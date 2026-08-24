const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const { dumpUi, keyEvent, runAdb, screenshotPng, tap } = require("../infra/adb");
const { inputUnicodeText } = require("./aos-text-input");
const { chooseScenario } = require("./helpers/conversational-search-scenarios");

const INITIAL_PROMPT = "출장으로 잠시 머물 집이 필요해.";
const MIN_TURNS = 6;
const MAX_TURNS = 8;

// The feature is not in a testable build yet. Keep provisional coordinates in one
// place so only this map needs adjustment after the first dev build is available.
const PROVISIONAL_COORDINATES = {
  homeAgentEntry: { x: 540, y: 880 },
  messageInput: { x: 500, y: 2180 },
  sendButton: { x: 980, y: 2180 },
  resultCarouselSwipe: { startX: 260, endX: 850, y: 880, durationMs: 280 },
  resultCardCandidates: [
    { x: 270, y: 760 },
    { x: 760, y: 760 }
  ]
};

const APP_ERROR_SIGNALS = [
  "오류가 발생했습니다",
  "잠시 후 다시 시도",
  "답변을 생성할 수 없습니다",
  "네트워크 연결",
  "문제가 발생했습니다"
];

const RESULT_SIGNALS = ["원 / 주", "원/주", "이 조건으로 더보기", "일정 선택"];
const AGENT_SCREEN_SIGNALS = [
  "어디에서 잠시 머물 집이 필요한가요",
  "찾고 싶은 집에 대해 물어보세요",
  "AI 답변은 부정확할 수 있습니다"
];

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

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
}

function parseBounds(value) {
  const match = String(value || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
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
  for (const raw of String(xml || "").match(/<node\b[^>]*>/g) || []) {
    const attrs = {};
    for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[match[1]] = decodeXml(match[2]);
    }
    nodes.push({
      attrs,
      bounds: parseBounds(attrs.bounds),
      label: [attrs.text, attrs["content-desc"], attrs.hint].filter(Boolean).join(" ")
    });
  }
  return nodes;
}

function findNode(xml, patterns, { clickable = false } = {}) {
  const values = Array.isArray(patterns) ? patterns : [patterns];
  const matches = parseNodes(xml).filter((node) => {
    if (!node.bounds) return false;
    if (clickable && node.attrs.clickable !== "true") return false;
    return values.some((value) => value instanceof RegExp ? value.test(node.label) : node.label.includes(value));
  });
  return matches.find((node) => node.attrs.clickable === "true") || matches[0] || null;
}

function hasAny(xml, signals) {
  return signals.some((signal) => String(xml || "").includes(signal));
}

function isAgentScreen(xml) {
  return hasAny(xml, AGENT_SCREEN_SIGNALS);
}

function isResultScreen(xml) {
  return hasAny(xml, RESULT_SIGNALS);
}

function isListingDetailScreen(xml) {
  const detailSignals = ["숙소 정보", "집 정보", "편의시설", "계약 요청", "위치", "체크인"];
  return detailSignals.filter((signal) => String(xml || "").includes(signal)).length >= 2;
}

function extractVisibleText(xml) {
  return parseNodes(xml)
    .map((node) => node.label.trim())
    .filter(Boolean)
    .join("\n");
}

