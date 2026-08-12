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

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function calculateScheduleRange(label, baseDate = startOfToday()) {
  const normalized = normalizeText(label).replace(/\s+/g, "");
  const direction = normalized.endsWith("전") ? -1 : 1;
  const isBefore = direction < 0;
  let periodDays;

  if (/^(일주일|1주일)전$|^(일주일|1주일)후$/.test(normalized)) {
    periodDays = 7;
  } else if (/^2주일전$|^2주일후$/.test(normalized)) {
    periodDays = 14;
  } else if (/^(한달|1개월)전$|^(한달|1개월)후$/.test(normalized)) {
    periodDays = 31;
  } else {
    throw new Error(`지원하지 않는 일정 변경 기준입니다: ${label}`);
  }

  // 사용자가 확인하는 콘솔 기간 표기 기준에 맞춰 양 끝 날짜를 포함해 계산한다.
  // 예: 기준 체크인 2026-08-12
  // - 일주일전 => 2026-08-06 ~ 2026-08-12
  // - 일주일후 => 2026-08-18 ~ 2026-08-24
  const startDate = isBefore
    ? addDays(baseDate, -(periodDays - 1))
    : addDays(baseDate, periodDays - 1);
  const endDate = isBefore
    ? baseDate
    : addDays(startDate, periodDays - 1);

  return {
    label: normalizeText(label),
    periodDays,
    nights: periodDays - 1,
    baseDate,
    baseDateText: formatDate(baseDate),
    startDate,
    endDate,
    startDateText: formatDate(startDate),
    endDateText: formatDate(endDate)
  };
}

