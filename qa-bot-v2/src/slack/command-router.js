const { runTest } = require("../orchestrator/run-test");
const { formatHelp, formatResult } = require("./slack-reporter");

const KOREAN_SHORTCUT_PATTERN =
  /^!(게스트|계스트|호스트)\s+(로그인|로그아웃|집검색|집 검색|검색 정확한일정|검색 정확한 일정|검색 유연한일정|검색 유연한 일정|정확한일정 검색|정확한 일정 검색|유연한일정 검색|유연한 일정 검색|계약요청|계약 요청|계약요청취소|계약 요청 취소|계약확정취소|계약 확정 취소|예약확정취소|예약 확정 취소|계약승인|계약 승인|계약요청거절|계약 요청 거절|계약결제|계약 결제)(?:\s+(일반카드|카드|무통장|자동카드))?(?:\s+(dev|stg|staging))?$/i;

const TOSS_DEPOSIT_APPROVE_PATTERN = /^!무통장\s+입금\s+승인$/i;
const SCHEDULE_CHANGE_PATTERN =
  /^!(\d+)\s+계약\s*변경\s+(일주일\s*전|2주일\s*전|2주\s*전|한달\s*전|1달\s*전|일주일\s*후|2주일\s*후|2주\s*후|한달\s*후|1달\s*후)$/i;
const BASIC_VALIDATION_PATTERN =
  /^!기본검증\s+(일반결제|일반카드|카드|무통장\s*결제|무통장결제|무통장|자동결제|자동\s*결제|자동카드)(?:\s+(dev|stg|staging))?$/i;

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
    계약요청: "contract-request",
    "계약 요청": "contract-request",
    계약요청취소: "contract-cancel-request",
    "계약 요청 취소": "contract-cancel-request",
    계약확정취소: "contract-cancel-confirmed",
    "계약 확정 취소": "contract-cancel-confirmed",
    예약확정취소: "contract-cancel-confirmed",
    "예약 확정 취소": "contract-cancel-confirmed",
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
  const test = paymentMethod === "auto-card"
    ? "contract-request"
    : testByCommand[match[2]];
  const role = roleForShortcut(test, match[1]);

  return {
    test,
    role,
    env: envByShortcut[String(match[4] || "stg").toLowerCase()],
    payment_method: paymentMethod
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
    일반카드: "card",
    카드: "card",
    "무통장 결제": "bank-transfer",
    무통장결제: "bank-transfer",
    무통장: "bank-transfer",
    자동결제: "auto-card",
    "자동 결제": "auto-card",
    자동카드: "auto-card"
  };

  return {
    env: envByShortcut[String(match[2] || "stg").toLowerCase()],
    payment_method: methodByShortcut[match[1].replace(/\s+/g, " ").trim()] || "card"
  };
}

function parseScheduleChange(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const match = normalized.match(SCHEDULE_CHANGE_PATTERN);
  if (!match) return null;

  return {
    test: "schedule-change",
    env: "api",
    role: "api",
    reservation_id: match[1],
    offset_label: match[2]
  };
}

function roleForShortcut(test, requestedRoleLabel) {
  if (test === "contract-approve" || test === "contract-reject") return "host";
  if (
    test === "contract-request" ||
    test === "contract-payment" ||
    test === "contract-cancel-request" ||
    test === "contract-cancel-confirmed"
  ) {
    return "guest";
  }
  return requestedRoleLabel === "호스트" ? "host" : "guest";
}

function defaultRoleForTest(test) {
  if (test === "schedule-change") return "api";
  if (test === "toss-deposit-approve") return "admin";
  return test === "contract-approve" || test === "contract-reject" ? "host" : "guest";
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
    "contract-cancel-confirmed"
  ];
  if (guestRequired.includes(test)) return "guest";
  if (test === "contract-approve" || test === "contract-reject") return "host";
  return "";
}

