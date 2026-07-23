const { runTest } = require("../orchestrator/run-test");
const { formatHelp, formatResult } = require("./slack-reporter");

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
  const match = normalized.match(
    /^!(게스트|호스트)\s+(로그인|로그아웃|집검색|집 검색|정확한일정 검색|정확한 일정 검색|유연한일정 검색|유연한 일정 검색|계약요청|계약 요청|계약승인|계약 승인|계약결제|계약 결제)(?:\s+(카드|무통장))?(?:\s+(dev|stg|staging))?$/i
  );
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
    계약승인: "contract-approve",
    "계약 승인": "contract-approve",
    계약결제: "contract-payment",
    "계약 결제": "contract-payment"
  };
  const envByShortcut = {
    dev: "dev",
    stg: "staging",
    staging: "staging"
  };
  const paymentMethodByShortcut = {
    카드: "card",
    무통장: "bank-transfer"
  };

  return {
    test: testByCommand[match[2]],
    role: match[1] === "게스트" ? "guest" : "host",
    env: envByShortcut[String(match[4] || "stg").toLowerCase()],
    payment_method: paymentMethodByShortcut[match[3]]
  };
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
    command === "contract-payment" ||
    command === "contract-request"
  ) {
    const args = parseKeyValues(parts.slice(2));
    return runQaCommand(
      {
        test: command,
        env: args.env || "staging",
        role: args.role || "guest",
        payment_method: args.method || args.payment_method
      },
      context
    );
  }

  if (command === "status" || command === "rerun") {
    return `아직 ${command} 명령은 1단계 구현 대상이 아닙니다. 먼저 login dry-run을 안정화합니다.`;
  }

  return `알 수 없는 명령입니다: ${command}\n\n${formatHelp()}`;
}

module.exports = {
  routeCommand
};
