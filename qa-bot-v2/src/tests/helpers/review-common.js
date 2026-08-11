const { keyEvent, runAdb, tap } = require("../../infra/adb");
const {
  dumpUiStable,
  findExactNode,
  findNode,
  isVisibleNode,
  nodeLabel,
  parseNodes,
  saveFailureArtifacts,
  saveXml,
  waitForUi,
  xmlTextLines
} = require("./ui-automation");

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

function screenSignature(xml) {
  return xmlTextLines(xml)
    .slice(0, 48)
    .join("|")
    .replace(/\d{1,2}:\d{2}/g, "");
}

function hasGuestHomeShell(xml) {
  return (
    xml.includes("홈") &&
    xml.includes("찜") &&
    xml.includes("리브후기") &&
    xml.includes("계약") &&
    xml.includes("내 정보")
  );
}

function hasContractListScreen(xml) {
  return (
    xml.includes("계약") &&
    (
      xml.includes("진행 중인 계약") ||
      xml.includes("진행중인 계약") ||
      xml.includes("지난 계약") ||
      xml.includes("내 리뷰 보기") ||
      xml.includes("리뷰 작성하기") ||
      xml.includes("리뷰 작성") ||
      xml.includes("계약 중")
    )
  );
}

function hasReviewDetailScreen(xml) {
  return (
    xml.includes("내 리뷰") ||
    xml.includes("리뷰 상세") ||
    xml.includes("수정") ||
    xml.includes("삭제") ||
    xml.includes("머무는 동안")
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

function findBottomTab(xml, label) {
  const exact = parseNodes(xml).find((node) => (
    node.bounds &&
    node.bounds.top >= 2320 &&
    node.bounds.bottom <= 2495 &&
    isVisibleNode(node) &&
    labelOf(node) === label
  ));
  if (exact) return exact;

  return parseNodes(xml).find((node) => (
    node.bounds &&
    node.bounds.top >= 2320 &&
    node.bounds.bottom <= 2495 &&
    isVisibleNode(node) &&
    nodeLabel(node).includes(label)
  ));
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

function findReviewViewButtons(xml) {
  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.enabled !== "false" &&
      nodeLabel(node).includes("내 리뷰 보기") &&
      node.bounds.top >= 260 &&
      node.bounds.bottom <= 2260
    ))
    .sort((a, b) => a.bounds.top - b.bounds.top);
}

function findReviewWriteButtons(xml) {
  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.enabled !== "false" &&
      (nodeLabel(node).includes("리뷰 작성하기") || nodeLabel(node).includes("리뷰 작성")) &&
      node.bounds.top >= 260 &&
      node.bounds.bottom <= 2260
    ))
    .sort((a, b) => a.bounds.top - b.bounds.top);
}

function findTopRightMoreButton(xml) {
  const labeled = findVisibleButton(xml, ["더보기", "옵션", "...", "…"]);
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

function pickRandom(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function imageCandidateScore(node) {
  if (!node.bounds || !isVisibleNode(node)) return 0;
  if (node.bounds.top < 260 || node.bounds.bottom > 2140) return 0;
  const width = node.bounds.right - node.bounds.left;
  const height = node.bounds.bottom - node.bounds.top;
  if (width < 90 || height < 90) return 0;
  const className = String(node.attrs.class || "");
  const label = labelOf(node);
  let score = 0;
  if (className.includes("Image")) score += 3;
  if (node.attrs.clickable === "true") score += 2;
  if (label.includes("사진") || label.includes("이미지") || label.includes("선택")) score += 1;
  if (width >= 120 && width <= 420 && height >= 120 && height <= 420) score += 1;
  return score;
}

// Android photo picker exposes different XML shapes by OS/app state, so keep
// the candidate search layered from strict picker cells to generic image nodes.
function findPhotoCandidates(xml) {
  const photoPickerGridCandidates = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
      const label = labelOf(node);
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        label.includes("촬영") &&
        label.includes("사진") &&
        !label.includes("선택됨") &&
        node.bounds.top >= 650 &&
        node.bounds.bottom <= 2140 &&
        width >= 220 &&
        height >= 220
      );
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
  if (photoPickerGridCandidates.length) return photoPickerGridCandidates;

  const genericPhotoGridCells = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= 700 &&
        node.bounds.bottom <= 2140 &&
        width >= 300 &&
        width <= 390 &&
        height >= 300 &&
        height <= 390
      );
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
  if (genericPhotoGridCells.length) return genericPhotoGridCells;

  return parseNodes(xml)
    .map((node) => ({ node, score: imageCandidateScore(node) }))
    .filter(({ node, score }) => score > 0 && !labelOf(node).includes("선택됨"))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.node.bounds.top - b.node.bounds.top || a.node.bounds.left - b.node.bounds.left;
    })
    .map(({ node }) => node)
    .filter((node, index, nodes) => (
      nodes.findIndex((other) => Math.abs(other.bounds.x - node.bounds.x) < 12 && Math.abs(other.bounds.y - node.bounds.y) < 12) === index
    ));
}

