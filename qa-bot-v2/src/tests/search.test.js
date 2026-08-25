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
  formatMonthLabel,
  getRandomExactSearchDateRange,
  schedulePattern
} = require("./helpers/exact-date-range");

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

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function findNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    const label = nodeLabel(node);
    const matches = labelList.some((value) => label.includes(value));
    if (!matches) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    return Boolean(node.bounds);
  });

  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function hasHomeSearchBar(xml) {
  return (
    xml.includes("동네 · 주변 장소로 검색") ||
    xml.includes("동네 주변 장소로 검색")
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

function isSearchResults(xml, exactDateRange = null) {
  const dateOk = exactDateRange ? xml.includes(exactDateRange.label) : schedulePattern().test(xml);
  return (
    xml.includes("국내") &&
    dateOk &&
    !xml.includes("일주일 / 1명") &&
    (xml.includes("개의 집") || xml.includes("필터") || xml.includes("지도로 보기"))
  );
}

function isFlexibleSearchResults(xml, selection = null) {
  const expectedSchedule = selection?.label || "일주일 / 7월, 8월";
  return (
    xml.includes("국내") &&
    xml.includes(`${expectedSchedule} / 1명`) &&
    (xml.includes("개의 집") || xml.includes("필터") || xml.includes("지도로 보기"))
  );
}

function hasLoadedSearchResultContent(xml) {
  return (
    /[\d,]+개의 집/.test(xml) ||
    (xml.includes("최소") && xml.includes("₩")) ||
    /검색 결과가 없|집을 찾지 못|조건에 맞는 집이 없/.test(xml)
  );
}

function summarizeAndroidSearchResults(xml, schedule) {
  const labels = parseNodes(xml)
    .map((node) => String(node.attrs["content-desc"] || node.attrs.text || node.attrs.hint || "").trim())
    .filter(Boolean);
  const expectedGuestLabel = schedule.resultGuestLabel || "1명";
  const condition = labels.find((label) => label.includes("국내") && label.includes(expectedGuestLabel)) || "";
  const resultCountLabel = labels.find((label) => /[\d,]+개의 집/.test(label)) || "";
  const resultCountMatch = resultCountLabel.match(/([\d,]+)개의 집/);
  const noResults = labels.some((label) => /검색 결과가 없|집을 찾지 못|조건에 맞는 집이 없/.test(label));
  const firstListingLabel = labels.find((label) => label.includes("최소") && /₩[\d,]+/.test(label)) || "";
  const firstListingLines = firstListingLabel.split("\n").map((line) => line.trim()).filter(Boolean);
  const minimumStayIndex = firstListingLines.findIndex((line) => line.startsWith("최소 "));
  const firstListing = minimumStayIndex >= 2 ? firstListingLines[minimumStayIndex - 1] : "";

  return {
    applied_condition: condition.replace(/\s+/g, " "),
    condition_matches: condition.includes("국내") && condition.includes(schedule.label) && condition.includes(expectedGuestLabel),
    result_count: resultCountMatch ? Number(resultCountMatch[1].replace(/,/g, "")) : noResults ? 0 : null,
    first_listing: firstListing,
    sort_visible: labels.some((label) => label.includes("리브 추천 순")),
    filter_visible: labels.some((label) => label.includes("필터")),
    map_visible: labels.some((label) => label === "지도" || label.includes("지도로 보기")),
    result_panel_visible: Boolean(resultCountMatch || firstListing || noResults)
  };
}

const APP_ERROR_TEXTS = [
  "일시적인 오류가 발생했습니다",
  "오류가 발생했습니다",
  "다시 시도해 주세요",
  "네트워크 연결 상태를 확인",
  "서버와 통신"
];

function findAppErrorText(xml) {
  return APP_ERROR_TEXTS.find((text) => xml.includes(text));
}

function hasAppError(xml) {
  return Boolean(findAppErrorText(xml));
}

async function collectAppErrorWarning(config, device, store, xml, screenshotName = "search-results") {
  const errorText = findAppErrorText(xml);
  if (!errorText) return null;

  const logcatPath = path.join(store.logsDir, "app-error-logcat.txt");
  try {
    const { stdout } = await runAdb(config, device, ["logcat", "-d", "-t", "500"]);
    fs.writeFileSync(logcatPath, stdout);
  } catch (error) {
    store.appendLog("runner.log", `failed to collect app error logcat: ${error.message}`);
  }

  return {
    type: "app_warning",
    name: "앱 화면 오류 문구",
    message: errorText,
    details: [
      "검색 결과 목록은 확인됐지만 화면에 앱 오류 문구가 함께 노출되었습니다.",
      "지도 영역 또는 부가 데이터 로딩 오류일 수 있어 검색 성공과 별도로 확인이 필요합니다.",
      `리포트의 ${screenshotName}.png와 ${screenshotName}.xml을 확인해주세요.`,
      "app-error-logcat.txt와 앱 내 정보 > 매니저 도구 > 앱 로그 내역에서 같은 시간대 로그를 확인해주세요."
    ],
    log: logcatPath
  };
}

async function waitForUi(config, device, predicate, timeoutMs = 10000, intervalMs = 300) {
  const startedAt = Date.now();
  let xml = "";

  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
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
    fs.writeFileSync(xmlPath, xml || (await dumpUi(config, device)));
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

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });
  await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "600", "300"]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  addStep(steps, "단말 깨우기 및 잠금 해제 시도");
}

