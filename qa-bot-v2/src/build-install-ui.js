const { getFirebaseReleases } = require("./tests/build-install.test");

const BUILD_INSTALL_MODAL_CALLBACK_ID = "qa_build_install_submit";
const BUILD_INSTALL_OPEN_ACTION_ID = "qa_build_install_open";
const BUILD_INSTALL_ENV_ACTION_ID = "qa_build_install_env";

function plainText(text) {
  return { type: "plain_text", text, emoji: true };
}

function normalizeEnv(env) {
  return env === "stg" ? "staging" : env;
}

function shortEnv(env) {
  return normalizeEnv(env) === "dev" ? "dev" : "stg";
}

function releaseLabel(release, { latest = false } = {}) {
  const version = release.displayVersion || "unknown";
  const build = release.buildVersion || "unknown";
  const createdAt = release.createTime ? ` / ${release.createTime.slice(0, 10)}` : "";
  return `${latest ? "[최신] " : ""}${version} (${build})${createdAt}`;
}

function releaseValue(release, env) {
  return JSON.stringify({
    env: shortEnv(env),
    buildVersion: String(release.buildVersion || "")
  });
}

async function buildReleaseOptions(config, env) {
  try {
    // 모달을 열거나 환경을 바꿀 때는 최신 목록을 강제로 받고,
    // 선택 후 설치 단계에서는 이 결과를 재사용한다.
    const releases = await getFirebaseReleases(config, normalizeEnv(env), 30, { forceRefresh: true });
    if (!releases.length) {
      return [{ text: plainText("Firebase 릴리즈 없음"), value: JSON.stringify({ error: "no-release" }) }];
    }

    const sortedReleases = [...releases].sort((left, right) => {
      const timeDiff = Date.parse(right.createTime || 0) - Date.parse(left.createTime || 0);
      if (timeDiff) return timeDiff;
      return Number(right.buildVersion || 0) - Number(left.buildVersion || 0);
    });

    return sortedReleases.slice(0, 20).map((release, index) => ({
      text: plainText(releaseLabel(release, { latest: index === 0 }).slice(0, 75)),
      value: releaseValue(release, env)
    }));
  } catch (error) {
    return [{
      text: plainText("Firebase 설정 확인 필요"),
      value: JSON.stringify({ error: error.message || String(error) })
    }];
  }
}

function selectedValue(view, blockId) {
  const block = view.state.values?.[blockId] || {};
  return block.value || block[BUILD_INSTALL_ENV_ACTION_ID] || Object.values(block)[0] || {};
}

function buildLoadingReleaseOptions(message = "Firebase 릴리즈 조회 중") {
  return [{ text: plainText(message), value: JSON.stringify({ error: message }) }];
}

async function buildInstallModal(privateMetadata, config, env = "stg", { releaseOptions } = {}) {
  const options = releaseOptions || await buildReleaseOptions(config, env);
  return {
    type: "modal",
    callback_id: BUILD_INSTALL_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ ...privateMetadata, env: shortEnv(env) }),
    title: plainText("빌드 설치"),
    submit: plainText("시작"),
    close: plainText("취소"),
    blocks: [
      {
        type: "input",
        block_id: "tester",
        label: plainText("테스터/단말"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("테스터/단말 선택"),
          initial_option: { text: plainText("게스트 단말"), value: "guest" },
          options: [
            { text: plainText("게스트 단말"), value: "guest" },
            { text: plainText("호스트 단말"), value: "host" }
          ]
        }
      },
      {
        type: "input",
        block_id: "environment",
        dispatch_action: true,
        label: plainText("환경"),
        element: {
          type: "static_select",
          action_id: BUILD_INSTALL_ENV_ACTION_ID,
          placeholder: plainText("환경 선택"),
          initial_option: { text: plainText(shortEnv(env)), value: shortEnv(env) },
          options: [
            { text: plainText("stg"), value: "stg" },
            { text: plainText("dev"), value: "dev" }
          ]
        }
      },
      {
        type: "input",
        block_id: "build",
        label: plainText("빌드 버전"),
        element: {
          type: "static_select",
          // Slack은 같은 block_id/action_id의 기존 선택값을 views.update 후에도 보존한다.
          // 환경별 action_id로 staging 빌드 선택값이 dev 목록에 남지 않게 한다.
          action_id: `build_${shortEnv(env)}`,
          placeholder: plainText("빌드 버전 선택"),
          options
        }
      }
    ]
  };
}

function buildInstallOpenBlocks(metadata) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*설치할 빌드를 선택해 주세요.*\n버튼을 누르면 테스터, 환경, 빌드 버전을 선택할 수 있습니다."
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: BUILD_INSTALL_OPEN_ACTION_ID,
          text: plainText("빌드 선택 열기"),
          style: "primary",
          value: JSON.stringify(metadata)
        }
      ]
    }
  ];
}

function parseSubmission(view) {
  const testerRole = selectedValue(view, "tester").selected_option?.value || "guest";
  const env = selectedValue(view, "environment").selected_option?.value || "stg";
  const buildOption = selectedValue(view, "build").selected_option || {};
  const buildRaw = buildOption.value || "";
  const build = buildRaw.startsWith("{")
    ? JSON.parse(buildRaw)
    : {
      buildVersion: buildRaw,
      displayVersion: buildOption.text?.text || buildRaw
    };

  if (build.error) {
    throw new Error(`빌드 목록을 가져오지 못했습니다: ${build.error}`);
  }
  if (build.env && build.env !== env) {
    throw new Error(`${env} 환경의 빌드 목록이 아닙니다. 환경을 다시 선택한 뒤 빌드를 선택해주세요.`);
  }

  return {
    testerRole,
    env,
    build,
    displayTarget: `빌드설치 ${testerRole} ${env} ${build.displayVersion || build.buildVersion || ""}`.trim(),
    commandText: [
      "!qa build-install",
      `env=${env === "stg" ? "staging" : env}`,
      `role=${testerRole}`,
      build.buildVersion ? `build_version=${build.buildVersion}` : ""
    ].filter(Boolean).join(" ")
  };
}

