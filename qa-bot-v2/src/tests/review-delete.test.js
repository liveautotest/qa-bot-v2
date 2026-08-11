const { withDeviceLock } = require("../infra/device-lock");
const { tap } = require("../infra/adb");
const {
  findExactNode,
  findNode,
  isVisibleNode,
  nodeLabel,
  parseNodes,
  saveFailureArtifacts,
  saveXml,
  waitForUi
} = require("./helpers/ui-automation");
const reviewCommon = require("./helpers/review-common");

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

function labelOf(node) {
  return nodeLabel(node).replace(/\s+/g, " ").trim();
}

function hasDeleteConfirmDialog(xml) {
  return (
    (
      xml.includes("정말 리뷰를 삭제하시겠어요") ||
      xml.includes("리뷰를 삭제하시겠어요") ||
      xml.includes("삭제하시겠어요")
    ) &&
    (
      xml.includes("삭제하기") ||
      xml.includes("삭제")
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

function findVisibleButton(xml, labels) {
  const exact = findExactNode(xml, labels, {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (exact) return exact;
  return findNode(xml, labels, {
    visible: true,
    clickable: true,
    enabled: true
  });
}

function findTopRightMoreButton(xml) {
  const labeled = findVisibleButton(xml, ["더보기", "옵션", "⋯", "...", "…"]);
  if (labeled?.bounds && labeled.bounds.top <= 420 && labeled.bounds.left >= 780) return labeled;

  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.enabled !== "false" &&
      (
        node.attrs.clickable === "true" ||
        labelOf(node).includes("더보기") ||
        labelOf(node).includes("...")
      ) &&
      node.bounds.top >= 80 &&
      node.bounds.top <= 420 &&
      node.bounds.left >= 780
    ))
    .sort((a, b) => b.bounds.right - a.bounds.right)[0] || null;
}

async function deleteReview(config, device, store, steps, xml) {
  let currentXml = xml;
  const moreButton = findTopRightMoreButton(currentXml);
  if (!moreButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-delete-more-not-found", currentXml);
    fail(
      "내 리뷰 상세 화면에서 오른쪽 더보기 버튼을 찾지 못했습니다.",
      steps,
      ["오른쪽 상단 *** 버튼이 보여야 합니다."]
    );
  }

  await tap(config, device, moreButton.bounds.x, moreButton.bounds.y);
  addStep(steps, "내 리뷰 상세 오른쪽 더보기 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => (
    candidate.includes("수정") && candidate.includes("삭제")
  ), 5000);
  saveXml(store, "review-delete-more-menu", currentXml);

  const deleteButton = findVisibleButton(currentXml, ["삭제"]);
  if (!deleteButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-delete-menu-delete-not-found", currentXml);
    fail(
      "수정/삭제 모달에서 삭제 버튼을 찾지 못했습니다.",
      steps,
      ["더보기 선택 후 수정, 삭제 버튼이 노출되어야 합니다."]
    );
  }

  await tap(config, device, deleteButton.bounds.x, deleteButton.bounds.y);
  addStep(steps, "삭제 버튼 선택");
  currentXml = await waitForUi(config, device, hasDeleteConfirmDialog, 8000);
  saveXml(store, "review-delete-confirm-dialog", currentXml);
  if (!hasDeleteConfirmDialog(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-delete-confirm-dialog-not-found", currentXml);
    fail(
      "정말 리뷰를 삭제하시겠어요? 확인 팝업을 확인하지 못했습니다.",
      steps,
      ["삭제 버튼 선택 후 삭제 확인 팝업과 삭제하기 버튼이 보여야 합니다."]
    );
  }

  const confirmDeleteButton = findVisibleButton(currentXml, ["삭제하기", "삭제"]);
  if (!confirmDeleteButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-delete-confirm-button-not-found", currentXml);
    fail(
      "삭제 확인 팝업에서 삭제하기 버튼을 찾지 못했습니다.",
      steps,
      ["정말 리뷰를 삭제하시겠어요? 팝업에는 삭제하기 버튼이 보여야 합니다."]
    );
  }

  await tap(config, device, confirmDeleteButton.bounds.x, confirmDeleteButton.bounds.y);
  addStep(steps, "삭제 확인 팝업 삭제하기 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => !hasDeleteConfirmDialog(candidate), 10000);
  saveXml(store, "review-delete-after-submit", currentXml);

  if (hasDeleteConfirmDialog(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-delete-confirm-not-dismissed", currentXml);
    fail(
      "삭제하기 버튼을 눌렀지만 삭제 확인 팝업이 닫히지 않았습니다.",
      steps,
      ["삭제 확인 팝업이 사라져야 PASS 처리합니다."]
    );
  }
  if (hasAppError(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-delete-app-error", currentXml);
    fail("리뷰 삭제 후 앱 오류 문구가 노출되었습니다.", steps);
  }

  addStep(steps, "리뷰 삭제 완료 상태 확인", "pass", "삭제 확인 팝업 닫힘 및 앱 오류 미노출");
}

async function runReviewDeleteTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("리뷰 삭제 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await reviewCommon.wakeAndUnlock(config, device, steps, store);
    await reviewCommon.launchFresh(config, device, appPackage, steps);

    const contractListXml = await reviewCommon.openContractTab(config, device, store, steps, {
      prefix: "review-delete",
      purpose: "리뷰 삭제"
    });
    const reviewDetailXml = await reviewCommon.openMyReview(config, device, store, steps, contractListXml, {
      prefix: "review-delete",
      purpose: "리뷰 삭제"
    });
    await deleteReview(config, device, store, steps, reviewDetailXml);

    return {
      test_id: "TC-INTERNAL-REFACTOR-007",
      name: "guest 리뷰 삭제",
      env,
      status: "pass",
      device,
      steps,
      review_delete: {
        opened_review_detail: true,
        confirm_dialog_checked: true,
        deleted: true,
        manual_check_required: [
          "삭제 후 계약 목록의 버튼 상태가 내 리뷰 보기에서 리뷰 작성하기로 바뀌었는지 수동 확인"
        ]
      }
    };
  });
}

module.exports = {
  runReviewDeleteTest
};
