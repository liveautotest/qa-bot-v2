const fs = require("fs");
const path = require("path");
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
  await new Promise((resolve) => setTimeout(resolve, 500));
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

function hasReviewFeed(xml) {
  const topContentLabels = parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.bounds.top < 2100 &&
      nodeLabel(node).trim()
    ))
    .map(nodeLabel)
    .join("\n");

  return (
    xml.includes("리브후기") &&
    (
      xml.includes("팔로잉") ||
      xml.includes("추천") ||
      xml.includes("프로필") ||
      topContentLabels.includes("후기") ||
      topContentLabels.includes("게시물") ||
      topContentLabels.includes("댓글") ||
      visibleLabelCount(xml) >= 9
    ) &&
    topContentLabels.trim().length > 0
  );
}

function isReviewFeedBlank(xml) {
  return hasGuestHomeShell(xml) && visibleLabelCount(xml) <= 6;
}

function isReviewProfile(xml) {
  return (
    xml.includes("내 리브 후기") ||
    (
      xml.includes("리브 후기") &&
      (xml.includes("팔로워") || xml.includes("팔로잉") || xml.includes("게시물"))
    )
  );
}

function hasAppError(xml) {
  return [
    "일시적인 오류",
    "오류가 발생",
    "다시 시도해 주세요",
    "네트워크 연결 상태",
    "문제가 발생"
  ].some((text) => xml.includes(text));
}

function visibleLabelCount(xml) {
  return parseNodes(xml)
    .filter(isVisibleNode)
    .map((node) => nodeLabel(node).trim())
    .filter(Boolean)
    .length;
}

function visibleImageLikeCount(xml) {
  return parseNodes(xml)
    .filter((node) => (
      isVisibleNode(node) &&
      (
        String(node.attrs.class || "").includes("Image") ||
        node.attrs.clickable === "true"
      ) &&
      node.bounds.right > node.bounds.left
    ))
    .length;
}

function hasProfilePostLayoutSignals(xml) {
  const lines = xmlTextLines(xml);
  const joined = lines.join("\n");
  return (
    visibleLabelCount(xml) >= 5 &&
    (
      visibleImageLikeCount(xml) >= 1 ||
      joined.includes("by") ||
      joined.includes("좋아요") ||
      joined.includes("댓글") ||
      joined.includes("게시물") ||
      joined.includes("팔로워")
    )
  );
}

function findBottomTab(xml, label) {
  return parseNodes(xml).find((node) => {
    if (!node.bounds || node.bounds.top < 2200) return false;
    return nodeLabel(node).includes(label);
  });
}

function findTopRightProfileButton(xml) {
  const profileByLabel = findNode(xml, ["프로필", "내 프로필", "profile", "Profile"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (profileByLabel?.bounds && profileByLabel.bounds.top < 420 && profileByLabel.bounds.left > 650) {
    return profileByLabel;
  }

  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled === "true" &&
      node.bounds.top >= 80 &&
      node.bounds.top <= 380 &&
      node.bounds.left >= 780
    ))
    .sort((leftNode, rightNode) => rightNode.bounds.right - leftNode.bounds.right)[0] || null;
}

function fixedTopRightProfileButton() {
  return {
    bounds: {
      x: 946,
      y: 174
    }
  };
}

function extractNickname(xml) {
  const titleNode = findNode(xml, "내 리브 후기", { visible: true });
  const titleTop = titleNode?.bounds?.top || 0;
  const candidates = xmlTextLines(xml)
    .map((line) => line.trim())
    .filter((line) => (
      line &&
      line !== "내 리브 후기" &&
      !line.includes("리브후기") &&
      !line.includes("팔로워") &&
      !line.includes("팔로잉") &&
      !line.includes("게시물")
    ));

  const leftVisibleCandidate = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      const label = nodeLabel(node).trim();
      return (
        label &&
        label !== "내 리브 후기" &&
        node.bounds.left <= 520 &&
        node.bounds.top >= titleTop &&
        node.bounds.top <= 900 &&
        !label.includes("리브후기") &&
        !label.includes("팔로워") &&
        !label.includes("팔로잉") &&
        !label.includes("게시물")
      );
    })
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0];

  return leftVisibleCandidate ? nodeLabel(leftVisibleCandidate).trim() : candidates[0] || "";
}