function extractAgentResponse(xml, userMessages = []) {
  let text = extractVisibleText(xml);
  for (const message of userMessages) {
    text = text.split(message).join("");
  }
  return text
    .split("\n")
    .filter((line) => !AGENT_SCREEN_SIGNALS.some((signal) => line.includes(signal)))
    .filter((line) => !/AI 답변은 부정확|새로운 대화|답변 중단/.test(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const TRAVEL_FOLLOW_UPS = [
  { intent: "location", patterns: /어디|지역|장소|근처|출근|출장지/, text: "여의도로 출장 갈 거야." },
  { intent: "schedule", patterns: /언제|일정|날짜|기간|며칠|몇\s*박/, text: "다음 주 월요일부터 2주 동안 머물 예정이야." },
  { intent: "party", patterns: /누구|인원|몇\s*명|동행/, text: "성인 한 명이 혼자 머물 거야." },
  { intent: "budget", patterns: /예산|가격|금액|얼마/, text: "주 40만 원 이하로 찾아줘." },
  { intent: "commute", patterns: /교통|역|이동|거리/, text: "여의도역까지 도보 10분 이내면 좋겠어." },
  { intent: "preference", patterns: /조건|선호|어떤 집|원하|시설/, text: "조용하고 업무용 책상과 세탁기가 있는 집이면 좋겠어." },
  { intent: "correction", patterns: /반려|동물|펫/, text: "반려동물은 없고, 주차도 필요 없어." },
  { intent: "result", patterns: /찾아|추천|결과|집을 보여/, text: "지금까지 말한 조건으로 숙소를 찾아줘." }
];

function selectFollowUp(responseText, turn, usedIntents = new Set(), resultVisible = false) {
  const text = String(responseText || "");
  const matching = TRAVEL_FOLLOW_UPS.find((item) => !usedIntents.has(item.intent) && item.patterns.test(text));
  if (matching) return matching;

  // When results arrive early, continue refining them instead of ending the test.
  // This exposes context-loss bugs that only appear after several user turns.
  if (resultVisible) {
    const refinement = TRAVEL_FOLLOW_UPS.find((item) =>
      !usedIntents.has(item.intent) && ["budget", "commute", "preference", "correction"].includes(item.intent)
    );
    if (refinement) return refinement;
  }

  return TRAVEL_FOLLOW_UPS.find((item) => !usedIntents.has(item.intent)) ||
    TRAVEL_FOLLOW_UPS[Math.min(turn, TRAVEL_FOLLOW_UPS.length - 1)];
}

function evaluateResponse({ responseText, previousText, prompt, resultVisible }) {
  const issues = [];
  const normalized = String(responseText || "").replace(/\s+/g, " ").trim();

  if (!normalized) issues.push("AI 답변이 비어 있습니다.");
  if (APP_ERROR_SIGNALS.some((signal) => normalized.includes(signal))) {
    issues.push("AI 오류 또는 재시도 안내가 노출되었습니다.");
  }
  if (previousText && normalized === previousText.replace(/\s+/g, " ").trim()) {
    issues.push("이전 답변과 동일한 내용이 반복되었습니다.");
  }
  if (!resultVisible && normalized && !/[?？]|까요|주세요|알려/.test(normalized)) {
    issues.push("숙소 결과 없이 대화를 이어가지만 다음 조건을 묻는 질문이 확인되지 않습니다.");
  }
  if (/출장/.test(prompt) && normalized && !/출장|머물|숙소|집|지역|일정|기간/.test(normalized)) {
    issues.push("출장 숙소 요청과 관련된 응답인지 확인되지 않습니다.");
  }

  return issues;
}

async function waitForUi(config, device, predicate, timeoutMs = 20000, intervalMs = 500) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return xml;
}

async function saveArtifacts(config, device, store, name, xml) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(xmlPath, xml || await dumpUi(config, device));
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return { xmlPath, screenshotPath };
}

function extractListingSummary(xml) {
  const nodes = parseNodes(xml);
  const labels = nodes.map((node) => node.label.trim()).filter(Boolean);
  const price = labels.find((label) => /(?:₩|원).*(?:주|월|박)|(?:주|월|박).*(?:₩|원)/.test(label)) || "";
  const title = labels.find((label) =>
    label !== price &&
    label.length >= 3 &&
    label.length <= 80 &&
    !/찾고 싶은|AI 답변|일정 선택|이 조건으로|체크인|체크아웃|편의시설/.test(label)
  ) || "";
  return { title, price, visible_text: labels.join("\n") };
}

function validateListingAgainstScenario(detailText, scenario) {
  const matched = [];
  const unmatched = [];
  const manualRequired = [];
  const hardIntents = new Set(["location", "party", "budget", "pet"]);

  for (const turn of scenario.turns || []) {
    if (!turn.expectedSignals?.length) continue;
    if (turn.expectedSignals.some((signal) => detailText.includes(signal))) {
      matched.push(`${turn.intent}: ${turn.expectedSignals.join("/")}`);
    } else if (hardIntents.has(turn.intent)) {
      unmatched.push(`${turn.intent}: ${turn.expectedSignals.join(" 또는 ")}`);
    } else {
      manualRequired.push(`${turn.intent}: ${turn.expectedSignals.join(" 또는 ")}`);
    }
  }

  return { matched, unmatched, manual_required: manualRequired };
}

async function openListingFromResults(config, device, store, steps, resultXml, scenario) {
  const before = await saveArtifacts(config, device, store, "conversational-search-results", resultXml);
  let selectableXml = resultXml;
  let cardNode = findNode(selectableXml, [/(?:₩|원).*(?:주|월|박)/, /오피스텔|아파트|원룸|투룸|주택/]);

  // Prefer the first visible result. Horizontal swipe is only a recovery path
  // for builds where the card body is clipped or not exposed to Android XML.
  if (!cardNode) {
    const gesture = PROVISIONAL_COORDINATES.resultCarouselSwipe;
    await runAdb(config, device, [
      "shell", "input", "swipe",
      String(gesture.startX), String(gesture.y),
      String(gesture.endX), String(gesture.y),
      String(gesture.durationMs)
    ]);
    await new Promise((resolve) => setTimeout(resolve, 650));
    selectableXml = await dumpUi(config, device);
    cardNode = findNode(selectableXml, [/(?:₩|원).*(?:주|월|박)/, /오피스텔|아파트|원룸|투룸|주택/]);
    await saveArtifacts(config, device, store, "conversational-search-results-after-recovery-swipe", selectableXml);
    addStep(steps, "검색 결과 카드 선택 영역 복구", "pass", "가로 스와이프 후 카드 재탐색");
  }

  const resultSummary = extractListingSummary(selectableXml);
  const candidates = PROVISIONAL_COORDINATES.resultCardCandidates;
  const fallback = candidates[0];
  const point = cardNode?.bounds || fallback;
  await tap(config, device, point.x, point.y);
  addStep(steps, "검색 결과 첫 번째 집 선택", "pass", cardNode ? "XML 카드 영역 탭" : "Figma 임시 첫 번째 카드 좌표 탭");

  const detailXml = await waitForUi(config, device, isListingDetailScreen, 15000, 500);
  if (!isListingDetailScreen(detailXml)) {
    await saveArtifacts(config, device, store, "conversational-search-listing-detail-not-found", detailXml);
    fail(
      "대화형 검색 결과의 집을 선택했지만 집 상세 화면으로 진입하지 못했습니다.",
      steps,
      ["개발 빌드 배포 후 결과 카드의 실제 클릭 영역과 집 상세 화면 식별 문구를 조정해주세요."]
    );
  }

  const detailArtifacts = await saveArtifacts(config, device, store, "conversational-search-listing-detail", detailXml);
  const detailSummary = extractListingSummary(detailXml);
  const conditionValidation = validateListingAgainstScenario(detailSummary.visible_text, scenario);
  addStep(
    steps,
    "집 상세 내용 및 대화 조건 일치 확인",
    conditionValidation.unmatched.length ? "fail" : "pass",
    conditionValidation.unmatched.length
      ? `불일치 ${conditionValidation.unmatched.length}건`
      : `자동 일치 ${conditionValidation.matched.length}건`
  );

  if (conditionValidation.unmatched.length) {
    fail(
      "선택한 집 상세 내용이 대화형 검색에서 요청한 핵심 조건과 다릅니다.",
      steps,
      conditionValidation.unmatched.map((item) => `조건 불일치: ${item}`)
    );
  }

  return {
    result_summary: resultSummary,
    detail_summary: detailSummary,
    condition_validation: conditionValidation,
    artifacts: {
      screenshots: [before.screenshotPath, detailArtifacts.screenshotPath],
      logs: [before.xmlPath, detailArtifacts.xmlPath]
    }
  };
}

async function launchApp(config, device, appPackage, steps) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch(() => {});
  await runAdb(config, device, ["shell", "am", "force-stop", appPackage]);
  await runAdb(config, device, [
    "shell", "monkey", "-p", appPackage, "-c", "android.intent.category.LAUNCHER", "1"
  ]);
  addStep(steps, "앱 실행");
}

