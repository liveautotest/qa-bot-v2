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

async function waitForUi(config, device, predicate, timeoutMs = 12000, intervalMs = 500) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return xml;
}

function isHostModeShell(xml) {
  return ["집 목록", "계약", "메시지", "내 정보"].filter((label) => findBottomTab(xml, label)).length >= 3;
}

function isLoginStartScreen(xml) {
  return (
    xml.includes("이메일/휴대폰 번호로 시작하기") ||
    xml.includes("카카오로 시작하기") ||
    xml.includes("구글로 시작하기") ||
    xml.includes("로그인 하지 않고 둘러보기")
  );
}

function isHostContractList(xml) {
  return xml.includes("계약 관리") && xml.includes("계약 요청") && xml.includes("최근 계약 요청일 순");
}

function isContractRequestDetail(xml) {
  return (
    xml.includes("계약 번호:") &&
    xml.includes("수락해주세요") &&
    (xml.includes("계약 수락") || xml.includes("거절"))
  );
}

function hasServiceUpdateBanner(xml) {
  return xml.includes("서비스 업데이트가 있습니다.") && xml.includes("새로고침");
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
  const match = String(xml || "").match(/계약\s*번호:?\s*(\d+)/);
  return match ? match[1] : "";
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getScheduleVariants(schedule) {
  const variants = new Set();
  const normalized = normalizeText(schedule);
  if (normalized) variants.add(normalized);

  const koreanRange = normalized.match(/(\d{1,2})월\s*(\d{1,2})일\s*~\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (koreanRange) {
    const [, startMonth, startDay, endMonth, endDay] = koreanRange;
    const dotStart = `2026.${startMonth.padStart(2, "0")}.${startDay.padStart(2, "0")}`;
    const dotEnd = `2026.${endMonth.padStart(2, "0")}.${endDay.padStart(2, "0")}`;
    const hyphenStart = `2026-${startMonth.padStart(2, "0")}-${startDay.padStart(2, "0")}`;
    const hyphenEnd = `2026-${endMonth.padStart(2, "0")}-${endDay.padStart(2, "0")}`;
    variants.add(`${dotStart}~${dotEnd}`);
    variants.add(`${dotStart} ~ ${dotEnd}`);
    variants.add(`${hyphenStart}~${hyphenEnd}`);
    variants.add(`${hyphenStart} ~ ${hyphenEnd}`);
  }

  return Array.from(variants);
}

function summaryMatches(label, summary) {
  if (!summary) return false;
  const normalizedLabel = normalizeText(label);
  const title = normalizeText(summary.title);
  const scheduleVariants = getScheduleVariants(summary.schedule);

  return (
    Boolean(title) &&
    scheduleVariants.length > 0 &&
    normalizedLabel.includes(title) &&
    scheduleVariants.some((schedule) => normalizedLabel.includes(schedule))
  );
}

function getHomeRequestCardSummary(xml) {
  const scheduleRegex = /\d{1,2}월\s*\d{1,2}일\s*~\s*\d{1,2}월\s*\d{1,2}일/;
  const card = parseNodes(xml).find((node) => {
    if (!node.bounds) return false;
    const label = labelOf(node);
    return (
      label.includes("요청 중") &&
      scheduleRegex.test(label) &&
      label.includes("성인 1")
    );
  });

  if (!card) return null;

  const lines = labelOf(card)
    .replace(/\s*\|\s*/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const statusIndex = lines.findIndex((line) => line.includes("요청 중"));

  return {
    status: "요청 중",
    title: lines[statusIndex + 1] || "",
    schedule: lines.find((line) => scheduleRegex.test(line)) || "",
    guest: lines.find((line) => line.includes("성인 1")) || "",
    raw: lines.join(" | ")
  };
}

function findRequestCard(xml, targetContractNumber = "", matchSummary = null, options = {}) {
  const nodes = parseNodes(xml);
  const matchedByNumber = nodes.find((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    const label = labelOf(node);
    const contractNumber = getContractNumber(label);
    return (
      label.includes("계약 요청") &&
      label.includes("계약 번호:") &&
      (!targetContractNumber || contractNumber === String(targetContractNumber)) &&
      node.bounds.top >= 600 &&
      node.bounds.top < 2200
    );
  });

  if (matchedByNumber || targetContractNumber) return matchedByNumber;

  const matchedBySummary = nodes.find((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    const label = labelOf(node);
    return (
      label.includes("계약 요청") &&
      summaryMatches(label, matchSummary) &&
      node.bounds.top >= 600 &&
      node.bounds.top < 2200
    );
  });

  if (matchedBySummary || (matchSummary && options.requireSummaryMatch)) return matchedBySummary;

  return nodes.find((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    const label = labelOf(node);
    return (
      label.includes("계약 요청") &&
      node.bounds.top >= 600 &&
      node.bounds.top < 2200
    );
  });
}

function findHostHomeRequestCard(xml, matchSummary = null) {
  const nodes = parseNodes(xml);
  if (matchSummary) {
    const matchedSummaryCard = nodes.find((node) => {
      if (!node.bounds || node.attrs.clickable !== "true") return false;
      if (node.bounds.top < 240 || node.bounds.top >= 2100) return false;
      return summaryMatches(labelOf(node), matchSummary);
    });
    if (matchedSummaryCard) return matchedSummaryCard;
  }

  const statusPattern = /(수락이\s*필요한\s*계약|수락해\s*주세요|수락\s*대기|계약\s*요청|요청\s*중)/;
  const candidates = nodes.filter((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    const label = labelOf(node);
    return (
      statusPattern.test(label) &&
      node.bounds.top >= 240 &&
      node.bounds.top < 2100
    );
  });

  const matchingSummaryCard = candidates.find((node) => summaryMatches(labelOf(node), matchSummary));

  if (matchingSummaryCard) return matchingSummaryCard;
  if (matchSummary) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

function findLatestGuestContractRequestSummary(reportBaseDir, env) {
  if (!reportBaseDir || !fs.existsSync(reportBaseDir)) return null;

  const results = fs.readdirSync(reportBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("contract-request"))
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
      if (result.role && result.role !== "guest") continue;

      const summary = result.contract_request?.match_summary;
      if (summary?.title && summary?.schedule) return summary;

      const finalXmlPath = path.join(path.dirname(item.resultPath), "logs", "contract-request-final.xml");
      if (fs.existsSync(finalXmlPath)) {
        const recoveredSummary = getHomeRequestCardSummary(fs.readFileSync(finalXmlPath, "utf8"));
        if (recoveredSummary?.title && recoveredSummary?.schedule) return recoveredSummary;
      }
    } catch {
      // Ignore malformed historical reports.
    }
  }

  return null;
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

async function prepareHostContractList(config, device, appPackage, store, steps, options = {}) {
  if (options.skipFreshLaunch) {
    const xml = await waitForUi(config, device, isHostModeShell, 2500, 150);
    saveXml(store, "host-before-reuse", xml);
    if (isHostModeShell(xml)) {
      addStep(steps, "기존 호스트 화면 재사용");
      return;
    }

    store.appendLog("runner.log", "contract-approve could not reuse host screen; launching app fresh");
    addStep(steps, "기존 호스트 화면 재사용 불가, 앱 재실행으로 복구");
  }

  await launchApp(config, device, appPackage, steps);
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

    await tap(config, device, contractTab.bounds.x, Math.max(2360, contractTab.bounds.top - 70));
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

async function openContractRequestFromHostHome(config, device, store, steps, options = {}) {
  const matchSummary = options.matchSummary || null;
  let xml = await waitForUi(
    config,
    device,
    (candidateXml) => isHostModeShell(candidateXml),
    7000,
    150
  );
  saveXml(store, "host-home-before-direct-approve", xml);

  if (!isHostModeShell(xml)) return null;

  let requestCard = findHostHomeRequestCard(xml, matchSummary);
  if (!requestCard?.bounds) {
    const homeTab = findBottomTab(xml, "홈");
    if (homeTab?.bounds) {
      await tap(config, device, homeTab.bounds.x, homeTab.bounds.y);
      addStep(steps, "호스트 홈 탭 진입");
      xml = await waitForUi(
        config,
        device,
        (candidateXml) => Boolean(findHostHomeRequestCard(candidateXml, matchSummary)),
        5000,
        150
      );
      saveXml(store, "host-home-after-home-tab", xml);
      requestCard = findHostHomeRequestCard(xml, matchSummary);
    }
  }

  if (!requestCard?.bounds) return null;

  const matchedMessage = matchSummary?.title
    ? `${matchSummary.title} / ${matchSummary.schedule}`
    : "호스트 홈 수락 대기 카드";

  const tapTargets = [
    [requestCard.bounds.x, requestCard.bounds.y, "카드 중앙"],
    [Math.max(requestCard.bounds.left + 90, 180), Math.round((requestCard.bounds.top + requestCard.bounds.bottom) / 2), "카드 이미지 영역"],
    [Math.min(requestCard.bounds.left + 430, requestCard.bounds.right - 80), requestCard.bounds.top + 48, "카드 숙소명 영역"]
  ];

  for (const [x, y, targetLabel] of tapTargets) {
    await tap(config, device, x, y);
    addStep(steps, "호스트 홈 수락 대기 카드 선택", "pass", `${matchedMessage} (${targetLabel})`);

    xml = await waitForUi(config, device, isContractRequestDetail, 3200, 160);
    if (isContractRequestDetail(xml)) {
      saveXml(store, "contract-approve-detail", xml);
      addStep(steps, "호스트 계약 요청 상세 진입");
      return {
        xml,
        contractNumber: getContractNumber(xml)
      };
    }

    if (hasServiceUpdateBanner(xml)) {
      const refreshButton = findNode(xml, "새로고침", { visibleOnly: true });
      if (refreshButton?.bounds) {
        await tap(config, device, refreshButton.bounds.x, refreshButton.bounds.y);
        addStep(steps, "서비스 업데이트 안내 새로고침 선택");
        xml = await waitForUi(
          config,
          device,
          (candidateXml) => isContractRequestDetail(candidateXml) || isHostModeShell(candidateXml),
          3500,
          150
        );
      }
    }

    if (isHostModeShell(xml)) {
      await keyEvent(config, device, 23).catch(() => {});
      addStep(steps, "호스트 홈 수락 대기 카드 포커스 확정");
      xml = await waitForUi(config, device, isContractRequestDetail, 1600, 120);
      if (isContractRequestDetail(xml)) {
        saveXml(store, "contract-approve-detail", xml);
        addStep(steps, "호스트 계약 요청 상세 진입");
        return {
          xml,
          contractNumber: getContractNumber(xml)
        };
      }

      await tap(config, device, x, y);
      addStep(steps, "호스트 홈 수락 대기 카드 재탭", "pass", targetLabel);
      xml = await waitForUi(config, device, isContractRequestDetail, 1800, 120);
      if (isContractRequestDetail(xml)) {
        saveXml(store, "contract-approve-detail", xml);
        addStep(steps, "호스트 계약 요청 상세 진입");
        return {
          xml,
          contractNumber: getContractNumber(xml)
        };
      }
    }

    if (!isHostModeShell(xml)) {
      await keyEvent(config, device, 4).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
      xml = await waitForUi(config, device, isHostModeShell, 2500, 150);
    }
  }

  saveXml(store, "contract-approve-detail", xml);

  store.appendLog("runner.log", "host home request card did not open approve detail");
  return null;
}

async function openContractRequest(config, device, store, steps, xml, options = {}) {
  const targetContractNumber = options.contractNumber || "";
  const matchSummary = options.matchSummary || null;
  const requireSummaryMatch = options.requireSummaryMatch === true;
  let requestCard = findRequestCard(xml, targetContractNumber, matchSummary, { requireSummaryMatch });

  if (!requestCard) {
    const requestFilter = findNode(xml, "계약 요청", { visibleOnly: true });
    if (requestFilter?.bounds) {
      await tap(config, device, requestFilter.bounds.x, requestFilter.bounds.y);
      addStep(steps, "계약 요청 필터 선택");
      xml = await waitForUi(
        config,
        device,
        (nextXml) => Boolean(findRequestCard(nextXml, targetContractNumber, matchSummary, { requireSummaryMatch })),
        8000
      );
      saveXml(store, "host-contract-request-list", xml);
      requestCard = findRequestCard(xml, targetContractNumber, matchSummary, { requireSummaryMatch });
    }
  }

  if (!requestCard?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-request-card-not-found", xml);
    fail(
      "승인할 계약 요청 건을 찾지 못했습니다.",
      steps,
      [
        targetContractNumber
          ? `호스트 계약 관리 목록에서 계약 번호 ${targetContractNumber}인 계약 요청 카드를 찾습니다.`
          : matchSummary
            ? `호스트 계약 관리 목록에서 숙소명 '${matchSummary.title}', 일정 '${matchSummary.schedule}'인 계약 요청 카드를 먼저 찾습니다.`
            : "호스트 계약 관리 목록에서 가장 위에 보이는 '계약 요청' 상태 카드를 찾습니다.",
        "현재 처리 가능한 요청 건이 없거나, 목록 정렬/필터 상태가 예상과 다를 수 있습니다.",
        "리포트의 contract-request-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const contractNumber = getContractNumber(labelOf(requestCard));
  await tap(config, device, requestCard.bounds.x, requestCard.bounds.y);
  const matchedMessage = matchSummary?.title
    ? `${matchSummary.title} / ${matchSummary.schedule}`
    : contractNumber ? `계약 번호 ${contractNumber}` : "최신 계약 요청건";
  addStep(steps, "계약 요청 건 상세 진입", "pass", matchedMessage);

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

  const detailContractNumber = getContractNumber(xml) || contractNumber;

  return { xml, contractNumber: detailContractNumber };
}

function findRejectButton(xml) {
  const matches = parseNodes(xml).filter((node) => {
    if (!node.bounds || node.attrs.clickable !== "true") return false;
    if (!labelOf(node).includes("거절")) return false;
    if (node.bounds.bottom <= 0 || node.bounds.top >= 2496) return false;
    return true;
  });

  return matches.sort((a, b) => b.bounds.top - a.bounds.top)[0] || null;
}

function isRejectReasonScreen(xml) {
  return (
    xml.includes("게스트에게 계약 요청 거절 사유를 알려주세요") ||
    xml.includes("계약 요청 거절 사유") ||
    (xml.includes("거절 사유") && xml.includes("거절"))
  );
}

function isContractRejected(xml) {
  return (
    xml.includes("게스트에게 거절 사유를 보냈습니다") ||
    xml.includes("거절되었습니다") ||
    xml.includes("거절됐습니다") ||
    xml.includes("계약 거절 완료") ||
    (isHostContractList(xml) && !xml.includes("계약 요청 상세"))
  );
}

async function goToContractHistoryIfPresent(config, device, store, steps, xml) {
  const historyButton = findNode(xml, "계약 내역 가기", { visibleOnly: true });
  if (!historyButton?.bounds) return xml;

  await tap(config, device, historyButton.bounds.x, historyButton.bounds.y);
  addStep(steps, "거절 완료 화면 계약 내역 가기 선택");

  let nextXml = await waitForUi(
    config,
    device,
    (candidateXml) =>
      isHostContractList(candidateXml) ||
      (
        !candidateXml.includes("게스트에게 거절 사유를 보냈습니다") &&
        candidateXml.includes("계약")
      ) ||
      isHostModeShell(candidateXml),
    12000
  );
  saveXml(store, "contract-reject-history", nextXml);

  if (!isHostContractList(nextXml)) {
    const backButton = parseNodes(nextXml).find((node) => {
      if (!node.bounds || node.attrs.clickable !== "true") return false;
      return node.bounds.left <= 180 && node.bounds.top >= 80 && node.bounds.top <= 260;
    });

    if (backButton?.bounds) {
      await tap(config, device, backButton.bounds.x, backButton.bounds.y);
      addStep(steps, "계약 내역 상단 뒤로가기 선택");
      nextXml = await waitForUi(config, device, isHostContractList, 12000);
      saveXml(store, "contract-reject-history-back", nextXml);
    }
  }

  if (!isHostContractList(nextXml)) {
    await saveFailureArtifacts(config, device, store, "contract-reject-history-not-found", nextXml);
    fail(
      "계약 내역에서 뒤로가기 후 호스트 계약 관리 목록을 확인하지 못했습니다.",
      steps,
      [
        "거절 완료 화면의 '계약 내역 가기' 버튼을 누른 뒤 상단 뒤로가기 버튼으로 계약 관리 목록에 복귀해야 합니다.",
        "리포트의 contract-reject-history-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return nextXml;
}

function chooseRejectReason(xml) {
  const excluded = ["기타", "거절 사유를 선택", "선택해주세요"];
  const candidates = [];

  for (const node of parseNodes(xml)) {
    if (!node.bounds || node.attrs.enabled !== "true") continue;
    if (node.bounds.bottom <= 94 || node.bounds.top >= 2496) continue;

    const label = labelOf(node).replace(/\s+/g, " ").trim();
    if (!label || label.length > 80) continue;
    if (excluded.some((text) => label.includes(text))) continue;

    const isReasonOption =
      label.startsWith("죄송합니다.") ||
      node.attrs.clickable === "true" ||
      node.attrs.class?.includes("TextView") ||
      node.attrs.class?.includes("Button");

    if (isReasonOption) {
      if (!candidates.some((candidate) => candidate.label === label)) {
        candidates.push({ label, node });
      }
    }
  }

  return candidates.slice(0, 4)[Math.floor(Math.random() * Math.min(candidates.length, 4))] || null;
}

async function selectRejectReasonAndSubmit(config, device, store, steps, initialXml) {
  let xml = isRejectReasonScreen(initialXml)
    ? initialXml
    : await waitForUi(config, device, isRejectReasonScreen, 10000);
  saveXml(store, "contract-reject-reason-start", xml);

  if (!isRejectReasonScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-reject-reason-not-found", xml);
    fail(
      "게스트에게 전달할 계약 요청 거절 사유 화면을 확인하지 못했습니다.",
      steps,
      [
        "계약 상세에서 거절 버튼을 누르면 '게스트에게 계약 요청 거절 사유를 알려주세요' 화면이 보여야 합니다.",
        "리포트의 contract-reject-reason-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const dropdown = findNode(xml, "선택", { visibleOnly: true }) || findNode(xml, "사유", { visibleOnly: true });
  if (dropdown?.bounds) {
    await tap(config, device, dropdown.bounds.x, dropdown.bounds.y);
    addStep(steps, "계약 요청 거절 사유 드롭박스 선택");
    xml = await waitForUi(config, device, (nextXml) => chooseRejectReason(nextXml), 5000);
    saveXml(store, "contract-reject-reason-options", xml);
  }

  const reason = chooseRejectReason(xml);
  if (!reason?.node?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-reject-reason-option-not-found", xml);
    fail(
      "계약 요청 거절 사유 항목을 찾지 못했습니다.",
      steps,
      [
        "드롭박스에서 기타를 제외한 4개 항목 중 하나를 선택해야 합니다.",
        "리포트의 contract-reject-reason-option-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, reason.node.bounds.x, reason.node.bounds.y);
  addStep(steps, "계약 요청 거절 사유 선택", "pass", reason.label);
  await new Promise((resolve) => setTimeout(resolve, 300));
  xml = await dumpUi(config, device);
  saveXml(store, "contract-reject-reason-selected", xml);

  const rejectButton = findRejectButton(xml);
  if (!rejectButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-reject-submit-not-found", xml);
    fail(
      "계약 요청 거절 버튼을 찾지 못했습니다.",
      steps,
      [
        "거절 사유를 선택하면 하단 거절 버튼이 활성화되어야 합니다.",
        "리포트의 contract-reject-submit-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, rejectButton.bounds.x, rejectButton.bounds.y);
  addStep(steps, "계약 요청 거절 버튼 선택");

  xml = await waitForUi(config, device, isContractRejected, 12000);
  saveXml(store, "contract-reject-final", xml);
  if (!isContractRejected(xml)) {
    await saveFailureArtifacts(config, device, store, "contract-reject-final", xml);
    fail(
      "계약 요청 거절 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        "거절 버튼을 눌렀지만 거절 완료 상태 또는 호스트 계약 목록 복귀 상태가 확인되지 않았습니다.",
        "리포트의 contract-reject-final.png 화면을 확인해주세요."
      ]
    );
  }

  xml = await goToContractHistoryIfPresent(config, device, store, steps, xml);

  return { xml, reason: reason.label };
}

async function tapRejectAndConfirm(config, device, store, steps, xml) {
  const rejectButton = findRejectButton(xml);
  if (!rejectButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "contract-reject-button-not-found", xml);
    fail(
      "계약 상세 화면에서 거절 버튼을 찾지 못했습니다.",
      steps,
      [
        "호스트 계약 요청 상세 화면 하단에 거절 버튼이 보여야 합니다.",
        "리포트의 contract-reject-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, rejectButton.bounds.x, rejectButton.bounds.y);
  addStep(steps, "계약 요청 상세 거절 버튼 선택");
  return selectRejectReasonAndSubmit(config, device, store, steps, xml);
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
  const skipFreshLaunch = request.skip_fresh_launch === true;

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

    await prepareHostContractList(config, device, appPackage, store, steps, {
      skipFreshLaunch
    });

    const matchSummary = findLatestGuestContractRequestSummary(config.reportBaseDir, env);
    const directDetail = await openContractRequestFromHostHome(config, device, store, steps, {
      matchSummary
    });

    if (!directDetail) {
      const xml = await dumpUi(config, device);
      await saveFailureArtifacts(config, device, store, "host-home-approve-card-not-found", xml);
      if (isLoginStartScreen(xml)) {
        fail(
          "호스트 로그인 세션이 풀려 계약 승인 홈 화면에 진입하지 못했습니다.",
          steps,
          [
            "기본검증에서는 이 실패를 감지하면 호스트 로그인을 먼저 복구한 뒤 계약 승인을 재시도합니다.",
            "리포트의 host-home-approve-card-not-found.png 화면을 확인해주세요."
          ]
        );
      }

      fail(
        "호스트 홈 수락 대기 계약 카드를 눌렀지만 상세 화면으로 이동하지 못했습니다.",
        steps,
        [
          "계약 승인은 호스트 홈의 '수락이 필요한 계약' 카드에서 바로 시작합니다.",
          "자동화가 카드 탭, 포커스 확정, 재탭까지 시도했습니다.",
          "숙소명/일정 매칭이 어긋나면 다른 계약을 승인하지 않도록 계약 탭 fallback은 사용하지 않습니다.",
          "리포트의 host-home-approve-card-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    let xml = directDetail.xml;
    const detail = directDetail;
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

async function runContractRejectTest({ request, config, store }) {
  const role = request.role || "host";
  const env = request.env || "staging";
  const device = config.devices.host || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "host") {
    throw new Error("계약 요청 거절은 host role에서만 실행할 수 있습니다.");
  }
  if (!device) throw new Error("Missing device id for role: host");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await keyEvent(config, device, 224);
    await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch(() => {});
    addStep(steps, "단말 깨우기 및 잠금 해제 시도");

    let xml = await waitForUi(config, device, isHostModeShell, 2500, 150);
    saveXml(store, "host-reject-before-reuse", xml);
    if (isHostModeShell(xml)) {
      addStep(steps, "기존 호스트 화면 재사용");
    } else {
      addStep(steps, "기존 호스트 화면 재사용 불가, 앱 재실행으로 복구");
      await launchApp(config, device, appPackage, steps);
    }

    const matchSummary = findLatestGuestContractRequestSummary(config.reportBaseDir, env);
    if (matchSummary?.title && matchSummary?.schedule) {
      addStep(
        steps,
        "게스트 계약 요청 카드 기준 확인",
        "pass",
        `${matchSummary.title} / ${matchSummary.schedule}`
      );
    } else {
      fail(
        "거절할 게스트 계약 요청 카드 기준을 찾지 못했습니다.",
        steps,
        [
          "호스트 계약 요청 거절은 게스트 홈 카드의 숙소명과 일정을 기준으로 호스트 계약 탭의 요청 건을 매칭합니다.",
          `먼저 최신 코드로 !게스트 계약 요청 ${env === "dev" ? "dev" : "stg"} 명령어를 PASS 시켜주세요.`,
          "게스트 계약 요청 PASS 리포트에 계약 요청 카드 기준이 저장되어야 거절 대상 계약을 안전하게 선택할 수 있습니다."
        ]
      );
    }

    xml = await openHostContractList(config, device, store, steps);
    const detail = await openContractRequest(config, device, store, steps, xml, {
      matchSummary,
      requireSummaryMatch: true
    });
    const rejected = await tapRejectAndConfirm(config, device, store, steps, detail.xml);

    addStep(steps, "계약 요청 거절 완료 확인");

    return {
      test_id: "TC-CONTRACT-REJECT-001",
      name: "host 계약 요청 거절",
      env,
      status: "pass",
      device,
      steps,
      rejected_contract: {
        contract_number: detail.contractNumber || "",
        match_summary: matchSummary || null,
        reason: rejected.reason
      },
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "host-contract-list.xml"),
          path.join(store.logsDir, "host-contract-request-list.xml"),
          path.join(store.logsDir, "contract-approve-detail.xml"),
          path.join(store.logsDir, "contract-reject-reason-start.xml"),
          path.join(store.logsDir, "contract-reject-final.xml"),
          path.join(store.logsDir, "contract-reject-history.xml"),
          path.join(store.logsDir, "contract-reject-history-back.xml")
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

module.exports = {
  runContractApproveTest,
  runContractRejectTest
};
