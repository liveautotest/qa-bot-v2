const VALIDATION_MODAL_CALLBACK_ID = "qa_validation_lab_submit";
const VALIDATION_OPEN_ACTION_ID = "qa_validation_lab_open";
const VALIDATION_ITEMS = [
  {
    label: "게스트 로그인",
    commandTemplate: (env) => `!게스트 로그인 ${env}`,
    iosCommandTemplate: (env) => `!qa ios-login env=${env === "stg" ? "staging" : env} role=guest`
  },
  { label: "호스트 로그인", commandTemplate: (env) => `!호스트 로그인 ${env}` },
  { label: "정확한 일정 검색", commandTemplate: (env) => `!게스트 검색 정확한일정 ${env}` },
  { label: "유연한 일정 검색", commandTemplate: (env) => `!게스트 검색 유연한일정 ${env}` },
  {
    label: "대화형 검색 (준비 중)",
    value: "대화형 검색",
    ready: false,
    commandTemplate: (env) => `!게스트 대화형 검색 ${env}`
  },
  { label: "게스트 계약 요청", commandTemplate: (env) => `!게스트 계약 요청 ${env}` },
  { label: "게스트 계약 요청 취소", commandTemplate: (env) => `!게스트 계약 요청 취소 ${env}` },
  { label: "호스트 계약 승인", commandTemplate: (env) => `!호스트 계약 승인 ${env}` },
  { label: "호스트 계약 요청 거절", commandTemplate: (env) => `!호스트 계약 요청 거절 ${env}` },
  { label: "게스트 연장요청", commandTemplate: (env) => `!게스트 연장요청 ${env}` },
  { label: "호스트 연장수락", commandTemplate: (env) => `!호스트 연장수락 ${env}` },
  { label: "일반결제", commandLabel: "일반결제" },
  { label: "무통장 결제", commandLabel: "무통장 결제" },
  { label: "등록카드결제", commandLabel: "등록카드결제" },
  { label: "분할결제", commandLabel: "분할결제" },
  { label: "연장결제 카드", commandLabel: "연장결제 카드" },
  { label: "연장결제 무통장", commandLabel: "연장결제 무통장" },
  { label: "계약 확정 취소", commandTemplate: (env) => `!게스트 계약 확정 취소 ${env}` }
];

function plainText(text) {
  return { type: "plain_text", text, emoji: true };
}

function buildValidationModal(privateMetadata) {
  return {
    type: "modal",
    callback_id: VALIDATION_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(privateMetadata),
    title: plainText("검증 선택"),
    submit: plainText("시작"),
    close: plainText("취소"),
    blocks: [
      {
        type: "input",
        block_id: "tester",
        label: plainText("테스터"),
        element: {
          type: "users_select",
          action_id: "value",
          placeholder: plainText("테스터 선택")
        }
      },
      {
        type: "input",
        block_id: "client",
        label: plainText("클라이언트"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("클라이언트 선택"),
          initial_option: { text: plainText("Android APP"), value: "android-app" },
          options: [
            { text: plainText("Android APP"), value: "android-app" },
            { text: plainText("iOS APP"), value: "ios-app" },
            { text: plainText("PC (준비 중)"), value: "pc" }
          ]
        }
      },
      {
        type: "input",
        block_id: "environment",
        label: plainText("환경"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("환경 선택"),
          initial_option: { text: plainText("stg"), value: "stg" },
          options: [
            { text: plainText("stg"), value: "stg" },
            { text: plainText("dev"), value: "dev" },
            { text: plainText("Prod (준비 중)"), value: "prod" }
          ]
        }
      },
      {
        type: "input",
        block_id: "validation_item",
        label: plainText("검증 항목"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("검증 항목 선택"),
          options: VALIDATION_ITEMS.map((item) => ({
            text: plainText(item.label),
            value: item.value || item.commandLabel || item.label
          }))
        }
      }
    ]
  };
}

function selectedValue(view, blockId) {
  return view.state.values?.[blockId]?.value || {};
}

function parseSubmission(view) {
  const tester = selectedValue(view, "tester").selected_user || "";
  const env = selectedValue(view, "environment").selected_option?.value || "stg";
  const client = selectedValue(view, "client").selected_option?.value || "android-app";
  const validationItem = selectedValue(view, "validation_item").selected_option?.value || "";
  const item = VALIDATION_ITEMS.find((candidate) => (candidate.value || candidate.label) === validationItem);
  const commandText = client === "ios-app"
    ? item?.iosCommandTemplate?.(env) || ""
    : item?.commandTemplate
      ? item.commandTemplate(env)
      : `!기본검증 ${validationItem} ${env}`;
  const clientLabel = client === "ios-app" ? "iOS APP" : client === "pc" ? "PC" : "Android APP";
  const displayTarget = `${clientLabel} · ${validationItem} ${env}`;

  return {
    tester,
    env,
    client,
    validationItem,
    validationReady: item?.ready !== false,
    clientSupported: client !== "ios-app" || Boolean(item?.iosCommandTemplate),
    displayTarget,
    commandText
  };
}