async function openAgentScreen(config, device, store, steps) {
  let xml = await waitForUi(config, device, (value) => isAgentScreen(value) || /잠시 머물 집|검색/.test(value), 12000);
  if (isAgentScreen(xml)) return xml;

  const entry = findNode(xml, [
    /강남역 근처.*찾아보세요/,
    /대화형 검색/,
    /AI.*검색/
  ]);
  if (entry) {
    await tap(config, device, entry.bounds.x, entry.bounds.y);
  } else {
    await tap(config, device, PROVISIONAL_COORDINATES.homeAgentEntry.x, PROVISIONAL_COORDINATES.homeAgentEntry.y);
  }
  addStep(steps, "홈 화면 대화형 검색 진입", "pass", entry ? "XML 요소 탭" : "Figma 임시 좌표 탭");

  xml = await waitForUi(config, device, isAgentScreen, 12000);
  if (!isAgentScreen(xml)) {
    await saveArtifacts(config, device, store, "conversational-search-entry-not-found", xml);
    fail(
      "대화형 검색 화면으로 진입하지 못했습니다.",
      steps,
      [
        "현재 개발 빌드에 대화형 검색 기능이 아직 포함되지 않았거나 진입 좌표가 변경되었을 수 있습니다.",
        "개발 빌드 배포 후 PROVISIONAL_COORDINATES와 화면 문구를 실제 UI에 맞춰 조정해주세요."
      ]
    );
  }
  return xml;
}

