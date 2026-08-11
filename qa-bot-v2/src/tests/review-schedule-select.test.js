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

function hasScheduleSelectModal(xml) {
  return (
    xml.includes("작성할 일정을 선택해 주세요") ||
    xml.includes("다른 일정으로 작성하고 싶어요") ||
    (
      xml.includes("일정을 선택") &&
      (xml.includes("예약") || xml.includes("일정"))
    )
  );
}

function hasReviewWriteScreen(xml) {
  if (hasScheduleSelectModal(xml)) return false;
  return [
    "리브후기 작성",
    "후기 작성",
    "리뷰 작성",
    "사진",
    "내용",
    "작성하기",
    "등록"
  ].some((text) => xml.includes(text));
}

function hasReviewWriteScreenWithoutScheduleSelector(xml) {
  return (
    hasReviewWriteScreen(xml) &&
    !xml.includes("일정 선택하기") &&
    !xml.includes("작성할 일정을 선택해 주세요") &&
    xml.includes("제목을 작성해 주세요") &&
    xml.includes("나만의 한달살기 이야기")
  );
}

function findBottomTab(xml, label) {
  return parseNodes(xml).find((node) => {
    if (!node.bounds || node.bounds.top < 2200) return false;
    return nodeLabel(node).includes(label);
  });
}

function findPenFab(xml) {
  const labelButton = findNode(xml, ["작성", "글쓰기", "만년필", "연필", "write", "Write"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (
    labelButton?.bounds &&
    labelButton.bounds.left >= 740 &&
    labelButton.bounds.top >= 1700 &&
    labelButton.bounds.bottom <= 2300
  ) {
    return labelButton;
  }

  const candidates = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled !== "true") return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.left >= 760 &&
        node.bounds.right >= 900 &&
        node.bounds.top >= 1700 &&
        node.bounds.bottom <= 2290 &&
        width >= 44 &&
        width <= 240 &&
        height >= 44 &&
        height <= 240
      );
    })
    .sort((leftNode, rightNode) => {
      const bottomDiff = rightNode.bounds.bottom - leftNode.bounds.bottom;
      if (bottomDiff) return bottomDiff;
      return rightNode.bounds.right - leftNode.bounds.right;
    });

  return candidates[0] || {
    bounds: {
      x: 966,
      y: 2136,
      left: 910,
      top: 2080,
      right: 1022,
      bottom: 2192
    },
    fallback: true
  };
}

function labelLooksLikeSchedule(label) {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (normalized.includes("다른 일정으로 작성하고 싶어요")) return true;
  if (["확인", "취소", "닫기", "다음", "선택"].includes(normalized)) return false;
  if (/20\d{2}[.\-/년]\s*\d{1,2}/.test(normalized)) return true;
  if (/\d{1,2}\s*월\s*\d{1,2}\s*일/.test(normalized)) return true;
  return (
    normalized.includes("예약") ||
    normalized.includes("일정") ||
    normalized.includes("숙소") ||
    normalized.includes("입주") ||
    normalized.includes("퇴실")
  ) && normalized.length >= 5;
}

function findScheduleOption(xml) {
  const otherScheduleOption = findNode(xml, "다른 일정으로 작성하고 싶어요", {
    visible: true,
    enabled: true
  });
  if (otherScheduleOption?.bounds) return otherScheduleOption;

  const nodes = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.enabled === "false") return false;
      if (node.bounds.top < 520 || node.bounds.bottom > 2240) return false;
      return labelLooksLikeSchedule(nodeLabel(node));
    })
    .sort((leftNode, rightNode) => {
      const leftClickable = leftNode.attrs.clickable === "true" ? 0 : 1;
      const rightClickable = rightNode.attrs.clickable === "true" ? 0 : 1;
      if (leftClickable !== rightClickable) return leftClickable - rightClickable;
      return leftNode.bounds.top - rightNode.bounds.top;
    });

  return nodes[0] || null;
}

function visibleScheduleOptionCount(xml) {
  return parseNodes(xml).filter((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    node.bounds.top >= 520 &&
    node.bounds.bottom <= 2240 &&
    labelLooksLikeSchedule(nodeLabel(node))
  )).length;
}

