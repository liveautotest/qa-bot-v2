const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  dumpUi,
  keyEvent,
  runAdb,
  screenshotPng,
  tap
} = require("../infra/adb");
const {
  addDays,
  formatDateIso,
  formatKoreanMonthDay,
  formatMonthLabel,
  getRandomExactSearchDateRange,
  schedulePattern
} = require("./helpers/exact-date-range");
const { inputUnicodeText } = require("./aos-text-input");

const PET_INFO_CANDIDATES = [
  "사자", "호랑이", "치타", "표범", "재규어", "늑대", "여우", "곰", "판다", "코끼리",
  "기린", "얼룩말", "코뿔소", "하마", "캥거루", "코알라", "고릴라", "침팬지", "오랑우탄", "원숭이",
  "사슴", "낙타", "라마", "알파카", "말", "당나귀", "소", "양", "염소", "돼지",
  "토끼", "다람쥐", "햄스터", "고슴도치", "수달", "비버", "너구리", "족제비", "박쥐", "돌고래",
  "고래", "상어", "문어", "오징어", "해파리", "바다거북", "물개", "바다사자", "펭귄", "독수리",
  "매", "올빼미", "부엉이", "앵무새", "까마귀", "참새", "백조", "공작", "타조", "악어",
  "뱀", "도마뱀", "카멜레온", "이구아나", "개구리", "두꺼비", "도롱뇽", "거북이", "도마뱀붙이",
  "장수풍뎅이", "사슴벌레", "풍뎅이", "무당벌레", "반딧불이", "나비", "나방", "잠자리", "매미", "메뚜기",
  "귀뚜라미", "여치", "사마귀", "벌", "꿀벌", "말벌", "개미", "흰개미", "모기", "파리",
  "등에", "벼룩", "이", "바퀴벌레", "하늘소", "물방개", "소금쟁이", "장구벌레", "진딧물", "노린재"
];

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

function decodeXmlValue(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
}

function parseBounds(bounds) {
  const match = String(bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;

  const [, left, top, right, bottom] = match.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2)
  };
}

function parseNodes(xml) {
  const nodes = [];
  const nodePattern = /<node\b[^>]*>/g;
  const attrPattern = /([\w:-]+)="([^"]*)"/g;
  let nodeMatch;

  while ((nodeMatch = nodePattern.exec(xml))) {
    const raw = nodeMatch[0];
    const attrs = {};
    let attrMatch;

    while ((attrMatch = attrPattern.exec(raw))) {
      attrs[attrMatch[1]] = decodeXmlValue(attrMatch[2]);
    }

    nodes.push({ attrs, bounds: parseBounds(attrs.bounds) });
  }

  return nodes;
}

function nodeLabel(node) {
  return [
    node.attrs.text || "",
    node.attrs["content-desc"] || "",
    node.attrs.hint || ""
  ].join("\n");
}

function pickRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function makeRandomGuestProfile(options = {}) {
  const adultCount = randomInt(1, 5);
  const childCount = randomInt(0, 5 - adultCount);
  const requestedPetCount = Number(options.guest_pet_count);
  const petCount = Number.isInteger(requestedPetCount)
    ? Math.max(0, Math.min(2, requestedPetCount))
    : randomInt(0, 2);
  return {
    adultCount,
    childCount,
    infantCount: randomInt(0, 2),
    petCount
  };
}

function findNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    const label = nodeLabel(node);
    const matches = labelList.some((value) => label.includes(value));
    if (!matches) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    if (options.visible && (!node.bounds || node.bounds.bottom <= 94 || node.bounds.top >= 2496)) return false;
    if (options.aboveBottomAction && node.bounds.bottom >= 2220) return false;
    return Boolean(node.bounds);
  });

  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function findEditableNodes(xml) {
  return parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    const className = node.attrs.class || "";
    return className.includes("EditText") && node.attrs.enabled === "true";
  });
}

function getScreenBounds(xml) {
  return parseNodes(xml)
    .map((node) => node.bounds)
    .filter(Boolean)
    .sort((a, b) => (b.right * b.bottom) - (a.right * a.bottom))[0] || null;
}

function getBottomContractRequestButton(xml) {
  if (!xml.includes("계약 요청하기")) return null;

  const screen = getScreenBounds(xml);
  if (!screen?.right || !screen?.bottom) return null;
  const visibleBottom = Math.min(screen.bottom, 2496);

  const button = {
    left: Math.round(screen.right * 0.06),
    top: Math.round(visibleBottom * 0.91),
    right: Math.round(screen.right * 0.94),
    bottom: Math.round(visibleBottom * 0.975)
  };

  return {
    attrs: {
      text: "계약 요청하기",
      clickable: "true",
      enabled: "true"
    },
    bounds: {
      ...button,
      x: Math.round((button.left + button.right) / 2),
      y: Math.round((button.top + button.bottom) / 2)
    }
  };
}

function hasHomeSearchBar(xml) {
  return (
    xml.includes("동네 · 주변 장소로 검색") ||
    xml.includes("동네 주변 장소로 검색")
  );
}

function isLoginStartScreen(xml) {
  return (
    xml.includes("이메일/휴대폰 번호로 시작하기") ||
    xml.includes("카카오로 시작하기") ||
    xml.includes("구글로 시작하기") ||
    xml.includes("로그인 하지 않고 둘러보기")
  );
}

function isSearchConditionScreen(xml) {
  return (
    xml.includes("위치") &&
    xml.includes("일정") &&
    xml.includes("게스트") &&
    (xml.includes("동네 · 주변 장소로 검색") || xml.includes("동네 주변 장소로 검색"))
  );
}

function isGuestScreen(xml) {
  return (
    xml.includes("성인") &&
    xml.includes("어린이") &&
    xml.includes("유아") &&
    xml.includes("반려동물") &&
    xml.includes("검색")
  );
}

function isContractSearchResults(xml, exactDateRange = null) {
  const dateOk = exactDateRange ? xml.includes(exactDateRange.label) : schedulePattern().test(xml);
  return (
    xml.includes("국내") &&
    dateOk &&
    !xml.includes("일주일 / 1명") &&
    xml.includes("필터") &&
    (/\d[\d,]*개의 집/.test(xml) || xml.includes("지도로 보기") || xml.includes("리브 추천 순"))
  );
}

function isAccommodationDetail(xml) {
  return (
    xml.includes("계약 조건 확인") ||
    (
      xml.includes("가산역 신축 풀옵션") &&
      xml.includes("₩511,815") &&
      (xml.includes("외국인 환영") || xml.includes("오피스텔"))
    )
  );
}

function isContractDetail(xml) {
  return (
    xml.includes("계약 요청하기") &&
    xml.includes("계약자 정보") &&
    xml.includes("필수 약관 전체 동의")
  );
}

function getContractNumber(xml) {
  const match = String(xml || "").match(/계약\s*번호:?\s*(\d+)/);
  return match ? match[1] : "";
}

function getHomeRequestCardSummary(xml) {
  const scheduleRegex = schedulePattern();
  const card = parseNodes(xml).find((node) => {
    if (!node.bounds) return false;
    const label = nodeLabel(node);
    return (
      label.includes("요청 중") &&
      scheduleRegex.test(label) &&
      label.includes("성인 1")
    );
  });

  if (!card) return null;

  const lines = nodeLabel(card)
    .replace(/\s*\|\s*/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const statusIndex = lines.findIndex((line) => line.includes("요청 중"));

  return {
    status: "요청 중",
    title: lines[statusIndex + 1] || "",
    schedule: lines.find((line) => scheduleRegex.test(line)) || "",
    guest: lines.find((line) => line.includes("성인 1")) || "",
    raw: lines.join(" | ")
  };
}

function isContractRequestScreen(xml) {
  return (
    xml.includes("계약 요청하기") &&
    (
      xml.includes("필수 약관 전체 동의") ||
      xml.includes("결제 수단") ||
      xml.includes("계약자 정보")
    )
  );
}

function hasContractRequestError(xml) {
  return [
    "반려동물 정보를 채워야 계약 요청을 할 수 있어요",
    "오류가 발생했습니다",
    "일시적인 오류가 발생했습니다",
    "다시 시도"
  ].some((text) => xml.includes(text));
}

function extractContractRequestError(xml) {
  const texts = [
    "반려동물 정보를 채워야 계약 요청을 할 수 있어요",
    "일시적인 오류로 요청하지 못 했습니다. 잠시 후 다시 시도해 주세요.",
    "일시적인 오류가 발생했습니다",
    "오류가 발생했습니다",
    "다시 시도"
  ];
  return texts.find((text) => xml.includes(text)) || "";
}

function hasTermsAgreementWarning(xml) {
  return xml.includes("약관을 전체 동의해 주세요");
}

function isContractPeriodConfirm(xml) {
  return (
    xml.includes("계약 기간 확인") &&
    xml.includes("요청 계속하기")
  );
}

function findAutoCardPaymentOption(xml) {
  const optionText = findNode(xml, [
    "호스트 수락 즉시 자동 결제",
    "호스트 수락 즉시 자동결제",
    "수락 즉시 자동 결제",
    "자동 결제"
  ], {
    enabled: true,
    visible: true,
    aboveBottomAction: true
  });

  if (!optionText?.bounds) return null;

  const clickableOption = findNode(xml, [
    "호스트 수락 즉시 자동 결제",
    "호스트 수락 즉시 자동결제",
    "수락 즉시 자동 결제",
    "자동 결제"
  ], {
    clickable: true,
    enabled: true,
    visible: true,
    aboveBottomAction: true
  });

  if (clickableOption?.bounds) return clickableOption;

  return {
    ...optionText,
    bounds: {
      ...optionText.bounds,
      x: 78,
      y: optionText.bounds.y
    }
  };
}

function hasAutoCardPaymentSelected(xml) {
  return (
    xml.includes("호스트 수락 즉시 자동 결제 선택됨") ||
    xml.includes("호스트 수락 즉시 자동결제 선택됨") ||
    xml.includes("자동 결제 선택됨")
  );
}

function isSafelyTappableSplitPaymentBounds(bounds) {
  return Boolean(
    bounds &&
    bounds.bottom - bounds.top >= 40 &&
    bounds.top >= 320 &&
    bounds.bottom <= 2134
  );
}

function findSplitPaymentOption(xml) {
  const optionText = parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      node.attrs.enabled === "true" &&
      ["분할 결제", "분할결제", "분할 납부"].some((value) => label.includes(value)) &&
      isSafelyTappableSplitPaymentBounds(node.bounds)
    );
  });

  if (!optionText?.bounds) return null;

  const clickableOption = parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled === "true" &&
      ["분할 결제", "분할결제", "분할 납부"].some((value) => label.includes(value)) &&
      isSafelyTappableSplitPaymentBounds(node.bounds)
    );
  });

  if (clickableOption?.bounds) return clickableOption;

  // 라디오 버튼이 텍스트와 별도 노드로 노출되지 않는 화면이 있어 텍스트 왼쪽 영역을 사용한다.
  return {
    attrs: { text: "분할 결제", clickable: "true", enabled: "true" },
    bounds: {
      left: Math.max(32, optionText.bounds.left - 96),
      top: Math.max(94, optionText.bounds.top - 24),
      right: optionText.bounds.left + 16,
      bottom: optionText.bounds.bottom + 24,
      x: Math.max(72, optionText.bounds.left - 48),
      y: optionText.bounds.y
    }
  };
}

function hasSplitPaymentSelected(xml) {
  return (
    xml.includes("분할 결제 선택됨") ||
    xml.includes("분할결제 선택됨") ||
    xml.includes("분할 결제 (단기 월세)") ||
    xml.includes("1회차 금액이 자동으로 결제") ||
    (
      (xml.includes("분할 결제") || xml.includes("분할결제")) &&
      xml.includes("선택됨")
    )
  );
}

