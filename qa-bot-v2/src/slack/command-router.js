const { runTest } = require("../orchestrator/run-test");
const { buildResultJudgment, formatHelp, formatResult } = require("./slack-reporter");

const KOREAN_SHORTCUT_PATTERN =
  /^!(게스트|계스트|호스트)\s+(로그인|로그아웃|집검색|집 검색|검색 정확한일정|검색 정확한 일정|검색 유연한일정|검색 유연한 일정|정확한일정 검색|정확한 일정 검색|유연한일정 검색|유연한 일정 검색|리브후기 프로필|리브 후기 프로필|리브후기 일정선택|리브후기 일정 선택|리브 후기 일정선택|리브 후기 일정 선택|리브후기 상세|리브 후기 상세|리뷰작성|리뷰 작성|리뷰수정|리뷰 수정|리뷰삭제|리뷰 삭제|쿠폰함|쿠폰 함|계약요청|계약 요청|계약요청취소|계약 요청 취소|계약확정취소|계약 확정 취소|예약확정취소|예약 확정 취소|연장요청|연장 요청|계약연장|계약 연장|연장결제|연장 결제|계약연장결제|계약 연장 결제|연장수락|연장 수락|연장승인|연장 승인|계약연장수락|계약 연장 수락|계약연장승인|계약 연장 승인|계약승인|계약 승인|계약요청거절|계약 요청 거절|계약결제|계약 결제)(?:\s+(일반카드|카드|무통장|자동카드))?(?:\s+(dev|stg|staging))?$/i;

const TOSS_DEPOSIT_APPROVE_PATTERN = /^!무통장\s+입금\s+승인$/i;
const CONSOLE_SCHEDULE_CHANGE_PATTERN =
  /^\s*![\s\u200b\u200c\u200d\ufeff]*일정변경\s+(\d+)\s+((?:일|1|2)주일|한\s*달|한달|1개월)\s*(전|후)\s+(dev|stg|staging)\s*$/i;
const BASIC_VALIDATION_PATTERN =
  /^\s*![\s\u200b\u200c\u200d\ufeff]*기본검증\s+(일반결제|일반\s*결제|무통장결제|무통장\s*결제|자동결제|자동\s*결제|연장결제|연장\s*결제)(?:\s+(카드|무통장))?(?:\s+(dev|stg|staging))?\s*$/i;

function parseKeyValues(parts) {
  const values = {};
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key && value) values[key] = value;
  }
  return values;
}

function parseKoreanShortcut(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const match = normalized.match(KOREAN_SHORTCUT_PATTERN);
  if (!match) return null;

  const testByCommand = {
    로그인: "login",
    로그아웃: "logout",
    집검색: "search",
    "집 검색": "search",
    "검색 정확한일정": "search",
    "검색 정확한 일정": "search",
    "정확한일정 검색": "search",
    "정확한 일정 검색": "search",
    "검색 유연한일정": "search-flexible",
    "검색 유연한 일정": "search-flexible",
    "유연한일정 검색": "search-flexible",
    "유연한 일정 검색": "search-flexible",
    "리브후기 프로필": "review-profile",
    "리브 후기 프로필": "review-profile",
    "리브후기 일정선택": "review-schedule-select",
    "리브후기 일정 선택": "review-schedule-select",
    "리브 후기 일정선택": "review-schedule-select",
    "리브 후기 일정 선택": "review-schedule-select",
    "리브후기 상세": "review-detail",
    "리브 후기 상세": "review-detail",
    리뷰작성: "review-write",
    "리뷰 작성": "review-write",
    리뷰수정: "review-edit",
    "리뷰 수정": "review-edit",
    리뷰삭제: "review-delete",
    "리뷰 삭제": "review-delete",
    쿠폰함: "coupon-box",
    "쿠폰 함": "coupon-box",
    계약요청: "contract-request",
    "계약 요청": "contract-request",
    계약요청취소: "contract-cancel-request",
    "계약 요청 취소": "contract-cancel-request",
    계약확정취소: "contract-cancel-confirmed",
    "계약 확정 취소": "contract-cancel-confirmed",
    예약확정취소: "contract-cancel-confirmed",
    "예약 확정 취소": "contract-cancel-confirmed",
    연장요청: "contract-extension",
    "연장 요청": "contract-extension",
    계약연장: "contract-extension",
    "계약 연장": "contract-extension",
    연장결제: "contract-payment",
    "연장 결제": "contract-payment",
    계약연장결제: "contract-payment",
    "계약 연장 결제": "contract-payment",
    연장수락: "contract-extension-approve",
    "연장 수락": "contract-extension-approve",
    연장승인: "contract-extension-approve",
    "연장 승인": "contract-extension-approve",
    계약연장수락: "contract-extension-approve",
    "계약 연장 수락": "contract-extension-approve",
    계약연장승인: "contract-extension-approve",
    "계약 연장 승인": "contract-extension-approve",
    계약승인: "contract-approve",
    "계약 승인": "contract-approve",
    계약요청거절: "contract-reject",
    "계약 요청 거절": "contract-reject",
    계약결제: "contract-payment",
    "계약 결제": "contract-payment"
  };
  const envByShortcut = {
    dev: "dev",
    stg: "staging",
    staging: "staging"
  };
  const paymentMethodByShortcut = {
    일반카드: "card",
    카드: "card",
    무통장: "bank-transfer",
    자동카드: "auto-card"
  };
  const paymentMethod = paymentMethodByShortcut[match[3]];
  const isExtensionPayment = ["연장결제", "연장 결제", "계약연장결제", "계약 연장 결제"].includes(match[2]);
  const test = paymentMethod === "auto-card"
    ? "contract-request"
    : testByCommand[match[2]];
  const role = roleForShortcut(test, match[1]);

  return {
    test,
    role,
    env: envByShortcut[String(match[4] || "stg").toLowerCase()],
    payment_method: isExtensionPayment
      ? paymentMethod === "bank-transfer" ? "extension-bank-transfer" : "extension-card"
      : paymentMethod,
    skip_fresh_launch: isExtensionPayment ? true : undefined
  };
}

