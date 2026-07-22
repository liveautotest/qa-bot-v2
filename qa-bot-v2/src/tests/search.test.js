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

function isLoggedInHome(xml) {
  const signals = [
    "잠시 머물 집은",
    "동네 · 주변 장소로 검색",
    "동네 주변 장소로 검색",
    "내 정보",
    "계약",
    "리브후기"
  ];
  return signals.filter((text) => xml.includes(text)).length >= 2;
}

function isLoggedOut(xml) {
  return (
    xml.includes("이메일/휴대폰 번호로 시작하기") ||
    (xml.includes("로그인해 주세요") && xml.includes("회원가입 / 로그인하기")) ||
    (xml.includes("이메일 혹은 휴대폰 번호로 시작하기") && xml.includes("비밀번호"))
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

function isSearchResults(xml) {
  return (
    xml.includes("국내") &&
    xml.includes("8월 1일 ~ 8월 7일") &&
    (xml.includes("개의 집") || xml.includes("필터") || xml.includes("지도로 보기"))
  );
}

async function waitForUi(config, device, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  let xml = "";

  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return xml;
}

async function saveArtifacts(config, device, store, name, xml) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);

  try {
    fs.writeFileSync(xmlPath, xml || (await dumpUi(config, device)));
  } catch (error) {
    store.appendLog("runner.log", `failed to dump ui ${name}: ${error.message}`);
  }

  try {
    fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  } catch (error) {
    store.appendLog("runner.log", `failed to screenshot ${name}: ${error.message}`);
  }

  return { xmlPath, screenshotPath };
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

async function ensureAugustVisible(config, device, xml, steps) {
  let currentXml = xml;
  for (let count = 0; count < 4; count += 1) {
    if (currentXml.includes("2026년 8월")) return currentXml;
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "1900", "540", "1100", "500"
    ]);
    addStep(steps, "달력 스크롤", "pass", "2026년 8월 탐색");
    await new Promise((resolve) => setTimeout(resolve, 700));
    currentXml = await dumpUi(config, device);
  }
  return currentXml;
}

async function selectExactDates(config, device, xml, store, steps) {
  const scheduleTab = findNode(xml, "일정", { clickable: true });
  await tapNode(config, device, scheduleTab, "일정 탭", steps);
  addStep(steps, "일정 탭 진입");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => nextXml.includes("정확한 일정") && nextXml.includes("유연한 일정"),
    8000
  );
  await saveArtifacts(config, device, store, "calendar-open", xml);

  const exact = findNode(xml, "정확한 일정", { clickable: true });
  await tapNode(config, device, exact, "정확한 일정 탭", steps);
  addStep(steps, "정확한 일정 선택");
  await new Promise((resolve) => setTimeout(resolve, 500));

  xml = await dumpUi(config, device);
  xml = await ensureAugustVisible(config, device, xml, steps);
  await saveArtifacts(config, device, store, "calendar-before-select", xml);

  const startDate = findDateNodeInMonth(xml, "2026년 8월", "1");
  const endDate = findDateNodeInMonth(xml, "2026년 8월", "7");
  if (!startDate?.bounds || !endDate?.bounds) {
    fail(
      "달력에서 2026년 8월 1일 또는 8월 7일을 찾지 못했습니다.",
      steps,
      [
        "정확한 일정 달력에 2026년 8월이 노출되어야 합니다.",
        "리포트의 calendar-before-select.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, startDate.bounds.x, startDate.bounds.y);
  addStep(steps, "체크인 날짜 선택", "pass", "2026-08-01");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await tap(config, device, endDate.bounds.x, endDate.bounds.y);
  addStep(steps, "체크아웃 날짜 선택", "pass", "2026-08-07");
  await new Promise((resolve) => setTimeout(resolve, 500));

  xml = await dumpUi(config, device);
  await saveArtifacts(config, device, store, "calendar-after-select", xml);
  const next = findNode(xml, "다음", { clickable: true, enabled: true });
  await tapNode(config, device, next, "다음 버튼", steps);
  addStep(steps, "일정 다음 버튼 탭");
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
    await new Promise((resolve) => setTimeout(resolve, 3000));

    let xml = await waitForUi(
      config,
      device,
      (nextXml) => isLoggedInHome(nextXml) || isLoggedOut(nextXml),
      10000
    );
    await saveArtifacts(config, device, store, "search-home", xml);

    if (isLoggedOut(xml)) {
      fail(
        "검색 테스트를 시작할 수 없습니다. 현재 단말이 로그인 상태가 아닙니다.",
        steps,
        [
          "먼저 Slack에서 !게스트 로그인 또는 CLI login을 실행해주세요.",
          "검색 테스트는 앱을 완전히 껐다가 재실행하지만, 로그인 세션은 유지되어 있어야 합니다.",
          "리포트의 search-home.png 화면을 확인해주세요."
        ]
      );
    }

    if (!isLoggedInHome(xml)) {
      fail(
        "앱 재실행 후 홈 화면을 확인하지 못했습니다.",
        steps,
        [
          "홈 화면 신호는 검색바, 내 정보, 계약, 리브후기 텍스트 중 2개 이상으로 판단합니다.",
          "리포트의 search-home.png 화면을 확인해주세요."
        ]
      );
    }

    await tapSearchBar(config, device, xml, steps);
    xml = await waitForUi(config, device, isSearchConditionScreen, 8000);
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

    await selectExactDates(config, device, xml, store, steps);
    xml = await waitForUi(config, device, isGuestScreen, 8000);
    await addGuestOptions(config, device, xml, store, steps);

    xml = await waitForUi(config, device, isSearchResults, 20000);
    const finalArtifacts = await saveArtifacts(config, device, store, "search-results", xml);
    if (!isSearchResults(xml)) {
      fail(
        "검색 버튼을 눌렀지만 검색 결과 목록 화면을 확인하지 못했습니다.",
        steps,
        [
          "성공 기준은 '국내', '8월 1일 ~ 8월 7일', '개의 집/필터/지도로 보기' 신호입니다.",
          "리포트의 search-results.png 화면을 확인해주세요."
        ]
      );
    }

    addStep(steps, "검색 결과 목록 진입 확인");

    return {
      test_id: "TC-SEARCH-001",
      name: `${role} 집 검색`,
      env,
      status: "pass",
      device,
      steps,
      search_conditions: {
        region: "국내",
        schedule_type: "정확한 일정",
        start_date: "2026-08-01",
        end_date: "2026-08-07",
        child_count: 1,
        infant_count: 1,
        pet_count: 1
      },
      artifacts: {
        screenshots: [finalArtifacts.screenshotPath],
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

module.exports = {
  runSearchTest
};
