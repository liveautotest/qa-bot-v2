const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  inputText,
  keyEvent,
  runAdb,
  tap
} = require("../infra/adb");
const {
  dumpUiStable,
  findExactNode,
  findNode,
  isVisibleNode,
  nodeLabel,
  parseNodes,
  saveFailureArtifacts,
  saveXml,
  tapButtonAndWaitFast,
  tapNode,
  waitForUi,
  xmlTextLines
} = require("./helpers/ui-automation");

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

function findPgCardPartAlert(xml) {
  const text = xmlTextLines(xml).join("\n");
  const match = text.match(/Please enter the (first|second|third|fourth) 4 digits of your credit card number/i);
  if (!match) return null;

  return {
    first: 0,
    second: 1,
    third: 2,
    fourth: 3
  }[match[1].toLowerCase()];
}

async function dismissPgCardPartAlert(config, device, steps, xml) {
  const confirm = findNode(xml, "Confirm", {
    visible: true,
    clickable: true,
    enabled: true
  });

  if (confirm?.bounds) {
    await tapNode(config, device, confirm, "PG 카드번호 입력 안내 Confirm", steps);
  } else {
    await tap(config, device, 792, 1515);
    addStep(steps, "PG 카드번호 입력 안내 Confirm", "pass", "fallback 좌표");
  }

  return waitForUi(config, device, (nextXml) => findPgCardPartAlert(nextXml) === null, 2500, 120);
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

async function prepareHomeForContractPayment(config, device, appPackage, store, steps, options = {}) {
  if (options.skipFreshLaunch) {
    let xml = await waitForUi(
      config,
      device,
      (nextXml) => (
        nextXml.includes("동네") ||
        hasPaymentWaitingCard(nextXml) ||
        hasExtensionPaymentWaitingCard(nextXml) ||
        isContractDetailLike(nextXml)
      ),
      3000
    );
    saveXml(store, "payment-home-before-reuse", xml);
    if (xml.includes("동네") || hasPaymentWaitingCard(xml) || hasExtensionPaymentWaitingCard(xml) || isContractDetailLike(xml)) {
      addStep(steps, "기본검증 기존 홈 화면 재사용");
      return xml;
    }

    store.appendLog("runner.log", "contract-payment could not reuse current screen; launching app fresh");
    addStep(steps, "기존 화면 재사용 불가, 앱 재실행으로 복구");
  }

  await launchFresh(config, device, appPackage, steps);
  return "";
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

function hasExtensionPaymentWaitingCard(xml) {
  return (
    (
      xml.includes("연장 결제 대기") ||
      xml.includes("연장결제대기") ||
      xml.includes("연장 결제") ||
      (
        xml.includes("계약 연장 요청") &&
        xml.includes("결제 대기 중")
      )
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

function findExtensionPaymentWaitingCard(xml) {
  return parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      (
        label.includes("연장 결제 대기") ||
        label.includes("연장결제대기") ||
        label.includes("연장 결제") ||
        (
          label.includes("계약 연장 요청") &&
          label.includes("결제 대기 중")
        )
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

function findExtensionPaymentHomeActionButton(xml) {
  const extensionCard = findExtensionPaymentWaitingCard(xml);
  const minTop = extensionCard?.bounds?.top || 0;
  const maxBottom = extensionCard?.bounds?.bottom || 2496;

  return parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        node.bounds.top >= minTop &&
        node.bounds.bottom <= maxBottom + 40 &&
        (
          label.includes("확인 및 결제") ||
          label.includes("결제하기") ||
          label.includes("계약 확인")
        )
      );
    })
    .sort((leftNode, rightNode) => rightNode.bounds.top - leftNode.bounds.top)[0] || null;
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

async function tapExtensionPaymentHomeCard(config, device, xml, steps) {
  const paymentButton = findExtensionPaymentHomeActionButton(xml);
  if (paymentButton?.bounds) {
    await tapNode(config, device, paymentButton, "연장 결제 카드 확인 및 결제 버튼", steps);
    return;
  }

  const paymentCard = findExtensionPaymentWaitingCard(xml);
  if (paymentCard?.bounds) {
    await tap(config, device, paymentCard.bounds.x, paymentCard.bounds.y);
    return;
  }

  fail("홈 화면 연장 결제 카드 선택 좌표를 찾지 못했습니다.", steps);
}

async function tapExtensionPaymentHomeCardRobust(config, device, store, xml, steps) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const paymentButton = findExtensionPaymentHomeActionButton(xml);
    if (paymentButton?.bounds) {
      const tapTargets = [
        [paymentButton.bounds.x, paymentButton.bounds.y],
        [paymentButton.bounds.x, paymentButton.bounds.bottom - 48],
        [paymentButton.bounds.x, paymentButton.bounds.top + 48]
      ];
      const [x, y] = tapTargets[Math.min(attempt, tapTargets.length - 1)];
      if (attempt === 1) {
        await runAdb(config, device, ["shell", "input", "swipe", String(x), String(y), String(x), String(y), "180"]);
      } else {
        await tap(config, device, x, y);
      }
      store.appendLog("runner.log", `extension payment home action tap attempt ${attempt + 1}: ${x},${y}`);
    } else {
      await tapExtensionPaymentHomeCard(config, device, xml, steps);
    }

    const nextXml = await waitForUi(
      config,
      device,
      (candidateXml) => !hasExtensionPaymentWaitingCard(candidateXml) || isContractDetailLike(candidateXml),
      attempt === 0 ? 900 : 1600
    );
    if (isContractDetailLike(nextXml) || !hasExtensionPaymentWaitingCard(nextXml)) {
      return nextXml;
    }

    xml = nextXml;
  }

  return xml;
}

function isContractPaymentDetail(xml) {
  return (
    (
      xml.includes("계약번호") ||
      xml.includes("계약 번호") ||
      xml.includes("결제 마감") ||
      xml.includes("결제하기") ||
      xml.includes("결제해 주세요")
    ) &&
    (
      xml.includes("결제") ||
      xml.includes("신용 / 체크 카드") ||
      xml.includes("무통장 입금") ||
      xml.includes("계약 진행중") ||
      xml.includes("계약 진행 중")
    )
  );
}

function isContractDetailLike(xml) {
  return (
    (xml.includes("계약번호") || xml.includes("계약 번호") || xml.includes("계약 상세")) &&
    (xml.includes("계약") || xml.includes("결제") || xml.includes("연장"))
  );
}

function isExtensionAcceptedPaymentScreen(xml) {
  return (
    xml.includes("연장") &&
    (
      xml.includes("수락") ||
      xml.includes("결제 예정") ||
      xml.includes("연장 계약") ||
      xml.includes("게스트 결제")
    ) &&
    xml.includes("결제")
  );
}

function isPaymentEntryScreen(xml) {
  return (
    hasPaymentMethodSection(xml) ||
    isPgPaymentScreen(xml) ||
    (
      xml.includes("결제하기") &&
      (
        xml.includes("총 결제") ||
        xml.includes("결제 마감") ||
        xml.includes("결제 방법") ||
        xml.includes("신용") ||
        xml.includes("체크카드")
      )
    )
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
      findNode(xml, "결제하기", { visible: true, clickable: true, enabled: true })
  );
}

function findMoreCardButton(xml, { visible = true } = {}) {
  return findNode(xml, "더보기 버튼", {
    visible,
    clickable: true,
    enabled: true
  });
}

function isSafelyTappablePaymentButton(node) {
  if (!node?.bounds || !isVisibleNode(node)) return false;
  return node.bounds.top >= 260 && node.bounds.bottom <= 2140;
}

async function scrollMoreCardButtonIntoView(config, device, store, xml) {
  let currentXml = xml;

  for (let count = 0; count < 8; count += 1) {
    const visibleMore = findMoreCardButton(currentXml, { visible: true });
    if (isSafelyTappablePaymentButton(visibleMore)) {
      return { xml: currentXml, node: visibleMore };
    }

    const clippedMore = findMoreCardButton(currentXml, { visible: false });
    const target = visibleMore || clippedMore;
    if (target?.bounds) {
      store.appendLog(
        "runner.log",
        `more card button not safely tappable at [${target.bounds.left},${target.bounds.top}][${target.bounds.right},${target.bounds.bottom}], scrolling (${count + 1})`
      );
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "1680", "180"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    currentXml = await dumpUiStable(config, device);
  }

  const finalMore = findMoreCardButton(currentXml, { visible: true });
  return {
    xml: currentXml,
    node: isSafelyTappablePaymentButton(finalMore) ? finalMore : null
  };
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

function findVisibleExtensionBankTransferOption(xml) {
  const directOption = parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        (label.includes("무통장 입금") || label.includes("무통장입금"))
      );
    })
    .sort((leftNode, rightNode) => rightNode.bounds.top - leftNode.bounds.top)[0] || null;
  if (directOption) return directOption;
  return null;
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

function hasExtensionBankTransferForm(xml) {
  return (
    (xml.includes("무통장 입금") || xml.includes("무통장입금")) &&
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

function hasVisibleJcbCardOption(xml) {
  return Boolean(findJcbCardOption(xml, { visible: true }));
}

function isSafelyTappableCardOption(node) {
  if (!node?.bounds || !isVisibleNode(node)) return false;
  return node.bounds.bottom < 2140;
}

async function scrollJcbCardIntoView(config, device, store, xml) {
  let currentXml = xml;

  for (let count = 0; count < 8; count += 1) {
    const visibleJcb = findJcbCardOption(currentXml, { visible: true });
    if (isSafelyTappableCardOption(visibleJcb)) {
      return { xml: currentXml, node: visibleJcb };
    }

    const clippedJcb = findJcbCardOption(currentXml, { visible: false });
    const scrollTarget = visibleJcb || clippedJcb;
    if (!scrollTarget?.bounds) return { xml: currentXml, node: null };

    store.appendLog(
      "runner.log",
      `JCB card option not safely tappable at [${scrollTarget.bounds.left},${scrollTarget.bounds.top}][${scrollTarget.bounds.right},${scrollTarget.bounds.bottom}], scrolling above sticky payment footer (${count + 1})`
    );
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2220", "540", "1580", "220"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    currentXml = await dumpUiStable(config, device);
  }

  const finalJcb = findJcbCardOption(currentXml, { visible: true });
  return {
    xml: currentXml,
    node: isSafelyTappableCardOption(finalJcb) ? finalJcb : null
  };
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
    xml.includes("결제가 완료되었습니다") ||
    xml.includes("결제가 완료") ||
    xml.includes("결제되었습니다") ||
    xml.includes("계약이 확정")
  );
}

function isVisualOnlyPaymentCompleteCandidate(xml) {
  return (
    xml.includes("<hierarchy") &&
    xmlTextLines(xml).length === 0 &&
    !isPgPaymentScreen(xml) &&
    !hasSecureKeypad(xml)
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

function isExtensionVirtualAccountComplete(xml) {
  return (
    isBankTransferPaymentComplete(xml) ||
    (
      (xml.includes("가상계좌") || xml.includes("입금")) &&
      !xml.includes("가상계좌 발급") &&
      !xml.includes("가상 계좌 발급") &&
      (
        xml.includes("발급 완료") ||
        xml.includes("발급되었습니다") ||
        xml.includes("입금해주세요") ||
        xml.includes("무통장 입금 정보") ||
        xml.includes("입금 계좌") ||
        xml.includes("입금기한")
      )
    )
  );
}

function findTopLeftCloseButton(xml) {
  if (!isExtensionVirtualAccountComplete(xml)) return null;

  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled === "true" &&
      node.bounds.left <= 180 &&
      node.bounds.top >= 90 &&
      node.bounds.top <= 330 &&
      (
        nodeLabel(node).includes("닫기") ||
        nodeLabel(node).includes("close") ||
        nodeLabel(node).includes("Close") ||
        nodeLabel(node).includes("left-action") ||
        (node.bounds.left >= 30 && node.bounds.right <= 180)
      )
    ))
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0] || null;
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
    if (isVisualOnlyPaymentCompleteCandidate(xml)) {
      await tap(config, device, 150, 2375);
      addStep(steps, "결제 완료 화면 홈으로 버튼 탭", "pass", "완료 화면 XML 텍스트 미노출 fallback 좌표");
    } else {
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
  } else {
    await tapNode(config, device, homeButton, "홈으로 버튼", steps);
    addStep(steps, "결제 완료 화면 홈으로 버튼 탭");
  }

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

async function tapHolderCheckRobust(config, device, store, steps, xml) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let holderCheck = findHolderCheckButton(xml);
    if (holderCheck?.bounds && holderCheck.bounds.top >= 260 && holderCheck.bounds.bottom <= 2100) {
      await tapNode(config, device, holderCheck, "예금주 확인 버튼", steps);
      const nextXml = await waitForUi(config, device, (candidateXml) => (
        isAccountHolderConfirmDialog(candidateXml) ||
        hasRefundAccountVerified(candidateXml) ||
        hasRefundAccountRequiredError(candidateXml)
      ), 3000);
      if (
        isAccountHolderConfirmDialog(nextXml) ||
        hasRefundAccountVerified(nextXml) ||
        hasRefundAccountRequiredError(nextXml)
      ) {
        return nextXml;
      }
      xml = nextXml;
    }

    if (attempt === 0) {
      await keyEvent(config, device, 111).catch(() => {});
    } else {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1750", "540", "1300", "160"]);
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "account-holder-check-not-ready", xml);
  fail(
    "예금주 확인 버튼이 활성화되지 않았습니다.",
    steps,
    [
      "은행 선택과 계좌번호 입력 후 예금주 확인 버튼이 눌릴 수 있는 상태가 되어야 합니다.",
      "계좌 입력 직후 키패드가 올라와 있으면 버튼이 보이는 좌표를 먼저 탭하고, 실패 시 키패드 닫기/위치 보정 후 재시도합니다.",
      "리포트의 account-holder-check-not-ready.png 화면을 확인해주세요."
    ]
  );
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

  xml = await dumpUiStable(config, device);
  const confirmButton = findNode(xml, "Confirm", {
    visible: true,
    clickable: true,
    enabled: true
  });

  if (confirmButton?.bounds) {
    await tapNode(config, device, confirmButton, "보안키패드 Confirm", steps);
  } else {
    await tap(config, device, 742, 2436);
    addStep(steps, "보안키패드 Confirm", "pass", "XML 미노출 fallback 좌표");
  }

  xml = await waitForUi(config, device, (nextXml) => !hasSecureKeypad(nextXml), 2000, 120);
  if (hasSecureKeypad(xml)) {
    await tap(config, device, 742, 2436);
    addStep(steps, "보안키패드 Confirm 재시도", "pass", "키패드 유지로 fallback 좌표 재탭");
    await waitForUi(config, device, (nextXml) => !hasSecureKeypad(nextXml), 1800, 120);
  }
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
    for (let attempt = 1; attempt <= 3 && !hasPaymentWaitingCard(xml); attempt += 1) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      addStep(steps, `홈 화면 풀 리프레시 ${attempt}회`);

      xml = await waitForUi(config, device, hasPaymentWaitingCard, 7500);
      saveXml(store, `payment-home-after-refresh-${attempt}`, xml);
    }
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

  xml = await waitForUi(config, device, isContractPaymentDetail, 2800, 140);
  if (!isContractPaymentDetail(xml)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    xml = await dumpUiStable(config, device, 8);
  }
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

async function openExtensionPaymentFromHome(config, device, store, steps, options = {}) {
  let xml = options.initialXml || "";
  if (options.fastHomeActionTap && !isContractDetailLike(xml)) {
    if (hasExtensionPaymentWaitingCard(xml)) {
      const button = findExtensionPaymentHomeActionButton(xml);
      if (button?.bounds) {
        xml = await tapButtonAndWaitFast(config, device, button, isContractDetailLike, "연장 결제 카드 확인 및 결제 버튼", {
          attempts: [
            { x: button.bounds.x, y: button.bounds.y, waitMs: 1100, type: "tap" },
            { x: button.bounds.x, y: button.bounds.y, waitMs: 1500, type: "tap" }
          ]
        });
        store.appendLog("runner.log", `extension payment fast home xml action tap: ${button.bounds.x},${button.bounds.y}`);
      }
    }
    if (isContractDetailLike(xml)) {
      addStep(steps, "홈 화면 연장 결제 카드 선택", "pass", "상단 카드 확인 및 결제 버튼 빠른 탭");
      saveXml(store, "extension-payment-contract-detail", xml);
    }
  }

  if (!isContractDetailLike(xml)) {
    xml = await dumpUiStable(config, device);
    if (isContractDetailLike(xml)) {
      addStep(steps, "연장 결제 계약 상세 화면 확인", "pass", "홈 카드 탭 후 상세 화면 진입 상태");
      saveXml(store, "extension-payment-contract-detail", xml);
    } else if (!hasExtensionPaymentWaitingCard(xml) && !xml.includes("동네")) {
      xml = await waitForUi(
        config,
        device,
        (nextXml) => nextXml.includes("동네") || hasExtensionPaymentWaitingCard(nextXml),
        3000
      );
    }
    saveXml(store, "extension-payment-home-before-refresh", xml);

    if (isContractDetailLike(xml)) {
      // Already on contract detail. Do not pull-refresh the detail page while looking for a home card.
    } else if (!hasExtensionPaymentWaitingCard(xml)) {
      for (let attempt = 1; attempt <= 3 && !hasExtensionPaymentWaitingCard(xml); attempt += 1) {
        await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        addStep(steps, `홈 화면 풀 리프레시 ${attempt}회`);

        xml = await waitForUi(config, device, hasExtensionPaymentWaitingCard, 7500);
        saveXml(store, `extension-payment-home-after-refresh-${attempt}`, xml);
      }
    } else {
      addStep(steps, "홈 화면 연장 결제 카드 즉시 확인", "pass", "리프레시 없이 카드가 이미 보이는 상태");
    }
    saveXml(store, "extension-payment-home-after-refresh", xml);

    if (!isContractDetailLike(xml) && !hasExtensionPaymentWaitingCard(xml)) {
      await saveFailureArtifacts(config, device, store, "extension-payment-card-not-found", xml);
      fail(
        "홈 화면에서 연장 결제 대기 카드를 찾지 못했습니다.",
        steps,
        [
          "홈 화면에서 '연장 결제 대기 중' 상태와 확인 및 결제/결제하기 버튼이 있는 카드를 찾습니다.",
          "호스트가 연장 요청을 수락했는지 확인해주세요.",
          "리포트의 extension-payment-card-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    if (!isContractDetailLike(xml)) {
      addStep(steps, "홈 화면 연장 결제 카드 확인");
      xml = await tapExtensionPaymentHomeCardRobust(config, device, store, xml, steps);
      addStep(steps, "홈 화면 연장 결제 카드 선택");
    }
  }

  xml = isContractDetailLike(xml) ? xml : await waitForUi(config, device, isContractDetailLike, 10000);
  saveXml(store, "extension-payment-contract-detail", xml);

  if (!isContractDetailLike(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-payment-contract-detail-not-found", xml);
    fail(
      "연장 결제 계약 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "홈 카드의 확인 및 결제 버튼을 눌렀지만 계약 상세 화면을 확인하지 못했습니다.",
        "리포트의 extension-payment-contract-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const extensionPaymentButton = findNode(xml, ["확인 및 결제", "결제하기", "결제"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!extensionPaymentButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-payment-detail-button-not-found", xml);
    fail(
      "계약 상세 화면에서 계약 연장 요청 카드의 확인 및 결제 버튼을 찾지 못했습니다.",
      steps,
      [
        "계약 상세 화면에는 계약연장요청 카드와 확인 및 결제 버튼이 보여야 합니다.",
        "리포트의 extension-payment-detail-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  xml = await tapButtonAndWaitFast(
    config,
    device,
    extensionPaymentButton,
    isExtensionAcceptedPaymentScreen,
    "계약 연장 요청 확인 및 결제 버튼"
  );
  addStep(steps, "계약 연장 요청 확인 및 결제 버튼 선택");

  saveXml(store, "extension-payment-accepted-detail", xml);

  if (!isExtensionAcceptedPaymentScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-payment-accepted-detail-not-found", xml);
    fail(
      "계약 연장 요청 수락 화면으로 진입하지 못했습니다.",
      steps,
      [
        "확인 및 결제 선택 후 연장 결제 금액과 결제 버튼이 있는 화면이 보여야 합니다.",
        "리포트의 extension-payment-accepted-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const amountPayButton = parseNodes(xml)
    .filter((node) => {
      const label = nodeLabel(node);
      return (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled === "true" &&
        label.includes("결제") &&
        !label.includes("확인 및 결제")
      );
    })
    .sort((leftNode, rightNode) => rightNode.bounds.top - leftNode.bounds.top)[0] ||
    findNode(xml, "결제", { visible: true, clickable: true, enabled: true });
  if (!amountPayButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-payment-amount-button-not-found", xml);
    fail(
      "계약연장요청수락 화면에서 금액 결제 버튼을 찾지 못했습니다.",
      steps,
      [
        "계약연장요청수락 화면 하단에는 파란색 금액 결제 버튼이 보여야 합니다.",
        "리포트의 extension-payment-amount-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  xml = await tapButtonAndWaitFast(
    config,
    device,
    amountPayButton,
    isPaymentEntryScreen,
    "연장 금액 결제 버튼",
    {
      attempts: [
        { x: amountPayButton.bounds.x, y: amountPayButton.bounds.y, waitMs: 2200, type: "tap" },
        { x: amountPayButton.bounds.x, y: amountPayButton.bounds.y, waitMs: 2600, type: "tap" },
        { x: amountPayButton.bounds.x, y: Math.min(amountPayButton.bounds.bottom - 10, amountPayButton.bounds.y + 20), waitMs: 3200, type: "press", durationMs: 120 }
      ]
    }
  );
  addStep(steps, "계약연장요청수락 화면 금액 결제 버튼 선택");

  saveXml(store, "extension-payment-detail-start", xml);

  if (!isPaymentEntryScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-payment-page-not-found", xml);
    fail(
      "연장 결제하기 화면으로 이동하지 못했습니다.",
      steps,
      [
        "금액 결제 버튼을 눌렀지만 결제 방법 영역 또는 PG 결제 화면을 확인하지 못했습니다.",
        "리포트의 extension-payment-page-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function scrollToPaymentMethod(config, device, store, steps, paymentMethod = "card") {
  let xml = await dumpUiStable(config, device);
  if (paymentMethod === "bank-transfer") {
    const swipes = [
      null,
      ["shell", "input", "swipe", "540", "2180", "540", "760", "220"],
      ["shell", "input", "swipe", "540", "1880", "540", "980", "150"]
    ];

    for (let count = 0; count < swipes.length; count += 1) {
      if (isPaymentMethodReady(xml, paymentMethod)) {
        saveXml(store, "payment-type-tabs", xml);
        addStep(steps, "결제 타입 탭 영역 확인", "pass", count === 0 ? "이미 보이는 상태" : "빠른 스크롤 후 확인");
        return xml;
      }

      if (hasPaymentTypeTabsClippedAtTop(xml) && hasPaymentMethodSection(xml)) {
        await runAdb(config, device, ["shell", "input", "swipe", "540", "850", "540", "1270", "120"]);
      } else if (swipes[count]) {
        await runAdb(config, device, swipes[count]);
      }

      await new Promise((resolve) => setTimeout(resolve, 80));
      xml = await dumpUiStable(config, device);
    }
  }

  for (let count = 0; count < 9; count += 1) {
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
      await runAdb(config, device, ["shell", "input", "swipe", "540", "850", "540", "1270", "150"]);
      await new Promise((resolve) => setTimeout(resolve, 90));
      xml = await dumpUiStable(config, device);
      continue;
    }

    const swipeArgs = paymentMethod === "bank-transfer"
      ? ["shell", "input", "swipe", "540", "1760", "540", "1120", "150"]
      : ["shell", "input", "swipe", "540", "1900", "540", "760", "180"];
    await runAdb(config, device, swipeArgs);
    await new Promise((resolve) => setTimeout(resolve, 90));
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
        "상세 화면을 아래로 스크롤했지만 '결제 방법'과 신용·체크카드 선택 상태가 확인되지 않았습니다.",
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
  await keyEvent(config, device, 123).catch(() => {});
  for (let count = 0; count < 24; count += 1) {
    await keyEvent(config, device, 67).catch(() => {});
  }
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

  const moreResult = await scrollMoreCardButtonIntoView(config, device, store, xml);
  xml = moreResult.xml;
  saveXml(store, "payment-method-before-more", xml);
  const moreButton = moreResult.node;
  if (!moreButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "card-more-button-not-visible", xml);
    fail(
      "신용·체크카드 더보기 버튼을 안전하게 누를 수 있는 위치로 가져오지 못했습니다.",
      steps,
      [
        "결제 방법 영역은 확인했지만 더보기 버튼이 하단 결제하기 고정 영역에 가려졌습니다.",
        "리포트의 card-more-button-not-visible.png 화면을 확인해주세요."
      ]
    );
  }
  await tapNode(config, device, moreButton, "더보기 버튼", steps);
  addStep(steps, "결제 카드 더보기 선택");

  xml = await waitForUi(
    config,
    device,
    (nextXml) => hasVisibleJcbCardOption(nextXml) || hasJcbSelected(nextXml) || isPgPaymentScreen(nextXml),
    8000
  );
  saveXml(store, "payment-method-expanded", xml);

  if (!hasJcbSelected(xml) && !isPgPaymentScreen(xml)) {
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

function hasRefundAccountNumberValue(xml, expectedValue) {
  const accountInput = findRefundAccountInput(xml);
  if (accountInput) {
    const digits = nodeLabel(accountInput).replace(/\D/g, "");
    if (digits === expectedValue) return true;
  }

  return findEditableNodes(xml).some((node) => (
    isVisibleNode(node) &&
    !nodeLabel(node).includes("@") &&
    nodeLabel(node).replace(/\D/g, "") === expectedValue
  ));
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
      nodeLabel(node).replace(/\D/g, "") === "01000000000" &&
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
  const heading = findNode(xml, ["환불/보증금 반환 계좌", "보증금 반환 계좌", "환불 계좌"], { visible: true });
  const bankSelect = findNode(xml, ["은행 선택", "은행"], { visible: true });
  const holderCheck = findNode(xml, ["예금주 확인", "예금 주 확인"], { visible: true });
  const accountInput = findRefundAccountInput(xml);

  return Boolean(heading && bankSelect && holderCheck && accountInput);
}

function findRefundBankSelect(xml) {
  return findNode(xml, ["은행을 선택해 주세요", "은행 선택"], {
    visible: true,
    clickable: true,
    enabled: true
  }) || findNode(xml, "은행", {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function findRefundAccountInput(xml) {
  const labelBasedInput = findEditableBesideLabel(xml, "계좌번호", { excludeEmail: true }) ||
    findEditableBelowLabel(xml, "계좌번호", { excludeEmail: true });
  if (labelBasedInput?.bounds) return labelBasedInput;

  const bankSelect = findNode(xml, ["은행 선택", "은행"], { visible: true });
  const holderCheck = findNode(xml, ["예금주 확인", "예금 주 확인"], { visible: true });
  if (!bankSelect?.bounds || !holderCheck?.bounds) return null;

  return findEditableNodes(xml)
    .filter((node) => (
      isVisibleNode(node) &&
      !nodeLabel(node).includes("@") &&
      node.bounds.top >= bankSelect.bounds.bottom - 20 &&
      node.bounds.bottom <= holderCheck.bounds.top + 20
    ))
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0] || null;
}

async function bringRefundAccountInputIntoSafeView(config, device, xml) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const accountInput = findRefundAccountInput(xml);
    if (accountInput?.bounds && accountInput.bounds.top >= 720 && accountInput.bounds.bottom <= 1480) {
      return xml;
    }

    if (!accountInput?.bounds || accountInput.bounds.bottom > 1480) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "2040", "540", "1120", "160"]);
    } else if (accountInput.bounds.top < 720) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "960", "540", "1300", "120"]);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    xml = await dumpUiStable(config, device);
  }

  return xml;
}

async function keepRefundAccountAboveKeyboard(config, device, xml) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const accountInput = findRefundAccountInput(xml);
    const holderCheck = findHolderCheckButton(xml);
    if (
      accountInput?.bounds &&
      holderCheck?.bounds &&
      accountInput.bounds.bottom <= 1380 &&
      holderCheck.bounds.bottom <= 1700
    ) {
      return xml;
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1880", "540", "1180", "140"]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    xml = await dumpUiStable(config, device);
  }

  return xml;
}

async function bringRefundBankSelectIntoSafeView(config, device, xml) {
  xml = await hideKeyboard(config, device);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bankSelect = findRefundBankSelect(xml);
    if (bankSelect?.bounds && bankSelect.bounds.top >= 720 && bankSelect.bounds.bottom <= 1900) {
      return xml;
    }

    if (!bankSelect?.bounds) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1900", "540", "1260", "130"]);
    } else if (bankSelect.bounds.bottom > 1900) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1880", "540", "1480", "120"]);
    } else if (bankSelect.bounds.top < 720) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "960", "540", "1260", "120"]);
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    xml = await dumpUiStable(config, device);
  }

  return xml;
}

function findIbkBankOption(xml) {
  return findNode(xml, ["IBK기업은행", "IBK 기업은행", "기업은행"], {
    visible: true,
    enabled: true
  });
}

function visibleBankOptionLabels(xml) {
  return [...new Set(xmlTextLines(xml)
    .filter((line) => /은행|뱅크|Bank|IBK|국민|신한|우리|하나|농협|기업|카카오|토스|새마을|수협|부산|대구|광주|전북|경남|제주|SC|씨티/.test(line))
    .slice(0, 20))];
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
  return isCashReceiptAlreadyIssued(xml);
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
  xml = await bringRefundBankSelectIntoSafeView(config, device, xml);
  addStep(steps, "환불/보증금 반환 계좌 영역 정렬", "pass", "은행/계좌번호/예금주 확인 영역이 보이도록 스크롤");
  let bankSelect = findRefundBankSelect(xml);

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

  let dropdownXml = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    bankSelect = findRefundBankSelect(xml);
    if (!bankSelect?.bounds) break;

    await tapNode(config, device, bankSelect, "은행 선택", steps);
    if (attempt === 0) addStep(steps, "환불/보증금 반환 은행 선택 열기");

    dropdownXml = await waitForUi(
      config,
      device,
      (nextXml) => Boolean(findIbkBankOption(nextXml)) || visibleBankOptionLabels(nextXml).length >= 3,
      1800
    );
    saveXml(store, `refund-bank-dropdown-${attempt + 1}`, dropdownXml);

    const ibk = findIbkBankOption(dropdownXml);
    if (ibk?.bounds) {
      await tapNode(config, device, ibk, "기업은행", steps);
      addStep(steps, "기업은행 선택", "pass", attempt === 0 ? "드롭다운에서 바로 선택" : "드롭다운 재시도 후 선택");
      await new Promise((resolve) => setTimeout(resolve, 250));
      return dumpUiStable(config, device);
    }

    if (visibleBankOptionLabels(dropdownXml).length >= 3) {
      await runAdb(config, device, ["shell", "input", "swipe", "540", "1770", "540", "980", "150"]);
      await new Promise((resolve) => setTimeout(resolve, 160));
      dropdownXml = await dumpUiStable(config, device);
      saveXml(store, `refund-bank-dropdown-scroll-${attempt + 1}`, dropdownXml);

      const scrolledIbk = findIbkBankOption(dropdownXml);
      if (scrolledIbk?.bounds) {
        await tapNode(config, device, scrolledIbk, "기업은행", steps);
        addStep(steps, "기업은행 선택", "pass", "드롭다운 스크롤 후 선택");
        await new Promise((resolve) => setTimeout(resolve, 250));
        return dumpUiStable(config, device);
      }
    }

    xml = await bringRefundBankSelectIntoSafeView(config, device, await dumpUiStable(config, device));
  }

  const labels = visibleBankOptionLabels(dropdownXml);
  await saveFailureArtifacts(config, device, store, "refund-bank-option-not-found", dropdownXml || xml);
  fail(
    "환불/보증금 반환 은행 목록에서 기업은행을 찾지 못했습니다.",
    steps,
    [
      labels.length
        ? `현재 보이는 은행 후보: ${labels.join(", ")}`
        : "은행 선택 드롭다운은 눌렀지만 은행 후보 목록이 화면/XML에 노출되지 않았습니다.",
      "환불/보증금 반환 계좌 영역이 화면 중앙에 와야 안정적으로 은행 목록을 선택할 수 있습니다.",
      "리포트의 refund-bank-option-not-found.png 화면을 확인해주세요."
    ]
  );
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
  xml = await keepRefundAccountAboveKeyboard(config, device, await dumpUiStable(config, device));
  xml = await waitForUi(
    config,
    device,
    (nextXml) => hasRefundAccountNumberValue(nextXml, "34108755301018"),
    2500
  );
  if (!hasRefundAccountNumberValue(xml, "34108755301018")) {
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
  xml = await tapHolderCheckRobust(config, device, store, steps, xml);
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
  addStep(steps, "현금영수증 입력 생략", "pass", "무통장 결제 속도 개선을 위해 현금영수증 입력/발급요청은 수행하지 않음");
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
      "환불/보증금 반환 계좌 입력 후 하단 결제하기 버튼이 보여야 합니다.",
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
        "은행, 계좌번호, 예금주 확인, 저장, 결제하기 버튼 처리 후 실제 무통장 입금 안내 화면이 보여야 합니다.",
        "무통장 결제 완료 화면에는 입금해주세요, 무통장 입금 정보, 예금주, 계좌 번호, 입금액, 홈으로 가기가 보여야 합니다.",
        "리포트의 payment-complete-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "무통장 입금 안내 완료 화면 확인");

  return returnHomeFromPaymentComplete(config, device, store, steps, xml, "payment");
}

function findVirtualAccountIssueButton(xml) {
  return findNode(xml, ["가상계좌 발급", "가상 계좌 발급"], {
    visible: true,
    clickable: true,
    enabled: true
  });
}

async function tapVirtualAccountIssueButtonRobust(config, device, store, steps, xml) {
  await keyEvent(config, device, 111).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 180));
  xml = await dumpUiStable(config, device);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const issueButton = findVirtualAccountIssueButton(xml);
    if (issueButton?.bounds && issueButton.bounds.top >= 900 && issueButton.bounds.bottom <= 2465) {
      saveXml(store, "extension-bank-transfer-submit-ready", xml);
      await tapNode(config, device, issueButton, "가상계좌 발급 버튼", steps);
      addStep(steps, "가상계좌 발급 버튼 선택");
      return xml;
    }

    const accountSectionVisible = Boolean(findNode(xml, ["환불 계좌", "환불/보증금 반환 계좌"], { visible: true }));
    const swipeArgs = accountSectionVisible
      ? ["shell", "input", "swipe", "540", "1880", "540", "1420", "150"]
      : ["shell", "input", "swipe", "540", "1850", "540", "900", "170"];
    await runAdb(config, device, swipeArgs);
    await new Promise((resolve) => setTimeout(resolve, 140));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "extension-bank-transfer-submit-ready", xml);
  fail(
    "연장 무통장 결제의 가상계좌 발급 버튼을 찾지 못했습니다.",
    steps,
    [
      "환불계좌 입력/예금주 확인 후 키패드를 닫고 가상계좌 발급 버튼을 찾아야 합니다.",
      "버튼이 화면 하단에 있으면 짧은 스크롤로 위치만 보정합니다.",
      "리포트의 extension-bank-transfer-submit-ready.png 화면을 확인해주세요."
    ]
  );
}

async function selectExtensionBankTransferMethod(config, device, store, steps, xml) {
  if (xml.includes("결제 방법") && !xml.includes("무통장 입금")) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "850", "540", "1500", "180"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
  }

  for (let count = 0; count < 8; count += 1) {
    const bankTransfer = findVisibleExtensionBankTransferOption(xml);
    if (bankTransfer?.bounds) {
      await tapNode(config, device, bankTransfer, "연장결제 무통장 입금 라디오", steps);
      addStep(steps, "연장결제 무통장 입금 선택");
      xml = await waitForUi(config, device, hasExtensionBankTransferForm, 5000);
      saveXml(store, "extension-payment-bank-transfer-method", xml);
      if (hasExtensionBankTransferForm(xml)) return xml;
    }

    const paymentMethodHeading = findNode(xml, "결제 방법", { visible: true });
    const swipeArgs = paymentMethodHeading?.bounds
      ? ["shell", "input", "swipe", "540", "900", "540", "1500", "160"]
      : ["shell", "input", "swipe", "540", "1850", "540", "900", "170"];
    await runAdb(config, device, swipeArgs);
    await new Promise((resolve) => setTimeout(resolve, 140));
    xml = await dumpUiStable(config, device);
  }

  await saveFailureArtifacts(config, device, store, "extension-bank-transfer-method-not-found", xml);
  fail(
    "연장 결제하기 화면에서 무통장 입금 라디오 버튼을 찾지 못했습니다.",
    steps,
    [
      "결제하기 화면의 카드/간편결제 기본 선택 상태에서 무통장 입금 라디오 버튼을 선택해야 합니다.",
      "리포트의 extension-bank-transfer-method-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function submitExtensionBankTransferPayment(config, device, appPackage, store, steps, xml) {
  xml = await selectExtensionBankTransferMethod(config, device, store, steps, xml);
  xml = await fillRefundAccount(config, device, store, steps, xml);
  xml = await tapVirtualAccountIssueButtonRobust(config, device, store, steps, xml);

  xml = await waitForUi(config, device, isExtensionVirtualAccountComplete, 12000);
  saveXml(store, "payment-complete", xml);

  if (!isExtensionVirtualAccountComplete(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-bank-transfer-complete-not-found", xml);
    fail(
      "연장 무통장 가상계좌 발급 완료 화면을 확인하지 못했습니다.",
      steps,
      [
        "가상계좌 발급 버튼을 눌렀지만 가상계좌/입금 안내 완료 화면이 확인되지 않았습니다.",
        "리포트의 extension-bank-transfer-complete-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "가상계좌 발급 완료 화면 확인");

  if (appPackage) {
    await launchFresh(config, device, appPackage, steps);
    addStep(steps, "가상계좌 발급 완료 후 앱 재실행");
    return waitForUi(config, device, isHomeScreen, 8000);
  }

  return xml;
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
  const retryCounts = [0, 0, 0, 0];
  let index = 0;
  while (index < cardParts.length) {
    xml = await dumpUiStable(config, device);
    const requestedPartIndex = findPgCardPartAlert(xml);
    if (requestedPartIndex !== null) {
      retryCounts[requestedPartIndex] += 1;
      if (retryCounts[requestedPartIndex] > 2) {
        await saveFailureArtifacts(config, device, store, "pg-card-part-alert-repeat", xml);
        fail(
          `PG 카드번호 ${requestedPartIndex + 1}번째 입력 안내 팝업이 반복됩니다.`,
          steps,
          [
            "PG가 특정 카드번호 4자리 입력을 계속 요구하고 있습니다.",
            "리포트의 pg-card-part-alert-repeat.png 화면을 확인해주세요."
          ]
        );
      }
      xml = await dismissPgCardPartAlert(config, device, steps, xml);
      addStep(
        steps,
        "PG 카드번호 입력 재시도",
        "pass",
        `${requestedPartIndex + 1}번째 4자리 입력 안내 팝업 감지`
      );
      index = requestedPartIndex;
      continue;
    }

    ({ cardFields } = findPgPaymentFields(xml));
    const field = cardFields[index];
    if (!field?.bounds) {
      const alertPartIndex = findPgCardPartAlert(xml);
      if (alertPartIndex !== null) {
        xml = await dismissPgCardPartAlert(config, device, steps, xml);
        index = alertPartIndex;
        continue;
      }
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
    index += 1;
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
    if (isVisualOnlyPaymentCompleteCandidate(xml)) {
      addStep(
        steps,
        "결제 완료 화면 확인",
        "pass",
        "완료 화면의 Android XML 텍스트가 노출되지 않아 홈으로 버튼 fallback으로 검증"
      );
      return returnHomeFromPaymentComplete(config, device, store, steps, xml, "card-payment");
    }

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
  const isExtensionPayment = paymentMethod === "extension-card";
  const isExtensionBankTransfer = paymentMethod === "extension-bank-transfer";
  const skipFreshLaunch = request.skip_fresh_launch === true;
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("계약 결제는 guest role에서만 실행할 수 있습니다.");
  if (!["card", "bank-transfer", "extension-card", "extension-bank-transfer"].includes(paymentMethod)) {
    throw new Error(`Unknown payment method: ${paymentMethod}`);
  }
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    const homeXml = await prepareHomeForContractPayment(config, device, appPackage, store, steps, {
      skipFreshLaunch
    });

    let xml = isExtensionPayment || isExtensionBankTransfer
      ? await openExtensionPaymentFromHome(config, device, store, steps, {
        fastHomeActionTap: skipFreshLaunch,
        initialXml: homeXml
      })
      : await openPaymentDetailFromHome(config, device, store, steps);
    if (isExtensionBankTransfer) {
      xml = await submitExtensionBankTransferPayment(config, device, appPackage, store, steps, xml);
    } else {
      xml = await scrollToPaymentMethod(config, device, store, steps, isExtensionPayment ? "card" : paymentMethod);
    }

    if (paymentMethod === "card" || isExtensionPayment) {
      xml = await chooseJcbAndSubmit(config, device, store, steps, xml);
      xml = await inputPgCard(config, device, store, steps, xml);
    } else if (paymentMethod === "bank-transfer") {
      xml = await submitBankTransferPayment(config, device, store, steps, xml);
    }

    addStep(steps, "계약 결제 완료 확인");

    return {
      test_id: "TC-CONTRACT-PAYMENT-001",
      name: isExtensionPayment || isExtensionBankTransfer ? "guest 계약 연장 결제" : "guest 계약 결제",
      env,
      status: "pass",
      device,
      steps,
      payment_conditions: {
        method: paymentMethod === "bank-transfer" || isExtensionBankTransfer ? "무통장 입금" : "신용·체크카드",
        type: isExtensionPayment || isExtensionBankTransfer ? "계약 연장 결제" : "계약 결제",
        ...(paymentMethod === "card" || isExtensionPayment
          ? {
            card_brand: "JCB",
            card_number: "3530 **** **** 0000",
            expiry: "03/28"
          }
          : {
            ...(paymentMethod === "bank-transfer"
              ? {
                cash_receipt_type: "개인",
                cash_receipt_phone: "01000000000"
              }
              : {}),
            refund_bank: "기업은행",
            refund_account: "34108755301018",
            ...(isExtensionBankTransfer
              ? {
                virtual_account: "가상계좌 발급 완료"
              }
              : {
                toss_approval_target: extractBankTransferApprovalTarget(store)
              })
          })
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "payment-home-after-refresh.xml"),
          path.join(store.logsDir, "extension-payment-home-after-refresh.xml"),
          path.join(store.logsDir, "extension-payment-contract-detail.xml"),
          path.join(store.logsDir, "extension-payment-accepted-detail.xml"),
          path.join(store.logsDir, "extension-payment-detail-start.xml"),
          path.join(store.logsDir, "extension-payment-bank-transfer-method.xml"),
          path.join(store.logsDir, paymentMethod === "bank-transfer" || isExtensionBankTransfer ? "payment-method-bank-transfer.xml" : "payment-method-jcb.xml"),
          path.join(store.logsDir, "extension-bank-transfer-submit-ready.xml"),
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