function parseBasicValidation(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const match = normalized.match(BASIC_VALIDATION_PATTERN);
  if (!match) return null;

  const envByShortcut = {
    dev: "dev",
    stg: "staging",
    staging: "staging"
  };

  const methodByShortcut = {
    일반결제: "card",
    "일반 결제": "card",
    무통장결제: "bank-transfer",
    "무통장 결제": "bank-transfer",
    자동결제: "auto-card",
    "자동 결제": "auto-card",
    연장결제: "extension-card",
    "연장 결제": "extension-card",
    "연장결제 카드": "extension-card",
    "연장 결제 카드": "extension-card",
    "연장결제 무통장": "extension-bank-transfer",
    "연장 결제 무통장": "extension-bank-transfer"
  };

  const methodLabel = match[1].replace(/\s+/g, " ").trim();
  const detailLabel = match[2] ? match[2].replace(/\s+/g, " ").trim() : "";
  const isExtensionPayment = methodLabel === "연장결제" || methodLabel === "연장 결제";

  return {
    env: envByShortcut[String(match[3] || "stg").toLowerCase()],
    payment_method: isExtensionPayment
      ? detailLabel === "무통장" ? "extension-bank-transfer" : "extension-card"
      : methodByShortcut[methodLabel] || "card"
  };
}

function parseConsoleScheduleChange(text) {
  const normalized = text.trim().replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\s+/g, " ");
  const match = normalized.match(CONSOLE_SCHEDULE_CHANGE_PATTERN);
  if (!match) return null;

  const envByShortcut = {
    dev: "dev",
    stg: "staging",
    staging: "staging"
  };
  const amount = match[2].replace(/\s+/g, "");
  const label = `${amount === "1주일" ? "일주일" : amount} ${match[3]}`;

  return {
    test: "console-schedule-change",
    env: envByShortcut[String(match[4] || "stg").toLowerCase()],
    role: "admin",
    reservation_id: match[1],
    schedule_shift_label: label,
    skip_app_build_check: true
  };
}

function roleForShortcut(test, requestedRoleLabel) {
  if (test === "contract-approve" || test === "contract-reject" || test === "contract-extension-approve") return "host";
  if (
    test === "contract-request" ||
    test === "contract-payment" ||
    test === "contract-cancel-request" ||
    test === "contract-cancel-confirmed" ||
    test === "review-detail" ||
    test === "review-profile" ||
    test === "review-schedule-select" ||
    test === "review-delete" ||
    test === "review-edit" ||
    test === "review-write" ||
    test === "coupon-box"
  ) {
    return "guest";
  }
  return requestedRoleLabel === "호스트" ? "host" : "guest";
}

