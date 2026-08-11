const { withDeviceLock } = require("../infra/device-lock");
const {
  keyEvent,
  runAdb,
  tap
} = require("../infra/adb");
const {
  dumpUiStable,
  findNode,
  isVisibleNode,
  nodeLabel,
  parseNodes,
  saveFailureArtifacts,
  saveXml,
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

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });
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

function hasGuestHomeShell(xml) {
  return (
    xml.includes("홈") &&
    xml.includes("찜") &&
    xml.includes("리브후기") &&
    xml.includes("내 정보")
  );
}

function visibleLabelCount(xml) {
  return parseNodes(xml)
    .filter(isVisibleNode)
    .map((node) => nodeLabel(node).trim())
    .filter(Boolean)
    .length;
}

function hasReviewFeed(xml) {
  const visibleLabels = xmlTextLines(xml).join("\n");
  return (
    xml.includes("리브후기") &&
    visibleLabelCount(xml) >= 8 &&
    (
      visibleLabels.includes("#추천") ||
      visibleLabels.includes("팔로잉") ||
      visibleLabels.includes("추천") ||
      visibleLabels.includes("후기") ||
      visibleLabels.includes("댓글") ||
      visibleLabels.includes("좋아요")
    )
  );
}

function isReviewFeedBlank(xml) {
  return hasGuestHomeShell(xml) && visibleLabelCount(xml) <= 6;
}

function hasAppError(xml) {
  return [
    "일시적인 오류",
    "오류가 발생",
    "다시 시도해 주세요",
    "네트워크 연결 상태",
    "문제가 발생",
    "이미지를 불러오지 못"
  ].some((text) => xml.includes(text));
}

function findBottomTab(xml, label) {
  return parseNodes(xml).find((node) => {
    if (!node.bounds || node.bounds.top < 2200) return false;
    return nodeLabel(node).includes(label);
  });
}

function findRecommendTag(xml) {
  return findNode(xml, "#추천", {
    visible: true,
    clickable: true,
    enabled: true
  }) || parseNodes(xml).find((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    node.bounds.top >= 220 &&
    node.bounds.top <= 420 &&
    nodeLabel(node).includes("#추천")
  ));
}

function findFirstReviewCard(xml) {
  const card = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled !== "true") return false;
      const label = nodeLabel(node).trim();
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= 360 &&
        node.bounds.bottom <= 2310 &&
        node.bounds.left <= 80 &&
        node.bounds.right >= 1000 &&
        height >= 360 &&
        label &&
        !label.includes("#추천") &&
        !label.includes("리브후기")
      );
    })
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0];

  return card || null;
}

function hasReviewDetailScreen(xml) {
  if (hasReviewFeed(xml) && xml.includes("#추천")) return false;
  return (
    xml.includes("by") ||
    xml.includes("댓글") ||
    xml.includes("좋아요") ||
    xml.includes("공유") ||
    xml.includes("신고") ||
    xml.includes("동구") ||
    xml.includes("주택")
  ) && parseNodes(xml).some((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    node.bounds.top < 420 &&
    (
      String(node.attrs.class || "").includes("Image") ||
      node.attrs.clickable === "true"
    )
  ));
}

function hasHeaderImageOrFallback(xml) {
  const headerNodes = parseNodes(xml).filter((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    node.bounds.top >= 90 &&
    node.bounds.top <= 940 &&
    node.bounds.bottom > 260
  ));
  const imageNode = headerNodes.find((node) => (
    String(node.attrs.class || "").includes("Image") &&
    node.bounds.right - node.bounds.left >= 120 &&
    node.bounds.bottom - node.bounds.top >= 120
  ));
  const fallbackLabel = headerNodes
    .map(nodeLabel)
    .join("\n");

  return {
    ok: Boolean(imageNode) || [
      "사진",
      "이미지",
      "대표",
      "기본 이미지",
      "불러올 수"
    ].some((text) => fallbackLabel.includes(text)),
    mode: imageNode ? "헤더 이미지 노드 확인" : "헤더 이미지 폴백/문구 제한 확인",
    header_node_count: headerNodes.length
  };
}

function screenSignature(xml) {
  return xmlTextLines(xml)
    .slice(0, 32)
    .join("|")
    .replace(/\d{1,2}:\d{2}/g, "");
}

function visibleImageLikeCount(xml) {
  return parseNodes(xml).filter((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    (
      String(node.attrs.class || "").includes("Image") ||
      (
        node.attrs.clickable === "true" &&
        node.bounds.right - node.bounds.left >= 180 &&
        node.bounds.bottom - node.bounds.top >= 120
      )
    )
  )).length;
}

function hasDetailContentSignal(xml) {
  const labels = xmlTextLines(xml).join("\n");
  return (
    visibleLabelCount(xml) >= 4 &&
    (
      labels.includes("by") ||
      labels.includes("댓글") ||
      labels.includes("좋아요") ||
      labels.includes("일상") ||
      labels.includes("숙소") ||
      labels.includes("준비") ||
      labels.length >= 80
    )
  );
}

