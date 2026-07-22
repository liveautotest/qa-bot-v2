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

function decodeXmlValue(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
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

function labelOf(node) {
  return `${node.attrs.text || ""}\n${node.attrs["content-desc"] || ""}`;
}

function findNode(xml, label, options = {}) {
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visibleOnly && (node.bounds.bottom <= 0 || node.bounds.top >= 2496)) {
      return false;
    }
    return labelOf(node).includes(label);
  });
  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function findBottomTab(xml, label) {
  return parseNodes(xml).find((node) => {
    if (!node.bounds || node.bounds.top < 2200) return false;
    return labelOf(node).includes(label);
  });
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return xml;
}

function isHostModeShell(xml) {
  return ["집 목록", "계약", "메시지", "내 정보"].filter((label) => findBottomTab(xml, label)).length >= 3;
}

function isHostContractList(xml) {
  return xml.includes("계약 관리") && xml.includes("계약 요청") && xml.includes("최근 계약 요청일 순");
}

function isContractRequestDetail(xml) {
  return xml.includes("계약 번호:") && xml.includes("수락해주세요") && xml.includes("계약 수락");
}

function hasAcceptConfirmDialog(xml) {
  return (
    xml.includes("계약 내역을 확인하셨나요?") ||
    xml.includes("더블부킹") ||
    xml.includes("일방적인 계약 취소")
  );
}

function hasAcceptedSuccessDialog(xml) {
  return xml.includes("수락됐습니다.");
}

function isContractAccepted(xml) {
  return (
    !hasAcceptConfirmDialog(xml) &&
    !hasAcceptedSuccessDialog(xml) &&
    !xml.includes("계약 수락") &&
    !xml.includes("수락해주세요") &&
    (
      xml.includes("결제를 기다리고 있어요") ||
      xml.includes("결제 대기") ||
      xml.includes("계약 진행") ||
      xml.includes("계약 확정")
    )
  );
}

function getContractNumber(xml) {
  const match = xml.match(/계약 번호:\s*(\d+)/);
  return match ? match[1] : "";
}

function findRequestCard(xml) {
  return parseNodes(xml).find((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    const label = labelOf(node);
    return (
      label.includes("계약 요청") &&
      label.includes("계약 번호:") &&
      node.bounds.top >= 600 &&
      node.bounds.top < 2200
    );
  });
}

function findAcceptButton(xml, { dialogOnly = false } = {}) {
  const matches = parseNodes(xml).filter((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    if (!labelOf(node).includes("계약 수락")) return false;
    if (node.bounds.bottom <= 0 || node.bounds.top >= 2496) return false;
    return dialogOnly
      ? node.bounds.top >= 1200 && node.bounds.bottom <= 1800
      : true;
  });

  return (dialogOnly ? matches[0] : matches[matches.length - 1]) || null;
}