function isContractComplete(xml) {
  return (
    (xml.includes("홈으로") || xml.includes("계약 확인")) &&
    (
      xml.includes("계약 요청") ||
      xml.includes("계약 요청을 보냈습니다") ||
      xml.includes("요청이 완료") ||
      xml.includes("계약이 요청")
    )
  );
}

function isContractSubmitting(xml) {
  return (
    xml.includes("계약 요청중입니다") ||
    xml.includes("계약 요청 중입니다") ||
    xml.includes("계약 요청중") ||
    xml.includes("계약 요청 중")
  );
}

function isInvalidUiDump(xml) {
  return (
    !xml ||
    xml.includes("ERROR: could not get idle state") ||
    !xml.includes("<hierarchy")
  );
}

async function dumpUiStable(config, device, attempts = 4) {
  let xml = "";

  for (let count = 0; count < attempts; count += 1) {
    xml = await dumpUi(config, device);
    if (!isInvalidUiDump(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return xml;
}

async function waitForUi(config, device, predicate, timeoutMs = 10000, intervalMs = 300) {
  const startedAt = Date.now();
  let xml = "";

  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUiStable(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return xml;
}

async function saveArtifacts(config, device, store, name, xml, options = {}) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  const shouldCaptureScreenshot = options.screenshot === true;

  try {
    fs.writeFileSync(xmlPath, xml || (await dumpUiStable(config, device)));
  } catch (error) {
    store.appendLog("runner.log", `failed to dump ui ${name}: ${error.message}`);
  }

  if (shouldCaptureScreenshot) {
    try {
      fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
    } catch (error) {
      store.appendLog("runner.log", `failed to screenshot ${name}: ${error.message}`);
    }
  }

  return { xmlPath, screenshotPath: shouldCaptureScreenshot ? screenshotPath : null };
}

async function saveFailureArtifacts(config, device, store, name, xml) {
  return saveArtifacts(config, device, store, name, xml, { screenshot: true });
}

async function isKeyguardShowing(config, device, store) {
  try {
    const output = await runAdb(config, device, ["shell", "dumpsys", "window"]);
    return /mDreamingLockscreen=true|mShowingLockscreen=true|isStatusBarKeyguard=true/.test(output);
  } catch (error) {
    store.appendLog("runner.log", `keyguard state check failed: ${error.message}`);
    return false;
  }
}

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  const wasLocked = await isKeyguardShowing(config, device, store);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });

  if (wasLocked && (await isKeyguardShowing(config, device, store))) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "600", "300"]);
    store.appendLog("runner.log", "wakeAndUnlock sent unlock swipe because keyguard was still visible");
  } else {
    store.appendLog("runner.log", "wakeAndUnlock skipped unlock swipe because device was already usable");
  }

  await new Promise((resolve) => setTimeout(resolve, wasLocked ? 500 : 250));
  addStep(steps, "단말 깨우기 및 잠금 해제 시도");
}

async function launchFresh(config, device, appPackage, steps) {
  await runAdb(config, device, ["shell", "am", "force-stop", appPackage]);
  addStep(steps, "앱 완전 종료");
  await new Promise((resolve) => setTimeout(resolve, 450));
  await runAdb(config, device, [
    "shell",
    "monkey",
    "-p",
    appPackage,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ]);
  addStep(steps, "앱 재실행");
}

async function prepareHomeForContractRequest(config, device, appPackage, store, steps, options = {}) {
  if (options.skipFreshLaunch) {
    await tap(config, device, 540, 360);
    let xml = await waitForUi(config, device, isSearchConditionScreen, 650, 120);
    if (isSearchConditionScreen(xml)) {
      await saveArtifacts(config, device, store, "search-condition-fast-reuse", xml);
      addStep(steps, "기본검증 기존 홈 검색바 즉시 진입");
      return xml;
    }

    xml = await waitForUi(config, device, hasHomeSearchBar, 700, 160);
    await saveArtifacts(config, device, store, "search-home-before-reuse", xml);
    if (hasHomeSearchBar(xml)) {
      addStep(steps, "기본검증 기존 홈 화면 재사용");
      return xml;
    }

    store.appendLog("runner.log", "contract-request could not reuse current screen; launching app fresh");
    addStep(steps, "기존 화면 재사용 불가, 앱 재실행으로 복구");
  }

  await launchFresh(config, device, appPackage, steps);
  let xml = "";
  for (let count = 0; count < 3; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, count === 0 ? 260 : 180));
    await tap(config, device, 540, 360);
    xml = await waitForUi(config, device, isSearchConditionScreen, 520, 120);
    if (isSearchConditionScreen(xml)) {
      addStep(steps, "홈 검색바 빠른 진입", "pass", `앱 재실행 후 예상 검색바 좌표 ${count + 1}회 탭`);
      return xml;
    }
  }

  store.appendLog("runner.log", "contract-request fast home search tap did not open search condition; falling back to XML search");
  xml = await waitForUi(config, device, hasHomeSearchBar, 2500, 200);
  return xml;
}

async function tapNode(config, device, node, label, steps) {
  if (!node?.bounds) {
    fail(`${label}을 찾지 못했습니다.`, steps);
  }
  await tap(config, device, node.bounds.x, node.bounds.y);
}

function isContractSubmitOutcome(xml) {
  return (
    isContractComplete(xml) ||
    isContractPeriodConfirm(xml) ||
    hasTermsAgreementWarning(xml) ||
    hasContractRequestError(xml) ||
    isContractSubmitting(xml)
  );
}

async function pressContractRequestButton(config, device, store, button, mode = "tap") {
  if (!button?.bounds) {
    throw new Error("Contract request button bounds were not available.");
  }

  const x = button.bounds.x;
  const y = Math.min(
    button.bounds.bottom - 70,
    Math.max(button.bounds.top + 70, button.bounds.y)
  );

  store.appendLog(
    "runner.log",
    `contract-request submit ${mode}: bounds=[${button.bounds.left},${button.bounds.top}][${button.bounds.right},${button.bounds.bottom}] point=(${x}, ${y})`
  );

  if (mode === "press") {
    await runAdb(config, device, [
      "shell", "input", "swipe", String(x), String(y), String(x), String(y), "120"
    ]);
    return;
  }

  await tap(config, device, x, y);
}

function hasRequiredTermOverlappingSubmit(xml) {
  const request = findNode(xml, "계약 요청하기", {
    clickable: true,
    enabled: true,
    visible: true
  });
  if (!request?.bounds) return false;

  const requiredTerms = [
    "결제대행 서비스 이용약관 동의",
    "개인정보 제 3자 제공 동의",
    "이용 규칙 및 환불 규정 동의"
  ];

  return requiredTerms.some((label) => {
    const node = findNode(xml, label, { enabled: true, visible: true });
    return node?.bounds && node.bounds.bottom > request.bounds.top - 16;
  });
}

async function liftRequiredTermsAboveSubmit(config, device, store, xml) {
  let currentXml = xml;

  for (let count = 0; count < 3; count += 1) {
    if (!hasRequiredTermOverlappingSubmit(currentXml)) return currentXml;

    store.appendLog(
      "runner.log",
      `contract-request required terms overlap submit button; lifting content (${count + 1})`
    );
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "2180", "540", "1910", "180"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 220));
    currentXml = await dumpUiStable(config, device);
  }

  return currentXml;
}

async function tapSearchBar(config, device, xml, steps) {
  const searchBar = findNode(xml, [
    "동네 · 주변 장소로 검색",
    "동네 주변 장소로 검색"
  ], { clickable: true });

  if (!searchBar?.bounds) {
    fail(
      "홈 화면에서 검색바를 찾지 못했습니다.",
      steps,
      [
        "계약 요청은 검색 결과에서 이어지므로 홈 검색바 진입이 먼저 필요합니다.",
        "리포트의 search-home.png 화면을 확인해주세요."
      ]
    );
  }

  const fastX = searchBar.bounds.x;
  const fastY = Math.max(260, Math.min(searchBar.bounds.y, 560));
  await tap(config, device, fastX, fastY);
  addStep(steps, "홈 검색바 탭", "pass", "검색바 확인 후 즉시 탭");
}

async function selectDomesticRegion(config, device, xml, steps) {
  const domestic = findNode(xml, "국내", { clickable: true });
  await tapNode(config, device, domestic, "국내 지역 탭", steps);
  addStep(steps, "국내 지역 탭 선택");
}

function findDateNodeInMonth(xml, monthLabel, dayLabel) {
  const nodes = parseNodes(xml);
  const month = nodes.find((node) => nodeLabel(node).includes(monthLabel) && node.bounds);
  if (!month) return null;

  return nodes.find((node) => {
    if (!node.bounds) return false;
    if (node.attrs.clickable !== "true") return false;
    if (nodeLabel(node).trim() !== dayLabel) return false;
    return (
      node.bounds.left >= month.bounds.left &&
      node.bounds.right <= month.bounds.right &&
      node.bounds.top >= month.bounds.top &&
      node.bounds.bottom <= month.bounds.bottom
    );
  });
}

function isVisibleCalendarBounds(bounds) {
  return Boolean(
    bounds &&
    bounds.bottom > 94 &&
    bounds.bottom < 2134 &&
    bounds.bottom > bounds.top &&
    bounds.right > bounds.left
  );
}

function isMonthLabelVisible(xml, monthLabel) {
  return parseNodes(xml).some((node) => (
    nodeLabel(node).includes(monthLabel) &&
    isVisibleCalendarBounds(node.bounds)
  ));
}

function parseCalendarMonthIndex(label) {
  const [, yearText, monthText] = String(label || "").match(/(\d{4})년\s*(\d{1,2})월/) || [];
  if (!yearText || !monthText) return null;
  return Number(yearText) * 12 + Number(monthText) - 1;
}

function visibleCalendarMonths(xml) {
  return parseNodes(xml)
    .map((node) => ({
      label: nodeLabel(node),
      bounds: node.bounds,
      index: parseCalendarMonthIndex(nodeLabel(node))
    }))
    .filter((month) => month.index !== null && isVisibleCalendarBounds(month.bounds))
    .sort((a, b) => a.bounds.top - b.bounds.top);
}

function findVisibleDateNodeInMonth(xml, monthLabel, dayLabel) {
  const nodes = parseNodes(xml);
  const month = nodes.find((node) => (
    nodeLabel(node).includes(monthLabel) &&
    isVisibleCalendarBounds(node.bounds)
  ));
  if (!month) return null;

  const nextMonth = nodes.find((node) => (
    /\d{4}년\s*\d{1,2}월/.test(nodeLabel(node)) &&
    isVisibleCalendarBounds(node.bounds) &&
    node.bounds.top > month.bounds.top
  ));
  const upperBound = month.bounds.bottom;
  const lowerBound = nextMonth?.bounds.top || 2134;

  return nodes.find((node) => {
    if (!isVisibleCalendarBounds(node.bounds)) return false;
    if (node.attrs.clickable !== "true") return false;
    if (nodeLabel(node).trim() !== dayLabel) return false;
    return (
      node.bounds.top > upperBound &&
      node.bounds.bottom < lowerBound
    );
  });
}

async function ensureMonthVisible(config, device, xml, steps, monthLabel) {
  let currentXml = xml;
  for (let count = 0; count < 4; count += 1) {
    if (currentXml.includes(monthLabel)) return currentXml;
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "1900", "540", "1100", "500"
    ]);
    addStep(steps, "달력 스크롤", "pass", `${monthLabel} 탐색`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    currentXml = await dumpUiStable(config, device);
  }
  return currentXml;
}