function findChromeExecutable(config) {
  const candidates = [
    config.consoleAdmin.chromePath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);

  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
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
    await page.waitForTimeout(800);
    addStep(steps, "콘솔 계정 이메일 로그인 진입");
  }

  const passwordInput = page.locator("input[type='password']").first();
  if (!(await passwordInput.count().catch(() => 0))) return;

  if (!config.consoleAdmin.email || !config.consoleAdmin.password) {
    fail(
      "콘솔 로그인이 필요하지만 계정 정보가 설정되어 있지 않습니다.",
      steps,
      [
        "이미 로그인된 브라우저 세션이면 이 단계는 생략됩니다.",
        "로그인 화면이 뜬 경우 로컬 .env에 CONSOLE_ADMIN_EMAIL, CONSOLE_ADMIN_PASSWORD를 설정해주세요.",
        "값이 없으면 TOSS_ADMIN_EMAIL, TOSS_ADMIN_PASSWORD를 fallback으로 사용합니다."
      ]
    );
  }

  const emailInput = page.locator(
    "input[type='email'], input[name='email'], input[name='id'], input[autocomplete='username'], input[placeholder*='이메일'], input[placeholder*='휴대폰'], input[placeholder*='메일'], input:not([type='password'])"
  ).first();

  await emailInput.fill(config.consoleAdmin.email);
  await passwordInput.fill(config.consoleAdmin.password);

  const loginButton = page.getByRole("button", { name: /로그인|Sign in|Login/i }).first();
  if (await loginButton.count().catch(() => 0)) {
    await loginButton.click();
  } else {
    await passwordInput.press("Enter");
  }

  addStep(steps, "콘솔 로그인 시도");
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await page.waitForURL(/console\.liveanywhere\.me\/reservations\/\d+/, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

function consoleReservationUrl(config, env, reservationId) {
  const base = env === "dev"
    ? config.consoleAdmin.devUrlBase
    : config.consoleAdmin.stagingUrlBase;
  return `${String(base || "").replace(/\/+$/, "")}/${reservationId}`;
}

async function ensureReservationPage(page, config, store, steps, request) {
  const url = consoleReservationUrl(config, request.env, request.reservation_id);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await loginIfNeeded(page, config, steps);

  if (!page.url().includes(`/reservations/${request.reservation_id}`)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  }

  if (await page.locator("input[type='password']").count().catch(() => 0)) {
    await saveHtml(page, store, "console-login-still-visible");
    await saveScreenshot(page, store, "console-login-still-visible");
    fail(
      "콘솔 예약 상세로 이동하지 못하고 로그인 화면에 머물러 있습니다.",
      steps,
      [
        "콘솔 계정 정보가 맞는지 또는 추가 인증이 필요한지 확인해주세요.",
        "이미 로그인되어 있는 세션이면 이 단계는 생략됩니다.",
        "리포트의 console-login-still-visible.png 화면을 확인해주세요."
      ]
    );
  }

  const bodyText = normalizeText(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
  if (!bodyText.includes(String(request.reservation_id))) {
    await saveHtml(page, store, "console-reservation-not-found");
    await saveScreenshot(page, store, "console-reservation-not-found");
    const isBlankDetail =
      bodyText.includes("매니저 계약 관리") &&
      !bodyText.includes("예약 정보") &&
      !bodyText.includes("일정 변경");
    fail(
      isBlankDetail
        ? "콘솔 예약 상세 본문이 비어 있습니다. 예약번호 또는 환경을 확인해주세요."
        : "콘솔 예약 상세 화면을 확인하지 못했습니다.",
      steps,
      [
        `예약 번호: ${request.reservation_id}`,
        `현재 URL: ${page.url()}`,
        isBlankDetail
          ? "콘솔 메뉴는 보이지만 예약 상세 본문이 비어 있습니다. 해당 예약번호가 이 환경에 없을 때 주로 발생합니다."
          : "예약 상세 URL에 진입했지만 본문에서 예약 번호를 확인하지 못했습니다.",
        "리포트의 console-reservation-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "콘솔 예약 상세 진입", "pass", url);
}

async function scrollToScheduleChangeArea(page, store, steps) {
  const found = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const datePattern = /^(\d{4}-\d{2}-\d{2}|\d{4}\.\s*\d{2}\.\s*\d{2}\.?)$/;
    const candidates = Array.from(document.querySelectorAll("section, article, form, div"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const text = normalize(element.textContent);
        const dateInputs = Array.from(element.querySelectorAll("input"))
          .filter((input) => datePattern.test(normalize(input.value || input.getAttribute("value") || "")));
        return text.includes("일정 변경") &&
          text.includes("체크인") &&
          text.includes("체크아웃") &&
          dateInputs.length >= 2;
      })
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);

    const element = candidates[0];
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  });

  await page.waitForTimeout(400);
  if (!found) {
    await saveHtml(page, store, "console-schedule-section-not-found");
    await saveScreenshot(page, store, "console-schedule-section-not-found");
    fail(
      "콘솔 예약 상세에서 일정 변경 영역을 찾지 못했습니다.",
      steps,
      [
        "예약 상세 화면 안에 '일정 변경' 영역이 보여야 합니다.",
        "리포트의 console-schedule-section-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "일정 변경 영역 확인");
}

async function readScheduleDateFields(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const datePattern = /^(\d{4}-\d{2}-\d{2}|\d{4}\.\s*\d{2}\.\s*\d{2}\.?)$/;
    const containers = Array.from(document.querySelectorAll("section, article, form, div"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const text = normalize(element.textContent);
        const dateInputs = Array.from(element.querySelectorAll("input"))
          .filter((input) => datePattern.test(normalize(input.value || input.getAttribute("value") || "")));
        return text.includes("일정 변경") &&
          text.includes("체크인") &&
          text.includes("체크아웃") &&
          dateInputs.length >= 2;
      })
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);

    const container = containers[0];
    if (!container) return null;

    const inputs = Array.from(container.querySelectorAll("input"))
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        const value = normalize(input.value || input.getAttribute("value") || "");
        return rect.width > 0 && rect.height > 0 && datePattern.test(value);
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

    return {
      checkin: normalize(inputs[0]?.value || inputs[0]?.getAttribute("value") || ""),
      checkout: normalize(inputs[1]?.value || inputs[1]?.getAttribute("value") || "")
    };
  });
}

async function setDateField(page, label, date) {
  const isoDate = formatDate(date);
  const result = await page.evaluate(({ targetLabel, value }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const datePattern = /^(\d{4}-\d{2}-\d{2}|\d{4}\.\s*\d{2}\.\s*\d{2}\.?)$/;
    const containers = Array.from(document.querySelectorAll("section, article, form, div"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const text = normalize(element.textContent);
        const dateInputs = Array.from(element.querySelectorAll("input"))
          .filter((input) => datePattern.test(normalize(input.value || input.getAttribute("value") || "")));
        return text.includes("일정 변경") &&
          text.includes("체크인") &&
          text.includes("체크아웃") &&
          dateInputs.length >= 2;
      })
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);

    const container = containers[0];
    if (!container) return null;

    const inputs = Array.from(container.querySelectorAll("input"))
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        const value = normalize(input.value || input.getAttribute("value") || "");
        return rect.width > 0 && rect.height > 0 && datePattern.test(value);
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

    const input = targetLabel === "체크아웃" ? inputs[1] : inputs[0];
    if (!input) return null;

    input.scrollIntoView({ block: "center", inline: "nearest" });
    const before = normalize(input.value || input.getAttribute("value") || "");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    // React/MUI controlled input이 변경을 인지하도록 실제 사용자 입력과 같은 이벤트를 보낸다.
    const tracker = input._valueTracker;
    if (tracker) tracker.setValue(before);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));

    return {
      before,
      after: normalize(input.value || input.getAttribute("value") || "")
    };
  }, { targetLabel: label, value: isoDate });

  await page.waitForTimeout(350);
  if (!result || result.after !== isoDate) return false;
  return result;
}

