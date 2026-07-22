const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const { inputUnicodeText } = require("./aos-text-input");
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
    if (options.visible && (!node.bounds || node.bounds.bottom <= 94 || node.bounds.top >= 2496)) return false;
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

function isContractSearchResults(xml) {
  return (
    xml.includes("국내") &&
    xml.includes("8월 1일 ~ 8월 7일") &&
    (xml.includes("개의 집") || xml.includes("필터") || xml.includes("지도로 보기"))
  );
}

function isContractDetail(xml) {
  return (
    xml.includes("계약 요청하기") &&
    xml.includes("계약자 정보") &&
    xml.includes("필수 약관 전체 동의")
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

function isContractComplete(xml) {
  return (
    xml.includes("홈으로") &&
    (xml.includes("계약 요청") || xml.includes("요청이 완료") || xml.includes("계약이 요청"))
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
        "계약 요청은 검색 결과에서 이어지므로 홈 검색바 진입이 먼저 필요합니다.",
        "리포트의 search-home.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, searchBar.bounds.x, searchBar.bounds.y);
  addStep(steps, "홈 검색바 탭");
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
        "계약 요청 선행 검색은 정확한 일정 2026-08-01~2026-08-07을 사용합니다.",
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

async function addGuestOptions(config, device, xml, store, steps) {
  let guestXml = await waitForUi(config, device, isGuestScreen, 8000);
  await saveArtifacts(config, device, store, "guest-select-start", guestXml);
  if (!isGuestScreen(guestXml)) {
    fail(
      "인원 선택 화면으로 이동하지 못했습니다.",
      steps,
      [
        "계약 요청 선행 검색은 어린이 1명, 유아 1명, 반려동물 1마리를 포함합니다.",
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
  const labels = parseNodes(guestXml).map(nodeLabel).join("\n");
  if (
    !labels.includes("어린이\n만 2~12세\n1") ||
    !labels.includes("유아\n만 2세 미만\n1") ||
    !labels.includes("반려동물\n1")
  ) {
    fail(
      "어린이 1명, 유아 1명, 반려동물 1마리 선택 상태를 확인하지 못했습니다.",
      steps,
      [
        "각 + 버튼을 한 번씩 눌렀지만 XML에 선택 수량 1이 확인되지 않았습니다.",
        "리포트의 guest-select-after-plus.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "계약 요청용 인원 선택 확인", "pass", "어린이 1, 유아 1, 반려동물 1");
  const search = findNode(guestXml, "검색", { clickable: true, enabled: true });
  await tapNode(config, device, search, "검색 버튼", steps);
  addStep(steps, "검색 버튼 탭");
}

function findFirstListing(xml) {
  return parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      node.attrs.clickable === "true" &&
      node.bounds.top >= 350 &&
      node.bounds.bottom > node.bounds.top &&
      label.includes("최소") &&
      label.includes("계약 가능") &&
      label.includes("₩")
    );
  });
}

async function openFirstListing(config, device, store, steps) {
  await runAdb(config, device, [
    "shell", "input", "swipe", "540", "2300", "540", "900", "700"
  ]);
  addStep(steps, "검색 결과 리스트 끌어올리기");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  let xml = await dumpUi(config, device);
  await saveArtifacts(config, device, store, "search-results-expanded", xml);
  let listing = findFirstListing(xml);

  for (let count = 0; !listing && count < 3; count += 1) {
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "2050", "540", "1350", "500"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    xml = await dumpUi(config, device);
    listing = findFirstListing(xml);
  }

  if (!listing?.bounds) {
    fail(
      "검색 결과 목록에서 계약 가능한 숙소 카드를 찾지 못했습니다.",
      steps,
      [
        "검색 결과 리스트를 끌어올린 뒤 '최소', '계약 가능', 가격 문구가 있는 카드를 찾습니다.",
        "리포트의 search-results-expanded.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, listing.bounds.x, listing.bounds.y);
  addStep(steps, "임의 숙소 카드 선택");
}

async function tapContractCondition(config, device, store, steps) {
  const xml = await waitForUi(
    config,
    device,
    (nextXml) => nextXml.includes("계약 조건 확인"),
    15000
  );
  await saveArtifacts(config, device, store, "accommodation-detail", xml);

  const contractCondition = findNode(xml, "계약 조건 확인", {
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, contractCondition, "계약 조건 확인 버튼", steps);
  addStep(steps, "계약 조건 확인 버튼 탭");
}

async function scrollToRequiredTerms(config, device, store, steps) {
  let xml = await waitForUi(config, device, isContractDetail, 10000);
  await saveArtifacts(config, device, store, "contract-detail-start", xml);

  for (let count = 0; count < 8; count += 1) {
    const terms = findNode(xml, "필수 약관 전체 동의", {
      clickable: true,
      enabled: true,
      visible: true
    });
    const request = findNode(xml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    });
    if (terms?.bounds && request?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-terms", xml);
      return { terms, request, xml };
    }

    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "2150", "540", "450", "900"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    xml = await dumpUi(config, device);
  }

  await saveArtifacts(config, device, store, "contract-detail-terms-not-found", xml);
  fail(
    "계약 상세 화면에서 필수 약관 전체 동의 영역을 찾지 못했습니다.",
    steps,
    [
      "계약 상세 화면 하단까지 스크롤했지만 필수 약관 전체 동의와 계약 요청하기 버튼이 동시에 보이지 않았습니다.",
      "리포트의 contract-detail-terms-not-found.png 화면을 확인해주세요."
    ]
  );
}

function findPetInfoInput(xml) {
  const nodes = parseNodes(xml);
  const guestSummary = nodes.find((node) => {
    const label = nodeLabel(node);
    return node.bounds && label.includes("성인 1") && label.includes("1 반려동물");
  });
  const petLabel = nodes.find((node) => {
    const label = nodeLabel(node);
    return node.bounds && label.includes("반려동물") && label.includes("정보");
  });

  const candidates = nodes.filter((node) => {
    if (!node.bounds) return false;
    if (node.attrs.enabled !== "true") return false;
    if (!["android.widget.EditText", "android.widget.ImageView"].includes(node.attrs.class)) {
      return false;
    }
    if (node.bounds.top < 250 || node.bounds.bottom > 2300) return false;
    if (nodeLabel(node).includes("리트리버")) return false;
    return true;
  });

  if (guestSummary?.bounds) {
    const belowGuestSummary = candidates.find(
      (node) =>
        node.attrs.class === "android.widget.EditText" &&
        !nodeLabel(node).trim() &&
        node.bounds.top >= guestSummary.bounds.bottom &&
        node.bounds.top - guestSummary.bounds.bottom < 220 &&
        node.bounds.left <= 120 &&
        node.bounds.right >= 900
    );
    if (belowGuestSummary) return belowGuestSummary;
  }

  if (petLabel?.bounds) {
    const belowPetLabel = candidates.find(
      (node) =>
        node.bounds.top >= petLabel.bounds.bottom &&
        node.bounds.top - petLabel.bounds.bottom < 450 &&
        node.bounds.left <= 120 &&
        node.bounds.right >= 900
    );
    if (belowPetLabel) return belowPetLabel;
  }

  return candidates.find((node) => {
    const label = nodeLabel(node);
    return (
      label.includes("반려동물 정보를") ||
      label.includes("견종") ||
      label.includes("품종") ||
      label.includes("입력")
    );
  });
}

async function fillPetInfoIfNeeded(config, device, store, steps) {
  let xml = await dumpUi(config, device);

  for (let count = 0; count < 8; count += 1) {
    if (xml.includes("리트리버")) {
      addStep(steps, "반려동물 정보 입력 확인", "pass", "리트리버");
      return xml;
    }

    const petInput = findPetInfoInput(xml);
    if (petInput?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-pet-info", xml);
      await tap(config, device, petInput.bounds.x, petInput.bounds.y);
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await inputUnicodeText(config, device, "리트리버", store);
      } catch (error) {
        fail(
          "반려동물 정보 입력란은 찾았지만 '리트리버' 입력에 실패했습니다.",
          steps,
          [
            `입력 오류: ${error.message}`,
            "ADB 기본 input text가 한글을 처리하지 못하면 ADB Keyboard로 우회 입력합니다.",
            "리포트의 contract-detail-pet-info.png 화면을 확인해주세요."
          ]
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      await keyEvent(config, device, 4);
      await new Promise((resolve) => setTimeout(resolve, 700));
      xml = await dumpUi(config, device);
      await saveArtifacts(config, device, store, "contract-detail-after-pet-info", xml);

      if (!xml.includes("리트리버")) {
        fail(
          "반려동물 정보 입력란은 찾았지만 '리트리버' 입력을 확인하지 못했습니다.",
          steps,
          [
            "반려동물 1마리 조건으로 계약 요청하려면 계약 상세에서 반려동물 정보 입력이 필요합니다.",
            "기기 키보드가 ADB 한글 입력을 받지 않았을 수 있습니다.",
            "리포트의 contract-detail-after-pet-info.png 화면을 확인해주세요."
          ]
        );
      }

      addStep(steps, "반려동물 정보 입력", "pass", "리트리버");
      return xml;
    }

    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "2150", "540", "450", "900"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    xml = await dumpUi(config, device);
  }

  await saveArtifacts(config, device, store, "contract-detail-pet-info-not-found", xml);
  fail(
    "반려동물 정보 입력란을 찾지 못했습니다.",
    steps,
    [
      "검색 조건에 반려동물 1마리가 포함되어 있으므로 계약 상세에서 반려동물 정보 입력란이 보여야 합니다.",
      "리포트의 contract-detail-pet-info-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function submitContractRequest(config, device, store, steps) {
  await fillPetInfoIfNeeded(config, device, store, steps);
  const { terms, request } = await scrollToRequiredTerms(config, device, store, steps);

  await tap(config, device, terms.bounds.x, terms.bounds.y);
  addStep(steps, "필수 약관 전체 동의 선택");
  await new Promise((resolve) => setTimeout(resolve, 700));

  let xml = await dumpUi(config, device);
  await saveArtifacts(config, device, store, "contract-detail-after-terms", xml);
  const requestButton =
    findNode(xml, "계약 요청하기", {
      clickable: true,
      enabled: true,
      visible: true
    }) || request;

  await tap(config, device, requestButton.bounds.x, requestButton.bounds.y);
  addStep(steps, "계약 요청하기 버튼 탭");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => isContractComplete(nextXml) || hasContractRequestError(nextXml),
    20000
  );
  await saveArtifacts(config, device, store, "contract-request-after-submit", xml);

  if (hasContractRequestError(xml) && !isContractComplete(xml)) {
    fail(
      "계약 요청 완료 화면으로 이동하지 못했습니다.",
      steps,
      [
        "계약 요청 후 앱 오류 또는 필수 정보 누락 메시지가 노출되었습니다.",
        "반려동물 정보 입력값 '리트리버'가 저장되었는지도 함께 확인해주세요.",
        "리포트의 contract-request-after-submit.png 화면을 확인해주세요."
      ]
    );
  }

  if (!isContractComplete(xml)) {
    fail(
      "계약 요청 완료 화면을 확인하지 못했습니다.",
      steps,
      [
        "완료 화면에는 계약 요청 완료 문구와 홈으로 버튼이 보여야 합니다.",
        "리포트의 contract-request-after-submit.png 화면을 확인해주세요."
      ]
    );
  }

  const home = findNode(xml, "홈으로", { clickable: true, enabled: true });
  await tapNode(config, device, home, "홈으로 버튼", steps);
  addStep(steps, "완료 화면 홈으로 버튼 탭");

  xml = await waitForUi(config, device, hasHomeSearchBar, 10000);
  await saveArtifacts(config, device, store, "contract-request-final", xml);
  if (!hasHomeSearchBar(xml)) {
    fail(
      "홈으로 버튼을 눌렀지만 홈 화면을 확인하지 못했습니다.",
      steps,
      [
        "완료 화면에서 홈으로 버튼을 누른 뒤 홈 검색바가 보여야 합니다.",
        "리포트의 contract-request-final.png 화면을 확인해주세요."
      ]
    );
  }
}

async function runContractRequestTest({ request, config, store }) {
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

    let xml = await waitForUi(config, device, hasHomeSearchBar, 10000);
    await saveArtifacts(config, device, store, "search-home", xml);
    if (!hasHomeSearchBar(xml)) {
      fail(
        "앱 재실행 후 홈 검색바를 확인하지 못했습니다.",
        steps,
        [
          "계약 요청은 로그인 상태의 게스트 홈 화면에서 시작해야 합니다.",
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

    xml = await waitForUi(config, device, isContractSearchResults, 20000);
    await saveArtifacts(config, device, store, "search-results", xml);
    if (!isContractSearchResults(xml)) {
      fail(
        "계약 요청용 검색 결과 목록 화면을 확인하지 못했습니다.",
        steps,
        [
          "성공 기준은 '국내', '8월 1일 ~ 8월 7일', '개의 집/필터/지도로 보기' 신호입니다.",
          "리포트의 search-results.png 화면을 확인해주세요."
        ]
      );
    }
    addStep(steps, "계약 요청용 검색 결과 목록 확인");

    await openFirstListing(config, device, store, steps);
    await tapContractCondition(config, device, store, steps);
    await submitContractRequest(config, device, store, steps);
    addStep(steps, "계약 요청 완료 후 홈 화면 확인");

    return {
      test_id: "TC-CONTRACT-001",
      name: `${role} 계약 요청`,
      env,
      status: "pass",
      device,
      steps,
      contract_conditions: {
        region: "국내",
        schedule_type: "정확한 일정",
        start_date: "2026-08-01",
        end_date: "2026-08-07",
        adult_count: 1,
        child_count: 1,
        infant_count: 1,
        pet_count: 1,
        pet_info: "리트리버"
      },
      artifacts: {
        screenshots: [path.join(store.screenshotsDir, "contract-request-final.png")],
        logs: [
          path.join(store.logsDir, "search-results.xml"),
          path.join(store.logsDir, "accommodation-detail.xml"),
          path.join(store.logsDir, "contract-detail-after-pet-info.xml"),
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
