const { App } = require("@slack/bolt");
const { loadConfig } = require("./config");
const { KOREAN_SHORTCUT_PATTERN, routeCommand } = require("./slack/command-router");
const { formatHelp } = require("./slack/slack-reporter");

process.on("uncaughtException", (error) => {
  console.error("qa-bot-v2 crashed while connecting to Slack.");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

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
    const response = await routeCommand(message.text, {
      config,
      user: message.user,
      channel: message.channel,
      threadTs: message.thread_ts || message.ts
    });

    await say({
      text: response,
      thread_ts: message.thread_ts || message.ts
    });
  }

  app.message(/^!qa\b/i, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(KOREAN_SHORTCUT_PATTERN, async ({ message, say }) => {
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
