const { withDeviceLock } = require("../infra/device-lock");
const {
  inputText,
  keyEvent,
  runAdb,
  tap
} = require("../infra/adb");
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

function hasReviewEditScreen(xml) {
  return (
    (xml.includes("리뷰 수정") || xml.includes("리뷰") || xml.includes("저장")) &&
    (xml.includes("키워드") || xml.includes("상세 리뷰") || xml.includes("사진"))
  );
}

function hasKeywordScreen(xml) {
  return (
    xml.includes("키워드") &&
    (xml.includes("확인") || xml.includes("선택"))
  );
}

function hasPhotoPicker(xml) {
  return (
    xml.includes("com.google.android.photopicker") ||
    xml.includes("com.google.android.providers.media") ||
    xml.includes("완료") ||
    xml.includes("앨범") ||
    xml.includes("최근 항목") ||
    xml.includes("사진 선택")
  ) && findPhotoCandidates(xml).length > 0;
}

function hasReviewTextEditScreen(xml) {
  return (
    xml.includes("상세 리뷰") ||
    xml.includes("리뷰 내용") ||
    xml.includes("확인") ||
    xml.includes("1000")
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

function findRatingStars(xml) {
  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= 360 &&
        node.bounds.top <= 1500 &&
        width >= 70 &&
        width <= 200 &&
        height >= 70 &&
        height <= 200
      );
    })
    .sort((a, b) => a.bounds.left - b.bounds.left);
}

function extractRatingLabel(xml) {
  const candidates = [
    "또 오고 싶어요",
    "최고",
    "만족",
    "나쁘지 않았어요",
    "그저 그랬어요",
    "실망스러워요",
    "별로",
    "아쉬워요"
  ];
  return xmlTextLines(xml)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => candidates.some((candidate) => line.includes(candidate))) || "";
}

function isLikelyFiveStarRating(label) {
  return [
    "또 오고 싶어요",
    "최고",
    "매우 만족",
    "완벽"
  ].some((text) => String(label || "").includes(text));
}

function findChevronNearLabel(xml, labels) {
  const nodes = parseNodes(xml);
  const labelNode = nodes.find((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    labels.some((label) => labelOf(node).includes(label))
  ));
  if (!labelNode?.bounds) return null;

  if (
    labelNode.attrs.clickable === "true" &&
    labelNode.attrs.enabled !== "false" &&
    labelNode.bounds.right - labelNode.bounds.left >= 420
  ) {
    return labelNode;
  }

  return nodes
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.enabled !== "false" &&
      node.bounds.left >= 760 &&
      Math.abs(node.bounds.y - labelNode.bounds.y) < 220 &&
      (
        node.attrs.clickable === "true" ||
        labelOf(node).includes(">") ||
        labelOf(node).includes("›") ||
        labelOf(node).includes("더보기")
      )
    ))
    .sort((a, b) => Math.abs(a.bounds.y - labelNode.bounds.y) - Math.abs(b.bounds.y - labelNode.bounds.y))[0] || null;
}

function keywordCandidates(xml) {
  const blocked = ["확인", "다음", "뒤로", "닫기", "키워드", "선택", "최대", "좋았나요"];
  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.enabled === "false") return false;
      if (node.bounds.top < 420 || node.bounds.bottom > 2050) return false;
      const label = labelOf(node);
      if (!label || label.length < 2 || label.length > 28) return false;
      if (blocked.some((text) => label.includes(text))) return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return width >= 80 && width <= 650 && height >= 42 && height <= 240;
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
}

function extractKeywordLabels(xml) {
  const keywordRow = parseNodes(xml).find((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    labelOf(node).includes("키워드") &&
    node.attrs.clickable === "true"
  ));
  if (!keywordRow) return [];

  return labelOf(keywordRow)
    .split(/\s{2,}|\n/)
    .flatMap((line) => line.split(/(?<=상태)|(?<=인테리어)|(?<=대중교통)|(?<=환경)|(?<=가성비)|(?<=맛집)/))
    .map((line) => line.replace("키워드", "").trim())
    .filter(Boolean)
    .filter((line) => line.length >= 2 && line.length <= 28);
}