function defaultRoleForTest(test) {
  if (test === "toss-deposit-approve" || test === "console-schedule-change") return "admin";
  return test === "contract-approve" || test === "contract-reject" || test === "contract-extension-approve" ? "host" : "guest";
}

function shouldAutoApproveTossDeposit({ test, paymentMethod }, result) {
  return (
    test === "contract-payment" &&
    paymentMethod === "bank-transfer" &&
    result.status === "pass"
  );
}

function shouldAutoApproveHostContract({ test, paymentMethod }, result) {
  return (
    test === "contract-request" &&
    (!paymentMethod || paymentMethod === "auto-card") &&
    result.status === "pass"
  );
}

function requiredLoginRoleForTest(test) {
  const guestRequired = [
    "contract-request",
    "contract-payment",
    "contract-cancel-request",
    "contract-cancel-confirmed",
    "contract-extension",
    "review-detail",
    "review-profile",
    "review-schedule-select",
    "review-delete",
    "review-edit",
    "review-write",
    "coupon-box"
  ];
  if (guestRequired.includes(test)) return "guest";
  if (test === "contract-approve" || test === "contract-reject" || test === "contract-extension-approve") return "host";
  return "";
}

function shouldUseLazyLogin(test) {
  return test === "contract-extension" || test === "contract-extension-approve";
}

async function runPrerequisiteLogin({ test, env }, context) {
  const loginRole = requiredLoginRoleForTest(test);
  if (!loginRole) return null;

  return runTest(
    {
      test: "login",
      env,
      role: loginRole,
      host_home_only: loginRole === "host",
      requested_by: context.user,
      slack_channel: context.channel,
      thread_ts: context.threadTs,
      source: "slack-prerequisite"
    },
    context.config
  );
}

async function runSingleQaCommand(command, context) {
  const { test, env, role, payment_method: paymentMethod } = command;
  const result = await runTest(
    {
      test,
      env,
      role,
      payment_method: paymentMethod,
      reservation_id: command.reservation_id,
      schedule_shift_label: command.schedule_shift_label,
      host_home_only: command.host_home_only,
      skip_fresh_launch: command.skip_fresh_launch,
      skip_app_build_check: command.skip_app_build_check,
      requested_by: context.user,
      slack_channel: context.channel,
      thread_ts: context.threadTs,
      source: "slack"
    },
    context.config
  );

  return result;
}

async function runQaCommandWithPrerequisite(command, context) {
  if (shouldUseLazyLogin(command.test)) {
    return runSingleQaCommandWithLazyLogin(command, context);
  }

  const loginResult = await runPrerequisiteLogin(command, context);
  if (loginResult && loginResult.status !== "pass") {
    return {
      result: loginResult,
      formatted: [
        "[사전 확인 실패] 로그인 세션 복구",
        formatResult(loginResult)
      ].join("\n")
    };
  }

  const result = await runSingleQaCommand(command, context);
  const loginRole = requiredLoginRoleForTest(command.test);
  const prefix = loginResult
    ? [
      `[사전 확인] ${loginRole} 로그인 세션 확인 PASS`,
      loginResult.session_reused ? "- 기존 로그인 세션 재사용" : "- 로그인 세션 복구 완료",
      ""
    ].join("\n")
    : "";

  return {
    result,
    formatted: `${prefix}${formatResult(result)}`
  };
}

async function runQaCommand(command, context) {
  const { test, env, role, payment_method: paymentMethod } = command;
  const { result, formatted: formattedResult } = await runQaCommandWithPrerequisite(command, context);

  if (shouldAutoApproveHostContract({ test, paymentMethod }, result)) {
    const { formatted: formattedApproveResult } = await runQaCommandWithPrerequisite(
      {
        test: "contract-approve",
        env,
        role: "host"
      },
      context
    );

    return [
      formattedResult,
      "",
      "-----",
      "",
      "[연결 실행] 호스트 계약 승인",
      formattedApproveResult
    ].join("\n");
  }

  if (!shouldAutoApproveTossDeposit({ test, paymentMethod }, result)) {
    return formattedResult;
  }

  const tossResult = await runSingleQaCommand(
    {
      test: "toss-deposit-approve",
      env: "toss",
      role: "admin"
    },
    context
  );

  return [
    formattedResult,
    "",
    "-----",
    "",
    "[연결 실행] 무통장 입금 승인",
    formatResult(tossResult)
  ].join("\n");
}

