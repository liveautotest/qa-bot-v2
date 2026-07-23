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
    if (options.visible && (!node.bounds || node.bounds.bottom <= 94 || node.bounds.top >= 2496)) return false;
    if (options.aboveBottomAction && node.bounds.bottom >= 2220) return false;
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

function isContractSearchResults(xml) {
  return (
    xml.includes("국내") &&
    xml.includes("8월 1일 ~ 8월 7일") &&
    (xml.includes("개의 집") || xml.includes("필터") || xml.includes("지도로 보기"))
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

async function waitForUi(config, device, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  let xml = "";

  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUiStable(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 500));
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

function isContractSubmitOutcome(xml) {
  return (
    isContractComplete(xml) ||
    isContractPeriodConfirm(xml) ||
    hasTermsAgreementWarning(xml) ||
    hasContractRequestError(xml)
  );
}

async function pressContractRequestButton(config, device, store, button, mode = "tap") {
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
    currentXml = await dumpUiStable(config, device);
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

  xml = await dumpUiStable(config, device);
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

  xml = await dumpUiStable(config, device);
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  let xml = await dumpUiStable(config, device);
  await saveArtifacts(config, device, store, "search-results-expanded", xml);
  let listing = findFirstListing(xml);

  for (let count = 0; !listing && count < 3; count += 1) {
    await runAdb(config, device, [
      "shell", "input", "swipe", "540", "2050", "540", "1350", "500"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    xml = await dumpUiStable(config, device);
    listing = findFirstListing(xml);
  }

  if (!listing?.bounds) {
    await saveFailureArtifacts(config, device, store, "search-results-expanded", xml);
    fail(
      "검색 결과 목록에서 계약 가능한 숙소 카드를 찾지 못했습니다.",
      steps,
      [
        "검색 결과 리스트를 끌어올린 뒤 '최소', '계약 가능', 가격 문구가 있는 카드를 찾습니다.",
        "리포트의 search-results-expanded.png 화면을 확인해주세요."
      ]
    );
  }

  const tapTargets = [
    {
      name: "숙소 카드 제목 왼쪽 영역",
      x: Math.min(listing.bounds.right - 120, listing.bounds.left + 260),
      y: Math.min(listing.bounds.bottom - 120, listing.bounds.top + 700)
    },
    {
      name: "숙소 카드 설명 왼쪽 영역",
      x: Math.min(listing.bounds.right - 120, listing.bounds.left + 240),
      y: Math.min(listing.bounds.bottom - 120, listing.bounds.top + 790)
    },
    {
      name: "숙소 카드 이미지 영역",
      x: listing.bounds.x,
      y: Math.min(listing.bounds.bottom - 80, listing.bounds.top + 260)
    },
    {
      name: "숙소 카드 제목 영역",
      x: Math.min(listing.bounds.right - 120, listing.bounds.left + 320),
      y: Math.min(listing.bounds.bottom - 80, listing.bounds.top + 620)
    },
    {
      name: "숙소 카드 후기 위 본문 영역",
      x: Math.min(listing.bounds.right - 120, listing.bounds.left + 260),
      y: Math.min(listing.bounds.bottom - 180, listing.bounds.top + 980)
    },
    {
      name: "숙소 카드 중앙 영역",
      x: listing.bounds.x,
      y: listing.bounds.y
    }
  ];

  let detailXml = "";
  for (const target of tapTargets) {
    await tap(config, device, target.x, target.y);
    store.appendLog(
      "runner.log",
      `contract-request listing tap: ${target.name} (${target.x}, ${target.y})`
    );
    detailXml = await waitForUi(config, device, isAccommodationDetail, 8000);
    if (isAccommodationDetail(detailXml)) {
      addStep(steps, "검색 결과 첫 번째 숙소 상세 진입", "pass", target.name);
      return detailXml;
    }

    if (!isContractSearchResults(detailXml)) break;
  }

  await saveFailureArtifacts(config, device, store, "listing-tap-did-not-open-detail", detailXml);
  fail(
    "검색 결과 첫 번째 숙소 카드를 눌렀지만 상세 화면으로 이동하지 않았습니다.",
    steps,
    [
      "자동화가 숙소 카드의 이미지/제목/중앙 영역을 순서대로 탭했습니다.",
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
    : await waitForUi(config, device, isContractDetail, 10000);
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

  for (let batch = 0; batch < 4; batch += 1) {
    const terms = findNode(xml, "필수 약관 전체 동의", {
      clickable: true,
      enabled: true,
      visible: true,
      aboveBottomAction: true
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

    if (
      xml.includes("필수 약관 전체 동의") &&
      xml.includes("계약 요청하기") &&
      xml.includes("결제 수단")
    ) {
      const revealSwipes = [
        ["540", "2180", "540", "1730", "250"],
        ["540", "2050", "540", "1200", "450"],
        ["540", "1950", "540", "700", "650"],
        ["540", "1800", "540", "620", "650"]
      ];

      for (const [startX, startY, endX, endY, duration] of revealSwipes) {
        await runAdb(config, device, [
          "shell", "input", "swipe", startX, startY, endX, endY, duration
        ]);
        await new Promise((resolve) => setTimeout(resolve, 250));
        xml = await dumpUiStable(config, device);

        const adjustedTerms = findNode(xml, "필수 약관 전체 동의", {
          clickable: true,
          enabled: true,
          visible: true,
          aboveBottomAction: true
        });
        const adjustedRequest = findNode(xml, "계약 요청하기", {
          clickable: true,
          enabled: true,
          visible: true
        });
        if (adjustedTerms?.bounds && adjustedRequest?.bounds) {
          store.appendLog(
            "runner.log",
            `contract-request terms became visible after reveal scroll adjustment (${startY}->${endY})`
          );
          await saveArtifacts(config, device, store, "contract-detail-terms", xml);
          return { terms: adjustedTerms, request: adjustedRequest, xml };
        }
      }

      for (let count = 0; count < 6; count += 1) {
        await runAdb(config, device, [
          "shell", "input", "swipe", "540", "1760", "540", "1180", "320"
        ]);
        await new Promise((resolve) => setTimeout(resolve, 250));
        xml = await dumpUiStable(config, device);

        const liftedTerms = findNode(xml, "필수 약관 전체 동의", {
          clickable: true,
          enabled: true,
          visible: true,
          aboveBottomAction: true
        });
        const liftedRequest = findNode(xml, "계약 요청하기", {
          clickable: true,
          enabled: true,
          visible: true
        });
        if (liftedTerms?.bounds && liftedRequest?.bounds) {
          store.appendLog(
            "runner.log",
            `contract-request terms lifted above bottom action after extra scroll (${count + 1})`
          );
          await saveArtifacts(config, device, store, "contract-detail-terms", xml);
          return { terms: liftedTerms, request: liftedRequest, xml };
        }
      }

      store.appendLog(
        "runner.log",
        "contract-request terms are visible in WebView but XML bounds are clipped; refusing unsafe fallback tap"
      );
      await saveFailureArtifacts(config, device, store, "contract-detail-terms-clipped", xml);
      fail(
        "필수 약관 전체 동의 영역의 실제 탭 좌표를 확인하지 못했습니다.",
        steps,
        [
          "화면에는 약관 영역이 있지만 Android XML 좌표가 화면 하단에 접혀 있어 안전하게 탭할 수 없습니다.",
          "상세 규정 확인 같은 다른 버튼을 누르지 않도록 좌표 추정 탭은 중단했습니다.",
          "리포트의 contract-detail-terms-clipped.png 화면을 확인해주세요."
        ]
      );
    }

    for (let count = 0; count < 3; count += 1) {
      await runAdb(config, device, [
        "shell", "input", "swipe", "540", "2220", "540", "340", "450"
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "contract-detail-terms-not-found", xml);
  fail(
    "계약 상세 화면에서 필수 약관 전체 동의 영역을 찾지 못했습니다.",
    steps,
    [
      "계약 상세 화면 하단까지 스크롤했지만 필수 약관 전체 동의와 계약 요청하기 버튼이 동시에 보이지 않았습니다.",
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

  return waitForUi(
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
}

async function selectAutoCardPayment(config, device, store, steps, initialXml) {
  let xml = isContractDetail(initialXml)
    ? initialXml
    : await waitForUi(config, device, isContractDetail, 10000);

  for (let count = 0; count < 8; count += 1) {
    const autoCard = findAutoCardPaymentOption(xml);
    if (autoCard?.bounds) {
      await saveArtifacts(config, device, store, "contract-detail-auto-card", xml);
      if (hasAutoCardPaymentSelected(xml)) {
        addStep(steps, "자동카드 결제 수단 선택", "pass", "이미 선택된 상태");
        return xml;
      }

      await tap(config, device, autoCard.bounds.x, autoCard.bounds.y);
      addStep(steps, "자동카드 결제 수단 선택");
      await new Promise((resolve) => setTimeout(resolve, 400));

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
        "shell", "input", "swipe", "540", "2060", "540", "1460", "220"
      ]);
    } else {
      await runAdb(config, device, [
        "shell", "input", "swipe", "540", "2050", "540", "950", "260"
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
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
  let preparedContractDetailXml = contractDetailXml;
  if (options.paymentMethod === "auto-card") {
    preparedContractDetailXml = await selectAutoCardPayment(config, device, store, steps, contractDetailXml);
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
    }

    await saveArtifacts(config, device, store, "contract-request-after-retry-submit", xml);
  }

  if (hasContractRequestError(xml) && !isContractComplete(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-request-after-submit", xml);
    fail(
      "계약 요청 완료 화면으로 이동하지 못했습니다.",
      steps,
      [
        "계약 요청 후 앱 오류 또는 필수 정보 누락 메시지가 노출되었습니다.",
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
  await new Promise((resolve) => setTimeout(resolve, 1200));
  addStep(steps, "홈 화면 풀 리프레시");

  xml = await waitForUi(config, device, hasHomeSearchBar, 8000);
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
}

async function runContractRequestTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const paymentMethod = request.payment_method || "manual";
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (!["manual", "auto-card"].includes(paymentMethod)) {
    throw new Error(`Unknown contract request payment method: ${paymentMethod}`);
  }
  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    let xml = await waitForUi(config, device, hasHomeSearchBar, 10000);
    await saveArtifacts(config, device, store, "search-home", xml);
    if (!hasHomeSearchBar(xml)) {
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

    await tapSearchBar(config, device, xml, steps);
    xml = await waitForUi(config, device, isSearchConditionScreen, 8000);
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
    await new Promise((resolve) => setTimeout(resolve, 600));
    xml = await dumpUiStable(config, device);
    await saveArtifacts(config, device, store, "domestic-selected", xml);

    await selectExactDates(config, device, xml, store, steps);
    xml = await waitForUi(config, device, isGuestScreen, 8000);
    await submitDefaultGuests(config, device, xml, store, steps);

    xml = await waitForUi(config, device, isContractSearchResults, 20000);
    await saveArtifacts(config, device, store, "search-results", xml);
    if (!isContractSearchResults(xml)) {
      await saveFailureArtifacts(config, device, store, "search-results", xml);
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

    const detailXml = await openFirstListing(config, device, store, steps);
    const contractDetailXml = await tapContractCondition(config, device, store, steps, detailXml);
    await submitContractRequest(config, device, store, steps, contractDetailXml, { paymentMethod });
    addStep(steps, "계약 요청 완료 후 홈 화면 확인");

    return {
      test_id: "TC-CONTRACT-001",
      name: paymentMethod === "auto-card" ? `${role} 자동카드 계약 요청` : `${role} 계약 요청`,
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
        child_count: 0,
        infant_count: 0,
        pet_count: 0,
        payment_method: paymentMethod === "auto-card" ? "호스트 수락 즉시 자동 결제" : "호스트 승인 후 별도 결제"
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
