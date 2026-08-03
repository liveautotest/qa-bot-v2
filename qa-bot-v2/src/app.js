const { App } = require("@slack/bolt");
const { SocketModeClient } = require("@slack/socket-mode");
const { loadConfig } = require("./config");
const {
  BASIC_VALIDATION_PATTERN,
  KOREAN_SHORTCUT_PATTERN,
  SCHEDULE_CHANGE_PATTERN,
  TOSS_DEPOSIT_APPROVE_PATTERN,
  routeCommand
} = require("./slack/command-router");
const { formatHelp } = require("./slack/slack-reporter");
const { uploadPdfReports } = require("./slack/pdf-report");

function isSocketModeExplicitDisconnectRace(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("Unhandled event 'server explicit disconnect'") &&
    message.includes("state 'connecting'")
  );
}

function installSocketModeDisconnectGuard() {
  if (!SocketModeClient?.prototype || SocketModeClient.prototype.__qaBotDisconnectGuardInstalled) {
    return;
  }

  const originalOnWebSocketMessage = SocketModeClient.prototype.onWebSocketMessage;
  SocketModeClient.prototype.onWebSocketMessage = async function guardedOnWebSocketMessage(payload) {
    try {
      return await originalOnWebSocketMessage.call(this, payload);
    } catch (error) {
      if (!isSocketModeExplicitDisconnectRace(error)) {
        throw error;
      }

      this.logger?.warn?.("Slack sent an explicit disconnect while connecting. Retrying Socket Mode connection.");
      try {
        this.stateMachine?.handle?.("websocket close");
      } catch (reconnectError) {
        this.logger?.error?.(`Socket Mode reconnect guard failed: ${reconnectError.message || reconnectError}`);
      }
      return undefined;
    }
  };

  Object.defineProperty(SocketModeClient.prototype, "__qaBotDisconnectGuardInstalled", {
    value: true
  });
}

process.on("uncaughtException", (error) => {
  if (isSocketModeExplicitDisconnectRace(error)) {
    console.warn("Slack Socket Mode disconnected while connecting. Waiting for reconnect.");
    return;
  }

  console.error("qa-bot-v2 encountered an uncaught exception.");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  if (isSocketModeExplicitDisconnectRace(error)) {
    console.warn("Slack Socket Mode disconnected while connecting. Waiting for reconnect.");
    return;
  }

  console.error("qa-bot-v2 encountered an unhandled rejection.");
  console.error(error?.stack || error?.message || error);
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
  installSocketModeDisconnectGuard();

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
    if (/기본검증/i.test(String(message.text || ""))) {
      console.log(`[QA command] ${message.text}`);
    }
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

    try {
      await uploadPdfReports({
        client: app.client,
        config,
        channel: message.channel,
        threadTs,
        responseText: response
      });
    } catch (error) {
      console.error("Failed to upload PDF report:", error.stack || error.message);
      const message = String(error.message || "");
      const helpText = message.includes("missing_scope")
        ? "PDF 리포트 첨부에 실패했습니다: Slack 앱 권한에 files:write가 필요합니다. Slack 앱 OAuth Scopes에 files:write 추가 후 앱을 다시 설치해주세요."
        : `PDF 리포트 첨부에 실패했습니다: ${message}`;
      await say({
        text: helpText,
        thread_ts: threadTs
      });
    }
  }

  app.message(/^!qa\b/i, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(/^\s*![\s\u200b\u200c\u200d\ufeff]*기본검증/i, async ({ message, say }) => {
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
