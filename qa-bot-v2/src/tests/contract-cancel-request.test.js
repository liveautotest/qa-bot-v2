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
  return (xml.match(/<node\b[^>]*>/g) || []).map((raw) => {
    const attrs = {};
    for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[match[1]] = decodeXmlValue(match[2]);
    }
    return { attrs, bounds: parseBounds(attrs.bounds) };
  });
}

function nodeLabel(node) {
  return [
    node.attrs.text || "",
    node.attrs["content-desc"] || "",
    node.attrs.hint || ""
  ].join("\n");
}

function isVisibleNode(node) {
  if (!node?.bounds) return false;
  return node.bounds.bottom > 120 && node.bounds.top < 2449 && node.bounds.bottom > node.bounds.top;
}

function findNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && !isVisibleNode(node)) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;

    const label = nodeLabel(node);
    return labelList.some((value) => label.includes(value));
  });

  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function getScreenBounds(xml) {
  return parseNodes(xml)
    .map((node) => node.bounds)
    .filter(Boolean)
    .sort((a, b) => (b.right * b.bottom) - (a.right * a.bottom))[0];
}

function saveXml(store, name, xml) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  fs.writeFileSync(xmlPath, xml);
  return xmlPath;
}

async function saveFailureArtifacts(config, device, store, name, xml) {
  const xmlPath = saveXml(store, name, xml || (await dumpUi(config, device)));
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return { xmlPath, screenshotPath };
}

async function waitForUi(config, device, predicate, timeoutMs = 12000) {
  const startedAt = Date.now();
  let xml = "";

  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return xml;
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
  if (!node?.bounds) fail(`${label}을 찾지 못했습니다.`, steps);
  await tap(config, device, node.bounds.x, node.bounds.y);
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
    xml.includes("로그인 하지 않고 둘러보기")
  );
}

function hasContractRequestCard(xml) {
  return (
    xml.includes("계약 요청") ||
    xml.includes("요청 중") ||
    xml.includes("요청중") ||
    xml.includes("수락 대기")
  );
}

function hasConfirmedContractCard(xml) {
  return (
    xml.includes("예약 확정") ||
    xml.includes("계약 확정") ||
    xml.includes("확정") ||
    xml.includes("이용 예정") ||
    xml.includes("입주 예정")
  );
}