async function sendMessage(config, device, store, steps, text, turn) {
  let xml = await dumpUi(config, device);
  const input = findNode(xml, [/찾고 싶은 집에 대해/, /물어보세요/, /메시지/]);
  const inputPoint = input?.bounds || PROVISIONAL_COORDINATES.messageInput;
  await tap(config, device, inputPoint.x, inputPoint.y);
  await inputUnicodeText(config, device, text, store, {
    refocus: () => tap(config, device, inputPoint.x, inputPoint.y)
  });

  xml = await dumpUi(config, device);
  const send = findNode(xml, [/전송/, /보내기/, /send/i], { clickable: true });
  const sendPoint = send?.bounds || PROVISIONAL_COORDINATES.sendButton;
  await tap(config, device, sendPoint.x, sendPoint.y);
  addStep(steps, `${turn}차 대화 입력`, "pass", text);
  await new Promise((resolve) => setTimeout(resolve, 450));
  return dumpUi(config, device);
}

async function waitForAgentResponse(config, device, previousXml) {
  return waitForUi(
    config,
    device,
    (xml) => {
      if (hasAny(xml, APP_ERROR_SIGNALS)) return true;
      if (isResultScreen(xml)) return true;
      return xml !== previousXml && !/답변을 생성하고 있습니다|답변 중단/.test(xml);
    },
    30000,
    650
  );
}

