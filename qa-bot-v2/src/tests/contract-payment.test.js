const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  dumpUi,
  inputText,
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

function nodeLabel(node) {
  return [
    node.attrs.text || "",
    node.attrs["content-desc"] || "",
    node.attrs.hint || ""
  ].join("\n");
}

function xmlTextLines(xml) {
  return parseNodes(xml)
    .map(nodeLabel)
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

function extractBankTransferApprovalTarget(store) {
  const detailPath = path.join(store.logsDir, "payment-detail-start.xml");
  const completePath = path.join(store.logsDir, "payment-complete.xml");
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

function findNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && !isVisibleNode(node)) {
      return false;
    }
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    const label = nodeLabel(node);
    return labelList.some((value) => label.includes(value));
  });
  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function findExactNode(xml, labels, options = {}) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  const nodes = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (options.visible && !isVisibleNode(node)) return false;
    if (options.clickable && node.attrs.clickable !== "true") return false;
    if (options.enabled && node.attrs.enabled !== "true") return false;
    const label = nodeLabel(node).trim();
    return labelList.includes(label);
  });
  return nodes.find((node) => node.attrs.clickable === "true") || nodes[0];
}

function isVisibleNode(node) {
  if (!node?.bounds) return false;
  return node.bounds.bottom > 120 && node.bounds.top < 2449 && node.bounds.bottom > node.bounds.top;
}

function findEditableNodes(xml) {
  return parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    const className = node.attrs.class || "";
    return className.includes("EditText") && node.attrs.enabled === "true";
  });
}

function findPgPaymentFields(xml) {
  const cardNumberLabel = findNode(xml, "Card number", { visible: true });
  const expiryLabel = findNode(xml, "Expiry date", { visible: true });
  const cardTop = cardNumberLabel?.bounds ? cardNumberLabel.bounds.top : 90;
  const expiryTop = expiryLabel?.bounds ? expiryLabel.bounds.top : 1800;
  const editableNodes = findEditableNodes(xml).filter((node) => {
    const label = nodeLabel(node);
    return label !== "JCB" && !label.includes("@") && node.attrs["resource-id"] !== "cardExpiry";
  });
  const cardCandidates = editableNodes
    .filter((node) => {
      const width = node.bounds.right - node.bounds.left;
      return (
        width <= 260 &&
        node.bounds.top >= cardTop &&
        node.bounds.bottom <= expiryTop &&
        isVisibleNode(node)
      );
    })
    .sort((leftNode, rightNode) => leftNode.bounds.left - rightNode.bounds.left);
  const cardFields = [];
  for (const candidate of cardCandidates) {
    const existing = cardFields.find((node) => Math.abs(node.bounds.x - candidate.bounds.x) < 80);
    if (!existing) {
      cardFields.push(candidate);
    } else {
      const existingWidth = existing.bounds.right - existing.bounds.left;
      const candidateWidth = candidate.bounds.right - candidate.bounds.left;
      if (candidateWidth > existingWidth) {
        cardFields[cardFields.indexOf(existing)] = candidate;
      }
    }
  }
  const expiryField =
    findEditableNodes(xml).find((node) => node.attrs["resource-id"] === "cardExpiry") ||
    findEditableNodes(xml)
      .filter((node) => {
        const label = nodeLabel(node);
        const width = node.bounds.right - node.bounds.left;
        return !label.includes("@") && width > 600 && node.bounds.top > 1000;
      })
      .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0];

  return { cardFields, expiryField };
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return xml;
}

async function waitForUi(config, device, predicate, timeoutMs = 12000) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUiStable(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return xml;
}

async function tapNode(config, device, node, label, steps) {
  if (!node?.bounds) fail(`${label}을 찾지 못했습니다.`, steps);
  await tap(config, device, node.bounds.x, node.bounds.y);
}

async function hideKeyboard(config, device) {
  await keyEvent(config, device, 111).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  let xml = await dumpUiStable(config, device);
  const focusedInput = findEditableNodes(xml).some((node) => node.attrs.focused === "true");

  if (/honeyboard|inputmethod|keyboard|키보드|보안키패드/i.test(xml) || focusedInput) {
    // Do not send KEYCODE_BACK here. In the WebView payment page it can navigate away to Home.
    await tap(config, device, 540, 260).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
    xml = await dumpUiStable(config, device);
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

function hasPaymentWaitingCard(xml) {
  return (
    (
      xml.includes("결제 대기 중") ||
      xml.includes("결제 요청 중") ||
      xml.includes("요청 중")
    ) &&
    (
      xml.includes("확인 및 결제") ||
      xml.includes("결제하기") ||
      xml.includes("계약 확인")
    )
  );
}

function findPaymentWaitingCard(xml) {
  return parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      (
        label.includes("결제 대기 중") ||
        label.includes("결제 요청 중") ||
        label.includes("요청 중")
      )
    );
  });
}

function findPaymentHomeActionButton(xml) {
  return findNode(xml, ["확인 및 결제", "결제하기", "계약 확인"], {
    visible: true,
    clickable: true,
    enabled: true
  });
}

async function tapPaymentHomeCard(config, device, xml, steps) {
  const paymentButton = findPaymentHomeActionButton(xml);
  if (paymentButton?.bounds) {
    await tapNode(config, device, paymentButton, "결제 카드 버튼", steps);
    return;
  }

  const paymentCard = findPaymentWaitingCard(xml);
  if (paymentCard?.bounds) {
    await tap(config, device, paymentCard.bounds.x, paymentCard.bounds.y);
    return;
  }

  fail("홈 화면 결제 카드 선택 좌표를 찾지 못했습니다.", steps);
}

function isContractPaymentDetail(xml) {
  return (
    xml.includes("계약번호") &&
    (xml.includes("결제해 주세요") || xml.includes("결제해 주세요.")) &&
    xml.includes("결제하기")
  );
}

function hasPaymentMethodSection(xml) {
  return (
    xml.includes("결제 방법") &&
    xml.includes("결제하기")
  );
}

function hasVisibleCardPaymentMethodSection(xml) {
  return Boolean(
    findNode(xml, "신용·체크카드 결제 수단 선택됨", { visible: true }) &&
      findNode(xml, "더보기 버튼", { visible: true, clickable: true, enabled: true }) &&
      findNode(xml, "결제하기", { visible: true, clickable: true, enabled: true })
  );
}

