const { App } = require("@slack/bolt");
const { SocketModeClient } = require("@slack/socket-mode");
const { loadConfig } = require("./config");
const {
  BASIC_VALIDATION_PATTERN,
  CONSOLE_SCHEDULE_CHANGE_PATTERN,
  KOREAN_SHORTCUT_PATTERN,
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

function isConsoleScheduleChangeCommand(text = "") {
  return /^\s*![\s\u200b\u200c\u200d\ufeff]*일정변경/i.test(String(text || ""));
}

function formatProgressMessage(text = "") {
  if (isConsoleScheduleChangeCommand(text)) {
    return "일정 변경 진행중입니다. 잠시만 기다려주세요.";
  }

  return [
    "테스트를 시작했습니다.",
    "완료되면 이 스레드에 결과를 남길게요."
  ].join("\n");
}

function formatDelegatedProgressMessage(resultTarget) {
  return [
    "테스트를 시작했습니다.",
    `결과는 ${resultTarget.label} 채널에 새 스레드로 남길게요.`
  ].join("\n");
}

function normalizeSlackChannel(value = "") {
  const raw = String(value || "").trim();
  const mention = raw.match(/^<#([A-Z0-9]+)(?:\|[^>]+)?>$/);
  if (mention) return mention[1];
  return raw.replace(/^#/, "").trim();
}

function isSlackChannelId(value = "") {
  return /^[CGD][A-Z0-9]+$/.test(String(value || "").trim());
}

async function resolveSlackChannel(client, channelValue) {
  const normalized = normalizeSlackChannel(channelValue);
  if (!normalized) return null;

  if (isSlackChannelId(normalized)) {
    return {
      id: normalized,
      label: `<#${normalized}>`
    };
  }

  let cursor;
  do {
    const response = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor
    });
    const channel = (response.channels || []).find((item) => item.name === normalized);
    if (channel) {
      return {
        id: channel.id,
        label: `<#${channel.id}>`
      };
    }
    cursor = response.response_metadata?.next_cursor;
  } while (cursor);

  throw new Error(`결과 채널을 찾지 못했습니다: ${channelValue}`);
}

async function openResultThread({ client, resultTarget, sourceMessage }) {
  if (!resultTarget) {
    return {
      channel: sourceMessage.channel,
      threadTs: sourceMessage.thread_ts || sourceMessage.ts
    };
  }

  const posted = await client.chat.postMessage({
    channel: resultTarget.id,
    text: isConsoleScheduleChangeCommand(sourceMessage.text)
      ? [
        "일정 변경 진행중입니다. 잠시만 기다려주세요.",
        `요청자: <@${sourceMessage.user}>`,
        `검증 대상: ${sourceMessage.text || ""}`
      ].join("\n")
      : [
        "테스트를 시작했습니다.",
        "완료되면 이 스레드에 결과를 남길게요.",
        `요청자: <@${sourceMessage.user}>`,
        `검증 대상: ${sourceMessage.text || ""}`
      ].join("\n")
  });

  return {
    channel: resultTarget.id,
    threadTs: posted.ts
  };
}

const handledMessageKeys = new Map();
const activeCommandKeys = new Set();

function normalizeCommandText(text = "") {
  return String(text).trim().replace(/\s+/g, " ");
}

function resultChannelAllowlist(config) {
  return String(config.slackResultChannelAllowlist || "")
    .split(/[,\n]/)
    .map((item) => normalizeCommandText(item))
    .filter(Boolean);
}

function testResultChannelAllowlist(config) {
  return String(config.slackTestResultChannelAllowlist || "")
    .split(/[,\n]/)
    .map((item) => normalizeCommandText(item))
    .filter(Boolean);
}

function resolveConfiguredResultChannel(text = "", config = {}) {
  if (!shouldPostProgressMessage(text)) return "";
  const normalized = normalizeCommandText(text);
  if (config.slackTestResultChannel && testResultChannelAllowlist(config).includes(normalized)) {
    return config.slackTestResultChannel;
  }
  if (config.slackResultChannel && resultChannelAllowlist(config).includes(normalized)) {
    return config.slackResultChannel;
  }
  return "";
}

function messageDedupeKey(message) {
  return [message.channel || "", message.ts || "", normalizeCommandText(message.text)].join(":");
}

function activeCommandKey(message) {
  return [message.channel || "", normalizeCommandText(message.text)].join(":");
}

function rememberMessageKey(key) {
  const now = Date.now();
  handledMessageKeys.set(key, now);

  for (const [storedKey, storedAt] of handledMessageKeys.entries()) {
    if (now - storedAt > 10 * 60 * 1000) {
      handledMessageKeys.delete(storedKey);
    }
  }
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
    const dedupeKey = messageDedupeKey(message);
    if (handledMessageKeys.has(dedupeKey)) {
      return;
    }
    rememberMessageKey(dedupeKey);

    const commandKey = activeCommandKey(message);
    if (activeCommandKeys.has(commandKey)) {
      await say({
        text: "같은 테스트가 이미 진행 중입니다. 완료되면 이 스레드에 결과를 남길게요.",
        thread_ts: threadTs
      });
      return;
    }

    activeCommandKeys.add(commandKey);
    let resultThread = {
      channel: message.channel,
      threadTs
    };
    try {
      let resultTarget = null;
      const configuredResultChannel = resolveConfiguredResultChannel(message.text, config);
      if (configuredResultChannel) {
        try {
          resultTarget = await resolveSlackChannel(app.client, configuredResultChannel);
        } catch (error) {
          await say({
            text: `결과 채널 설정을 확인하지 못했습니다: ${error.message}`,
            thread_ts: threadTs
          });
          return;
        }
      }
      resultThread = await openResultThread({
        client: app.client,
        resultTarget,
        sourceMessage: message
      });

      if (/기본검증/i.test(String(message.text || ""))) {
        console.log(`[QA command] ${message.text}`);
      }
      if (shouldPostProgressMessage(message.text)) {
        await say({
          text: resultTarget ? formatDelegatedProgressMessage(resultTarget) : formatProgressMessage(message.text),
          thread_ts: threadTs
        });
      }

      const response = await routeCommand(message.text, {
        config,
        user: message.user,
        channel: resultThread.channel,
        threadTs: resultThread.threadTs
      });

      await app.client.chat.postMessage({
        channel: resultThread.channel,
        text: response,
        thread_ts: resultThread.threadTs
      });

      if (!isConsoleScheduleChangeCommand(message.text)) {
        try {
          const uploadedPdfs = await uploadPdfReports({
            client: app.client,
            config,
            channel: resultThread.channel,
            threadTs: resultThread.threadTs,
            responseText: response
          });
          if (shouldPostProgressMessage(message.text) && uploadedPdfs.length === 0) {
            await app.client.chat.postMessage({
              channel: resultThread.channel,
              text: "PDF 리포트 생성 대상을 찾지 못했습니다. 결과 메시지의 run_id와 reports 폴더를 확인해주세요.",
              thread_ts: resultThread.threadTs
            });
          }
        } catch (error) {
          console.error("Failed to upload PDF report:", error.stack || error.message);
          const message = String(error.message || "");
          const helpText = message.includes("missing_scope")
            ? "PDF 리포트 첨부에 실패했습니다: Slack 앱 권한에 files:write가 필요합니다. Slack 앱 OAuth Scopes에 files:write 추가 후 앱을 다시 설치해주세요."
            : `PDF 리포트 첨부에 실패했습니다: ${message}`;
          await app.client.chat.postMessage({
            channel: resultThread.channel,
            text: helpText,
            thread_ts: resultThread.threadTs
          });
        }
      }
    } catch (error) {
      console.error("QA command failed before result message was posted:", error.stack || error.message);
      const failureText = [
        "[FAIL] QA 자동화 실행",
        `검증 대상: ${message.text || ""}`,
        `실패 사유: ${error.message || error}`,
        "",
        "자동화 실행 중 예외가 발생해서 정상 결과 리포트를 만들지 못했습니다.",
        "봇 로그와 최신 reports 폴더를 확인해주세요."
      ].join("\n");

      try {
        await app.client.chat.postMessage({
          channel: resultThread.channel,
          text: failureText,
          thread_ts: resultThread.threadTs
        });
      } catch (postError) {
        console.error("Failed to post QA command failure message:", postError.stack || postError.message);
        await say({
          text: failureText,
          thread_ts: threadTs
        });
      }
    } finally {
      activeCommandKeys.delete(commandKey);
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

  app.message(TOSS_DEPOSIT_APPROVE_PATTERN, async ({ message, say }) => {
    await handleQaMessage(message, say);
  });

  app.message(/^\s*![\s\u200b\u200c\u200d\ufeff]*일정변경/i, async ({ message, say }) => {
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
