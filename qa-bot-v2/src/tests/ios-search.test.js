const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const { activateApp, createSession, releaseSession } = require("../infra/ios-wda");
const {
  dumpNodes,
  findExactNode,
  findNode,
  nodeLabel,
  saveFailureArtifacts,
  saveNodesSnapshot,
  tapNode,
  waitForNodes
} = require("./helpers/ios-automation");

const HOME_SEARCH_LABELS = ["동네 · 주변 장소로 검색", "동네 주변 장소로 검색"];

function addStep(steps, name, status = "pass", message) {
  steps.push({ name, status, ...(message ? { message } : {}) });
}

function fail(message, steps, details = []) {
  const error = new Error(message);
  error.steps = steps;
  error.details = details;
  throw error;
}

function labelsText(nodes) {
  return nodes.map(nodeLabel).filter(Boolean).join("\n");
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function dumpNodesWithRetry(wdaUrl, sessionId, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await dumpNodes(wdaUrl, sessionId);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

function isHome(nodes) {
  return Boolean(findNode(nodes, HOME_SEARCH_LABELS, { visible: true }));
}

function isSearchCondition(nodes) {
  const labels = labelsText(nodes);
  return labels.includes("위치") && labels.includes("일정") && labels.includes("게스트");
}

function isGuestSelection(nodes) {
  const labels = labelsText(nodes);
  return ["성인", "어린이", "유아", "반려동물", "검색"].every((label) => labels.includes(label));
}

function isSearchResults(nodes) {
  const labels = labelsText(nodes);
  return labels.includes("국내") && (
    labels.includes("필터") ||
    labels.includes("리브 추천 순") ||
    /\d[\d,]*개의 집/.test(labels)
  );
}

function findTopLeftClose(nodes) {
  return nodes.find((node) => (
    node.attrs.visible !== false &&
    node.attrs.enabled !== false &&
    node.attrs.type === "Button" &&
    node.bounds &&
    node.bounds.x <= 55 &&
    node.bounds.y <= 110
  ));
}

async function ensureHome(wdaUrl, sessionId, steps) {
  let nodes = await dumpNodes(wdaUrl, sessionId);
  for (let attempt = 0; attempt < 3 && !isHome(nodes); attempt += 1) {
    const close = findTopLeftClose(nodes);
    if (!close) break;
    await tapNode(wdaUrl, sessionId, close, "iOS 상단 닫기/뒤로가기", steps);
    addStep(steps, "iOS 기존 검색 화면 닫기");
    await new Promise((resolve) => setTimeout(resolve, 500));
    nodes = await dumpNodes(wdaUrl, sessionId);
  }
  return nodes;
}

async function openSchedule(wdaUrl, sessionId, steps) {
  let nodes = await ensureHome(wdaUrl, sessionId, steps);
  const searchBar = findNode(nodes, HOME_SEARCH_LABELS, { visible: true, enabled: true });
  await tapNode(wdaUrl, sessionId, searchBar, "iOS 홈 검색바", steps);
  addStep(steps, "iOS 홈 검색바 선택");

  nodes = await waitForNodes(wdaUrl, sessionId, isSearchCondition, 7000);
  if (!isSearchCondition(nodes)) return nodes;

  await tapNode(
    wdaUrl,
    sessionId,
    findExactNode(nodes, ["국내"], { visible: true, enabled: true }),
    "국내 지역",
    steps
  );
  addStep(steps, "국내 지역 선택");

  nodes = await dumpNodes(wdaUrl, sessionId);
  await tapNode(
    wdaUrl,
    sessionId,
    findExactNode(nodes, ["일정"], { visible: true, enabled: true }),
    "일정 탭",
    steps
  );
  addStep(steps, "일정 탭 진입");

  return waitForNodes(
    wdaUrl,
    sessionId,
    (candidate) => labelsText(candidate).includes("정확한 일정") && labelsText(candidate).includes("유연한 일정"),
    7000
  );
}

function visibleCalendarDates(nodes) {
  let year;
  let month;
  const dates = [];

  for (const node of nodes) {
    const label = String(node.attrs.label || node.attrs.name || "").trim();
    const monthMatch = label.match(/(\d{4})년\s*(\d{1,2})월/);
    if (monthMatch) {
      year = Number(monthMatch[1]);
      month = Number(monthMatch[2]);
      continue;
    }
    const dayMatch = label.match(/^(\d{1,2})(?:\s*\n?\s*오늘)?$/);
    if (!year || !month || !dayMatch || !node.bounds || node.attrs.visible === false) continue;
    dates.push({ node, date: new Date(year, month - 1, Number(dayMatch[1]), 12) });
  }
  return dates;
}

function formatMonthDay(date) {
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function summarizeSearchResults(nodes, schedule) {
  // WDA는 동일 문구를 label/name에 중복 제공할 수 있어 대표 값만 사용한다.
  const labels = nodes
    .map((node) => String(node.attrs.label || node.attrs.name || node.attrs.value || "").trim())
    .filter(Boolean);
  const condition = labels.find((label) => label.includes("국내") && label.includes("1명")) || "";
  const resultCountLabel = labels.find((label) => /\d[\d,]*개의 집/.test(label)) || "";
  const resultCountMatch = resultCountLabel.match(/(\d[\d,]*)개의 집/);
  const noResults = labels.some((label) => /검색 결과가 없|집을 찾지 못|조건에 맞는 집이 없/.test(label));
  const firstListingLabel = labels.find((label) => label.includes("최소") && /₩[\d,]+/.test(label)) || "";
  const firstListingLines = firstListingLabel.split("\n").map((line) => line.trim()).filter(Boolean);
  const minimumStayIndex = firstListingLines.findIndex((line) => line.startsWith("최소 "));
  const firstListing = minimumStayIndex >= 2 ? firstListingLines[minimumStayIndex - 1] : "";
  const expectedSchedule = schedule.label.replace(/\s+/g, " ");
  const normalizedCondition = condition.replace(/\s+/g, " ");

  return {
    applied_condition: normalizedCondition,
    condition_matches: normalizedCondition.includes("국내") &&
      normalizedCondition.includes(expectedSchedule) &&
      normalizedCondition.includes("1명"),
    result_count: resultCountMatch ? Number(resultCountMatch[1].replace(/,/g, "")) : noResults ? 0 : null,
    first_listing: firstListing,
    sort_visible: labels.includes("리브 추천 순"),
    filter_visible: labels.includes("필터"),
    map_visible: labels.some((label) => label.includes("Map") || label.includes("지도로 보기")),
    result_panel_visible: Boolean(resultCountMatch || firstListing || noResults)
  };
}

function hasLoadedSearchResultContent(nodes) {
  const labels = nodes
    .map((node) => String(node.attrs.label || node.attrs.name || node.attrs.value || "").trim())
    .filter(Boolean);
  return labels.some((label) => (
    /\d[\d,]*개의 집/.test(label) ||
    (label.includes("최소") && /₩[\d,]+/.test(label)) ||
    /검색 결과가 없|집을 찾지 못|조건에 맞는 집이 없/.test(label)
  ));
}

async function selectExactSchedule(wdaUrl, sessionId, nodes, steps) {
  await tapNode(
    wdaUrl,
    sessionId,
    findExactNode(nodes, ["정확한 일정"], { visible: true, enabled: true }),
    "정확한 일정",
    steps
  );
  addStep(steps, "정확한 일정 선택");
  await new Promise((resolve) => setTimeout(resolve, 300));

  nodes = await dumpNodes(wdaUrl, sessionId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidates = visibleCalendarDates(nodes)
    .filter(({ date, node }) => date > today && node.attrs.enabled !== false)
    .sort((left, right) => left.date - right.date);
  const selectableCheckins = candidates.filter((candidate, index) => (
    candidates.slice(index + 1).some(({ date }) => (
      Math.round((date - candidate.date) / 86400000) >= 6
    ))
  ));
  const checkin = randomItem(selectableCheckins);
  const checkoutCandidates = checkin
    ? candidates.filter(({ date }) => Math.round((date - checkin.date) / 86400000) >= 6)
    : [];
  const checkout = randomItem(checkoutCandidates);

  if (!checkin || !checkout) {
    fail(
      "iOS 달력에서 선택 가능한 랜덤 일정을 찾지 못했습니다.",
      steps,
      ["현재 화면에 보이는 오늘 이후 날짜 중 체크인보다 늦은 체크아웃을 랜덤 선택합니다."]
    );
  }

  await tapNode(wdaUrl, sessionId, checkin.node, "iOS 체크인 날짜", steps);
  addStep(steps, "iOS 체크인 날짜 선택", "pass", formatMonthDay(checkin.date));
  await new Promise((resolve) => setTimeout(resolve, 200));

  nodes = await dumpNodes(wdaUrl, sessionId);
  const refreshedCheckout = visibleCalendarDates(nodes).find(({ date }) => date.getTime() === checkout.date.getTime());
  await tapNode(wdaUrl, sessionId, refreshedCheckout?.node, "iOS 체크아웃 날짜", steps);
  addStep(steps, "iOS 체크아웃 날짜 선택", "pass", formatMonthDay(checkout.date));

  nodes = await dumpNodes(wdaUrl, sessionId);
  await tapNode(
    wdaUrl,
    sessionId,
    findExactNode(nodes, ["다음"], { visible: true, enabled: true }),
    "일정 다음 버튼",
    steps
  );
  addStep(steps, "일정 다음 버튼 선택");
  const nights = Math.round((checkout.date - checkin.date) / 86400000);
  return {
    label: `${formatMonthDay(checkin.date)} ~ ${formatMonthDay(checkout.date)}`,
    start_date: formatIsoDate(checkin.date),
    end_date: formatIsoDate(checkout.date),
    stay_nights: nights
  };
}

async function selectFlexibleSchedule(wdaUrl, sessionId, nodes, steps) {
  await tapNode(
    wdaUrl,
    sessionId,
    findExactNode(nodes, ["유연한 일정"], { visible: true, enabled: true }),
    "유연한 일정",
    steps
  );
  addStep(steps, "유연한 일정 선택");
  await new Promise((resolve) => setTimeout(resolve, 250));

  nodes = await dumpNodes(wdaUrl, sessionId);
  const durationLabels = ["일주일", "2주", "한 달", "두 달 이상"];
  const durationCandidates = durationLabels
    .map((label) => ({ label, node: findExactNode(nodes, [label], { visible: true, enabled: true }) }))
    .filter(({ node }) => node?.bounds);
  const duration = randomItem(durationCandidates);
  if (!duration) {
    fail("iOS 유연한 일정에서 머무는 기간 선택지를 찾지 못했습니다.", steps);
  }
  await tapNode(wdaUrl, sessionId, duration?.node, "유연한 일정 기간", steps);
  addStep(steps, "유연한 일정 기간 랜덤 선택", "pass", duration.label);

  nodes = await dumpNodesWithRetry(wdaUrl, sessionId);
  const monthCandidates = nodes
    .map((node) => {
      const rawLabel = String(node.attrs.label || node.attrs.name || "").trim();
      const match = rawLabel.match(/^(\d{1,2})월\s*(\d{4})$/);
      return match && node.bounds && node.attrs.visible !== false && node.attrs.enabled !== false
        ? { month: `${Number(match[1])}월`, year: Number(match[2]), rawLabel, node }
        : null;
    })
    .filter(Boolean)
    .filter((candidate, index, all) => all.findIndex(({ rawLabel }) => rawLabel === candidate.rawLabel) === index);
  const selectedMonth = randomItem(monthCandidates);
  if (!selectedMonth) {
    fail("iOS 유연한 일정에서 예상 입주월 선택지를 찾지 못했습니다.", steps);
  }
  await tapNode(wdaUrl, sessionId, selectedMonth.node, "유연한 일정 입주월", steps);
  addStep(steps, "유연한 일정 입주월 랜덤 선택", "pass", selectedMonth.rawLabel.replace(/\s+/g, " "));

  nodes = await dumpNodes(wdaUrl, sessionId);
  await tapNode(wdaUrl, sessionId, findExactNode(nodes, ["다음"], { visible: true, enabled: true }), "일정 다음 버튼", steps);
  addStep(steps, "일정 다음 버튼 선택");
  return {
    label: `${duration.label} / ${selectedMonth.month}`,
    duration: duration.label,
    month: selectedMonth.month,
    move_in_year: selectedMonth.year
  };
}

async function submitSearch(wdaUrl, sessionId, steps) {
  let nodes = await waitForNodes(wdaUrl, sessionId, isGuestSelection, 7000);
  if (!isGuestSelection(nodes)) return nodes;
  await tapNode(wdaUrl, sessionId, findExactNode(nodes, ["검색"], { visible: true, enabled: true }), "검색 버튼", steps);
  addStep(steps, "기본 성인 1명으로 검색");
  return waitForNodes(wdaUrl, sessionId, isSearchResults, 20000);
}

async function runIosSearch({ request, config, store, flexible }) {
  const role = request.role || "guest";
  const env = request.env === "stg" ? "staging" : request.env || "staging";
  const ios = config.appBuild?.ios || {};
  const wdaUrl = ios.wdaUrls?.[role];
  const bundleId = ios.bundleIds?.[env];
  const steps = [];

  if (role !== "guest") throw new Error("iOS 검색은 현재 guest role만 지원합니다.");
  if (!wdaUrl) throw new Error("iOS guest WDA URL을 찾지 못했습니다.");
  if (!bundleId) throw new Error(`iOS bundle id를 찾지 못했습니다 (env: ${env}).`);

  return withDeviceLock(wdaUrl, async () => {
    let sessionId;
    try {
      sessionId = await createSession(wdaUrl, bundleId);
      addStep(steps, "WDA 세션 생성", "pass", wdaUrl);
      await activateApp(wdaUrl, sessionId, bundleId);
      addStep(steps, "iOS 앱 활성화", "pass", bundleId);

      let nodes = await openSchedule(wdaUrl, sessionId, steps);
      if (!isSearchCondition(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-search-condition-not-found", nodes);
        fail("iOS 검색 조건 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      saveNodesSnapshot(store, "ios-search-schedule", nodes);

      const schedule = flexible
        ? await selectFlexibleSchedule(wdaUrl, sessionId, nodes, steps)
        : await selectExactSchedule(wdaUrl, sessionId, nodes, steps);
      nodes = await submitSearch(wdaUrl, sessionId, steps);
      // 지도보다 늦게 그려지는 집 개수와 숙소 카드까지 기다려 결과 내용을 수집한다.
      nodes = await waitForNodes(
        wdaUrl,
        sessionId,
        (candidate) => isSearchResults(candidate) && hasLoadedSearchResultContent(candidate),
        6000
      );
      saveNodesSnapshot(store, "ios-search-results", nodes);

      if (!isSearchResults(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-search-results-not-found", nodes);
        fail(
          "iOS 검색 결과 목록을 확인하지 못했습니다.",
          steps,
          [`선택 일정: ${schedule.label}`, `리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`]
        );
      }
      const resultSummary = summarizeSearchResults(nodes, schedule);
      if (!resultSummary.condition_matches) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-search-condition-mismatch", nodes);
        fail(
          "iOS 검색 결과에 선택한 일정 또는 인원 조건이 정확히 반영되지 않았습니다.",
          steps,
          [
            `선택 조건: 국내 / ${schedule.label} / 성인 1명`,
            `결과 조건: ${resultSummary.applied_condition || "확인 불가"}`,
            `리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`
          ]
        );
      }
      if (!resultSummary.sort_visible || !resultSummary.filter_visible || !resultSummary.map_visible) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-search-result-controls-missing", nodes);
        fail(
          "iOS 검색 결과 화면의 정렬, 필터 또는 지도 영역을 확인하지 못했습니다.",
          steps,
          [`리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`]
        );
      }
      addStep(steps, "iOS 검색 조건 반영 확인", "pass", resultSummary.applied_condition);
      addStep(steps, "iOS 검색 결과 화면 구성 확인", "pass", "리브 추천 순 / 필터 / 지도");

      return {
        test_id: flexible ? "TC-IOS-SEARCH-002" : "TC-IOS-SEARCH-001",
        name: `iOS guest ${flexible ? "유연한 일정" : "정확한 일정"} 검색`,
        env,
        status: "pass",
        device: wdaUrl,
        search: {
          type: flexible ? "flexible" : "exact",
          region: "국내",
          ...schedule,
          guests: "성인 1명",
          ...resultSummary
        },
        steps,
        artifacts: { screenshots: [], logs: [] }
      };
    } catch (error) {
      if (!error.steps) error.steps = steps;
      throw error;
    } finally {
      if (sessionId) await releaseSession(wdaUrl, sessionId);
    }
  });
}

function runIosSearchTest(context) {
  return runIosSearch({ ...context, flexible: false });
}

function runIosFlexibleSearchTest(context) {
  return runIosSearch({ ...context, flexible: true });
}

module.exports = {
  ensureHome,
  hasLoadedSearchResultContent,
  isHome,
  isSearchResults,
  openSchedule,
  runIosFlexibleSearchTest,
  runIosSearchTest,
  selectExactSchedule,
  selectFlexibleSchedule,
  submitSearch,
  summarizeSearchResults
};
