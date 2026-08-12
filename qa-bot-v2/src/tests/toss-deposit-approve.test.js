const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { runAdb } = require("../infra/adb");

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

function parseMoney(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function textIncludesAmount(text, target) {
  const normalizedText = normalizeText(text);
  const amountText = normalizeText(target.amount);
  const amountNumber = target.amount_number || parseMoney(target.amount);
  return (
    !amountNumber ||
    normalizedText.includes(amountText) ||
    normalizedText.replace(/[^\d]/g, "").includes(String(amountNumber))
  );
}

function decodeXmlValue(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
}

function xmlTextLines(xml) {
  return Array.from(String(xml || "").matchAll(/(?:text|content-desc|hint)="([^"]*)"/g))
    .map((match) => decodeXmlValue(match[1]))
    .flatMap((label) => label.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractFirstMatch(lines, pattern) {
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function recoverApprovalTarget(runDir) {
  const detailPath = path.join(runDir, "logs", "payment-detail-start.xml");
  const completePath = path.join(runDir, "logs", "payment-complete.xml");
  const detailXml = fs.existsSync(detailPath) ? fs.readFileSync(detailPath, "utf8") : "";
  const completeXml = fs.existsSync(completePath) ? fs.readFileSync(completePath, "utf8") : "";
  const detailLines = xmlTextLines(detailXml);
  const completeLines = xmlTextLines(completeXml);
  const contractNumber = extractFirstMatch(detailLines, /계약번호:\s*(\d+)/);
  const amount =
    extractFirstMatch(completeLines, /입금액:\s*([\d,]+)원/) ||
    extractFirstMatch(detailLines, /총 결제 요금\s*([\d,]+)원/);

  return {
    contract_number: contractNumber,
    contract_number_suffix: contractNumber ? contractNumber.slice(-6) : "",
    product_name: detailLines[0] || "",
    buyer_name: extractFirstMatch(detailLines, /게스트 이름:\s*(.+)/),
    amount: amount ? `${amount}원` : "",
    amount_number: amount ? Number(amount.replace(/,/g, "")) : null,
    virtual_account_bank: extractFirstMatch(completeLines, /은행:\s*(.+)/),
    virtual_account_number: extractFirstMatch(completeLines, /계좌 번호:\s*(.+)/)
  };
}

function findChromeExecutable(config) {
  const candidates = [
    config.tossAdmin.chromePath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);

  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
}

function findLatestBankTransferPayment(reportBaseDir) {
  if (!reportBaseDir || !fs.existsSync(reportBaseDir)) return null;

  const results = fs.readdirSync(reportBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("contract-payment"))
    .map((entry) => {
      const resultPath = path.join(reportBaseDir, entry.name, "result.json");
      if (!fs.existsSync(resultPath)) return null;
      return {
        runDir: path.join(reportBaseDir, entry.name),
        resultPath,
        mtimeMs: fs.statSync(resultPath).mtimeMs
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of results) {
    try {
      const result = JSON.parse(fs.readFileSync(item.resultPath, "utf8"));
      if (result.status !== "pass") continue;
      if (result.payment_conditions?.method !== "무통장 입금") continue;

      return {
        run_id: result.run_id,
        env: result.env,
        report_dir: item.runDir,
        target: result.payment_conditions.toss_approval_target || recoverApprovalTarget(item.runDir),
        payment_conditions: result.payment_conditions
      };
    } catch {
      // Ignore malformed historical reports.
    }
  }

  return null;
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

async function findMidInput(page) {
  const comboInputs = page.locator("input[cmdk-input][role='combobox']");
  const comboCount = await comboInputs.count().catch(() => 0);
  for (let index = 0; index < comboCount; index += 1) {
    const input = comboInputs.nth(index);
    const box = await input.boundingBox().catch(() => null);
    if (box && box.x < 700 && box.y > 120 && box.y < 320) return input;
  }

  const directInputs = page.locator(
    "input[placeholder*='상점'], input[placeholder*='MID'], input[aria-label*='상점'], input[aria-label*='MID']"
  );
  const directCount = await directInputs.count().catch(() => 0);
  for (let index = 0; index < directCount; index += 1) {
    const input = directInputs.nth(index);
    if (await input.boundingBox().catch(() => null)) return input;
  }

  const inputs = page.locator("input:not([type='password'])");
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const box = await input.boundingBox().catch(() => null);
    if (!box) continue;
    const nearbyText = normalizeText(await page.locator("body").evaluate(
      (body, inputBox) => {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const values = [];
        while (walker.nextNode()) {
          const text = walker.currentNode.nodeValue || "";
          if (!/상점|MID|아이디/i.test(text)) continue;
          const element = walker.currentNode.parentElement;
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (
            Math.abs(rect.top - inputBox.y) < 140 &&
            rect.left < inputBox.x + inputBox.width &&
            rect.right > inputBox.x - 260
          ) {
            values.push(text);
          }
        }
        return values.join(" ");
      },
      box
    ).catch(() => ""));

    if (/상점|MID|아이디/i.test(nearbyText)) return input;
  }

  return null;
}

async function clearAndFillInput(page, input, value) {
  const box = await input.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width - 18, box.y + box.height / 2);
    await page.waitForTimeout(600);
  }

  await input.click();
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(300);
  await page.keyboard.type(value, { delay: 80 });
  await page.waitForTimeout(800);

  const option = page.getByText(value, { exact: true }).last();
  if (await option.count().catch(() => 0)) {
    await option.click().catch(() => {});
    await page.waitForTimeout(500);
  } else {
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
  }

  let currentValue = await input.inputValue().catch(() => "");
  if (currentValue === value) return true;

  await input.fill("");
  await page.waitForTimeout(300);
  await input.fill(value);
  await page.waitForTimeout(500);
  const fallbackOption = page.getByText(value, { exact: true }).last();
  if (await fallbackOption.count().catch(() => 0)) {
    await fallbackOption.click().catch(() => {});
    await page.waitForTimeout(500);
  } else {
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
  }
  currentValue = await input.inputValue().catch(() => "");
  if (currentValue === value) return true;

  await input.evaluate((element, nextValue) => {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, nextValue);
    } else {
      element.value = nextValue;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
  currentValue = await input.inputValue().catch(() => "");
  return currentValue === value;
}

async function resetPaymentLogSearch(page, steps) {
  const resetButton = page.getByRole("button", { name: /초기화/ }).first();
  if (await resetButton.count().catch(() => 0)) {
    await resetButton.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    addStep(steps, "토스 결제내역 검색 조건 초기화");
  }
}

async function loginIfNeeded(page, config, steps) {
  const email = config.tossAdmin.email;
  const password = config.tossAdmin.password;

  const passwordInput = page.locator("input[type='password']").first();
  const hasPasswordInput = await passwordInput.count().catch(() => 0);
  if (!hasPasswordInput) return;

  const emailInput = page.locator(
    "input[type='email'], input[name='email'], input[autocomplete='username'], input[placeholder*='이메일'], input[placeholder*='메일'], input:not([type='password'])"
  ).first();

  if (!email || !password) {
    fail(
      "토스 어드민 로그인이 필요하지만 계정 정보가 설정되어 있지 않습니다.",
      steps,
      [
        "이미 로그인되어 있으면 이 단계는 생략됩니다.",
        "로그인 화면이 뜬 경우에는 로컬 .env에 TOSS_ADMIN_EMAIL, TOSS_ADMIN_PASSWORD가 필요합니다."
      ]
    );
  }

  await emailInput.fill(email);
  await passwordInput.fill(password);
  const loginButton = page.getByRole("button", { name: /로그인|Sign in|Login/i }).first();
  if (await loginButton.count().catch(() => 0)) {
    await loginButton.click();
  } else {
    await passwordInput.press("Enter");
  }
  addStep(steps, "토스 어드민 로그인 시도");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function gotoPaymentLogs(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    // 토스 콘솔이 로그인/세션 복구 중 같은 결제내역 URL로 자체 이동하는 경우가 있어,
    // 최종 URL이 맞으면 실패로 보지 않고 다음 안정화 단계로 넘긴다.
    if (!message.includes("interrupted by another navigation") || !page.url().includes("/payment-logs")) {
      throw error;
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
}

async function relaunchGuestAppFromPayment(config, latestPayment, store, steps) {
  const env = latestPayment.env;
  const device = config.devices?.guest;
  const appPackage = config.androidPackages?.[env];

  if (!env || !device || !appPackage) {
    return {
      status: "skipped",
      reason: "무통장 결제 기준 리포트에서 guest 앱 재실행 대상을 확인하지 못했습니다."
    };
  }

  try {
    await runAdb(config, device, ["shell", "am", "force-stop", appPackage]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await runAdb(config, device, [
      "shell",
      "monkey",
      "-p",
      appPackage,
      "-c",
      "android.intent.category.LAUNCHER",
      "1"
    ]);
    addStep(steps, "무통장 입금 승인 후 guest 앱 재실행", "pass", `${env} / ${device}`);
    return {
      status: "pass",
      env,
      device,
      app_package: appPackage
    };
  } catch (error) {
    store.appendLog("runner.log", `post toss deposit guest app relaunch failed: ${error.message}`);
    addStep(steps, "무통장 입금 승인 후 guest 앱 재실행", "warning", error.message);
    return {
      status: "warning",
      env,
      device,
      app_package: appPackage,
      message: error.message
    };
  }
}

async function preparePaymentLogs(page, config, store, steps) {
  await gotoPaymentLogs(page, config.tossAdmin.url);
  await loginIfNeeded(page, config, steps);

  if (!page.url().includes("/payment-logs")) {
    await gotoPaymentLogs(page, config.tossAdmin.url);
  }

  if (await page.locator("input[type='password']").count().catch(() => 0)) {
    await saveHtml(page, store, "toss-login-still-visible");
    await saveScreenshot(page, store, "toss-login-still-visible");
    fail(
      "토스 테스트 결제내역으로 이동하지 못하고 로그인 화면에 머물러 있습니다.",
      steps,
      [
        "토스 계정 정보가 맞는지 또는 추가 인증이 필요한지 확인해주세요.",
        "이미 로그인되어 있는 세션이면 이 단계는 생략됩니다."
      ]
    );
  }

  addStep(steps, "토스 테스트 결제내역 접속");

  await resetPaymentLogSearch(page, steps);

  const midInput = await findMidInput(page);
  if (config.tossAdmin.mid && midInput) {
    const didFillMid = await clearAndFillInput(page, midInput, config.tossAdmin.mid);
    if (!didFillMid) {
      await saveHtml(page, store, "toss-mid-input-not-filled");
      await saveScreenshot(page, store, "toss-mid-input-not-filled");
      fail(
        "토스 테스트 결제내역에서 상점 MID 값이 실제 입력칸에 반영되지 않았습니다.",
        steps,
        [
          `입력하려던 MID: ${config.tossAdmin.mid}`,
          "리포트의 toss-mid-input-not-filled.png 화면을 확인해주세요."
        ]
      );
    }
    addStep(steps, "상점 MID 재입력 및 값 확인", "pass", config.tossAdmin.mid);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
  } else if (config.tossAdmin.mid) {
    await saveHtml(page, store, "toss-mid-input-not-found");
    await saveScreenshot(page, store, "toss-mid-input-not-found");
    fail(
      "토스 테스트 결제내역에서 상점 MID 입력칸을 찾지 못했습니다.",
      steps,
      [
        "결제내역 화면이 아닌 다른 화면이거나 검색 필드 구조가 바뀌었을 수 있습니다.",
        "리포트의 toss-mid-input-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const searchButton = page.getByRole("button", { name: /검색/ }).first();
  if (await searchButton.count().catch(() => 0)) {
    await searchButton.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    addStep(steps, "테스트 결제내역 검색");
  }
}

async function findPendingDepositRow(page, target) {
  const rows = page.locator("tbody tr, table tr");
  const count = await rows.count();
  const targetAmount = target.amount_number || parseMoney(target.amount);
  const suffix = normalizeText(target.contract_number_suffix);
  const product = normalizeText(target.product_name);
  const buyer = normalizeText(target.buyer_name);

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = normalizeText(await row.innerText().catch(() => ""));
    if (!text.includes("입금대기")) continue;
    if (!text.includes("입금처리")) continue;
    if (targetAmount && !textIncludesAmount(text, target)) continue;
    if (suffix && !text.includes(suffix)) continue;
    if (product && !text.includes(product)) continue;
    if (buyer && !text.includes(buyer)) continue;
    return { row, text };
  }

  return null;
}

async function clickDepositProcess(row) {
  const button = row.getByRole("button", { name: /입금처리/ }).first();
  if (await button.count().catch(() => 0)) {
    await button.click();
    return;
  }

  await row.getByText("입금처리", { exact: true }).click();
}

async function approveTossDeposit(page, store, steps, target) {
  const matched = await findPendingDepositRow(page, target);
  if (!matched) {
    await saveHtml(page, store, "toss-payment-logs-not-matched");
    await saveScreenshot(page, store, "toss-payment-logs-not-matched");
    fail(
      "토스 테스트 결제내역에서 승인할 입금대기 건을 찾지 못했습니다.",
      steps,
      [
        `매칭 기준: 금액 ${target.amount || "unknown"}, 구매자 ${target.buyer_name || "unknown"}, 계약번호 끝자리 ${target.contract_number_suffix || "unknown"}, 상품 ${target.product_name || "unknown"}`,
        "입금대기 상태와 입금처리 버튼이 있는 행만 처리합니다.",
        "리포트의 toss-payment-logs-not-matched.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "토스 입금대기 행 매칭", "pass", matched.text);
  await clickDepositProcess(matched.row);
  addStep(steps, "입금처리 버튼 선택");

  const dialog = page.locator("[role='dialog'], .modal, .Dialog, .dialog").first();
  if (await dialog.count().catch(() => 0)) {
    const confirmButton = dialog.getByRole("button", { name: /확인|처리|입금/i }).last();
    await confirmButton.click().catch(() => {});
    addStep(steps, "입금처리 확인 버튼 선택");
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const searchButton = page.getByRole("button", { name: /검색/ }).first();
  if (await searchButton.count().catch(() => 0)) {
    await searchButton.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  await saveHtml(page, store, "toss-deposit-after-approve");

  const stillPending = await findPendingDepositRow(page, target);
  if (stillPending) {
    await saveScreenshot(page, store, "toss-deposit-approve-not-confirmed");
    fail(
      "입금처리 버튼을 눌렀지만 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        "입금처리 후 같은 금액/상품/계약번호의 입금대기 행이 더 이상 보이지 않아야 합니다.",
        "리포트의 toss-deposit-approve-not-confirmed.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "입금대기 행 제거 확인");
}

async function runTossDepositApproveTest({ config, store }) {
  const steps = [];
  const latestPayment = findLatestBankTransferPayment(config.reportBaseDir);

  if (!latestPayment?.target) {
    fail(
      "최근 무통장 결제 PASS 결과를 찾지 못했습니다.",
      steps,
      [
        "먼저 !게스트 계약 결제 무통장 dev/stg 명령어를 PASS 시켜주세요.",
        "그 결과를 기준으로 토스 입금대기 행을 매칭합니다."
      ]
    );
  }

  const target = latestPayment.target;
  if (!target.amount_number || !target.contract_number_suffix || !target.product_name) {
    fail(
      "최근 무통장 결제 결과에 토스 매칭 정보가 부족합니다.",
      steps,
      [
        "최신 코드로 !게스트 계약 결제 무통장을 다시 실행하면 금액, 숙소명, 계약번호 끝자리를 저장합니다.",
        `최근 결제 run_id: ${latestPayment.run_id || "unknown"}`
      ]
    );
  }

  addStep(
    steps,
    "최근 무통장 결제 기준 확인",
    "pass",
    `${target.product_name} / ${target.amount} / ${target.contract_number_suffix}`
  );

  if (!config.tossAdmin.url || !config.tossAdmin.mid) {
    fail(
      "토스 어드민 URL 또는 MID 설정이 없습니다.",
      steps,
      [
        "로컬 .env에 TOSS_ADMIN_URL, TOSS_ADMIN_MID를 설정해주세요."
      ]
    );
  }

  const executablePath = findChromeExecutable(config);
  if (!executablePath) {
    fail(
      "토스 어드민 자동화에 사용할 Chrome 실행 파일을 찾지 못했습니다.",
      steps,
      [
        "Google Chrome을 설치하거나 .env의 TOSS_ADMIN_CHROME_PATH에 실행 파일 경로를 설정해주세요."
      ]
    );
  }
  store.appendLog("runner.log", `toss admin browser executable: ${executablePath}`);
  addStep(steps, "토스 어드민 브라우저 확인", "pass", executablePath);

  const profileDir = path.resolve(config.projectRoot, config.tossAdmin.profileDir);
  const browser = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: config.tossAdmin.headless,
    viewport: { width: 1440, height: 1000 }
  });
  const page = browser.pages()[0] || await browser.newPage();
  let shouldCloseBrowser = true;
  page.on("dialog", async (dialog) => {
    store.appendLog("runner.log", `toss admin dialog accepted: ${dialog.message()}`);
    await dialog.accept().catch(() => {});
  });

  try {
    await preparePaymentLogs(page, config, store, steps);
    await approveTossDeposit(page, store, steps, target);
    addStep(steps, "무통장 입금 승인 완료 확인");
  } catch (error) {
    if (config.tossAdmin.keepOpenOnFail && !config.tossAdmin.headless) {
      shouldCloseBrowser = false;
      store.appendLog("runner.log", "toss admin browser kept open after failure.");
      error.details = [
        ...(error.details || []),
        "디버깅을 위해 토스 어드민 브라우저를 열어둔 상태입니다."
      ];
    }
    throw error;
  } finally {
    if (shouldCloseBrowser) {
      await browser.close();
    }
  }

  const guestAppRelaunch = await relaunchGuestAppFromPayment(config, latestPayment, store, steps);

  return {
    test_id: "TC-TOSS-DEPOSIT-APPROVE-001",
    name: "무통장 입금 승인",
    env: "toss",
    status: "pass",
    device: "browser",
    steps,
    toss_deposit: {
      source_payment_run_id: latestPayment.run_id,
      mid: config.tossAdmin.mid,
      amount: target.amount,
      buyer_name: target.buyer_name,
      product_name: target.product_name,
      contract_number_suffix: target.contract_number_suffix
    },
    guest_app_relaunch: guestAppRelaunch,
    artifacts: {
      screenshots: [],
      logs: [
        path.join(store.logsDir, "toss-deposit-after-approve.html")
      ].filter((filePath) => fs.existsSync(filePath))
    }
  };
}

module.exports = {
  runTossDepositApproveTest
};