function reportLine(result) {
  return "";
}

function compactFlowSection(title, result) {
  const judgment = buildResultJudgment(result);
  const status = judgment.status;
  const lines = [
    `${status === "PASS" ? "[PASS]" : "[FAIL]"} ${title}`,
    `- 판정: ${judgment.conclusion}`,
    `- run_id: ${judgment.runId} / ${judgment.duration}`
  ];

  if (result.status === "fail") {
    lines.push(`- 마지막 성공: ${judgment.lastPassed}`);
    lines.push(`- 마지막 진행: ${judgment.lastProgress}`);
    lines.push(`- 의심 영역: ${judgment.suspectedArea}`);
    if (judgment.nextChecks[0]) lines.push(`- 다음 확인: ${judgment.nextChecks[0]}`);
  }

  const report = reportLine(result);
  if (report) lines.push(report);
  return lines.join("\n");
}

function appendFlowSection(sections, title, result) {
  sections.push(compactFlowSection(title, result));
}

function looksLikeLoginSessionFailure(result) {
  const message = String(result?.error || "");
  return (
    message.includes("호스트모드") ||
    message.includes("호스트 모드") ||
    message.includes("게스트 모드") ||
    message.includes("로그인") ||
    message.includes("login") ||
    message.includes("세션") ||
    message.includes("홈 화면")
  );
}

function isRetryableContractRequestError(result) {
  const message = String(result?.error || "");
  return (
    result?.status === "fail" &&
    (
      message.includes("일시적인 오류로 요청하지 못") ||
      message.includes("일시적인 오류가 발생") ||
      message.includes("잠시 후 다시 시도")
    )
  );
}

function relaunchRetryCommand(command) {
  return {
    ...command,
    skip_fresh_launch: false,
    skip_app_build_check: true
  };
}

async function runSingleQaCommandWithLazyLogin(command, context) {
  let result = await runSingleQaCommand(command, context);
  const loginRole = requiredLoginRoleForTest(command.test);

  if (command.test === "contract-request" && isRetryableContractRequestError(result)) {
    const retryResult = await runSingleQaCommand(relaunchRetryCommand(command), context);
    return {
      result: retryResult,
      formatted: [
        "[재시도] 계약 요청 일시 오류로 앱 재실행 후 다시 실행",
        formatResult(retryResult)
      ].join("\n")
    };
  }

  if (result.status === "pass" || !loginRole || !looksLikeLoginSessionFailure(result)) {
    return { result, formatted: formatResult(result) };
  }

  const loginResult = await runSingleQaCommand(
    {
      test: "login",
      env: command.env,
      role: loginRole,
      host_home_only: loginRole === "host",
      skip_app_build_check: command.skip_app_build_check
    },
    context
  );

  if (loginResult.status !== "pass") {
    return {
      result: loginResult,
      formatted: [
        "[세션 복구 실패] 로그인 재시도",
        formatResult(loginResult)
      ].join("\n")
    };
  }

  result = await runSingleQaCommand(command, context);
  if (command.test === "contract-request" && isRetryableContractRequestError(result)) {
    const retryResult = await runSingleQaCommand(relaunchRetryCommand(command), context);
    return {
      result: retryResult,
      formatted: [
        "[세션 복구] 로그인 후 재시도",
        loginResult.session_reused ? "- 기존 로그인 세션 재사용" : "- 로그인 세션 복구 완료",
        "",
        "[재시도] 계약 요청 일시 오류로 앱 재실행 후 다시 실행",
        formatResult(retryResult)
      ].join("\n")
    };
  }

  return {
    result,
    formatted: [
      `[세션 복구] ${loginRole} 로그인 후 재시도`,
      loginResult.session_reused ? "- 기존 로그인 세션 재사용" : "- 로그인 세션 복구 완료",
      "",
      formatResult(result)
    ].join("\n")
  };
}

function basicValidationLabel(paymentMethod) {
  if (paymentMethod === "extension-bank-transfer") return "연장결제 무통장";
  if (paymentMethod === "extension-card") return "연장결제";
  if (paymentMethod === "bank-transfer") return "무통장 결제";
  if (paymentMethod === "auto-card") return "자동결제";
  return "일반결제";
}