async function runPrerequisiteLogin({ test, env }, context) {
  const loginRole = requiredLoginRoleForTest(test);
  if (!loginRole) return null;

  return runTest(
    {
      test: "login",
      env,
      role: loginRole,
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
      offset_label: command.offset_label || command.offset,
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

function appendFlowSection(sections, title, result) {
  sections.push([
    `## ${title}`,
    formatResult(result)
  ].join("\n"));
}

function basicValidationLabel(paymentMethod) {
  if (paymentMethod === "bank-transfer") return "무통장 결제";
  if (paymentMethod === "auto-card") return "자동결제";
  return "일반결제";
}

async function runBasicValidation({ env, payment_method: paymentMethod }, context) {
  const flowLabel = basicValidationLabel(paymentMethod);
  const isAutoCard = paymentMethod === "auto-card";
  const requestPaymentMethod = isAutoCard ? "auto-card" : undefined;
  const sections = [
    `[기본검증] ${flowLabel} 1사이클 (${env})`,
    isAutoCard
      ? "로그인 > 정확한 일정 검색/집 상세 진입/자동카드 계약 요청 > 호스트 승인 순서로 실행합니다."
      : `로그인 > 정확한 일정 검색/집 상세 진입/계약 요청 > 호스트 승인 > 게스트 ${flowLabel} 순서로 실행합니다.`
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

  const contractRequest = await runSingleQaCommand(
    {
      test: "contract-request",
      env,
      role: "guest",
      payment_method: requestPaymentMethod
    },
    context
  );
  appendFlowSection(
    sections,
    isAutoCard ? "2. 집 검색/상세 진입/자동카드 계약 요청" : "2. 집 검색/상세 진입/계약 요청",
    contractRequest
  );
  if (contractRequest.status !== "pass") return sections.join("\n\n");

  const { result: approveResult, formatted: formattedApproveResult } = await runQaCommandWithPrerequisite(
    {
      test: "contract-approve",
      env,
      role: "host"
    },
    context
  );
  sections.push([
    "## 3. 호스트 계약 승인",
    formattedApproveResult
  ].join("\n"));
  if (approveResult.status !== "pass") return sections.join("\n\n");

  if (isAutoCard) {
    sections.push("[기본검증 PASS] 자동결제 계약 요청부터 호스트 승인까지 1사이클이 완료되었습니다.");
    return sections.join("\n\n");
  }

  const { result: paymentResult, formatted: formattedPaymentResult } = await runQaCommandWithPrerequisite(
    {
      test: "contract-payment",
      env,
      role: "guest",
      payment_method: paymentMethod
    },
    context
  );
  sections.push([
    `## 4. 게스트 ${flowLabel}`,
    formattedPaymentResult
  ].join("\n"));
  if (paymentResult.status !== "pass") return sections.join("\n\n");

  if (paymentMethod === "bank-transfer") {
    const tossResult = await runSingleQaCommand(
      {
        test: "toss-deposit-approve",
        env: "toss",
        role: "admin"
      },
      context
    );
    appendFlowSection(sections, "5. 무통장 입금 승인", tossResult);
    if (tossResult.status !== "pass") return sections.join("\n\n");
  }

  sections.push(`[기본검증 PASS] ${flowLabel} 계약 요청부터 결제까지 1사이클이 완료되었습니다.`);
  return sections.join("\n\n");
}

async function routeCommand(text, context) {
  const basicValidation = parseBasicValidation(text);
  if (basicValidation) {
    return runBasicValidation(basicValidation, context);
  }

  const scheduleChange = parseScheduleChange(text);
  if (scheduleChange) {
    return runQaCommand(scheduleChange, context);
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
    command === "contract-payment" ||
    command === "contract-request" ||
    command === "basic-validation" ||
    command === "schedule-change" ||
    command === "toss-deposit-approve"
  ) {
    const args = parseKeyValues(parts.slice(2));
    const paymentMethod = args.method || args.payment_method;
    if (command === "basic-validation") {
      return runBasicValidation(
        {
          env: args.env || "staging",
          payment_method: paymentMethod || "card"
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
        env: args.env || (test === "toss-deposit-approve" ? "toss" : test === "schedule-change" ? "api" : "staging"),
        role: args.role || defaultRoleForTest(test),
        payment_method: paymentMethod,
        reservation_id: args.reservation_id || args.reservation || args.id,
        offset_label: args.offset || args.offset_label
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
  KOREAN_SHORTCUT_PATTERN,
  SCHEDULE_CHANGE_PATTERN,
  TOSS_DEPOSIT_APPROVE_PATTERN,
  routeCommand
};
