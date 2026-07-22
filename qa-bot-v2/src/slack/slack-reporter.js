function formatHelp() {
  return [
    "사용 가능한 QA 명령어",
    "",
    "자주 쓰는 명령어",
    "!게스트 로그인",
    "!게스트 로그아웃",
    "!게스트 집검색",
    "!게스트 정확한일정 검색",
    "!게스트 유연한일정 검색",
    "!게스트 계약 요청",
    "!호스트 로그인",
    "!호스트 로그아웃",
    "",
    "상세 명령어",
    "!qa help",
    "!qa login env=staging role=guest",
    "!qa login env=staging role=host",
    "!qa logout env=staging role=guest",
    "!qa logout env=staging role=host",
    "!qa search env=staging role=guest",
    "!qa search-flexible env=staging role=guest",
    "!qa contract-request env=staging role=guest"
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
    pet_info: "반려동물 정보"
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
    return [
      "- 앱 재실행 후 정확한 일정 검색 결과 목록으로 진입했습니다.",
      "- 임의 숙소 상세에서 계약 조건 확인 화면으로 이동했습니다.",
      "- 반려동물 정보 입력, 필수 약관 전체 동의, 계약 요청 완료 화면을 확인했습니다.",
      "- 완료 화면의 홈으로 버튼을 눌러 홈 화면 복귀까지 확인했습니다."
    ];
  }

  return [];
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
