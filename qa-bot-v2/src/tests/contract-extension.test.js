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
  mergeFigmaValidations,
  validateGuestExtensionCompletePopup,
  validateGuestExtensionDetail
} = require("./helpers/extension-figma-baseline");

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

async function waitForUi(config, device, predicate, timeoutMs = 12000, intervalMs = 300) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return xml;
}

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
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

async function tapNode(config, device, node, label, steps) {
  if (!node?.bounds) fail(`${label}을 찾지 못했습니다.`, steps);
  await tap(config, device, node.bounds.x, node.bounds.y);
}

function hasHomeSearchBar(xml) {
  return xml.includes("동네 · 주변 장소로 검색") || xml.includes("동네 주변 장소로 검색");
}

function isLoginStartScreen(xml) {
  return (
    xml.includes("이메일/휴대폰 번호로 시작하기") ||
    xml.includes("카카오로 시작하기") ||
    xml.includes("로그인 하지 않고 둘러보기")
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
    (xml.includes("계약번호") || xml.includes("계약 번호") || xml.includes("계약 상세")) &&
    (xml.includes("계약 연장") || xml.includes("계약 취소") || xml.includes("결제") || xml.includes("체크아웃"))
  );
}

function isExtensionGuidePopup(xml) {
  return xml.includes("계약 연장 요청 안내");
}

function isExtensionCalendar(xml) {
  return (
    (
      xml.includes("연장 퇴실일 선택") ||
      xml.includes("희망 퇴실일") ||
      xml.includes("퇴실일 선택") ||
      xml.includes("변경할 퇴실일을 선택해주세요")
    ) &&
    xml.includes("확인")
  );
}

function isExtensionDetail(xml) {
  return (
    xml.includes("계약 연장") &&
    (
      xml.includes("변경 후 계약") ||
      xml.includes("계약 연장 날짜") ||
      xml.includes("총 연장 박수") ||
      xml.includes("총 연장박수") ||
      xml.includes("주의사항 및 규정")
    )
  );
}

function isExtensionCompletePopup(xml) {
  return (
    xml.includes("계약 연장 요청 완료") ||
    xml.includes("연장 요청이 완료") ||
    xml.includes("연장 요청 완료")
  );
}