async function launchApp(config, device, appPackage, steps) {
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

async function openHostContractList(config, device, store, steps) {
  let xml = await waitForUi(config, device, (nextXml) => isHostModeShell(nextXml), 15000);
  saveXml(store, "host-approve-after-launch", xml);

  if (!isHostModeShell(xml)) {
    await saveFailureArtifacts(config, device, store, "host-mode-not-found", xml);
    fail(
      "호스트모드 하단 탭을 찾지 못해서 계약 승인 화면으로 이동하지 못했습니다.",
      steps,
      [
        "호스트 계정으로 로그인되어 있고 호스트모드에 진입된 상태여야 합니다.",
        "먼저 !호스트 로그인 명령이 PASS 되는지 확인해주세요."
      ]
    );
  }

  if (!isHostContractList(xml)) {
    const contractTab = findBottomTab(xml, "계약");
    if (!contractTab?.bounds) {
      await saveFailureArtifacts(config, device, store, "host-contract-tab-not-found", xml);
      fail("호스트모드 하단 계약 탭을 찾지 못했습니다.", steps);
    }

    await tap(config, device, contractTab.bounds.x, contractTab.bounds.y);
    addStep(steps, "호스트 계약 탭 진입");
    xml = await waitForUi(config, device, isHostContractList, 12000);
  }

  saveXml(store, "host-contract-list", xml);
  if (!isHostContractList(xml)) {
    await saveFailureArtifacts(config, device, store, "host-contract-list-not-found", xml);
    fail(
      "호스트 계약 관리 목록을 확인하지 못했습니다.",
      steps,
      [
        "계약 탭을 눌렀지만 '계약 관리', '계약 요청', '최근 계약 요청일 순' 문구가 동시에 확인되지 않았습니다.",
        "리포트의 host-contract-list-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function openLatestContractRequest(config, device, store, steps, xml) {
  let requestCard = findRequestCard(xml);

  if (!requestCard) {
    const requestFilter = findNode(xml, "계약 요청", { visibleOnly: true });
    if (requestFilter?.bounds) {
      await tap(config, device, requestFilter.bounds.x, requestFilter.bounds.y);
      addStep(steps, "계약 요청 필터 선택");
      xml = await waitForUi(config, device, (nextXml) => Boolean(findRequestCard(nextXml)), 8000);
      saveXml(store, "host-contract-request-list", xml);
      requestCard = findRequestCard(xml);
    }
  }

  if (!requestCard?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-request-card-not-found", xml);
    fail(
      "승인할 계약 요청 건을 찾지 못했습니다.",
      steps,
      [
        "호스트 계약 관리 목록에서 '계약 요청' 상태와 '계약 번호'가 있는 카드를 찾습니다.",
        "현재 승인 가능한 요청 건이 없거나, 목록 정렬/필터 상태가 예상과 다를 수 있습니다.",
        "리포트의 contract-request-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const contractNumber = getContractNumber(labelOf(requestCard));
  await tap(config, device, requestCard.bounds.x, requestCard.bounds.y);
  addStep(steps, "계약 요청 건 상세 진입", "pass", contractNumber ? `계약 번호 ${contractNumber}` : undefined);

  xml = await waitForUi(config, device, isContractRequestDetail, 12000);
  saveXml(store, "contract-approve-detail", xml);

  if (!isContractRequestDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-approve-detail-not-found", xml);
    fail(
      "계약 요청 상세 화면에서 계약 수락 버튼을 찾지 못했습니다.",
      steps,
      [
        "계약 요청 카드를 눌렀지만 상세 화면의 '계약 수락' 버튼이 확인되지 않았습니다.",
        "이미 처리된 계약이거나 상세 화면 구조가 바뀌었을 수 있습니다.",
        "리포트의 contract-approve-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return { xml, contractNumber: getContractNumber(xml) || contractNumber };
}

async function tapAcceptAndConfirm(config, device, store, steps, xml) {
  const acceptButton = findAcceptButton(xml);
  if (!acceptButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-accept-button-not-found", xml);
    fail("계약 상세 화면에서 '계약 수락' 버튼을 찾지 못했습니다.", steps);
  }

  await tap(config, device, acceptButton.bounds.x, acceptButton.bounds.y);
  addStep(steps, "계약 수락 버튼 탭");

  xml = await waitForUi(
    config,
    device,
    (nextXml) =>
      isContractAccepted(nextXml) ||
      hasAcceptConfirmDialog(nextXml),
    8000
  );
  saveXml(store, "contract-approve-after-tap", xml);

  if (hasAcceptConfirmDialog(xml)) {
    const confirmButton = findAcceptButton(xml, { dialogOnly: true });

    if (confirmButton?.bounds) {
      await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
      addStep(steps, "계약 수락 확인 버튼 탭");
      xml = await waitForUi(
        config,
        device,
        (nextXml) => hasAcceptedSuccessDialog(nextXml) || isContractAccepted(nextXml),
        15000
      );
    } else {
      await saveFailureArtifacts(config, device, store, "contract-accept-confirm-button-not-found", xml);
      fail(
        "계약 수락 확인 팝업은 떴지만 팝업 안의 계약 수락 버튼을 찾지 못했습니다.",
        steps,
        [
          "팝업 문구 '계약 내역을 확인하셨나요?'는 확인됐습니다.",
          "팝업 하단의 파란 '계약 수락' 버튼 좌표를 찾지 못했습니다.",
          "리포트의 contract-accept-confirm-button-not-found.png 화면을 확인해주세요."
        ]
      );
    }
  }

  if (hasAcceptedSuccessDialog(xml)) {
    const doneButton = findNode(xml, "확인", { visibleOnly: true });
    if (!doneButton?.bounds) {
      await saveFailureArtifacts(config, device, store, "contract-accepted-confirm-button-not-found", xml);
      fail(
        "계약 수락 완료 팝업은 떴지만 확인 버튼을 찾지 못했습니다.",
        steps,
        [
          "팝업 문구 '수락됐습니다.'는 확인됐습니다.",
          "팝업의 '확인' 버튼 좌표를 찾지 못했습니다.",
          "리포트의 contract-accepted-confirm-button-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    await tap(config, device, doneButton.bounds.x, doneButton.bounds.y);
    addStep(steps, "계약 수락 완료 팝업 확인");
    xml = await waitForUi(config, device, isContractAccepted, 12000);
  }

  saveXml(store, "contract-approve-final", xml);
  if (!isContractAccepted(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-approve-final", xml);
    fail(
      "계약 수락 후 승인 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        "계약 수락 버튼을 눌렀지만 '결제를 기다리고 있어요', '계약 진행 중', '결제 대기', '계약 확정' 등 승인 후 상태가 확인되지 않았습니다.",
        "확인 팝업 버튼 문구가 예상과 다르거나 앱 오류가 발생했을 수 있습니다.",
        "리포트의 contract-approve-final.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function runContractApproveTest({ request, config, store }) {
  const role = request.role || "host";
  const env = request.env || "staging";
  const device = config.devices.host || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "host") {
    throw new Error("계약 승인은 host role에서만 실행할 수 있습니다.");
  }
  if (!device) throw new Error("Missing device id for role: host");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await keyEvent(config, device, 224);
    await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch(() => {});
    addStep(steps, "단말 깨우기 및 잠금 해제 시도");

    await launchApp(config, device, appPackage, steps);

    let xml = await openHostContractList(config, device, store, steps);
    const detail = await openLatestContractRequest(config, device, store, steps, xml);
    xml = await tapAcceptAndConfirm(config, device, store, steps, detail.xml);

    addStep(steps, "계약 승인 완료 확인");

    return {
      test_id: "TC-CONTRACT-APPROVE-001",
      name: "host 계약 승인",
      env,
      status: "pass",
      device,
      steps,
      approved_contract: {
        contract_number: detail.contractNumber || getContractNumber(xml) || ""
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "host-contract-list.xml"),
          path.join(store.logsDir, "contract-approve-detail.xml"),
          path.join(store.logsDir, "contract-approve-final.xml")
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

module.exports = {
  runContractApproveTest
};