function buildValidationOpenBlocks(metadata) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*검증 항목을 선택해 주세요.*\n버튼을 누르면 테스터, 클라이언트, 환경, 검증 항목을 선택할 수 있습니다."
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: VALIDATION_OPEN_ACTION_ID,
          text: plainText("검증 선택 열기"),
          style: "primary",
          value: JSON.stringify(metadata)
        }
      ]
    }
  ];
}

function registerValidationUiLab(app, { runQaCommand } = {}) {
  // Slack Socket Mode 연결은 본 봇(src/app.js) 하나만 사용한다.
  // /검증 UI는 이 함수로 핸들러만 등록해서 이벤트 수신 충돌을 막는다.
  app.command("/검증", async ({ ack, body, client, respond }) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildValidationModal({
          channel: body.channel_id,
          user: body.user_id
        })
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: `검증 선택창을 열지 못했습니다: ${error.message || error}`
      });
    }
  });

  app.message(/^\s*!검증\s*$/i, async ({ message, client }) => {
    const threadTs = message.thread_ts || message.ts;
    const posted = await client.chat.postMessage({
      channel: message.channel,
      text: "검증 항목을 선택해 주세요.",
      thread_ts: threadTs,
      blocks: buildValidationOpenBlocks({
        channel: message.channel,
        threadTs,
        promptTs: "",
        user: message.user
      })
    });

    const promptTs = posted?.ts;
    if (promptTs) {
      await client.chat.update({
        channel: message.channel,
        ts: promptTs,
        text: "검증 항목을 선택해 주세요.",
        blocks: buildValidationOpenBlocks({
          channel: message.channel,
          threadTs,
          promptTs,
          user: message.user
        })
      });
    }
  });

  app.action(VALIDATION_OPEN_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    let metadata = {};
    try {
      metadata = JSON.parse(body.actions?.[0]?.value || "{}");
    } catch {
      metadata = {};
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildValidationModal({
        channel: metadata.channel || body.channel?.id,
        threadTs: metadata.threadTs || body.message?.ts,
        promptTs: metadata.promptTs,
        user: body.user?.id
      })
    });
  });

  app.view(VALIDATION_MODAL_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const submission = parseSubmission(view);
    const errors = {};
    if (submission.client === "pc") {
      errors.client = "PC 검증은 준비 중입니다.";
    }
    if (submission.client === "ios-app" && !submission.clientSupported) {
      errors.validation_item = "iOS APP은 현재 게스트 로그인만 실행할 수 있습니다.";
    }
    if (submission.env === "prod") {
      errors.environment = "Prod 검증은 준비 중입니다. 현재는 stg 또는 dev만 선택할 수 있습니다.";
    }
    if (!submission.validationReady) {
      errors.validation_item = "대화형 검색은 개발 빌드 배포 전 준비 중입니다.";
    }
    if (Object.keys(errors).length) {
      await ack({
        response_action: "errors",
        errors
      });
      return;
    }

    await ack();
    const metadata = JSON.parse(view.private_metadata || "{}");
    const channel = metadata.channel;

    if (channel && metadata.promptTs) {
      await client.chat.update({
        channel,
        ts: metadata.promptTs,
        text: `검증을 시작했습니다: ${submission.displayTarget}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*검증을 시작했습니다.*\n검증 대상: ${submission.displayTarget}`
            }
          }
        ]
      }).catch(() => undefined);
    }

    if (!runQaCommand) {
      await client.chat.postMessage({
        channel,
        thread_ts: metadata.threadTs,
        text: [
          "검증 UI 실행 핸들러가 연결되지 않았습니다.",
          `검증 대상: ${submission.displayTarget}`
        ].join("\n")
      });
      return;
    }

    let threadTs = metadata.threadTs;
    if (!threadTs) {
      const seed = await client.chat.postMessage({
        channel,
        text: [
          "검증 UI에서 선택한 항목으로 자동화를 시작합니다.",
          `검증 대상: ${submission.displayTarget}`
        ].join("\n")
      });
      threadTs = seed.ts;
    }

    await runQaCommand({
      channel,
      thread_ts: threadTs,
      ts: threadTs,
      text: submission.commandText,
      displayText: submission.displayTarget,
      user: submission.tester || body.user.id
    });
  });
}

if (require.main === module) {
  console.log("/검증 UI는 src/app.js 본 봇에 등록해서 사용합니다. 별도 Socket Mode 프로세스로 실행하지 않습니다.");
}

module.exports = {
  buildValidationModal,
  parseSubmission,
  registerValidationUiLab
};