function sameStringSet(left, right) {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (leftSet.size !== rightSet.size) return false;
  return Array.from(leftSet).every((item) => rightSet.has(item));
}

function extractPhotoCount(xml) {
  const countLine = xmlTextLines(xml).find((line) => /^\d+\s*\/\s*10$/.test(line.trim()));
  const match = String(countLine || "").match(/^(\d+)\s*\//);
  return match ? Number(match[1]) : null;
}

function findPhotoDeleteButtons(xml) {
  const photoLabel = parseNodes(xml).find((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    labelOf(node) === "사진"
  ));
  if (!photoLabel?.bounds) return [];

  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= photoLabel.bounds.bottom &&
        node.bounds.top <= photoLabel.bounds.bottom + 520 &&
        node.bounds.right <= 850 &&
        width >= 44 &&
        width <= 120 &&
        height >= 44 &&
        height <= 120
      );
    })
    .sort((a, b) => a.bounds.left - b.bounds.left);
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
    .map(({ node }) => node);
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

function findPhotoAddButton(xml) {
  const byLabel = findVisibleButton(xml, ["사진 +", "+ 추가", "사진 추가", "추가"]);
  if (byLabel?.bounds && byLabel.bounds.top >= 300 && byLabel.bounds.top <= 1900) return byLabel;

  const photoLabel = parseNodes(xml).find((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    labelOf(node) === "사진"
  ));
  if (photoLabel?.bounds) {
    const rowCandidates = parseNodes(xml)
      .filter((node) => {
        if (!node.bounds || !isVisibleNode(node)) return false;
        if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
        const width = node.bounds.right - node.bounds.left;
        const height = node.bounds.bottom - node.bounds.top;
        return (
          node.bounds.top >= photoLabel.bounds.bottom &&
          node.bounds.top <= photoLabel.bounds.bottom + 520 &&
          width >= 60 &&
          width <= 280 &&
          height >= 60 &&
          height <= 280
        );
      })
      .sort((a, b) => b.bounds.right - a.bounds.right);
    if (rowCandidates[0]?.bounds) return rowCandidates[0];
  }

  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.enabled === "false") return false;
      const label = labelOf(node);
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= 320 &&
        node.bounds.top <= 1900 &&
        width >= 70 &&
        width <= 380 &&
        height >= 70 &&
        height <= 380 &&
        (label.includes("+") || label.includes("사진") || node.attrs.clickable === "true")
      );
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)[0] || null;
}

function findEditableTextField(xml) {
  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      const className = String(node.attrs.class || "");
      const label = labelOf(node);
      return (
        node.attrs.enabled !== "false" &&
        (
          className.includes("EditText") ||
          node.attrs.focusable === "true" ||
          label.includes("리뷰") ||
          label.includes("경험")
        ) &&
        node.bounds.top >= 280 &&
        node.bounds.bottom <= 2240
      );
    })
    .sort((a, b) => {
      const areaA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
      const areaB = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
      return areaB - areaA;
    })[0] || null;
}

