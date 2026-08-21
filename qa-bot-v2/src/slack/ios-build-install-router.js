const { runTest } = require("../orchestrator/run-test");
const { formatResult } = require("./slack-reporter");

// build-install-ui.js(코덱스가 계속 작업 중인 모달 UI 파일)와 완전히 분리된 iOS 전용 라우터.
// "!빌드설치 ios [dev|stg] [게스트|호스트]" 형식만 처리한다. 기존 "!빌드설치"(공백만 있는 경우)
// 패턴과는 겹치지 않는다(뒤에 "ios" 토큰이 있어야만 매치됨).
const IOS_BUILD_INSTALL_PATTERN =
  /^\s*!빌드설치\s+ios(?:\s+(dev|stg|staging))?(?:\s+(게스트|호스트))?\s*$/i;

function parseIosBuildInstallCommand(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  const match = normalized.match(IOS_BUILD_INSTALL_PATTERN);
  if (!match) return null;

  const envByShortcut = {
    dev: "dev",
    stg: "staging",
    staging: "staging"
  };

  return {
    test: "ios-build-install",
    env: envByShortcut[String(match[1] || "stg").toLowerCase()],
    role: match[2] === "호스트" ? "host" : "guest"
  };
}

async function routeIosBuildInstallCommand(text, context) {
  const command = parseIosBuildInstallCommand(text);
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
  IOS_BUILD_INSTALL_PATTERN,
  routeIosBuildInstallCommand
};
