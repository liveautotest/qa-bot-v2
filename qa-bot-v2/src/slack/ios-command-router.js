const { runTest } = require("../orchestrator/run-test");
const { formatResult } = require("./slack-reporter");

// command-router.js(코덱스가 계속 작업 중인 파일)와 완전히 분리된 iOS UI 자동화 전용 라우터.
// "!게스트/호스트 로그인 ios [dev|stg]" 형식만 처리한다. ios-build-install-router.js와도
// 별개 파일이라 서로 안 겹친다.
const IOS_LOGIN_PATTERN =
  /^\s*!(게스트|호스트)\s+로그인\s+ios(?:\s+(dev|stg|staging))?\s*$/i;

function parseIosLoginCommand(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  const match = normalized.match(IOS_LOGIN_PATTERN);
  if (!match) return null;

  const envByShortcut = {
    dev: "dev",
    stg: "staging",
    staging: "staging"
  };

  return {
    test: "ios-login",
    role: match[1] === "호스트" ? "host" : "guest",
    env: envByShortcut[String(match[2] || "stg").toLowerCase()]
  };
}

async function routeIosLoginCommand(text, context) {
  const command = parseIosLoginCommand(text);
  if (!command) return null;

  const result = await runTest(
    {
      ...command,
      requested_by: context.user,
      slack_channel: context.channel,
      thread_ts: context.threadTs,
      source: "slack-ios"
    },
    context.config
  );

  return formatResult(result);
}

module.exports = {
  IOS_LOGIN_PATTERN,
  routeIosLoginCommand
};