function findContractRequestCardAction(xml) {
  const statusCard = findNode(xml, ["계약 요청", "요청 중", "요청중", "수락 대기"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (statusCard?.bounds) return statusCard;

  return findNode(xml, ["계약 확인", "상세 보기", "상세"], {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function findConfirmedContractCardAction(xml) {
  const statusCard = findNode(xml, ["예약 확정", "계약 확정", "확정", "이용 예정", "입주 예정"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (statusCard?.bounds) return statusCard;

  return findNode(xml, ["계약 확인", "예약 확인", "상세 보기", "상세"], {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function isContractDetail(xml) {
  return (
    (
      xml.includes("계약번호:") ||
      xml.includes("계약 요청") ||
      xml.includes("계약 상세")
    ) &&
    xml.includes("계약 취소")
  );
}

function isCancelConfirmPopup(xml) {
  return xml.includes("계약을 취소하시겠어요") && xml.includes("계약 취소");
}

function isCancelReasonScreen(xml) {
  return (
    xml.includes("계약 취소") &&
    (
      xml.includes("취소 사유") ||
      xml.includes("취소 이유") ||
      xml.includes("계약을 취소")
    )
  );
}

function isConfirmedCancelReasonScreen(xml) {
  return (
    xml.includes("호스트가 이해할수있도록 취소사유를 전달해주세요") ||
    xml.includes("호스트가 이해할 수 있도록 취소사유를 전달해주세요") ||
    xml.includes("호스트가 이해할 수 있도록") ||
    isCancelReasonScreen(xml)
  );
}

function isCancelReviewScreen(xml) {
  return (
    xml.includes("취소 내역을 확인해주세요") ||
    xml.includes("취소 내역을 확인해 주세요")
  );
}

function isCancelComplete(xml) {
  return (
    xml.includes("취소 완료") ||
    xml.includes("취소되었습니다") ||
    xml.includes("취소가 완료") ||
    xml.includes("취소가 완료되었습니다")
  );
}

function isLiveAnywhereFeedbackScreen(xml) {
  return (
    xml.includes("리브애니웨어에게 취소사유를 전달해주세요") ||
    xml.includes("리브애니웨어에게 취소 사유를 전달해주세요") ||
    xml.includes("취소사유를 전달해주세요")
  );
}

function hasCancelError(xml) {
  return [
    "오류가 발생했습니다",
    "일시적인 오류가 발생했습니다",
    "다시 시도"
  ].some((text) => xml.includes(text));
}

async function openContractRequestDetailFromHome(config, device, store, steps, env) {
  let xml = await waitForUi(
    config,
    device,
    (nextXml) => hasHomeSearchBar(nextXml) || hasContractRequestCard(nextXml) || isLoginStartScreen(nextXml),
    12000
  );
  saveXml(store, "cancel-request-home-before-refresh", xml);

  if (isLoginStartScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-request-login-required", xml);
    fail(
      "게스트가 로그아웃된 상태라 계약 요청 취소를 시작할 수 없습니다.",
      steps,
      [
        `먼저 !게스트 로그인 ${env === "dev" ? "dev" : "stg"} 명령어로 게스트 로그인을 완료해주세요.`,
        "계약 요청 취소는 로그인 상태의 홈 화면에서 계약 요청 상태 카드가 보여야 합니다.",
        "리포트의 cancel-request-login-required.png 화면을 확인해주세요."
      ]
    );
  }

  if (!hasContractRequestCard(xml)) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    addStep(steps, "홈 화면 풀 리프레시");
    xml = await waitForUi(config, device, hasContractRequestCard, 7000);
  } else {
    addStep(steps, "홈 화면 계약 요청 카드 즉시 확인", "pass", "리프레시 없이 카드가 이미 보이는 상태");
  }
  saveXml(store, "cancel-request-home-after-refresh", xml);

  if (!hasContractRequestCard(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-request-card-not-found", xml);
    fail(
      "홈 화면에서 계약 요청 상태 카드를 찾지 못했습니다.",
      steps,
      [
        "홈 화면에서 '계약 요청', '요청 중', '수락 대기' 상태 문구가 있는 카드를 찾습니다.",
        "취소 가능한 계약 요청 건이 생성되어 있는지 확인해주세요.",
        "리포트의 cancel-request-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const action = findContractRequestCardAction(xml);
  if (!action?.bounds) {
    await saveFailureArtifacts(config, device, store, "cancel-request-card-action-not-found", xml);
    fail(
      "계약 요청 카드에서 상세 진입 버튼을 찾지 못했습니다.",
      steps,
      [
        "계약 요청 상태 문구는 보이지만 실제로 누를 수 있는 카드 영역을 찾지 못했습니다.",
        "리포트의 cancel-request-card-action-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, action, "계약 요청 카드", steps);
  addStep(steps, "홈 화면 계약 요청 카드 선택");

  xml = await waitForUi(config, device, isContractDetail, 12000);
  saveXml(store, "cancel-request-detail-start", xml);
  if (!isContractDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-request-detail-not-found", xml);
    fail(
      "계약 요청 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "계약 요청 카드를 눌렀지만 계약 취소 버튼이 있는 상세 화면을 확인하지 못했습니다.",
        "리포트의 cancel-request-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function openConfirmedContractDetailFromHome(config, device, store, steps, env) {
  let xml = await waitForUi(
    config,
    device,
    (nextXml) => hasHomeSearchBar(nextXml) || hasConfirmedContractCard(nextXml) || isLoginStartScreen(nextXml),
    12000
  );
  saveXml(store, "cancel-confirmed-home-before-refresh", xml);

  if (isLoginStartScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-login-required", xml);
    fail(
      "게스트가 로그아웃된 상태라 예약 확정 취소를 시작할 수 없습니다.",
      steps,
      [
        `먼저 !게스트 로그인 ${env === "dev" ? "dev" : "stg"} 명령어로 게스트 로그인을 완료해주세요.`,
        "예약 확정 취소는 로그인 상태의 홈 화면에서 확정 상태 카드가 보여야 합니다.",
        "리포트의 cancel-confirmed-login-required.png 화면을 확인해주세요."
      ]
    );
  }

  if (!hasConfirmedContractCard(xml)) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    addStep(steps, "홈 화면 풀 리프레시");
    xml = await waitForUi(config, device, hasConfirmedContractCard, 7000);
  } else {
    addStep(steps, "홈 화면 예약 확정 카드 즉시 확인", "pass", "리프레시 없이 카드가 이미 보이는 상태");
  }
  saveXml(store, "cancel-confirmed-home-after-refresh", xml);

  if (!hasConfirmedContractCard(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-card-not-found", xml);
    fail(
      "홈 화면에서 예약 확정 상태 카드를 찾지 못했습니다.",
      steps,
      [
        "홈 화면에서 '예약 확정', '계약 확정', '이용 예정', '입주 예정' 상태 문구가 있는 카드를 찾습니다.",
        "취소 가능한 확정 계약 건이 있는지 확인해주세요.",
        "리포트의 cancel-confirmed-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const action = findConfirmedContractCardAction(xml);
  if (!action?.bounds) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-card-action-not-found", xml);
    fail(
      "예약 확정 카드에서 상세 진입 버튼을 찾지 못했습니다.",
      steps,
      [
        "확정 상태 문구는 보이지만 실제로 누를 수 있는 카드 영역을 찾지 못했습니다.",
        "리포트의 cancel-confirmed-card-action-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, action, "예약 확정 카드", steps);
  addStep(steps, "홈 화면 예약 확정 카드 선택");

  xml = await waitForUi(config, device, isContractDetail, 12000);
  saveXml(store, "cancel-confirmed-detail-start", xml);
  if (!isContractDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-detail-not-found", xml);
    fail(
      "예약 확정 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "예약 확정 카드를 눌렀지만 계약 취소 버튼이 있는 상세 화면을 확인하지 못했습니다.",
        "리포트의 cancel-confirmed-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function tapCancelButtonAtBottom(config, device, store, steps, initialXml) {
  let xml = initialXml;

  for (let count = 0; count < 12; count += 1) {
    const cancelButton = findNode(xml, "계약 취소", {
      visible: true,
      clickable: true,
      enabled: true
    });
    if (cancelButton?.bounds && cancelButton.bounds.top > 400) {
      saveXml(store, "cancel-request-cancel-button", xml);
      await tapNode(config, device, cancelButton, "계약 취소 버튼", steps);
      addStep(steps, "계약 상세 하단 계약 취소 버튼 선택");
      return waitForUi(config, device, isCancelReasonScreen, 10000);
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "430", "260"]);
    await new Promise((resolve) => setTimeout(resolve, 160));
    xml = await dumpUi(config, device);
  }

  await saveFailureArtifacts(config, device, store, "cancel-request-button-not-found", xml);
  fail(
    "계약 상세 화면 하단에서 계약 취소 버튼을 찾지 못했습니다.",
    steps,
    [
      "계약 상세 화면을 최하단까지 빠르게 스크롤하며 실제 클릭 가능한 '계약 취소' 버튼을 찾습니다.",
      "리포트의 cancel-request-button-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function tapConfirmedCancelButtonAtBottom(config, device, store, steps, initialXml) {
  let xml = await tapCancelButtonAtBottom(config, device, store, steps, initialXml);

  if (!isCancelConfirmPopup(xml)) {
    xml = await waitForUi(config, device, isCancelConfirmPopup, 6000);
  }
  saveXml(store, "cancel-confirmed-confirm-popup", xml);

  if (!isCancelConfirmPopup(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-confirm-popup-not-found", xml);
    fail(
      "계약 취소 확인 팝업을 찾지 못했습니다.",
      steps,
      [
        "확정 계약 취소는 하단 계약 취소 버튼을 누른 뒤 '계약을 취소하시겠어요?' 팝업이 떠야 합니다.",
        "리포트의 cancel-confirmed-confirm-popup-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const buttons = parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        label.includes("계약 취소")
      );
    })
    .sort((a, b) => b.bounds.top - a.bounds.top);
  const confirmButton = buttons[0];
  if (!confirmButton?.bounds) {
    const screen = getScreenBounds(xml);
    const popupTextOnlyNode = xml.includes("계약을 취소하시겠어요") &&
      xml.includes("아니요") &&
      xml.includes("계약 취소");

    if (!screen || !popupTextOnlyNode) {
      await saveFailureArtifacts(config, device, store, "cancel-confirmed-confirm-button-not-found", xml);
      fail(
        "계약 취소 확인 팝업에서 계약 취소 버튼을 찾지 못했습니다.",
        steps,
        [
          "팝업에서는 확인된 '계약 취소' 버튼만 누릅니다.",
          "리포트의 cancel-confirmed-confirm-button-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    const x = Math.round(screen.right * 0.69);
    const y = Math.round(screen.bottom * 0.61);
    await tap(config, device, x, y);
    addStep(steps, "계약 취소 확인 팝업 계약 취소 선택", "pass", "팝업 버튼이 XML 노드로 분리되지 않아 오른쪽 버튼 위치를 탭");
    return waitForUi(config, device, isConfirmedCancelReasonScreen, 10000);
  }

  await tapNode(config, device, confirmButton, "팝업 계약 취소 버튼", steps);
  addStep(steps, "계약 취소 확인 팝업 계약 취소 선택");
  return waitForUi(config, device, isConfirmedCancelReasonScreen, 10000);
}

function chooseCancelReason(xml) {
  const excludedLabels = ["기타"];
  const reasonNodes = parseNodes(xml).filter((node) => {
    if (!node.bounds || !isVisibleNode(node)) return false;
    if (node.attrs.enabled !== "true") return false;

    const label = nodeLabel(node).trim();
    if (!label || excludedLabels.some((excluded) => label.includes(excluded))) return false;
    if (label.includes("계약 취소") || label.includes("취소 사유") || label.includes("취소 이유")) return false;
    if (label.length > 80) return false;

    return (
      node.attrs.clickable === "true" ||
      node.attrs.class?.includes("Button") ||
      node.attrs.class?.includes("TextView")
    );
  });

  const uniqueReasons = [];
  for (const node of reasonNodes) {
    const label = nodeLabel(node).trim();
    if (uniqueReasons.some((item) => item.label === label)) continue;
    uniqueReasons.push({ label, node });
  }

  const candidates = uniqueReasons.slice(0, 4);
  if (!candidates.length) return null;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function findFinalCancelButton(xml) {
  const buttons = parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        label.includes("계약 취소")
      );
    })
    .sort((a, b) => b.bounds.top - a.bounds.top);

  return buttons[0];
}

function findNextButton(xml) {
  const buttons = parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node).trim();
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        label.includes("다음")
      );
    })
    .sort((a, b) => b.bounds.top - a.bounds.top);
  return buttons[0];
}

function findVisibleEnabledButton(xml, labels) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const buttons = parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        labelList.some((value) => label.includes(value))
      );
    })
    .sort((a, b) => b.bounds.top - a.bounds.top);
  return buttons[0];
}

async function selectReasonAndSubmit(config, device, store, steps, initialXml) {
  let xml = isCancelReasonScreen(initialXml)
    ? initialXml
    : await waitForUi(config, device, isCancelReasonScreen, 10000);
  saveXml(store, "cancel-request-reason-start", xml);

  if (!isCancelReasonScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-request-reason-not-found", xml);
    fail(
      "계약 취소 상세 화면을 확인하지 못했습니다.",
      steps,
      [
        "계약 취소 버튼을 누른 뒤 취소 사유를 선택하는 화면이 보여야 합니다.",
        "리포트의 cancel-request-reason-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const reason = chooseCancelReason(xml);
  if (!reason?.node?.bounds) {
    await saveFailureArtifacts(config, device, store, "cancel-request-reason-option-not-found", xml);
    fail(
      "계약 취소 사유 항목을 찾지 못했습니다.",
      steps,
      [
        "취소 사유 5개 중 '기타'를 제외한 4개 항목 중 하나를 선택해야 합니다.",
        "리포트의 cancel-request-reason-option-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, reason.node.bounds.x, reason.node.bounds.y);
  addStep(steps, "계약 취소 사유 선택", "pass", reason.label);
  await new Promise((resolve) => setTimeout(resolve, 400));
  xml = await dumpUi(config, device);
  saveXml(store, "cancel-request-reason-selected", xml);

  const cancelButton = findFinalCancelButton(xml);
  if (!cancelButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "cancel-request-submit-disabled", xml);
    fail(
      "계약 취소 버튼이 활성화되지 않았습니다.",
      steps,
      [
        "취소 사유를 선택하면 하단 '계약 취소' 버튼이 활성화되어야 합니다.",
        "리포트의 cancel-request-submit-disabled.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, cancelButton, "활성화된 계약 취소 버튼", steps);
  addStep(steps, "활성화된 계약 취소 버튼 선택");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => isCancelComplete(nextXml) || hasHomeSearchBar(nextXml) || hasCancelError(nextXml),
    12000
  );
  saveXml(store, "cancel-request-after-submit", xml);

  if (hasCancelError(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-request-after-submit", xml);
    fail(
      "계약 요청 취소 중 앱 오류가 발생했습니다.",
      steps,
      [
        "계약 취소 버튼을 누른 뒤 앱 오류 메시지가 노출되었습니다.",
        "리포트의 cancel-request-after-submit.png 화면을 확인해주세요."
      ]
    );
  }

  if (!isCancelComplete(xml) && !hasHomeSearchBar(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-request-after-submit", xml);
    fail(
      "계약 요청 취소 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        "계약 취소 버튼을 누른 뒤 취소 완료 화면 또는 홈 화면 복귀 상태가 확인되어야 합니다.",
        "리포트의 cancel-request-after-submit.png 화면을 확인해주세요."
      ]
    );
  }

  return { xml, reason: reason.label };
}

async function selectConfirmedCancelReasonAndNext(config, device, store, steps, initialXml) {
  let xml = isConfirmedCancelReasonScreen(initialXml)
    ? initialXml
    : await waitForUi(config, device, isConfirmedCancelReasonScreen, 10000);
  saveXml(store, "cancel-confirmed-reason-start", xml);

  if (!isConfirmedCancelReasonScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-reason-not-found", xml);
    fail(
      "호스트에게 전달할 취소 사유 선택 화면을 확인하지 못했습니다.",
      steps,
      [
        "계약 취소 확인 팝업 이후 '호스트가 이해할수있도록 취소사유를 전달해주세요' 화면이 보여야 합니다.",
        "리포트의 cancel-confirmed-reason-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const reason = chooseCancelReason(xml);
  if (!reason?.node?.bounds) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-reason-option-not-found", xml);
    fail(
      "예약 확정 취소 사유 항목을 찾지 못했습니다.",
      steps,
      [
        "취소 사유 5개 중 '기타'를 제외한 4개 항목 중 하나를 선택해야 합니다.",
        "리포트의 cancel-confirmed-reason-option-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, reason.node.bounds.x, reason.node.bounds.y);
  addStep(steps, "호스트 전달 취소 사유 선택", "pass", reason.label);
  await new Promise((resolve) => setTimeout(resolve, 400));
  xml = await dumpUi(config, device);
  saveXml(store, "cancel-confirmed-reason-selected", xml);

  const nextButton = findNextButton(xml);
  if (!nextButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-next-disabled", xml);
    fail(
      "취소 사유 선택 후 다음 버튼이 활성화되지 않았습니다.",
      steps,
      [
        "취소 사유를 선택하면 하단 '다음' 버튼이 활성화되어야 합니다.",
        "리포트의 cancel-confirmed-next-disabled.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, nextButton, "활성화된 다음 버튼", steps);
  addStep(steps, "활성화된 다음 버튼 선택");
  return {
    reason: reason.label,
    xml: await waitForUi(config, device, isCancelReviewScreen, 10000)
  };
}

async function confirmCancelReviewAndSubmit(config, device, store, steps, initialXml) {
  let xml = isCancelReviewScreen(initialXml)
    ? initialXml
    : await waitForUi(config, device, isCancelReviewScreen, 10000);
  saveXml(store, "cancel-confirmed-review-start", xml);

  if (!isCancelReviewScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-review-not-found", xml);
    fail(
      "취소 내역 확인 화면을 확인하지 못했습니다.",
      steps,
      [
        "다음 버튼을 누른 뒤 '취소 내역을 확인해주세요.' 화면이 보여야 합니다.",
        "리포트의 cancel-confirmed-review-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  for (let count = 0; count < 12; count += 1) {
    const confirmCheck = findNode(xml, ["위 내용을 모두 확인하였습니다", "모두 확인하였습니다"], {
      visible: true,
      enabled: true
    });
    const cancelButton = findVisibleEnabledButton(xml, "취소하기");

    if (confirmCheck?.bounds && cancelButton?.bounds) {
      saveXml(store, "cancel-confirmed-review-bottom", xml);
      await tap(config, device, confirmCheck.bounds.x, confirmCheck.bounds.y);
      addStep(steps, "취소 내역 모두 확인 선택");
      await new Promise((resolve) => setTimeout(resolve, 300));
      xml = await dumpUi(config, device);

      const enabledCancelButton = findVisibleEnabledButton(xml, "취소하기") || cancelButton;
      await tapNode(config, device, enabledCancelButton, "취소하기 버튼", steps);
      addStep(steps, "취소하기 버튼 선택");
      return waitForUi(config, device, (nextXml) => isCancelComplete(nextXml) || hasCancelError(nextXml), 12000);
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "500", "240"]);
    await new Promise((resolve) => setTimeout(resolve, 160));
    xml = await dumpUi(config, device);
  }

  await saveFailureArtifacts(config, device, store, "cancel-confirmed-review-bottom-not-found", xml);
  fail(
    "취소 내역 확인 화면 하단에서 확인 체크 또는 취소하기 버튼을 찾지 못했습니다.",
    steps,
    [
      "취소 내역 화면 최하단에서 '위 내용을 모두 확인하였습니다'를 선택한 뒤 '취소하기' 버튼을 눌러야 합니다.",
      "리포트의 cancel-confirmed-review-bottom-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function closeCompleteAndFeedback(config, device, store, steps, initialXml) {
  let xml = isCancelComplete(initialXml)
    ? initialXml
    : await waitForUi(config, device, isCancelComplete, 10000);
  saveXml(store, "cancel-confirmed-complete-popup", xml);

  if (!isCancelComplete(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-complete-not-found", xml);
    fail(
      "취소 완료 팝업을 확인하지 못했습니다.",
      steps,
      [
        "취소하기 버튼을 누른 뒤 '취소가 완료되었습니다!' 팝업이 보여야 합니다.",
        "리포트의 cancel-confirmed-complete-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const okButton = findVisibleEnabledButton(xml, ["확인", "OK"]);
  if (!okButton?.bounds) {
    const screen = getScreenBounds(xml);
    const completeTextOnlyNode = xml.includes("취소가 완료되었습니다") && xml.includes("확인");

    if (!screen || !completeTextOnlyNode) {
      await saveFailureArtifacts(config, device, store, "cancel-confirmed-complete-ok-not-found", xml);
      fail(
        "취소 완료 팝업에서 확인 버튼을 찾지 못했습니다.",
        steps,
        [
          "완료 팝업에서는 확인된 '확인' 버튼만 누릅니다.",
          "리포트의 cancel-confirmed-complete-ok-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    const x = Math.round(screen.right * 0.5);
    const y = Math.round(screen.bottom * 0.615);
    await tap(config, device, x, y);
    addStep(steps, "취소 완료 팝업 확인 선택", "pass", "팝업 버튼이 XML 노드로 분리되지 않아 하단 확인 버튼 위치를 탭");
  } else {
    await tapNode(config, device, okButton, "취소 완료 팝업 확인 버튼", steps);
    addStep(steps, "취소 완료 팝업 확인 선택");
  }

  xml = await waitForUi(
    config,
    device,
    (nextXml) => isLiveAnywhereFeedbackScreen(nextXml) || hasHomeSearchBar(nextXml),
    10000
  );
  saveXml(store, "cancel-confirmed-feedback", xml);

  if (isLiveAnywhereFeedbackScreen(xml)) {
    const closeButton =
      findNode(xml, ["닫기", "close", "Close", "×", "X"], {
        visible: true,
        clickable: true,
        enabled: true
      });

    if (closeButton?.bounds) {
      await tapNode(config, device, closeButton, "취소 사유 전달 화면 닫기 버튼", steps);
    } else {
      await tap(config, device, 1000, 160);
    }
    addStep(steps, "리브애니웨어 취소 사유 전달 화면 닫기");
  }

  xml = await waitForUi(config, device, hasHomeSearchBar, 10000);
  saveXml(store, "cancel-confirmed-final-home", xml);
  if (!hasHomeSearchBar(xml)) {
    await saveFailureArtifacts(config, device, store, "cancel-confirmed-final-home", xml);
    fail(
      "예약 확정 취소 후 홈 화면 진입을 확인하지 못했습니다.",
      steps,
      [
        "취소 완료 팝업 확인 후 리브애니웨어 취소 사유 전달 화면을 닫으면 홈 화면이 보여야 합니다.",
        "리포트의 cancel-confirmed-final-home.png 화면을 확인해주세요."
      ]
    );
  }
}

async function runContractCancelRequestTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("계약 요청 취소는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    let xml = await openContractRequestDetailFromHome(config, device, store, steps, env);
    xml = await tapCancelButtonAtBottom(config, device, store, steps, xml);
    const { reason } = await selectReasonAndSubmit(config, device, store, steps, xml);
    addStep(steps, "계약 요청 취소 완료 확인");

    return {
      test_id: "TC-CONTRACT-CANCEL-REQUEST-001",
      name: "guest 계약 요청 취소",
      env,
      status: "pass",
      device,
      steps,
      cancel_conditions: {
        type: "계약 요청 취소",
        reason
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "cancel-request-home-after-refresh.xml"),
          path.join(store.logsDir, "cancel-request-detail-start.xml"),
          path.join(store.logsDir, "cancel-request-cancel-button.xml"),
          path.join(store.logsDir, "cancel-request-reason-selected.xml"),
          path.join(store.logsDir, "cancel-request-after-submit.xml")
        ]
      }
    };
  });
}

async function runContractCancelConfirmedTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("예약 확정 취소는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    let xml = await openConfirmedContractDetailFromHome(config, device, store, steps, env);
    xml = await tapConfirmedCancelButtonAtBottom(config, device, store, steps, xml);
    const reasonResult = await selectConfirmedCancelReasonAndNext(config, device, store, steps, xml);
    xml = await confirmCancelReviewAndSubmit(config, device, store, steps, reasonResult.xml);
    await closeCompleteAndFeedback(config, device, store, steps, xml);
    addStep(steps, "예약 확정 취소 완료 및 홈 화면 진입 확인");

    return {
      test_id: "TC-CONTRACT-CANCEL-CONFIRMED-001",
      name: "guest 예약 확정 취소",
      env,
      status: "pass",
      device,
      steps,
      cancel_conditions: {
        type: "예약 확정 취소",
        reason: reasonResult.reason
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "cancel-confirmed-home-after-refresh.xml"),
          path.join(store.logsDir, "cancel-confirmed-detail-start.xml"),
          path.join(store.logsDir, "cancel-confirmed-confirm-popup.xml"),
          path.join(store.logsDir, "cancel-confirmed-reason-selected.xml"),
          path.join(store.logsDir, "cancel-confirmed-review-bottom.xml"),
          path.join(store.logsDir, "cancel-confirmed-complete-popup.xml"),
          path.join(store.logsDir, "cancel-confirmed-final-home.xml")
        ]
      }
    };
  });
}

module.exports = {
  runContractCancelConfirmedTest,
  runContractCancelRequestTest
};