function findPhotoDoneButton(xml) {
  const labeledButton = findVisibleButton(xml, ["완료", "선택 완료", "Done"]);
  if (labeledButton?.bounds) return labeledButton;

  const completeText = parseNodes(xml).find((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    labelOf(node) === "완료" &&
    node.bounds.top >= 2200 &&
    node.bounds.left >= 700
  ));
  if (completeText?.bounds) {
    const parent = parseNodes(xml)
      .filter((node) => (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.clickable === "true" &&
        node.attrs.enabled !== "false" &&
        node.bounds.left <= completeText.bounds.left &&
        node.bounds.right >= completeText.bounds.right &&
        node.bounds.top <= completeText.bounds.top &&
        node.bounds.bottom >= completeText.bounds.bottom
      ))
      .sort((a, b) => {
        const areaA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
        const areaB = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
        return areaA - areaB;
      })[0];
    return parent || completeText;
  }

  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.clickable === "true" &&
      node.attrs.enabled !== "false" &&
      node.bounds.top >= 2280 &&
      node.bounds.left >= 720 &&
      node.bounds.right <= 1040
    ))
    .sort((a, b) => b.bounds.right - a.bounds.right)[0] || null;
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

// Review scenarios all begin from the guest contract list, but the bottom tab
// may expose icon and text as separate hit areas depending on screen density.
async function openContractTab(config, device, store, steps, options = {}) {
  const prefix = options.prefix || "review";
  const purpose = options.purpose || "리뷰 테스트";
  let xml = await waitForUi(config, device, hasGuestHomeShell, options.homeTimeoutMs || 9000);
  saveXml(store, `${prefix}-home`, xml);
  if (!hasGuestHomeShell(xml)) {
    await saveFailureArtifacts(config, device, store, `${prefix}-home-not-found`, xml);
    fail(
      "앱 실행 후 게스트 홈 화면을 확인하지 못했습니다.",
      steps,
      [`${purpose}는 로그인된 게스트 앱에서 시작해야 합니다.`]
    );
  }

  const contractTab = findBottomTab(xml, "계약");
  if (!contractTab?.bounds && !xml.includes("계약")) {
    await saveFailureArtifacts(config, device, store, `${prefix}-contract-tab-not-found`, xml);
    fail("하단 계약 탭을 찾지 못했습니다.", steps);
  }

  const tabX = contractTab?.bounds?.x || 755;
  const iconY = contractTab?.bounds ? Math.max(2340, contractTab.bounds.top - 48) : 2380;
  await tap(config, device, tabX, iconY);
  addStep(steps, "하단 계약 탭 선택", "pass", `좌표 ${tabX},${iconY}`);
  xml = await waitForUi(config, device, hasContractListScreen, 9000);
  if (!hasContractListScreen(xml) && hasGuestHomeShell(xml)) {
    const labelY = contractTab?.bounds?.y || 2445;
    await tap(config, device, tabX, labelY);
    addStep(steps, "하단 계약 탭 재선택", "pass", `좌표 ${tabX},${labelY}`);
    xml = await waitForUi(config, device, hasContractListScreen, 6000);
  }
  saveXml(store, `${prefix}-contract-list`, xml);
  if (!hasContractListScreen(xml)) {
    await saveFailureArtifacts(config, device, store, `${prefix}-contract-list-not-found`, xml);
    fail(
      "계약 목록 화면을 확인하지 못했습니다.",
      steps,
      ["하단 계약 탭 선택 후 진행 중인 계약 목록이 보여야 합니다."]
    );
  }

  const ongoingTab = findVisibleButton(xml, ["진행 중인 계약", "진행중인 계약"]);
  if (ongoingTab?.bounds) {
    await tap(config, device, ongoingTab.bounds.x, ongoingTab.bounds.y);
    addStep(steps, "진행 중인 계약 탭 선택");
    xml = await waitForUi(config, device, hasContractListScreen, 4000);
  }

  return xml;
}