function screenSignature(xml) {
  return xmlTextLines(xml)
    .slice(0, 36)
    .join("|")
    .replace(/\d{1,2}:\d{2}/g, "");
}

async function openReviewFeed(config, device, store, steps) {
  let xml = await waitForUi(config, device, hasGuestHomeShell, 8000);
  saveXml(store, "review-schedule-home", xml);
  if (!hasGuestHomeShell(xml)) {
    await saveFailureArtifacts(config, device, store, "review-schedule-home-not-found", xml);
    fail(
      "앱 실행 후 게스트 홈 하단 탭을 확인하지 못했습니다.",
      steps,
      [
        "리브후기 일정 선택 테스트는 로그인된 게스트 앱 홈에서 시작해야 합니다.",
        "리포트의 review-schedule-home-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const reviewTab = findBottomTab(xml, "리브후기");
  if (!reviewTab?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-schedule-tab-not-found", xml);
    fail(
      "하단 리브후기 탭을 찾지 못했습니다.",
      steps,
      [
        "하단 탭에 '리브후기'가 보여야 합니다.",
        "리포트의 review-schedule-tab-not-found.png 화면을 확인해주세요."
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

  saveXml(store, "review-schedule-feed", xml);
  if (!hasReviewFeed(xml)) {
    await saveFailureArtifacts(config, device, store, "review-schedule-feed-not-found", xml);
    fail(
      isReviewFeedBlank(xml)
        ? "리브후기 화면 본문이 회색 빈 화면에서 로딩되지 않았습니다."
        : "리브후기 화면으로 진입하지 못했습니다.",
      steps,
      [
        "하단 리브후기 탭 선택 후 실제 피드 본문과 우측 하단 만년필 버튼이 보여야 합니다.",
        "리포트의 review-schedule-feed-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return xml;
}

async function openScheduleModal(config, device, store, steps, feedXml) {
  const penFab = findPenFab(feedXml);
  if (!penFab?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-schedule-pen-not-found", feedXml);
    fail(
      "리브후기 화면 오른쪽 하단 만년필 버튼을 찾지 못했습니다.",
      steps,
      [
        "게시물 카드를 누르지 않도록 오른쪽 하단 FAB 영역만 선택합니다.",
        "리포트의 review-schedule-pen-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, penFab.bounds.x, penFab.bounds.y);
  addStep(
    steps,
    "오른쪽 하단 만년필 아이콘 선택",
    "pass",
    penFab.fallback ? "우측 하단 FAB fallback 좌표" : "우측 하단 FAB XML 영역"
  );

  let xml = await waitForUi(config, device, hasScheduleSelectModal, 7000);
  saveXml(store, "review-schedule-after-pen", xml);

  if (hasReviewWriteScreen(xml) && !hasScheduleSelectModal(xml)) {
    const scheduleSelectButton = findNode(xml, ["일정 선택하기", "일정 선택"], {
      visible: true,
      clickable: true,
      enabled: true
    });
    if (!scheduleSelectButton?.bounds) {
      const artifactName = hasReviewWriteScreenWithoutScheduleSelector(xml)
        ? "review-schedule-direct-write-screen"
        : "review-schedule-select-button-not-found";
      await saveFailureArtifacts(config, device, store, artifactName, xml);
      fail(
        hasReviewWriteScreenWithoutScheduleSelector(xml)
          ? "만년필 아이콘 선택 후 일정 선택 모달 없이 리브 후기 작성 화면으로 바로 이동했습니다."
          : "리브 후기 작성 화면에서 일정 선택하기 버튼을 찾지 못했습니다.",
        steps,
        [
          "만년필 아이콘 선택 후에는 먼저 '작성할 일정을 선택해 주세요' 모달이 보여야 합니다.",
          "자동화가 추가 탭으로 모달을 닫지 않도록 예상 영역 탭은 수행하지 않습니다.",
          `리포트의 ${artifactName}.png 화면을 확인해주세요.`
        ]
      );
    } else {
      await tap(config, device, scheduleSelectButton.bounds.x, scheduleSelectButton.bounds.y);
      addStep(steps, "리브 후기 작성 화면 일정 선택하기 버튼 선택");
      xml = await waitForUi(config, device, hasScheduleSelectModal, 9000);
    }
  }

  saveXml(store, "review-schedule-modal", xml);
  if (!hasScheduleSelectModal(xml)) {
    await saveFailureArtifacts(config, device, store, "review-schedule-modal-not-found", xml);
    fail(
      "리브후기 작성 일정 선택 모달을 확인하지 못했습니다.",
      steps,
      [
        "만년필 아이콘 선택 후 작성 화면 또는 '작성할 일정을 선택해 주세요' 모달이 떠야 합니다.",
        "리포트의 review-schedule-modal-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "작성할 일정 선택 모달 확인");
  return xml;
}

async function scrollScheduleListAndSelect(config, device, store, steps, initialXml) {
  let xml = initialXml;
  const beforeSignature = screenSignature(xml);
  const beforeCount = visibleScheduleOptionCount(xml);

  await runAdb(config, device, ["shell", "input", "swipe", "540", "1900", "540", "980", "220"]);
  await new Promise((resolve) => setTimeout(resolve, 220));
  xml = await dumpUiStable(config, device);
  saveXml(store, "review-schedule-after-scroll", xml);

  const afterSignature = screenSignature(xml);
  const afterCount = visibleScheduleOptionCount(xml);
  addStep(
    steps,
    "예약/일정 목록 스크롤",
    "pass",
    beforeSignature === afterSignature
      ? `목록 변화 없음 또는 한 화면 목록 (후보 ${Math.max(beforeCount, afterCount)}개)`
      : `목록 스크롤 화면 변화 확인 (후보 ${afterCount}개)`
  );

  let option = findScheduleOption(xml) || findScheduleOption(initialXml);
  if (!option?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-schedule-option-not-found", xml);
    fail(
      "작성할 예약/일정 항목을 찾지 못했습니다.",
      steps,
      [
        "모달 안 예약/일정 목록에서 실제 선택 가능한 일정 항목이 보여야 합니다.",
        "리포트의 review-schedule-option-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const selectedLabel = nodeLabel(option).replace(/\s+/g, " ").trim();
  await tap(config, device, option.bounds.x, option.bounds.y);
  addStep(steps, "예약/일정 항목 선택", "pass", selectedLabel || "일정 항목 선택");

  xml = await waitForUi(config, device, (nextXml) => (
    hasReviewWriteScreen(nextXml) ||
    !hasScheduleSelectModal(nextXml)
  ), 8000);
  saveXml(store, "review-schedule-after-select", xml);
  if (hasScheduleSelectModal(xml)) {
    await saveFailureArtifacts(config, device, store, "review-schedule-selection-not-applied", xml);
    fail(
      "예약/일정 항목을 눌렀지만 일정 선택 모달이 유지되었습니다.",
      steps,
      [
        "일정 선택 후 리브후기 작성 화면으로 이동하거나 모달이 닫혀야 합니다.",
        "리포트의 review-schedule-selection-not-applied.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(
    steps,
    "일정 선택 후 작성 화면 진입 확인",
    "pass",
    hasReviewWriteScreen(xml) ? "작성 화면 신호 확인" : "일정 선택 모달 닫힘 확인"
  );

  return {
    selected_schedule: selectedLabel,
    list_scroll_changed: beforeSignature !== afterSignature,
    visible_schedule_count: Math.max(beforeCount, afterCount)
  };
}

async function runReviewScheduleSelectTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("리브후기 일정 선택 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    const feedXml = await openReviewFeed(config, device, store, steps);
    const modalXml = await openScheduleModal(config, device, store, steps, feedXml);
    const selection = await scrollScheduleListAndSelect(config, device, store, steps, modalXml);

    return {
      test_id: "TC-INTERNAL-REFACTOR-002",
      name: "guest 리브후기 일정 선택",
      env,
      status: "pass",
      device,
      steps,
      review_schedule_select: {
        modal_title: "작성할 일정을 선택해 주세요",
        selected_schedule: selection.selected_schedule,
        list_scroll_changed: selection.list_scroll_changed,
        visible_schedule_count: selection.visible_schedule_count
      }
    };
  });
}

module.exports = {
  runReviewScheduleSelectTest
};
