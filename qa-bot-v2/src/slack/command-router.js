const { runTest } = require("../orchestrator/run-test");
const { formatHelp, formatResult } = require("./slack-reporter");

const KOREAN_SHORTCUT_PATTERN =
  /^!(게스트|계스트|호스트)\s+(로그인|로그아웃|집검색|집 검색|정확한일정 검색|정확한 일정 검색|유연한일정 검색|유연한 일정 검색|계약요청|계약 요청|계약요청취소|계약 요청 취소|계약확정취소|계약 확정 취소|예약확정취소|예약 확정 취소|계약승인|계약 승인|계약요청거절|계약 요청 거절|계약결제|계약 결제)(?:\s+(일반카드|카드|무통장|자동카드))?(?:\s+(dev|stg|staging))?$/i;

const TOSS_DEPOSIT_APPROVE_PATTERN = /^!무통장\s+입금\s+승인$/i;

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
    "정확한일정 검색": "search",
    "정확한 일정 검색": "search",
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
  const role = test === "contract-approve" || test === "contract-reject"
    ? "host"
    : match[1] === "호스트" ? "host" : "guest";

  return {
    test,
    role,
    env: envByShortcut[String(match[4] || "stg").toLowerCase()],
    payment_method: paymentMethod
  };
}

function defaultRoleForTest(test) {
  if (test === "toss-deposit-approve") return "admin";
  return test === "contract-approve" || test === "contract-reject" ? "host" : "guest";
}

async function runQaCommand({ test, env, role, payment_method: paymentMethod }, context) {
  const result = await runTest(
    {
      test,
      env,
      role,
      payment_method: paymentMethod,
      requested_by: context.user,
      slack_channel: context.channel,
      thread_ts: context.threadTs,
      source: "slack"
    },
    context.config
  );

  return formatResult(result);
}

async function routeCommand(text, context) {
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
    command === "toss-deposit-approve"
  ) {
    const args = parseKeyValues(parts.slice(2));
    const paymentMethod = args.method || args.payment_method;
    const test = command === "contract-payment" && paymentMethod === "auto-card"
      ? "contract-request"
      : command;
    return runQaCommand(
      {
        test,
        env: args.env || (test === "toss-deposit-approve" ? "toss" : "staging"),
        role: args.role || defaultRoleForTest(test),
        payment_method: paymentMethod
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
  KOREAN_SHORTCUT_PATTERN,
  TOSS_DEPOSIT_APPROVE_PATTERN,
  routeCommand
};