async function runExtensionPaymentValidation({ env, payment_method: paymentMethod }, context) {
  const flowLabel = basicValidationLabel(paymentMethod);
  const sections = [
    `[기본검증] ${flowLabel} 1사이클 (${env})`,
    `게스트 연장요청 > 호스트 연장수락 > 게스트 ${flowLabel} 순서로 실행합니다.`
  ];

  const guestLogin = await runSingleQaCommand(
    {
      test: "login",
      env,
      role: "guest"
    },
    context
  );
  appendFlowSection(sections, "1. 게스트 로그인", guestLogin);
  if (guestLogin.status !== "pass") return sections.join("\n\n");

  const extensionRequest = await runSingleQaCommandWithLazyLogin(
    {
      test: "contract-extension",
      env,
      role: "guest",
      skip_fresh_launch: true,
      skip_app_build_check: true
    },
    context
  );
  sections.push(compactFlowSection("2. 게스트 연장요청", extensionRequest.result));
  if (extensionRequest.result.status !== "pass") return sections.join("\n\n");

  const extensionApprove = await runSingleQaCommandWithLazyLogin(
    {
      test: "contract-extension-approve",
      env,
      role: "host",
      skip_app_build_check: true
    },
    context
  );
  sections.push(compactFlowSection("3. 호스트 연장수락", extensionApprove.result));
  if (extensionApprove.result.status !== "pass") return sections.join("\n\n");

  const extensionPayment = await runSingleQaCommand(
    {
      test: "contract-payment",
      env,
      role: "guest",
      payment_method: paymentMethod,
      skip_fresh_launch: true,
      skip_app_build_check: true
    },
    context
  );
  sections.push(compactFlowSection(`4. 게스트 ${flowLabel}`, extensionPayment));
  if (extensionPayment.status !== "pass") return sections.join("\n\n");

  sections.push(`[기본검증 PASS] 연장요청부터 연장수락, ${flowLabel}까지 1사이클이 완료되었습니다.`);
  return sections.join("\n\n");
}

async function runStandardContractValidation({ env, payment_method: paymentMethod }, context) {
  const flowLabel = basicValidationLabel(paymentMethod);
  const sections = [
    `[기본검증] ${flowLabel} 1사이클 (${env})`,
    paymentMethod === "auto-card"
      ? "게스트 로그인 > 게스트 자동결제 계약 요청 > 호스트 계약 승인 순서로 실행합니다."
      : `게스트 로그인 > 게스트 계약 요청 > 호스트 계약 승인 > 게스트 ${flowLabel} 순서로 실행합니다.`
  ];

  const guestLogin = await runSingleQaCommand(
    {
      test: "login",
      env,
      role: "guest"
    },
    context
  );
  appendFlowSection(sections, "1. 게스트 로그인", guestLogin);
  if (guestLogin.status !== "pass") return sections.join("\n\n");

  const contractRequest = await runSingleQaCommandWithLazyLogin(
    {
      test: "contract-request",
      env,
      role: "guest",
      payment_method: paymentMethod === "auto-card" ? "auto-card" : undefined,
      skip_fresh_launch: true,
      skip_app_build_check: true
    },
    context
  );
  sections.push(compactFlowSection("2. 게스트 계약 요청", contractRequest.result));
  if (contractRequest.result.status !== "pass") return sections.join("\n\n");

  const contractApprove = await runSingleQaCommandWithLazyLogin(
    {
      test: "contract-approve",
      env,
      role: "host",
      skip_app_build_check: true
    },
    context
  );
  sections.push(compactFlowSection("3. 호스트 계약 승인", contractApprove.result));
  if (contractApprove.result.status !== "pass") return sections.join("\n\n");

  if (paymentMethod === "auto-card") {
    sections.push("[기본검증 PASS] 자동결제 계약 요청부터 호스트 승인까지 1사이클이 완료되었습니다.");
    return sections.join("\n\n");
  }

  const contractPayment = await runSingleQaCommandWithLazyLogin(
    {
      test: "contract-payment",
      env,
      role: "guest",
      payment_method: paymentMethod,
      skip_app_build_check: true
    },
    context
  );
  sections.push(compactFlowSection(`4. 게스트 ${flowLabel}`, contractPayment.result));
  if (contractPayment.result.status !== "pass") return sections.join("\n\n");

  if (paymentMethod === "bank-transfer") {
    const tossResult = await runSingleQaCommand(
      {
        test: "toss-deposit-approve",
        env: "toss",
        role: "admin"
      },
      context
    );
    sections.push(compactFlowSection("5. 무통장 입금 승인", tossResult));
    if (tossResult.status !== "pass") return sections.join("\n\n");
  }

  sections.push(`[기본검증 PASS] 계약 요청부터 호스트 승인, 게스트 ${flowLabel}까지 1사이클이 완료되었습니다.`);
  return sections.join("\n\n");
}