function hasVisiblePaymentMethodSection(xml) {
  return Boolean(
    findNode(xml, "결제 방법", { visible: true }) &&
      findNode(xml, "결제하기", { visible: true, clickable: true, enabled: true })
  );
}

function hasPaymentMethodTopTabs(xml) {
  return (
    xml.includes("신용 / 체크 카드") &&
    xml.includes("무통장 입금")
  );
}

function hasPaymentTypeTabsClippedAtTop(xml) {
  const bankTransferTab = parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      (label.includes("무통장 입금") || label.includes("무통장입금")) &&
      node.bounds.left >= 500 &&
      node.bounds.right >= 900 &&
      node.bounds.top <= 330
    );
  });
  return Boolean(bankTransferTab);
}

function hasVisiblePaymentTypeTabs(xml) {
  const creditTab = parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      isVisibleNode(node) &&
      label.includes("신용 / 체크 카드") &&
      node.bounds.left <= 80 &&
      node.bounds.right >= 500
    );
  });
  const bankTransferTab = findVisibleBankTransferTypeTab(xml);
  return Boolean(creditTab && bankTransferTab);
}

function isPaymentMethodReady(xml, paymentMethod) {
  if (paymentMethod === "bank-transfer") {
    return hasVisiblePaymentTypeTabs(xml);
  }

  return hasPaymentMethodSection(xml) && hasVisiblePaymentMethodSection(xml);
}

function hasBankTransferForm(xml) {
  return (
    (xml.includes("현금영수증") || xml.includes("현금 영수증")) &&
    (xml.includes("환불") || xml.includes("보증금")) &&
    xml.includes("은행") &&
    xml.includes("계좌")
  );
}

function hasBankTransferSelected(xml) {
  return (
    xml.includes("무통장 입금 결제 수단 선택됨") ||
    xml.includes("무통장입금 결제 수단 선택됨") ||
    (xml.includes("무통장 입금") && hasBankTransferForm(xml))
  );
}

function hasJcbSelected(xml) {
  return xml.includes("JCB 카드 선택됨");
}

function findJcbCardOption(xml, { visible = true } = {}) {
  return findNode(xml, "JCB 카드", {
    visible,
    clickable: true,
    enabled: true
  });
}

async function scrollJcbCardIntoView(config, device, store, xml) {
  let currentXml = xml;

  for (let count = 0; count < 6; count += 1) {
    const visibleJcb = findJcbCardOption(currentXml, { visible: true });
    if (visibleJcb?.bounds) return { xml: currentXml, node: visibleJcb };

    const clippedJcb = findJcbCardOption(currentXml, { visible: false });
    if (!clippedJcb?.bounds) return { xml: currentXml, node: null };

    store.appendLog(
      "runner.log",
      `JCB card option clipped at [${clippedJcb.bounds.left},${clippedJcb.bounds.top}][${clippedJcb.bounds.right},${clippedJcb.bounds.bottom}], scrolling into view (${count + 1})`
    );
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2250", "540", "1800", "180"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    currentXml = await dumpUiStable(config, device);
  }

  return { xml: currentXml, node: findJcbCardOption(currentXml, { visible: true }) };
}

function isPgPaymentScreen(xml) {
  return (
    xml.includes("Payment information") &&
    xml.includes("Card number") &&
    xml.includes("Expiry date") &&
    xml.includes("Next")
  );
}

function hasSecureKeypad(xml) {
  return xml.includes("보안키패드,");
}

function hasVisibleSecureDigit(xml, digit) {
  return Boolean(
    findNode(xml, `보안키패드, ${digit}`, {
      visible: true,
      clickable: true,
      enabled: true
    })
  );
}

function isPaymentComplete(xml) {
  return (
    xml.includes("결제 완료") ||
    xml.includes("Payment complete") ||
    xml.includes("결제가 완료") ||
    xml.includes("결제되었습니다") ||
    xml.includes("계약이 확정")
  );
}

function isBankTransferPaymentComplete(xml) {
  return (
    isPaymentComplete(xml) ||
    (
      xml.includes("입금해주세요") &&
      xml.includes("무통장 입금 정보") &&
      xml.includes("예금주:") &&
      xml.includes("계좌 번호:") &&
      xml.includes("입금액:") &&
      xml.includes("홈으로 가기")
    )
  );
}

function isHomeScreen(xml) {
  return (
    xml.includes("동네 주변 장소로 검색") ||
    xml.includes("동네 · 주변 장소로 검색") ||
    xml.includes("어디로 떠나세요") ||
    xml.includes("홈")
  );
}

async function returnHomeFromPaymentComplete(config, device, store, steps, xml, artifactPrefix = "payment") {
  const homeButton = findNode(xml, ["홈으로 가기", "홈으로", "홈 화면으로", "홈"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!homeButton?.bounds) {
    await saveFailureArtifacts(config, device, store, `${artifactPrefix}-home-button-not-found`, xml);
    fail(
      "결제 완료 화면에서 홈으로 버튼을 찾지 못했습니다.",
      steps,
      [
        "결제 완료 후 홈 화면으로 이동하는 버튼이 보여야 합니다.",
        `리포트의 ${artifactPrefix}-home-button-not-found.png 화면을 확인해주세요.`
      ]
    );
  }

  await tapNode(config, device, homeButton, "홈으로 버튼", steps);
  addStep(steps, "결제 완료 화면 홈으로 버튼 탭");

  const homeXml = await waitForUi(config, device, isHomeScreen, 8000);
  saveXml(store, "payment-return-home", homeXml);
  if (!isHomeScreen(homeXml)) {
    await saveFailureArtifacts(config, device, store, `${artifactPrefix}-return-home-not-found`, homeXml);
    fail(
      "결제 완료 후 홈 화면으로 이동하지 못했습니다.",
      steps,
      [
        "홈으로 버튼을 눌렀지만 홈 화면 검색바를 확인하지 못했습니다.",
        `리포트의 ${artifactPrefix}-return-home-not-found.png 화면을 확인해주세요.`
      ]
    );
  }
  addStep(steps, "홈 화면 이동 확인");

  return homeXml;
}

function hasVisibleEnabledHolderCheck(xml) {
  return Boolean(findNode(xml, ["예금주 확인", "예금 주 확인"], {
    visible: true,
    clickable: true,
    enabled: true
  }));
}

function findHolderCheckButton(xml) {
  return findNode(xml, ["예금주 확인", "예금 주 확인"], {
    visible: true,
    clickable: true,
    enabled: true
  });
}

async function bringHolderCheckIntoSafeView(config, device) {
  let xml = await hideKeyboard(config, device);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const holderCheck = findHolderCheckButton(xml);
    if (holderCheck?.bounds && holderCheck.bounds.top >= 280 && holderCheck.bounds.bottom <= 2100) {
      return xml;
    }

    const clippedHolderCheck = parseNodes(xml).find((node) => {
      const label = nodeLabel(node);
      return node.bounds && label.includes("예금주 확인") && node.bounds.bottom <= node.bounds.top;
    });

    if (clippedHolderCheck || !holderCheck?.bounds || holderCheck.bounds.bottom > 2100) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1850", "540", "1250", "250"]);
    } else if (holderCheck.bounds.top < 280) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "850", "540", "1250", "250"]);
    }

    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await hideKeyboard(config, device);
  }

  return xml;
}