async function openReviewEdit(config, device, store, steps, xml) {
  let currentXml = xml;
  let moreButton = findVisibleButton(currentXml, ["더보기", "옵션", "⋯", "...", "…"]);
  if (!moreButton?.bounds) {
    moreButton = parseNodes(currentXml)
      .filter((node) => (
        node.bounds &&
        isVisibleNode(node) &&
        node.attrs.enabled !== "false" &&
        (
          node.attrs.clickable === "true" ||
          labelOf(node).includes("더보기") ||
          labelOf(node).includes("...")
        ) &&
        node.bounds.top >= 120 &&
        node.bounds.top <= 360 &&
        node.bounds.left >= 840
      ))
      .sort((a, b) => b.bounds.right - a.bounds.right)[0] || null;
  }

  if (!moreButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-more-not-found", currentXml);
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
  saveXml(store, "review-edit-more-menu", currentXml);
  const editButton = findVisibleButton(currentXml, ["수정"]);
  if (!editButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-menu-edit-not-found", currentXml);
    fail(
      "수정/삭제 모달에서 수정 버튼을 찾지 못했습니다.",
      steps,
      ["더보기 선택 후 수정, 삭제 버튼이 노출되어야 합니다."]
    );
  }

  await tap(config, device, editButton.bounds.x, editButton.bounds.y);
  addStep(steps, "수정 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewEditScreen, 10000);
  saveXml(store, "review-edit-screen", currentXml);
  if (!hasReviewEditScreen(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-edit-screen-not-found", currentXml);
    fail(
      "리뷰 수정 화면으로 이동하지 못했습니다.",
      steps,
      ["수정 버튼 선택 후 리뷰 수정 화면이 보여야 합니다."]
    );
  }

  return currentXml;
}

async function changeRating(config, device, store, steps, xml) {
  const stars = findRatingStars(xml);
  const beforeLabel = extractRatingLabel(xml);
  const shouldDecrease = isLikelyFiveStarRating(beforeLabel);
  const target = shouldDecrease
    ? stars[3] || stars[2]
    : stars[stars.length - 1] || stars[3] || stars[2];
  if (!target?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-rating-stars-not-found", xml);
    fail(
      "리뷰 수정 화면에서 별점을 찾지 못했습니다.",
      steps,
      ["기존 별점이 5개면 낮추고, 5개 미만이면 올릴 수 있어야 합니다."]
    );
  }

  await tap(config, device, target.bounds.x, target.bounds.y);
  addStep(
    steps,
    shouldDecrease ? "별점 줄이기 선택" : "별점 추가 선택",
    "pass",
    `기존 문구 '${beforeLabel || "확인 불가"}' / 좌표 ${target.bounds.x},${target.bounds.y}`
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const nextXml = await dumpUiStable(config, device);
  saveXml(store, "review-edit-after-rating", nextXml);
  const afterLabel = extractRatingLabel(nextXml);
  if (beforeLabel && afterLabel && beforeLabel === afterLabel) {
    await saveFailureArtifacts(config, device, store, "review-edit-rating-not-changed", nextXml);
    fail(
      "별점 선택 후 별점 문구가 실제로 변경되지 않았습니다.",
      steps,
      [
        `기존 별점 문구: ${beforeLabel}`,
        `선택 후 별점 문구: ${afterLabel}`,
        "별점이 실제로 변경되어야 PASS 처리합니다."
      ]
    );
  }
  addStep(steps, "별점 변경 반영 확인", "pass", `${beforeLabel || "이전 문구 확인 불가"} -> ${afterLabel || "변경 후 문구 확인 불가"}`);
  return { xml: nextXml, ratingAction: shouldDecrease ? "decrease" : "increase", beforeLabel, afterLabel };
}

async function editKeywords(config, device, store, steps, xml) {
  let currentXml = xml;
  const originalKeywords = extractKeywordLabels(currentXml);
  const shouldRemove = originalKeywords.length > 1 && Math.random() < 0.5;
  let chevron = findChevronNearLabel(currentXml, ["키워드", "좋았던 점"]);
  for (let count = 0; !chevron?.bounds && count < 4; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1750", "540", "980", "150"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    chevron = findChevronNearLabel(currentXml, ["키워드", "좋았던 점"]);
  }
  if (!chevron?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-keyword-entry-not-found", currentXml);
    fail(
      "리뷰 수정 화면에서 키워드 영역 오른쪽 > 버튼을 찾지 못했습니다.",
      steps,
      ["키워드 영역 오른쪽 화살표를 선택해야 합니다."]
    );
  }

  await tap(config, device, chevron.bounds.x, chevron.bounds.y);
  addStep(steps, "키워드 영역 오른쪽 > 선택");
  currentXml = await waitForUi(config, device, hasKeywordScreen, 8000);
  saveXml(store, "review-edit-keyword-screen", currentXml);
  if (!hasKeywordScreen(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-edit-keyword-screen-not-found", currentXml);
    fail("키워드 선택 화면을 확인하지 못했습니다.", steps);
  }

  const selected = [];
  for (let count = 0; count < 2; count += 1) {
    let candidates = keywordCandidates(currentXml).filter((node) => {
      const label = labelOf(node);
      return shouldRemove
        ? !selected.includes(label) && originalKeywords.includes(label)
        : !selected.includes(label) && !originalKeywords.includes(label);
    });
    if (!candidates.length) {
      candidates = keywordCandidates(currentXml).filter((node) => !selected.includes(labelOf(node)));
    }
    const keyword = candidates[Math.floor(Math.random() * candidates.length)];
    if (!keyword?.bounds) {
      await saveFailureArtifacts(config, device, store, "review-edit-keyword-option-not-found", currentXml);
      fail(
        "키워드 선택 화면에서 추가할 키워드 2개를 찾지 못했습니다.",
        steps,
        ["키워드 화면에는 선택 가능한 키워드가 2개 이상 보여야 합니다."]
      );
    }
    const label = labelOf(keyword);
    await tap(config, device, keyword.bounds.x, keyword.bounds.y);
    selected.push(label || `키워드 ${count + 1}`);
    addStep(steps, `키워드 ${shouldRemove ? "제거" : "추가"} 선택 ${count + 1}`, "pass", label || "키워드");
    await new Promise((resolve) => setTimeout(resolve, 160));
    currentXml = await dumpUiStable(config, device);
  }

  const confirmButton = findVisibleButton(currentXml, ["확인", "완료"]);
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-keyword-confirm-not-found", currentXml);
    fail("키워드 2개 선택 후 확인 버튼을 찾지 못했습니다.", steps);
  }

  await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
  addStep(steps, "키워드 선택 확인 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewEditScreen, 8000);
  saveXml(store, "review-edit-after-keywords", currentXml);
  const afterKeywords = extractKeywordLabels(currentXml);
  const changedKeywords = shouldRemove
    ? originalKeywords.filter((keyword) => !afterKeywords.includes(keyword))
    : afterKeywords.filter((keyword) => !originalKeywords.includes(keyword));
  if (sameStringSet(originalKeywords, afterKeywords)) {
    await saveFailureArtifacts(config, device, store, "review-edit-keyword-not-changed", currentXml);
    fail(
      "키워드 선택 후 리뷰 수정 화면의 키워드가 실제로 변경되지 않았습니다.",
      steps,
      [
        `기존 키워드: ${originalKeywords.join(", ") || "확인 불가"}`,
        `선택 시도: ${selected.join(", ") || "없음"}`,
        "선택한 새 키워드가 리뷰 수정 화면에 반영되어야 PASS 처리합니다."
      ]
    );
  }
  addStep(steps, "키워드 변경 반영 확인", "pass", `${shouldRemove ? "제거" : "추가"}: ${changedKeywords.join(", ")}`);
  return {
    xml: currentXml,
    keywordAction: shouldRemove ? "remove" : "add",
    selectedKeywords: selected,
    changedKeywords,
    beforeKeywords: originalKeywords,
    afterKeywords
  };
}

async function addOnePhoto(config, device, store, steps, xml) {
  let currentXml = xml;
  let photoButton = findPhotoAddButton(currentXml);
  for (let count = 0; !photoButton?.bounds && count < 6; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1780", "540", "940", "150"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    photoButton = findPhotoAddButton(currentXml);
  }

  if (!photoButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-photo-add-not-found", currentXml);
    fail("리뷰 수정 화면에서 사진 + 추가 버튼을 찾지 못했습니다.", steps);
  }

  await tap(config, device, photoButton.bounds.x, photoButton.bounds.y);
  addStep(steps, "사진 영역 + 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => hasPhotoPicker(candidate) || candidate.includes("허용"), 9000);
  const allowButton = findVisibleButton(currentXml, ["허용", "앱 사용 중에만 허용", "모두 허용", "선택한 사진 허용", "Allow"]);
  if (allowButton?.bounds) {
    await tap(config, device, allowButton.bounds.x, allowButton.bounds.y);
    addStep(steps, "사진 접근 권한 팝업 허용");
    await new Promise((resolve) => setTimeout(resolve, 500));
    currentXml = await dumpUiStable(config, device);
  }
  currentXml = await waitForUi(config, device, hasPhotoPicker, 9000);
  saveXml(store, "review-edit-photo-picker", currentXml);

  const photo = findPhotoCandidates(currentXml)[0];
  if (!photo?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-photo-candidate-not-found", currentXml);
    fail("사진 선택 화면에서 추가할 사진을 찾지 못했습니다.", steps);
  }
  await tap(config, device, photo.bounds.x, photo.bounds.y);
  addStep(steps, "임의 사진 1장 선택", "pass", `좌표 ${photo.bounds.x},${photo.bounds.y}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  currentXml = await dumpUiStable(config, device);

  const doneButton = findPhotoDoneButton(currentXml);
  if (!doneButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-photo-done-not-found", currentXml);
    fail("사진 선택 후 완료 버튼을 찾지 못했습니다.", steps);
  }
  await tap(config, device, doneButton.bounds.x, doneButton.bounds.y);
  addStep(steps, "사진 선택 완료 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewEditScreen, 10000);
  saveXml(store, "review-edit-after-photo", currentXml);
  const afterCount = extractPhotoCount(currentXml);
  return {
    xml: currentXml,
    photoAction: "add",
    beforePhotoCount: null,
    afterPhotoCount: afterCount
  };
}

async function changePhoto(config, device, store, steps, xml) {
  const beforeCount = extractPhotoCount(xml);
  const deleteButtons = findPhotoDeleteButtons(xml);
  const shouldDelete = beforeCount > 0 && deleteButtons.length > 0 && Math.random() < 0.5;
  if (!shouldDelete) {
    const result = await addOnePhoto(config, device, store, steps, xml);
    return {
      ...result,
      beforePhotoCount: beforeCount
    };
  }

  const target = deleteButtons[Math.floor(Math.random() * deleteButtons.length)];
  await tap(config, device, target.bounds.x, target.bounds.y);
  addStep(steps, "사진 x 버튼 선택하여 삭제", "pass", `좌표 ${target.bounds.x},${target.bounds.y}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const currentXml = await dumpUiStable(config, device);
  saveXml(store, "review-edit-after-photo-delete", currentXml);
  const afterCount = extractPhotoCount(currentXml);
  if (beforeCount !== null && afterCount !== null && afterCount >= beforeCount) {
    await saveFailureArtifacts(config, device, store, "review-edit-photo-not-deleted", currentXml);
    fail(
      "사진 x 버튼을 눌렀지만 사진 개수가 줄어들지 않았습니다.",
      steps,
      [
        `삭제 전 사진 수: ${beforeCount}`,
        `삭제 후 사진 수: ${afterCount}`,
        "사진 삭제가 실제 반영되어야 PASS 처리합니다."
      ]
    );
  }
  addStep(steps, "사진 삭제 반영 확인", "pass", `${beforeCount}장 -> ${afterCount}장`);
  return {
    xml: currentXml,
    photoAction: "remove",
    beforePhotoCount: beforeCount,
    afterPhotoCount: afterCount
  };
}

async function editReviewText(config, device, store, steps, xml) {
  let currentXml = xml;
  let chevron = findChevronNearLabel(currentXml, ["리뷰 내용", "상세 리뷰"]);
  for (let count = 0; !chevron?.bounds && count < 6; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1780", "540", "940", "150"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    chevron = findChevronNearLabel(currentXml, ["리뷰 내용", "상세 리뷰"]);
  }
  if (!chevron?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-text-entry-not-found", currentXml);
    fail("리뷰 내용 영역 오른쪽 > 버튼을 찾지 못했습니다.", steps);
  }

  await tap(config, device, chevron.bounds.x, chevron.bounds.y);
  addStep(steps, "리뷰 내용 영역 오른쪽 > 선택");
  currentXml = await waitForUi(config, device, hasReviewTextEditScreen, 8000);
  saveXml(store, "review-edit-text-screen", currentXml);

  const field = findEditableTextField(currentXml);
  if (!field?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-text-field-not-found", currentXml);
    fail("리뷰 내용 수정 화면에서 텍스트 입력 영역을 찾지 못했습니다.", steps);
  }

  await tap(config, device, Math.min(field.bounds.right - 24, field.bounds.x + 220), field.bounds.y);
  await keyEvent(config, device, 123);
  const appendedText = ` edit${Date.now().toString().slice(-4)}`;
  await inputText(config, device, appendedText);
  addStep(steps, "리뷰 내용 끝 부분 임의 문구 입력", "pass", appendedText.trim());
  await keyEvent(config, device, 111).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  currentXml = await dumpUiStable(config, device);
  saveXml(store, "review-edit-text-entered", currentXml);
  if (!currentXml.includes(appendedText.trim())) {
    await tap(config, device, field.bounds.x, Math.min(field.bounds.bottom - 40, field.bounds.y + 420));
    await keyEvent(config, device, 123);
    await inputText(config, device, appendedText);
    await keyEvent(config, device, 111).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    currentXml = await dumpUiStable(config, device);
    saveXml(store, "review-edit-text-entered-retry", currentXml);
  }
  if (!currentXml.includes(appendedText.trim())) {
    await saveFailureArtifacts(config, device, store, "review-edit-text-not-changed", currentXml);
    fail(
      "리뷰 내용 입력 후 추가 문구가 실제 화면에 반영되지 않았습니다.",
      steps,
      [
        `추가 시도 문구: ${appendedText.trim()}`,
        "리뷰 내용 화면에 추가 문구가 보여야 PASS 처리합니다."
      ]
    );
  }
  addStep(steps, "리뷰 내용 변경 반영 확인", "pass", appendedText.trim());

  const confirmButton = findVisibleButton(currentXml, ["확인", "완료"]);
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-text-confirm-not-found", currentXml);
    fail("리뷰 내용 입력 후 확인 버튼을 찾지 못했습니다.", steps);
  }

  await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
  addStep(steps, "리뷰 내용 확인 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewEditScreen, 9000);
  saveXml(store, "review-edit-after-text", currentXml);
  if (!currentXml.includes(appendedText.trim())) {
    await saveFailureArtifacts(config, device, store, "review-edit-after-text-not-changed", currentXml);
    fail(
      "리뷰 내용 확인 후 리뷰 수정 화면에 추가 문구가 반영되지 않았습니다.",
      steps,
      [
        `추가 시도 문구: ${appendedText.trim()}`,
        "리뷰 수정 화면의 리뷰 내용 영역에 추가 문구가 보여야 PASS 처리합니다."
      ]
    );
  }
  return { xml: currentXml, appendedText: appendedText.trim() };
}

async function saveEditedReview(config, device, store, steps, xml, expected = {}) {
  let currentXml = xml;
  let saveButton = findVisibleButton(currentXml, ["저장", "수정 완료", "완료"]);
  for (let count = 0; !saveButton?.bounds && count < 4; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1850", "540", "980", "150"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    saveButton = findVisibleButton(currentXml, ["저장", "수정 완료", "완료"]);
  }

  if (!saveButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-edit-save-not-found", currentXml);
    fail("리뷰 수정 화면 하단 저장 버튼을 찾지 못했습니다.", steps);
  }

  await tap(config, device, saveButton.bounds.x, saveButton.bounds.y);
  addStep(steps, "리뷰 수정 저장 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => (
    candidate.includes("수정 완료") ||
    candidate.includes("저장되었습니다") ||
    candidate.includes("내 리뷰") ||
    candidate.includes("리뷰 상세") ||
    !candidate.includes("저장")
  ), 12000);
  saveXml(store, "review-edit-after-save", currentXml);

  if (hasAppError(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-edit-save-app-error", currentXml);
    fail("리뷰 수정 저장 후 앱 오류 문구가 노출되었습니다.", steps);
  }

  const confirmButton = findVisibleButton(currentXml, ["확인"]);
  if (confirmButton?.bounds) {
    await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
    addStep(steps, "리뷰 수정 완료 팝업 확인 버튼 선택");
    currentXml = await waitForUi(config, device, (candidate) => !candidate.includes("저장 완료"), 6000);
    saveXml(store, "review-edit-after-save-confirm", currentXml);
  }

  if (expected.appendedText && !currentXml.includes(expected.appendedText)) {
    await saveFailureArtifacts(config, device, store, "review-edit-save-text-not-visible", currentXml);
    fail(
      "저장 완료 후 수정된 리뷰 본문을 확인하지 못했습니다.",
      steps,
      [
        `기대 문구: ${expected.appendedText}`,
        "저장 후 리뷰 상세 화면에 수정 문구가 보여야 PASS 처리합니다."
      ]
    );
  }
}

async function runReviewEditTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("리뷰 수정 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await reviewCommon.wakeAndUnlock(config, device, steps, store);
    await reviewCommon.launchFresh(config, device, appPackage, steps);

    const contractListXml = await reviewCommon.openContractTab(config, device, store, steps, {
      prefix: "review-edit",
      purpose: "리뷰 수정"
    });
    const reviewDetailXml = await reviewCommon.openMyReview(config, device, store, steps, contractListXml, {
      prefix: "review-edit",
      purpose: "리뷰 수정"
    });
    let editXml = await openReviewEdit(config, device, store, steps, reviewDetailXml);
    const ratingResult = await changeRating(config, device, store, steps, editXml);
    editXml = ratingResult.xml;
    const keywordResult = await editKeywords(config, device, store, steps, editXml);
    const photoResult = await changePhoto(config, device, store, steps, keywordResult.xml);
    editXml = photoResult.xml;
    const textResult = await editReviewText(config, device, store, steps, editXml);
    await saveEditedReview(config, device, store, steps, textResult.xml, {
      appendedText: textResult.appendedText,
      selectedKeywords: keywordResult.selectedKeywords
    });

    return {
      test_id: "TC-INTERNAL-REFACTOR-006",
      name: "guest 리뷰 수정",
      env,
      status: "pass",
      device,
      steps,
      review_edit: {
        rating_changed: true,
        rating_action: ratingResult.ratingAction,
        rating_before: ratingResult.beforeLabel,
        rating_after: ratingResult.afterLabel,
        keyword_action: keywordResult.keywordAction,
        selected_keywords: keywordResult.selectedKeywords,
        changed_keywords: keywordResult.changedKeywords,
        photo_action: photoResult.photoAction,
        before_photo_count: photoResult.beforePhotoCount,
        after_photo_count: photoResult.afterPhotoCount,
        added_photo_count: photoResult.photoAction === "add" ? 1 : 0,
        removed_photo_count: photoResult.photoAction === "remove" ? 1 : 0,
        appended_text: textResult.appendedText,
        saved: true,
        manual_check_required: [
          "기존 리뷰 대비 별점 선택 색상 변화",
          "추가 사진 썸네일 실제 이미지 품질",
          "수정된 리뷰 본문 자연스러움"
        ]
      }
    };
  });
}

module.exports = {
  runReviewEditTest
};
