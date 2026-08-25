const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  activateApp,
  createSession,
  drag,
  launchApp,
  releaseSession,
  swipe,
  tap,
  tapAccessibilityId,
  terminateApp
} = require("../infra/ios-wda");
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
const {
  ensureHome,
  hasLoadedSearchResultContent,
  isHome,
  isSearchResults,
  openSchedule,
  selectExactSchedule,
  selectFlexibleSchedule,
  submitSearch,
  summarizeSearchResults
} = require("./ios-search.test");

const CANCEL_REASONS = [
  "다른 사이트에서 계약했어요.",
  "다른 집으로 계약할래요.",
  "계획이 변경/취소 되었어요.",
  "계약 일정/인원이 변경되어 다시 요청할게요."
];

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

function exactButton(nodes, label, visible = true) {
  return nodes.find((node) => (
    node.attrs.type === "Button" &&
    (node.attrs.label === label || node.attrs.name === label) &&
    node.attrs.enabled !== false &&
    (!visible || (
      node.bounds &&
      node.bounds.y >= 60 &&
      node.bounds.y <= 790 &&
      node.attrs.visible !== false
    ))
  ));
}

function parseListing(label) {
  const lines = String(label || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const minimumStayIndex = lines.findIndex((line) => line.startsWith("최소 "));
  return {
    accommodation: minimumStayIndex >= 2 ? lines[minimumStayIndex - 1] : "",
    raw: String(label || "")
  };
}

function findListing(nodes) {
  return nodes.find((node) => {
    const label = nodeLabel(node);
    return node.bounds &&
      node.attrs.visible !== false &&
      node.bounds.y > 120 &&
      node.bounds.y < 800 &&
      label.includes("최소") &&
      /₩[\d,]+/.test(label);
  });
}

function findVisibleListings(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    const label = nodeLabel(node);
    if (!node.bounds || node.attrs.visible === false || node.bounds.y <= 120 || node.bounds.y >= 800) return false;
    if (!label.includes("최소") || !/₩[\d,]+/.test(label)) return false;
    const key = `${label}|${node.bounds.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function selectNewestSort(wdaUrl, sessionId, nodes, steps) {
  if (labelsText(nodes).includes("신규 집 순")) return nodes;

  const sortButton = exactButton(nodes, "리브 추천 순") ||
    findNode(nodes, ["리브 추천 순", "리브 추천순"], { visible: true, enabled: true });
  if (!sortButton) fail("iOS 검색 결과에서 리브 추천 순 필터를 찾지 못했습니다.", steps);

  await tapNode(wdaUrl, sessionId, sortButton, "리브 추천 순", steps);
  addStep(steps, "검색 결과 정렬 필터 선택", "pass", "리브 추천 순");
  nodes = await waitForNodes(wdaUrl, sessionId, (candidate) => labelsText(candidate).includes("신규 집 순"), 8000);

  const newestButton = exactButton(nodes, "신규 집 순") ||
    findNode(nodes, ["신규 집 순"], { visible: true, enabled: true });
  if (!newestButton) fail("iOS 검색 결과 정렬 옵션에서 신규 집 순을 찾지 못했습니다.", steps);

  await tapNode(wdaUrl, sessionId, newestButton, "신규 집 순", steps);
  addStep(steps, "검색 결과 신규 집 순 정렬 선택");
  nodes = await waitForNodes(
    wdaUrl,
    sessionId,
    (candidate) => isSearchResults(candidate) && labelsText(candidate).includes("신규 집 순"),
    10000
  );
  if (!labelsText(nodes).includes("신규 집 순")) {
    fail("iOS 검색 결과에 신규 집 순 정렬이 적용되지 않았습니다.", steps);
  }
  addStep(steps, "검색 결과 신규 집 순 정렬 확인");
  return nodes;
}

function isContractDetail(nodes) {
  const text = labelsText(nodes);
  return text.includes("계약번호:") && (
    text.includes("호스트가 확인 중이에요") ||
    text.includes("계약 진행") ||
    text.includes("계약 확정")
  );
}

function isContractRequestPage(nodes) {
  const text = labelsText(nodes);
  return text.includes("계약 요청하기") &&
    text.includes("계약자 정보") &&
    (text.includes("결제 수단") || text.includes("필수 약관 전체 동의"));
}

async function dismissCouponPatchAlert(wdaUrl, sessionId, nodes, steps) {
  const text = labelsText(nodes);
  if (!text.includes("쿠폰 리스트 패치에 실패했습니다")) return nodes;

  const okButton = exactButton(nodes, "Ok", false);
  if (!okButton) return nodes;

  await tapNode(wdaUrl, sessionId, okButton, "쿠폰 리스트 오류 팝업 Ok", steps);
  addStep(
    steps,
    "쿠폰 리스트 오류 팝업 닫기",
    "pass",
    "계약 요청 화면을 가리는 비핵심 쿠폰 조회 오류 팝업을 닫고 계약 요청 검증을 계속합니다."
  );
  return waitForNodes(wdaUrl, sessionId, isContractRequestPage, 8000);
}

function isRequestComplete(nodes) {
  const text = labelsText(nodes);
  return text.includes("홈으로") && /계약.*요청.*(완료|전달|보냈)/.test(text);
}

function isCancelReasonPage(nodes) {
  const text = labelsText(nodes);
  return text.includes("취소 사유 선택") && CANCEL_REASONS.some((reason) => text.includes(reason));
}

function isCancelComplete(nodes) {
  return labelsText(nodes).includes("계약이 취소되었습니다.");
}

function extractContractDetail(nodes) {
  const text = labelsText(nodes);
  const contractNumber = text.match(/계약번호:\s*(\d+)/)?.[1] || "";
  const schedule = text.match(/(\d{4}년\s*\d{1,2}월\s*\d{1,2}일[^\n]*)[\s\S]*?(\d+)박\s*(\d+)일[\s\S]*?(\d{4}년\s*\d{1,2}월\s*\d{1,2}일[^\n]*)/);
  return {
    contract_number: contractNumber,
    start_date_text: schedule?.[1] || "",
    stay_nights: schedule ? Number(schedule[2]) : null,
    end_date_text: schedule?.[4] || ""
  };
}

async function waitForLoadedResults(wdaUrl, sessionId) {
  return waitForNodes(
    wdaUrl,
    sessionId,
    (nodes) => isSearchResults(nodes) && hasLoadedSearchResultContent(nodes),
    20000
  );
}

async function ensureIosHome(wdaUrl, sessionId, bundleId, steps) {
  let nodes = await ensureHome(wdaUrl, sessionId, steps);
  if (isHome(nodes)) return nodes;

  // 이전 검증이 완료/상세 WebView에 남아 있으면 앱 재실행으로 시작점만 복구한다.
  await terminateApp(wdaUrl, sessionId, bundleId);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await launchApp(wdaUrl, sessionId, bundleId);
  addStep(steps, "iOS 기존 화면에서 홈으로 복구");
  return waitForNodes(wdaUrl, sessionId, isHome, 12000);
}

async function openFirstContractableListing(wdaUrl, sessionId, schedule, steps, settleMs) {
  let nodes = await waitForLoadedResults(wdaUrl, sessionId);
  if (!isSearchResults(nodes)) return { nodes, listing: null };

  const summary = summarizeSearchResults(nodes, schedule);
  if (!summary.condition_matches) {
    fail(
      "iOS 검색 결과에 선택한 일정이 반영되지 않았습니다.",
      steps,
      [`선택 일정: ${schedule.label}`, `결과 조건: ${summary.applied_condition || "확인 불가"}`]
    );
  }

  nodes = await selectNewestSort(wdaUrl, sessionId, nodes, steps);
  await swipe(wdaUrl, sessionId, 195, 720, 195, 300, 100);
  await new Promise((resolve) => setTimeout(resolve, 250));
  nodes = await dumpNodes(wdaUrl, sessionId);
  addStep(steps, "검색 결과 리스트 끌어올리기");

  let listings = findVisibleListings(nodes);
  for (let attempt = 0; attempt < 3 && listings.length < 2; attempt += 1) {
    await drag(wdaUrl, sessionId, 195, 700, 195, 430, 0.12);
    await new Promise((resolve) => setTimeout(resolve, 250));
    nodes = await dumpNodes(wdaUrl, sessionId);
    listings = findVisibleListings(nodes);
  }
  const selectableListings = listings.length > 1 ? listings.slice(1) : [];
  let listing = selectableListings.length ? randomItem(selectableListings) : null;
  if (!listing) return { nodes, listing: null };
  const selectedLabel = nodeLabel(listing);

  // 검색 결과 렌더링 직후 카드를 누르면 상세 데이터 로딩과 탭이 겹칠 수 있다.
  // 짧게 안정화한 뒤 최신 노드에서 같은 카드 후보를 다시 찾아 탭한다.
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  nodes = await dumpNodes(wdaUrl, sessionId);
  listings = findVisibleListings(nodes);
  listing = listings.find((candidate) => nodeLabel(candidate) === selectedLabel) ||
    (listings.length > 1 ? randomItem(listings.slice(1)) : null);
  if (!listing) return { nodes, listing: null };

  const listingInfo = parseListing(nodeLabel(listing));
  await tapNode(wdaUrl, sessionId, listing, "iOS 검색 결과 숙소", steps);
  const detailNodes = await waitForNodes(
    wdaUrl,
    sessionId,
    (candidate) => Boolean(exactButton(candidate, "계약 조건 확인")),
    12000
  );
  const detailOpened = Boolean(exactButton(detailNodes, "계약 조건 확인"));
  if (detailOpened) {
    addStep(
      steps,
      "검색 결과 숙소 선택 및 상세 진입 확인",
      "pass",
      listingInfo.accommodation || "첫 번째 계약 가능 숙소"
    );
  }
  return { nodes: detailNodes, listing: listingInfo, detailOpened };
}

async function selectPaymentAndTerms(wdaUrl, sessionId, steps, requestPageNodes) {
  // WDA source 조회는 실기기에서 수 초가 걸린다. 각 스크롤 사이에 조회하지 않고
  // 하단까지 연속 이동한 뒤 한 번만 읽어 결제 수단과 약관을 함께 처리한다.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await swipe(wdaUrl, sessionId, 195, 720, 195, 100, 80);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  addStep(steps, "계약 요청 상세 하단 빠른 이동");

  // 현재 iOS 검증 단말(390x844pt)은 하단 도착 시 결제 수단과 전체 동의의
  // 위치가 고정된다. 중간 WDA source 조회를 생략하고 즉시 선택한다.
  const paymentTapped = await tapAccessibilityId(
    wdaUrl,
    sessionId,
    "호스트 수락 후 직접 결제 (해외 발행 카드 사용 가능)"
  );
  if (!paymentTapped) await tap(wdaUrl, sessionId, 201, 392);
  addStep(steps, "호스트 수락 후 직접 결제 선택");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const termsTapped = await tapAccessibilityId(wdaUrl, sessionId, "필수 약관 전체 동의");
  if (!termsTapped) await tap(wdaUrl, sessionId, 84, 551);
  addStep(steps, "필수 약관 전체 동의 선택");
  // 제출 및 완료 화면 전환을 최종 성공 기준으로 사용한다.
  return requestPageNodes;
}

async function runIosContractRequestTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env === "stg" ? "staging" : request.env || "staging";
  const ios = config.appBuild?.ios || {};
  const wdaUrl = ios.wdaUrls?.[role];
  const bundleId = ios.bundleIds?.[env];
  const transitionSettleMs = env === "staging" ? 1500 : 700;
  const steps = [];

  if (role !== "guest") throw new Error("iOS 계약 요청은 guest role에서만 실행할 수 있습니다.");
  if (!wdaUrl || !bundleId) throw new Error(`iOS guest 실행 설정을 찾지 못했습니다 (env: ${env}).`);

  return withDeviceLock(wdaUrl, async () => {
    let sessionId;
    try {
      sessionId = await createSession(wdaUrl, bundleId);
      await activateApp(wdaUrl, sessionId, bundleId);
      addStep(steps, "iOS 앱 활성화");

      const homeNodes = await ensureIosHome(wdaUrl, sessionId, bundleId, steps);
      if (!isHome(homeNodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-start-home-not-found", homeNodes);
        fail("iOS 계약 요청을 시작할 홈 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }

      let nodes = await openSchedule(wdaUrl, sessionId, steps);
      const useFlexibleSchedule = Math.random() < 0.5;
      const schedule = useFlexibleSchedule
        ? await selectFlexibleSchedule(wdaUrl, sessionId, nodes, steps)
        : await selectExactSchedule(wdaUrl, sessionId, nodes, steps);
      await submitSearch(wdaUrl, sessionId, steps);
      const opened = await openFirstContractableListing(
        wdaUrl,
        sessionId,
        schedule,
        steps,
        transitionSettleMs
      );
      nodes = opened.nodes;
      if (!opened.listing) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-listing-not-found", nodes);
        fail("iOS 검색 결과에서 계약 가능한 숙소를 찾지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      if (!opened.detailOpened) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-listing-detail-not-opened", nodes);
        fail(
          "iOS 검색 결과 숙소를 눌렀지만 숙소 상세 화면으로 이동하지 않았습니다.",
          steps,
          [path.basename(artifacts.screenshotPath)]
        );
      }
      // 숙소 상세의 계약/쿠폰 데이터가 준비된 뒤 계약 요청 화면으로 이동한다.
      await new Promise((resolve) => setTimeout(resolve, transitionSettleMs));
      nodes = await dumpNodes(wdaUrl, sessionId);
      const conditionButton = exactButton(nodes, "계약 조건 확인");
      if (!conditionButton) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-house-detail-not-found", nodes);
        fail("iOS 숙소 상세에서 계약 조건 확인 버튼을 찾지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      await tapNode(wdaUrl, sessionId, conditionButton, "계약 조건 확인", steps);
      addStep(steps, "숙소 상세 계약 조건 확인 선택");

      nodes = await waitForNodes(
        wdaUrl,
        sessionId,
        (candidate) => isContractRequestPage(candidate) ||
          labelsText(candidate).includes("쿠폰 리스트 패치에 실패했습니다"),
        12000
      );
      nodes = await dismissCouponPatchAlert(wdaUrl, sessionId, nodes, steps);
      if (!isContractRequestPage(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-request-page-not-found", nodes);
        fail("iOS 계약 요청하기 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      saveNodesSnapshot(store, "ios-contract-request-page", nodes);
      const requestPageText = labelsText(nodes);
      const accommodation = opened.listing.accommodation ||
        requestPageText.match(/계약 요청하기[\s\S]*?\n([^\n]+)\n/)?.[1] || "";

      nodes = await selectPaymentAndTerms(wdaUrl, sessionId, steps, nodes);
      const submitButton = exactButton(nodes, "계약 요청하기");
      if (!submitButton) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-submit-not-found", nodes);
        fail("iOS 계약 요청하기 버튼을 찾지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      await tapNode(wdaUrl, sessionId, submitButton, "계약 요청하기", steps);
      addStep(steps, "계약 요청하기 버튼 선택");

      nodes = await waitForNodes(
        wdaUrl,
        sessionId,
        (candidate) => labelsText(candidate).includes("계약 기간 확인") || isRequestComplete(candidate),
        8000
      );
      const continueButton = exactButton(nodes, "요청 계속하기");
      if (continueButton) {
        await tapNode(wdaUrl, sessionId, continueButton, "요청 계속하기", steps);
        addStep(steps, "계약 기간 확인 팝업 요청 계속하기");
      }

      nodes = await waitForNodes(wdaUrl, sessionId, isRequestComplete, 20000);
      if (!isRequestComplete(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-request-complete-not-found", nodes);
        fail("iOS 계약 요청 완료 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      addStep(steps, "계약 요청 완료 화면 확인");
      const homeButton = exactButton(nodes, "홈으로") || findExactNode(nodes, ["홈으로"], { visible: true, enabled: true });
      await tapNode(wdaUrl, sessionId, homeButton, "완료 화면 홈으로", steps);
      addStep(steps, "완료 화면 홈으로 버튼 선택");

      nodes = await waitForNodes(wdaUrl, sessionId, isHome, 12000);
      if (!isHome(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-home-not-found", nodes);
        fail("홈으로 버튼을 눌렀지만 iOS 홈 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      addStep(steps, "계약 요청 완료 후 홈 화면 확인");

      return {
        test_id: "TC-IOS-CONTRACT-REQUEST-001",
        name: "iOS guest 계약 요청",
        env,
        status: "pass",
        device: wdaUrl,
        contract_conditions: {
          accommodation,
          schedule_type: useFlexibleSchedule ? "유연한 일정" : "정확한 일정",
          ...(useFlexibleSchedule
            ? {
                stay_duration: schedule.duration,
                expected_move_in_months: [`${schedule.move_in_year}-${String(schedule.month).replace(/\D/g, "").padStart(2, "0")}`]
              }
            : {
                start_date: schedule.start_date,
                end_date: schedule.end_date,
                stay_nights: schedule.stay_nights
              }),
          guests: "성인 1명",
          payment_method: "호스트 수락 후 직접 결제"
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

async function findRequestCard(nodes) {
  return nodes.find((node) => {
    const label = nodeLabel(node);
    return node.bounds && node.attrs.visible !== false && label.includes("요청 중") && node.bounds.y > 80 && node.bounds.y < 760;
  });
}

async function runIosContractCancelRequestTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env === "stg" ? "staging" : request.env || "staging";
  const ios = config.appBuild?.ios || {};
  const wdaUrl = ios.wdaUrls?.[role];
  const bundleId = ios.bundleIds?.[env];
  const steps = [];

  if (role !== "guest") throw new Error("iOS 계약 요청 취소는 guest role에서만 실행할 수 있습니다.");
  if (!wdaUrl || !bundleId) throw new Error(`iOS guest 실행 설정을 찾지 못했습니다 (env: ${env}).`);

  return withDeviceLock(wdaUrl, async () => {
    let sessionId;
    try {
      sessionId = await createSession(wdaUrl, bundleId);
      await activateApp(wdaUrl, sessionId, bundleId);
      addStep(steps, "iOS 앱 활성화");

      let nodes = await ensureIosHome(wdaUrl, sessionId, bundleId, steps);
      const requestCard = await findRequestCard(nodes);
      if (!requestCard) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-request-card-not-found", nodes);
        fail("iOS 홈에서 요청 중 계약 카드를 찾지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      const cardText = nodeLabel(requestCard);
      await tapNode(wdaUrl, sessionId, requestCard, "요청 중 계약 카드", steps);
      addStep(steps, "홈 화면 요청 중 계약 카드 선택");

      nodes = await waitForNodes(wdaUrl, sessionId, isContractDetail, 15000);
      if (!isContractDetail(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-request-detail-not-found", nodes);
        fail("iOS 요청 계약 상세 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      const contract = extractContractDetail(nodes);
      addStep(steps, "계약 요청 상세 확인", "pass", contract.contract_number || "계약번호 확인");

      // 계약 상세 하단 탐색도 스크롤마다 WDA source를 읽지 않는다.
      // 연속 이동 후 한 번만 확인하고, 부족할 때만 보정 스크롤을 수행한다.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await swipe(wdaUrl, sessionId, 195, 720, 195, 100, 80);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      addStep(steps, "계약 상세 하단 빠른 이동");

      nodes = await dumpNodes(wdaUrl, sessionId);
      let cancelButton = exactButton(nodes, "계약 취소");
      if (!cancelButton) {
        await drag(wdaUrl, sessionId, 195, 720, 195, 180, 0.05);
        await new Promise((resolve) => setTimeout(resolve, 100));
        nodes = await dumpNodes(wdaUrl, sessionId);
        cancelButton = exactButton(nodes, "계약 취소");
      }
      if (!cancelButton) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-cancel-button-not-found", nodes);
        fail("iOS 계약 상세 하단에서 계약 취소 버튼을 찾지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      await tapNode(wdaUrl, sessionId, cancelButton, "계약 취소", steps);
      addStep(steps, "계약 상세 계약 취소 버튼 선택");

      nodes = await waitForNodes(wdaUrl, sessionId, isCancelReasonPage, 15000);
      if (!isCancelReasonPage(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-cancel-reason-page-not-found", nodes);
        fail("iOS 계약 취소 사유 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      const reason = randomItem(CANCEL_REASONS);
      const reasonButton = exactButton(nodes, reason);
      await tapNode(wdaUrl, sessionId, reasonButton, "계약 취소 사유", steps);
      addStep(steps, "계약 취소 사유 선택", "pass", reason);

      nodes = await dumpNodes(wdaUrl, sessionId);
      const finalCancelButton = exactButton(nodes, "계약 취소");
      await tapNode(wdaUrl, sessionId, finalCancelButton, "최종 계약 취소", steps);
      addStep(steps, "최종 계약 취소 버튼 선택");

      nodes = await waitForNodes(wdaUrl, sessionId, isCancelComplete, 20000);
      if (!isCancelComplete(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-contract-cancel-complete-not-found", nodes);
        fail("iOS 계약 요청 취소 완료 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      addStep(steps, "계약 요청 취소 완료 화면 확인");

      // 성공한 취소만 앱을 새로 시작한다. 실패 화면은 원인 확인을 위해 그대로 둔다.
      await terminateApp(wdaUrl, sessionId, bundleId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await launchApp(wdaUrl, sessionId, bundleId);
      nodes = await waitForNodes(wdaUrl, sessionId, isHome, 12000);
      if (!isHome(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "ios-cancel-relaunch-home-not-found", nodes);
        fail("계약 취소 완료 후 앱을 재실행했지만 홈 화면을 확인하지 못했습니다.", steps, [path.basename(artifacts.screenshotPath)]);
      }
      addStep(steps, "취소 완료 후 앱 종료 및 재실행");

      return {
        test_id: "TC-IOS-CONTRACT-CANCEL-REQUEST-001",
        name: "iOS guest 계약 요청 취소",
        env,
        status: "pass",
        device: wdaUrl,
        cancel_conditions: {
          type: "계약 요청 취소",
          reason,
          contract_number: contract.contract_number,
          request_card: cardText.replace(/\s+/g, " ").trim()
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

module.exports = {
  runIosContractCancelRequestTest,
  runIosContractRequestTest
};