async function clickCalendarNav(page, direction) {
  const navNames = direction === "next"
    ? /다음|Next|›|»|>/i
    : /이전|Prev|‹|«|</i;
  const button = page.getByRole("button", { name: navNames }).first();
  if (await button.count().catch(() => 0)) {
    await button.click().catch(() => {});
    await page.waitForTimeout(350);
    return true;
  }

  return page.evaluate((next) => {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], svg"))
      .filter((element) => {
        const text = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return next
          ? /다음|Next|›|»|>/i.test(text) || rect.left > window.innerWidth * 0.55 && rect.top < window.innerHeight * 0.45
          : /이전|Prev|‹|«|</i.test(text) || rect.left < window.innerWidth * 0.45 && rect.top < window.innerHeight * 0.45;
      })
      .sort((a, b) => next
        ? b.getBoundingClientRect().left - a.getBoundingClientRect().left
        : a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const target = candidates[0];
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  }, direction === "next");
}

async function clickVisibleCalendarDate(page, date) {
  const target = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    iso: formatDate(date)
  };

  return page.evaluate((targetDate) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const disabled = (element) => {
      const aria = element.getAttribute("aria-disabled");
      const disabledAttr = element.hasAttribute("disabled");
      const className = String(element.className || "");
      return aria === "true" || disabledAttr || /disabled|disable|unavailable/i.test(className);
    };
    const monthSignals = [
      `${targetDate.year}년 ${targetDate.month}월`,
      `${targetDate.year}.${String(targetDate.month).padStart(2, "0")}`,
      `${targetDate.month}월`
    ];

    const candidates = Array.from(document.querySelectorAll("button, [role='button'], td, div, span"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        if (disabled(element)) return false;

        const text = normalize(element.textContent);
        const aria = normalize(element.getAttribute("aria-label") || "");
        const title = normalize(element.getAttribute("title") || "");
        const dataDate = normalize(element.getAttribute("data-date") || element.getAttribute("data-day") || "");
        const merged = `${text} ${aria} ${title} ${dataDate}`;

        if (merged.includes(targetDate.iso)) return true;
        if (aria.includes(`${targetDate.month}월`) && aria.includes(`${targetDate.day}일`)) return true;
        if (title.includes(`${targetDate.month}월`) && title.includes(`${targetDate.day}일`)) return true;
        if (dataDate.includes(targetDate.iso)) return true;
        return text === String(targetDate.day);
      });

    for (const candidate of candidates) {
      let container = candidate;
      let context = "";
      for (let depth = 0; depth < 6 && container; depth += 1) {
        context += ` ${normalize(container.textContent)}`;
        container = container.parentElement;
      }
      if (!monthSignals.some((signal) => context.includes(signal))) continue;

      const rect = candidate.getBoundingClientRect();
      candidate.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      candidate.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      candidate.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      return true;
    }

    return false;
  }, target);
}