function hasRefundAccountRequiredError(xml) {
  return (
    xml.includes("보증금 반환 계좌 정보를 입력해주세요") ||
    xml.includes("환불 계좌 정보를 입력해주세요") ||
    xml.includes("계좌 정보를 입력해주세요")
  );
}

function isAccountHolderConfirmDialog(xml) {
  return (
    xml.includes("계좌가 맞나요") &&
    xml.includes("조회된 예금주 정보")
  );
}

function hasRefundAccountVerified(xml) {
  return (
    !hasVisibleEnabledHolderCheck(xml) ||
    xml.includes("예금주 확인 완료") ||
    xml.includes("예금주가 확인") ||
    xml.includes("확인 완료")
  );
}

function findVisibleSaveRefundAccountButton(xml) {
  const refundSection = findNode(xml, ["환불/보증금 반환 계좌", "보증금 반환 계좌", "환불 계좌"], {
    visible: true
  });
  if (!refundSection?.bounds) return null;

  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled === "true" &&
      nodeLabel(node).trim() === "저장" &&
      node.bounds.top >= refundSection.bounds.top
    ))
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0] || null;
}

function findVisibleBankTransferTypeTab(xml) {
  return parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        (label.includes("무통장 입금") || label.includes("무통장입금")) &&
        node.bounds.left >= 500 &&
        node.bounds.right >= 900 &&
        node.bounds.top >= 330 &&
        node.bounds.bottom <= 900
      );
    })
    .sort((leftNode, rightNode) => {
      const leftArea = (leftNode.bounds.right - leftNode.bounds.left) * (leftNode.bounds.bottom - leftNode.bounds.top);
      const rightArea = (rightNode.bounds.right - rightNode.bounds.left) * (rightNode.bounds.bottom - rightNode.bounds.top);
      return rightArea - leftArea;
    })[0] || null;
}

async function bringSecureKeypadIntoView(config, device) {
  let xml = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2250", "540", "850", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    xml = await dumpUiStable(config, device);
    if (hasVisibleSecureDigit(xml, "0") && hasVisibleSecureDigit(xml, "1")) break;
  }

  return xml || (await dumpUiStable(config, device));
}