function registerBuildInstallUi(app, { config, runQaCommand } = {}) {
  app.message(/^\s*!빌드설치\s*$/i, async ({ message, client }) => {
    const threadTs = message.thread_ts || message.ts;
    const posted = await client.chat.postMessage({
      channel: message.channel,
      text: "빌드 설치 항목을 선택해 주세요.",
      thread_ts: threadTs,
      blocks: buildInstallOpenBlocks({
        channel: message.channel,
        threadTs,
        promptTs: "",
        user: message.user
      })
    });

    if (posted?.ts) {
      await client.chat.update({
        channel: message.channel,
        ts: posted.ts,
        text: "빌드 설치 항목을 선택해 주세요.",
        blocks: buildInstallOpenBlocks({
          channel: message.channel,
          threadTs,
          promptTs: posted.ts,
          user: message.user
        })
      });
    }
  });

  app.action(BUILD_INSTALL_OPEN_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    let metadata = {};
    try {
      metadata = JSON.parse(body.actions?.[0]?.value || "{}");
    } catch {
      metadata = {};
    }

    const privateMetadata = {
      channel: metadata.channel || body.channel?.id,
      threadTs: metadata.threadTs || body.message?.ts,
      promptTs: metadata.promptTs,
      user: body.user?.id
    };

    try {
      // Slack trigger_id는 수명이 짧다. 모달은 먼저 즉시 열고, Firebase 릴리즈 목록은 비동기로 채운다.
      const opened = await client.views.open({
        trigger_id: body.trigger_id,
        view: await buildInstallModal(privateMetadata, config, "stg", {
          releaseOptions: buildLoadingReleaseOptions()
        })
      });

      const viewId = opened.view?.id;
      if (!viewId) return;

      const releaseOptions = await buildReleaseOptions(config, "stg");
      await client.views.update({
        view_id: viewId,
        view: await buildInstallModal(privateMetadata, config, "stg", { releaseOptions })
      });
    } catch (error) {
      if (privateMetadata.channel) {
        await client.chat.postMessage({
          channel: privateMetadata.channel,
          thread_ts: privateMetadata.threadTs,
          text: `빌드 선택창을 열지 못했습니다: ${error.message || error}`
        }).catch(() => undefined);
      } else {
        console.error(`빌드 선택창을 열지 못했습니다: ${error.message || error}`);
      }
    }
  });

  app.action(BUILD_INSTALL_ENV_ACTION_ID, async ({ ack, body, view, client }) => {
    await ack();
    const env = body.actions?.[0]?.selected_option?.value || "stg";
    const activeView = view || body.view;
    if (!activeView?.id) {
      console.error(`${env} 빌드 목록을 갱신하지 못했습니다: Slack modal view 정보가 없습니다.`);
      return;
    }
    let metadata = {};
    try {
      metadata = JSON.parse(activeView.private_metadata || "{}");
    } catch {
      metadata = {};
    }

    try {
      await client.views.update({
        view_id: activeView.id,
        hash: activeView.hash,
        view: await buildInstallModal(metadata, config, env, {
          releaseOptions: buildLoadingReleaseOptions(`${env} 최신 릴리즈 조회 중`)
        })
      });

      const releaseOptions = await buildReleaseOptions(config, env);
      await client.views.update({
        view_id: activeView.id,
        view: await buildInstallModal(metadata, config, env, { releaseOptions })
      });
    } catch (error) {
      if (metadata.channel) {
        await client.chat.postMessage({
          channel: metadata.channel,
          thread_ts: metadata.threadTs,
          text: `${env} 빌드 목록을 갱신하지 못했습니다: ${error.message || error}`
        }).catch(() => undefined);
      } else {
        console.error(`${env} 빌드 목록을 갱신하지 못했습니다: ${error.message || error}`);
      }
    }
  });

  app.view(BUILD_INSTALL_MODAL_CALLBACK_ID, async ({ ack, body, view, client }) => {
    let metadata = {};
    try {
      metadata = JSON.parse(view.private_metadata || "{}");
    } catch {
      metadata = {};
    }

    if (!metadata.channel) {
      await ack({
        response_action: "errors",
        errors: {
          build: "실행 채널 정보를 찾지 못했습니다. 모달을 닫고 !빌드설치부터 다시 실행해주세요."
        }
      });
      return;
    }

    let submission;
    try {
      submission = parseSubmission(view);
    } catch (error) {
      await ack({
        response_action: "errors",
        errors: {
          build: error.message || String(error)
        }
      });
      return;
    }
    await ack();

    const channel = metadata.channel;
    if (channel && metadata.promptTs) {
      await client.chat.update({
        channel,
        ts: metadata.promptTs,
        text: `빌드 설치를 시작했습니다: ${submission.displayTarget}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*빌드 설치를 시작했습니다.*\n설치 대상: ${submission.displayTarget}`
            }
          }
        ]
      }).catch(() => undefined);
    }

    await runQaCommand({
      channel,
      thread_ts: metadata.threadTs,
      ts: metadata.threadTs,
      text: submission.commandText,
      displayText: submission.displayTarget,
      user: metadata.user || body.user.id
    });
  });
}

module.exports = {
  buildInstallModal,
  parseSubmission,
  registerBuildInstallUi
};