// "내 리뷰 보기" can appear far down the 진행 중인 계약 list, so this helper
// scrolls until the screen stops changing instead of relying on a fixed count.
async function openMyReview(config, device, store, steps, initialXml, options = {}) {
  const prefix = options.prefix || "review";
  const purpose = options.purpose || "리뷰 테스트";
  let xml = initialXml;
  const signatures = new Set();

  for (let count = 0; count < (options.maxScrolls || 12); count += 1) {
    if (hasAppError(xml)) {
      await saveFailureArtifacts(config, device, store, `${prefix}-contract-list-app-error`, xml);
      fail("계약 목록에서 앱 오류 문구가 노출되었습니다.", steps);
    }

    const buttons = findReviewViewButtons(xml);
    if (buttons.length) {
      const target = options.pick === "random" ? pickRandom(buttons) : buttons[0];
      await tap(config, device, target.bounds.x, target.bounds.y);
      addStep(steps, "내 리뷰 보기 버튼 선택");
      const nextXml = await waitForUi(config, device, hasReviewDetailScreen, 10000);
      saveXml(store, `${prefix}-detail`, nextXml);
      if (!hasReviewDetailScreen(nextXml)) {
        await saveFailureArtifacts(config, device, store, `${prefix}-detail-not-found`, nextXml);
        fail(
          "내 리뷰 보기 버튼을 눌렀지만 리뷰 상세 화면으로 이동하지 못했습니다.",
          steps,
          ["내 리뷰 상세 화면이 보여야 다음 단계로 진행합니다."]
        );
      }
      return nextXml;
    }

    const signature = screenSignature(xml);
    if (signatures.has(signature) && count > 0) break;
    signatures.add(signature);

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1980", "540", "760", "190"]);
    await new Promise((resolve) => setTimeout(resolve, 170));
    xml = await dumpUiStable(config, device);
    saveXml(store, `${prefix}-contract-scroll-${count + 1}`, xml);
    addStep(steps, "진행 중인 계약 목록 스크롤", "pass", `${count + 1}회`);
  }

  await saveFailureArtifacts(config, device, store, `${prefix}-view-button-not-found`, xml);
  fail(
    "진행 중인 계약 목록에서 내 리뷰 보기 버튼을 찾지 못했습니다.",
    steps,
    [
      `${purpose}는 리뷰 작성 완료 후 노출되는 '내 리뷰 보기' 버튼이 있는 계약 건만 가능합니다.`,
      `리포트의 ${prefix}-view-button-not-found.png 화면을 확인해주세요.`
    ]
  );
}

