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

async function tapNode(config, device, node, label, steps) {
  if (!node?.bounds) fail(`${label}을 찾지 못했습니다.`, steps);
  await tap(config, device, node.bounds.x, node.bounds.y);
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
  return xml.includes("결제 대기 중") && xml.includes("확인 및 결제");
}

function findPaymentWaitingCard(xml) {
  return parseNodes(xml).find((node) => {
    const label = nodeLabel(node);
    return (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      label.includes("결제 대기 중")
    );
  });
}

function isContractPaymentDetail(xml) {
  return (
    xml.includes("계약번호:") &&
    xml.includes("결제해 주세요") &&
    xml.includes("결제하기")
  );
}

function hasPaymentMethodSection(xml) {
  return (
    xml.includes("결제 방법") &&
    xml.includes("신용·체크카드 결제 수단 선택됨") &&
    xml.includes("더보기 버튼") &&
    xml.includes("결제하기")
  );
}

function hasVisiblePaymentMethodSection(xml) {
  return Boolean(
    findNode(xml, "신용·체크카드 결제 수단 선택됨", { visible: true }) &&
      findNode(xml, "더보기 버튼", { visible: true, clickable: true, enabled: true }) &&
      findNode(xml, "결제하기", { visible: true, clickable: true, enabled: true })
  );
}

function hasJcbSelected(xml) {
  return xml.includes("JCB 카드 선택됨");
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
    xml.includes("계약 확정") ||
    xml.includes("Payment complete") ||
    xml.includes("결제가 완료")
  );
}

async function bringSecureKeypadIntoView(config, device) {
  let xml = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2250", "540", "850", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    xml = await dumpUi(config, device);
    if (hasVisibleSecureDigit(xml, "0") && hasVisibleSecureDigit(xml, "1")) break;
  }

  return xml || dumpUi(config, device);
}

async function openSecureKeypad(config, device, store, fieldIndex, steps) {
  let xml = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    xml = await dumpUi(config, device);
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
    xml = await dumpUi(config, device);
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
    15000
  );
  saveXml(store, "payment-home-before-refresh", xml);

  await runAdb(config, device, ["shell", "input", "swipe", "540", "700", "540", "1700", "700"]);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  addStep(steps, "홈 화면 풀 리프레시");

  xml = await waitForUi(config, device, hasPaymentWaitingCard, 12000);
  saveXml(store, "payment-home-after-refresh", xml);

  if (!hasPaymentWaitingCard(xml)) {
    await saveFailureArtifacts(config, device, store, "payment-card-not-found", xml);
    fail(
      "홈 화면에서 결제 대기 중 카드를 찾지 못했습니다.",
      steps,
      [
        "홈 화면 풀 리프레시 후 '결제 대기 중' 상태와 '확인 및 결제' 버튼이 있는 카드를 찾습니다.",
        "호스트가 계약 요청을 승인했는지 확인해주세요.",
        "리포트의 payment-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "결제 대기 중 카드 확인");
  const paymentCard = findPaymentWaitingCard(xml);
  if (paymentCard?.bounds) {
    await tap(config, device, paymentCard.bounds.x, paymentCard.bounds.y);
  } else {
    const paymentButton = findNode(xml, "확인 및 결제", {
      visible: true,
      clickable: true,
      enabled: true
    });
    await tapNode(config, device, paymentButton, "확인 및 결제 버튼", steps);
  }
  addStep(steps, "결제 대기 중 카드 선택");

  xml = await waitForUi(config, device, isContractPaymentDetail, 15000);
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

async function scrollToPaymentMethod(config, device, store, steps) {
  let xml = await dumpUi(config, device);
  for (let count = 0; count < 14; count += 1) {
    if (hasPaymentMethodSection(xml) && hasVisiblePaymentMethodSection(xml)) {
      saveXml(store, "payment-method", xml);
      addStep(steps, "결제 방법 영역 확인");
      return xml;
    }
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2050", "540", "650", "350"]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    xml = await dumpUi(config, device);
  }

  await saveFailureArtifacts(config, device, store, "payment-method-not-found", xml);
  fail(
    "계약 상세 화면에서 결제 방법 영역을 찾지 못했습니다.",
    steps,
    [
      "상세 화면을 아래로 스크롤했지만 '결제 방법', '신용·체크카드 결제 수단 선택됨', '더보기 버튼'이 확인되지 않았습니다.",
      "리포트의 payment-method-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function chooseJcbAndSubmit(config, device, store, steps, xml) {
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
    const jcbButton = findNode(xml, "JCB 카드", {
      visible: true,
      clickable: true,
      enabled: true
    });
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
    xml = await dumpUi(config, device);
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

  xml = await dumpUi(config, device);
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

  return xml;
}

async function runContractPaymentTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("계약 결제는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    let xml = await openPaymentDetailFromHome(config, device, store, steps);
    xml = await scrollToPaymentMethod(config, device, store, steps);
    xml = await chooseJcbAndSubmit(config, device, store, steps, xml);
    xml = await inputPgCard(config, device, store, steps, xml);

    addStep(steps, "계약 결제 완료 확인");

    return {
      test_id: "TC-CONTRACT-PAYMENT-001",
      name: "guest 계약 결제",
      env,
      status: "pass",
      device,
      steps,
      payment_conditions: {
        card_brand: "JCB",
        card_number: "3530 **** **** 0000",
        expiry: "03/28"
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "payment-home-after-refresh.xml"),
          path.join(store.logsDir, "payment-method-jcb.xml"),
          path.join(store.logsDir, "pg-payment-start.xml"),
          path.join(store.logsDir, "payment-final.xml")
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

module.exports = {
  runContractPaymentTest
};