async function openSecureKeypad(config, device, store, fieldIndex, steps) {
  let xml = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    xml = await dumpUiStable(config, device);
    const { cardFields } = findPgPaymentFields(xml);
    const field = cardFields[fieldIndex];
    if (!field?.bounds) break;

    const tapTargets = [
      [field.bounds.x, field.bounds.y],
      [field.bounds.left + 45, field.bounds.top + 45],
      [field.bounds.right - 45, field.bounds.bottom - 45]
    ];
    const [x, y] = tapTargets[Math.min(attempt, tapTargets.length - 1)];
    await tap(config, device, x, y);

    xml = await waitForUi(config, device, hasSecureKeypad, 1800);
    if (hasSecureKeypad(xml)) {
      xml = await bringSecureKeypadIntoView(config, device);
      if (hasSecureKeypad(xml)) return xml;
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2150", "540", "1500", "250"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  await saveFailureArtifacts(config, device, store, "pg-secure-keypad-not-opened", xml);
  fail(
    "PG 보안키패드가 열리지 않았습니다.",
    steps,
    [
      `카드번호 ${fieldIndex + 1}번째 칸을 여러 좌표로 탭하고 화면 스크롤 후 재시도했습니다.`,
      "리포트의 pg-secure-keypad-not-opened.png 화면을 확인해주세요."
    ]
  );
}

async function inputSecureKeypadDigits(config, device, store, digits, fieldIndex, steps) {
  let xml = await openSecureKeypad(config, device, store, fieldIndex, steps);
  if (!hasSecureKeypad(xml)) {
    fail("PG 보안키패드가 열리지 않았습니다.", steps);
  }

  for (const digit of digits) {
    xml = await dumpUiStable(config, device);
    if (!hasVisibleSecureDigit(xml, digit)) {
      xml = await bringSecureKeypadIntoView(config, device);
    }
    const digitButton = findNode(xml, `보안키패드, ${digit}`, {
      visible: true,
      clickable: true,
      enabled: true
    });
    await tapNode(config, device, digitButton, `보안키패드 숫자 ${digit}`, steps);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function openPaymentDetailFromHome(config, device, store, steps) {
  let xml = await waitForUi(
    config,
    device,
    (nextXml) => nextXml.includes("동네") || hasPaymentWaitingCard(nextXml),
    10000
  );
  saveXml(store, "payment-home-before-refresh", xml);

  if (!hasPaymentWaitingCard(xml)) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    addStep(steps, "홈 화면 풀 리프레시");

    xml = await waitForUi(config, device, hasPaymentWaitingCard, 6500);
  } else {
    addStep(steps, "홈 화면 결제 카드 즉시 확인", "pass", "리프레시 없이 카드가 이미 보이는 상태");
  }
  saveXml(store, "payment-home-after-refresh", xml);

  if (!hasPaymentWaitingCard(xml)) {
    await saveFailureArtifacts(config, device, store, "payment-card-not-found", xml);
    fail(
      "홈 화면에서 결제 카드 상태를 찾지 못했습니다.",
      steps,
      [
        "홈 화면에서 '결제 대기 중' 또는 '결제 요청 중' 상태와 결제/확인 버튼이 있는 카드를 찾습니다.",
        "호스트가 계약 요청을 승인했는지 확인해주세요.",
        "리포트의 payment-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "홈 화면 결제 카드 확인");
  await tapPaymentHomeCard(config, device, xml, steps);
  addStep(steps, "홈 화면 결제 카드 선택");

  xml = await waitForUi(config, device, isContractPaymentDetail, 10000);
  saveXml(store, "payment-detail-start", xml);

  if (!isContractPaymentDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "payment-detail-not-found", xml);
    fail(
      "계약 결제 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "확인 및 결제 버튼을 눌렀지만 계약번호, 결제 안내, 결제하기 버튼이 확인되지 않았습니다.",
        "리포트의 payment-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function scrollToPaymentMethod(config, device, store, steps, paymentMethod = "card") {
  let xml = await dumpUiStable(config, device);
  for (let count = 0; count < 14; count += 1) {
    if (paymentMethod === "bank-transfer" && isPaymentMethodReady(xml, paymentMethod)) {
      saveXml(store, "payment-type-tabs", xml);
      addStep(steps, "결제 타입 탭 영역 확인");
      return xml;
    }

    if (
      paymentMethod === "card" &&
      isPaymentMethodReady(xml, paymentMethod)
    ) {
      saveXml(store, "payment-method", xml);
      addStep(steps, "결제 방법 영역 확인");
      return xml;
    }

    if (
      paymentMethod === "bank-transfer" &&
      hasPaymentTypeTabsClippedAtTop(xml) &&
      hasPaymentMethodSection(xml)
    ) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "850", "540", "1350", "250"]);
      await new Promise((resolve) => setTimeout(resolve, 180));
      xml = await dumpUiStable(config, device);
      continue;
    }

    const swipeArgs = paymentMethod === "bank-transfer"
      ? ["shell", "input", "swipe", "540", "1880", "540", "870", "180"]
      : ["shell", "input", "swipe", "540", "1900", "540", "760", "180"];
    await runAdb(config, device, swipeArgs);
    await new Promise((resolve) => setTimeout(resolve, 140));
    xml = await dumpUiStable(config, device);
  }

  if (paymentMethod === "bank-transfer" && isPaymentMethodReady(xml, paymentMethod)) {
    saveXml(store, "payment-type-tabs", xml);
    addStep(steps, "결제 타입 탭 영역 확인");
    return xml;
  }

  if (paymentMethod === "card" && isPaymentMethodReady(xml, paymentMethod)) {
    saveXml(store, "payment-method", xml);
    addStep(steps, "결제 방법 영역 확인");
    return xml;
  }

  await saveFailureArtifacts(config, device, store, "payment-method-not-found", xml);
  fail(
    paymentMethod === "bank-transfer"
      ? "계약 상세 화면에서 결제 타입 탭 영역을 찾지 못했습니다."
      : "계약 상세 화면에서 결제 방법 영역을 찾지 못했습니다.",
    steps,
    paymentMethod === "bank-transfer"
      ? [
        "상세 화면을 아래로 스크롤했지만 '신용 / 체크 카드'와 '무통장 입금' 탭이 실제 화면 좌표로 확인되지 않았습니다.",
        "리포트의 payment-method-not-found.png 화면을 확인해주세요."
      ]
      : [
        "상세 화면을 아래로 스크롤했지만 '결제 방법', '신용·체크카드 결제 수단 선택됨', '더보기 버튼'이 확인되지 않았습니다.",
        "리포트의 payment-method-not-found.png 화면을 확인해주세요."
      ]
  );
}

async function scrollUntil(config, device, store, steps, predicate, artifactName, failMessage, details) {
  let xml = await dumpUiStable(config, device);
  for (let count = 0; count < 12; count += 1) {
    if (predicate(xml)) {
      saveXml(store, artifactName, xml);
      return xml;
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1850", "540", "900", "170"]);
    await new Promise((resolve) => setTimeout(resolve, 140));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, artifactName, xml);
  fail(failMessage, steps, details);
}

async function clearAndInput(config, device, node, value, label, steps) {
  await tapNode(config, device, node, label, steps);
  await runAdb(config, device, ["shell", "input", "keyevent", "--longpress", "67"]);
  await inputText(config, device, value);
}

async function inputDigitsWithKeyEvents(config, device, value) {
  const digitToKeyCode = {
    0: "7",
    1: "8",
    2: "9",
    3: "10",
    4: "11",
    5: "12",
    6: "13",
    7: "14",
    8: "15",
    9: "16"
  };

  for (const digit of String(value)) {
    await keyEvent(config, device, digitToKeyCode[digit]);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}

async function clearAndInputDigits(config, device, node, value, label, steps) {
  await tapNode(config, device, node, label, steps);
  await runAdb(config, device, ["shell", "input", "keyevent", "--longpress", "67"]);
  await inputDigitsWithKeyEvents(config, device, value);
}

async function chooseJcbAndSubmit(config, device, store, steps, xml) {
  if (!hasVisibleCardPaymentMethodSection(xml)) {
    await saveFailureArtifacts(config, device, store, "card-payment-method-not-visible", xml);
    fail(
      "계약 상세 화면에서 신용·체크카드 결제 방법 영역을 찾지 못했습니다.",
      steps,
      [
        "카드 결제는 신용·체크카드 선택 상태와 더보기 버튼이 보여야 합니다.",
        "리포트의 card-payment-method-not-visible.png 화면을 확인해주세요."
      ]
    );
  }

  const moreButton = findNode(xml, "더보기 버튼", {
    visible: true,
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, moreButton, "더보기 버튼", steps);
  addStep(steps, "결제 카드 더보기 선택");

  xml = await waitForUi(config, device, (nextXml) => nextXml.includes("JCB 카드"), 8000);
  saveXml(store, "payment-method-expanded", xml);

  if (!hasJcbSelected(xml)) {
    const jcbResult = await scrollJcbCardIntoView(config, device, store, xml);
    xml = jcbResult.xml;
    saveXml(store, "payment-method-jcb-visible", xml);
    const jcbButton = jcbResult.node;
    await tapNode(config, device, jcbButton, "JCB 카드", steps);
    addStep(steps, "JCB 카드 선택");

    xml = await waitForUi(
      config,
      device,
      (nextXml) => hasJcbSelected(nextXml) || isPgPaymentScreen(nextXml),
      8000
    );
  } else {
    addStep(steps, "JCB 카드 선택", "pass", "이미 JCB 카드가 선택된 상태");
  }

  saveXml(store, "payment-method-jcb", xml);

  if (isPgPaymentScreen(xml)) {
    addStep(steps, "결제하기 버튼 탭", "pass", "JCB 선택 후 PG 결제 화면으로 이동");
    saveXml(store, "pg-payment-start", xml);
    return xml;
  }

  if (!hasJcbSelected(xml)) {
    await saveFailureArtifacts(config, device, store, "jcb-not-selected", xml);
    fail(
      "JCB 카드 선택 상태를 확인하지 못했습니다.",
      steps,
      [
        "더보기 후 JCB 카드를 눌렀지만 'JCB 카드 선택됨' 문구가 확인되지 않았습니다.",
        "리포트의 jcb-not-selected.png 화면을 확인해주세요."
      ]
    );
  }

  const payButton = findNode(xml, "결제하기", {
    visible: true,
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, payButton, "결제하기 버튼", steps);
  addStep(steps, "결제하기 버튼 탭");

  xml = await waitForUi(config, device, isPgPaymentScreen, 20000);
  saveXml(store, "pg-payment-start", xml);
  if (!isPgPaymentScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "pg-payment-not-found", xml);
    fail(
      "PG사 결제 화면으로 이동하지 못했습니다.",
      steps,
      [
        "결제하기 버튼을 눌렀지만 Payment information, Card number, Expiry date, Next가 확인되지 않았습니다.",
        "리포트의 pg-payment-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

function findEditableBelowLabel(xml, label, options = {}) {
  const labelNode = findNode(xml, label, { visible: true });
  const editables = findEditableNodes(xml)
    .filter((node) => {
      if (!isVisibleNode(node)) return false;
      if (options.excludeEmail && nodeLabel(node).includes("@")) return false;
      if (!labelNode?.bounds) return true;
      return node.bounds.top >= labelNode.bounds.bottom - 20;
    })
    .sort((leftNode, rightNode) => {
      const labelY = labelNode?.bounds?.y || 0;
      return Math.abs(leftNode.bounds.y - labelY) - Math.abs(rightNode.bounds.y - labelY);
    });

  return editables[0];
}

function findEditableBesideLabel(xml, label, options = {}) {
  const labelNode = findNode(xml, label, { visible: true });
  if (!labelNode?.bounds) return null;

  return findEditableNodes(xml)
    .filter((node) => {
      if (!isVisibleNode(node)) return false;
      if (options.excludeEmail && nodeLabel(node).includes("@")) return false;
      return (
        node.bounds.left >= labelNode.bounds.right - 10 &&
        Math.abs(node.bounds.y - labelNode.bounds.y) <= 120
      );
    })
    .sort((leftNode, rightNode) => {
      return Math.abs(leftNode.bounds.y - labelNode.bounds.y) - Math.abs(rightNode.bounds.y - labelNode.bounds.y);
    })[0] || null;
}

function hasTextInEditableBesideLabel(xml, label, expectedValue) {
  const node = findEditableBesideLabel(xml, label, { excludeEmail: true }) ||
    findEditableBelowLabel(xml, label, { excludeEmail: true });
  return Boolean(node && nodeLabel(node).includes(expectedValue));
}

function findCashReceiptPhoneInput(xml) {
  const heading = findNode(xml, ["현금영수증", "현금 영수증"], { visible: true });
  const issueButton = findNode(xml, "발급 요청", { visible: true });
  if (!heading?.bounds || !issueButton?.bounds) return null;

  return findEditableNodes(xml)
    .filter((node) => (
      isVisibleNode(node) &&
      !nodeLabel(node).includes("@") &&
      node.bounds.top >= heading.bounds.bottom &&
      node.bounds.bottom <= issueButton.bounds.top + 20
    ))
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0] || null;
}

function findCashReceiptPhoneValueNode(xml) {
  const heading = findNode(xml, ["현금영수증", "현금 영수증"], { visible: true });
  const issueButton = findNode(xml, "발급 요청", { visible: true });
  if (!heading?.bounds || !issueButton?.bounds) return null;

  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      !nodeLabel(node).includes("@") &&
      nodeLabel(node).includes("01000000000") &&
      node.bounds.top >= heading.bounds.bottom &&
      node.bounds.bottom <= issueButton.bounds.top + 80
    ))
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0] || null;
}

function findEnabledCashReceiptIssueButton(xml) {
  return findNode(xml, "발급 요청", {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function hasVisibleRefundAccountSection(xml) {
  return Boolean(
    findNode(xml, ["환불/보증금 반환 계좌", "보증금 반환 계좌", "환불 계좌"], { visible: true }) &&
      findNode(xml, ["은행 선택", "은행"], { visible: true }) &&
      findNode(xml, "계좌번호", { visible: true })
  );
}

function findRefundAccountInput(xml) {
  return findEditableBesideLabel(xml, "계좌번호", { excludeEmail: true }) ||
    findEditableBelowLabel(xml, "계좌번호", { excludeEmail: true });
}

async function bringRefundAccountInputIntoSafeView(config, device, xml) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const accountInput = findRefundAccountInput(xml);
    if (accountInput?.bounds && accountInput.bounds.top >= 900 && accountInput.bounds.bottom <= 2050) {
      return xml;
    }

    if (!accountInput?.bounds || accountInput.bounds.bottom > 2050) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "2040", "540", "1650", "140"]);
    } else if (accountInput.bounds.top < 900) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1000", "540", "1300", "140"]);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    xml = await dumpUiStable(config, device);
  }

  return xml;
}

function isCashReceiptAlreadyIssued(xml) {
  const issueButton = findNode(xml, "발급 요청", { visible: true });
  return Boolean(
    findCashReceiptPhoneValueNode(xml) &&
      issueButton?.bounds &&
      issueButton.attrs.enabled !== "true" &&
      (xml.includes("환불") || xml.includes("보증금"))
  );
}

function isCashReceiptIssueCompleted(xml) {
  return isCashReceiptAlreadyIssued(xml) ||
    (!findEnabledCashReceiptIssueButton(xml) && !findCashReceiptPhoneInput(xml));
}

async function selectBankTransferMethod(config, device, store, steps, xml) {
  const bankMethod = findVisibleBankTransferTypeTab(xml);

  if (!bankMethod?.bounds) {
    await saveFailureArtifacts(config, device, store, "bank-transfer-method-not-found", xml);
    fail(
      "결제 타입 영역에서 무통장 입금 탭을 찾지 못했습니다.",
      steps,
      [
        "결제 타입 영역에는 신용 / 체크 카드와 무통장 입금 탭이 실제 화면 좌표로 보여야 합니다.",
        "리포트의 bank-transfer-method-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, bankMethod, "무통장 입금 탭", steps);
  addStep(steps, "무통장 입금 탭 선택");

  xml = await waitForUi(config, device, hasBankTransferSelected, 4000);
  saveXml(store, "payment-method-bank-transfer", xml);
  if (!hasBankTransferSelected(xml)) {
    await saveFailureArtifacts(config, device, store, "bank-transfer-form-not-found", xml);
    fail(
      "무통장 입금 선택 후 입력 폼을 확인하지 못했습니다.",
      steps,
      [
        "무통장 입금 선택 후 현금영수증, 환불/보증금 반환 계좌 입력 영역이 보여야 합니다.",
        "리포트의 bank-transfer-form-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function fillCashReceipt(config, device, store, steps, xml) {
  xml = await scrollUntil(
    config,
    device,
    store,
    steps,
    (nextXml) => (
      (nextXml.includes("현금영수증") || nextXml.includes("현금 영수증")) &&
      findNode(nextXml, "개인", { visible: true })
    ),
    "cash-receipt-section",
    "현금영수증 개인 선택 영역을 찾지 못했습니다.",
    [
      "무통장 입금 폼에서 현금영수증 영역과 개인 선택 버튼을 찾습니다.",
      "리포트의 cash-receipt-section.png 화면을 확인해주세요."
    ]
  );

  const personal = findNode(xml, "개인", {
    visible: true,
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, personal, "현금영수증 개인", steps);
  addStep(steps, "현금영수증 개인 선택");
  xml = await waitForUi(
    config,
    device,
    (nextXml) => Boolean(findCashReceiptPhoneInput(nextXml) || isCashReceiptAlreadyIssued(nextXml)),
    2500
  );

  if (isCashReceiptAlreadyIssued(xml)) {
    addStep(steps, "현금영수증 휴대폰 번호 입력", "pass", "01000000000");
    addStep(steps, "현금영수증 발급 요청 완료", "pass", "이미 발급 요청 완료 상태");
    return xml;
  }

  const phoneInput = findCashReceiptPhoneInput(xml);
  if (!phoneInput?.bounds) {
    await saveFailureArtifacts(config, device, store, "cash-receipt-phone-not-found", xml);
    fail(
      "현금영수증 휴대폰 번호 입력칸을 찾지 못했습니다.",
      steps,
      [
        "현금영수증 개인 선택 후 휴대폰 번호 텍스트 박스가 보여야 합니다.",
        "리포트의 cash-receipt-phone-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await clearAndInput(config, device, phoneInput, "01000000000", "현금영수증 휴대폰 번호", steps);
  addStep(steps, "현금영수증 휴대폰 번호 입력", "pass", "01000000000");
  xml = await hideKeyboard(config, device);

  xml = await waitForUi(
    config,
    device,
    (nextXml) => Boolean(findEnabledCashReceiptIssueButton(nextXml) || isCashReceiptAlreadyIssued(nextXml)),
    2500
  );
  if (isCashReceiptAlreadyIssued(xml)) {
    addStep(steps, "현금영수증 발급 요청 완료", "pass", "이미 발급 요청 완료 상태");
    return xml;
  }

  let issueButton = findEnabledCashReceiptIssueButton(xml);
  if (!issueButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "cash-receipt-issue-disabled", xml);
    fail(
      "현금영수증 발급 요청 버튼이 활성화되지 않았습니다.",
      steps,
      [
        "휴대폰 번호 입력 후 발급 요청 버튼이 활성 상태가 되어야 합니다.",
        "리포트의 cash-receipt-issue-disabled.png 화면을 확인해주세요."
      ]
    );
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await tapNode(config, device, issueButton, "현금영수증 발급 요청 버튼", steps);
    xml = await waitForUi(config, device, isCashReceiptIssueCompleted, 2500);
    if (isCashReceiptIssueCompleted(xml)) break;

    xml = await hideKeyboard(config, device);
    issueButton = findEnabledCashReceiptIssueButton(xml);
    if (!issueButton?.bounds) break;
  }

  if (!isCashReceiptIssueCompleted(xml)) {
    await saveFailureArtifacts(config, device, store, "cash-receipt-issue-not-completed", xml);
    fail(
      "현금영수증 발급 요청이 완료되지 않았습니다.",
      steps,
      [
        "휴대폰 번호 입력 후 발급 요청 버튼을 눌렀지만 버튼이 계속 활성 상태로 남아 있습니다.",
        "리포트의 cash-receipt-issue-not-completed.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "현금영수증 발급 요청 완료");

  return xml;
}

async function selectBank(config, device, store, steps, xml) {
  const bankSelect = findNode(xml, "은행 선택", {
    visible: true,
    clickable: true,
    enabled: true
  }) || findNode(xml, "은행", {
    visible: true,
    clickable: true,
    enabled: true
  });

  if (!bankSelect?.bounds) {
    await saveFailureArtifacts(config, device, store, "refund-bank-select-not-found", xml);
    fail(
      "환불/보증금 반환 계좌 영역에서 은행 선택 버튼을 찾지 못했습니다.",
      steps,
      [
        "무통장 입금 결제에는 환불/보증금 반환 계좌의 은행 선택이 필요합니다.",
        "리포트의 refund-bank-select-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, bankSelect, "은행 선택", steps);
  addStep(steps, "환불/보증금 반환 은행 선택 열기");
  xml = await waitForUi(
    config,
    device,
    (nextXml) => nextXml.includes("기업은행") || nextXml.includes("IBK기업은행"),
    4000
  );
  saveXml(store, "refund-bank-dropdown", xml);

  const ibk = findNode(xml, ["IBK기업은행", "기업은행"], {
    visible: true,
    enabled: true
  });
  await tapNode(config, device, ibk, "기업은행", steps);
  addStep(steps, "기업은행 선택");
  await new Promise((resolve) => setTimeout(resolve, 250));

  return dumpUiStable(config, device);
}

async function fillRefundAccount(config, device, store, steps, xml) {
  xml = await scrollUntil(
    config,
    device,
    store,
    steps,
    hasVisibleRefundAccountSection,
    "refund-account-section",
    "환불/보증금 반환 계좌 영역을 찾지 못했습니다.",
    [
      "무통장 입금 폼 하단에서 은행, 계좌번호, 예금주 확인 영역을 찾습니다.",
      "리포트의 refund-account-section.png 화면을 확인해주세요."
    ]
  );

  xml = await selectBank(config, device, store, steps, xml);
  xml = await bringRefundAccountInputIntoSafeView(config, device, xml);
  const accountInput = findRefundAccountInput(xml);
  if (!accountInput?.bounds) {
    await saveFailureArtifacts(config, device, store, "refund-account-number-not-found", xml);
    fail(
      "환불/보증금 반환 계좌번호 입력칸을 찾지 못했습니다.",
      steps,
      [
        "기업은행 선택 후 계좌번호 텍스트 박스가 보여야 합니다.",
        "리포트의 refund-account-number-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await clearAndInputDigits(config, device, accountInput, "34108755301018", "환불 계좌번호", steps);
  xml = await waitForUi(
    config,
    device,
    (nextXml) => hasTextInEditableBesideLabel(nextXml, "계좌번호", "34108755301018"),
    2500
  );
  if (!hasTextInEditableBesideLabel(xml, "계좌번호", "34108755301018")) {
    await saveFailureArtifacts(config, device, store, "refund-account-number-input-failed", xml);
    fail(
      "환불 계좌번호가 실제 입력되지 않았습니다.",
      steps,
      [
        "계좌번호 입력칸을 탭한 뒤 숫자 키이벤트로 입력했지만 화면에서 34108755301018 값을 확인하지 못했습니다.",
        "리포트의 refund-account-number-input-failed.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "환불 계좌번호 입력", "pass", "34108755301018");
  xml = await bringHolderCheckIntoSafeView(config, device);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    xml = await bringHolderCheckIntoSafeView(config, device);
    const holderCheck = findHolderCheckButton(xml);
    if (!holderCheck?.bounds) {
      await saveFailureArtifacts(config, device, store, "account-holder-check-not-ready", xml);
      fail(
        "예금주 확인 버튼이 활성화되지 않았습니다.",
        steps,
        [
          "은행 선택과 계좌번호 입력 후 예금주 확인 버튼이 눌릴 수 있는 상태가 되어야 합니다.",
          "리포트의 account-holder-check-not-ready.png 화면을 확인해주세요."
        ]
      );
    }

    xml = await hideKeyboard(config, device);
    const refreshedHolderCheck = findNode(xml, ["예금주 확인", "예금 주 확인"], {
      visible: true,
      clickable: true,
      enabled: true
    }) || holderCheck;
    await tapNode(config, device, refreshedHolderCheck, "예금주 확인 버튼", steps);
    xml = await waitForUi(config, device, (nextXml) => (
      isAccountHolderConfirmDialog(nextXml) ||
      hasRefundAccountVerified(nextXml) ||
      hasRefundAccountRequiredError(nextXml)
    ), 3000);
    if (isAccountHolderConfirmDialog(xml) || hasRefundAccountVerified(xml) || hasRefundAccountRequiredError(xml)) break;
  }
  saveXml(store, "account-holder-confirm-dialog", xml);

  if (isAccountHolderConfirmDialog(xml)) {
    addStep(steps, "예금주 확인 팝업 확인");
    const confirmButton = findExactNode(xml, "확인", {
      visible: true,
      clickable: true,
      enabled: true
    });
    await tapNode(config, device, confirmButton, "예금주 확인 팝업 확인 버튼", steps);
    addStep(steps, "예금주 확인 팝업 확인 버튼 탭");
    xml = await waitForUi(config, device, (nextXml) => !isAccountHolderConfirmDialog(nextXml), 4000);
  }

  saveXml(store, "account-holder-checked", xml);

  if (!hasRefundAccountVerified(xml) || hasRefundAccountRequiredError(xml)) {
    await saveFailureArtifacts(config, device, store, "account-holder-check-failed", xml);
    fail(
      "예금주 확인이 완료되지 않았습니다.",
      steps,
      [
        "예금주 확인 버튼을 누른 뒤 확인 완료 상태가 되어야 합니다.",
        "예금주 확인 버튼이 그대로 보이거나 계좌 정보 입력 오류가 나오면 실패 처리합니다.",
        "리포트의 account-holder-check-failed.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "예금주 확인 완료");

  const saveButton = findVisibleSaveRefundAccountButton(xml);
  if (saveButton?.bounds) {
    await tapNode(config, device, saveButton, "환불 계좌 저장 버튼", steps);
    addStep(steps, "환불 계좌 저장 버튼 탭");
    xml = await waitForUi(
      config,
      device,
      (nextXml) => !findVisibleSaveRefundAccountButton(nextXml),
      6000
    );
    if (findVisibleSaveRefundAccountButton(xml)) {
      await saveFailureArtifacts(config, device, store, "refund-account-save-failed", xml);
      fail(
        "환불/보증금 반환 계좌 저장이 완료되지 않았습니다.",
        steps,
        [
          "예금주 확인 후 저장 버튼을 눌렀지만 저장 버튼이 계속 보입니다.",
          "저장이 완료되어야 하단 결제하기를 진행할 수 있습니다.",
          "리포트의 refund-account-save-failed.png 화면을 확인해주세요."
        ]
      );
    }
    addStep(steps, "환불 계좌 저장 완료");
  }

  return xml;
}

async function submitBankTransferPayment(config, device, store, steps, xml) {
  xml = await selectBankTransferMethod(config, device, store, steps, xml);
  xml = await fillCashReceipt(config, device, store, steps, xml);
  xml = await fillRefundAccount(config, device, store, steps, xml);

  xml = await scrollUntil(
    config,
    device,
    store,
    steps,
    (nextXml) => Boolean(findNode(nextXml, "결제하기", {
      visible: true,
      clickable: true,
      enabled: true
    })),
    "bank-transfer-submit-ready",
    "무통장 입금 결제하기 버튼을 찾지 못했습니다.",
    [
      "현금영수증과 환불/보증금 반환 계좌 입력 후 하단 결제하기 버튼이 보여야 합니다.",
      "리포트의 bank-transfer-submit-ready.png 화면을 확인해주세요."
    ]
  );

  const payButton = findNode(xml, "결제하기", {
    visible: true,
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, payButton, "결제하기 버튼", steps);
  addStep(steps, "무통장 입금 결제하기 버튼 탭");

  xml = await waitForUi(config, device, (nextXml) => (
    isBankTransferPaymentComplete(nextXml) || hasRefundAccountRequiredError(nextXml)
  ), 12000);
  saveXml(store, "payment-complete", xml);

  if (!isBankTransferPaymentComplete(xml) || hasRefundAccountRequiredError(xml)) {
    await saveFailureArtifacts(config, device, store, "payment-complete-not-found", xml);
    fail(
      "무통장 입금 결제 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        "현금영수증, 은행, 계좌번호, 예금주 확인, 저장, 결제하기 버튼 처리 후 실제 무통장 입금 안내 화면이 보여야 합니다.",
        "무통장 결제 완료 화면에는 입금해주세요, 무통장 입금 정보, 예금주, 계좌 번호, 입금액, 홈으로 가기가 보여야 합니다.",
        "리포트의 payment-complete-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "무통장 입금 안내 완료 화면 확인");

  return returnHomeFromPaymentComplete(config, device, store, steps, xml, "payment");
}

async function inputPgCard(config, device, store, steps, xml) {
  let { cardFields, expiryField } = findPgPaymentFields(xml);

  if (cardFields.length < 4 || !expiryField) {
    await saveFailureArtifacts(config, device, store, "pg-inputs-not-found", xml);
    fail(
      "PG 결제 화면에서 카드번호/만료일 입력칸을 찾지 못했습니다.",
      steps,
      [
        `찾은 카드번호 칸: ${cardFields.length}/4`,
        `만료일 칸 확인: ${expiryField ? "Y" : "N"}`,
        "리포트의 pg-inputs-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const cardParts = ["3530", "1113", "3330", "0000"];
  for (let index = 0; index < cardParts.length; index += 1) {
    xml = await dumpUiStable(config, device);
    ({ cardFields } = findPgPaymentFields(xml));
    const field = cardFields[index];
    if (!field?.bounds) {
      await saveFailureArtifacts(config, device, store, "pg-card-field-missing", xml);
      fail(`PG 카드번호 ${index + 1}번째 입력칸을 찾지 못했습니다.`, steps);
    }

    if (index === 0 || index === 3) {
      await inputSecureKeypadDigits(config, device, store, cardParts[index], index, steps);
    } else {
      await tap(config, device, field.bounds.x, field.bounds.y);
      await inputText(config, device, cardParts[index]);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  addStep(steps, "PG 카드 번호 입력");

  xml = await dumpUiStable(config, device);
  ({ expiryField } = findPgPaymentFields(xml));
  if (!expiryField?.bounds) {
    await saveFailureArtifacts(config, device, store, "pg-expiry-field-missing", xml);
    fail("PG 만료일 입력칸을 찾지 못했습니다.", steps);
  }

  await tap(config, device, expiryField.bounds.x, expiryField.bounds.y);
  await inputText(config, device, "0328");
  addStep(steps, "PG 만료일 입력");

  xml = await waitForUi(config, device, isPgPaymentScreen, 8000);
  saveXml(store, "pg-payment-after-card", xml);

  if (!isPgPaymentScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "pg-left-after-card-input", xml);
    fail(
      "카드 정보 입력 후 PG 결제 화면을 유지하지 못했습니다.",
      steps,
      [
        "카드번호와 만료일 입력 후 Payment information/Card number/Expiry date/Next가 다시 확인되어야 합니다.",
        "리포트의 pg-left-after-card-input.png 화면을 확인해주세요."
      ]
    );
  }

  const requiredCheckbox = findNode(xml, "[Required]", {
    visible: true,
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, requiredCheckbox, "[Required] 동의 항목", steps);
  addStep(steps, "PG 필수 동의 선택");

  await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "1850", "250"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  xml = await waitForUi(config, device, (nextXml) => nextXml.includes("Next"), 5000);

  const nextButton = findNode(xml, "Next", {
    visible: true,
    clickable: true,
    enabled: true
  });
  await tapNode(config, device, nextButton, "NEXT 버튼", steps);
  addStep(steps, "PG NEXT 버튼 탭");

  xml = await waitForUi(config, device, isPaymentComplete, 20000);
  saveXml(store, "payment-final", xml);

  if (!isPaymentComplete(xml)) {
    await saveFailureArtifacts(config, device, store, "payment-final", xml);
    fail(
      "PG NEXT 이후 결제 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        "카드 번호, 만료일, 필수 동의, NEXT 버튼은 처리했습니다.",
        "결제 완료/계약 확정 문구가 확인되지 않았습니다.",
        "리포트의 payment-final.png 화면을 확인해주세요."
      ]
    );
  }

  return returnHomeFromPaymentComplete(config, device, store, steps, xml, "card-payment");
}

async function runContractPaymentTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const paymentMethod = request.payment_method || "card";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("계약 결제는 guest role에서만 실행할 수 있습니다.");
  if (!["card", "bank-transfer"].includes(paymentMethod)) {
    throw new Error(`Unknown payment method: ${paymentMethod}`);
  }
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    let xml = await openPaymentDetailFromHome(config, device, store, steps);
    xml = await scrollToPaymentMethod(config, device, store, steps, paymentMethod);
    if (paymentMethod === "card") {
      xml = await chooseJcbAndSubmit(config, device, store, steps, xml);
      xml = await inputPgCard(config, device, store, steps, xml);
    } else {
      xml = await submitBankTransferPayment(config, device, store, steps, xml);
    }

    addStep(steps, "계약 결제 완료 확인");

    return {
      test_id: "TC-CONTRACT-PAYMENT-001",
      name: "guest 계약 결제",
      env,
      status: "pass",
      device,
      steps,
      payment_conditions: {
        method: paymentMethod === "card" ? "신용·체크카드" : "무통장 입금",
        ...(paymentMethod === "card"
          ? {
            card_brand: "JCB",
            card_number: "3530 **** **** 0000",
            expiry: "03/28"
          }
          : {
            cash_receipt_type: "개인",
            cash_receipt_phone: "01000000000",
            refund_bank: "기업은행",
            refund_account: "34108755301018",
            toss_approval_target: extractBankTransferApprovalTarget(store)
          })
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "payment-home-after-refresh.xml"),
          path.join(store.logsDir, paymentMethod === "card" ? "payment-method-jcb.xml" : "payment-method-bank-transfer.xml"),
          path.join(store.logsDir, "cash-receipt-section.xml"),
          path.join(store.logsDir, "refund-account-section.xml"),
          path.join(store.logsDir, "account-holder-checked.xml"),
          path.join(store.logsDir, "pg-payment-start.xml"),
          path.join(store.logsDir, "payment-final.xml"),
          path.join(store.logsDir, "payment-complete.xml"),
          path.join(store.logsDir, "payment-return-home.xml")
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

module.exports = {
  runContractPaymentTest
};