async function openReviewFeed(config, device, store, steps) {
  let xml = await waitForUi(config, device, hasGuestHomeShell, 8000);
  saveXml(store, "review-detail-home", xml);
  if (!hasGuestHomeShell(xml)) {
    await saveFailureArtifacts(config, device, store, "review-detail-home-not-found", xml);
    fail(
      "앱 실행 후 게스트 홈 하단 탭을 확인하지 못했습니다.",
      steps,
      [
        "리브후기 상세 테스트는 로그인된 게스트 앱 홈에서 시작해야 합니다.",
        "리포트의 review-detail-home-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const reviewTab = findBottomTab(xml, "리브후기");
  if (!reviewTab?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-detail-tab-not-found", xml);
    fail(
      "하단 리브후기 탭을 찾지 못했습니다.",
      steps,
      [
        "하단 탭에 '리브후기'가 보여야 합니다.",
        "리포트의 review-detail-tab-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, reviewTab.bounds.x, reviewTab.bounds.y);
  addStep(steps, "하단 리브후기 탭 선택");
  xml = await waitForUi(config, device, hasReviewFeed, 12000);
  if (!hasReviewFeed(xml) && isReviewFeedBlank(xml)) {
    await tap(config, device, reviewTab.bounds.x, reviewTab.bounds.y);
    addStep(steps, "리브후기 탭 재선택", "pass", "리브후기 본문이 회색 빈 화면이라 재로딩 시도");
    xml = await waitForUi(config, device, hasReviewFeed, 10000);
  }

  saveXml(store, "review-detail-feed", xml);
  if (!hasReviewFeed(xml)) {
    await saveFailureArtifacts(config, device, store, "review-detail-feed-not-found", xml);
    fail(
      isReviewFeedBlank(xml)
        ? "리브후기 화면 본문이 회색 빈 화면에서 로딩되지 않았습니다."
        : "리브후기 화면으로 진입하지 못했습니다.",
      steps,
      [
        "리브후기 탭 선택 후 실제 피드 본문과 #추천 태그가 보여야 합니다.",
        "리포트의 review-detail-feed-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function selectRecommendTag(config, device, store, steps, initialXml) {
  let xml = initialXml;
  const recommendTag = findRecommendTag(xml);
  if (!recommendTag?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-detail-recommend-tag-not-found", xml);
    fail(
      "리브후기 상단 #추천 태그를 찾지 못했습니다.",
      steps,
      [
        "리브후기 화면 상단 태그 영역에 #추천이 보여야 합니다.",
        "리포트의 review-detail-recommend-tag-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, recommendTag.bounds.x, recommendTag.bounds.y);
  addStep(steps, "상단 #추천 태그 선택");
  xml = await waitForUi(config, device, hasReviewFeed, 5000);
  saveXml(store, "review-detail-after-recommend", xml);
  return xml;
}

async function openFirstReviewDetail(config, device, store, steps, feedXml) {
  const firstCard = findFirstReviewCard(feedXml);
  if (!firstCard?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-detail-first-card-not-found", feedXml);
    fail(
      "리브후기 #추천 목록에서 첫 번째 후기 카드를 찾지 못했습니다.",
      steps,
      [
        "추천 태그 선택 후 첫 번째 후기 카드가 보여야 합니다.",
        "리포트의 review-detail-first-card-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const label = nodeLabel(firstCard).replace(/\s+/g, " ").trim();
  const tapX = Math.min(firstCard.bounds.x, 780);
  const tapY = Math.min(firstCard.bounds.top + 360, firstCard.bounds.bottom - 80);
  await tap(config, device, tapX, tapY);
  addStep(steps, "첫 번째 리브후기 카드 선택", "pass", label || "첫 번째 카드");

  const xml = await waitForUi(config, device, hasReviewDetailScreen, 9000);
  saveXml(store, "review-detail-screen", xml);
  if (!hasReviewDetailScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "review-detail-screen-not-found", xml);
    fail(
      "첫 번째 후기 카드를 눌렀지만 리브후기 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "상세 화면에는 헤더 이미지와 후기 본문/작성자/좋아요/댓글 관련 신호가 보여야 합니다.",
        "리포트의 review-detail-screen-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return { xml, card_label: label };
}

async function validateHeaderImage(config, device, store, steps, xml) {
  if (hasAppError(xml)) {
    await saveFailureArtifacts(config, device, store, "review-detail-app-error", xml);
    fail(
      "리브후기 상세 화면에서 이미지/네트워크 오류 문구가 노출되었습니다.",
      steps,
      [
        "상세 진입 시 일시적인 오류, 네트워크 오류, 이미지 로딩 실패 문구가 없어야 합니다.",
        "리포트의 review-detail-app-error.png 화면을 확인해주세요."
      ]
    );
  }

  const header = hasHeaderImageOrFallback(xml);
  if (!header.ok) {
    await saveFailureArtifacts(config, device, store, "review-detail-header-image-not-found", xml);
    fail(
      "리브후기 상세 헤더 이미지 또는 에러 폴백 신호를 확인하지 못했습니다.",
      steps,
      [
        "상세 화면 상단에는 헤더 이미지가 로딩되거나, 이미지 폴백 UI가 보여야 합니다.",
        "리포트의 review-detail-header-image-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "리브후기 상세 헤더 이미지/폴백 확인", "pass", header.mode);
  addStep(steps, "리브후기 상세 앱 오류 문구 미노출 확인");
  return header;
}

async function scrollDetailToBottom(config, device, store, steps, initialXml) {
  let xml = initialXml;
  const signatures = new Set();
  let stableCount = 0;
  let checkedScreens = 0;
  let contentSignalScreens = 0;
  let imageSignalScreens = 0;
  let maxVisibleLabels = visibleLabelCount(xml);

  for (let count = 0; count < 10; count += 1) {
    if (hasAppError(xml)) {
      await saveFailureArtifacts(config, device, store, "review-detail-scroll-app-error", xml);
      fail(
        "리브후기 상세 스크롤 중 이미지/네트워크 오류 문구가 노출되었습니다.",
        steps,
        [
          "상세 하단 스크롤 중에도 일시적인 오류, 네트워크 오류, 이미지 로딩 실패 문구가 없어야 합니다.",
          "리포트의 review-detail-scroll-app-error.png 화면을 확인해주세요."
        ]
      );
    }

    const signature = screenSignature(xml);
    signatures.add(signature);
    checkedScreens += 1;
    maxVisibleLabels = Math.max(maxVisibleLabels, visibleLabelCount(xml));
    if (hasDetailContentSignal(xml)) contentSignalScreens += 1;
    if (visibleImageLikeCount(xml) > 0) imageSignalScreens += 1;

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2140", "540", "520", "240"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
    saveXml(store, `review-detail-scroll-${count + 1}`, xml);

    const nextSignature = screenSignature(xml);
    if (nextSignature === signature) stableCount += 1;
    else stableCount = 0;

    if (stableCount >= 1) {
      addStep(steps, "리브후기 상세 하단 끝 도달", "pass", `${count + 1}회 스크롤 후 화면 변화 없음`);
      break;
    }
  }

  saveXml(store, "review-detail-bottom", xml);
  if (contentSignalScreens === 0 || maxVisibleLabels < 4) {
    await saveFailureArtifacts(config, device, store, "review-detail-content-not-found", xml);
    fail(
      "리브후기 상세 스크롤 중 본문 내용 노출을 확인하지 못했습니다.",
      steps,
      [
        "상세 화면을 아래로 스크롤하면서 후기 텍스트/작성자/댓글/좋아요 등 내용 신호가 유지되어야 합니다.",
        "리포트의 review-detail-content-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(
    steps,
    "리브후기 상세 하단 스크롤 및 내용 노출 확인",
    "pass",
    `${checkedScreens}개 화면 중 내용 신호 ${contentSignalScreens}개, 이미지 신호 ${imageSignalScreens}개`
  );

  return {
    checked_screens: checkedScreens,
    content_signal_screens: contentSignalScreens,
    image_signal_screens: imageSignalScreens,
    scroll_snapshots: signatures.size,
    max_visible_labels: maxVisibleLabels
  };
}

async function runReviewDetailTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("리브후기 상세 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    const feedXml = await openReviewFeed(config, device, store, steps);
    const recommendedXml = await selectRecommendTag(config, device, store, steps, feedXml);
    const detail = await openFirstReviewDetail(config, device, store, steps, recommendedXml);
    const header = await validateHeaderImage(config, device, store, steps, detail.xml);
    const scroll = await scrollDetailToBottom(config, device, store, steps, detail.xml);

    return {
      test_id: "TC-INTERNAL-REFACTOR-003",
      name: "guest 리브후기 상세",
      env,
      status: "pass",
      device,
      steps,
      review_detail: {
        selected_tag: "#추천",
        selected_card: detail.card_label,
        header_validation: header.mode,
        header_node_count: header.header_node_count,
        checked_screens: scroll.checked_screens,
        content_signal_screens: scroll.content_signal_screens,
        image_signal_screens: scroll.image_signal_screens,
        scroll_snapshots: scroll.scroll_snapshots,
        max_visible_labels: scroll.max_visible_labels,
        manual_check_required: [
          "헤더 이미지 픽셀 단위 로딩 품질",
          "실제 이미지 URL 실패 시 디자인 폴백 시각 동일 여부"
        ]
      }
    };
  });
}

module.exports = {
  runReviewDetailTest
};