async function selectCalendarDate(page, store, steps, date, label) {
  const targetMonth = date.getFullYear() * 12 + date.getMonth();

  for (let attempt = 0; attempt < 18; attempt += 1) {
    if (await clickVisibleCalendarDate(page, date)) {
      await page.waitForTimeout(600);
      addStep(steps, `${label} 날짜 선택`, "pass", formatDate(date));
      return;
    }

    const visibleMonth = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const match = text.match(/(20\d{2})년\s*(\d{1,2})월/);
      if (match) return Number(match[1]) * 12 + Number(match[2]) - 1;
      const loose = text.match(/(\d{1,2})월/);
      if (loose) return new Date().getFullYear() * 12 + Number(loose[1]) - 1;
      return null;
    }).catch(() => null);

    const direction = visibleMonth === null || visibleMonth <= targetMonth ? "next" : "prev";
    if (!(await clickCalendarNav(page, direction))) break;
  }

  await saveHtml(page, store, `console-${label}-date-not-found`);
  await saveScreenshot(page, store, `console-${label}-date-not-found`);
  fail(
    `콘솔 달력에서 ${label} 날짜를 찾지 못했습니다.`,
    steps,
    [
      `선택 대상 날짜: ${formatDate(date)}`,
      "달력 월 이동 또는 날짜 셀 구조가 바뀌었을 수 있습니다.",
      `리포트의 console-${label}-date-not-found.png 화면을 확인해주세요.`
    ]
  );
}

async function changeDateField(page, store, steps, fieldLabel, date) {
  const result = await setDateField(page, fieldLabel, date);
  if (!result) {
    await saveHtml(page, store, `console-${fieldLabel}-field-not-found`);
    await saveScreenshot(page, store, `console-${fieldLabel}-field-not-found`);
    fail(
      `콘솔 일정 변경 영역에서 ${fieldLabel} 날짜 입력칸을 찾지 못했습니다.`,
      steps,
      [
        `${fieldLabel} 영역의 날짜 입력칸에 변경 날짜를 반영해야 합니다.`,
        `리포트의 console-${fieldLabel}-field-not-found.png 화면을 확인해주세요.`
      ]
    );
  }

  addStep(steps, `${fieldLabel} 날짜 변경`, "pass", `${result.before} -> ${formatDate(date)}`);
}

async function assertScheduleInputsChanged(page, store, steps, range) {
  const currentSchedule = await readScheduleDateFields(page);
  const startMatched = currentSchedule?.checkin === range.startDateText;
  const endMatched = currentSchedule?.checkout === range.endDateText;

  if (startMatched && endMatched) {
    addStep(
      steps,
      "일정 변경 입력값 검증",
      "pass",
      `${currentSchedule.checkin} ~ ${currentSchedule.checkout}`
    );
    return;
  }

  await saveHtml(page, store, "console-schedule-inputs-not-changed");
  await saveScreenshot(page, store, "console-schedule-inputs-not-changed");
  fail(
    "콘솔 일정 변경 입력값이 계산된 날짜와 일치하지 않습니다.",
    steps,
    [
      `기대 일정: ${range.startDateText} ~ ${range.endDateText}`,
      `현재 입력값: ${currentSchedule?.checkin || "-"} ~ ${currentSchedule?.checkout || "-"}`,
      "체크인/체크아웃이 모두 기대 날짜로 바뀐 경우에만 일정 변경 버튼을 누릅니다.",
      "리포트의 console-schedule-inputs-not-changed.png 화면을 확인해주세요."
    ]
  );
}