async function runBasicValidation({ env, payment_method: paymentMethod }, context) {
  if (!paymentMethod || paymentMethod === "card" || paymentMethod === "bank-transfer" || paymentMethod === "auto-card") {
    return runStandardContractValidation({ env, payment_method: paymentMethod || "card" }, context);
  }

  if (paymentMethod === "extension-card" || paymentMethod === "extension-bank-transfer") {
    return runExtensionPaymentValidation({ env, payment_method: paymentMethod }, context);
  }

  throw new Error("기본검증은 일반결제 또는 연장결제 카드/무통장만 실행할 수 있습니다. 예: !기본검증 일반결제 dev");
}

async function routeCommand(text, context) {
  const consoleScheduleChange = parseConsoleScheduleChange(text);
  if (consoleScheduleChange) {
    return runQaCommand(consoleScheduleChange, context);
  }

  const basicValidation = parseBasicValidation(text);
  if (basicValidation) {
    return runBasicValidation(basicValidation, context);
  }

  if (TOSS_DEPOSIT_APPROVE_PATTERN.test(text.trim())) {
    return runQaCommand(
      {
        test: "toss-deposit-approve",
        env: "toss",
        role: "admin"
      },
      context
    );
  }

  const shortcut = parseKoreanShortcut(text);
  if (shortcut) {
    return runQaCommand(shortcut, context);
  }

  const parts = text.trim().split(/\s+/);
  const command = parts[1] || "help";

  if (command === "help") {
    return formatHelp();
  }

  if (
    command === "login" ||
    command === "logout" ||
    command === "search" ||
    command === "search-flexible" ||
    command === "contract-approve" ||
    command === "contract-reject" ||
    command === "contract-cancel-confirmed" ||
    command === "contract-cancel-request" ||
    command === "contract-extension" ||
    command === "contract-extension-approve" ||
    command === "contract-payment" ||
    command === "contract-request" ||
    command === "review-detail" ||
    command === "review-profile" ||
    command === "review-schedule-select" ||
    command === "review-delete" ||
    command === "review-edit" ||
    command === "review-write" ||
    command === "coupon-box" ||
    command === "basic-validation" ||
    command === "toss-deposit-approve" ||
    command === "console-schedule-change"
  ) {
    const args = parseKeyValues(parts.slice(2));
    const paymentMethod = args.method || args.payment_method;
    if (command === "basic-validation") {
      return runBasicValidation(
        {
          env: args.env || "staging",
          payment_method: paymentMethod || "extension-card"
        },
        context
      );
    }

    const test = command === "contract-payment" && paymentMethod === "auto-card"
      ? "contract-request"
      : command;
    return runQaCommand(
      {
        test,
        env: args.env || (test === "toss-deposit-approve" ? "toss" : "staging"),
        role: args.role || defaultRoleForTest(test),
        payment_method: paymentMethod,
        reservation_id: args.reservation_id,
        schedule_shift_label: args.shift || args.schedule_shift_label
      },
      context
    );
  }

  if (command === "status" || command === "rerun") {
    return `아직 ${command} 명령은 구현되지 않았습니다. 현재는 help에 표시된 실행 명령어를 사용해주세요.`;
  }

  return `알 수 없는 명령입니다: ${command}\n\n${formatHelp()}`;
}

module.exports = {
  BASIC_VALIDATION_PATTERN,
  CONSOLE_SCHEDULE_CHANGE_PATTERN,
  KOREAN_SHORTCUT_PATTERN,
  TOSS_DEPOSIT_APPROVE_PATTERN,
  routeCommand
};
