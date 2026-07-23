const { App } = require("@slack/bolt");
const { loadConfig } = require("./config");
const { routeCommand } = require("./slack/command-router");
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

  app.message(
    /^!(게스트|계스트|호스트)\s+(로그인|로그아웃|집검색|집 검색|정확한일정 검색|정확한 일정 검색|유연한일정 검색|유연한 일정 검색|계약요청|계약 요청|계약요청취소|계약 요청 취소|계약확정취소|계약 확정 취소|예약확정취소|예약 확정 취소|계약승인|계약 승인|계약결제|계약 결제)(?:\s+(일반카드|카드|무통장|자동카드))?(?:\s+(dev|stg|staging))?$/i,
    async ({ message, say }) => {
      await handleQaMessage(message, say);
    }
  );

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
