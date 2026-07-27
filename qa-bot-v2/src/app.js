const { App } = require("@slack/bolt");
const { loadConfig } = require("./config");
const {
  BASIC_VALIDATION_PATTERN,
  KOREAN_SHORTCUT_PATTERN,
  SCHEDULE_CHANGE_PATTERN,
  TOSS_DEPOSIT_APPROVE_PATTERN,
  routeCommand
} = require("./slack/command-router");
const { formatHelp } = require("./slack/slack-reporter");

process.on("uncaughtException", (error) => {
  console.error("qa-bot-v2 crashed while connecting to Slack.");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function shouldPostProgressMessage(text = "") {
  const normalized = String(text).trim().replace(/\s+/g, " ");
  return !(/^!qa$/i.test(normalized) || /^!qa help$/i.test(normalized));
}

function formatProgressMessage(text = "") {
  return [
    "테스트 진행 중입니다.",
    "완료되면 이 스레드에 결과를 남길게요."
  ].join("\n");
}

async function main() {
  const config = loadConfig();

  if (!config.slackBotToken || !config.slackAppToken) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.");
  }

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true
  });

  app.error((error) => {
    console.error("Slack app error:", error.stack || error.message);
  });

  async function handleQaMessage(message, say) {
    const threadTs = message.thread_ts || message.ts;
    if (shouldPostProgressMessage(message.text)) {
      await say({
        text: formatProgressMessage(message.text),
        thread_ts: threadTs
      });
    }

    const response = await routeCommand(message.text, {
      config,
      user: message.user,
      channel: message.channel,
      threadTs
    });

    await say({
      text: response,
      thread_ts: threadTs
    });
  }

  app.message(/^!qa\b/i, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(BASIC_VALIDATION_PATTERN, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(KOREAN_SHORTCUT_PATTERN, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(SCHEDULE_CHANGE_PATTERN, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(TOSS_DEPOSIT_APPROVE_PATTERN, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(/^!qa$/i, async ({ message, say }) => {
    await say({
      text: formatHelp(),
      thread_ts: message.thread_ts || message.ts
    });
  });

  await app.start();
  console.log("qa-bot-v2 is running in Socket Mode.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  formatProgressMessage,
  main,
  shouldPostProgressMessage
};