async function ensureCalendarDateVisible(config, device, xml, steps, date) {
  const monthLabel = formatMonthLabel(date);
  const dayLabel = String(date.getDate());
  let currentXml = xml;
  const targetMonthIndex = parseCalendarMonthIndex(monthLabel);

  for (let count = 0; count < 18; count += 1) {
    if (findVisibleDateNodeInMonth(currentXml, monthLabel, dayLabel) || findDateNodeInMonth(currentXml, monthLabel, dayLabel)) {
      return currentXml;
    }

    const months = visibleCalendarMonths(currentXml);
    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    const targetBefore = targetMonthIndex !== null && firstMonth && targetMonthIndex < firstMonth.index;
    const swipe = targetBefore
      ? ["shell", "input", "swipe", "540", "760", "540", "1680", "180"]
      : ["shell", "input", "swipe", "540", "1880", "540", "720", "180"];

    await runAdb(config, device, swipe);
    addStep(
      steps,
      targetBefore ? "달력 이전 날짜 영역 스크롤" : "달력 체크아웃 날짜 영역 스크롤",
      "pass",
      `${monthLabel} ${dayLabel}일 탐색${firstMonth && lastMonth ? ` / 현재 ${firstMonth.label} ~ ${lastMonth.label}` : ""}`
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    currentXml = await dumpUiStable(config, device);
  }

  return currentXml;
}

async function selectCalendarDate(config, device, store, steps, xml, date, stepName, artifactName) {
  let currentXml = await ensureCalendarDateVisible(config, device, xml, steps, date);
  await saveArtifacts(config, device, store, artifactName, currentXml);
  const monthLabel = formatMonthLabel(date);
  const dayLabel = String(date.getDate());
  const dateNode =
    findVisibleDateNodeInMonth(currentXml, monthLabel, dayLabel) ||
    findDateNodeInMonth(currentXml, monthLabel, dayLabel);
  if (!dateNode?.bounds) {
    await saveFailureArtifacts(config, device, store, `${artifactName}-not-found`, currentXml);
    fail(
      `달력에서 ${stepName} 날짜를 찾지 못했습니다.`,
      steps,
      [
        `선택 대상: ${formatDateIso(date)} (${monthLabel} ${dayLabel}일)`,
        "정확한 일정은 체크인 날짜 선택 후 체크아웃 날짜가 보일 때까지 달력을 빠르게 스크롤합니다.",
        `리포트의 ${artifactName}-not-found.png 화면을 확인해주세요.`
      ]
    );
  }

  await tap(config, device, dateNode.bounds.x, dateNode.bounds.y);
  addStep(steps, stepName, "pass", `${monthLabel} ${dayLabel}일`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return dumpUiStable(config, device);
}

async function selectExactDates(config, device, xml, store, steps, exactDateRange) {
  const scheduleTab = findNode(xml, "일정", { clickable: true });
  await tapNode(config, device, scheduleTab, "일정 탭", steps);
  addStep(steps, "일정 탭 진입");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => nextXml.includes("정확한 일정") && nextXml.includes("유연한 일정"),
    3500,
    200
  );
  await saveArtifacts(config, device, store, "calendar-open", xml);

  const exact = findNode(xml, "정확한 일정", { clickable: true });
  await tapNode(config, device, exact, "정확한 일정 탭", steps);
  addStep(steps, "정확한 일정 선택");
  await new Promise((resolve) => setTimeout(resolve, 120));

  xml = await dumpUiStable(config, device);
  await saveArtifacts(config, device, store, "calendar-before-select", xml);

  xml = await selectCalendarDate(config, device, store, steps, xml, exactDateRange.start, "체크인 날짜 선택", "calendar-before-checkin");
  xml = await selectCalendarDate(config, device, store, steps, xml, exactDateRange.end, "체크아웃 날짜 선택", "calendar-before-checkout");

  await saveArtifacts(config, device, store, "calendar-after-select", xml);
  const next = findNode(xml, "다음", { clickable: true, enabled: true });
  await tapNode(config, device, next, "다음 버튼", steps);
  addStep(steps, "일정 다음 버튼 탭");
}

async function submitDefaultGuests(config, device, xml, store, steps) {
  const guestXml = await waitForUi(config, device, isGuestScreen, 8000);
  await saveArtifacts(config, device, store, "guest-select-default", guestXml);
  if (!isGuestScreen(guestXml)) {
    fail(
      "인원 선택 화면으로 이동하지 못했습니다.",
      steps,
      [
        "계약 요청 선행 검색은 어린이, 유아, 반려동물을 추가하지 않은 기본 성인 1명 상태를 사용합니다.",
        "리포트의 guest-select-default.png 화면을 확인해주세요."
      ]
    );
  }

  const labels = parseNodes(guestXml).map(nodeLabel).join("\n");
  if (
    !labels.includes("성인\n만 13세 이상\n1") ||
    !labels.includes("어린이\n만 2~12세\n0") ||
    !labels.includes("유아\n만 2세 미만\n0") ||
    !labels.includes("반려동물\n0")
  ) {
    fail(
      "계약 요청용 기본 인원 상태를 확인하지 못했습니다.",
      steps,
      [
        "계약 요청 기본 케이스는 어린이, 유아, 반려동물을 추가하지 않고 성인 1명으로 검색합니다.",
        "리포트의 guest-select-default.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "계약 요청용 기본 인원 확인", "pass", "성인 1, 어린이 0, 유아 0, 반려동물 0");
  const search = findNode(guestXml, "검색", { clickable: true, enabled: true });
  await tapNode(config, device, search, "검색 버튼", steps);
  addStep(steps, "검색 버튼 탭");
}

function guestOptionsSelected(xml, profile) {
  const labels = parseNodes(xml).map(nodeLabel).join("\n");
  return (
    labels.includes(`성인\n만 13세 이상\n${profile.adultCount}`) &&
    labels.includes(`어린이\n만 2~12세\n${profile.childCount}`) &&
    labels.includes(`유아\n만 2세 미만\n${profile.infantCount}`) &&
    labels.includes(`반려동물\n${profile.petCount}`)
  );
}

async function submitRandomProfileGuests(config, device, xml, store, steps, profile) {
  let guestXml = await waitForUi(config, device, isGuestScreen, 8000);
  await saveArtifacts(config, device, store, "guest-select-random-profile-start", guestXml);
  if (!isGuestScreen(guestXml)) {
    fail(
      "인원 선택 화면으로 이동하지 못했습니다.",
      steps,
      [
        "랜덤 일반결제 검증은 성인/어린이/유아/반려동물 인원을 무작위로 선택합니다.",
        "리포트의 guest-select-random-profile-start.png 화면을 확인해주세요."
      ]
    );
  }

  const plusButtons = parseNodes(guestXml).filter(
    (node) =>
      node.bounds &&
      node.attrs.class === "android.widget.Button" &&
      node.attrs.clickable === "true" &&
      node.bounds.left >= 900 &&
      node.bounds.top >= 300 &&
      node.bounds.top <= 1150
  );

  const targets = [
    { node: plusButtons.find((node) => node.bounds.top >= 300 && node.bounds.top <= 520), label: "성인 + 버튼", taps: profile.adultCount - 1 },
    { node: plusButtons.find((node) => node.bounds.top >= 540 && node.bounds.top <= 700), label: "어린이 + 버튼", taps: profile.childCount },
    { node: plusButtons.find((node) => node.bounds.top >= 760 && node.bounds.top <= 920), label: "유아 + 버튼", taps: profile.infantCount },
    { node: plusButtons.find((node) => node.bounds.top >= 980 && node.bounds.top <= 1120), label: "반려동물 + 버튼", taps: profile.petCount }
  ];

  for (const target of targets) {
    if (target.taps <= 0) continue;
    if (!target.node?.bounds) {
      fail(
        `${target.label}을 찾지 못했습니다.`,
        steps,
        [
          "인원 선택 화면의 + 버튼은 텍스트 없이 잡히므로 좌표 범위로 찾습니다.",
          "리포트의 guest-select-random-profile-start.png 화면을 확인해주세요."
        ]
      );
    }
    for (let count = 0; count < target.taps; count += 1) {
      await tap(config, device, target.node.bounds.x, target.node.bounds.y);
      addStep(steps, `${target.label} 탭`, "pass", `${count + 1}/${target.taps}`);
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
  }

  guestXml = await dumpUiStable(config, device);
  await saveArtifacts(config, device, store, "guest-select-random-profile-after-plus", guestXml);
  if (!guestOptionsSelected(guestXml, profile)) {
    fail(
      "일반결제 랜덤 인원 상태를 확인하지 못했습니다.",
      steps,
      [
        `선택 대상: 성인 ${profile.adultCount}, 어린이 ${profile.childCount}, 유아 ${profile.infantCount}, 반려동물 ${profile.petCount}`,
        "리포트의 guest-select-random-profile-after-plus.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(
    steps,
    "계약 요청용 랜덤 인원 확인",
    "pass",
    `성인 ${profile.adultCount}, 어린이 ${profile.childCount}, 유아 ${profile.infantCount}, 반려동물 ${profile.petCount}`
  );
  const search = findNode(guestXml, "검색", { clickable: true, enabled: true });
  await tapNode(config, device, search, "검색 버튼", steps);
  addStep(steps, "검색 버튼 탭");
}

function findListingCandidates(xml) {
  const visibleTop = 415;
  const visibleBottom = 2320;
  return parseNodes(xml).filter((node) => {
    const label = nodeLabel(node);
    const lines = label
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const visibleHeight = node.bounds
      ? Math.min(node.bounds.bottom, visibleBottom) - Math.max(node.bounds.top, visibleTop)
      : 0;
    return (
      node.bounds &&
      node.attrs.clickable === "true" &&
      node.bounds.top >= 350 &&
      node.bounds.top < visibleBottom &&
      node.bounds.bottom > node.bounds.top &&
	      visibleHeight >= 520 &&
	      label.includes("최소") &&
	      !lines.includes("환상의 나라") &&
	      /계약\s*가능/.test(label) &&
      (
        label.includes("주택") ||
        label.includes("오피스텔") ||
        label.includes("독채") ||
        label.includes("아파트") ||
        label.includes("원룸") ||
        label.includes("숙소") ||
        label.includes("집")
      )
    );
  }).sort((a, b) => a.bounds.top - b.bounds.top);
}

async function scrollToMiddleListingArea(config, device, store, steps, xml, exactDateRange) {
  const firstListings = findListingCandidates(xml);
  const skippedTitles = firstListings
    .slice(0, 2)
    .map((listing) => listingTitle(listing))
    .filter(Boolean);
  if (skippedTitles.length) {
    store.appendLog("runner.log", `contract-request scrolling past first visible listings: ${skippedTitles.join(", ")}`);
  }

  // 검색 결과 첫 카드들은 지도/바텀시트 경계에 걸리는 경우가 많아서 3~4번째 후보가
  // 화면 중앙에 오도록 더 깊게 당긴 뒤 선택한다.
  await runAdb(config, device, [
    "shell", "input", "swipe", "540", "2220", "540", "720", "560"
  ]);
  addStep(
    steps,
    "검색 결과 3~4번째 숙소 영역까지 스크롤",
    "pass",
    skippedTitles.length ? `상단 후보 제외: ${skippedTitles.join(" / ")}` : "상단 후보 미확인, 중간 목록 후보 사용"
  );
  await new Promise((resolve) => setTimeout(resolve, 260));

  const scrolledXml = await waitForUi(
    config,
    device,
    (nextXml) => isContractSearchResults(nextXml, exactDateRange),
    2500,
    180
  );

  return {
    xml: isContractSearchResults(scrolledXml, exactDateRange) ? scrolledXml : await dumpUiStable(config, device),
    skippedTitles
  };
}

async function selectNewestSort(config, device, store, steps, xml, exactDateRange) {
  if (xml.includes("신규 집 순")) {
    addStep(steps, "검색 결과 정렬 확인", "pass", "신규 집 순");
    return xml;
  }

  const sortButton = findNode(xml, ["리브 추천 순", "리브 추천순"], {
    clickable: true,
    visible: true
  });
  if (!sortButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "search-sort-button-not-found", xml);
    fail(
      "검색 결과 화면에서 정렬 필터를 찾지 못했습니다.",
      steps,
      [
        "계약 요청은 검색 결과를 '신규 집 순'으로 정렬한 뒤 3~4번째 숙소 후보를 우선 선택합니다.",
        "리포트의 search-sort-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, sortButton, "리브 추천 순 정렬 필터", steps);
  addStep(steps, "검색 결과 정렬 필터 선택", "pass", "리브 추천 순");

  let sortXml = await waitForUi(config, device, (nextXml) => nextXml.includes("신규 집 순"), 6000);
  await saveArtifacts(config, device, store, "search-sort-options", sortXml);
  const newest = findNode(sortXml, "신규 집 순", {
    clickable: true,
    enabled: true,
    visible: true
  });
  if (!newest?.bounds) {
    await saveFailureArtifacts(config, device, store, "search-newest-sort-not-found", sortXml);
    fail(
      "검색 결과 정렬 옵션에서 신규 집 순을 찾지 못했습니다.",
      steps,
      [
        "정렬 필터를 열었지만 '신규 집 순' 옵션이 실제 탭 가능한 좌표로 확인되지 않았습니다.",
        "리포트의 search-newest-sort-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, newest, "신규 집 순 정렬 옵션", steps);
  addStep(steps, "검색 결과 신규 집 순 정렬 선택");

  const resultXml = await waitForUi(
    config,
    device,
    (nextXml) => isContractSearchResults(nextXml, exactDateRange) && nextXml.includes("신규 집 순"),
    8000
  );
  await saveArtifacts(config, device, store, "search-results-newest-sort", resultXml);
  if (!isContractSearchResults(resultXml, exactDateRange) || !resultXml.includes("신규 집 순")) {
    await saveFailureArtifacts(config, device, store, "search-newest-sort-not-applied", resultXml);
    fail(
      "검색 결과 신규 집 순 정렬 적용을 확인하지 못했습니다.",
      steps,
      [
        "신규 집 순을 선택한 뒤 검색 결과 화면의 정렬 라벨이 '신규 집 순'으로 바뀌어야 합니다.",
        "리포트의 search-newest-sort-not-applied.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "검색 결과 신규 집 순 정렬 확인");
  return resultXml;
}

function listingInfo(listing) {
  const lines = nodeLabel(listing)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines.find((line) => (
    !/^(1\/\d+|오피스텔|독채|아파트|원룸|주택|단기 월세|신규 등록|최소)/.test(line) &&
    !line.includes("계약 가능") &&
    !line.includes("개의 집") &&
    !line.includes("/박") &&
    !line.includes("/146박")
  )) || "숙소 카드";

  return { title };
}

function listingTitle(listing) {
  return listingInfo(listing).title;
}

function listingTapTargets(listing) {
  const safeTop = Math.max(listing.bounds.top + 120, 450);
  const safeBottom = Math.min(listing.bounds.bottom - 120, 2320);
  const point = (name, x, y) => ({
    name,
    x: Math.max(listing.bounds.left + 120, Math.min(listing.bounds.right - 120, x)),
    y: Math.max(safeTop, Math.min(safeBottom, y))
  });

  return [
    point("숙소 카드 이미지 영역", listing.bounds.x, listing.bounds.top + 260),
    point("숙소 카드 제목 왼쪽 영역", listing.bounds.left + 260, listing.bounds.top + 700),
    point("숙소 카드 설명 왼쪽 영역", listing.bounds.left + 240, listing.bounds.top + 790),
    point("숙소 카드 제목 영역", listing.bounds.left + 320, listing.bounds.top + 620),
    point("숙소 카드 중앙 영역", listing.bounds.x, listing.bounds.y)
  ].filter((target) => target.y >= 450 && target.y <= 2320);
}

function pickPreferredListing(listings) {
  if (!listings.length) return null;

  const stableListings = listings.filter((listing) => (
    listing.bounds.top >= 560 &&
    listing.bounds.bottom <= 2320 &&
    listing.bounds.bottom - listing.bounds.top >= 620
  ));
  const source = stableListings.length ? stableListings : listings;
  const preferred = [source[2], source[3]].filter(Boolean);
  if (preferred.length) {
    return {
      listing: preferred[Math.floor(Math.random() * preferred.length)],
      source,
      mode: "3~4번째 후보"
    };
  }

  return {
    listing: source[Math.floor(Math.random() * source.length)],
    source,
    mode: "보이는 후보"
  };
}

async function tryOpenListing(config, device, store, steps, listing, attemptLabel, exactDateRange) {
  const info = listingInfo(listing);
  const title = info.title;
  for (const target of listingTapTargets(listing)) {
    await tap(config, device, target.x, target.y);
    store.appendLog(
      "runner.log",
      `contract-request listing tap: ${attemptLabel} ${title} ${target.name} (${target.x}, ${target.y})`
    );

    const detailXml = await waitForUi(config, device, isAccommodationDetail, 5000, 200);
    if (isAccommodationDetail(detailXml)) {
      addStep(steps, "검색 결과 숙소 상세 진입", "pass", `${title} / ${target.name}`);
      return { detailXml, title };
    }

    if (!isContractSearchResults(detailXml, exactDateRange)) {
      await keyEvent(config, device, 4).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  return null;
}

async function openContractableListing(config, device, store, steps, exactDateRange) {
  await runAdb(config, device, [
    "shell", "input", "swipe", "540", "2300", "540", "900", "700"
  ]);
  addStep(steps, "검색 결과 리스트 끌어올리기");
  await new Promise((resolve) => setTimeout(resolve, 300));

  let xml = await dumpUiStable(config, device);
  await saveArtifacts(config, device, store, "search-results-expanded", xml);

  const scrolled = await scrollToMiddleListingArea(config, device, store, steps, xml, exactDateRange);
  xml = scrolled.xml;
  await saveArtifacts(config, device, store, "search-results-middle-listings", xml);

  let lastXml = xml;
  for (let scrollCount = 0; scrollCount < 4; scrollCount += 1) {
    const listings = findListingCandidates(xml);
    if (listings.length) {
      addStep(steps, "검색 결과 계약 가능 숙소 후보 확인", "pass", `${listings.length}개`);

      const selection = pickPreferredListing(listings);
      const selectedListing = selection.listing;
      const selectedIndex = selection.source.indexOf(selectedListing);
      addStep(
        steps,
        "검색 결과 3~4번째 숙소 우선 랜덤 선택",
        "pass",
        `${listingTitle(selectedListing)} (${selection.mode}, ${selectedIndex + 1}/${selection.source.length})`
      );

      const opened = await tryOpenListing(config, device, store, steps, selectedListing, `${scrollCount + 1}-${selectedIndex + 1}`, exactDateRange);
      if (opened?.detailXml && isAccommodationDetail(opened.detailXml)) {
        return opened;
      }
      xml = await waitForUi(config, device, (nextXml) => isContractSearchResults(nextXml, exactDateRange), 3000, 200);
    }

    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "2050", "540", "1350", "450"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    xml = await dumpUiStable(config, device);
    lastXml = xml;
  }

  await saveFailureArtifacts(config, device, store, "listing-tap-did-not-open-detail", lastXml);
  fail(
    "검색 결과 숙소 카드를 눌렀지만 상세 화면으로 이동하지 않았습니다.",
    steps,
    [
      "자동화가 목록을 더 내려 3~4번째 계약 가능 숙소 후보를 우선 랜덤 선택했습니다.",
      "집 이름이 정확히 '환상의 나라'인 숙소만 계약 요청 검증 대상에서 제외합니다.",
      "상세 화면의 '계약 조건 확인' 버튼이 나타나야 다음 단계로 진행합니다.",
      "리포트의 listing-tap-did-not-open-detail.png 화면을 확인해주세요.",
      "실제 탭 좌표는 runner.log에 기록됩니다."
    ]
  );
}

async function tapContractCondition(config, device, store, steps, detailXml) {
  const xml = isAccommodationDetail(detailXml)
    ? detailXml
    : await waitForUi(
    config,
    device,
    isAccommodationDetail,
    15000
  );
  await saveArtifacts(config, device, store, "accommodation-detail", xml);

  const contractCondition = findNode(xml, "계약 조건 확인", {
    clickable: true,
    enabled: true
  });
  if (!contractCondition?.bounds) {
    await saveFailureArtifacts(config, device, store, "accommodation-detail", xml);
    fail(
      "숙소 상세 화면에서 계약 조건 확인 버튼을 찾지 못했습니다.",
      steps,
      [
        "숙소 상세 화면 진입 후 하단 고정 버튼 '계약 조건 확인'을 찾습니다.",
        "버튼이 화면에 보이는데 실패했다면 accessibility label 또는 XML 노출 방식이 바뀐 것입니다.",
        "리포트의 accommodation-detail.png 화면을 확인해주세요."
      ]
    );
  }

  const tapTargets = [
    {
      name: "XML 버튼 영역",
      x: contractCondition.bounds.x,
      y: contractCondition.bounds.y
    },
    {
      name: "하단 고정 버튼 중앙 좌표",
      x: 540,
      y: 2388
    }
  ];

  let contractDetailXml = "";
  for (const target of tapTargets) {
    await tap(config, device, target.x, target.y);
    store.appendLog(
      "runner.log",
      `contract-request condition tap: ${target.name} (${target.x}, ${target.y})`
    );
    contractDetailXml = await waitForUi(config, device, isContractDetail, 12000);
    if (isContractDetail(contractDetailXml)) {
      await saveArtifacts(config, device, store, "contract-detail-start", contractDetailXml);
      addStep(steps, "계약 상세 화면 진입", "pass", target.name);
      return contractDetailXml;
    }
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-did-not-open", contractDetailXml);
  fail(
    "계약 조건 확인 버튼을 눌렀지만 계약 상세 화면으로 이동하지 않았습니다.",
    steps,
    [
      "자동화가 계약 조건 확인 버튼과 하단 고정 버튼 중앙 좌표를 순서대로 탭했습니다.",
      "계약 상세 화면에는 계약자 정보, 필수 약관 전체 동의, 계약 요청하기 버튼이 보여야 합니다.",
      "리포트의 contract-detail-did-not-open.png 화면을 확인해주세요.",
      "실제 탭 좌표는 runner.log에 기록됩니다."
    ]
  );
}

async function scrollToRequiredTerms(config, device, store, steps, initialXml) {
  let xml = isContractDetail(initialXml)
    ? initialXml
    : await waitForUi(config, device, isContractDetail, 6000, 180);
  await saveArtifacts(config, device, store, "contract-detail-start", xml);

  if (!isContractDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-detail-start", xml);
    fail(
      "계약 상세 화면을 확인하지 못했습니다.",
      steps,
      [
        "계약 조건 확인 버튼을 누른 뒤 계약자 정보와 계약 요청하기 버튼이 있는 화면으로 이동해야 합니다.",
        "리포트의 contract-detail-start.png 화면을 확인해주세요."
      ]
    );
  }

  const findReadyTerms = (candidateXml) => {
    const terms = findNode(candidateXml, "필수 약관 전체 동의", {
      clickable: true,
      enabled: true,
      visible: true,
      aboveBottomAction: true
    });
    const request = findNode(candidateXml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    });
    if (terms?.bounds && request?.bounds) {
      return { terms, request, xml: candidateXml };
    }

    const fallbackRequest = getBottomContractRequestButton(candidateXml);
    if (terms?.bounds && fallbackRequest?.bounds) {
      store.appendLog(
        "runner.log",
        "contract-request terms are safely visible; using bottom fixed submit button fallback because XML submit bounds are clipped"
      );
      return { terms, request: fallbackRequest, xml: candidateXml };
    }

    return null;
  };

  let ready = findReadyTerms(xml);
  if (ready) {
    await saveArtifacts(config, device, store, "contract-detail-terms", ready.xml);
    return ready;
  }

  await runAdb(config, device, ["shell", "input", "swipe", "540", "2280", "540", "520", "420"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  xml = await dumpUiStable(config, device);
  addStep(steps, "계약 상세 약관 영역으로 빠르게 스크롤");

  ready = findReadyTerms(xml);
  if (ready) {
    await saveArtifacts(config, device, store, "contract-detail-terms", ready.xml);
    return ready;
  }

  for (let count = 0; count < 3; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2160", "540", "1580", "120"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    xml = await dumpUiStable(config, device);
    store.appendLog("runner.log", `contract-request terms reveal adjustment ${count + 1}`);

    ready = findReadyTerms(xml);
    if (ready) {
      await saveArtifacts(config, device, store, "contract-detail-terms", ready.xml);
      addStep(steps, "필수 약관 영역 빠른 보정", "pass", `${count + 1}회`);
      return ready;
    }
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-terms-not-found", xml);
  fail(
    "계약 상세 화면에서 필수 약관 전체 동의 영역을 찾지 못했습니다.",
    steps,
    [
      "계약 상세 화면에서 약관 영역까지 빠르게 스크롤하고 짧은 보정을 반복했지만 안전한 탭 좌표를 찾지 못했습니다.",
      "리포트의 contract-detail-terms-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function tapRequiredTerms(config, device, xml, store, steps, mode = "whole") {
  const targets = [];
  const labels = mode === "children"
    ? [
      "결제대행 서비스 이용약관 동의",
      "개인정보 제 3자 제공 동의",
      "이용 규칙 및 환불 규정 동의"
    ]
    : ["필수 약관 전체 동의"];

  for (const label of labels) {
    const node = findNode(xml, label, { enabled: true, visible: true });
    if (node?.bounds) {
      targets.push({
        name: label,
        x: node.bounds.x,
        y: node.bounds.y
      });
    }
  }

  if (!targets.length) {
    await saveFailureArtifacts(config, device, store, "contract-terms-retry-not-found", xml);
    fail(
      "약관 재시도 중 실제로 누를 수 있는 약관 버튼을 찾지 못했습니다.",
      steps,
      [
        "자동화는 확인된 약관 버튼만 누릅니다.",
        "좌표 추정으로 다른 버튼을 누르지 않도록 중단했습니다.",
        "리포트의 contract-terms-retry-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  for (const target of targets) {
    store.appendLog(
      "runner.log",
      `contract-request terms tap: ${target.name} (${target.x}, ${target.y})`
    );
    await tap(config, device, target.x, target.y);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function continueContractPeriodIfNeeded(config, device, store, steps, xml) {
  if (!isContractPeriodConfirm(xml)) return xml;

  await saveArtifacts(config, device, store, "contract-period-confirm", xml);
  const continueButton =
    findNode(xml, "요청 계속하기", {
      clickable: true,
      enabled: true,
      visible: true
    });

  if (!continueButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-period-confirm", xml);
    fail(
      "계약 기간 확인 팝업에서 요청 계속하기 버튼을 찾지 못했습니다.",
      steps,
      [
        "계약 기간 확인 팝업이 뜬 경우에는 확인된 '요청 계속하기' 버튼만 누릅니다.",
        "다른 버튼을 누르지 않도록 좌표 추정 탭은 사용하지 않습니다.",
        "리포트의 contract-period-confirm.png 화면을 확인해주세요."
      ]
    );
  }

  store.appendLog(
    "runner.log",
    `contract-request period confirm tap: (${continueButton.bounds.x}, ${continueButton.bounds.y})`
  );
  await tap(config, device, continueButton.bounds.x, continueButton.bounds.y);
  addStep(steps, "계약 기간 확인 팝업 요청 계속하기 탭");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => (
      isContractComplete(nextXml) ||
      hasTermsAgreementWarning(nextXml) ||
      hasContractRequestError(nextXml) ||
      isContractRequestScreen(nextXml)
    ),
    20000
  );

  if (
    isContractRequestScreen(xml) &&
    !isContractComplete(xml) &&
    !hasTermsAgreementWarning(xml) &&
    !hasContractRequestError(xml)
  ) {
    const submitButton = findNode(xml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    });
    if (submitButton?.bounds) {
      await saveArtifacts(config, device, store, "contract-period-after-continue-detail", xml);
      await pressContractRequestButton(config, device, store, submitButton, "press");
      addStep(steps, "계약 기간 확인 후 계약 요청하기 재탭");
      xml = await waitForUi(
        config,
        device,
        (nextXml) => (
          isContractComplete(nextXml) ||
          hasTermsAgreementWarning(nextXml) ||
          hasContractRequestError(nextXml) ||
          !isContractRequestScreen(nextXml)
        ),
        20000
      );
    }
  }

  return xml;
}

async function waitWhileContractSubmitting(config, device, store, steps, xml, artifactName) {
  if (!isContractSubmitting(xml)) return xml;

  addStep(steps, "계약 요청 처리 대기", "pass", "앱 로딩 상태 확인");
  const nextXml = await waitForUi(
    config,
    device,
    (candidateXml) => (
      !isContractSubmitting(candidateXml) &&
      (
        isContractComplete(candidateXml) ||
        isContractPeriodConfirm(candidateXml) ||
        hasTermsAgreementWarning(candidateXml) ||
        hasContractRequestError(candidateXml) ||
        !isContractRequestScreen(candidateXml)
      )
    ),
    30000,
    500
  );
  await saveArtifacts(config, device, store, artifactName, nextXml);
  return nextXml;
}

function makeSplitPaymentRange(checkIn = null) {
  const base = checkIn || addDays(new Date(), 7);
  // 기본 지정 일정이 불가능할 때 쓰는 fallback은 장기 검증 범위 안에서 빠르게 선택 가능한 날짜로 제한한다.
  const nights = 60 + Math.floor(Math.random() * 120);
  const checkout = addDays(base, nights);
  return {
    start: base,
    end: checkout,
    nights,
    startIso: formatDateIso(base),
    endIso: formatDateIso(checkout),
    label: `${formatKoreanMonthDay(base)} ~ ${formatKoreanMonthDay(checkout)}`
  };
}

function parseIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffCalendarDays(start, end) {
  return Math.round((end - start) / 86400000);
}

function makeRequestedSplitPaymentRange(startIso, endIso) {
  const requestedStart = parseIsoDate(startIso);
  const requestedEnd = parseIsoDate(endIso);
  if (!requestedStart || !requestedEnd) return null;

  const requestedNights = diffCalendarDays(requestedStart, requestedEnd);
  if (requestedNights < 60 || requestedNights > 180) {
    const error = new Error("분할결제 지정 일정은 60박부터 180박까지만 사용할 수 있습니다.");
    error.details = [
      `지정 일정: ${startIso} ~ ${endIso}`,
      `계산 박수: ${requestedNights}박`,
      "체크아웃 날짜는 체크인 날짜보다 60~180일 뒤여야 합니다."
    ];
    throw error;
  }

  const earliestStart = addDays(new Date(), 1);
  const start = requestedStart < earliestStart ? earliestStart : requestedStart;
  const end = addDays(start, requestedNights);
  return {
    start,
    end,
    nights: requestedNights,
    startIso: formatDateIso(start),
    endIso: formatDateIso(end),
    label: `${formatKoreanMonthDay(start)} ~ ${formatKoreanMonthDay(end)}`,
    requestedStartIso: startIso,
    requestedEndIso: endIso,
    adjusted: formatDateIso(start) !== startIso || formatDateIso(end) !== endIso
  };
}

function makeSplitPaymentRangeFromVisibleCalendar(xml) {
  const months = parseNodes(xml)
    .filter((node) => /\d{4}년\s*\d{1,2}월/.test(nodeLabel(node)) && isVisibleCalendarBounds(node.bounds))
    .sort((a, b) => a.bounds.top - b.bounds.top);
  const month = months[0];
  if (!month) return makeSplitPaymentRange();

  const [, yearText, monthText] = nodeLabel(month).match(/(\d{4})년\s*(\d{1,2})월/) || [];
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  if (!year || monthIndex < 0) return makeSplitPaymentRange();

  const nextMonth = months.find((candidate) => candidate.bounds.top > month.bounds.top);
  const candidates = parseNodes(xml)
    .filter((node) => {
      const day = Number(nodeLabel(node).trim());
      if (!day || node.attrs.clickable !== "true") return false;
      if (!isVisibleCalendarBounds(node.bounds)) return false;
      if (node.bounds.top <= month.bounds.bottom) return false;
      if (nextMonth?.bounds && node.bounds.bottom >= nextMonth.bounds.top) return false;
      const date = new Date(year, monthIndex, day, 12, 0, 0, 0);
      return formatDateIso(date) >= formatDateIso(addDays(new Date(), 1));
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);

  const pool = candidates.slice(0, Math.min(10, candidates.length));
  if (!pool.length) return makeSplitPaymentRange();

  const selected = pool[Math.floor(Math.random() * pool.length)];
  const checkIn = new Date(year, monthIndex, Number(nodeLabel(selected).trim()), 12, 0, 0, 0);
  return makeSplitPaymentRange(checkIn);
}

function makeDefaultRequestedSplitPaymentRange() {
  const range = makeRequestedSplitPaymentRange("2026-08-20", "2027-02-15");
  return {
    ...range,
    nights: 180
  };
}

function findScheduleChangeButton(xml) {
  const explicit = findNode(xml, ["일정 변경", "계약 일정 변경"], {
    clickable: true,
    enabled: true,
    visible: true,
    aboveBottomAction: true
  });
  if (explicit?.bounds) return explicit;

  return parseNodes(xml).find((node) => {
    const label = nodeLabel(node).replace(/\s+/g, " ").trim();
    return (
      node.bounds &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled === "true" &&
      node.bounds.top > 260 &&
      node.bounds.top < 1900 &&
      label === "변경"
    );
  }) || null;
}

async function openContractScheduleChange(config, device, store, steps, initialXml) {
  let xml = initialXml;
  for (let count = 0; count < 5; count += 1) {
    const changeButton = findScheduleChangeButton(xml);
    if (changeButton?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-split-schedule-change", xml);
      await tap(config, device, changeButton.bounds.x, changeButton.bounds.y);
      addStep(steps, "분할결제 일정 변경 버튼 선택");

      const calendarXml = await waitForUi(
        config,
        device,
        (nextXml) => /\d{4}년\s*\d{1,2}월/.test(nextXml) && (nextXml.includes("선택") || nextXml.includes("확인")),
        6000,
        180
      );
      await saveArtifacts(config, device, store, "contract-detail-split-calendar-open", calendarXml);
      return calendarXml;
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2050", "540", "980", "160"]);
    await new Promise((resolve) => setTimeout(resolve, 90));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-split-schedule-change-not-found", xml);
  fail(
    "계약 요청 화면에서 일정 변경 버튼을 찾지 못했습니다.",
    steps,
    [
      "분할결제 계약 요청은 먼저 계약 요청 화면에서 일정 변경을 눌러 60박 이상 일정으로 바꿔야 합니다.",
      "리포트의 contract-detail-split-schedule-change-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function ensureSplitCheckoutDateVisible(config, device, xml, steps, monthLabel, dayLabel) {
  let currentXml = xml;
  const targetMonthIndex = parseCalendarMonthIndex(monthLabel);
  for (let count = 0; count < 14; count += 1) {
    if (findVisibleDateNodeInMonth(currentXml, monthLabel, dayLabel)) return currentXml;

    const months = visibleCalendarMonths(currentXml);
    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    const targetMonthVisible = isMonthLabelVisible(currentXml, monthLabel);

    // 장기 일정 달력은 월 이동 버튼보다 세로 스크롤이 빠르고 안정적이다.
    // 버튼 후보가 날짜 셀과 겹쳐 잡히는 경우가 있어 분할결제에서는 스크롤만 사용한다.
    let swipe = ["shell", "input", "swipe", "540", "1880", "540", "1260", "180"];
    let stepName = "분할결제 달력 날짜 위치 조정";
    if (!targetMonthVisible && targetMonthIndex !== null && firstMonth && lastMonth) {
      if (targetMonthIndex < firstMonth.index) {
        const gap = firstMonth.index - targetMonthIndex;
        swipe = gap <= 3
          ? ["shell", "input", "swipe", "540", "760", "540", "1540", "160"]
          : ["shell", "input", "swipe", "540", "620", "540", "1900", "180"];
        stepName = "분할결제 달력 이전 월 복구 스크롤";
      } else if (targetMonthIndex > lastMonth.index) {
        const gap = targetMonthIndex - lastMonth.index;
        swipe = gap <= 1
          ? ["shell", "input", "swipe", "540", "1500", "540", "940", "130"]
          : ["shell", "input", "swipe", "540", "1900", "540", "620", "180"];
        stepName = "분할결제 달력 다음 월 스크롤";
      }
    }
    await runAdb(config, device, swipe);
    addStep(
      steps,
      stepName,
      "pass",
      firstMonth && lastMonth
        ? `${monthLabel} ${dayLabel}일 탐색 / 현재 ${firstMonth.label} ~ ${lastMonth.label}`
        : `${monthLabel} ${dayLabel}일 탐색`
    );

    await new Promise((resolve) => setTimeout(resolve, 240));
    currentXml = await dumpUiStable(config, device);
  }
  return currentXml;
}

function findCalendarCompleteButton(xml) {
  const labels = ["선택 완료", "선택완료", "확인", "완료"];
  const candidates = parseNodes(xml).filter((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled === "true" &&
      labels.some((value) => label.includes(value))
    );
  });

  return candidates
    .filter((node) => node.bounds.top > 1780)
    .sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0] ||
    candidates.find((node) => nodeLabel(node).includes("선택")) ||
    candidates[0] ||
    null;
}

function isCalendarCompleteEnabled(xml) {
  return Boolean(findCalendarCompleteButton(xml));
}

async function tapSplitCalendarComplete(config, device, xml) {
  const completeButton = findCalendarCompleteButton(xml);
  const x = completeButton?.bounds?.x || 873;
  const y = completeButton?.bounds?.y || 2243;

  // The period picker uses a fixed bottom action bar. On WebView builds the XML
  // node is sometimes present but tap routing is more reliable at the visual
  // button center, so prefer the known bottom-right action coordinate.
  const visualX = Math.max(820, Math.min(930, Math.round(x)));
  const visualY = Math.max(2200, Math.min(2260, Math.round(y)));
  await runAdb(config, device, ["shell", "input", "tap", String(visualX), String(visualY)]);
}

async function selectSplitCalendarDate(config, device, store, steps, xml, date, stepName, artifactPrefix) {
  const monthLabel = formatMonthLabel(date);
  const dayLabel = String(date.getDate());
  let currentXml = await ensureSplitCheckoutDateVisible(config, device, xml, steps, monthLabel, dayLabel);
  await saveArtifacts(config, device, store, `${artifactPrefix}-before-date`, currentXml);

  const dateNode = findVisibleDateNodeInMonth(currentXml, monthLabel, dayLabel);
  if (!dateNode?.bounds) {
    await saveFailureArtifacts(config, device, store, `${artifactPrefix}-date-not-found`, currentXml);
    fail(
      `${stepName} 날짜를 달력에서 찾지 못했습니다.`,
      steps,
      [
        `선택 대상: ${formatDateIso(date)}`,
        "기간 선택 화면에서는 체크인과 체크아웃 날짜를 모두 다시 선택합니다.",
        `리포트의 ${artifactPrefix}-date-not-found.png 화면을 확인해주세요.`
      ]
    );
  }

  await tap(config, device, dateNode.bounds.x, dateNode.bounds.y);
  await new Promise((resolve) => setTimeout(resolve, 180));
  currentXml = await dumpUiStable(config, device);
  await saveArtifacts(config, device, store, `${artifactPrefix}-after-date`, currentXml);
  addStep(steps, stepName, "pass", formatDateIso(date));
  return currentXml;
}

function isSplitScheduleCalendarOpen(xml) {
  return (
    /\d{4}년\s*\d{1,2}월/.test(xml) &&
    (xml.includes("선택 완료") || xml.includes("선택완료") || xml.includes("취소"))
  );
}

async function selectSplitPaymentCheckoutDate(config, device, store, steps, calendarXml, splitRange) {
  let xml = await selectSplitCalendarDate(
    config,
    device,
    store,
    steps,
    calendarXml,
    splitRange.start,
    "분할결제 체크인 날짜 선택",
    "contract-detail-split-checkin"
  );
  xml = await selectSplitCalendarDate(
    config,
    device,
    store,
    steps,
    xml,
    splitRange.end,
    "분할결제 체크아웃 날짜 선택",
    "contract-detail-split-checkout"
  );
  await saveArtifacts(config, device, store, "contract-detail-split-calendar-after-checkout", xml);
  if (!isCalendarCompleteEnabled(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-detail-split-calendar-complete-disabled", xml);
    fail(
      "분할결제 체크아웃 날짜를 눌렀지만 선택 완료 버튼이 활성화되지 않았습니다.",
      steps,
      [
        `선택 대상: ${splitRange.startIso} ~ ${splitRange.endIso} (${splitRange.nights}박)`,
        "날짜가 달력에서 실제 선택 가능한지 확인해야 합니다.",
        "리포트의 contract-detail-split-calendar-complete-disabled.png 화면을 확인해주세요."
      ]
    );
  }
  const completeButton = findCalendarCompleteButton(xml);
  if (!completeButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-detail-split-calendar-complete-not-found", xml);
    fail(
      "분할결제 달력에서 선택 완료 버튼을 찾지 못했습니다.",
      steps,
      [
        "체크아웃 날짜 선택 후 선택 완료 버튼이 활성화되어야 합니다.",
        "리포트의 contract-detail-split-calendar-complete-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapSplitCalendarComplete(config, device, xml);
  addStep(steps, "분할결제 일정 선택 완료");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => isContractDetail(nextXml) && !isSplitScheduleCalendarOpen(nextXml),
    5000,
    220
  );
  if (isSplitScheduleCalendarOpen(xml)) {
    for (let count = 0; count < 2; count += 1) {
      const retryCompleteButton = findCalendarCompleteButton(xml);
      if (retryCompleteButton?.bounds) {
        await tapSplitCalendarComplete(config, device, xml);
      } else {
        await runAdb(config, device, ["shell", "input", "tap", "873", "2243"]);
      }
      addStep(steps, "분할결제 일정 선택 완료 재시도", "pass", `하단 우측 선택 완료 ${count + 1}회`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      xml = await waitForUi(
        config,
        device,
        (nextXml) => isContractDetail(nextXml) && !isSplitScheduleCalendarOpen(nextXml),
        5000,
        220
      );
      if (!isSplitScheduleCalendarOpen(xml)) break;
    }
  }

  await saveArtifacts(config, device, store, "contract-detail-split-after-schedule", xml);
  if (!isContractDetail(xml) || isSplitScheduleCalendarOpen(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-detail-split-after-schedule", xml);
    fail(
      "분할결제 일정 선택 후 계약 요청 화면으로 돌아오지 못했습니다.",
      steps,
      [
        "장기 체크아웃 날짜 선택 후 계약 요청 상세 화면이 다시 보여야 합니다.",
        "리포트의 contract-detail-split-after-schedule.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function selectSplitPaymentMethod(config, device, store, steps, initialXml) {
  let xml = initialXml;
  for (let count = 0; count < 8; count += 1) {
    const splitPayment = findSplitPaymentOption(xml);
    if (splitPayment?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-split-payment", xml);
      if (hasSplitPaymentSelected(xml)) {
        addStep(steps, "분할 결제 라디오 버튼 선택", "pass", "이미 선택된 상태");
        return xml;
      }

      await tap(config, device, splitPayment.bounds.x, splitPayment.bounds.y);
      addStep(steps, "분할 결제 라디오 버튼 선택");
      await new Promise((resolve) => setTimeout(resolve, 180));
      xml = await dumpUiStable(config, device);
      if (!hasSplitPaymentSelected(xml)) {
        await runAdb(config, device, [
          "shell",
          "input",
          "tap",
          String(Math.max(72, Math.min(108, Math.round(splitPayment.bounds.x)))),
          String(Math.round(splitPayment.bounds.y))
        ]);
        await new Promise((resolve) => setTimeout(resolve, 220));
        xml = await dumpUiStable(config, device);
      }
      await saveArtifacts(config, device, store, "contract-detail-split-payment-selected", xml);
      if (!hasSplitPaymentSelected(xml)) {
        await saveFailureArtifacts(config, device, store, "contract-detail-split-payment-not-selected", xml);
        fail(
          "분할 결제 라디오 버튼을 눌렀지만 선택 상태가 확인되지 않았습니다.",
          steps,
          [
            "분할 결제 선택 후에는 분할 결제 안내 문구가 화면에 노출되어야 합니다.",
            "리포트의 contract-detail-split-payment-not-selected.png 화면을 확인해주세요."
          ]
        );
      }
      return xml;
    }

    const clippedSplitPayment = parseNodes(xml).find((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        ["분할 결제", "분할결제", "분할 납부"].some((value) => label.includes(value)) &&
        node.bounds.bottom < 320
      );
    });

    if (clippedSplitPayment) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "900", "540", "1250", "120"]);
      addStep(steps, "분할 결제 영역 중앙 보정", "pass", `${count + 1}회`);
    } else {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1850", "540", "650", "180"]);
      addStep(steps, "분할 결제 영역으로 빠르게 스크롤", "pass", `${count + 1}회`);
    }
    await new Promise((resolve) => setTimeout(resolve, 90));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-split-payment-not-found", xml);
  fail(
    "계약 요청 화면에서 분할 결제 라디오 버튼을 찾지 못했습니다.",
    steps,
    [
      "60박 이상 일정으로 변경한 뒤 결제 방법에서 분할 결제를 선택해야 합니다.",
      "리포트의 contract-detail-split-payment-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function selectSplitPaymentContractOptions(config, device, store, steps, contractDetailXml, options = {}) {
  const calendarXml = await openContractScheduleChange(config, device, store, steps, contractDetailXml);
  const requestedRange =
    makeRequestedSplitPaymentRange(options.splitStartIso, options.splitEndIso) ||
    makeDefaultRequestedSplitPaymentRange();
  const splitRange = options.splitRange || requestedRange || makeSplitPaymentRangeFromVisibleCalendar(calendarXml);
  options.splitRange = splitRange;
  addStep(
    steps,
    requestedRange ? "분할결제 지정 장기 일정 결정" : "분할결제 장기 일정 랜덤 결정",
    "pass",
    `${splitRange.label} (${splitRange.nights}박)${splitRange.adjusted ? ` / 지정일 보정: ${splitRange.requestedStartIso} ~ ${splitRange.requestedEndIso}` : ""}`
  );

  let xml = await selectSplitPaymentCheckoutDate(config, device, store, steps, calendarXml, splitRange);
  xml = await selectSplitPaymentMethod(config, device, store, steps, xml);
  return xml;
}

function findPetInfoInput(xml) {
  const editables = findEditableNodes(xml).filter((node) => (
    node.bounds &&
    node.bounds.top > 120 &&
    node.bounds.bottom < 2150 &&
    node.attrs.enabled === "true"
  ));
  if (!editables.length) return null;

  const petLabels = parseNodes(xml).filter((node) => (
    node.bounds &&
    nodeLabel(node).includes("반려동물") &&
    node.bounds.top > 120 &&
    node.bounds.bottom < 2100
  ));
  for (const labelNode of petLabels) {
    const nearInput = editables
      .filter((input) => input.bounds.top >= labelNode.bounds.top - 80 && input.bounds.top <= labelNode.bounds.bottom + 620)
      .sort((a, b) => a.bounds.top - b.bounds.top)[0];
    if (nearInput) return nearInput;
  }

  return editables
    .filter((input) => {
      const label = nodeLabel(input);
      return label.includes("반려동물") || !label.trim();
    })
    .sort((a, b) => a.bounds.top - b.bounds.top)[0] || editables[0];
}

async function fillPetInfoIfNeeded(config, device, store, steps, initialXml, options = {}) {
  if (!options.petInfoText) return initialXml;

  let xml = initialXml;
  for (let count = 0; count < 6; count += 1) {
    let input = findPetInfoInput(xml);
    if (input?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-pet-info-input", xml);
      let confirmedXml = "";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // Position the field before opening the keyboard. Scrolling after the keyboard
        // appears can collapse WebView coordinates and leave the input behind the keypad.
        if (input.bounds.bottom > 1350) {
          await runAdb(config, device, ["shell", "input", "swipe", "540", "1720", "540", "1370", "140"]);
          await new Promise((resolve) => setTimeout(resolve, 220));
          xml = await dumpUiStable(config, device);
          const centeredInput = findPetInfoInput(xml);
          if (centeredInput?.bounds) {
            input = centeredInput;
          }
          await saveArtifacts(config, device, store, "contract-detail-pet-info-centered", xml);
        }

        await tap(config, device, input.bounds.x, input.bounds.y);
        await new Promise((resolve) => setTimeout(resolve, 180));

        // Android already pans this WebView when the keyboard opens. Re-read that layout
        // instead of swiping, which can push the field above the viewport and leave stale coordinates.
        xml = await dumpUiStable(config, device);
        await saveArtifacts(config, device, store, "contract-detail-pet-info-keyboard-lifted", xml);
        const keyboardAdjustedInput = findPetInfoInput(xml);
        if (keyboardAdjustedInput?.bounds) {
          input = keyboardAdjustedInput;
          await tap(config, device, input.bounds.x, input.bounds.y);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }

        await runAdb(config, device, ["shell", "input", "keyevent", "123"]).catch(() => {});
        await inputUnicodeText(config, device, options.petInfoText, store, {
          refocus: async () => {
            await tap(config, device, input.bounds.x, input.bounds.y);
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        xml = await dumpUiStable(config, device);
        if (xml.includes(options.petInfoText)) {
          confirmedXml = xml;
          break;
        }

        store.appendLog(
          "runner.log",
          `contract-request pet info input retry ${attempt}: value not visible after ADB keyboard input`
        );

        // Some WebView fields miss ADB Keyboard broadcasts even after focus.
        // Clipboard paste gives the same user-visible result without depending on IME internals.
        await tap(config, device, input.bounds.x, input.bounds.y);
        await runAdb(config, device, ["shell", "cmd", "clipboard", "set", options.petInfoText]).catch((error) => {
          store.appendLog("runner.log", `contract-request pet info clipboard set failed: ${error.message}`);
        });
        await runAdb(config, device, ["shell", "input", "keyevent", "279"]).catch((error) => {
          store.appendLog("runner.log", `contract-request pet info paste failed: ${error.message}`);
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        xml = await dumpUiStable(config, device);
        if (xml.includes(options.petInfoText)) {
          confirmedXml = xml;
          break;
        }

        await tap(config, device, input.bounds.x, input.bounds.y);
        await runAdb(config, device, ["shell", "input", "keyevent", "67"]).catch(() => {});
      }
      if (!confirmedXml) {
        xml = await dumpUiStable(config, device);
        await saveFailureArtifacts(config, device, store, "contract-detail-pet-info-not-filled", xml);
        fail(
          "반려동물 정보가 실제 입력되지 않았습니다.",
          steps,
          [
            `입력 대상: ${options.petInfoText}`,
            "일반결제 랜덤 프로필에서는 계약 요청 상세 상단 게스트 영역의 반려동물 정보 입력이 필수입니다.",
            "리포트의 contract-detail-pet-info-not-filled.png 화면을 확인해주세요."
          ]
        );
      }
      await saveArtifacts(config, device, store, "contract-detail-pet-info-filled", confirmedXml);
      addStep(steps, "반려동물 정보 입력", "pass", options.petInfoText);
      await keyEvent(config, device, 4).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 180));
      xml = await dumpUiStable(config, device);
      return xml;
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1780", "540", "1030", "140"]);
    addStep(steps, "반려동물 정보 입력 영역 탐색", "pass", `${count + 1}회`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-pet-info-input-not-found", xml);
  fail(
    "계약 요청 상세에서 반려동물 정보 입력칸을 찾지 못했습니다.",
    steps,
    [
      "성인/어린이/유아/반려동물 1명 조건에서는 게스트 영역의 반려동물 정보 입력칸이 보여야 합니다.",
      "리포트의 contract-detail-pet-info-input-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function selectAutoCardPayment(config, device, store, steps, initialXml) {
  let xml = isContractDetail(initialXml)
    ? initialXml
    : await waitForUi(config, device, isContractDetail, 6000, 180);

  for (let count = 0; count < 5; count += 1) {
    const autoCard = findAutoCardPaymentOption(xml);
    if (autoCard?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-auto-card", xml);
      if (hasAutoCardPaymentSelected(xml)) {
        addStep(steps, "자동카드 결제 수단 선택", "pass", "이미 선택된 상태");
        return xml;
      }

      await tap(config, device, autoCard.bounds.x, autoCard.bounds.y);
      addStep(steps, "자동카드 결제 수단 선택");
      await new Promise((resolve) => setTimeout(resolve, 180));

      xml = await dumpUiStable(config, device);
      await saveArtifacts(config, device, store, "contract-detail-auto-card-selected", xml);
      if (
        hasAutoCardPaymentSelected(xml) ||
        isContractRequestScreen(xml) ||
        xml.includes("호스트 수락 즉시 자동 결제")
      ) {
        return xml;
      }
    }

    if (
      xml.includes("결제 수단") &&
      (
        xml.includes("호스트 수락 즉시 자동 결제") ||
        xml.includes("호스트 수락 즉시 자동결제") ||
        xml.includes("자동 결제")
      )
    ) {
      await runAdb(config, device, [
        "shell", "input", "swipe", "540", "2060", "540", "1460", "140"
      ]);
    } else {
      await runAdb(config, device, [
        "shell", "input", "swipe", "540", "2050", "540", "900", "180"
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-auto-card-not-found", xml);
  fail(
    "계약 요청 화면에서 자동카드 결제 수단을 찾지 못했습니다.",
    steps,
    [
      "자동카드 계약 요청은 계약 요청 화면의 결제 수단 영역에서 '호스트 수락 즉시 자동 결제'를 선택해야 합니다.",
      "화면에 실제 좌표로 보이는 자동카드 옵션만 탭합니다.",
      "리포트의 contract-detail-auto-card-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function submitContractRequest(config, device, store, steps, contractDetailXml, options = {}) {
  let preparedContractDetailXml = await fillPetInfoIfNeeded(config, device, store, steps, contractDetailXml, options);
  if (options.paymentMethod === "auto-card") {
    preparedContractDetailXml = await selectAutoCardPayment(config, device, store, steps, preparedContractDetailXml);
  } else if (options.paymentMethod === "split-payment") {
    preparedContractDetailXml = await selectSplitPaymentContractOptions(
      config,
      device,
      store,
      steps,
      contractDetailXml,
      options
    );
  }

  const { terms, request } = await scrollToRequiredTerms(config, device, store, steps, preparedContractDetailXml);

  await tap(config, device, terms.bounds.x, terms.bounds.y);
  addStep(steps, "필수 약관 전체 동의 선택");
  await new Promise((resolve) => setTimeout(resolve, 300));

  let xml = await dumpUiStable(config, device);
  if (hasTermsAgreementWarning(xml)) {
    store.appendLog(
      "runner.log",
      "contract-request terms warning remained after first tap; retrying expected checkbox coordinate (78, 1708)"
    );
    await tap(config, device, 78, 1708);
    await new Promise((resolve) => setTimeout(resolve, 300));
    xml = await dumpUiStable(config, device);
  }
  await saveArtifacts(config, device, store, "contract-detail-after-terms", xml);
  if (options.paymentMethod === "auto-card") {
    xml = await liftRequiredTermsAboveSubmit(config, device, store, xml);
    await saveArtifacts(config, device, store, "contract-detail-before-auto-card-submit", xml);
  }

  const requestButton =
    findNode(xml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    }) || request;

  await pressContractRequestButton(config, device, store, requestButton, "tap");
  addStep(steps, "계약 요청하기 버튼 탭");

  xml = await waitForUi(config, device, isContractSubmitOutcome, 2200);
  if (!isContractSubmitOutcome(xml) && isContractRequestScreen(xml)) {
    const pressSubmitButton = findNode(xml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    });
    if (pressSubmitButton?.bounds) {
      await saveArtifacts(config, device, store, "contract-request-submit-still-detail", xml);
      await pressContractRequestButton(config, device, store, pressSubmitButton, "press");
      addStep(steps, "계약 요청하기 버튼 재시도");
    }
  }

  xml = await waitForUi(config, device, isContractSubmitOutcome, 20000);
  await saveArtifacts(config, device, store, "contract-request-after-submit", xml);
  xml = await continueContractPeriodIfNeeded(config, device, store, steps, xml);
  xml = await waitWhileContractSubmitting(config, device, store, steps, xml, "contract-request-after-submit-wait");
  const submittedContractNumber = getContractNumber(xml);

  if (
    isContractRequestScreen(xml) &&
    !isContractComplete(xml) &&
    !hasTermsAgreementWarning(xml) &&
    !hasContractRequestError(xml)
  ) {
    const retrySubmitButton = findNode(xml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    });
    if (retrySubmitButton?.bounds) {
      store.appendLog(
        "runner.log",
        `contract-request submit remained on detail; retrying submit (${retrySubmitButton.bounds.x}, ${retrySubmitButton.bounds.y})`
      );
      await pressContractRequestButton(config, device, store, retrySubmitButton, "press");
      addStep(steps, "계약 요청하기 버튼 재탭");

      xml = await waitForUi(
        config,
        device,
        (nextXml) => (
          isContractComplete(nextXml) ||
          isContractPeriodConfirm(nextXml) ||
          hasTermsAgreementWarning(nextXml) ||
          hasContractRequestError(nextXml) ||
          !isContractRequestScreen(nextXml)
        ),
        20000
      );
      await saveArtifacts(config, device, store, "contract-request-after-submit-retry", xml);
      xml = await continueContractPeriodIfNeeded(config, device, store, steps, xml);
      xml = await waitWhileContractSubmitting(config, device, store, steps, xml, "contract-request-after-submit-retry-wait");
    }
  }

  if (hasTermsAgreementWarning(xml)) {
    store.appendLog(
      "runner.log",
      "contract-request terms warning appeared after submit; selecting visible terms and retrying submit"
    );
    await tapRequiredTerms(config, device, xml, store, steps, "whole");
    xml = await dumpUiStable(config, device);

    const retryButton =
      findNode(xml, "계약 요청하기", {
        clickable: true,
        enabled: true,
        visible: true
      }) || requestButton;
    await pressContractRequestButton(config, device, store, retryButton, "tap");
    addStep(steps, "약관 경고 후 계약 요청 재시도");

    xml = await waitForUi(
      config,
      device,
      (nextXml) => (
        isContractComplete(nextXml) ||
        isContractPeriodConfirm(nextXml) ||
        hasTermsAgreementWarning(nextXml) ||
        hasContractRequestError(nextXml)
      ),
      12000
    );
    xml = await continueContractPeriodIfNeeded(config, device, store, steps, xml);
    xml = await waitWhileContractSubmitting(config, device, store, steps, xml, "contract-request-after-terms-retry-wait");

    if (hasTermsAgreementWarning(xml)) {
      store.appendLog(
        "runner.log",
        "contract-request terms warning remained; selecting individual required terms and retrying submit"
      );
      await tapRequiredTerms(config, device, xml, store, steps, "children");
      xml = await dumpUiStable(config, device);

      const finalRetryButton =
        findNode(xml, "계약 요청하기", {
          clickable: true,
          enabled: true,
          visible: true
        }) || requestButton;
      await pressContractRequestButton(config, device, store, finalRetryButton, "tap");
      addStep(steps, "개별 필수 약관 선택 후 계약 요청 재시도");

      xml = await waitForUi(
        config,
        device,
        (nextXml) => (
          isContractComplete(nextXml) ||
          isContractPeriodConfirm(nextXml) ||
          hasContractRequestError(nextXml)
        ),
        15000
      );
      xml = await continueContractPeriodIfNeeded(config, device, store, steps, xml);
      xml = await waitWhileContractSubmitting(config, device, store, steps, xml, "contract-request-after-final-retry-wait");
    }

    await saveArtifacts(config, device, store, "contract-request-after-retry-submit", xml);
  }

  if (hasContractRequestError(xml) && !isContractComplete(xml)) {
    const appError = extractContractRequestError(xml);
    await saveFailureArtifacts(config, device, store, "contract-request-after-submit", xml);
    fail(
      appError
        ? `계약 요청 실패: 앱 오류 메시지 노출 - ${appError}`
        : "계약 요청 완료 화면으로 이동하지 못했습니다.",
      steps,
      [
        appError
          ? `앱 화면에 노출된 오류: ${appError}`
          : "계약 요청 후 앱 오류 또는 필수 정보 누락 메시지가 노출되었습니다.",
        "버튼 탭은 완료됐지만 서버/앱 처리 결과가 실패로 돌아온 상태입니다.",
        "리포트의 contract-request-after-submit.png 화면을 확인해주세요."
      ]
    );
  }

  if (isContractRequestScreen(xml) && !isContractComplete(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-request-after-submit", xml);
    fail(
      "계약 요청하기 버튼을 눌렀지만 제출이 반영되지 않았습니다.",
      steps,
      [
        "현재 화면이 아직 계약 요청 상세 화면입니다.",
        "자동화가 하단 '계약 요청하기' 버튼을 탭한 뒤 같은 좌표를 짧은 press 방식으로 재시도했습니다.",
        "리포트의 contract-request-after-submit.png 화면과 runner.log의 제출 버튼 좌표를 확인해주세요."
      ]
    );
  }

  const home = findNode(xml, "홈으로", { clickable: true, enabled: true });
  if (home?.bounds) {
    await tapNode(config, device, home, "홈으로 버튼", steps);
    addStep(steps, "완료 화면 홈으로 버튼 탭");
  } else if (!isContractRequestScreen(xml) && !hasContractRequestError(xml)) {
    store.appendLog(
      "runner.log",
      "contract-request complete screen did not expose text/buttons in XML; tapping fixed bottom-left home button area"
    );
    await tap(config, device, 150, 2380);
    addStep(steps, "완료 화면 홈으로 버튼 탭", "XML 텍스트 미노출 fallback");
  } else {
    await saveFailureArtifacts(config, device, store, "contract-request-after-submit", xml);
    fail(
      "계약 요청 완료 화면에서 홈으로 버튼을 찾지 못했습니다.",
      steps,
      [
        "완료 화면에서는 확인된 '홈으로' 버튼만 누릅니다.",
        "상세 규정 확인 같은 다른 버튼을 누르지 않도록 좌표 추정 탭은 사용하지 않습니다.",
        "리포트의 contract-request-after-submit.png 화면을 확인해주세요."
      ]
    );
  }

  xml = await waitForUi(config, device, hasHomeSearchBar, 10000);
  if (!hasHomeSearchBar(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-request-final", xml);
    fail(
      "홈으로 버튼을 눌렀지만 홈 화면을 확인하지 못했습니다.",
      steps,
      [
        "완료 화면에서 홈으로 버튼을 누른 뒤 홈 검색바가 보여야 합니다.",
        "리포트의 contract-request-final.png 화면을 확인해주세요."
      ]
    );
  }

  await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  addStep(steps, "홈 화면 풀 리프레시");

  xml = await waitForUi(config, device, hasHomeSearchBar, 6500);
  await saveArtifacts(config, device, store, "contract-request-final", xml);
  if (!hasHomeSearchBar(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-request-final", xml);
    fail(
      "홈 화면 풀 리프레시 후 홈 화면을 확인하지 못했습니다.",
      steps,
      [
        "완료 화면에서 홈으로 버튼을 누른 뒤 홈 화면에서 풀드리프레시까지 수행합니다.",
        "리포트의 contract-request-final.png 화면을 확인해주세요."
      ]
    );
  }

  return {
    contractNumber: submittedContractNumber || getContractNumber(xml),
    requestSummary: getHomeRequestCardSummary(xml),
    finalXml: xml
  };
}

async function runContractRequestTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const paymentMethod = request.payment_method || "manual";
  const skipFreshLaunch = request.skip_fresh_launch === true;
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (!["manual", "auto-card", "split-payment"].includes(paymentMethod)) {
    throw new Error(`Unknown contract request payment method: ${paymentMethod}`);
  }
  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);

    let xml = await prepareHomeForContractRequest(config, device, appPackage, store, steps, {
      skipFreshLaunch
    });
    await saveArtifacts(config, device, store, "search-home", xml);
    if (!hasHomeSearchBar(xml) && !isSearchConditionScreen(xml)) {
      await saveFailureArtifacts(config, device, store, "search-home", xml);
      if (isLoginStartScreen(xml)) {
        fail(
          "게스트가 로그아웃된 상태라 계약 요청을 시작할 수 없습니다.",
          steps,
          [
            `먼저 !게스트 로그인 ${env === "dev" ? "dev" : "stg"} 명령어로 게스트 로그인을 완료해주세요.`,
            "계약 요청은 로그인 상태의 게스트 홈 화면에서 시작해야 합니다.",
            "리포트의 search-home.png 화면에서 로그인 시작 화면이 노출됩니다."
          ]
        );
      }

      fail(
        "앱 재실행 후 홈 검색바를 확인하지 못했습니다.",
        steps,
        [
          "계약 요청은 로그인 상태의 게스트 홈 화면에서 시작해야 합니다.",
          "리포트의 search-home.png 화면을 확인해주세요."
        ]
      );
    }

    if (!isSearchConditionScreen(xml)) {
      await tapSearchBar(config, device, xml, steps);
      xml = await waitForUi(config, device, isSearchConditionScreen, 2500, 180);
    }
    await saveArtifacts(config, device, store, "search-condition", xml);
    if (!isSearchConditionScreen(xml)) {
      await saveFailureArtifacts(config, device, store, "search-condition", xml);
      fail(
        "검색 상세 조건 화면으로 진입하지 못했습니다.",
        steps,
        [
          "검색바 탭 후 위치/일정/게스트 탭과 검색 입력창이 보여야 합니다.",
          "리포트의 search-condition.png 화면을 확인해주세요."
        ]
      );
    }

    await selectDomesticRegion(config, device, xml, steps);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
    await saveArtifacts(config, device, store, "domestic-selected", xml);

    const useRandomProfile = request.random_search_profile === true;
    const exactDateRange = getRandomExactSearchDateRange(
      new Date(),
      useRandomProfile
        ? {
            minNights: 6,
            maxNights: 180,
            maxEndDate: new Date(new Date().getFullYear() + 1, 0, 31, 12, 0, 0, 0),
            nightBuckets: [
              { min: 6, max: 30 },
              { min: 31, max: 90 },
              { min: 91, max: 180 }
            ]
          }
        : undefined
    );
    const guestProfile = useRandomProfile
      ? makeRandomGuestProfile(request)
      : { adultCount: 1, childCount: 0, infantCount: 0, petCount: 0 };
    const petInfoText = useRandomProfile && guestProfile.petCount > 0 ? pickRandomItem(PET_INFO_CANDIDATES) : "";
    addStep(
      steps,
      useRandomProfile ? "정확한 일정 랜덤 장기 기간 결정" : "정확한 일정 랜덤 기간 결정",
      "pass",
      `${exactDateRange.label}${exactDateRange.nights ? ` (${exactDateRange.nights}박)` : ""}`
    );

    await selectExactDates(config, device, xml, store, steps, exactDateRange);
    xml = await waitForUi(config, device, isGuestScreen, 3500, 180);
    if (useRandomProfile) {
      await submitRandomProfileGuests(config, device, xml, store, steps, guestProfile);
    } else {
      await submitDefaultGuests(config, device, xml, store, steps);
    }

    xml = await waitForUi(config, device, (nextXml) => isContractSearchResults(nextXml, exactDateRange), 20000);
    await saveArtifacts(config, device, store, "search-results", xml);
    if (!isContractSearchResults(xml, exactDateRange)) {
      await saveFailureArtifacts(config, device, store, "search-results", xml);
      fail(
        "계약 요청용 검색 결과 목록 화면을 확인하지 못했습니다.",
        steps,
        [
          `성공 기준은 '국내', '${exactDateRange.label}', 검색 결과 화면의 숙소 수/필터/정렬/지도 신호입니다.`,
          "검색 결과가 '일주일 / 1명'이면 정확한 일정 선택 실패로 처리합니다.",
          "리포트의 search-results.png 화면을 확인해주세요."
        ]
      );
    }
    addStep(steps, "계약 요청용 검색 결과 목록 확인");

    xml = await selectNewestSort(config, device, store, steps, xml, exactDateRange);
    const openedListing = await openContractableListing(config, device, store, steps, exactDateRange);
    const contractDetailXml = await tapContractCondition(config, device, store, steps, openedListing.detailXml);
    const submitOptions = {
      paymentMethod,
      splitStartIso: request.split_start,
      splitEndIso: request.split_end,
      petInfoText
    };
    const submittedContract = await submitContractRequest(config, device, store, steps, contractDetailXml, submitOptions);
    addStep(steps, "계약 요청 완료 후 홈 화면 확인");

    const splitRange = submitOptions.splitRange;
    const contractStart = splitRange?.startIso || exactDateRange.startIso;
    const contractEnd = splitRange?.endIso || exactDateRange.endIso;
    const paymentMethodLabel =
      paymentMethod === "auto-card"
        ? "호스트 수락 즉시 자동 결제"
        : paymentMethod === "split-payment"
          ? "분할 결제"
          : "호스트 승인 후 별도 결제";

    return {
      test_id: "TC-CONTRACT-001",
      name:
        paymentMethod === "auto-card"
          ? `${role} 등록카드 계약 요청`
          : paymentMethod === "split-payment"
            ? `${role} 분할결제 계약 요청`
            : `${role} 계약 요청`,
      env,
      status: "pass",
      device,
      steps,
      contract_conditions: {
        region: "국내",
        schedule_type: "정확한 일정",
        start_date: contractStart,
        end_date: contractEnd,
        stay_nights: splitRange?.nights || exactDateRange.nights,
        adult_count: guestProfile.adultCount,
        child_count: guestProfile.childCount,
        infant_count: guestProfile.infantCount,
        pet_count: guestProfile.petCount,
        pet_info: petInfoText,
        payment_method: paymentMethodLabel
      },
      contract_request: {
        contract_number: submittedContract.contractNumber || "",
        selected_listing_title: openedListing.title || "",
        match_summary: submittedContract.requestSummary || (
          openedListing.title
            ? {
                status: "요청 중",
                title: openedListing.title,
                schedule: exactDateRange.label,
                guest: `성인 ${guestProfile.adultCount} · 어린이 ${guestProfile.childCount} · 유아 ${guestProfile.infantCount} · 반려동물 ${guestProfile.petCount}`
              }
            : null
        )
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "search-results.xml"),
          path.join(store.logsDir, "accommodation-detail.xml"),
          path.join(store.logsDir, "contract-detail-terms.xml"),
          path.join(store.logsDir, "contract-request-after-submit.xml"),
          path.join(store.logsDir, "contract-request-final.xml")
        ]
      }
    };
  });
}

module.exports = {
  runContractRequestTest
};