async function openReviewProfile(config, device, store, steps) {
  let xml = await waitForUi(config, device, hasGuestHomeShell, 8000);
  saveXml(store, "review-home", xml);
  if (!hasGuestHomeShell(xml)) {
    await saveFailureArtifacts(config, device, store, "review-home-not-found", xml);
    fail(
      "앱 실행 후 게스트 홈 하단 탭을 확인하지 못했습니다.",
      steps,
      [
        "리브후기 프로필 테스트는 로그인된 게스트 앱 홈에서 시작해야 합니다.",
        "리포트의 review-home-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const reviewTab = findBottomTab(xml, "리브후기");
  if (!reviewTab?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-tab-not-found", xml);
    fail(
      "하단 리브후기 탭을 찾지 못했습니다.",
      steps,
      [
        "하단 탭에 '리브후기'가 보여야 합니다.",
        "리포트의 review-tab-not-found.png 화면을 확인해주세요."
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
  saveXml(store, "review-feed", xml);
  if (!hasReviewFeed(xml)) {
    await saveFailureArtifacts(config, device, store, "review-feed-not-found", xml);
    fail(
      isReviewFeedBlank(xml)
        ? "리브후기 화면 본문이 회색 빈 화면에서 로딩되지 않았습니다."
        : "리브후기 화면으로 진입하지 못했습니다.",
      steps,
      [
        "하단 리브후기 탭 선택 후 하단 탭 텍스트만이 아니라 실제 피드 본문 또는 상단 프로필 버튼이 보여야 합니다.",
        "리포트의 review-feed-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const profileButton = findTopRightProfileButton(xml) || fixedTopRightProfileButton();
  if (!profileButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-profile-button-not-found", xml);
    fail(
      "리브후기 화면 오른쪽 상단 프로필 버튼을 찾지 못했습니다.",
      steps,
      [
        "리브후기 화면 최상단 오른쪽에 프로필 버튼이 보여야 합니다.",
        "리포트의 review-profile-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, profileButton.bounds.x, profileButton.bounds.y);
  addStep(
    steps,
    "리브후기 프로필 버튼 선택",
    "pass",
    findTopRightProfileButton(xml) ? "XML 버튼 영역" : "우측 상단 fallback 좌표"
  );
  xml = await waitForUi(config, device, isReviewProfile, 7000);
  saveXml(store, "review-profile-start", xml);
  if (!isReviewProfile(xml)) {
    await saveFailureArtifacts(config, device, store, "review-profile-not-found", xml);
    fail(
      "리브후기 프로필 상세 화면으로 진입하지 못했습니다.",
      steps,
      [
        "프로필 상세 화면에는 '내 리브 후기' 타이틀이 보여야 합니다.",
        "리포트의 review-profile-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const nickname = extractNickname(xml);
  if (!nickname) {
    await saveFailureArtifacts(config, device, store, "review-profile-nickname-not-found", xml);
    fail(
      "리브후기 프로필 상세 화면에서 닉네임을 확인하지 못했습니다.",
      steps,
      [
        "프로필 상세 화면의 왼쪽 영역에 닉네임이 보여야 합니다.",
        "리포트의 review-profile-nickname-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "프로필 상세 타이틀 및 닉네임 확인", "pass", `닉네임: ${nickname}`);
  return { xml, nickname };
}

async function scrollProfileToEnd(config, device, store, steps, initialXml) {
  let xml = initialXml;
  const signatures = new Set();
  let maxVisibleLabels = visibleLabelCount(xml);
  let layoutSignalScreens = 0;
  let checkedScreens = 0;
  let stableCount = 0;

  for (let count = 0; count < 12; count += 1) {
    if (hasAppError(xml)) {
      await saveFailureArtifacts(config, device, store, "review-profile-app-error", xml);
      fail(
        "리브후기 프로필 스크롤 중 앱 오류 문구가 노출되었습니다.",
        steps,
        [
          "프로필 상세 스크롤 중 일시적인 오류/네트워크 오류 문구가 없어야 합니다.",
          "리포트의 review-profile-app-error.png 화면을 확인해주세요."
        ]
      );
    }

    const labels = xmlTextLines(xml).slice(0, 24).join("|");
    const signature = labels.replace(/\d{1,2}:\d{2}/g, "");
    signatures.add(signature);
    maxVisibleLabels = Math.max(maxVisibleLabels, visibleLabelCount(xml));
    checkedScreens += 1;
    if (hasProfilePostLayoutSignals(xml)) layoutSignalScreens += 1;

    await runAdb(config, device, ["shell", "input", "swipe", "540", "2140", "540", "560", "260"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
    saveXml(store, `review-profile-scroll-${count + 1}`, xml);

    const nextSignature = xmlTextLines(xml)
      .slice(0, 24)
      .join("|")
      .replace(/\d{1,2}:\d{2}/g, "");
    if (nextSignature === signature) stableCount += 1;
    else stableCount = 0;

    if (stableCount >= 1) {
      addStep(steps, "프로필 상세 스크롤 끝 도달", "pass", `${count + 1}회 스크롤 후 화면 변화 없음`);
      break;
    }
  }

  saveXml(store, "review-profile-end", xml);
  if (maxVisibleLabels < 5) {
    await saveFailureArtifacts(config, device, store, "review-profile-blank-after-scroll", xml);
    fail(
      "리브후기 프로필 스크롤 중 화면 콘텐츠가 비정상적으로 적게 노출되었습니다.",
      steps,
      [
        "게시물이 많은 프로필에서도 스크롤 중 빈 화면처럼 보이면 안 됩니다.",
        "리포트의 review-profile-blank-after-scroll.png 화면을 확인해주세요."
      ]
    );
  }

  if (layoutSignalScreens === 0) {
    await saveFailureArtifacts(config, device, store, "review-profile-layout-signal-not-found", xml);
    fail(
      "리브후기 프로필 스크롤 중 게시물 레이아웃 신호를 확인하지 못했습니다.",
      steps,
      [
        "게시물이 많은 계정 프로필에서는 스크롤 중 게시물 이미지/작성자/게시물 관련 텍스트가 유지되어야 합니다.",
        "리포트의 review-profile-layout-signal-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(
    steps,
    "프로필 상세 끝까지 스크롤",
    "pass",
    `스크롤 화면 변화 ${signatures.size}개, 최대 표시 텍스트 ${maxVisibleLabels}개`
  );
  addStep(
    steps,
    "게시물 많은 계정 스크롤 레이아웃 검증",
    "pass",
    `${checkedScreens}개 화면 중 ${layoutSignalScreens}개 화면에서 게시물/이미지/텍스트 신호 유지`
  );
  addStep(
    steps,
    "구분선 동일 여부 제한 검증",
    "pass",
    "스크롤 중 빈 화면/앱 오류/콘텐츠 소실 없음. 픽셀 단위 구분선 동일 여부는 기준 이미지가 없어 수동 확인 필요"
  );

  return {
    xml,
    scroll_snapshots: signatures.size,
    max_visible_labels: maxVisibleLabels,
    checked_screens: checkedScreens,
    layout_signal_screens: layoutSignalScreens
  };
}

async function runReviewProfileTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("리브후기 프로필 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    const { xml, nickname } = await openReviewProfile(config, device, store, steps);
    const scrollResult = await scrollProfileToEnd(config, device, store, steps, xml);

    return {
      test_id: "TC-INTERNAL-REFACTOR-001",
      name: "guest 리브후기 프로필",
      env,
      status: "pass",
      device,
      steps,
      review_profile: {
        title: "내 리브 후기",
        nickname,
        layout_validation: "XML 기반 제한 검증",
        scroll_snapshots: scrollResult.scroll_snapshots,
        max_visible_labels: scrollResult.max_visible_labels,
        checked_screens: scrollResult.checked_screens,
        layout_signal_screens: scrollResult.layout_signal_screens,
        manual_check_required: [
          "구분선 픽셀 동일 여부",
          "게시물 이미지 로딩의 미세한 레이아웃 흔들림"
        ]
      }
    };
  });
}

module.exports = {
  runReviewProfileTest
};
