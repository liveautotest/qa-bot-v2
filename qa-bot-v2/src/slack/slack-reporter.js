function formatHelp() {
  return [
    "사용 가능한 QA 명령어",
    "",
    "환경 선택",
    "- 명령어 뒤에 dev 또는 stg를 붙일 수 있습니다.",
    "- 생략하면 stg로 실행됩니다.",
    "",
    "자주 쓰는 명령어",
    "!게스트 로그인 stg",
    "!게스트 로그인 dev",
    "!게스트 로그아웃 stg",
    "!게스트 로그아웃 dev",
    "!게스트 정확한일정 검색 stg",
    "!게스트 정확한일정 검색 dev",
    "!게스트 유연한일정 검색 stg",
    "!게스트 유연한일정 검색 dev",
    "!게스트 계약 요청 stg",
    "!게스트 계약 요청 dev",
    "!게스트 계약 요청 취소 stg",
    "!게스트 계약 요청 취소 dev",
    "!게스트 계약 확정 취소 stg",
    "!게스트 계약 확정 취소 dev",
    "!게스트 계약 결제 일반카드 stg",
    "!게스트 계약 결제 일반카드 dev",
    "!게스트 계약 결제 자동카드 stg",
    "!게스트 계약 결제 자동카드 dev",
    "!게스트 계약 결제 무통장 stg",
    "!게스트 계약 결제 무통장 dev",
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
    "!qa login env=staging role=guest",
    "!qa login env=staging role=host",
    "!qa logout env=staging role=guest",
    "!qa logout env=staging role=host",
    "!qa search env=staging role=guest",
    "!qa search-flexible env=staging role=guest",
    "!qa contract-request env=staging role=guest",
    "!qa contract-request env=staging role=guest method=auto-card",
    "!qa contract-cancel-request env=staging role=guest",
    "!qa contract-cancel-confirmed env=staging role=guest",
    "!qa contract-payment env=staging role=guest method=card",
    "!qa contract-payment env=staging role=guest method=auto-card",
    "!qa contract-payment env=staging role=guest method=bank-transfer",
    "!qa contract-approve env=staging role=host",
    "!qa contract-reject env=staging role=host"
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

  if (result.test_id === "TC-CONTRACT-001") {
    if (result.contract_conditions?.payment_method === "호스트 수락 즉시 자동 결제") {
      return [
        "- 앱 재실행 후 정확한 일정 검색 결과 목록으로 진입했습니다.",
        "- 검색 결과 첫 번째 숙소 상세에서 계약 조건 확인 화면으로 이동했습니다.",
        "- 계약 요청 화면의 결제 수단 영역에서 호스트 수락 즉시 자동 결제를 선택했습니다.",
        "- 필수 약관 전체 동의 후 계약 요청 완료 화면과 홈 화면 복귀까지 확인했습니다."
      ];
    }

    return [
      "- 앱 재실행 후 정확한 일정 검색 결과 목록으로 진입했습니다.",
      "- 검색 결과 첫 번째 숙소 상세에서 계약 조건 확인 화면으로 이동했습니다.",
      "- 기본 성인 1명 조건으로 필수 약관 전체 동의와 계약 요청 완료 화면을 확인했습니다.",
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

function formatResult(result) {
  const icon = result.status === "pass" ? "PASS" : "FAIL";
  const lines = [
    `[${icon}] [${result.test_id}] ${result.name}`,
    "",
    `run_id: ${result.run_id}`,
    `환경: ${result.env}`,
    `디바이스: ${result.device || "unknown"}`,
    `소요시간: ${result.duration_ms}ms`
  ];

  const passSummary = formatPassSummary(result);
  if (passSummary.length > 0) {
    lines.push("");
    lines.push("검증 요약:");
    lines.push(...passSummary);
  }

  const appBuild = formatAppBuild(result.app_build);
  if (appBuild.length > 0) {
    lines.push("");
    lines.push(...appBuild);
  }

  const searchConditions = formatSearchConditions(result.search_conditions);
  if (searchConditions.length > 0) {
    lines.push("");
    lines.push("검색 조건:");
    lines.push(...searchConditions);
  }

  const contractConditions = formatSearchConditions(result.contract_conditions);
  if (contractConditions.length > 0) {
    lines.push("");
    lines.push("계약 요청 조건:");
    lines.push(...contractConditions);
  }

  if (result.contract_request && result.contract_request.contract_number) {
    lines.push("");
    lines.push("계약 요청:");
    lines.push(`- 계약 번호: ${result.contract_request.contract_number}`);
  }

  if (result.contract_request && result.contract_request.match_summary) {
    lines.push("");
    lines.push("계약 요청 카드 기준:");
    if (result.contract_request.match_summary.title) {
      lines.push(`- 숙소: ${result.contract_request.match_summary.title}`);
    }
    if (result.contract_request.match_summary.schedule) {
      lines.push(`- 일정: ${result.contract_request.match_summary.schedule}`);
    }
    if (result.contract_request.match_summary.guest) {
      lines.push(`- 인원: ${result.contract_request.match_summary.guest}`);
    }
  }

  if (result.approved_contract && result.approved_contract.contract_number) {
    lines.push("");
    lines.push("승인 계약:");
    lines.push(`- 계약 번호: ${result.approved_contract.contract_number}`);
  }

  if (result.rejected_contract && result.rejected_contract.contract_number) {
    lines.push("");
    lines.push("거절 계약:");
    lines.push(`- 계약 번호: ${result.rejected_contract.contract_number}`);
  }

  if (result.rejected_contract && result.rejected_contract.match_summary) {
    if (!result.rejected_contract.contract_number) {
      lines.push("");
      lines.push("거절 계약:");
    }
    if (result.rejected_contract.match_summary.title) {
      lines.push(`- 매칭 숙소: ${result.rejected_contract.match_summary.title}`);
    }
    if (result.rejected_contract.match_summary.schedule) {
      lines.push(`- 매칭 일정: ${result.rejected_contract.match_summary.schedule}`);
    }
  }

  if (result.rejected_contract && result.rejected_contract.reason) {
    if (!result.rejected_contract.contract_number && !result.rejected_contract.match_summary) {
      lines.push("");
      lines.push("거절 계약:");
    }
    lines.push(`- 거절 사유: ${result.rejected_contract.reason}`);
  }

  if (result.payment_conditions) {
    lines.push("");
    lines.push("결제 조건:");
    if (result.payment_conditions.method) {
      lines.push(`- 결제 방식: ${result.payment_conditions.method}`);
    }
    if (result.payment_conditions.card_brand) {
      lines.push(`- 카드 브랜드: ${result.payment_conditions.card_brand}`);
    }
    if (result.payment_conditions.card_number) {
      lines.push(`- 카드 번호: ${result.payment_conditions.card_number}`);
    }
    if (result.payment_conditions.expiry) {
      lines.push(`- 만료일: ${result.payment_conditions.expiry}`);
    }
    if (result.payment_conditions.cash_receipt_type) {
      lines.push(`- 현금영수증: ${result.payment_conditions.cash_receipt_type}`);
    }
    if (result.payment_conditions.cash_receipt_phone) {
      lines.push(`- 현금영수증 휴대폰: ${result.payment_conditions.cash_receipt_phone}`);
    }
    if (result.payment_conditions.refund_bank) {
      lines.push(`- 환불/보증금 반환 은행: ${result.payment_conditions.refund_bank}`);
    }
    if (result.payment_conditions.refund_account) {
      lines.push(`- 환불/보증금 반환 계좌: ${result.payment_conditions.refund_account}`);
    }
  }

  if (result.app_warnings && result.app_warnings.length > 0) {
    lines.push("");
    lines.push("기타 이슈:");
    for (const warning of result.app_warnings) {
      lines.push(`- ${warning.name}: ${warning.message}`);
      if (warning.details && warning.details.length > 0) {
        for (const detail of warning.details) {
          lines.push(`  - ${detail}`);
        }
      }
      if (warning.log) {
        lines.push(`  - 로그: ${warning.log}`);
      }
    }
  }

  if (result.session_reused) {
    lines.push("로그인 방식: 기존 로그인 세션 사용");
  }

  if (result.session_already_logged_out) {
    lines.push("로그아웃 방식: 이미 로그아웃된 상태");
  }

  if (result.status === "fail") {
    lines.push(`실패 단계: ${result.failed_step || "unknown"}`);
    lines.push(`에러: ${result.error || "unknown"}`);
    if (result.error_details && result.error_details.length > 0) {
      lines.push("확인할 내용:");
      for (const detail of result.error_details) {
        lines.push(`- ${detail}`);
      }
    }
  }

  const stepSummary = formatStepSummary(result.steps, {
    compact: result.status === "pass"
  });
  if (stepSummary.length > 0) {
    lines.push("");
    lines.push("실행 단계:");
    lines.push(...stepSummary);
  }

  if (result.security_checks && result.security_checks.length > 0) {
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

  if (result.artifacts && result.artifacts.report_dir) {
    lines.push(`리포트: ${result.artifacts.report_dir}`);
  }

  return lines.join("\n");
}

module.exports = {
  formatHelp,
  formatResult
};
