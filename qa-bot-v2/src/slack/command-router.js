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
    /^!(게스트|호스트)\s+(로그인|로그아웃|집검색|집 검색|정확한일정 검색|정확한 일정 검색|유연한일정 검색|유연한 일정 검색)$/
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
    "유연한 일정 검색": "search-flexible"
  };

  return {
    test: testByCommand[match[2]],
    role: match[1] === "게스트" ? "guest" : "host",
    env: "staging"
  };
}

async function runQaCommand({ test, env, role }, context) {
  const result = await runTest(
    {
      test,
      env,
      role,
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
    command === "search-flexible"
  ) {
    const args = parseKeyValues(parts.slice(2));
    return runQaCommand(
      {
        test: command,
        env: args.env || "staging",
        role: args.role || "guest"
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