async function launchFresh(config, device, appPackage, steps) {
  await runAdb(config, device, ["shell", "am", "force-stop", appPackage]);
  addStep(steps, "앱 완전 종료");
  await new Promise((resolve) => setTimeout(resolve, 700));
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

async function tapNode(config, device, node, label, steps) {
  if (!node?.bounds) {
    fail(`${label}을 찾지 못했습니다.`, steps);
  }
  await tap(config, device, node.bounds.x, node.bounds.y);
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
        "검색바 문구는 '동네 · 주변 장소로 검색' 또는 '동네 주변 장소로 검색'으로 찾습니다.",
        "리포트의 search-home.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, searchBar.bounds.x, searchBar.bounds.y);
  addStep(steps, "홈 검색바 탭");
}

async function selectDomesticRegion(config, device, xml, steps) {
  const domestic = findNode(xml, "국내", { clickable: true });
  if (!domestic?.bounds) {
    fail(
      "검색 조건 화면에서 국내 지역 탭을 찾지 못했습니다.",
      steps,
      [
        "위치 탭 화면에 '국내' 지역 탭이 노출되어야 합니다.",
        "리포트의 search-condition.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, domestic.bounds.x, domestic.bounds.y);
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

async function ensureMonthVisible(config, device, xml, steps, monthLabel) {
  let currentXml = xml;
  for (let count = 0; count < 4; count += 1) {
    if (currentXml.includes(monthLabel)) return currentXml;
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "1900", "540", "1100", "500"
    ]);
    addStep(steps, "달력 스크롤", "pass", `${monthLabel} 탐색`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    currentXml = await dumpUi(config, device);
  }
  return currentXml;
}

async function ensureDateVisible(config, device, xml, steps, monthLabel, dayLabel) {
  let currentXml = await ensureMonthVisible(config, device, xml, steps, monthLabel);
  for (let count = 0; count < 4; count += 1) {
    const dateNode = findDateNodeInMonth(currentXml, monthLabel, dayLabel);
    if (dateNode?.bounds) return { xml: currentXml, dateNode };
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "1850", "540", "1250", "300"
    ]);
    addStep(steps, "달력 날짜 영역 스크롤", "pass", `${monthLabel} ${dayLabel}일 탐색`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    currentXml = await dumpUi(config, device);
  }
  return { xml: currentXml, dateNode: null };
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

  xml = await dumpUi(config, device);
  const startMonthLabel = formatMonthLabel(exactDateRange.start);
  const endMonthLabel = formatMonthLabel(exactDateRange.end);
  const visibleStart = await ensureDateVisible(
    config,
    device,
    xml,
    steps,
    startMonthLabel,
    String(exactDateRange.start.getDate())
  );
  xml = visibleStart.xml;
  await saveArtifacts(config, device, store, "calendar-before-select", xml);

  const startDate = visibleStart.dateNode;
  if (!startDate?.bounds) {
    fail(
      "달력에서 정확한 일정 체크인 날짜를 찾지 못했습니다.",
      steps,
      [
        `선택 대상: ${exactDateRange.label}`,
        "오늘 이후 날짜 중 랜덤 체크인 날짜를 선택합니다.",
        "리포트의 calendar-before-select.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, startDate.bounds.x, startDate.bounds.y);
  addStep(steps, "체크인 날짜 선택", "pass", `${startMonthLabel} ${exactDateRange.start.getDate()}일`);
  await new Promise((resolve) => setTimeout(resolve, 120));

  xml = await dumpUi(config, device);
  const visibleEnd = await ensureDateVisible(
    config,
    device,
    xml,
    steps,
    endMonthLabel,
    String(exactDateRange.end.getDate())
  );
  xml = visibleEnd.xml;
  const endDate = visibleEnd.dateNode;
  if (!endDate?.bounds) {
    await saveArtifacts(config, device, store, "calendar-end-date-not-found", xml, { screenshot: true });
    fail(
      "달력에서 정확한 일정 체크아웃 날짜를 찾지 못했습니다.",
      steps,
      [
        `선택 대상: ${exactDateRange.label}`,
        "체크인 선택 후 체크아웃 월까지 달력을 내려 날짜를 찾습니다.",
        "리포트의 calendar-end-date-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, endDate.bounds.x, endDate.bounds.y);
  addStep(steps, "체크아웃 날짜 선택", "pass", `${endMonthLabel} ${exactDateRange.end.getDate()}일`);
  await new Promise((resolve) => setTimeout(resolve, 160));

  xml = await dumpUi(config, device);
  await saveArtifacts(config, device, store, "calendar-after-select", xml);
  const next = findNode(xml, "다음", { clickable: true, enabled: true });
  await tapNode(config, device, next, "다음 버튼", steps);
  addStep(steps, "일정 다음 버튼 탭");
}

function findVisibleFlexibleMonths(xml) {
  return parseNodes(xml).map((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    const label = nodeLabel(node).replace(/\s+/g, " ");
    const match = label.match(/(\d{1,2})월\s*(\d{4})/);
    if (!match || node.bounds.bottom <= 0 || node.bounds.top >= 2340) return null;
    return {
      node,
      month: Number(match[1]),
      year: Number(match[2]),
      label: `${Number(match[1])}월 / ${Number(match[2])}`
    };
  }).filter(Boolean);
}

async function selectFlexibleSchedule(config, device, xml, store, steps) {
  const scheduleTab = findNode(xml, "일정", { clickable: true });
  await tapNode(config, device, scheduleTab, "일정 탭", steps);
  addStep(steps, "일정 탭 진입");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => nextXml.includes("정확한 일정") && nextXml.includes("유연한 일정"),
    8000
  );
  await saveArtifacts(config, device, store, "flex-calendar-open", xml);

  const flexible = findNode(xml, "유연한 일정", { clickable: true });
  await tapNode(config, device, flexible, "유연한 일정 탭", steps);
  addStep(steps, "유연한 일정 선택");
  await new Promise((resolve) => setTimeout(resolve, 500));

  xml = await waitForUi(
    config,
    device,
    (nextXml) =>
      nextXml.includes("어느 정도 머물 예정인가요?") &&
      nextXml.includes("예상 입주일이 언제 정도인가요?"),
    8000
  );
  await saveArtifacts(config, device, store, "flex-options", xml);

  const duration = randomItem(["일주일", "2주", "한 달", "두 달 이상"]);
  const durationNode = findNode(xml, duration, { clickable: true });

  if (!durationNode?.bounds) {
    fail(
      `유연한 일정에서 '${duration}' 항목을 찾지 못했습니다.`,
      steps,
      [
        "유연한 일정 화면에는 '어느 정도 머물 예정인가요?'와 '예상 입주일이 언제 정도인가요?' 항목이 보여야 합니다.",
        "리포트의 flex-options.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, durationNode.bounds.x, durationNode.bounds.y);
  addStep(steps, "머무는 기간 랜덤 선택", "pass", duration);
  await new Promise((resolve) => setTimeout(resolve, 180));

  xml = await dumpUi(config, device);
  const pageMoves = Math.floor(Math.random() * 3);
  for (let count = 0; count < pageMoves; count += 1) {
    const before = findVisibleFlexibleMonths(xml).map(({ label }) => label).join("|");
    await runAdb(config, device, [
      "shell", "input", "swipe", "900", "1190", "360", "1190", "220"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const nextXml = await dumpUi(config, device);
    const after = findVisibleFlexibleMonths(nextXml).map(({ label }) => label).join("|");
    xml = nextXml;
    if (!after || after === before) break;
    addStep(steps, "예상 입주월 목록 랜덤 이동", "pass", `${count + 1}회`);
  }

  const monthCandidates = findVisibleFlexibleMonths(xml);
  const target = randomItem(monthCandidates);
  if (!target?.node?.bounds) {
    await saveArtifacts(config, device, store, "flex-month-not-found", xml, { screenshot: true });
    fail(
      "유연한 일정에서 현재 화면에 보이는 예상 입주월을 찾지 못했습니다.",
      steps,
      [
        "예상 입주월 목록에서 실제로 보이고 탭 가능한 월 중 하나를 랜덤 선택합니다.",
        "리포트의 flex-month-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, target.node.bounds.x, target.node.bounds.y);
  addStep(steps, "예상 입주월 랜덤 선택", "pass", `${target.year}년 ${target.month}월`);
  await new Promise((resolve) => setTimeout(resolve, 220));

  xml = await dumpUi(config, device);
  await saveArtifacts(config, device, store, "flex-after-select", xml);
  const next = findNode(xml, "다음", { clickable: true, enabled: true });
  await tapNode(config, device, next, "다음 버튼", steps);
  addStep(steps, "유연한 일정 다음 버튼 탭");

  return {
    label: `${duration} / ${target.month}월`,
    schedule: `${duration} / ${target.month}월`,
    duration,
    month: `${target.month}월`,
    move_in_year: target.year,
    yearMonth: `${target.year}-${String(target.month).padStart(2, "0")}`
  };
}

function guestCountSelected(xml) {
  const labels = parseNodes(xml).map(nodeLabel).join("\n");
  return (
    labels.includes("어린이\n만 2~12세\n1") &&
    labels.includes("유아\n만 2세 미만\n1") &&
    labels.includes("반려동물\n1")
  );
}

async function addGuestOptions(config, device, xml, store, steps) {
  let guestXml = await waitForUi(config, device, isGuestScreen, 8000);
  await saveArtifacts(config, device, store, "guest-select-start", guestXml);
  if (!isGuestScreen(guestXml)) {
    fail(
      "인원 선택 화면으로 이동하지 못했습니다.",
      steps,
      [
        "일정 선택 후 '게스트' 탭이 선택되고 성인/어린이/유아/반려동물 항목이 보여야 합니다.",
        "리포트의 guest-select-start.png 화면을 확인해주세요."
      ]
    );
  }

  const plusButtons = parseNodes(guestXml).filter(
    (node) =>
      node.bounds &&
      node.attrs.class === "android.widget.Button" &&
      node.attrs.clickable === "true" &&
      node.bounds.left >= 900 &&
      node.bounds.top >= 500 &&
      node.bounds.top <= 1150
  );

  const childPlus = plusButtons.find((node) => node.bounds.top >= 540 && node.bounds.top <= 700);
  const infantPlus = plusButtons.find((node) => node.bounds.top >= 760 && node.bounds.top <= 920);
  const petPlus = plusButtons.find((node) => node.bounds.top >= 980 && node.bounds.top <= 1120);
  const targets = [
    { node: childPlus, label: "어린이 + 버튼" },
    { node: infantPlus, label: "유아 + 버튼" },
    { node: petPlus, label: "반려동물 + 버튼" }
  ];

  for (const target of targets) {
    if (!target.node?.bounds) {
      fail(
        `${target.label}을 찾지 못했습니다.`,
        steps,
        [
          "인원 선택 화면의 + 버튼이 텍스트 없이 잡히므로 버튼 좌표 범위로 찾습니다.",
          "리포트의 guest-select-start.png 화면을 확인해주세요."
        ]
      );
    }
    await tap(config, device, target.node.bounds.x, target.node.bounds.y);
    addStep(steps, `${target.label} 탭`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  guestXml = await dumpUi(config, device);
  await saveArtifacts(config, device, store, "guest-select-after-plus", guestXml);
  if (!guestCountSelected(guestXml)) {
    fail(
      "어린이 1명, 유아 1명, 반려동물 1마리 선택 상태를 확인하지 못했습니다.",
      steps,
      [
        "각 + 버튼을 한 번씩 눌렀지만 XML에 선택 수량 1이 확인되지 않았습니다.",
        "리포트의 guest-select-after-plus.png 화면을 확인해주세요."
      ]
    );
  }

  const search = findNode(guestXml, "검색", { clickable: true, enabled: true });
  await tapNode(config, device, search, "검색 버튼", steps);
  addStep(steps, "검색 버튼 탭");
}

async function submitDefaultGuests(config, device, xml, store, steps) {
  const guestXml = await waitForUi(config, device, isGuestScreen, 8000);
  await saveArtifacts(config, device, store, "guest-select-default", guestXml);
  if (!isGuestScreen(guestXml)) {
    fail(
      "인원 선택 화면으로 이동하지 못했습니다.",
      steps,
      [
        "유연한 일정 선택 후 '게스트' 탭이 선택되고 성인/어린이/유아/반려동물 항목이 보여야 합니다.",
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
      "기본 인원 상태를 확인하지 못했습니다.",
      steps,
      [
        "유연한 일정 검색은 어린이, 유아, 반려동물을 추가하지 않고 기본 성인 1명으로 검색합니다.",
        "리포트의 guest-select-default.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "기본 인원 확인", "pass", "성인 1, 어린이 0, 유아 0, 반려동물 0");
  const search = findNode(guestXml, "검색", { clickable: true, enabled: true });
  await tapNode(config, device, search, "검색 버튼", steps);
  addStep(steps, "검색 버튼 탭");
}

async function openSearchConditionAfterLaunch(config, device, store, steps) {
  let xml = "";
  for (let count = 0; count < 3; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, count === 0 ? 260 : 180));
    await tap(config, device, 540, 360);
    xml = await waitForUi(config, device, isSearchConditionScreen, 520, 120);
    if (isSearchConditionScreen(xml)) {
      addStep(steps, "홈 검색바 빠른 진입", "pass", `앱 재실행 후 예상 검색바 좌표 ${count + 1}회 탭`);
      await saveArtifacts(config, device, store, "search-condition", xml);
      return xml;
    }
  }

  xml = await waitForUi(config, device, hasHomeSearchBar, 2500, 200);
  await saveArtifacts(config, device, store, "search-home", xml);
  return xml;
}

async function runSearchTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    let xml = await openSearchConditionAfterLaunch(config, device, store, steps);

    if (!isSearchConditionScreen(xml) && !hasHomeSearchBar(xml)) {
      fail(
        "앱 재실행 후 홈 검색바를 확인하지 못했습니다.",
        steps,
        [
          "검색은 로그인 필수 동작이 아니므로 로그인 여부를 보지 않고 홈 검색바만 확인합니다.",
          "검색바 문구는 '동네 · 주변 장소로 검색' 또는 '동네 주변 장소로 검색'이어야 합니다.",
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
    xml = await dumpUi(config, device);
    await saveArtifacts(config, device, store, "domestic-selected", xml);

    const exactDateRange = getRandomExactSearchDateRange(new Date(), {
      minNights: 1,
      maxNights: 60,
      maxEndDate: addDays(new Date(), 90),
      nightBuckets: [
        { min: 1, max: 7 },
        { min: 8, max: 30 },
        { min: 31, max: 60 }
      ]
    });
    addStep(steps, "정확한 일정 랜덤 기간 결정", "pass", exactDateRange.label);

    await selectExactDates(config, device, xml, store, steps, exactDateRange);
    xml = await waitForUi(config, device, isGuestScreen, 3500, 180);
    await addGuestOptions(config, device, xml, store, steps);

    xml = await waitForUi(
      config,
      device,
      (nextXml) => isSearchResults(nextXml, exactDateRange) || hasAppError(nextXml),
      20000
    );
    const appWarning = await collectAppErrorWarning(config, device, store, xml);
    if (!isSearchResults(xml, exactDateRange)) {
      await saveArtifacts(config, device, store, "search-results", xml, { screenshot: true });
      fail(
        "검색 버튼을 눌렀지만 검색 결과 목록 화면을 확인하지 못했습니다.",
        steps,
        [
          `성공 기준은 '국내', '${exactDateRange.label}', '개의 집/필터/지도로 보기' 신호입니다.`,
          "검색 결과가 '일주일 / 1명'이면 정확한 일정 선택 실패로 처리합니다.",
          "리포트의 search-results.png 화면을 확인해주세요."
        ]
      );
    }
    if (!hasLoadedSearchResultContent(xml)) {
      xml = await waitForUi(config, device, hasLoadedSearchResultContent, 6000, 300);
    }
    const resultSummary = summarizeAndroidSearchResults(xml, {
      ...exactDateRange,
      // 검색 조건 요약 인원은 성인+어린이만 포함하고 유아/반려동물은 제외한다.
      resultGuestLabel: "2명"
    });
    if (!resultSummary.condition_matches) {
      await saveArtifacts(config, device, store, "search-condition-mismatch", xml, { screenshot: true });
      fail(
        "검색 결과에 선택한 정확한 일정 또는 인원 조건이 반영되지 않았습니다.",
        steps,
        [
          `선택 조건: 국내 / ${exactDateRange.label} / 2명`,
          `결과 조건: ${resultSummary.applied_condition || "확인 불가"}`,
          "리포트의 search-condition-mismatch.png 화면을 확인해주세요."
        ]
      );
    }
    const finalArtifacts = await saveArtifacts(config, device, store, "search-results", xml);

    if (appWarning) {
      addStep(steps, "앱 오류 경고 확인", "pass", appWarning.message);
    }
    addStep(steps, "검색 결과 목록 진입 확인");

    return {
      test_id: "TC-SEARCH-001",
      name: `${role} 정확한 일정 검색`,
      env,
      status: "pass",
      device,
      steps,
      search: {
        type: "exact",
        region: "국내",
        label: exactDateRange.label,
        start_date: exactDateRange.startIso,
        end_date: exactDateRange.endIso,
        stay_nights: exactDateRange.nights,
        guests: "성인 1명, 어린이 1명, 유아 1명, 반려동물 1마리",
        ...resultSummary
      },
      search_conditions: {
        region: "국내",
        schedule_type: "정확한 일정",
        start_date: exactDateRange.startIso,
        end_date: exactDateRange.endIso,
        stay_nights: exactDateRange.nights,
        adult_count: 1,
        child_count: 1,
        infant_count: 1,
        pet_count: 1
      },
      app_warnings: appWarning ? [appWarning] : [],
      artifacts: {
        screenshots: finalArtifacts.screenshotPath ? [finalArtifacts.screenshotPath] : [],
        logs: [
          path.join(store.logsDir, "runner.log"),
          path.join(store.logsDir, "search-home.xml"),
          path.join(store.logsDir, "search-condition.xml"),
          path.join(store.logsDir, "calendar-after-select.xml"),
          path.join(store.logsDir, "guest-select-after-plus.xml"),
          finalArtifacts.xmlPath
        ]
      }
    };
  });
}

async function runFlexibleSearchTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    let xml = await openSearchConditionAfterLaunch(config, device, store, steps);

    if (!isSearchConditionScreen(xml) && !hasHomeSearchBar(xml)) {
      fail(
        "앱 재실행 후 홈 검색바를 확인하지 못했습니다.",
        steps,
        [
          "검색은 로그인 필수 동작이 아니므로 로그인 여부를 보지 않고 홈 검색바만 확인합니다.",
          "검색바 문구는 '동네 · 주변 장소로 검색' 또는 '동네 주변 장소로 검색'이어야 합니다.",
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
    await new Promise((resolve) => setTimeout(resolve, 600));
    xml = await dumpUi(config, device);
    await saveArtifacts(config, device, store, "domestic-selected", xml);

    const flexibleSelection = await selectFlexibleSchedule(config, device, xml, store, steps);
    xml = await waitForUi(config, device, isGuestScreen, 8000);
    await submitDefaultGuests(config, device, xml, store, steps);

    xml = await waitForUi(
      config,
      device,
      (nextXml) => isFlexibleSearchResults(nextXml, flexibleSelection) || hasAppError(nextXml),
      20000
    );
    const appWarning = await collectAppErrorWarning(config, device, store, xml);
    if (!isFlexibleSearchResults(xml, flexibleSelection)) {
      await saveArtifacts(config, device, store, "search-results", xml, { screenshot: true });
      fail(
        "검색 버튼을 눌렀지만 유연한 일정 검색 결과 목록 화면을 확인하지 못했습니다.",
        steps,
        [
          `성공 기준은 '국내', '${flexibleSelection.label} / 1명', '개의 집/필터/지도로 보기' 신호입니다.`,
          "리포트의 search-results.png 화면을 확인해주세요."
        ]
      );
    }
    if (!hasLoadedSearchResultContent(xml)) {
      xml = await waitForUi(config, device, hasLoadedSearchResultContent, 6000, 300);
    }
    const resultSummary = summarizeAndroidSearchResults(xml, flexibleSelection);
    if (!resultSummary.condition_matches) {
      await saveArtifacts(config, device, store, "search-condition-mismatch", xml, { screenshot: true });
      fail(
        "검색 결과에 선택한 유연한 일정 또는 인원 조건이 반영되지 않았습니다.",
        steps,
        [
          `선택 조건: 국내 / ${flexibleSelection.label} / 성인 1명`,
          `결과 조건: ${resultSummary.applied_condition || "확인 불가"}`,
          "리포트의 search-condition-mismatch.png 화면을 확인해주세요."
        ]
      );
    }
    const finalArtifacts = await saveArtifacts(config, device, store, "search-results", xml);

    if (appWarning) {
      addStep(steps, "앱 오류 경고 확인", "pass", appWarning.message);
    }
    addStep(steps, "검색 결과 목록 진입 확인");

    return {
      test_id: "TC-SEARCH-002",
      name: `${role} 유연한 일정 검색`,
      env,
      status: "pass",
      device,
      steps,
      search: {
        type: "flexible",
        region: "국내",
        ...flexibleSelection,
        guests: "성인 1명",
        ...resultSummary
      },
      search_conditions: {
        region: "국내",
        schedule_type: "유연한 일정",
        stay_duration: flexibleSelection.duration,
        expected_move_in_months: [flexibleSelection.yearMonth],
        adult_count: 1,
        child_count: 0,
        infant_count: 0,
        pet_count: 0
      },
      app_warnings: appWarning ? [appWarning] : [],
      artifacts: {
        screenshots: finalArtifacts.screenshotPath ? [finalArtifacts.screenshotPath] : [],
        logs: [
          path.join(store.logsDir, "runner.log"),
          path.join(store.logsDir, "search-home.xml"),
          path.join(store.logsDir, "search-condition.xml"),
          path.join(store.logsDir, "flex-after-select.xml"),
          path.join(store.logsDir, "guest-select-default.xml"),
          finalArtifacts.xmlPath
        ]
      }
    };
  });
}

module.exports = {
  runFlexibleSearchTest,
  runSearchTest,
  selectFlexibleSchedule
};