async function runConversationalSearchTest({ request, config, store }) {
  const env = request.env || "staging";
  const role = "guest";
  const device = config.devices?.[role];
  const appPackage = config.androidPackages?.[env];
  const steps = [];

  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Missing Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    await launchApp(config, device, appPackage, steps);
    let xml = await openAgentScreen(config, device, store, steps);
    addStep(steps, "대화형 검색 초기 화면 확인");

    const scenario = request.conversation_scenario || chooseScenario();
    const conversation = [];
    const validationIssues = [];
    const manualChecks = [];
    let prompt = scenario.initialPrompt || INITIAL_PROMPT;
    let previousResponse = "";
    let resultVisible = false;
    let resultObserved = false;
    let latestResultXml = "";
    const usedIntents = new Set();

    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      const afterSend = await sendMessage(config, device, store, steps, prompt, turn);
      xml = await waitForAgentResponse(config, device, afterSend);
      const sentMessages = [...conversation.map((item) => item.prompt), prompt];
      const responseText = extractAgentResponse(xml, sentMessages);
      resultVisible = isResultScreen(xml);
      resultObserved = resultObserved || resultVisible;
      if (resultVisible) latestResultXml = xml;
      const issues = evaluateResponse({ responseText, previousText: previousResponse, prompt, resultVisible });

      conversation.push({ turn, prompt, response: responseText, result_visible: resultVisible, issues });
      validationIssues.push(...issues.map((issue) => `${turn}차 답변: ${issue}`));
      await saveArtifacts(config, device, store, `conversational-search-turn-${turn}`, xml);
      addStep(steps, `${turn}차 AI 답변 확인`, issues.length ? "warning" : "pass", resultVisible ? "숙소 결과 노출" : "후속 대화 진행");

      if (issues.some((issue) => issue.includes("오류"))) break;
      if (turn >= MIN_TURNS && resultVisible) break;

      const adaptive = selectFollowUp(responseText, turn - 1, usedIntents, resultVisible);
      const followUp = scenario.turns.find((item) => item.intent === adaptive.intent && !usedIntents.has(item.intent)) ||
        scenario.turns.find((item) => !usedIntents.has(item.intent)) ||
        adaptive;
      usedIntents.add(followUp.intent);
      prompt = followUp.text;
      previousResponse = responseText;
    }

    if (!resultObserved) {
      fail(
        "대화형 검색을 이어갔지만 숙소 검색 결과를 확인하지 못했습니다.",
        steps,
        validationIssues.length
          ? validationIssues
          : ["최대 5회 대화 안에 숙소 카드 또는 검색 결과 진입 신호가 보여야 합니다."]
      );
    }

    if (validationIssues.length) {
      fail(
        "대화형 검색 응답 품질 또는 맥락 유지 검증에 실패했습니다.",
        steps,
        validationIssues
      );
    }

    const selectedListing = await openListingFromResults(
      config,
      device,
      store,
      steps,
      latestResultXml || xml,
      scenario
    );
    manualChecks.push(...selectedListing.condition_validation.manual_required.map((item) => `집 상세 수동 확인: ${item}`));

    const completeText = conversation.map((item) => item.response).join("\n");
    for (const planned of scenario.turns.filter((item) => usedIntents.has(item.intent))) {
      if (planned.expectedSignals?.length && !planned.expectedSignals.some((signal) => completeText.includes(signal))) {
        manualChecks.push(`${planned.intent}: AI 답변/결과에서 '${planned.expectedSignals.join(" 또는 ")}' 조건 반영을 XML로 확인하지 못했습니다.`);
      }
    }

    const finalArtifacts = await saveArtifacts(config, device, store, "conversational-search-final", xml);
    addStep(steps, "숙소 검색 결과 및 대화 맥락 확인");

    return {
      test_id: "TC-CONVERSATIONAL-SEARCH-001",
      name: "guest 대화형 검색",
      env,
      status: "pass",
      device,
      steps,
      conversational_search: {
        scenario: scenario.label,
        initial_prompt: scenario.initialPrompt,
        turns: conversation.length,
        result_visible: resultObserved,
        conversation,
        validation: {
          relevance: "pass",
          context_continuity: "pass",
          result_delivery: "pass",
          manual_required: manualChecks
        },
        selected_listing: selectedListing,
        sources: [
          "Airbnb monthly stay/search filter guidance",
          "Booking.com for Business extended-stay preference research",
          "한국관광공사 워케이션·장기체류 자료"
        ]
      },
      artifacts: {
        screenshots: [finalArtifacts.screenshotPath, ...selectedListing.artifacts.screenshots],
        logs: [path.join(store.logsDir, "runner.log"), finalArtifacts.xmlPath, ...selectedListing.artifacts.logs]
      }
    };
  });
}

module.exports = {
  INITIAL_PROMPT,
  evaluateResponse,
  runConversationalSearchTest,
  selectFollowUp
};