function findExtensionSubmitButton(xml) {
  return findNode(xml, ["연장 요청", "계약 연장 요청"], {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function findExtensionAgreementNode(xml) {
  return findNode(xml, [
    "주의사항 및 규정 전체 동의",
    "주의사항 및 환불 규정 전체 동의",
    "주의사항 및 규정",
    "주의사항 및 환불 규정"
  ], {
    visible: true,
    enabled: true
  });
}

function findExtensionCalendarConfirmButton(xml) {
  return findNode(xml, "확인", {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function hasExtensionAgreementWarning(xml) {
  return xml.includes("모든 주의사항 및 규정에 대한 동의가 필요합니다.");
}

function extractCheckoutDate(xml) {
  const labels = parseNodes(xml)
    .map((node) => nodeLabel(node).trim())
    .filter(Boolean);
  let checkoutDate = null;
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] !== "퇴실") continue;
    const nextDateLabel = labels
      .slice(index + 1, index + 5)
      .find((label) => /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일/.test(label));
    const match = nextDateLabel && nextDateLabel.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
    if (match) {
      checkoutDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
  }
  if (checkoutDate) return checkoutDate;

  const normalized = String(xml || "").replace(/\s+/g, " ");
  const isoRange = normalized.match(/(\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})/);
  if (isoRange) {
    return new Date(Number(isoRange[4]), Number(isoRange[5]) - 1, Number(isoRange[6]));
  }

  const koreanYearRange = normalized.match(
    /입주\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일[^퇴]*퇴실\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/
  );
  if (koreanYearRange) {
    return new Date(Number(koreanYearRange[4]), Number(koreanYearRange[5]) - 1, Number(koreanYearRange[6]));
  }

  const koreanRange = normalized.match(/(\d{1,2})월\s*(\d{1,2})일\s*~\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (koreanRange) {
    return new Date(2026, Number(koreanRange[3]) - 1, Number(koreanRange[4]));
  }

  const checkoutLabelDate = normalized.match(/퇴실\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (checkoutLabelDate) {
    return new Date(Number(checkoutLabelDate[1]), Number(checkoutLabelDate[2]) - 1, Number(checkoutLabelDate[3]));
  }

  return null;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthLabel(date) {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

function findDateNodeInMonth(xml, targetDate) {
  const nodes = parseNodes(xml);
  const month = nodes.find((node) => nodeLabel(node).includes(monthLabel(targetDate)) && node.bounds && isVisibleNode(node));
  if (!month?.bounds) return null;

  const nextMonthDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 1);
  const nextMonth = nodes.find((node) => nodeLabel(node).includes(monthLabel(nextMonthDate)) && node.bounds);
  const monthTop = month.bounds.bottom;
  const monthBottom = nextMonth?.bounds?.top && nextMonth.bounds.top > monthTop
    ? nextMonth.bounds.top
    : 2496;
  const dayLabel = String(targetDate.getDate());
  return nodes.find((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    if (nodeLabel(node).trim() !== dayLabel) return false;
    return (
      node.bounds.top >= monthTop &&
      node.bounds.bottom <= monthBottom &&
      node.bounds.bottom > node.bounds.top &&
      node.bounds.top < 2496
    );
  });
}

function daysBetween(startDate, endDate) {
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function getVisibleExtensionDateCandidates(xml, baseCheckout) {
  const nodes = parseNodes(xml);
  const bottomActionTop = nodes
    .filter((node) => node.bounds && nodeLabel(node).includes("확인"))
    .map((node) => node.bounds.top)
    .filter((top) => top > 1800)
    .sort((a, b) => a - b)[0] || 2060;
  const maxCandidateBottom = Math.min(1980, bottomActionTop - 20);
  const monthNodes = nodes
    .map((node) => {
      const match = nodeLabel(node).match(/(\d{4})년\s*(\d{1,2})월/);
      if (!match || !node.bounds || !isVisibleNode(node)) return null;
      return {
        node,
        year: Number(match[1]),
        monthIndex: Number(match[2]) - 1
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.node.bounds.top - b.node.bounds.top);

  const candidates = [];
  for (let monthIndex = 0; monthIndex < monthNodes.length; monthIndex += 1) {
    const currentMonth = monthNodes[monthIndex];
    const nextMonth = monthNodes[monthIndex + 1];
    const monthTop = currentMonth.node.bounds.bottom;
    const monthBottom = nextMonth?.node?.bounds?.top && nextMonth.node.bounds.top > monthTop
      ? nextMonth.node.bounds.top
      : 2496;

    for (const node of nodes) {
      if (!node.bounds || node.attrs.clickable !== "true" || node.attrs.enabled !== "true") continue;
      if (!isVisibleNode(node)) continue;
      if (node.bounds.top < monthTop || node.bounds.bottom > monthBottom) continue;
      if (node.bounds.bottom > maxCandidateBottom) continue;

      const label = nodeLabel(node).trim();
      if (!/^\d{1,2}$/.test(label)) continue;

      const date = new Date(currentMonth.year, currentMonth.monthIndex, Number(label));
      if (date.getMonth() !== currentMonth.monthIndex) continue;

      const extensionNights = daysBetween(baseCheckout, date);
      if (extensionNights < 1 || extensionNights > 180) continue;
      candidates.push({ node, date, extensionNights });
    }
  }

  return candidates;
}

async function openConfirmedContractDetailFromHome(config, device, store, steps, env) {
  let xml = await waitForUi(
    config,
    device,
    (nextXml) => hasHomeSearchBar(nextXml) || hasConfirmedContractCard(nextXml) || isLoginStartScreen(nextXml),
    12000
  );
  saveXml(store, "extension-home-before-refresh", xml);

  if (isLoginStartScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-login-required", xml);
    fail(
      "게스트가 로그아웃된 상태라 계약 연장을 시작할 수 없습니다.",
      steps,
      [
        `먼저 !게스트 로그인 ${env === "dev" ? "dev" : "stg"} 명령어로 게스트 로그인을 완료해주세요.`,
        "계약 연장은 로그인 상태의 홈 화면에서 계약 확정 상태 카드가 보여야 합니다.",
        "리포트의 extension-login-required.png 화면을 확인해주세요."
      ]
    );
  }

  if (!hasConfirmedContractCard(xml)) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "720", "540", "1650", "450"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    addStep(steps, "홈 화면 풀 리프레시");
    xml = await waitForUi(config, device, hasConfirmedContractCard, 7000);
  } else {
    addStep(steps, "홈 화면 계약 확정 카드 즉시 확인", "pass", "리프레시 없이 카드가 이미 보이는 상태");
  }
  saveXml(store, "extension-home-after-refresh", xml);

  if (!hasConfirmedContractCard(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-confirmed-card-not-found", xml);
    fail(
      "홈 화면에서 계약 확정 상태 카드를 찾지 못했습니다.",
      steps,
      [
        "홈 화면에서 '예약 확정', '계약 확정', '입주 예정' 상태 문구가 있는 카드를 찾습니다.",
        "연장 요청 가능한 확정 계약 건이 있는지 확인해주세요.",
        "리포트의 extension-confirmed-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const action = findConfirmedContractCardAction(xml);
  if (!action?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-card-action-not-found", xml);
    fail(
      "계약 확정 카드에서 상세 진입 버튼을 찾지 못했습니다.",
      steps,
      [
        "확정 상태 문구는 보이지만 실제로 누를 수 있는 카드 영역을 찾지 못했습니다.",
        "리포트의 extension-card-action-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const checkoutDate = extractCheckoutDate(xml);
  await tapNode(config, device, action, "계약 확정 카드", steps);
  addStep(steps, "홈 화면 계약 확정 카드 선택");

  xml = await waitForUi(config, device, isContractDetail, 12000);
  saveXml(store, "extension-contract-detail-start", xml);
  if (!isContractDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-detail-not-found", xml);
    fail(
      "계약 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "계약 확정 카드를 눌렀지만 계약 상세 화면을 확인하지 못했습니다.",
        "리포트의 extension-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return {
    xml,
    checkoutDate: checkoutDate || extractCheckoutDate(xml)
  };
}

async function tapExtensionRequestButton(config, device, store, steps, initialXml) {
  let xml = initialXml;
  for (let count = 0; count < 12; count += 1) {
    saveXml(store, `extension-request-search-${count + 1}`, xml);
    let button = findNode(xml, "계약 연장 요청", {
      visible: true,
      clickable: true,
      enabled: true
    });
    if (button?.bounds) {
      saveXml(store, "extension-request-button", xml);
      const tapAttempts = [
        {
          name: "버튼 XML 좌표 탭",
          action: () => tap(config, device, button.bounds.x, button.bounds.y)
        },
        {
          name: "버튼 중앙 짧은 press",
          action: () => runAdb(config, device, [
            "shell",
            "input",
            "swipe",
            String(button.bounds.x),
            String(button.bounds.y),
            String(button.bounds.x),
            String(button.bounds.y),
            "160"
          ])
        },
        {
          name: "버튼 하단 영역 탭",
          action: () => tap(
            config,
            device,
            button.bounds.x,
            Math.max(button.bounds.top + 24, button.bounds.bottom - 42)
          )
        },
        {
          name: "포커스 확정",
          action: () => keyEvent(config, device, 23)
        }
      ];

      for (let attemptIndex = 0; attemptIndex < tapAttempts.length; attemptIndex += 1) {
        await tapAttempts[attemptIndex].action();
        addStep(
          steps,
          attemptIndex === 0 ? "계약 상세 계약 연장 요청 버튼 선택" : "계약 상세 계약 연장 요청 버튼 재시도",
          "pass",
          tapAttempts[attemptIndex].name
        );

        const nextXml = await waitForUi(
          config,
          device,
          (nextXml) => isExtensionGuidePopup(nextXml) || isExtensionCalendar(nextXml),
          attemptIndex === 0 ? 3500 : 2200,
          160
        );
        if (isExtensionGuidePopup(nextXml) || isExtensionCalendar(nextXml)) return nextXml;
        saveXml(store, `extension-request-tap-no-transition-${count + 1}-${attemptIndex + 1}`, nextXml);
        xml = nextXml;
        button = findNode(xml, "계약 연장 요청", {
          visible: true,
          clickable: true,
          enabled: true
        });
        if (!button?.bounds) break;
      }

      await saveFailureArtifacts(config, device, store, "extension-request-button-did-not-open", xml);
      fail(
        "계약 연장 요청 버튼을 눌렀지만 연장 퇴실일 선택 화면으로 이동하지 않았습니다.",
        steps,
        [
          "계약 상세 화면의 '계약 연장 요청' 버튼을 여러 방식으로 재시도했지만 화면이 그대로였습니다.",
          "리포트의 extension-request-button-did-not-open.png 화면과 runner.log를 확인해주세요."
        ]
      );
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1920", "540", "1320", "180"]);
    await new Promise((resolve) => setTimeout(resolve, 140));
    xml = await dumpUi(config, device);
  }

  await saveFailureArtifacts(config, device, store, "extension-request-button-not-found", xml);
  fail(
    "계약 상세 화면에서 계약 연장 요청 버튼을 찾지 못했습니다.",
    steps,
    [
      "계약 상세 중간 영역까지 빠르게 스크롤하며 실제 클릭 가능한 '계약 연장 요청' 버튼을 찾습니다.",
      "리포트의 extension-request-button-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function confirmGuideIfNeeded(config, device, store, steps, xml) {
  if (isExtensionCalendar(xml)) {
    addStep(steps, "계약 연장 요청 안내 팝업 확인", "pass", "팝업 미노출, 달력 화면 바로 진입");
    return xml;
  }

  if (!isExtensionGuidePopup(xml)) {
    addStep(steps, "계약 연장 요청 안내 팝업 확인", "pass", "팝업 미노출");
    return xml;
  }

  saveXml(store, "extension-guide-popup", xml);
  const confirmButton = findNode(xml, "확인", {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-guide-confirm-not-found", xml);
    fail(
      "계약 연장 요청 안내 팝업에서 확인 버튼을 찾지 못했습니다.",
      steps,
      [
        "안내 팝업이 노출된 경우 확인 버튼을 눌러 연장 퇴실일 선택 화면으로 이동해야 합니다.",
        "리포트의 extension-guide-confirm-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tapNode(config, device, confirmButton, "계약 연장 요청 안내 확인 버튼", steps);
  addStep(steps, "계약 연장 요청 안내 팝업 확인 선택");
  return waitForUi(config, device, isExtensionCalendar, 10000);
}

async function selectRandomExtensionCheckout(config, device, store, steps, initialXml, currentCheckoutDate) {
  let xml = isExtensionCalendar(initialXml)
    ? initialXml
    : await waitForUi(config, device, isExtensionCalendar, 10000);
  saveXml(store, "extension-calendar-start", xml);

  if (!isExtensionCalendar(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-calendar-not-found", xml);
    fail(
      "연장 퇴실일 선택 화면을 확인하지 못했습니다.",
      steps,
      [
        "계약 연장 요청 이후 '연장 퇴실일 선택' 또는 '희망 퇴실일' 달력 화면이 보여야 합니다.",
        "리포트의 extension-calendar-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const baseCheckout = currentCheckoutDate || extractCheckoutDate(xml);
  if (!baseCheckout) {
    await saveFailureArtifacts(config, device, store, "extension-checkout-date-not-found", xml);
    fail(
      "현재 퇴실일을 확인하지 못해서 연장 희망 퇴실일을 계산할 수 없습니다.",
      steps,
      [
        "홈 카드, 계약 상세, 달력 화면 중 하나에는 현재 계약 기간 또는 퇴실일이 노출되어야 합니다.",
        "리포트의 extension-checkout-date-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  let lastCandidates = [];
  for (let count = 0; count < 8; count += 1) {
    const candidates = getVisibleExtensionDateCandidates(xml, baseCheckout);
    lastCandidates = candidates;
    if (candidates.length > 0) {
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      await tapNode(config, device, selected.node, "희망 퇴실일", steps);
      addStep(steps, "희망 퇴실일 랜덤 선택", "pass", `${formatDate(selected.date)} (${selected.extensionNights}박 연장)`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      xml = await dumpUi(config, device);
      saveXml(store, "extension-calendar-selected", xml);

      let confirmButton = findExtensionCalendarConfirmButton(xml);
      if (!confirmButton?.bounds) {
        await saveFailureArtifacts(config, device, store, "extension-calendar-confirm-not-found", xml);
        fail(
          "희망 퇴실일 선택 후 확인 버튼을 찾지 못했습니다.",
          steps,
          [
            "연장 퇴실일을 선택하면 하단 확인 버튼이 활성화되어야 합니다.",
            "리포트의 extension-calendar-confirm-not-found.png 화면을 확인해주세요."
          ]
        );
      }

      const confirmAttempts = [
        {
          name: "확인 버튼 XML 좌표 탭",
          action: () => tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y)
        },
        {
          name: "하단 확인 버튼 고정 좌표 탭",
          action: () => runAdb(config, device, ["shell", "input", "touchscreen", "tap", "540", "2233"])
        },
        {
          name: "하단 확인 버튼 짧은 press",
          action: () => runAdb(config, device, ["shell", "input", "swipe", "540", "2233", "540", "2233", "160"])
        },
        {
          name: "포커스 확인 실행",
          action: () => keyEvent(config, device, 23)
        }
      ];

      for (let index = 0; index < confirmAttempts.length; index += 1) {
        await confirmAttempts[index].action();
        addStep(
          steps,
          index === 0 ? "연장 퇴실일 확인 버튼 선택" : "연장 퇴실일 확인 버튼 재시도",
          "pass",
          confirmAttempts[index].name
        );

        xml = await waitForUi(
          config,
          device,
          (nextXml) => isExtensionDetail(nextXml) || !isExtensionCalendar(nextXml),
          index === 0 ? 3500 : 2200,
          160
        );
        if (isExtensionDetail(xml)) {
          return {
            xml,
            targetDate: selected.date,
            extensionNights: selected.extensionNights
          };
        }

        confirmButton = findExtensionCalendarConfirmButton(xml);
        if (!confirmButton?.bounds) break;
      }

      await saveFailureArtifacts(config, device, store, "extension-calendar-confirm-did-not-open-detail", xml);
      fail(
        "연장 퇴실일 확인 버튼을 눌렀지만 계약 연장 요청 화면으로 이동하지 않았습니다.",
        steps,
        [
          "희망 퇴실일 선택 화면의 확인 버튼을 여러 방식으로 재시도했지만 달력 화면이 유지되었습니다.",
          "리포트의 extension-calendar-confirm-did-not-open-detail.png 화면과 runner.log를 확인해주세요."
        ]
      );
      return {
        xml,
        targetDate: selected.date,
        extensionNights: selected.extensionNights
      };
    }

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1980", "540", "950", "260"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    xml = await dumpUi(config, device);
  }

  await saveFailureArtifacts(config, device, store, "extension-target-date-not-found", xml);
  fail(
    "달력에서 랜덤 희망 퇴실일을 찾지 못했습니다.",
    steps,
    [
      `마지막 화면의 선택 가능 후보 수: ${lastCandidates.length}`,
      "현재 화면에 보이는 날짜 중 현재 퇴실일 이후 1박부터 180박까지의 날짜를 랜덤 선택합니다.",
      "리포트의 extension-target-date-not-found.png 화면을 확인해주세요."
    ]
  );
}

async function agreeRulesAndSubmit(config, device, store, steps, initialXml, extensionInfo, figmaValidations) {
  let xml = isExtensionDetail(initialXml)
    ? initialXml
    : await waitForUi(config, device, isExtensionDetail, 10000);
  saveXml(store, "extension-detail-start", xml);

  if (!isExtensionDetail(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-detail-screen-not-found", xml);
    fail(
      "계약 연장 상세 화면을 확인하지 못했습니다.",
      steps,
      [
        "연장 퇴실일 확인 후 계약 연장 날짜, 총 연장 박수, 주의사항 및 규정 영역이 보여야 합니다.",
        "리포트의 extension-detail-screen-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const hasDateSummary = xml.includes("계약 연장 날짜") || xml.includes("변경 후 계약");
  const hasNightSummary = xml.includes("총 연장 박수") || xml.includes("총 연장박수") || /\d+박\s*연장/.test(xml);
  const figmaDetailValidation = validateGuestExtensionDetail(xml, extensionInfo);
  figmaValidations.push(figmaDetailValidation);
  if (figmaDetailValidation.status === "fail") {
    await saveFailureArtifacts(config, device, store, "extension-detail-figma-mismatch", xml);
    fail(
      "계약 연장 상세 화면의 문구가 Figma 기준과 다릅니다.",
      steps,
      [
        `누락 기준: ${figmaDetailValidation.missing.join(", ")}`,
        "팝업/금액처럼 Android XML에 노출되지 않는 항목은 수동 확인 필요로만 기록합니다.",
        "리포트의 extension-detail-figma-mismatch.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(
    steps,
    "Figma 기준 계약 연장 상세 문구 비교",
    "pass",
    figmaDetailValidation.status === "manual_required"
      ? "자동 확인 가능 항목 PASS, 일부 수동 확인 필요"
      : "자동 확인 가능 항목 PASS"
  );

  if (!hasDateSummary || !hasNightSummary) {
    await saveFailureArtifacts(config, device, store, "extension-detail-text-mismatch", xml);
    fail(
      "계약 연장 상세 화면의 필수 문구가 Figma 기준과 다릅니다.",
      steps,
      [
        "필수 문구: 계약 연장 날짜/변경 후 계약, 총 연장 박수 또는 N박 연장",
        "화면 문구가 변경되면 디자인/기획 기준 확인이 필요합니다.",
        "리포트의 extension-detail-text-mismatch.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(steps, "계약 연장 날짜 및 총 연장 박수 확인", "pass", `${formatDate(extensionInfo.targetDate)} / ${extensionInfo.extensionNights}박`);

  for (let count = 0; count < 5 && !xml.includes("주의사항 및 규정"); count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2100", "540", "1150", "220"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUi(config, device);
  }

  let agreeNode = findExtensionAgreementNode(xml);
  if (!agreeNode?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-agreement-not-found", xml);
    fail(
      "주의사항 및 규정 전체 동의 영역을 찾지 못했습니다.",
      steps,
      [
        "계약 연장 상세 화면 하단에 '주의사항 및 규정 전체 동의' 문구가 보여야 합니다.",
        "리포트의 extension-agreement-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  if (agreeNode.bounds.bottom > 2200) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1960", "540", "1220", "220"]);
    await new Promise((resolve) => setTimeout(resolve, 160));
    xml = await dumpUi(config, device);
    agreeNode = findExtensionAgreementNode(xml);
    saveXml(store, "extension-agreement-lifted", xml);
    if (!agreeNode?.bounds) {
      await saveFailureArtifacts(config, device, store, "extension-agreement-lifted-not-found", xml);
      fail(
        "주의사항 및 규정 전체 동의 영역을 화면 중간으로 올린 뒤에도 찾지 못했습니다.",
        steps,
        [
          "전체 동의 행이 하단 고정 버튼 또는 시스템 바에 가려졌을 수 있습니다.",
          "리포트의 extension-agreement-lifted-not-found.png 화면을 확인해주세요."
        ]
      );
    }
  }

  const agreementTapTargets = [
    {
      name: "오른쪽 체크 표시",
      x: Math.min(1000, agreeNode.bounds.right - 62),
      y: agreeNode.bounds.y
    },
    {
      name: "오른쪽 체크 표시 상단",
      x: Math.min(1000, agreeNode.bounds.right - 62),
      y: Math.max(agreeNode.bounds.top + 44, agreeNode.bounds.y - 26)
    },
    {
      name: "전체 동의 행 중앙",
      x: agreeNode.bounds.x,
      y: agreeNode.bounds.y
    }
  ];

  for (let index = 0; index < agreementTapTargets.length; index += 1) {
    const target = agreementTapTargets[index];
    await tap(config, device, target.x, target.y);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUi(config, device);
    if (!hasExtensionAgreementWarning(xml)) {
      addStep(steps, "주의사항 및 규정 전체 동의 선택", "pass", target.name);
      break;
    }
    if (index === agreementTapTargets.length - 1) {
      addStep(steps, "주의사항 및 규정 전체 동의 선택", "pass", `${target.name} 후 경고 유지`);
    }
  }

  xml = await dumpUi(config, device);
  saveXml(store, "extension-agreement-selected", xml);

  const submitButton = findExtensionSubmitButton(xml);
  if (!submitButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-submit-not-found", xml);
    fail(
      "연장 요청 버튼이 활성화되지 않았습니다.",
      steps,
      [
        "주의사항 및 규정 전체 동의 후 하단 파란색 '연장 요청' 버튼이 활성화되어야 합니다.",
        "리포트의 extension-submit-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const attempts = [
    {
      name: "버튼 XML 좌표 탭",
      action: () => tap(config, device, submitButton.bounds.x, submitButton.bounds.y)
    },
    {
      name: "하단 고정 좌표 탭",
      action: () => runAdb(config, device, ["shell", "input", "touchscreen", "tap", "540", "2388"])
    },
    {
      name: "하단 고정 좌표 짧은 press",
      action: () => runAdb(config, device, ["shell", "input", "swipe", "540", "2388", "540", "2388", "160"])
    },
    {
      name: "포커스 확정",
      action: () => keyEvent(config, device, 23)
    }
  ];

  for (let index = 0; index < attempts.length; index += 1) {
    await attempts[index].action();
    addStep(
      steps,
      index === 0 ? "연장 요청 버튼 선택" : "연장 요청 버튼 재시도",
      "pass",
      attempts[index].name
    );

    xml = await waitForUi(
      config,
      device,
      (nextXml) => isExtensionCompletePopup(nextXml) || !isExtensionDetail(nextXml),
      index === 0 ? 3500 : 2200,
      160
    );
    if (isExtensionCompletePopup(xml)) return xml;

    const nextSubmitButton = findExtensionSubmitButton(xml);
    if (!nextSubmitButton?.bounds) return xml;
  }

  return xml;
}

async function confirmCompletePopup(config, device, store, steps, initialXml, figmaValidations) {
  let xml = isExtensionCompletePopup(initialXml)
    ? initialXml
    : await waitForUi(config, device, isExtensionCompletePopup, 10000);
  saveXml(store, "extension-complete-popup", xml);

  if (!isExtensionCompletePopup(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-complete-popup-not-found", xml);
    fail(
      "계약 연장 요청 완료 팝업을 확인하지 못했습니다.",
      steps,
      [
        "연장 요청 버튼 선택 후 '계약 연장 요청 완료' 팝업이 보여야 합니다.",
        "리포트의 extension-complete-popup-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const figmaPopupValidation = validateGuestExtensionCompletePopup(xml);
  figmaValidations.push(figmaPopupValidation);
  if (figmaPopupValidation.status === "fail") {
    await saveFailureArtifacts(config, device, store, "extension-complete-popup-figma-mismatch", xml);
    fail(
      "계약 연장 요청 완료 팝업의 문구가 Figma 기준과 다릅니다.",
      steps,
      [
        `누락 기준: ${figmaPopupValidation.missing.join(", ")}`,
        "볼 수 없는 팝업 본문은 수동 확인 필요로만 기록합니다.",
        "리포트의 extension-complete-popup-figma-mismatch.png 화면을 확인해주세요."
      ]
    );
  }
  addStep(
    steps,
    "Figma 기준 계약 연장 완료 팝업 비교",
    "pass",
    figmaPopupValidation.status === "manual_required"
      ? "자동 확인 가능 항목 PASS, 일부 수동 확인 필요"
      : "자동 확인 가능 항목 PASS"
  );

  const confirmButton = findNode(xml, "확인", {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "extension-complete-confirm-not-found", xml);
    fail(
      "계약 연장 요청 완료 팝업에서 확인 버튼을 찾지 못했습니다.",
      steps,
      [
        "완료 팝업에서는 확인 버튼을 눌러야 최종 완료로 처리합니다.",
        "리포트의 extension-complete-confirm-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const attempts = [
    {
      name: "확인 버튼 고정 좌표 touchscreen 탭",
      action: () => runAdb(config, device, [
        "shell",
        "input",
        "touchscreen",
        "tap",
        "540",
        "1662"
      ])
    },
    {
      name: "확인 버튼 고정 좌표 짧은 press",
      action: () => runAdb(config, device, [
        "shell",
        "input",
        "swipe",
        "540",
        "1662",
        "540",
        "1662",
        "140"
      ])
    },
    {
      name: "확인 버튼 XML 좌표 touchscreen 탭",
      action: () => runAdb(config, device, [
        "shell",
        "input",
        "touchscreen",
        "tap",
        String(confirmButton.bounds.x),
        String(confirmButton.bounds.y)
      ])
    },
    {
      name: "확인 버튼 중앙 탭",
      action: () => tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y)
    },
    {
      name: "확인 버튼 짧은 press",
      action: () => runAdb(config, device, [
        "shell",
        "input",
        "swipe",
        String(confirmButton.bounds.x),
        String(confirmButton.bounds.y),
        String(confirmButton.bounds.x),
        String(confirmButton.bounds.y),
        "180"
      ])
    },
    {
      name: "확인 버튼 하단 영역 탭",
      action: () => tap(
        config,
        device,
        confirmButton.bounds.x,
        Math.max(confirmButton.bounds.top + 20, confirmButton.bounds.bottom - 38)
      )
    }
  ];

  for (const attempt of attempts) {
    await attempt.action();
    await new Promise((resolve) => setTimeout(resolve, 500));
    xml = await waitForUi(config, device, (nextXml) => !isExtensionCompletePopup(nextXml), 2200, 250);
    if (!isExtensionCompletePopup(xml)) {
      saveXml(store, "extension-complete-after-confirm", xml);
      addStep(steps, "계약 연장 요청 완료 팝업 확인 선택", "pass", `${attempt.name} 후 팝업 닫힘 확인`);
      return;
    }
    addStep(steps, "계약 연장 요청 완료 팝업 확인 재시도", "pass", `${attempt.name} 후 팝업 유지`);
  }

  saveXml(store, "extension-complete-after-confirm", xml);

  if (isExtensionCompletePopup(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-complete-confirm-not-dismissed", xml);
    fail(
      "계약 연장 요청 완료 팝업의 확인 버튼을 눌렀지만 팝업이 닫히지 않았습니다.",
      steps,
      [
        "완료 팝업의 확인 버튼을 누른 뒤 팝업이 사라져야 최종 PASS 처리합니다.",
        "앱이 탭을 받지 않았거나 확인 버튼 좌표가 변경되었을 수 있습니다.",
        "리포트의 extension-complete-confirm-not-dismissed.png 화면을 확인해주세요."
      ]
    );
  }
}

async function relaunchAndVerifyHome(config, device, appPackage, store, steps) {
  await launchFresh(config, device, appPackage, steps);
  const xml = await waitForUi(
    config,
    device,
    (nextXml) => hasHomeSearchBar(nextXml) || hasConfirmedContractCard(nextXml) || isLoginStartScreen(nextXml),
    12000
  );
  saveXml(store, "extension-home-after-relaunch", xml);

  if (isLoginStartScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-home-after-relaunch-login-required", xml);
    fail(
      "연장 요청 완료 후 앱을 재실행했지만 게스트 홈이 아닌 로그인 화면이 노출되었습니다.",
      steps,
      [
        "연장 요청 완료 후에는 로그인 세션이 유지된 홈 화면으로 진입해야 합니다.",
        "리포트의 extension-home-after-relaunch-login-required.png 화면을 확인해주세요."
      ]
    );
  }

  if (!hasHomeSearchBar(xml) && !hasConfirmedContractCard(xml)) {
    await saveFailureArtifacts(config, device, store, "extension-home-after-relaunch-not-found", xml);
    fail(
      "연장 요청 완료 후 앱 재실행 시 홈 화면을 확인하지 못했습니다.",
      steps,
      [
        "완료 팝업 확인 후 앱을 재실행해 홈 화면 진입까지 확인합니다.",
        "리포트의 extension-home-after-relaunch-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "연장 요청 완료 후 앱 재실행 및 홈 화면 확인");
}

async function runContractExtensionTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("계약 연장은 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);
    const figmaValidations = [];

    const detail = await openConfirmedContractDetailFromHome(config, device, store, steps, env);
    let xml = await tapExtensionRequestButton(config, device, store, steps, detail.xml);
    xml = await confirmGuideIfNeeded(config, device, store, steps, xml);
    const extensionInfo = await selectRandomExtensionCheckout(config, device, store, steps, xml, detail.checkoutDate);
    xml = await agreeRulesAndSubmit(config, device, store, steps, extensionInfo.xml, extensionInfo, figmaValidations);
    await confirmCompletePopup(config, device, store, steps, xml, figmaValidations);
    await relaunchAndVerifyHome(config, device, appPackage, store, steps);

    const figmaValidation = mergeFigmaValidations(figmaValidations);
    return {
      test_id: "TC-CONTRACT-EXTENSION-001",
      name: "guest 계약 연장",
      env,
      status: "pass",
      device,
      steps,
      contract_extension: {
        target_checkout_date: formatDate(extensionInfo.targetDate),
        extension_nights: extensionInfo.extensionNights
      },
      figma_validation: figmaValidation,
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "extension-home-after-refresh.xml"),
          path.join(store.logsDir, "extension-contract-detail-start.xml"),
          path.join(store.logsDir, "extension-calendar-selected.xml"),
          path.join(store.logsDir, "extension-detail-start.xml"),
          path.join(store.logsDir, "extension-complete-popup.xml"),
          path.join(store.logsDir, "extension-complete-after-confirm.xml"),
          path.join(store.logsDir, "extension-home-after-relaunch.xml")
        ].filter((filePath) => fs.existsSync(filePath)),
        report_dir: store.reportDir
      }
    };
  });
}

module.exports = {
  runContractExtensionTest
};
