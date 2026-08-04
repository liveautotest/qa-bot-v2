const FIGMA_SOURCE = "PLAT-1158 계약 연장 기능 추가";

function normalizeText(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text, values) {
  return values.some((value) => text.includes(value));
}

function extractKrwAmounts(text) {
  return Array.from(new Set(
    [...text.matchAll(/(?:₩|￦|W)\s?[\d,]+|[\d,]+\s?원/g)]
      .map((match) => normalizeText(match[0]))
  ));
}

function buildValidation({ screen, status, checked, missing = [], manualRequired = [], amounts = [] }) {
  const hasMissing = missing.length > 0;
  const needsManual = manualRequired.length > 0;
  return {
    source: FIGMA_SOURCE,
    screen,
    status: hasMissing ? "fail" : needsManual ? "manual_required" : status || "pass",
    checked,
    missing,
    manual_required: manualRequired,
    amounts
  };
}

function validateGuestExtensionDetail(xml, extensionInfo = {}) {
  const text = normalizeText(xml);
  const checked = [];
  const missing = [];
  const manualRequired = [];

  const rules = [
    {
      label: "계약 연장 화면 제목",
      values: ["계약 연장"]
    },
    {
      label: "변경 후 계약 영역",
      values: ["변경 후 계약", "계약 연장 날짜"]
    },
    {
      label: "주의사항 및 규정 영역",
      values: ["주의사항 및 규정", "주의사항 및 환불 규정"]
    }
  ];

  for (const rule of rules) {
    if (includesAny(text, rule.values)) checked.push(rule.label);
    else missing.push(rule.label);
  }

  if (extensionInfo.extensionNights) {
    const expectedNightPattern = new RegExp(`${extensionInfo.extensionNights}\\s*박`);
    const extensionNightMatch = text.match(/(\d+)\s*박\s*연장/);
    const visibleNightMatch = extensionNightMatch || text.match(/(\d+)\s*박\s*\d+\s*일|총\s*(\d+)\s*박/);
    if (expectedNightPattern.test(text)) {
      checked.push(`총 연장 박수 ${extensionInfo.extensionNights}박`);
    } else if (visibleNightMatch) {
      const visibleNights = visibleNightMatch.slice(1).find(Boolean);
      checked.push(`총 연장 박수 표기`);
      manualRequired.push(
        `자동 선택 박수(${extensionInfo.extensionNights}박)와 화면 표시 박수(${visibleNights}박)가 달라 수동 확인이 필요합니다.`
      );
    } else {
      manualRequired.push("총 연장 박수 표기가 Android XML에 노출되지 않아 수동 확인이 필요합니다.");
    }
  } else {
    manualRequired.push("총 연장 박수는 실행 데이터가 없어 자동 비교하지 않았습니다.");
  }

  if (includesAny(text, [
    "연장 금액은 수락 시 확정됩니다.",
    "연장 금액은 호스트 수락 시 확정되며, 예상 요금과 다를 수 있습니다.",
    "연장 금액은 수락 후 게스트 결제 시 확정됩니다."
  ])) {
    checked.push("연장 금액 확정 안내 문구");
  } else {
    manualRequired.push("연장 금액 안내 문구는 Android XML에 노출되지 않아 수동 확인이 필요합니다.");
  }

  const amounts = extractKrwAmounts(text);
  if (amounts.length) checked.push("금액 표기 형식");
  else manualRequired.push("금액 값은 Android XML에 노출되지 않아 수동 확인이 필요합니다.");

  return buildValidation({
    screen: "guest_extension_request_detail",
    checked,
    missing,
    manualRequired,
    amounts
  });
}

function validateGuestExtensionCompletePopup(xml) {
  const text = normalizeText(xml);
  const checked = [];
  const missing = [];
  const manualRequired = [];

  if (includesAny(text, ["계약 연장 요청 완료", "연장 요청 완료"])) {
    checked.push("계약 연장 요청 완료 팝업 제목");
  } else {
    missing.push("계약 연장 요청 완료 팝업 제목");
  }

  if (includesAny(text, ["계약 연장이 요청되었습니다.", "연장 요청이 완료"])) {
    checked.push("계약 연장 요청 완료 안내 문구");
  } else {
    manualRequired.push("완료 팝업 본문 문구는 XML 노출이 제한될 수 있어 수동 확인이 필요합니다.");
  }

  if (text.includes("확인")) {
    checked.push("완료 팝업 확인 버튼");
  } else {
    missing.push("완료 팝업 확인 버튼");
  }

  return buildValidation({
    screen: "guest_extension_request_complete_popup",
    checked,
    missing,
    manualRequired,
    amounts: []
  });
}

function mergeFigmaValidations(validations) {
  const items = validations.filter(Boolean);
  const missing = items.flatMap((item) => item.missing || []);
  const manualRequired = items.flatMap((item) => item.manual_required || []);
  const checked = items.flatMap((item) => item.checked || []);
  const amounts = Array.from(new Set(items.flatMap((item) => item.amounts || [])));

  return {
    source: FIGMA_SOURCE,
    status: missing.length ? "fail" : manualRequired.length ? "manual_required" : "pass",
    checked,
    missing,
    manual_required: manualRequired,
    amounts
  };
}

module.exports = {
  validateGuestExtensionDetail,
  validateGuestExtensionCompletePopup,
  mergeFigmaValidations
};
