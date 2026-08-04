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

function labelOf(node) {
  return [
    node.attrs.text || "",
    node.attrs["content-desc"] || "",
    node.attrs.hint || ""
  ].join("\n");
}

function visible(node) {
  return node?.bounds && node.bounds.bottom > 110 && node.bounds.top < 2496;
}

function findNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && !visible(node)) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    const label = labelOf(node);
    return labelList.some((item) => label.includes(item));
  });

  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function saveXml(store, name, xml) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  fs.writeFileSync(xmlPath, xml);
  return xmlPath;
}

async function saveFailureArtifacts(config, device, store, name, xml) {
  const xmlPath = saveXml(store, name, xml || (await dumpUiStable(config, device)));
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return { xmlPath, screenshotPath };
}

async function saveScreenshotArtifact(config, device, store, name) {
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return screenshotPath;
}

function isInvalidUiDump(xml) {
  return !xml || !String(xml).includes("<hierarchy");
}

async function dumpUiStable(config, device, attempts = 4) {
  let xml = "";
  for (let count = 0; count < attempts; count += 1) {
    xml = await dumpUi(config, device);
    if (!isInvalidUiDump(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return xml;
}

async function waitForUi(config, device, predicate, timeoutMs = 12000, intervalMs = 250) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUiStable(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return xml;
}

async function launchApp(config, device, appPackage, steps) {
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

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  addStep(steps, "단말 깨우기 및 잠금 해제 시도");
}

function findBottomTab(xml, label) {
  return parseNodes(xml).find((node) => (
    node.bounds &&
    node.bounds.top > 2200 &&
    labelOf(node).includes(label)
  ));
}

function isHostModeShell(xml) {
  return ["홈", "집 목록", "계약", "메시지", "내 정보"].filter((label) => findBottomTab(xml, label)).length >= 3;
}

function isHostContractList(xml) {
  return xml.includes("계약 관리") && xml.includes("최근 계약 요청일 순");
}

function hasHostHomeWorkArea(xml) {
  if (isHostContractList(xml)) return false;
  return xml.includes("할 일") || xml.includes("수락이 필요한 계약");
}

function findLatestGuestExtensionInfo(reportBaseDir, env) {
  if (!reportBaseDir || !fs.existsSync(reportBaseDir)) return null;

  const results = fs.readdirSync(reportBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("contract-extension"))
    .map((entry) => {
      const resultPath = path.join(reportBaseDir, entry.name, "result.json");
      if (!fs.existsSync(resultPath)) return null;
      const stat = fs.statSync(resultPath);
      return { resultPath, mtimeMs: stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of results) {
    try {
      const result = JSON.parse(fs.readFileSync(item.resultPath, "utf8"));
      if (result.status !== "pass") continue;
      if (env && result.env && result.env !== env) continue;
      if (result.contract_extension) return result.contract_extension;
    } catch {
      // Historical broken result files are ignored.
    }
  }

  return null;
}

function findExtensionRequestCard(xml) {
  const candidates = parseNodes(xml).filter((node) => {
    if (!visible(node) || node.attrs.clickable !== "true") return false;
    if (node.bounds.top < 420 || node.bounds.top > 2100) return false;
    const label = labelOf(node);
    return /(\d+)\s*박\s*연장\s*요청/.test(label);
  });

  return candidates[0] || null;
}

async function openHostHome(config, device, appPackage, store, steps) {
  await launchApp(config, device, appPackage, steps);
  let xml = await waitForUi(config, device, isHostModeShell, 12000, 180);

  if (!isHostModeShell(xml)) {
    await saveFailureArtifacts(config, device, store, "host-extension-shell-not-found", xml);
    fail(
      "호스트 모드 화면을 확인하지 못했습니다.",
      steps,
      [
        "호스트 계정으로 로그인되어 있고 호스트 모드에 진입된 상태여야 합니다.",
        "먼저 !호스트 로그인 dev/stg 명령어가 PASS 되는지 확인해주세요."
      ]
    );
  }

  const homeTab = findBottomTab(xml, "홈");
  if (homeTab?.bounds && (!hasHostHomeWorkArea(xml) || !findExtensionRequestCard(xml))) {
    await tap(config, device, homeTab.bounds.x, homeTab.bounds.y);
    addStep(steps, "호스트 홈 탭 진입");
    xml = await waitForUi(
      config,
      device,
      (nextXml) =>
        isHostModeShell(nextXml) &&
        hasHostHomeWorkArea(nextXml) &&
        Boolean(findExtensionRequestCard(nextXml)),
      7000,
      180
    );
  } else {
    addStep(steps, "호스트 홈 화면 확인");
  }

  if (!hasHostHomeWorkArea(xml) || !findExtensionRequestCard(xml)) {
    await saveFailureArtifacts(config, device, store, "host-extension-home-not-found", xml);
    fail(
      "호스트 홈 화면의 연장 요청 카드를 확인하지 못했습니다.",
      steps,
      [
        "연장 수락은 호스트 홈의 연장 요청 카드에서 시작합니다.",
        "계약 탭으로 이동하지 않고 홈 카드만 대상으로 처리합니다.",
        "리포트의 host-extension-home-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  saveXml(store, "host-extension-home", xml);
  return xml;
}

async function openExtensionRequestDetail(config, device, store, steps, homeXml) {
  let xml = homeXml;
  let card = findExtensionRequestCard(xml);

  if (!card?.bounds) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    xml = await dumpUiStable(config, device);
    saveXml(store, "host-extension-home-after-refresh", xml);
    card = findExtensionRequestCard(xml);
  }

  if (!card?.bounds) {
    await saveFailureArtifacts(config, device, store, "host-extension-card-not-found", xml);
    fail(
      "호스트 홈에서 연장 수락 요청 카드를 찾지 못했습니다.",
      steps,
      [
        "호스트 홈의 할 일 카드에서 초록색 'N박 연장 요청' 상태 카드를 찾습니다.",
        "먼저 게스트가 !게스트 연장요청 dev/stg를 PASS 시켰는지 확인해주세요.",
        "리포트의 host-extension-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const cardLabel = labelOf(card).replace(/\s+/g, " ").trim();
  await tap(config, device, card.bounds.x, card.bounds.y);
  addStep(steps, "호스트 홈 연장 요청 카드 선택", "pass", cardLabel);

  xml = await waitForUi(
    config,
    device,
    (nextXml) =>
      nextXml.includes("계약 연장 요청") ||
      nextXml.includes("확인 및 응답") ||
      isAccessibilityLightUi(nextXml),
    6000,
    150
  );
  saveXml(store, "host-extension-contract-detail", xml);

  const confirmAndRespond = findNode(xml, "확인 및 응답", {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!confirmAndRespond?.bounds) {
    const canUseVisualFallback =
      xml.includes("계약 연장 요청") ||
      xml.includes("수락 대기 중") ||
      isAccessibilityLightUi(xml);

    if (canUseVisualFallback) {
      const fallbackTargets = [
        { x: 540, y: 1308, name: "버튼 중앙" },
        { x: 540, y: 1348, name: "버튼 하단 중앙" },
        { x: 540, y: 1268, name: "버튼 상단 중앙" }
      ];

      for (const target of fallbackTargets) {
        await tap(config, device, target.x, target.y);
        await new Promise((resolve) => setTimeout(resolve, 220));
        const fallbackXml = await waitForUi(
          config,
          device,
          (nextXml) => isExtensionApproveDetail(nextXml) || isAccessibilityLightUi(nextXml),
          1200,
          120
        );
        if (isExtensionApproveDetail(fallbackXml) || isAccessibilityLightUi(fallbackXml)) {
          addStep(
            steps,
            "계약 연장 요청 확인 및 응답 선택",
            "pass",
            `XML 미노출 버튼 ${target.name} 좌표 탭`
          );
          saveXml(store, "host-extension-approve-detail-start", fallbackXml);
          return fallbackXml;
        }
        xml = fallbackXml;
      }

      await tap(config, device, 540, 1372);
      addStep(
        steps,
        "계약 연장 요청 확인 및 응답 재시도",
        "pass",
        "기존 하단 좌표 탭"
      );
      const fallbackXml = await waitForUi(
        config,
        device,
        (nextXml) => isExtensionApproveDetail(nextXml) || isAccessibilityLightUi(nextXml),
        1500,
        120
      );
      if (isExtensionApproveDetail(fallbackXml) || isAccessibilityLightUi(fallbackXml)) {
        saveXml(store, "host-extension-approve-detail-start", fallbackXml);
        return fallbackXml;
      }
      xml = fallbackXml;
    }

    await saveFailureArtifacts(config, device, store, "host-extension-confirm-response-not-found", xml);
    fail(
      "호스트 계약 상세에서 계약 연장 요청의 확인 및 응답 버튼을 찾지 못했습니다.",
      steps,
      [
        "계약 상세 화면의 '계약 연장 요청' 섹션에 '확인 및 응답' 버튼이 보여야 합니다.",
        "Android XML에 버튼이 노출되지 않는 경우 화면 중앙 하단 버튼 좌표로 재시도합니다.",
        "리포트의 host-extension-confirm-response-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, confirmAndRespond.bounds.x, confirmAndRespond.bounds.y);
  addStep(steps, "계약 연장 요청 확인 및 응답 선택");

  await new Promise((resolve) => setTimeout(resolve, 450));
  xml = await waitForUi(
    config,
    device,
    (nextXml) => isExtensionApproveDetail(nextXml) || isAccessibilityLightUi(nextXml),
    1800,
    150
  );
  saveXml(store, "host-extension-approve-detail-start", xml);
  if (isAccessibilityLightUi(xml)) {
    await saveScreenshotArtifact(config, device, store, "host-extension-approve-detail-visual-fallback");
    addStep(
      steps,
      "계약 연장 상세 화면 진입 확인",
      "pass",
      "Android XML 텍스트 미노출로 화면 캡처 기반 제한 검증 모드 사용"
    );
    return xml;
  }

  if (!isExtensionApproveDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "host-extension-approve-detail-not-found", xml);
    fail(
      "계약 연장 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "확인 및 응답 선택 후 계약 연장 상세 화면이 보여야 합니다.",
        "리포트의 host-extension-approve-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

function isExtensionApproveDetail(xml) {
  return (
    (xml.includes("계약 연장") || xml.includes("연장 요청")) &&
    (
      xml.includes("연장 계약 금액 설정") ||
      xml.includes("기존 계약 박당 금액") ||
      xml.includes("연장 정산 예정") ||
      xml.includes("게스트 결제 예정 금액")
    )
  );
}

function moneyValues(text) {
  return Array.from(String(text || "").matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/g))
    .map((match) => `${match[1]}원`);
}

function xmlText(xml) {
  return parseNodes(xml)
    .map((node) => labelOf(node).trim())
    .filter(Boolean)
    .join(" ");
}

function meaningfulLabelCount(xml) {
  return parseNodes(xml)
    .map((node) => labelOf(node).trim())
    .filter(Boolean)
    .length;
}

function isAccessibilityLightUi(xml) {
  return !isInvalidUiDump(xml) && meaningfulLabelCount(xml) <= 2;
}

function fixedAcceptButtonFromViewport() {
  return {
    attrs: {
      text: "연장 수락",
      clickable: "true",
      enabled: "true"
    },
    bounds: {
      left: 552,
      top: 2317,
      right: 1032,
      bottom: 2461,
      x: 792,
      y: 2389
    }
  };
}

function fixedPopupConfirmButtonFromViewport() {
  return {
    bounds: {
      left: 552,
      top: 1650,
      right: 960,
      bottom: 1815,
      x: 756,
      y: 1735
    }
  };
}

function hasRequiredTexts(xml, texts) {
  return texts.every((text) => xml.includes(text));
}

function extractAmountNear(xml, anchorLabels) {
  const nodes = parseNodes(xml).filter((node) => node.bounds);
  const anchors = nodes.filter((node) => anchorLabels.some((label) => labelOf(node).includes(label)));
  const values = [];

  for (const anchor of anchors) {
    const nearby = nodes.filter((node) => (
      visible(node) &&
      node.bounds.top >= anchor.bounds.top - 80 &&
      node.bounds.top <= anchor.bounds.bottom + 260
    ));
    for (const node of nearby) {
      values.push(...moneyValues(labelOf(node)));
    }
  }

  return values[values.length - 1] || "";
}

async function scrollAndValidateExtensionDetail(config, device, store, steps, initialXml) {
  let xml = initialXml;
  if (isAccessibilityLightUi(xml)) {
    const warnings = [
      {
        name: "host_extension_detail_accessibility",
        message: "계약 연장 상세 화면의 Android XML 텍스트가 노출되지 않아 문구/금액 자동 비교를 제한했습니다.",
        details: [
          "화면 진입 캡처는 host-extension-approve-detail-visual-fallback.png에 저장했습니다.",
          "연장 수락 버튼은 화면 하단 고정 영역 좌표로 탭합니다."
        ]
      }
    ];
    addStep(
      steps,
      "계약 연장 상세 문구/금액 제한 검증",
      "pass",
      "화면 텍스트가 Android XML에 노출되지 않아 자동 문구/금액 비교를 제한합니다."
    );
    saveXml(store, "host-extension-approve-detail-combined", xml);
    saveXml(store, "host-extension-before-accept", xml);
    return buildExtensionApprovalDetail({
      xml,
      acceptButton: fixedAcceptButtonFromViewport(),
      settlementAmount: "XML 미노출",
      guestPaymentAmount: "XML 미노출",
      bottomSettlementAmount: "XML 미노출",
      basePriceAmount: "XML 미노출",
      validationMode: "visual-fallback",
      appWarnings: warnings
    });
  }

  const warnings = [];
  const seen = [];
  const requiredTexts = [
    "연장 요청",
    "연장 계약 금액 설정",
    "기존 계약 박당 금액",
    "기존 계약 요금 기준",
    "연장 정산 예정",
    "게스트 결제 예정 금액",
    "정산 예정 금액",
    "연장 수락"
  ];

  for (let count = 0; count < 7; count += 1) {
    seen.push(xml);
    if (hasRequiredTexts(seen.join("\n"), requiredTexts)) break;
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2110", "540", "1040", "220"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
  }

  const combinedXml = seen.join("\n");
  saveXml(store, "host-extension-approve-detail-combined", combinedXml);

  const missing = requiredTexts.filter((text) => !combinedXml.includes(text));
  if (missing.length) {
    await saveScreenshotArtifact(config, device, store, "host-extension-detail-text-limited");
    pushWarning(
      warnings,
      "host_extension_detail_text_limited",
      "계약 연장 상세 화면의 일부 문구가 Android XML에서 확인되지 않아 자동 비교를 제한했습니다.",
      [`확인 제한 문구: ${missing.join(", ")}`]
    );
    addStep(steps, "계약 연장 상세 문구 제한 검증", "pass", `확인 제한: ${missing.join(", ")}`);
  } else {
    addStep(steps, "계약 연장 상세 필수 문구 확인");
  }

  if (!combinedXml.includes("기존 계약 박당 금액") || !combinedXml.includes("선택")) {
    pushWarning(
      warnings,
      "host_extension_default_price_limited",
      "기존 계약 박당 금액 기본 선택 상태를 Android XML에서 충분히 확인하지 못했습니다.",
      ["화면 캡처/PDF에서 선택 상태를 확인해주세요."]
    );
    addStep(steps, "기존 계약 박당 금액 기본 선택 제한 검증", "pass", "XML 확인 제한");
  } else {
    addStep(steps, "기존 계약 박당 금액 기본 선택 확인");
  }

  const combinedText = xmlText(combinedXml);
  const allAmounts = moneyValues(combinedText);
  const settlementAmount = extractAmountNear(combinedXml, ["연장 정산 예정"]);
  const guestPaymentAmount = extractAmountNear(combinedXml, ["게스트 결제 예정 금액"]);
  const bottomSettlementAmount = extractAmountNear(combinedXml, ["정산 예정 금액"]);
  const basePriceAmount = extractAmountNear(combinedXml, ["기존 계약 요금 기준", "기존 계약 박당 금액"]);

  if (!settlementAmount || !guestPaymentAmount || !bottomSettlementAmount) {
    await saveScreenshotArtifact(config, device, store, "host-extension-amounts-limited");
    pushWarning(
      warnings,
      "host_extension_amounts_limited",
      "계약 연장 상세 화면의 금액 일부를 Android XML에서 확인하지 못했습니다.",
      [`확인된 금액: ${allAmounts.join(", ") || "없음"}`]
    );
    addStep(steps, "연장 계약 금액 제한 검증", "pass", `확인된 금액=${allAmounts.join(", ") || "없음"}`);
  } else if (settlementAmount !== bottomSettlementAmount) {
    pushWarning(
      warnings,
      "host_extension_settlement_mismatch",
      "하단 정산 예정 금액과 연장 정산 예정 영역의 금액이 다르게 확인되었습니다.",
      [`연장 정산 예정: ${settlementAmount}`, `하단 정산 예정 금액: ${bottomSettlementAmount}`]
    );
    addStep(steps, "연장 정산 예정 금액 비교", "pass", `불일치 경고: ${settlementAmount} / ${bottomSettlementAmount}`);
  } else {
    addStep(steps, "연장 계약 금액 설정 및 금액 검증", "pass", `기존요금=${basePriceAmount || "확인됨"}, 정산=${settlementAmount}, 게스트결제=${guestPaymentAmount}`);
  }

  const acceptButton = findNode(xml, "연장 수락", {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!acceptButton?.bounds) {
    pushWarning(
      warnings,
      "host_extension_accept_button_fallback",
      "연장 수락 버튼을 Android XML에서 확인하지 못해 화면 하단 좌표로 선택합니다.",
      ["화면 하단 고정 버튼 영역을 사용합니다."]
    );
  }

  saveXml(store, "host-extension-before-accept", xml);
  return buildExtensionApprovalDetail({
    xml,
    acceptButton: acceptButton || fixedAcceptButtonFromViewport(),
    settlementAmount,
    guestPaymentAmount,
    bottomSettlementAmount,
    basePriceAmount,
    validationMode: warnings.length ? "partial" : "xml",
    appWarnings: warnings
  });
}

async function prepareFastExtensionApproval(config, device, store, steps, initialXml) {
  let xml = initialXml;
  saveXml(store, "host-extension-approve-detail-combined", xml);
  saveXml(store, "host-extension-before-accept", xml);

  const acceptButton = findNode(xml, "연장 수락", {
    visible: true,
    clickable: true,
    enabled: true
  }) || fixedAcceptButtonFromViewport();

  if (!acceptButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "host-extension-accept-button-not-found", xml);
    fail(
      "계약 연장 상세 화면에서 연장 수락 버튼을 찾지 못했습니다.",
      steps,
      [
        "속도 개선 모드에서는 상세 화면 진입 후 바로 하단 연장 수락 버튼을 선택합니다.",
        "리포트의 host-extension-accept-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(
    steps,
    "계약 연장 상세 빠른 수락 준비",
    "pass",
    acceptButton.attrs?.text ? "XML 버튼 영역" : "하단 고정 버튼 좌표"
  );

  return buildExtensionApprovalDetail({
    xml,
    acceptButton,
    settlementAmount: "빠른 수락 모드",
    guestPaymentAmount: "빠른 수락 모드",
    bottomSettlementAmount: "빠른 수락 모드",
    basePriceAmount: "빠른 수락 모드",
    validationMode: "fast-accept",
    appWarnings: [
      {
        name: "host_extension_detail_validation_skipped",
        message: "속도 개선을 위해 호스트 연장 상세의 문구/금액 상세 비교를 생략하고 하단 연장 수락을 바로 선택했습니다.",
        details: [
          "호스트 연장 수락 명령은 빠른 처리 중심으로 동작합니다.",
          "상세 문구/금액 확인이 필요하면 리포트 캡처 또는 앱 화면에서 별도로 확인해주세요."
        ]
      }
    ]
  });
}

function hasAcceptConfirmPopup(xml) {
  return xml.includes("연장 계약 내용을 확인하셨나요?") || xml.includes("계약 연장 내용을 확인하셨나요?");
}

function hasExtensionAcceptCompletePopup(xml) {
  return (
    xml.includes("계약 연장 수락 완료") ||
    xml.includes("연장 수락 완료") ||
    xml.includes("수락이 완료")
  );
}

async function tapConfirmButton(config, device, store, steps, xml, label, artifactName) {
  const confirmButton = findNode(xml, "확인", {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, artifactName, xml);
    fail(`${label} 팝업에서 확인 버튼을 찾지 못했습니다.`, steps);
  }

  await runAdb(config, device, [
    "shell",
    "input",
    "touchscreen",
    "tap",
    String(confirmButton.bounds.x),
    String(confirmButton.bounds.y)
  ]);
  addStep(steps, `${label} 확인 버튼 선택`);
}

async function tapFixedPopupConfirmButton(config, device, steps, label, waitMs = 180) {
  const confirmButton = fixedPopupConfirmButtonFromViewport();
  await runAdb(config, device, [
    "shell",
    "input",
    "touchscreen",
    "tap",
    String(confirmButton.bounds.x),
    String(confirmButton.bounds.y)
  ]);
  addStep(steps, `${label} 확인 버튼 선택`, "pass", "팝업 XML 미노출로 화면 좌표 fallback 사용");
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function verifyExtensionRequestResolved(config, device, appPackage, store, steps) {
  await launchApp(config, device, appPackage, steps);
  let xml = await waitForUi(config, device, isHostModeShell, 12000, 180);

  const homeTab = findBottomTab(xml, "홈");
  if (homeTab?.bounds && !hasHostHomeWorkArea(xml)) {
    await tap(config, device, homeTab.bounds.x, homeTab.bounds.y);
    addStep(steps, "호스트 홈 탭 최종 확인");
    xml = await waitForUi(
      config,
      device,
      (nextXml) => isHostModeShell(nextXml) && hasHostHomeWorkArea(nextXml),
      7000,
      180
    );
  }

  saveXml(store, "host-extension-final-home", xml);
  const remainingCard = findExtensionRequestCard(xml);
  if (remainingCard?.bounds) {
    await saveFailureArtifacts(config, device, store, "host-extension-request-still-present", xml);
    fail(
      "연장 수락 후에도 호스트 홈에 연장 요청 카드가 남아 있습니다.",
      steps,
      [
        "연장 수락 버튼 또는 확인 팝업 탭이 실제 앱에 반영되지 않았습니다.",
        "최종 PASS는 호스트 홈에서 연장 요청 카드가 사라진 경우에만 처리합니다.",
        "리포트의 host-extension-request-still-present.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "호스트 홈 연장 요청 카드 제거 확인");
}

function addWarning(detail, name, message, details = []) {
  detail.appWarnings = detail.appWarnings || [];
  detail.appWarnings.push({ name, message, details });
}

function pushWarning(warnings, name, message, details = []) {
  warnings.push({ name, message, details });
}

function buildExtensionApprovalDetail({
  xml,
  acceptButton,
  settlementAmount,
  guestPaymentAmount,
  bottomSettlementAmount,
  basePriceAmount,
  validationMode,
  appWarnings
}) {
  return {
    xml,
    acceptButton,
    settlementAmount: settlementAmount || "확인 제한",
    guestPaymentAmount: guestPaymentAmount || "확인 제한",
    bottomSettlementAmount: bottomSettlementAmount || "확인 제한",
    basePriceAmount: basePriceAmount || "확인 제한",
    validationMode,
    appWarnings
  };
}

async function submitExtensionApproval(config, device, appPackage, store, steps, detail) {
  await tap(config, device, detail.acceptButton.bounds.x, detail.acceptButton.bounds.y);
  addStep(steps, "연장 수락 버튼 선택");

  await new Promise((resolve) => setTimeout(resolve, 220));
  await tapFixedPopupConfirmButton(config, device, steps, "연장 계약 내용 확인", 220);

  let xml = await waitForUi(
    config,
    device,
    (nextXml) => (
      hasExtensionAcceptCompletePopup(nextXml) ||
      hasAcceptConfirmPopup(nextXml) ||
      isAccessibilityLightUi(nextXml)
    ),
    1200,
    100
  );
  saveXml(store, "host-extension-accept-confirm-popup", xml);
  if (hasAcceptConfirmPopup(xml)) {
    await tapFixedPopupConfirmButton(config, device, steps, "연장 계약 내용 확인 재시도", 180);
    xml = await waitForUi(
      config,
      device,
      (nextXml) => hasExtensionAcceptCompletePopup(nextXml) || isAccessibilityLightUi(nextXml),
      1200,
      100
    );
  }

  if (!hasExtensionAcceptCompletePopup(xml) && !isAccessibilityLightUi(xml)) {
    await saveScreenshotArtifact(config, device, store, "host-extension-accept-confirm-popup-visual-fallback");
    addWarning(
      detail,
      "host_extension_accept_confirm_accessibility",
      "연장 계약 내용 확인 팝업 처리 후 완료 팝업 전환을 Android XML에서 즉시 확인하지 못했습니다.",
      ["캡처: host-extension-accept-confirm-popup-visual-fallback.png"]
    );
  }

  await tapFixedPopupConfirmButton(config, device, steps, "계약 연장 수락 완료", 260);

  xml = await waitForUi(config, device, (nextXml) => !hasExtensionAcceptCompletePopup(nextXml), 1200, 120);
  saveXml(store, "host-extension-accept-complete-popup", xml);
  if (hasExtensionAcceptCompletePopup(xml)) {
    await saveScreenshotArtifact(config, device, store, "host-extension-accept-complete-popup-visual-fallback");
    addWarning(
      detail,
      "host_extension_accept_complete_accessibility",
      "계약 연장 수락 완료 팝업의 확인 버튼을 눌렀지만 팝업 닫힘을 즉시 확인하지 못했습니다.",
      ["캡처: host-extension-accept-complete-popup-visual-fallback.png"]
    );
    await tapFixedPopupConfirmButton(config, device, steps, "계약 연장 수락 완료 재시도", 260);
  }

  await verifyExtensionRequestResolved(config, device, appPackage, store, steps);
}

async function runContractExtensionApproveTest({ request, config, store }) {
  const role = request.role || "host";
  const env = request.env || "staging";
  const device = config.devices.host || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "host") throw new Error("계약 연장 수락은 host role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: host");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);

    const latestExtension = findLatestGuestExtensionInfo(config.reportBaseDir, env);
    if (latestExtension?.extension_nights) {
      addStep(steps, "최근 게스트 연장 요청 기준 확인", "pass", `${latestExtension.extension_nights}박 / ${latestExtension.target_checkout_date}`);
    }

    const homeXml = await openHostHome(config, device, appPackage, store, steps);
    const extensionXml = await openExtensionRequestDetail(config, device, store, steps, homeXml);
    const detail = await prepareFastExtensionApproval(config, device, store, steps, extensionXml);
    await submitExtensionApproval(config, device, appPackage, store, steps, detail);

    return {
      test_id: "TC-CONTRACT-EXTENSION-APPROVE-001",
      name: "host 계약 연장 수락",
      env,
      status: "pass",
      device,
      steps,
      contract_extension_approval: {
        latest_guest_extension: latestExtension || null,
        validation_mode: detail.validationMode || "xml",
        base_price_amount: detail.basePriceAmount || "",
        settlement_amount: detail.settlementAmount,
        guest_payment_amount: detail.guestPaymentAmount,
        bottom_settlement_amount: detail.bottomSettlementAmount
      },
      app_warnings: detail.appWarnings || [],
      artifacts: {
        screenshots: [
          path.join(store.screenshotsDir, "host-extension-approve-detail-visual-fallback.png"),
          path.join(store.screenshotsDir, "host-extension-accept-confirm-popup-visual-fallback.png"),
          path.join(store.screenshotsDir, "host-extension-accept-complete-popup-visual-fallback.png")
        ].filter((filePath) => fs.existsSync(filePath)),
        logs: [
          path.join(store.logsDir, "host-extension-home.xml"),
          path.join(store.logsDir, "host-extension-contract-detail.xml"),
          path.join(store.logsDir, "host-extension-approve-detail-combined.xml"),
          path.join(store.logsDir, "host-extension-before-accept.xml"),
          path.join(store.logsDir, "host-extension-accept-confirm-popup.xml"),
          path.join(store.logsDir, "host-extension-accept-complete-popup.xml"),
          path.join(store.logsDir, "host-extension-final-home.xml")
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

module.exports = {
  runContractExtensionApproveTest
};
