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
    "!기본검증 연장결제 카드 stg",
    "!기본검증 연장결제 카드 dev",
    "!기본검증 연장결제 무통장 stg",
    "!기본검증 연장결제 무통장 dev",
    "!게스트 로그인 stg",
    "!게스트 로그인 dev",
    "!게스트 로그아웃 stg",
    "!게스트 로그아웃 dev",
    "!게스트 검색 정확한일정 stg",
    "!게스트 검색 정확한일정 dev",
    "!게스트 검색 유연한일정 stg",
    "!게스트 검색 유연한일정 dev",
    "!게스트 계약 요청 stg (PASS 시 호스트 계약 승인 자동 실행)",
    "!게스트 계약 요청 dev (PASS 시 호스트 계약 승인 자동 실행)",
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
    "!146183 계약 변경 일주일 전",
    "!146183 계약 변경 2주일전",
    "!146183 계약 변경 한달전",
    "!146183 계약 변경 일주일 후",
    "!146183 계약 변경 2주 후",
    "!146183 계약 변경 한달 후",
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
    "!qa contract-extension env=staging role=guest",
    "!qa contract-payment env=staging role=guest method=extension-card",
    "!qa contract-payment env=staging role=guest method=extension-bank-transfer",
    "!qa contract-payment env=staging role=guest method=card",
    "!qa contract-payment env=staging role=guest method=auto-card",
    "!qa contract-payment env=staging role=guest method=bank-transfer (PASS 시 무통장 입금 승인 자동 실행)",
    "!qa contract-approve env=staging role=host",
    "!qa contract-reject env=staging role=host",
    "!qa schedule-change reservation_id=146183 offset=일주일후",
    "!qa toss-deposit-approve"
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

  if (result.test_id === "TC-SCHEDULE-CHANGE-001") {
    return [
      "- 현재 날짜 기준으로 변경할 계약 기간을 계산했습니다.",
      "- 날짜만 변경하는 예약 일정 변경 API를 호출했습니다.",
      "- API 응답이 성공 상태인지 확인했습니다. 앱 새로고침 후 계약 기간 반영 여부를 확인할 수 있습니다.",
      "- 이 명령은 세부가격/총결제금액 재계산 검증은 하지 않습니다."
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

  if (result.contract_request?.match_summary) {
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

  if (result.contract_extension_approval) {
    const fastExtensionApprove = result.contract_extension_approval.validation_mode === "fast-accept";
    if (!fastExtensionApprove && result.contract_extension_approval.settlement_amount) {
      lines.push(`- 연장 정산 예정: ${result.contract_extension_approval.settlement_amount}`);
    }
    if (!fastExtensionApprove && result.contract_extension_approval.guest_payment_amount) {
      lines.push(`- 게스트 결제 예정: ${result.contract_extension_approval.guest_payment_amount}`);
    }
  }

  if (result.schedule_change) {
    lines.push(`- 예약 번호: ${result.schedule_change.reservation_id}`);
    lines.push(`- 변경 기간: ${result.schedule_change.start_date} ~ ${result.schedule_change.end_date}`);
    lines.push(
      result.schedule_change.applies_price_recalculation
        ? "- 반영 범위: 날짜/금액 재계산"
        : "- 반영 범위: 날짜 변경만, 금액 재계산 없음"
    );
  }

  if (result.toss_deposit) {
    if (result.toss_deposit.amount) lines.push(`- 금액: ${result.toss_deposit.amount}`);
    if (result.toss_deposit.buyer_name) lines.push(`- 구매자: ${result.toss_deposit.buyer_name}`);
    if (result.toss_deposit.product_name) lines.push(`- 상품: ${result.toss_deposit.product_name}`);
  }

  return lines.slice(0, 6);
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
  const conditionSummary = [
    ...formatSearchConditions(result.search_conditions).slice(0, 3),
    ...formatSearchConditions(result.contract_conditions).slice(0, 3),
    ...formatResultConditionSummary(result)
  ].slice(0, 6);
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
    verified: passSummary.slice(0, 3),
    conditions: conditionSummary,
    failedStep: result.status === "fail" ? result.failed_step || "runner" : "",
    lastPassed: result.status === "fail" ? formatStepLabel(lastPassed) : "",
    lastProgress: result.status === "fail" ? formatStepLabel(lastStep) : "",
    failureReason: result.status === "fail" ? result.error || "unknown" : "",
    suspectedArea: result.status === "fail" ? classifyFailure(result) : "",
    nextChecks: result.status === "fail"
      ? [
        ...details,
        result.artifacts?.report_dir ? "PDF 리포트와 실패 화면/로그를 함께 확인해주세요." : ""
      ].filter(Boolean).slice(0, 4)
      : [],
    reportDir: result.artifacts?.report_dir || ""
  };
}

function formatJudgmentLines(result) {
  const judgment = buildResultJudgment(result);
  const lines = [
    `[${judgment.status}] ${judgment.title}`,
    `요청자: ${judgment.requester} / 환경: ${judgment.env} / 디바이스: ${judgment.device} / 소요시간: ${judgment.duration}`,
    `run_id: ${judgment.runId}`,
    "",
    `판정: ${judgment.conclusion}`
  ];

  if (result.status === "pass") {
    if (judgment.verified.length) {
      lines.push("");
      lines.push("검증 완료:");
      lines.push(...judgment.verified.slice(0, 3).map((line) => `- ${line}`));
    }
    if (judgment.conditions.length) {
      lines.push("");
      lines.push("주요 조건:");
      lines.push(...judgment.conditions);
    }
  } else {
    lines.push("");
    lines.push("실패 요약:");
    lines.push(`- 실패 위치: ${judgment.failedStep}`);
    lines.push(`- 마지막 성공: ${judgment.lastPassed}`);
    lines.push(`- 마지막 진행: ${judgment.lastProgress}`);
    lines.push(`- 의심 영역: ${judgment.suspectedArea}`);

    if (judgment.nextChecks.length) {
      lines.push("");
      lines.push("다음 확인:");
      lines.push(...judgment.nextChecks.map((line) => `- ${line}`));
    }
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

  if (judgment.reportDir) {
    lines.push("");
    lines.push(`리포트: ${judgment.reportDir}`);
  }

  return lines;
}

function formatResult(result) {
  const lines = formatJudgmentLines(result);

  const appBuild = formatAppBuild(result.app_build);
  if (appBuild.length > 0) lines.splice(Math.min(4, lines.length), 0, "", ...appBuild);

  if (result.session_reused) {
    lines.push("");
    lines.push("로그인 방식: 기존 로그인 세션 사용");
  }

  if (result.session_already_logged_out) {
    lines.push("");
    lines.push("로그아웃 방식: 이미 로그아웃된 상태");
  }

  if (result.security_checks && result.security_checks.length > 0) {
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
  formatHelp,
  formatJudgmentLines,
  formatPassSummary,
  formatResult
};