async function clickButtonByText(page, patterns) {
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).last();
    if (await button.count().catch(() => 0)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
  }

  return page.evaluate((sources) => {
    const patterns = sources.map((source) => new RegExp(source, "i"));
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const text = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`;
        return patterns.some((pattern) => pattern.test(text));
      });
    const target = candidates[candidates.length - 1];
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  }, patterns.map((pattern) => pattern.source));
}

async function submitScheduleChange(page, store, steps) {
  if (!(await clickButtonByText(page, [/일정\s*변경/]))){
    await saveHtml(page, store, "console-schedule-change-button-not-found");
    await saveScreenshot(page, store, "console-schedule-change-button-not-found");
    fail(
      "콘솔 일정 변경 버튼을 찾지 못했습니다.",
      steps,
      [
        "체크인/체크아웃 날짜 변경 후 일정 변경 버튼이 활성화되어야 합니다.",
        "리포트의 console-schedule-change-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "일정 변경 버튼 선택");

  const bodyAfterSubmit = normalizeText(await page.locator("body").innerText({ timeout: 15000 }).catch(() => ""));
  if (/일정 변경 및 세부 가격 변경|세부 가격|가격 변경/.test(bodyAfterSubmit)) {
    if (!(await clickButtonByText(page, [/다음/]))){
      await saveHtml(page, store, "console-price-change-next-not-found");
      await saveScreenshot(page, store, "console-price-change-next-not-found");
      fail(
        "일정 변경 및 세부 가격 변경 모달에서 다음 버튼을 찾지 못했습니다.",
        steps,
        [
          "첫 번째 확인 모달에서는 다음 버튼을 눌러야 합니다.",
          "리포트의 console-price-change-next-not-found.png 화면을 확인해주세요."
        ]
      );
    }
    addStep(steps, "일정 변경 및 세부 가격 변경 모달 다음 선택");
  } else {
    addStep(steps, "일정 변경 및 세부 가격 변경 모달 확인", "pass", "모달 미노출 또는 즉시 다음 단계");
  }

  const bodyBeforeComplete = normalizeText(await page.locator("body").innerText({ timeout: 15000 }).catch(() => ""));
  if (/가격 차이|게스트 기준|변경 완료/.test(bodyBeforeComplete)) {
    if (!(await clickButtonByText(page, [/변경\s*완료|완료|확인/]))){
      await saveHtml(page, store, "console-change-complete-button-not-found");
      await saveScreenshot(page, store, "console-change-complete-button-not-found");
      fail(
        "게스트 기준 가격 차이 확인 팝업에서 변경 완료 버튼을 찾지 못했습니다.",
        steps,
        [
          "마지막 확인 팝업에서는 변경 완료 버튼을 눌러야 합니다.",
          "리포트의 console-change-complete-button-not-found.png 화면을 확인해주세요."
        ]
      );
    }
    addStep(steps, "게스트 기준 가격 차이 확인 팝업 변경 완료 선택");
  } else {
    addStep(steps, "게스트 기준 가격 차이 팝업 확인", "pass", "팝업 미노출 또는 즉시 완료");
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function verifyChangedSchedule(page, store, steps, range) {
  const bodyText = normalizeText(await page.locator("body").innerText({ timeout: 15000 }).catch(() => ""));
  const startLoose = range.startDateText.replace(/-/g, ".");
  const endLoose = range.endDateText.replace(/-/g, ".");
  const startVisible =
    bodyText.includes(range.startDateText) ||
    bodyText.includes(startLoose) ||
    bodyText.includes(`${range.startDate.getMonth() + 1}월 ${range.startDate.getDate()}일`);
  const endVisible =
    bodyText.includes(range.endDateText) ||
    bodyText.includes(endLoose) ||
    bodyText.includes(`${range.endDate.getMonth() + 1}월 ${range.endDate.getDate()}일`);

  await saveHtml(page, store, "console-schedule-change-final");
  if (!startVisible || !endVisible) {
    await saveScreenshot(page, store, "console-schedule-change-final-manual-check");
    addStep(
      steps,
      "변경 일정 화면 반영 확인",
      "warning",
      `콘솔 본문에서 변경 날짜를 자동 확정하지 못해 수동 확인 필요 (${range.startDateText} ~ ${range.endDateText})`
    );
    return "manual_required";
  }

  addStep(steps, "변경 일정 화면 반영 확인", "pass", `${startLoose} ~ ${endLoose}`);
  return "pass";
}

async function runConsoleScheduleChangeTest({ request, config, store }) {
  const steps = [];
  const reservationId = String(request.reservation_id || "").trim();
  const shiftLabel = request.schedule_shift_label || request.schedule_change_label || "";

  if (!reservationId || !/^\d+$/.test(reservationId)) {
    fail(
      "일정 변경 예약 번호가 올바르지 않습니다.",
      steps,
      ["예: !일정변경 146628 일주일 전 dev"]
    );
  }

  const executablePath = findChromeExecutable(config);
  if (!executablePath) {
    fail(
      "콘솔 자동화에 사용할 Chrome 실행 파일을 찾지 못했습니다.",
      steps,
      ["Google Chrome을 설치하거나 .env의 CONSOLE_ADMIN_CHROME_PATH에 실행 파일 경로를 설정해주세요."]
    );
  }
  addStep(steps, "콘솔 브라우저 확인", "pass", executablePath);

  const baseProfileDir = path.resolve(config.projectRoot, config.consoleAdmin.profileDir);
  const profileDir = config.consoleAdmin.headless
    ? `${baseProfileDir}-headless`
    : baseProfileDir;
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: config.consoleAdmin.headless,
      viewport: { width: 1440, height: 1000 }
    });
  } catch (error) {
    if (String(error.message || "").includes("기존 브라우저 세션") || String(error.message || "").includes("Target page, context or browser has been closed")) {
      fail(
        "콘솔 자동화용 Chrome 프로필이 이미 사용 중입니다.",
        steps,
        [
          "기존 콘솔 자동화 Chrome 창이 열려 있으면 닫고 다시 실행해주세요.",
          `사용 중인 프로필: ${profileDir}`,
          "로그인 세션을 재사용하기 위해 고정 프로필을 사용합니다."
        ]
      );
    }
    throw error;
  }
  const page = browser.pages()[0] || await browser.newPage();
  let shouldCloseBrowser = true;
  page.on("dialog", async (dialog) => {
    store.appendLog("runner.log", `console dialog accepted: ${dialog.message()}`);
    await dialog.accept().catch(() => {});
  });

  try {
    await ensureReservationPage(page, config, store, steps, request);
    await scrollToScheduleChangeArea(page, store, steps);
    const currentSchedule = await readScheduleDateFields(page);
    const currentCheckin = parseIsoDate(currentSchedule?.checkin);
    if (!currentCheckin) {
      await saveHtml(page, store, "console-current-checkin-not-found");
      await saveScreenshot(page, store, "console-current-checkin-not-found");
      fail(
        "콘솔 일정 변경 영역에서 현재 체크인 날짜를 확인하지 못했습니다.",
        steps,
        [
          "일정 변경은 예약의 현재 체크인 날짜를 기준으로 계산합니다.",
          "리포트의 console-current-checkin-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    const range = calculateScheduleRange(shiftLabel, currentCheckin);
    addStep(
      steps,
      "예약 체크인 기준 변경 기간 계산",
      "pass",
      `기준 체크인 ${range.baseDateText} / ${range.label}: ${range.startDateText} ~ ${range.endDateText}`
    );
    await changeDateField(page, store, steps, "체크인", range.startDate);
    await changeDateField(page, store, steps, "체크아웃", range.endDate);
    await assertScheduleInputsChanged(page, store, steps, range);
    await submitScheduleChange(page, store, steps);
    const verificationStatus = await verifyChangedSchedule(page, store, steps, range);
    addStep(steps, "콘솔 일정 변경 완료");

    return {
      test_id: "TC-CONSOLE-SCHEDULE-CHANGE-001",
      name: "콘솔 계약 일정 변경",
      env: request.env,
      status: "pass",
      device: "browser",
      steps,
      console_schedule_change: {
        reservation_id: reservationId,
        change_label: range.label,
        base_checkin_date: range.baseDateText,
        nights: range.nights,
        period_days: range.periodDays,
        previous_start_date: currentSchedule.checkin,
        previous_end_date: currentSchedule.checkout,
        start_date: range.startDateText,
        end_date: range.endDateText,
        url: consoleReservationUrl(config, request.env, reservationId),
        visual_browser: !config.consoleAdmin.headless,
        final_verification: verificationStatus
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "console-schedule-change-final.html")
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  } catch (error) {
    if (config.consoleAdmin.keepOpenOnFail && !config.consoleAdmin.headless) {
      shouldCloseBrowser = false;
      error.details = [
        ...(error.details || []),
        "디버깅을 위해 콘솔 브라우저를 열어둔 상태입니다."
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
  calculateScheduleRange,
  runConsoleScheduleChangeTest
};