// Review writing is only available for contracts with an explicit write button;
// other contract cards are ignored to avoid false PASS on the wrong detail.
async function openReviewWriteFromContract(config, device, store, steps, initialXml, options = {}) {
  const prefix = options.prefix || "review-write";
  let xml = initialXml;
  const signatures = new Set();

  for (let count = 0; count < (options.maxScrolls || 10); count += 1) {
    if (hasAppError(xml)) {
      await saveFailureArtifacts(config, device, store, `${prefix}-contract-list-app-error`, xml);
      fail("계약 목록에서 앱 오류 문구가 노출되었습니다.", steps);
    }

    const buttons = findReviewWriteButtons(xml);
    if (buttons.length) {
      const target = pickRandom(buttons);
      const selected = labelOf(target) || "리뷰 작성하기";
      await tap(config, device, target.bounds.x, target.bounds.y);
      addStep(steps, "리뷰 작성하기 버튼 선택", "pass", selected);
      const nextXml = await waitForUi(config, device, options.hasReviewRatingScreen, 10000);
      saveXml(store, `${prefix}-rating`, nextXml);
      if (!options.hasReviewRatingScreen(nextXml)) {
        await saveFailureArtifacts(config, device, store, `${prefix}-rating-not-found`, nextXml);
        fail(
          "리뷰 작성하기 버튼을 눌렀지만 별점 화면으로 이동하지 못했습니다.",
          steps,
          [
            "첫 화면에는 '머무는 동안 어땠나요?' 별점 선택 화면이 보여야 합니다.",
            `리포트의 ${prefix}-rating-not-found.png 화면을 확인해주세요.`
          ]
        );
      }
      return nextXml;
    }

    const signature = screenSignature(xml);
    if (signatures.has(signature) && count > 0) break;
    signatures.add(signature);

    await runAdb(config, device, ["shell", "input", "swipe", "540", "1980", "540", "760", "190"]);
    await new Promise((resolve) => setTimeout(resolve, 180));
    xml = await dumpUiStable(config, device);
    saveXml(store, `${prefix}-contract-scroll-${count + 1}`, xml);
    addStep(steps, "진행 중인 계약 목록 스크롤", "pass", `${count + 1}회`);
  }

  await saveFailureArtifacts(config, device, store, `${prefix}-button-not-found`, xml);
  fail(
    "진행 중인 계약 목록에서 리뷰 작성하기 버튼을 찾지 못했습니다.",
    steps,
    [
      "리뷰 작성은 '리뷰 작성하기' 버튼이 노출되는 계약 건만 가능합니다.",
      "계약 탭의 진행 중인 계약 목록에 리뷰 작성 가능 계약이 있는지 확인해주세요.",
      `리포트의 ${prefix}-button-not-found.png 화면을 확인해주세요.`
    ]
  );
}

async function maybeAllowPermission(config, device, store, steps, xml, artifactName = "review-photo-after-permission") {
  const allowButton = findVisibleButton(xml, [
    "허용",
    "앱 사용 중에만 허용",
    "모두 허용",
    "선택한 사진 허용",
    "Allow",
    "ALLOW"
  ]);
  if (!allowButton?.bounds) return xml;
  await tap(config, device, allowButton.bounds.x, allowButton.bounds.y);
  addStep(steps, "사진 접근 권한 팝업 허용");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const nextXml = await dumpUiStable(config, device);
  saveXml(store, artifactName, nextXml);
  return nextXml;
}

module.exports = {
  addStep,
  fail,
  findBottomTab,
  findPhotoCandidates,
  findPhotoDoneButton,
  findReviewViewButtons,
  findReviewWriteButtons,
  findTopRightMoreButton,
  findVisibleButton,
  hasAppError,
  hasContractListScreen,
  hasGuestHomeShell,
  hasReviewDetailScreen,
  imageCandidateScore,
  labelOf,
  launchFresh,
  maybeAllowPermission,
  openContractTab,
  openMyReview,
  openReviewWriteFromContract,
  pickRandom,
  screenSignature,
  wakeAndUnlock
};
