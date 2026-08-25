function formatHelp() {
  return [
    "사용 가능한 QA 명령어",
    "",
    "환경 선택",
    "- 명령어 뒤에 dev 또는 stg를 붙일 수 있습니다.",
    "- 생략하면 stg로 실행됩니다.",
    "- 계약 요청/승인/결제/취소 계열은 필요한 게스트/호스트 로그인을 먼저 확인하고, 풀려 있으면 자동 로그인 후 이어서 진행합니다.",
    "",
    "자주 쓰는 명령어",
    "!기본검증 일반결제 stg",
    "!기본검증 일반결제 dev",
    "!기본검증 무통장 결제 stg",
    "!기본검증 무통장 결제 dev",
    "!기본검증 등록카드결제 stg",
    "!기본검증 등록카드결제 dev",
    "!기본검증 분할결제 stg",
    "!기본검증 분할결제 dev",
    "!기본검증 연장결제 카드 stg",
    "!기본검증 연장결제 카드 dev",
    "!기본검증 연장결제 무통장 stg",
    "!기본검증 연장결제 무통장 dev",
    "!빌드설치",
    "!게스트 로그인 stg",
    "!게스트 로그인 dev",
    "!게스트 로그아웃 stg",
    "!게스트 로그아웃 dev",
    "!게스트 검색 정확한일정 stg",
    "!게스트 검색 정확한일정 dev",
    "!게스트 검색 유연한일정 stg",
    "!게스트 검색 유연한일정 dev",
    "!게스트 리브후기 프로필 stg",
    "!게스트 리브후기 프로필 dev",
    "!게스트 리브후기 일정 선택 stg",
    "!게스트 리브후기 일정 선택 dev",
    "!게스트 리브후기 상세 stg",
    "!게스트 리브후기 상세 dev",
    "!게스트 리뷰작성 stg",
    "!게스트 리뷰작성 dev",
    "!게스트 리뷰수정 stg",
    "!게스트 리뷰수정 dev",
    "!게스트 리뷰삭제 stg",
    "!게스트 리뷰삭제 dev",
    "!게스트 쿠폰함 stg",
    "!게스트 쿠폰함 dev",
    "!게스트 계약 요청 stg",
    "!게스트 계약 요청 dev",
    "!게스트 계약 요청 취소 stg",
    "!게스트 계약 요청 취소 dev",
    "!게스트 계약 확정 취소 stg",
    "!게스트 계약 확정 취소 dev",
    "!게스트 연장요청 stg",
    "!게스트 연장요청 dev",
    "!호스트 연장수락 stg",
    "!호스트 연장수락 dev",
    "!게스트 연장결제 카드 stg",
    "!게스트 연장결제 카드 dev",
    "!게스트 연장결제 무통장 stg",
    "!게스트 연장결제 무통장 dev",
    "!게스트 계약 결제 일반카드 stg",
    "!게스트 계약 결제 일반카드 dev",
    "!게스트 계약 결제 자동카드 stg (PASS 시 호스트 계약 승인 자동 실행)",
    "!게스트 계약 결제 자동카드 dev (PASS 시 호스트 계약 승인 자동 실행)",
    "!게스트 계약 결제 무통장 stg",
    "!게스트 계약 결제 무통장 dev",
    "!무통장 입금 승인 (단독 실행용, 무통장 결제 PASS 시에는 자동 실행)",
    "!일정변경 146628 일주일 전 dev",
    "!일정변경 146628 2주일 후 stg",
    "!호스트 로그인 stg",
    "!호스트 로그인 dev",
    "!호스트 로그아웃 stg",
    "!호스트 로그아웃 dev",
    "!호스트 계약 승인 stg",
    "!호스트 계약 승인 dev",
    "!호스트 계약 요청 거절 stg",
    "!호스트 계약 요청 거절 dev",
    "",
    "상세 명령어",
    "!qa help",
    "!qa basic-validation env=staging method=extension-card",
    "!qa basic-validation env=staging method=extension-bank-transfer",
    "!qa basic-validation env=staging method=split-payment",
    "!qa login env=staging role=guest",
    "!qa login env=staging role=host",
    "!qa logout env=staging role=guest",
    "!qa logout env=staging role=host",
    "!qa search env=staging role=guest",
    "!qa search-flexible env=staging role=guest",
    "!qa review-profile env=staging role=guest",
    "!qa review-schedule-select env=staging role=guest",
    "!qa review-detail env=staging role=guest",
    "!qa review-write env=staging role=guest",
    "!qa review-edit env=staging role=guest",
    "!qa review-delete env=staging role=guest",
    "!qa coupon-box env=staging role=guest",
    "!qa contract-request env=staging role=guest",
    "!qa contract-request env=staging role=guest method=auto-card",
    "!qa contract-request env=staging role=guest method=split-payment",
    "!qa contract-cancel-request env=staging role=guest",
    "!qa contract-cancel-confirmed env=staging role=guest",
    "!qa contract-extension env=staging role=guest",
    "!qa contract-payment env=staging role=guest method=extension-card",
    "!qa contract-payment env=staging role=guest method=extension-bank-transfer",
    "!qa contract-payment env=staging role=guest method=card",
    "!qa contract-payment env=staging role=guest method=auto-card",
    "!qa contract-payment env=staging role=guest method=bank-transfer (PASS 시 무통장 입금 승인 자동 실행)",
    "!qa contract-approve env=staging role=host",
    "!qa contract-reject env=staging role=host",
    "!qa toss-deposit-approve",
    "!qa build-install env=staging role=guest build_version=123"
  ].join("\n");
}

function formatConditionValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function formatSearchConditions(conditions) {
  if (!conditions) return [];

  const labels = {
    region: "지역",
    schedule_type: "일정 방식",
    start_date: "체크인",
    end_date: "체크아웃",
    stay_duration: "머무는 기간",
    stay_nights: "계약 박수",
    expected_move_in_months: "예상 입주월",
    adult_count: "성인",
    child_count: "어린이",
    infant_count: "유아",
    pet_count: "반려동물",
    pet_info: "반려동물 정보",
    payment_method: "계약 요청 결제 방식"
  };

  return Object.entries(labels)
    .filter(([key]) => conditions[key] !== undefined)
    .map(([key, label]) => `- ${label}: ${formatConditionValue(conditions[key])}`);
}

