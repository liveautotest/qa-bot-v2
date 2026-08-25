const { withDeviceLock } = require("../infra/device-lock");
const {
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
const {
  addStep,
  fail
} = require("./helpers/review-common");
const reviewCommon = require("./helpers/review-common");

function hasReviewRatingScreen(xml) {
  return (
    xml.includes("머무는 동안") ||
    xml.includes("어땠나요") ||
    xml.includes("어땟나요") ||
    (
      xml.includes("별점") &&
      (xml.includes("다음") || xml.includes("리뷰"))
    )
  );
}

function hasReviewTagScreen(xml) {
  return (
    xml.includes("어떤 점이 좋았나요") ||
    xml.includes("좋았나요") ||
    (
      xml.includes("태그") &&
      (xml.includes("확인") || xml.includes("다음"))
    )
  );
}

function hasReviewWriteScreen(xml) {
  return (
    xml.includes("상세 리뷰") ||
    xml.includes("리뷰 작성") ||
    xml.includes("간편 작성") ||
    xml.includes("사진") ||
    xml.includes("리뷰 제출")
  );
}

function hasPhotoPicker(xml) {
  return (
    xml.includes("사진") ||
    xml.includes("앨범") ||
    xml.includes("최근") ||
    xml.includes("완료") ||
    xml.includes("선택")
  ) && parseNodes(xml).some((node) => imageCandidateScore(node) > 0);
}

function hasReviewCompleteDialog(xml) {
  return (
    (
      xml.includes("리뷰 작성 완료") ||
      xml.includes("리뷰가 등록") ||
      xml.includes("작성 완료") ||
      xml.includes("등록되었습니다")
    ) &&
    xml.includes("확인")
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

function extractGeneratedReviewText(xml) {
  const blocked = [
    "{{common.loading}}",
    "선택한 키워드",
    "리뷰를 작성 중",
    "상세 리뷰",
    "최대 10장",
    "사진을 등록",
    "다음 게스트에게",
    "내용 다듬기",
    "다시 작성",
    "허위 리뷰",
    "명예 훼손",
    "리뷰 제출",
    "1000"
  ];

  return xmlTextLines(xml)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 20)
    .filter((line) => !/^\d+\s*\/\s*\d+$/.test(line))
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !blocked.some((text) => line.includes(text)))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function validateGeneratedReviewText(xml) {
  const text = extractGeneratedReviewText(xml);
  const issues = [];
  const checks = [];

  if (!text) {
    issues.push("AI 리뷰 본문을 Android XML에서 확인하지 못했습니다.");
  } else {
    checks.push(`AI 리뷰 본문 확인 (${text.length}자)`);
  }

  if (hasAppError(xml) || /일시적인 오류|오류가 발생|다시 시도/.test(text)) {
    issues.push("리뷰 작성 화면에 앱 오류 문구가 노출되었습니다.");
  } else {
    checks.push("앱 오류 문구 미노출");
  }

  if (/작성 중|loading|로딩|{{common\.loading}}/i.test(text)) {
    issues.push("리뷰 본문이 아직 생성 대기/로딩 상태입니다.");
  } else {
    checks.push("로딩/대기 문구 미노출");
  }

  if (text && text.length < 30) {
    issues.push(`리뷰 본문이 너무 짧습니다. (${text.length}자)`);
  }

  return {
    status: issues.length ? "fail" : "pass",
    text,
    text_preview: text.length > 180 ? `${text.slice(0, 180)}...` : text,
    length: text.length,
    checks,
    issues
  };
}

function hasAiReviewLoading(xml) {
  return /작성 중|loading|로딩|{{common\.loading}}|선택한 키워드/i.test(xml);
}

function findSubmitReviewButton(xml, options = {}) {
  const labels = ["리뷰 제출", "제출", "등록"];
  return findExactNode(xml, labels, {
    visible: true,
    clickable: options.enabledOnly !== false,
    enabled: options.enabledOnly !== false
  }) || findNode(xml, labels, {
    visible: true,
    clickable: options.enabledOnly !== false,
    enabled: options.enabledOnly !== false
  });
}

async function waitForAiReviewReady(config, device, timeoutMs = 60000) {
  const startedAt = Date.now();
  let currentXml = "";

  // AI 생성 중에도 버튼 텍스트는 먼저 노출될 수 있으므로 실제 활성 상태까지 기다린다.
  while (Date.now() - startedAt < timeoutMs) {
    currentXml = await dumpUiStable(config, device);
    const enabledSubmit = findSubmitReviewButton(currentXml, { enabledOnly: true });
    if (enabledSubmit?.bounds && !hasAiReviewLoading(currentXml) && !hasAppError(currentXml)) {
      return { xml: currentXml, submitButton: enabledSubmit, ready: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return {
    xml: currentXml,
    submitButton: findSubmitReviewButton(currentXml, { enabledOnly: true }),
    ready: false
  };
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

function labelOf(node) {
  return nodeLabel(node).replace(/\s+/g, " ").trim();
}

function pickRandom(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function visibleTagCandidates(xml) {
  const blocked = ["확인", "다음", "뒤로", "닫기", "좋았나요", "어떤 점", "최대", "선택할 수"];
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
      return width >= 80 && width <= 620 && height >= 42 && height <= 230;
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
}

function findRatingStars(xml) {
  const question = findNode(xml, ["머무는 동안", "어땠나요", "어땟나요"], { visible: true });
  const minTop = question?.bounds ? question.bounds.bottom : 900;
  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= minTop &&
        node.bounds.top <= 1600 &&
        width >= 80 &&
        width <= 190 &&
        height >= 80 &&
        height <= 190
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

async function maybeAllowPermission(config, device, store, steps, xml) {
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
  saveXml(store, "review-write-after-permission", nextXml);
  return nextXml;
}

async function selectThreeStarRating(config, device, store, steps, xml) {
  const stars = findRatingStars(xml);
  const thirdStar = stars[2];
  if (!thirdStar?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-rating-stars-not-found", xml);
    fail(
      "별점 화면에서 별 5개 중 3번째 별을 찾지 못했습니다.",
      steps,
      [
        "별점 화면에는 선택 가능한 별 아이콘 5개가 보여야 합니다.",
        "리포트의 review-write-rating-stars-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const x = thirdStar.bounds.x;
  const y = thirdStar.bounds.y;
  await tap(config, device, x, y);
  addStep(steps, "별점 3개 선택", "pass", `3번째 별 XML 좌표 (${x}, ${y})`);

  let nextXml = await waitForUi(config, device, (candidate) => (
    hasReviewRatingScreen(candidate) &&
    Boolean(findVisibleButton(candidate, ["다음"]))
  ), 3000);
  saveXml(store, "review-write-after-rating", nextXml);

  const nextButton = findVisibleButton(nextXml, ["다음"]);
  if (!nextButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-rating-next-not-found", nextXml);
    fail(
      "별점 3개 선택 후 다음 버튼을 찾지 못했습니다.",
      steps,
      [
        "별점 선택 후 하단 다음 버튼이 활성화되어야 합니다.",
        "리포트의 review-write-rating-next-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, nextButton.bounds.x, nextButton.bounds.y);
  addStep(steps, "별점 화면 다음 버튼 선택");
  nextXml = await waitForUi(config, device, hasReviewTagScreen, 8000);
  saveXml(store, "review-write-tags", nextXml);
  if (!hasReviewTagScreen(nextXml)) {
    await saveFailureArtifacts(config, device, store, "review-write-tags-not-found", nextXml);
    fail(
      "별점 다음 버튼을 눌렀지만 태그 선택 화면으로 이동하지 못했습니다.",
      steps,
      [
        "다음 화면에는 '어떤 점이 좋았나요?' 태그 선택 화면이 보여야 합니다.",
        "리포트의 review-write-tags-not-found.png 화면을 확인해주세요."
      ]
    );
  }
  return nextXml;
}

async function selectRandomTags(config, device, store, steps, xml) {
  let currentXml = xml;
  const selected = [];

  for (let count = 0; count < 3; count += 1) {
    const candidates = visibleTagCandidates(currentXml)
      .filter((node) => !selected.includes(labelOf(node)));
    const tag = pickRandom(candidates);
    if (!tag?.bounds) {
      await saveFailureArtifacts(config, device, store, "review-write-tag-not-found", currentXml);
      fail(
        "태그 선택 화면에서 선택 가능한 태그 3개를 찾지 못했습니다.",
        steps,
        [
          "태그 화면에는 임의 선택 가능한 태그가 3개 이상 보여야 합니다.",
          "리포트의 review-write-tag-not-found.png 화면을 확인해주세요."
        ]
      );
    }

    const label = labelOf(tag);
    await tap(config, device, tag.bounds.x, tag.bounds.y);
    selected.push(label || `태그 ${count + 1}`);
    addStep(steps, `좋았던 점 태그 선택 ${count + 1}`, "pass", label || "태그");
    await new Promise((resolve) => setTimeout(resolve, 160));
    currentXml = await dumpUiStable(config, device);
  }

  saveXml(store, "review-write-tags-selected", currentXml);
  const confirmButton = findVisibleButton(currentXml, ["확인", "다음"]);
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-tags-confirm-not-found", currentXml);
    fail(
      "태그 3개 선택 후 확인 버튼을 찾지 못했습니다.",
      steps,
      [
        "태그 선택 후 하단 확인 버튼이 활성화되어야 합니다.",
        "리포트의 review-write-tags-confirm-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
  addStep(steps, "태그 화면 확인 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewWriteScreen, 9000);
  saveXml(store, "review-write-detail", currentXml);
  if (!hasReviewWriteScreen(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-write-detail-not-found", currentXml);
    fail(
      "태그 확인 후 상세 리뷰 작성 화면으로 이동하지 못했습니다.",
      steps,
      [
        "상세 리뷰 화면에는 사진 추가, 간편 작성, 리뷰 제출 관련 요소가 보여야 합니다.",
        "리포트의 review-write-detail-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return { xml: currentXml, selectedTags: selected };
}

function findPhotoAddButton(xml) {
  const byLabel = findVisibleButton(xml, ["사진 +", "+ 추가", "사진 추가", "사진", "추가"]);
  if (byLabel?.bounds && byLabel.bounds.top >= 300 && byLabel.bounds.top <= 1500) return byLabel;

  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.enabled === "false") return false;
      const label = labelOf(node);
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      return (
        node.bounds.top >= 320 &&
        node.bounds.top <= 1500 &&
        width >= 80 &&
        width <= 360 &&
        height >= 80 &&
        height <= 360 &&
        (
          label.includes("+") ||
          label.includes("사진") ||
          node.attrs.clickable === "true"
        )
      );
    })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)[0] || null;
}

async function addThreePhotos(config, device, store, steps, xml) {
  let currentXml = xml;
  let photoButton = findPhotoAddButton(currentXml);

  for (let count = 0; !photoButton?.bounds && count < 4; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1780", "540", "940", "160"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    photoButton = findPhotoAddButton(currentXml);
  }

  if (!photoButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-photo-add-not-found", currentXml);
    fail(
      "상세 리뷰 화면에서 사진 + 추가 버튼을 찾지 못했습니다.",
      steps,
      [
        "상세 리뷰 화면에는 사진 추가 버튼이 보여야 합니다.",
        "리포트의 review-write-photo-add-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, photoButton.bounds.x, photoButton.bounds.y);
  addStep(steps, "사진 + 추가 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => hasPhotoPicker(candidate) || candidate.includes("허용"), 9000);
  currentXml = await maybeAllowPermission(config, device, store, steps, currentXml);
  currentXml = await waitForUi(config, device, hasPhotoPicker, 9000);
  saveXml(store, "review-write-photo-picker", currentXml);
  if (!hasPhotoPicker(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-write-photo-picker-not-found", currentXml);
    fail(
      "사진 선택 화면을 확인하지 못했습니다.",
      steps,
      [
        "사진 + 추가 버튼 선택 후 사진 선택 화면 또는 Android 사진 선택기가 떠야 합니다.",
        "리포트의 review-write-photo-picker-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  let photos = findPhotoCandidates(currentXml);
  const selected = [];
  for (let count = 0; count < 3; count += 1) {
    const photo = photos.find((candidate) => (
      !selected.some((point) => {
        const [x, y] = point.split(",").map(Number);
        return Math.abs(candidate.bounds.x - x) < 20 && Math.abs(candidate.bounds.y - y) < 20;
      })
    ));
    if (!photo?.bounds) {
      await saveFailureArtifacts(config, device, store, "review-write-photo-candidate-not-found", currentXml);
      fail(
        "사진 선택 화면에서 임의 사진 3장을 찾지 못했습니다.",
        steps,
        [
          "사진 선택 화면에는 선택 가능한 이미지가 3장 이상 보여야 합니다.",
          "리포트의 review-write-photo-candidate-not-found.png 화면을 확인해주세요."
        ]
      );
    }
    await tap(config, device, photo.bounds.x, photo.bounds.y);
    selected.push(`${photo.bounds.x},${photo.bounds.y}`);
    addStep(steps, `임의 사진 선택 ${count + 1}`, "pass", `좌표 ${photo.bounds.x},${photo.bounds.y}`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    currentXml = await dumpUiStable(config, device);
    photos = findPhotoCandidates(currentXml);
  }

  const doneButton = findPhotoDoneButton(currentXml);
  if (!doneButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-photo-done-not-found", currentXml);
    fail(
      "사진 3장 선택 후 완료 버튼을 찾지 못했습니다.",
      steps,
      [
        "사진 선택 화면 상단 또는 하단에 완료 버튼이 보여야 합니다.",
        "리포트의 review-write-photo-done-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, doneButton.bounds.x, doneButton.bounds.y);
  addStep(steps, "사진 선택 완료 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewWriteScreen, 10000);
  saveXml(store, "review-write-after-photos", currentXml);
  if (!hasReviewWriteScreen(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-write-after-photos-not-found", currentXml);
    fail(
      "사진 선택 완료 후 리뷰 작성 화면으로 돌아오지 못했습니다.",
      steps,
      [
        "사진 3장 선택 후 상세 리뷰 작성 화면으로 복귀해야 합니다.",
        "리포트의 review-write-after-photos-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  return { xml: currentXml, selectedPhotos: selected };
}

async function tapSimpleAiReview(config, device, store, steps, xml) {
  let currentXml = xml;
  let simpleButton = findVisibleButton(currentXml, ["간편 작성", "간편작성"]);

  for (let count = 0; !simpleButton?.bounds && count < 5; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1840", "540", "900", "160"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    simpleButton = findVisibleButton(currentXml, ["간편 작성", "간편작성"]);
  }

  if (!simpleButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-simple-button-not-found", currentXml);
    fail(
      "상세 리뷰 화면에서 간편 작성 버튼을 찾지 못했습니다.",
      steps,
      [
        "사진 선택 후 상세 리뷰 영역에 간편 작성 버튼이 보여야 합니다.",
        "리포트의 review-write-simple-button-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, simpleButton.bounds.x, simpleButton.bounds.y);
  addStep(steps, "간편 작성 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => (
    candidate.includes("AI") ||
    candidate.includes("ai") ||
    candidate.includes("리뷰 작성 대기") ||
    candidate.includes("리뷰 제출")
  ), 8000);
  saveXml(store, "review-write-after-simple", currentXml);

  const aiButton = findVisibleButton(currentXml, [
    "AI 리뷰 작성 대기",
    "ai 리뷰 작성 대기",
    "AI 리뷰 작성",
    "리뷰 작성 대기",
    "작성 대기"
  ]);
  if (aiButton?.bounds) {
    await tap(config, device, aiButton.bounds.x, aiButton.bounds.y);
    addStep(steps, "AI 리뷰 작성 대기 버튼 선택");
  } else {
    addStep(steps, "AI 리뷰 작성 대기 버튼 확인", "pass", "버튼이 XML에 없거나 간편 작성 직후 자동 생성 대기 상태");
  }

  const readyResult = await waitForAiReviewReady(config, device);
  currentXml = readyResult.xml;
  saveXml(store, "review-write-ai-complete", currentXml);
  if (!readyResult.ready) {
    await saveFailureArtifacts(config, device, store, "review-write-ai-review-not-complete", currentXml);
    const disabledSubmit = findSubmitReviewButton(currentXml, { enabledOnly: false });
    fail(
      "AI 리뷰 작성 완료 상태를 확인하지 못했습니다.",
      steps,
      [
        disabledSubmit?.bounds
          ? "리뷰 제출 버튼은 보이지만 아직 활성화되지 않았습니다."
          : "간편 작성 후 리뷰 내용이 생성되고 리뷰 제출 버튼이 보여야 합니다.",
        hasAiReviewLoading(currentXml)
          ? "AI 리뷰 생성 로딩 문구가 아직 남아 있습니다."
          : "AI 리뷰 생성 로딩 문구는 보이지 않지만 제출 가능 상태가 아닙니다.",
        "리포트의 review-write-ai-review-not-complete.png 화면을 확인해주세요."
      ]
    );
  }

  const reviewTextValidation = validateGeneratedReviewText(currentXml);
  const onlyXmlTextMissing = (
    reviewTextValidation.issues.length === 1 &&
    reviewTextValidation.issues[0].includes("Android XML")
  );
  if (reviewTextValidation.status === "fail" && !onlyXmlTextMissing) {
    await saveFailureArtifacts(config, device, store, "review-write-ai-review-text-invalid", currentXml);
    fail(
      "AI 리뷰 본문 자동 검증에 실패했습니다.",
      steps,
      [
        ...reviewTextValidation.issues,
        "리포트의 review-write-ai-review-text-invalid.png 화면을 확인해주세요."
      ]
    );
  }

  addStep(steps, "AI 리뷰 작성 완료 확인");
  if (onlyXmlTextMissing) {
    reviewTextValidation.status = "manual_required";
    reviewTextValidation.checks.push("리뷰 제출 버튼 활성화 확인");
    addStep(
      steps,
      "AI 리뷰 본문 오류 자동 확인",
      "pass",
      "본문이 Android XML에 노출되지 않아 대시보드 화면 캡처 수동 확인 필요, 리뷰 제출 버튼 활성화 확인"
    );
  } else {
    addStep(
      steps,
      "AI 리뷰 본문 오류 자동 확인",
      "pass",
      reviewTextValidation.checks.join(", ")
    );
  }
  return { xml: currentXml, reviewTextValidation };
}

async function submitReview(config, device, store, steps, xml) {
  let currentXml = xml;
  let submitButton = findSubmitReviewButton(currentXml, { enabledOnly: true });

  for (let count = 0; !submitButton?.bounds && count < 4; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "1800", "540", "920", "160"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    currentXml = await dumpUiStable(config, device);
    submitButton = findSubmitReviewButton(currentXml, { enabledOnly: true });
  }

  if (!submitButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-submit-not-found", currentXml);
    fail(
      "리뷰 제출 버튼을 찾지 못했습니다.",
      steps,
      [
        "AI 리뷰 작성 완료 후 하단 리뷰 제출 버튼이 보여야 합니다.",
        "리포트의 review-write-submit-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  await tap(config, device, submitButton.bounds.x, submitButton.bounds.y);
  addStep(steps, "리뷰 제출 버튼 선택");
  currentXml = await waitForUi(config, device, hasReviewCompleteDialog, 15000);
  saveXml(store, "review-write-complete-dialog", currentXml);
  if (!hasReviewCompleteDialog(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-write-complete-dialog-not-found", currentXml);
    fail(
      "리뷰 작성 완료 팝업을 확인하지 못했습니다.",
      steps,
      [
        "리뷰 제출 후 작성 완료 팝업과 확인 버튼이 보여야 합니다.",
        "리포트의 review-write-complete-dialog-not-found.png 화면을 확인해주세요."
      ]
    );
  }

  const confirmButton = findVisibleButton(currentXml, ["확인"]);
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "review-write-complete-confirm-not-found", currentXml);
    fail(
      "리뷰 작성 완료 팝업에서 확인 버튼을 찾지 못했습니다.",
      steps,
      ["리포트의 review-write-complete-confirm-not-found.png 화면을 확인해주세요."]
    );
  }

  await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
  addStep(steps, "리뷰 작성 완료 팝업 확인 버튼 선택");
  currentXml = await waitForUi(config, device, (candidate) => !hasReviewCompleteDialog(candidate), 6000);
  if (hasReviewCompleteDialog(currentXml)) {
    await saveFailureArtifacts(config, device, store, "review-write-complete-confirm-not-dismissed", currentXml);
    fail(
      "리뷰 작성 완료 팝업 확인 버튼을 눌렀지만 팝업이 닫히지 않았습니다.",
      steps,
      [
        "확인 버튼 선택 후 팝업이 사라져야 최종 PASS 처리합니다.",
        "리포트의 review-write-complete-confirm-not-dismissed.png 화면을 확인해주세요."
      ]
    );
  }

  return currentXml;
}

async function runReviewWriteTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("리뷰 작성 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await reviewCommon.wakeAndUnlock(config, device, steps, store);
    await reviewCommon.launchFresh(config, device, appPackage, steps);

    const contractListXml = await reviewCommon.openContractTab(config, device, store, steps, {
      prefix: "review-write",
      purpose: "리뷰 작성"
    });
    const ratingXml = await reviewCommon.openReviewWriteFromContract(config, device, store, steps, contractListXml, {
      prefix: "review-write",
      hasReviewRatingScreen
    });
    const tagXml = await selectThreeStarRating(config, device, store, steps, ratingXml);
    const tagResult = await selectRandomTags(config, device, store, steps, tagXml);
    const photoResult = await addThreePhotos(config, device, store, steps, tagResult.xml);
    const aiResult = await tapSimpleAiReview(config, device, store, steps, photoResult.xml);
    await submitReview(config, device, store, steps, aiResult.xml);

    return {
      test_id: "TC-INTERNAL-REFACTOR-005",
      name: "guest 리뷰 작성",
      env,
      status: "pass",
      device,
      steps,
      review_write: {
        rating: 3,
        selected_tags: tagResult.selectedTags,
        selected_photo_count: photoResult.selectedPhotos.length,
        ai_review_used: true,
        generated_review_text_preview: aiResult.reviewTextValidation.text_preview,
        generated_review_text_length: aiResult.reviewTextValidation.length,
        generated_review_text_validation: aiResult.reviewTextValidation.status,
        generated_review_text_checks: aiResult.reviewTextValidation.checks,
        generated_review_text_issues: aiResult.reviewTextValidation.issues,
        completed: true,
        manual_check_required: [
          "별 아이콘의 선택 색상/애니메이션",
          "사진 썸네일 실제 이미지 품질",
          "AI 생성 리뷰 문장 품질"
        ]
      }
    };
  });
}

module.exports = {
  runReviewWriteTest
};
