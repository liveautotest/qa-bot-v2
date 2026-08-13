const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

function addStep(steps, name, status = "pass", message) {
  const step = { name, status };
  if (message) step.message = message;
  steps.push(step);
}

function fail(message, steps, details = []) {
  const error = new Error(message);
  error.steps = steps;
  error.details = details;
  throw error;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findChromeExecutable(config) {
  const candidates = [
    config.consoleHost.chromePath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);

  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
}

function hostReservationUrl(config, env, reservationId) {
  const base = env === "dev"
    ? config.consoleHost.devUrlBase
    : config.consoleHost.stagingUrlBase;
  return `${String(base || "").replace(/\/+$/, "")}/${reservationId}`;
}

async function saveScreenshot(page, store, name) {
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function saveHtml(page, store, name) {
  const htmlPath = path.join(store.logsDir, `${name}.html`);
  fs.writeFileSync(htmlPath, await page.content());
  return htmlPath;
}

async function loginIfNeeded(page, config, steps) {
  const accountEntryButton = page.getByText("이메일/휴대폰 번호로 시작하기", { exact: true }).first();
  if (await accountEntryButton.count().catch(() => 0)) {
    await accountEntryButton.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
    addStep(steps, "호스트 콘솔 계정 이메일 로그인 진입");
  }

  const passwordInput = page.locator("input[type='password']").first();
  if (!(await passwordInput.count().catch(() => 0))) return false;

  if (!config.consoleHost.email || !config.consoleHost.password) {
    fail(
      "호스트 콘솔 로그인이 필요하지만 계정 정보가 설정되어 있지 않습니다.",
      steps,
      [
        "로컬 .env에 CONSOLE_HOST_EMAIL, CONSOLE_HOST_PASSWORD를 설정해주세요.",
        "이미 로그인된 브라우저 세션이면 이 단계는 생략됩니다."
      ]
    );
  }

  const emailInput = page.locator(
    "input[type='email'], input[name='email'], input[name='id'], input[autocomplete='username'], input[placeholder*='이메일'], input[placeholder*='휴대폰'], input[placeholder*='메일'], input:not([type='password'])"
  ).first();

  await emailInput.fill(config.consoleHost.email);
  await passwordInput.fill(config.consoleHost.password);

  const loginButton = page.getByRole("button", { name: /로그인|Sign in|Login/i }).first();
  if (await loginButton.count().catch(() => 0)) {
    await loginButton.click();
  } else {
    await passwordInput.press("Enter");
  }

  addStep(steps, "호스트 콘솔 로그인 시도");
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await page.waitForURL(/console\.liveanywhere\.me\/host\/reservations\/\d+/, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

async function ensureHostReservationPage(page, config, store, steps, request) {
  const url = hostReservationUrl(config, request.env, request.reservation_id);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  const didLogin = await loginIfNeeded(page, config, steps);

  if (!page.url().includes(`/host/reservations/${request.reservation_id}`)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  }

  if (await page.locator("input[type='password']").count().catch(() => 0)) {
    await saveHtml(page, store, "console-host-login-still-visible");
    await saveScreenshot(page, store, "console-host-login-still-visible");
    fail(
      "호스트 콘솔 예약 상세로 이동하지 못하고 로그인 화면에 머물러 있습니다.",
      steps,
      [
        "호스트 콘솔 계정 정보가 맞는지 또는 추가 인증이 필요한지 확인해주세요.",
        "리포트의 console-host-login-still-visible.png 화면을 확인해주세요."
      ]
    );
  }

  let bodyText = normalizeText(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
  for (let attempt = 1; attempt <= 2 && !bodyText.includes(String(request.reservation_id)); attempt += 1) {
    const isBlankDetail = bodyText.includes("리브애니웨어") && !bodyText.includes("보증금");
    if (!didLogin && !isBlankDetail) break;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1800 + attempt * 700);
    bodyText = normalizeText(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
    addStep(steps, `호스트 콘솔 예약 상세 빈 화면 재확인 ${attempt}회`, "pass", url);
  }

  if (!bodyText.includes(String(request.reservation_id))) {
    await saveHtml(page, store, "console-host-reservation-not-found");
    await saveScreenshot(page, store, "console-host-reservation-not-found");
    fail(
      "호스트 콘솔 예약 상세 화면을 확인하지 못했습니다.",
      steps,
      [
        `예약 번호: ${request.reservation_id}`,
        `현재 URL: ${page.url()}`,
        "예약 상세 URL에 진입했지만 본문에서 예약 번호를 확인하지 못했습니다.",
        "리포트의 console-host-reservation-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "호스트 콘솔 예약 상세 진입", "pass", url);
}

async function scrollToDepositReturnArea(page, store, steps) {
  const found = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll("section, article, form, div"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const text = normalize(element.textContent);
        return text.includes("보증금") &&
          (text.includes("보류") || text.includes("반환 확정") || text.includes("반환 처리"));
      })
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);

    const element = candidates[0];
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  });

  await page.waitForTimeout(350);
  if (!found) {
    await saveHtml(page, store, "deposit-return-section-not-found");
    await saveScreenshot(page, store, "deposit-return-section-not-found");
    fail(
      "호스트 콘솔 예약 상세에서 보증금 반환 처리 영역을 찾지 못했습니다.",
      steps,
      [
        "화면에 보류 버튼 또는 보증금 반환 확정 버튼이 보여야 합니다.",
        "리포트의 deposit-return-section-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "보증금 반환 처리 영역 확인");
}

async function clickLocatorWithFallback(page, locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});

  try {
    await locator.click({ timeout: 2500 });
    return "click";
  } catch (firstError) {
    try {
      await locator.click({ force: true, timeout: 1500 });
      return "force";
    } catch (secondError) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return "mouse";
      }

      await locator.evaluate((element) => element.click());
      return "dom";
    }
  }
}

function modalScopedButton(page, label) {
  const exactLabel = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`);
  return page
    .locator("[role='presentation']")
    .filter({ hasText: label })
    .last()
    .getByRole("button", { name: exactLabel })
    .last();
}

async function clickVisibleButton(page, labels, store, steps, stepName, artifactName, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  let lastError;

  for (const label of labelList) {
    const exactLabel = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`);
    const locators = [
      modalScopedButton(page, label),
      page.getByRole("button", { name: exactLabel }).last(),
      page.getByRole("button", { name: new RegExp(escapeRegExp(label)) }).last(),
      page.getByText(label, { exact: true }).last()
    ];

    // 콘솔 모달은 backdrop 레이어가 기본 click을 가로채는 경우가 있어
    // 모달 내부 버튼 우선 탐색 후 force/mouse/DOM 클릭 순서로 빠르게 보정한다.
    for (const locator of locators) {
      if (!(await locator.count().catch(() => 0))) continue;
      try {
        const method = await clickLocatorWithFallback(page, locator);
        addStep(steps, stepName, "pass", `${label} (${method})`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
  }

  await saveHtml(page, store, artifactName);
  await saveScreenshot(page, store, artifactName);
  fail(
    `${stepName} 버튼을 찾지 못했습니다.`,
    steps,
    [
      `탐색 버튼: ${labelList.join(", ")}`,
      ...(options.help ? [options.help] : []),
      ...(lastError ? [`마지막 클릭 오류: ${lastError.message}`] : []),
      `리포트의 ${artifactName}.png 화면을 확인해주세요.`
    ]
  );
}

async function processDepositHold(page, store, steps) {
  await clickVisibleButton(page, ["보류"], store, steps, "보증금 반환 보류 버튼 선택", "deposit-hold-button-not-found");
  await page.waitForTimeout(500);

  const modalText = normalizeText(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
  if (!modalText.includes("보증금 반환 보류") || !modalText.includes("사유를 선택")) {
    await saveHtml(page, store, "deposit-hold-modal-not-found");
    await saveScreenshot(page, store, "deposit-hold-modal-not-found");
    fail(
      "보증금 반환 보류 팝업을 확인하지 못했습니다.",
      steps,
      [
        "보류 버튼 선택 후 보증금 반환 보류 팝업과 사유 선택 항목이 보여야 합니다.",
        "리포트의 deposit-hold-modal-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "보증금 반환 보류 팝업 확인");

  const reasons = ["퇴실 거부", "집 파손", "게스트와 협의 중"];
  const reason = reasons[Math.floor(Math.random() * reasons.length)];
  const reasonOption = page.getByText(reason, { exact: true }).first();
  if (!(await reasonOption.count().catch(() => 0))) {
    await saveHtml(page, store, "deposit-hold-reason-not-found");
    await saveScreenshot(page, store, "deposit-hold-reason-not-found");
    fail(
      "보증금 반환 보류 사유를 찾지 못했습니다.",
      steps,
      [
        `선택 대상: ${reason}`,
        "기타를 제외한 보류 사유 3개 중 하나를 선택해야 합니다.",
        "리포트의 deposit-hold-reason-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  await reasonOption.click();
  addStep(steps, "보증금 반환 보류 사유 선택", "pass", reason);

  await clickVisibleButton(page, ["보류"], store, steps, "보증금 반환 보류 확정", "deposit-hold-submit-not-found");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { action: "보류", reason };
}

async function processDepositReturn(page, store, steps) {
  await clickVisibleButton(
    page,
    ["보증금 반환 확정", "반환 확정"],
    store,
    steps,
    "보증금 반환 확정 버튼 선택",
    "deposit-return-button-not-found"
  );
  await page.waitForTimeout(500);

  const modalText = normalizeText(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
  if (!modalText.includes("보증금 반환을 확정하시겠습니까")) {
    await saveHtml(page, store, "deposit-return-confirm-modal-not-found");
    await saveScreenshot(page, store, "deposit-return-confirm-modal-not-found");
    fail(
      "보증금 반환 확정 팝업을 확인하지 못했습니다.",
      steps,
      [
        "보증금 반환 확정 버튼 선택 후 확인 팝업이 보여야 합니다.",
        "리포트의 deposit-return-confirm-modal-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "보증금 반환 확정 팝업 확인");

  await clickVisibleButton(
    page,
    ["확인"],
    store,
    steps,
    "보증금 반환 확정 팝업 확인",
    "deposit-return-confirm-button-not-found",
    { help: "확인 버튼은 보증금 반환 확정 팝업 내부 버튼만 처리합니다." }
  );
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { action: "반환 확정" };
}

async function runConsoleDepositReturnTest({ request, config, store }) {
  const steps = [];
  const reservationId = request.reservation_id;
  const action = request.deposit_action;
  if (!reservationId) {
    fail("보증금 처리 예약 번호가 필요합니다.", steps, ["예: !보증금 반환 146647 stg"]);
  }
  if (!["return", "hold"].includes(action)) {
    fail("보증금 처리 action이 올바르지 않습니다.", steps, ["지원 action: return, hold"]);
  }

  const chromePath = findChromeExecutable(config);
  if (!chromePath) {
    fail("Chrome 실행 파일을 찾지 못했습니다.", steps, ["CONSOLE_HOST_CHROME_PATH 또는 Google Chrome 설치 상태를 확인해주세요."]);
  }
  addStep(steps, "호스트 콘솔 브라우저 확인", "pass", chromePath);

  const profileDir = path.resolve(config.projectRoot, config.consoleHost.profileDir);
  fs.mkdirSync(profileDir, { recursive: true });

  const browser = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: config.consoleHost.headless,
    viewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--disable-infobars"]
  });
  const page = browser.pages()[0] || await browser.newPage();
  let shouldCloseBrowser = true;
  page.on("dialog", async (dialog) => {
    store.appendLog("runner.log", `console host dialog accepted: ${dialog.message()}`);
    await dialog.accept().catch(() => {});
  });

  try {
    await ensureHostReservationPage(page, config, store, steps, request);
    await scrollToDepositReturnArea(page, store, steps);
    const result = action === "hold"
      ? await processDepositHold(page, store, steps)
      : await processDepositReturn(page, store, steps);
    await saveHtml(page, store, "deposit-return-final");
    await saveScreenshot(page, store, "deposit-return-final");

    return {
      test_id: "TC-CONSOLE-DEPOSIT-RETURN-001",
      name: action === "hold" ? "콘솔 보증금 반환 보류" : "콘솔 보증금 반환 확정",
      env: request.env,
      status: "pass",
      device: "browser",
      steps,
      console_deposit_return: {
        reservation_id: reservationId,
        action: result.action,
        reason: result.reason || "",
        url: hostReservationUrl(config, request.env, reservationId)
      },
      artifacts: {
        screenshots: [path.join(store.screenshotsDir, "deposit-return-final.png")],
        logs: [path.join(store.logsDir, "deposit-return-final.html")]
      }
    };
  } catch (error) {
    if (config.consoleHost.keepOpenOnFail && !config.consoleHost.headless) {
      shouldCloseBrowser = false;
      error.details = [
        ...(error.details || []),
        "디버깅을 위해 호스트 콘솔 브라우저를 열어둔 상태입니다."
      ];
    }
    throw error;
  } finally {
    if (shouldCloseBrowser) {
      await browser.close();
    }
  }
}

module.exports = {
  runConsoleDepositReturnTest
};