function formatStepSummary(steps = [], { compact = false } = {}) {
  if (!steps.length) return [];

  const visibleSteps = compact ? steps.slice(0, 12) : steps;
  const lines = visibleSteps.map((step, index) => {
    const status =
      step.status === "pass"
        ? "PASS"
        : step.status === "fail"
          ? "FAIL"
          : String(step.status || "UNKNOWN").toUpperCase();
    const message = step.message ? ` (${step.message})` : "";
    return `${index + 1}. [${status}] ${step.name}${message}`;
  });

  if (compact && steps.length > visibleSteps.length) {
    lines.push(`...외 ${steps.length - visibleSteps.length}개 단계는 리포트에서 확인`);
  }

  return lines;
}

function formatPassSummary(result) {
  if (result.status !== "pass") return [];

  if (result.test_id === "TC-LOGIN-001") {
    return [
      "- 앱 재실행 후 로그인 완료 상태를 확인했습니다.",
      result.session_reused
        ? "- 기존 로그인 세션을 재사용했습니다."
        : "- 이메일/비밀번호 입력 후 홈 화면 진입을 확인했습니다."
    ];
  }

  if (result.test_id === "TC-LOGOUT-001") {
    return [
      result.session_already_logged_out
        ? "- 시작 시점에 이미 로그아웃 상태임을 확인했습니다."
        : "- 내 정보 화면에서 로그아웃 버튼과 확인 팝업을 처리했습니다.",
      "- 로그아웃 후 로그인 시작 화면 또는 로그인 안내 상태를 확인했습니다."
    ];
  }

  if (result.test_id === "TC-SEARCH-001") {
    return [
      "- 앱 재실행 후 홈 검색바를 확인했습니다.",
      "- 정확한 일정 검색 조건을 적용하고 검색 결과 목록 진입을 확인했습니다."
    ];
  }

  if (result.test_id === "TC-SEARCH-002") {
    return [
      "- 앱 재실행 후 홈 검색바를 확인했습니다.",
      "- 유연한 일정 검색 조건을 적용하고 검색 결과 목록 진입을 확인했습니다."
    ];
  }

  if (result.test_id === "TC-IOS-CONTRACT-REQUEST-001") {
    return [
      `- iOS ${result.contract_conditions?.schedule_type || "일정"} 검색 결과에서 계약 가능한 숙소 상세로 진입했습니다.`,
      "- 호스트 수락 후 직접 결제와 필수 약관 전체 동의를 선택했습니다.",
      "- 계약 요청 완료 화면의 홈으로 버튼을 누르고 홈 화면 복귀까지 확인했습니다."
    ];
  }

  if (result.test_id === "TC-IOS-CONTRACT-CANCEL-REQUEST-001") {
    return [
      "- iOS 홈의 요청 중 계약 카드와 계약 상세를 확인했습니다.",
      `- 취소 사유 '${result.cancel_conditions?.reason || "선택됨"}' 선택 후 취소 완료 화면을 확인했습니다.`,
      "- 계약 요청 취소 완료 후 앱을 종료하고 재실행해 홈 화면을 확인했습니다."
    ];
  }

  if (result.test_id === "TC-CONVERSATIONAL-SEARCH-001") {
    return [
      `- '${result.conversational_search?.scenario || "대화형 검색"}' 사용자 시나리오로 ${result.conversational_search?.turns || 0}회 대화를 진행했습니다.`,
      "- AI 답변의 요청 관련성, 이전 조건 유지, 숙소 검색 결과 노출을 확인했습니다.",
      result.conversational_search?.validation?.manual_required?.length
        ? `- 화면 구조상 조건 반영 수동 확인 필요: ${result.conversational_search.validation.manual_required.length}건`
        : "- 입력한 여행 조건이 AI 답변과 결과에 반영된 것을 확인했습니다."
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-001") {
    return [
      "- 앱 재실행 후 하단 리브후기 탭으로 진입했습니다.",
      "- 오른쪽 상단 프로필 버튼을 눌러 내 리브 후기 프로필 상세 화면을 확인했습니다.",
      `- 닉네임 '${result.review_profile?.nickname || "확인됨"}' 표시와 프로필 상세 끝까지 스크롤을 확인했습니다.`,
      `- 게시물 많은 계정 스크롤: ${result.review_profile?.checked_screens || 0}개 화면 중 ${result.review_profile?.layout_signal_screens || 0}개 화면에서 게시물/이미지/텍스트 신호를 확인했습니다.`,
      "- 구분선 동일 여부는 빈 화면/앱 오류/콘텐츠 소실 없는지 자동 확인하고, 픽셀 단위 동일 여부는 수동 확인 필요로 기록했습니다."
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-002") {
    return [
      "- 앱 재실행 후 하단 리브후기 탭으로 진입했습니다.",
      "- 오른쪽 하단 만년필 아이콘만 선택해 일정 선택 모달을 확인했습니다.",
      `- 예약/일정 목록 스크롤 후 '${result.review_schedule_select?.selected_schedule || "일정 항목"}'을 선택했습니다.`,
      result.review_schedule_select?.list_scroll_changed
        ? "- 예약/일정 목록 스크롤 중 화면 변화가 확인되었습니다."
        : "- 예약/일정 목록은 한 화면이거나 XML 기준 화면 변화가 없어 제한 검증으로 기록했습니다."
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-003") {
    return [
      "- 앱 재실행 후 하단 리브후기 탭으로 진입했습니다.",
      "- 상단 #추천 태그 선택 후 첫 번째 후기 카드를 선택했습니다.",
      "- 리브후기 상세 화면 진입과 헤더 이미지/폴백 신호를 확인했습니다.",
      `- 상세 하단 스크롤 중 ${result.review_detail?.checked_screens || 0}개 화면에서 이미지/내용 노출과 오류 문구 미노출을 확인했습니다.`
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-004") {
    return [
      "- 앱 재실행 후 하단 내 정보 탭에서 쿠폰함으로 진입했습니다.",
      `- 임의 쿠폰 '${result.coupon_box?.selected_coupon || "쿠폰"}'의 상세 다이얼로그와 확인 버튼 동작을 확인했습니다.`,
      `- 쿠폰 그리드 스크롤 중 ${result.coupon_box?.checked_screens || 0}개 화면에서 콘텐츠 유지와 앱 오류 미노출을 확인했습니다.`,
      "- 카드 정렬과 다이얼로그의 픽셀 단위 디자인 동일 여부는 수동 확인 필요로 기록했습니다."
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-005") {
    const tags = result.review_write?.selected_tags || [];
    const reviewTextStatus = result.review_write?.generated_review_text_validation === "pass"
      ? "오류 없음"
      : result.review_write?.generated_review_text_validation || "확인 필요";
    return [
      "- 앱 재실행 후 하단 계약 탭에서 리뷰 작성 가능 계약을 선택했습니다.",
      `- 별점 ${result.review_write?.rating || 3}개와 태그 ${tags.length}개(${tags.join(", ") || "선택됨"})를 선택했습니다.`,
      `- 사진 ${result.review_write?.selected_photo_count || 0}장 선택 후 간편 작성/AI 리뷰 작성 대기 흐름을 확인했습니다.`,
      `- AI 리뷰 본문 자동 검증 결과: ${reviewTextStatus} (${result.review_write?.generated_review_text_length || 0}자)`,
      "- 리뷰 제출 후 작성 완료 팝업 확인 버튼까지 처리했습니다.",
      "- 별 선택 색상, 사진 썸네일 품질, AI 문장 자연스러움은 수동 확인 필요로 기록했습니다."
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-006") {
    const keywords = result.review_edit?.changed_keywords || result.review_edit?.selected_keywords || [];
    const ratingAction = result.review_edit?.rating_action === "decrease" ? "별점 낮춤" : "별점 올림";
    const keywordAction = result.review_edit?.keyword_action === "remove" ? "키워드 제거" : "키워드 추가";
    const photoAction = result.review_edit?.photo_action === "remove" ? "사진 삭제" : "사진 추가";
    return [
      "- 앱 재실행 후 하단 계약 탭에서 내 리뷰 보기 가능 계약을 선택했습니다.",
      "- 내 리뷰 상세 더보기 메뉴에서 수정 화면으로 진입했습니다.",
      `- ${ratingAction}(${result.review_edit?.rating_before || "이전"} -> ${result.review_edit?.rating_after || "변경 후"})을 확인했습니다.`,
      `- ${keywordAction} ${keywords.length}개(${keywords.join(", ") || "변경됨"})를 확인했습니다.`,
      `- ${photoAction}을 확인했습니다. (${result.review_edit?.before_photo_count ?? "?"}장 -> ${result.review_edit?.after_photo_count ?? "?"}장)`,
      `- 리뷰 본문 끝에 '${result.review_edit?.appended_text || "임의 문구"}'를 추가했습니다.`,
      "- 하단 저장 버튼 선택 후 앱 오류 문구 미노출을 확인했습니다.",
      "- 별 선택 색상, 사진 썸네일 품질, 수정 본문 자연스러움은 수동 확인 필요로 기록했습니다."
    ];
  }

  if (result.test_id === "TC-INTERNAL-REFACTOR-007") {
    return [
      "- 앱 재실행 후 하단 계약 탭에서 내 리뷰 보기 가능 계약을 선택했습니다.",
      "- 내 리뷰 상세 더보기 메뉴에서 삭제 버튼을 선택했습니다.",
      "- '정말 리뷰를 삭제하시겠어요?' 확인 팝업과 삭제하기 버튼을 확인했습니다.",
      "- 삭제하기 버튼 선택 후 팝업이 닫히고 앱 오류 문구가 없는지 확인했습니다.",
      "- 삭제 후 계약 목록의 버튼 상태 변경은 수동 확인 필요로 기록했습니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-001") {
    const conditions = result.contract_conditions || {};
    const scheduleType = conditions.schedule_type || "일정";
    const guests = [
      `성인 ${conditions.adult_count ?? 1}`,
      `어린이 ${conditions.child_count ?? 0}`,
      `유아 ${conditions.infant_count ?? 0}`,
      `반려동물 ${conditions.pet_count ?? 0}`
    ].join(", ");
    if (result.contract_conditions?.payment_method === "호스트 수락 즉시 자동 결제") {
      return [
        `- 앱 재실행 후 ${scheduleType} 검색 결과 목록으로 진입했습니다.`,
        "- 검색 결과 목록을 더 내려 3~4번째 숙소 후보 중 하나의 상세로 이동했습니다.",
        "- 계약 요청 화면의 결제 수단 영역에서 호스트 수락 즉시 자동 결제를 선택했습니다.",
        "- 필수 약관 전체 동의 후 계약 요청 완료 화면과 홈 화면 복귀까지 확인했습니다."
      ];
    }

    return [
      `- 앱 재실행 후 ${scheduleType} 검색 결과 목록으로 진입했습니다.`,
      "- 검색 결과 목록을 더 내려 3~4번째 숙소 후보 중 하나의 상세로 이동했습니다.",
      `- ${guests} 조건으로 필수 약관 전체 동의와 계약 요청 완료 화면을 확인했습니다.`,
      "- 완료 화면의 홈으로 버튼을 눌러 홈 화면 복귀까지 확인했습니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-APPROVE-001") {
    return [
      "- 호스트 계약 관리 목록에서 계약 요청 건을 확인했습니다.",
      "- 계약 요청 상세 화면에서 계약 수락 버튼을 눌렀습니다.",
      "- 승인 후 계약 진행/결제 대기 상태를 확인했습니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-REJECT-001") {
    return [
      "- 호스트 계약 관리 목록에서 게스트 홈 카드의 숙소명/일정과 일치하는 계약 요청 건을 확인했습니다.",
      "- 계약 요청 상세 화면에서 거절 버튼을 눌렀습니다.",
      "- 게스트에게 전달할 거절 사유를 선택하고 계약 요청 거절 완료 상태를 확인했습니다.",
      "- 완료 화면에서 계약 내역 가기를 누른 뒤 상단 뒤로가기로 계약 관리 목록까지 복귀합니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-CANCEL-REQUEST-001") {
    return [
      "- 홈 화면 풀 리프레시 후 계약 요청 상태 카드를 확인했습니다.",
      "- 계약 상세 하단에서 계약 취소 버튼을 눌렀습니다.",
      `- 취소 사유 '${result.cancel_conditions?.reason || "선택됨"}' 선택 후 계약 요청 취소 완료 상태를 확인했습니다.`
    ];
  }

  if (result.test_id === "TC-CONTRACT-CANCEL-CONFIRMED-001") {
    return [
      "- 홈 화면 풀 리프레시 후 예약 확정 상태 카드를 확인했습니다.",
      "- 계약 상세 하단에서 계약 취소 버튼과 확인 팝업을 처리했습니다.",
      `- 호스트 전달 취소 사유 '${result.cancel_conditions?.reason || "선택됨"}' 선택 후 취소 내역 확인과 최종 취소 완료를 확인했습니다.`,
      "- 리브애니웨어 취소 사유 전달 화면을 닫고 홈 화면 복귀까지 확인했습니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-EXTENSION-001") {
    return [
      "- 홈 화면에서 계약 확정 상태 카드를 선택해 계약 상세로 진입했습니다.",
      "- 계약 상세에서 계약 연장 요청 버튼을 눌렀습니다.",
      "- 연장 퇴실일을 1박부터 180박 범위에서 랜덤 선택하고 확인했습니다.",
      "- 계약 연장 상세의 날짜/연장 박수와 주의사항 동의 후 연장 요청 완료 팝업까지 확인했습니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-EXTENSION-APPROVE-001") {
    return [
      "- 호스트 홈에서 연장 요청 카드를 선택해 계약 상세로 진입했습니다.",
      "- 계약 연장 요청 섹션의 확인 및 응답 버튼을 눌렀습니다.",
      result.contract_extension_approval?.validation_mode === "fast-accept"
        ? "- 계약 연장 상세 진입 후 속도 우선 모드로 하단 연장 수락을 바로 선택했습니다."
        : "- 계약 연장 상세 문구, 금액 영역, 정산 예정 금액 일치 여부를 확인했습니다.",
      "- 연장 수락과 확인 팝업, 수락 완료 팝업 처리 후 호스트 앱 재실행까지 확인했습니다."
    ];
  }

  if (result.test_id === "TC-CONTRACT-PAYMENT-001") {
    if (result.payment_conditions?.method === "무통장 입금") {
      return [
        "- 홈 화면 풀 리프레시 후 결제 대기 중 카드를 확인했습니다.",
        "- 계약 상세에서 무통장 입금 결제 수단을 선택했습니다.",
        "- 현금영수증 개인 발급 요청과 환불/보증금 반환 계좌 입력을 처리했습니다."
      ];
    }

    return [
      "- 홈 화면 풀 리프레시 후 결제 대기 중 카드를 확인했습니다.",
      "- 계약 상세에서 신용·체크카드 결제 수단과 JCB 카드 선택을 확인했습니다.",
      "- PG 결제 화면에서 카드번호, 만료일, 필수 동의, NEXT 버튼을 처리했습니다.",
      "- 결제 완료 화면의 홈으로 버튼을 눌러 홈 화면 복귀까지 확인했습니다."
    ];
  }

  if (result.test_id === "TC-TOSS-DEPOSIT-APPROVE-001") {
    return [
      "- 최근 무통장 결제 PASS 결과에서 금액/숙소명/계약번호 기준을 확인했습니다.",
      "- 토스 테스트 결제내역에서 입금대기 상태와 입금처리 버튼이 있는 행을 매칭했습니다.",
      "- 입금처리 버튼을 눌러 테스트 무통장 입금을 승인했습니다."
    ];
  }

  if (result.test_id === "TC-CONSOLE-SCHEDULE-CHANGE-001") {
    return [
      "- 콘솔 예약 상세 화면에 브라우저로 진입했습니다.",
      "- 일정 변경 영역에서 체크인/체크아웃 달력 버튼을 선택했습니다.",
      "- 계산된 변경 날짜를 선택하고 일정 변경, 다음, 변경 완료 버튼을 처리했습니다.",
      result.console_schedule_change?.final_verification === "manual_required"
        ? "- 최종 화면 날짜 반영은 자동 확정하지 못해 수동 확인 필요로 기록했습니다."
        : "- 콘솔 화면에서 변경된 일정 반영을 확인했습니다."
    ];
  }

  return [];
}

function formatAppBuild(build) {
  if (!build || build.status === "skipped") return [];

  const lines = ["앱 빌드 확인:"];
  if (build.installed_before) {
    lines.push(
      `- 단말 설치 버전: ${build.installed_before.displayVersion || "unknown"} (${build.installed_before.buildVersion || "unknown"})`
    );
  }
  if (build.latest) {
    lines.push(
      `- Firebase 최신 버전: ${build.latest.displayVersion || "unknown"} (${build.latest.buildVersion || "unknown"})`
    );
  }

  const actionMessages = {
    already_latest: "최신 빌드라 설치 없이 테스트 진행",
    installed_latest: "최신 스테이징 APK 설치 완료",
    blocked_outdated: "최신 빌드가 아니라 테스트 시작 전 중단"
  };
  if (build.action) {
    lines.push(`- 조치: ${actionMessages[build.action] || build.action}`);
  }
  if (build.installed_after) {
    lines.push(
      `- 설치 후 버전: ${build.installed_after.displayVersion || "unknown"} (${build.installed_after.buildVersion || "unknown"})`
    );
  }
  if (build.latest && build.latest.firebaseConsoleUri) {
    lines.push(`- Firebase: ${build.latest.firebaseConsoleUri}`);
  }

  return lines;
}

function formatResultConditionSummary(result) {
  const lines = [];

  if (result.search) {
    const search = result.search;
    lines.push(`- 지역: ${search.region || "-"}`);
    if (search.type === "exact" && search.start_date && search.end_date) {
      lines.push(`- 정확한 일정: ${search.start_date} ~ ${search.end_date}${search.stay_nights ? ` (${search.stay_nights}박)` : ""}`);
    } else if (search.schedule || search.label) {
      lines.push(`- 유연한 일정: ${search.schedule || search.label}${search.move_in_year ? ` (${search.move_in_year}년)` : ""}`);
    }
    lines.push(`- 인원: ${search.guests || "-"}`);
    if (search.applied_condition) lines.push(`- 검색 조건 반영: ${search.applied_condition.replace(/\n/g, " / ")}`);
    lines.push(
      Number.isFinite(search.result_count)
        ? `- 검색 결과: ${search.result_count.toLocaleString("ko-KR")}개의 집`
        : "- 검색 결과: 결과 화면 진입 확인 (집 개수 자동 추출 불가)"
    );
    lines.push(`- 첫 번째 집: ${search.first_listing || "-"}`);
    const visibleControls = [
      search.sort_visible ? "리브 추천 순" : "",
      search.filter_visible ? "필터" : "",
      search.map_visible ? "지도" : "",
      search.result_panel_visible ? "하단 검색 결과 영역" : ""
    ].filter(Boolean);
    if (visibleControls.length) lines.push(`- 결과 화면: ${visibleControls.join(" · ")} 노출 확인`);
  }

  if (result.conversational_search) {
    lines.push(`- 대화 시나리오: ${result.conversational_search.scenario || "-"}`);
    lines.push(`- 대화 횟수: ${result.conversational_search.turns || 0}회`);
    lines.push(`- 최초 요청: ${result.conversational_search.initial_prompt || "-"}`);
    lines.push(`- 숙소 결과: ${result.conversational_search.result_visible ? "확인" : "미확인"}`);
    const selected = result.conversational_search.selected_listing;
    if (selected?.detail_summary?.title || selected?.result_summary?.title) {
      lines.push(`- 선택한 집: ${selected.detail_summary.title || selected.result_summary.title}`);
    }
    if (selected?.detail_summary?.price || selected?.result_summary?.price) {
      lines.push(`- 노출 가격: ${selected.detail_summary.price || selected.result_summary.price}`);
    }
    if (selected?.condition_validation) {
      lines.push(
        `- 상세 조건 비교: 일치 ${selected.condition_validation.matched.length}건, ` +
        `불일치 ${selected.condition_validation.unmatched.length}건, ` +
        `수동 확인 ${selected.condition_validation.manual_required.length}건`
      );
    }
  }

  if (result.contract_request?.match_summary || result.contract_request?.selected_listing_title) {
    const { title, schedule, guest } = result.contract_request.match_summary || {};
    const selectedTitle = result.contract_request.selected_listing_title || title;
    if (selectedTitle) lines.push(`- 집 이름: ${selectedTitle}`);
    if (schedule) lines.push(`- 일정: ${schedule}`);
    if (guest) lines.push(`- 인원: ${guest}`);
  }

  if (result.contract_conditions) {
    const conditions = result.contract_conditions;
    if (conditions.start_date && conditions.end_date) {
      lines.push(`- 정확한 일정: ${conditions.start_date} ~ ${conditions.end_date}${conditions.stay_nights ? ` (${conditions.stay_nights}박)` : ""}`);
    }
    if (
      conditions.adult_count !== undefined ||
      conditions.child_count !== undefined ||
      conditions.infant_count !== undefined ||
      conditions.pet_count !== undefined
    ) {
      lines.push(
        `- 인원: ${[
          `성인${conditions.adult_count ?? 0}`,
          `어린이${conditions.child_count ?? 0}`,
          `유아${conditions.infant_count ?? 0}`,
          `반려동물${conditions.pet_count ?? 0}`
        ].join(", ")}`
      );
    }
    if (conditions.pet_info) {
      lines.push(`- 반려동물 정보: ${conditions.pet_info}`);
    }
    if (conditions.payment_method) {
      lines.push(`- 계약 요청 결제 방식: ${conditions.payment_method}`);
    }
  }

  if (result.search_conditions && !result.contract_conditions && !result.search) {
    const { region, schedule_type: scheduleType, start_date: startDate, end_date: endDate, stay_duration: stayDuration } = result.search_conditions;
    if (region) lines.push(`- 지역: ${region}`);
    if (startDate && endDate) {
      lines.push(`- 일정: ${startDate} ~ ${endDate}${stayDuration ? ` (${stayDuration})` : ""}`);
    } else if (scheduleType) {
      lines.push(`- 일정 방식: ${scheduleType}`);
    }
  }

  if (result.contract_request?.match_summary && !result.contract_request?.selected_listing_title) {
    const { title, schedule, guest } = result.contract_request.match_summary;
    if (title) lines.push(`- 숙소: ${title}`);
    if (schedule) lines.push(`- 일정: ${schedule}`);
    if (guest) lines.push(`- 인원: ${guest}`);
  }

  if (result.approved_contract?.contract_number) {
    lines.push(`- 승인 계약 번호: ${result.approved_contract.contract_number}`);
  }

  if (result.rejected_contract?.contract_number) {
    lines.push(`- 거절 계약 번호: ${result.rejected_contract.contract_number}`);
  }
  if (result.rejected_contract?.reason) {
    lines.push(`- 거절 사유: ${result.rejected_contract.reason}`);
  }

  if (result.payment_conditions?.method) {
    lines.push(`- 결제 방식: ${result.payment_conditions.method}`);
  }
  if (result.payment_conditions?.card_brand) {
    lines.push(`- 카드: ${result.payment_conditions.card_brand}`);
  }
  if (result.payment_conditions?.refund_bank || result.payment_conditions?.refund_account) {
    lines.push(
      `- 환불 계좌: ${[
        result.payment_conditions.refund_bank,
        result.payment_conditions.refund_account
      ].filter(Boolean).join(" ")}`
    );
  }

  if (result.contract_extension) {
    if (result.contract_extension.target_checkout_date) {
      lines.push(`- 희망 퇴실일: ${result.contract_extension.target_checkout_date}`);
    }
    if (result.contract_extension.extension_nights) {
      lines.push(`- 연장 박수: ${result.contract_extension.extension_nights}박`);
    }
  }

  if (result.figma_validation) {
    const validation = result.figma_validation;
    if (validation.status === "pass") {
      lines.push("- Figma 기준: 자동 비교 PASS");
    } else if (validation.status === "manual_required") {
      lines.push(`- Figma 기준: 자동 비교 PASS, 수동 확인 필요 ${validation.manual_required?.length || 0}건`);
    } else if (validation.status === "fail") {
      lines.push(`- Figma 기준: 불일치 ${validation.missing?.length || 0}건`);
    }
  }

  if (result.contract_extension_approval) {
    const fastExtensionApprove = result.contract_extension_approval.validation_mode === "fast-accept";
    if (!fastExtensionApprove && result.contract_extension_approval.settlement_amount) {
      lines.push(`- 연장 정산 예정: ${result.contract_extension_approval.settlement_amount}`);
    }
    if (!fastExtensionApprove && result.contract_extension_approval.guest_payment_amount) {
      lines.push(`- 게스트 결제 예정: ${result.contract_extension_approval.guest_payment_amount}`);
    }
  }

  if (result.toss_deposit) {
    if (result.toss_deposit.amount) lines.push(`- 금액: ${result.toss_deposit.amount}`);
    if (result.toss_deposit.buyer_name) lines.push(`- 구매자: ${result.toss_deposit.buyer_name}`);
    if (result.toss_deposit.product_name) lines.push(`- 상품: ${result.toss_deposit.product_name}`);
  }

  if (result.console_schedule_change) {
    lines.push(`- 예약 번호: ${result.console_schedule_change.reservation_id}`);
    lines.push(`- 변경 기준: ${result.console_schedule_change.change_label}`);
    if (result.console_schedule_change.previous_start_date && result.console_schedule_change.previous_end_date) {
      lines.push(`- 기존 일정: ${result.console_schedule_change.previous_start_date} ~ ${result.console_schedule_change.previous_end_date}`);
    }
    lines.push(`- 변경 일정: ${result.console_schedule_change.start_date} ~ ${result.console_schedule_change.end_date}`);
    if (result.console_schedule_change.nights && result.console_schedule_change.period_days) {
      lines.push(`- 기간: ${result.console_schedule_change.nights}박 ${result.console_schedule_change.period_days}일`);
    }
    const priceSummary = result.console_schedule_change.price_change_summary;
    const settlementLabels = ["호스트 추가 정산", "호스트 지불", "게스트 추가 결제", "게스트 환불"];
    const settlementLines = settlementLabels
      .filter((label) => priceSummary?.settlement?.[label])
      .map((label) => `${label}: ${priceSummary.settlement[label]}`);
    if (settlementLines.length) {
      lines.push("- 정산/가격 변경:");
      for (const line of settlementLines) {
        lines.push(`  - ${line}`);
      }
    } else if (priceSummary?.summary_lines?.length) {
      lines.push("- 정산/가격 변경:");
      for (const line of priceSummary.summary_lines.slice(0, 4)) {
        lines.push(`  - ${line}`);
      }
    } else if (priceSummary) {
      lines.push("- 정산/가격 변경: 자동 추출 불가, 콘솔 모달 수동 확인 필요");
    }
  }

  if (result.console_deposit_return) {
    lines.push(`- 예약 번호: ${result.console_deposit_return.reservation_id}`);
    lines.push(`- 처리: ${result.console_deposit_return.action}`);
    if (result.console_deposit_return.reason) {
      lines.push(`- 보류 사유: ${result.console_deposit_return.reason}`);
    }
  }

  if (result.build_install) {
    const build = result.build_install;
    const target = build.target_build || {};
    const installedBefore = build.installed_before || {};
    const installedAfter = build.installed_after || {};
    lines.push(`- 클라이언트: ${build.client === "ios" ? "iOS" : "Android"}`);
    lines.push(`- 테스터: ${build.tester_role || result.role || "-"}`);
    lines.push(`- 앱 식별자: ${build.package || build.bundle_id || "-"}`);
    lines.push(`- 설치 대상: ${target.displayVersion || "unknown"} (${target.buildVersion || "unknown"})`);
    lines.push(`- 기존 버전: ${installedBefore.displayVersion || "미설치"} (${installedBefore.buildVersion || "-"})`);
    lines.push(`- 설치 방식: ${build.action_label || build.action || "-"}`);
    if (installedAfter.displayVersion || installedAfter.buildVersion) {
      lines.push(`- 설치 직후 검증 버전: ${installedAfter.displayVersion || "unknown"} (${installedAfter.buildVersion || "unknown"})`);
    }
    if (build.verified_at) {
      lines.push(`- 설치 검증 시각: ${build.verified_at}`);
    }
  }

  if (result.review_write) {
    if (result.review_write.rating) lines.push(`- 별점: ${result.review_write.rating}개`);
    if (result.review_write.selected_tags?.length) {
      lines.push(`- 선택 태그: ${result.review_write.selected_tags.join(", ")}`);
    }
    if (result.review_write.generated_review_text_validation) {
      const status = result.review_write.generated_review_text_validation === "pass" ? "오류 없음" : "확인 필요";
      lines.push(`- 리뷰 본문: ${status} (${result.review_write.generated_review_text_length || 0}자)`);
    }
  }

  if (result.review_edit) {
    if (result.review_edit.rating_changed) {
      const ratingAction = result.review_edit.rating_action === "decrease" ? "낮춤" : "올림";
      lines.push(`- 별점: ${ratingAction} (${result.review_edit.rating_before || "이전"} -> ${result.review_edit.rating_after || "변경 후"})`);
    }
    if (result.review_edit.changed_keywords?.length || result.review_edit.selected_keywords?.length) {
      const keywordAction = result.review_edit.keyword_action === "remove" ? "제거" : "추가";
      lines.push(`- 키워드 ${keywordAction}: ${(result.review_edit.changed_keywords || result.review_edit.selected_keywords).join(", ")}`);
    }
    if (result.review_edit.photo_action) {
      const photoAction = result.review_edit.photo_action === "remove" ? "삭제" : "추가";
      lines.push(`- 사진 ${photoAction}: ${result.review_edit.before_photo_count ?? "?"}장 -> ${result.review_edit.after_photo_count ?? "?"}장`);
    }
    if (result.review_edit.appended_text) {
      lines.push(`- 추가 본문: ${result.review_edit.appended_text}`);
    }
  }

  if (result.review_delete) {
    lines.push("- 리뷰 상세: 내 리뷰 보기에서 진입");
    lines.push("- 삭제 확인 팝업: 확인");
    lines.push(result.review_delete.deleted ? "- 삭제 처리: 완료" : "- 삭제 처리: 확인 필요");
  }

  const summaryLimit = result.console_schedule_change || result.console_deposit_return || result.build_install
    ? 10
    : result.search
      ? 8
      : 6;
  return lines.slice(0, summaryLimit);
}

function formatFigmaValidationSummary(validation) {
  if (!validation) return [];
  const passCount = validation.checked?.length || 0;
  const manualCount = validation.manual_required?.length || 0;
  const failCount = validation.missing?.length || 0;

  if (validation.status === "pass") {
    return [`Figma 기준 비교: PASS ${passCount}건`];
  }

  if (validation.status === "manual_required") {
    return [`Figma 기준 비교: PASS ${passCount}건, 수동 확인 필요 ${manualCount}건`];
  }

  if (validation.status === "fail") {
    return [`Figma 기준 비교: PASS ${passCount}건, 불일치 ${failCount}건`];
  }

  return [`Figma 기준 비교: ${validation.status}`];
}

function formatFigmaValidationDetailLines(validation, { maxItems = 4 } = {}) {
  if (!validation) return [];

  const lines = [];
  if (validation.source) lines.push(`기준: ${validation.source}`);

  const checked = validation.checked || [];
  const manualRequired = validation.manual_required || [];
  const missing = validation.missing || [];

  for (const item of checked.slice(0, maxItems)) {
    lines.push(`[PASS] ${item}`);
  }
  if (checked.length > maxItems) {
    lines.push(`[PASS] 외 ${checked.length - maxItems}건은 대시보드에서 확인`);
  }

  for (const item of manualRequired.slice(0, maxItems)) {
    lines.push(`[수동 확인 필요] ${item}`);
  }
  if (manualRequired.length > maxItems) {
    lines.push(`[수동 확인 필요] 외 ${manualRequired.length - maxItems}건은 대시보드에서 확인`);
  }

  for (const item of missing.slice(0, maxItems)) {
    lines.push(`[FAIL] ${item}`);
  }
  if (missing.length > maxItems) {
    lines.push(`[FAIL] 외 ${missing.length - maxItems}건은 대시보드에서 확인`);
  }

  if (validation.amounts?.length) {
    lines.push(`[참고] 화면에서 확인한 금액: ${validation.amounts.join(", ")}`);
  }

  return lines;
}

function formatLastProgress(steps = []) {
  if (!steps.length) return [];
  const recent = steps.slice(-4);
  return recent.map((step) => {
    const message = step.message ? ` (${step.message})` : "";
    return `- ${step.name}${message}`;
  });
}

function formatCompactDetails(details = []) {
  return details
    .filter(Boolean)
    .slice(0, 3)
    .map((detail) => `- ${detail}`);
}

function formatDuration(ms = 0) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

function formatRequester(result) {
  return result.requested_by ? `<@${result.requested_by}>` : "-";
}

function getLastStep(steps = []) {
  return steps.length ? steps[steps.length - 1] : null;
}

function getLastPassedStep(steps = []) {
  return [...steps].reverse().find((step) => step.status === "pass") || null;
}

function formatStepLabel(step) {
  if (!step) return "-";
  return `${step.name}${step.message ? ` (${step.message})` : ""}`;
}

function classifyFailure(result) {
  const message = [
    result.error,
    ...(result.error_details || [])
  ].join(" ");

  if (/adb: device .* not found|device .* not found|offline|unauthorized/i.test(message)) {
    return "단말/ADB 연결 상태를 먼저 확인해야 합니다.";
  }
  if (/로그인|세션|login|호스트모드|홈 화면/.test(message)) {
    return "계정 세션 또는 앱 시작 화면 상태를 먼저 확인해야 합니다.";
  }
  if (/일시적인 오류|잠시 후 다시 시도|앱 오류|오류 메시지/.test(message)) {
    return "앱 또는 서버에서 노출한 오류 가능성이 큽니다.";
  }
  if (/HTTP|API|예약이 불가능|response|request/i.test(message)) {
    return "API 응답, 테스트 데이터, 예약 가능 조건을 확인해야 합니다.";
  }
  if (/찾지 못|확인하지 못|버튼|카드|팝업|화면|좌표|탭/.test(message)) {
    return "화면 상태 변화 또는 자동화 selector/탭 좌표를 확인해야 합니다.";
  }
  return "리포트의 마지막 화면과 로그를 기준으로 원인을 확인해야 합니다.";
}

function formatFailConclusion(result) {
  const lastStep = getLastStep(result.steps || []);
  const base = result.error || "실패 원인을 확인하지 못했습니다.";
  if (!lastStep) return base;
  return `${formatStepLabel(lastStep)} 단계 이후 실패했습니다. ${base}`;
}

function formatPassConclusion(result) {
  const summary = formatPassSummary(result);
  if (summary.length) return summary[0].replace(/^- /, "");
  return "요청한 자동화 시나리오가 PASS 기준까지 완료되었습니다.";
}

function buildResultJudgment(result) {
  const status = String(result.status || "unknown").toUpperCase();
  const passSummary = formatPassSummary(result).map((line) => line.replace(/^- /, ""));
  const figmaSummary = formatFigmaValidationSummary(result.figma_validation);
  const conditionLimit = result.test_id === "TC-CONSOLE-SCHEDULE-CHANGE-001" ||
    result.test_id === "TC-CONSOLE-DEPOSIT-RETURN-001" ||
    result.test_id === "TC-BUILD-INSTALL-001"
    ? 10
    : 8;
  const resultConditionSummary = formatResultConditionSummary(result);
  const genericConditionSummary = [
    ...formatSearchConditions(result.search_conditions).slice(0, 3),
    ...formatSearchConditions(result.contract_conditions).slice(0, 3)
  ];
  const conditionSummary = [
    ...resultConditionSummary,
    ...(resultConditionSummary.length ? [] : genericConditionSummary)
  ].slice(0, conditionLimit);
  const lastPassed = getLastPassedStep(result.steps || []);
  const lastStep = getLastStep(result.steps || []);
  const details = (result.error_details || []).filter(Boolean).slice(0, 3);

  return {
    status,
    requester: formatRequester(result),
    command: result.source === "slack-prerequisite" ? "사전 확인" : "슬랙 명령 실행",
    title: result.name || result.test_id || "QA 자동화",
    runId: result.run_id || "-",
    env: result.env || "-",
    device: result.device || "-",
    duration: formatDuration(result.duration_ms),
    conclusion: result.status === "pass" ? formatPassConclusion(result) : formatFailConclusion(result),
    verified: [...figmaSummary, ...passSummary].slice(0, 4),
    conditions: conditionSummary,
    failedStep: result.status === "fail" ? result.failed_step || "runner" : "",
    lastPassed: result.status === "fail" ? formatStepLabel(lastPassed) : "",
    lastProgress: result.status === "fail" ? formatStepLabel(lastStep) : "",
    failureReason: result.status === "fail" ? result.error || "unknown" : "",
    suspectedArea: result.status === "fail" ? classifyFailure(result) : "",
    nextChecks: result.status === "fail"
      ? [
        ...details,
        result.artifacts?.report_dir ? "대시보드에서 실패 화면과 로그를 함께 확인해주세요." : ""
      ].filter(Boolean).slice(0, 4)
      : [],
    reportDir: result.artifacts?.report_dir || ""
  };
}

function formatJudgmentLines(result) {
  if (result.test_id === "TC-CONSOLE-SCHEDULE-CHANGE-001") {
    const judgment = buildResultJudgment(result);
    if (result.status === "pass") {
      const lines = [`[검증 완료] ${judgment.title} (${judgment.env})`];
      if (judgment.conditions.length) {
        lines.push("");
        lines.push("주요 조건:");
        lines.push(...judgment.conditions);
      }
      return lines;
    }

    const titlePrefix = result.status === "pass" ? "[검증 완료]" : `[${judgment.status}]`;
    const lines = [
      `${titlePrefix} ${judgment.title}`,
      `요청자: ${judgment.requester} / 환경: ${judgment.env} / 소요시간: ${judgment.duration}`,
      `run_id: ${judgment.runId}`
    ];

    if (judgment.conditions.length) {
      lines.push("");
      lines.push("주요 조건:");
      lines.push(...judgment.conditions);
    }

    if (result.status === "fail") {
      lines.push("");
      lines.push("실패 요약:");
      lines.push(`- ${judgment.conclusion}`);
      if (judgment.lastPassed && judgment.lastPassed !== "-") lines.push(`- 마지막 성공: ${judgment.lastPassed}`);
      if (judgment.lastProgress && judgment.lastProgress !== "-") lines.push(`- 마지막 진행: ${judgment.lastProgress}`);
      if (judgment.nextChecks.length) {
        lines.push("");
        lines.push("다음 확인:");
        lines.push(...judgment.nextChecks.map((line) => `- ${line}`));
      }
    }

    return lines;
  }

  const judgment = buildResultJudgment(result);
  if (result.status === "pass") {
    const figmaDetailLines = formatFigmaValidationDetailLines(result.figma_validation, { maxItems: 3 });
    const conditionLines = [
      ...judgment.conditions,
      ...figmaDetailLines.map((line) => line.replace(/^- /, ""))
    ];
    const lines = [`[검증 완료] ${judgment.title} (${judgment.env})`];

    lines.push("");
    lines.push("검증 항목:");
    if (conditionLines.length) {
      lines.push(...conditionLines.map((line) => line.startsWith("- ") ? line : `- ${line}`));
    } else {
      lines.push(`- ${judgment.conclusion}`);
    }

    return lines;
  }

  const titlePrefix = result.status === "pass" ? "[검증 완료]" : `[${judgment.status}]`;
  const lines = [
    `${titlePrefix} ${judgment.title}`,
    `요청자: ${judgment.requester} / 환경: ${judgment.env} / 디바이스: ${judgment.device} / 소요시간: ${judgment.duration}`,
    `run_id: ${judgment.runId}`
  ];

  lines.push("");
  lines.push(`판정: ${judgment.conclusion}`);
  lines.push("");
  lines.push("실패 요약:");
  lines.push(`- 실패 위치: ${judgment.failedStep}`);
  lines.push(`- 마지막 성공: ${judgment.lastPassed}`);
  lines.push(`- 마지막 진행: ${judgment.lastProgress}`);
  lines.push(`- 의심 영역: ${judgment.suspectedArea}`);

  if (judgment.conditions.length) {
    lines.push("");
    lines.push("주요 조건:");
    lines.push(...judgment.conditions);
  }

  if (judgment.nextChecks.length) {
    lines.push("");
    lines.push("다음 확인:");
    lines.push(...judgment.nextChecks.map((line) => `- ${line}`));
  }

  if (result.app_warnings && result.app_warnings.length > 0) {
    lines.push("");
    lines.push("부가 이슈:");
    for (const warning of result.app_warnings.slice(0, 2)) {
      lines.push(`- ${warning.name}: ${warning.message}`);
    }
  }

  if (result.security_checks && result.security_checks.length > 0) {
    const failedSecurity = result.security_checks.filter((check) => check.status === "fail");
    if (failedSecurity.length) {
      lines.push("");
      lines.push("보안 확인 이슈:");
      for (const check of failedSecurity.slice(0, 3)) {
        lines.push(`- ${check.name}`);
      }
    }
  }

  return lines;
}

function formatResult(result) {
  const lines = formatJudgmentLines(result);

  const appBuild = formatAppBuild(result.app_build);
  if (result.status !== "pass" && appBuild.length > 0) lines.splice(Math.min(4, lines.length), 0, "", ...appBuild);

  if (result.status !== "pass" && result.session_reused) {
    lines.push("");
    lines.push("로그인 방식: 기존 로그인 세션 사용");
  }

  if (result.status !== "pass" && result.session_already_logged_out) {
    lines.push("");
    lines.push("로그아웃 방식: 이미 로그아웃된 상태");
  }

  if (result.status !== "pass" && result.security_checks && result.security_checks.length > 0) {
    const hasSecuritySection = lines.includes("보안 확인 이슈:");
    if (!hasSecuritySection) {
      lines.push("");
      lines.push("로그인 보안 확인:");
      for (const check of result.security_checks) {
        const status =
          check.status === "pass"
            ? "PASS"
            : check.status === "fail"
              ? "FAIL"
              : "NOT TESTED";
        lines.push(`[${status}] ${check.name}`);
      }
    }
  }

  return lines.join("\n");
}

module.exports = {
  buildResultJudgment,
  formatFigmaValidationDetailLines,
  formatHelp,
  formatJudgmentLines,
  formatPassSummary,
  formatResult
};
