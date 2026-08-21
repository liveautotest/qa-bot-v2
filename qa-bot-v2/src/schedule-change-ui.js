const SCHEDULE_CHANGE_MODAL_CALLBACK_ID = "qa_schedule_change_submit";
const SCHEDULE_CHANGE_OPEN_ACTION_ID = "qa_schedule_change_open";

const SCHEDULE_CHANGE_OPTIONS = [
  { label: "일주일 전", value: "일주일 전" },
  { label: "2주일 전", value: "2주일 전" },
  { label: "한달 전", value: "한달 전" },
  { label: "일주일 후", value: "일주일 후" },
  { label: "2주일 후", value: "2주일 후" },
  { label: "한달 후", value: "한달 후" }
];

function plainText(text) {
  return { type: "plain_text", text, emoji: true };
}

function buildScheduleChangeModal(privateMetadata) {
  return {
    type: "modal",
    callback_id: SCHEDULE_CHANGE_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(privateMetadata),
    title: plainText("일정 변경"),
    submit: plainText("시작"),
    close: plainText("취소"),
    blocks: [
      {
        type: "input",
        block_id: "reservation_id",
        label: plainText("계약 ID"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: plainText("계약 ID 입력"),
          min_length: 1,
          max_length: 20
        }
      },
      {
        type: "input",
        block_id: "change_date",
        label: plainText("변경 날짜"),
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: plainText("변경 날짜 선택"),
          options: SCHEDULE_CHANGE_OPTIONS.map((option) => ({
            text: plainText(option.label),
            value: option.value
          }))
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
            { text: plainText("dev"), value: "dev" }
          ]
        }
      }
    ]
  };
}

function selectedValue(view, blockId) {
  return view.state.values?.[blockId]?.value || {};
}

function parseSubmission(view) {
  const reservationId = String(selectedValue(view, "reservation_id").value || "").trim();
  const changeDate = selectedValue(view, "change_date").selected_option?.value || "";
  const env = selectedValue(view, "environment").selected_option?.value || "stg";

  if (!/^\d+$/.test(reservationId)) {
    throw Object.assign(new Error("계약 ID는 숫자로 입력해주세요."), {
      blockId: "reservation_id"
    });
  }
  if (!SCHEDULE_CHANGE_OPTIONS.some((option) => option.value === changeDate)) {
    throw Object.assign(new Error("변경 날짜를 다시 선택해주세요."), {
      blockId: "change_date"
    });
  }

  return {
    reservationId,
    changeDate,
    env,
    displayTarget: `계약 ${reservationId} / ${changeDate} / ${env}`,
    commandText: `!일정변경 ${reservationId} ${changeDate} ${env}`
  };
}

function buildScheduleChangeOpenBlocks(metadata) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*변경할 계약과 날짜 기준을 선택해 주세요.*"
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SCHEDULE_CHANGE_OPEN_ACTION_ID,
          text: plainText("일정 변경 선택"),
          style: "primary",
          value: JSON.stringify(metadata)
        }
      ]
    }
  ];
}

function registerScheduleChangeUi(app, { runQaCommand } = {}) {
  app.message(/^\s*!일정변경\s*$/i, async ({ message, client }) => {
    const threadTs = message.thread_ts || message.ts;
    const posted = await client.chat.postMessage({
      channel: message.channel,
      text: "일정 변경 항목을 입력해 주세요.",
      thread_ts: threadTs,
      blocks: buildScheduleChangeOpenBlocks({
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
        text: "일정 변경 항목을 입력해 주세요.",
        blocks: buildScheduleChangeOpenBlocks({
          channel: message.channel,
          threadTs,
          promptTs: posted.ts,
          user: message.user
        })
      });
    }
  });

  app.action(SCHEDULE_CHANGE_OPEN_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    let metadata = {};
    try {
      metadata = JSON.parse(body.actions?.[0]?.value || "{}");
    } catch {
      metadata = {};
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildScheduleChangeModal({
        channel: metadata.channel || body.channel?.id,
        threadTs: metadata.threadTs || body.message?.ts,
        promptTs: metadata.promptTs,
        user: body.user?.id
      })
    });
  });

  app.view(SCHEDULE_CHANGE_MODAL_CALLBACK_ID, async ({ ack, body, view, client }) => {
    let submission;
    try {
      submission = parseSubmission(view);
    } catch (error) {
      await ack({
        response_action: "errors",
        errors: {
          [error.blockId || "reservation_id"]: error.message || String(error)
        }
      });
      return;
    }
    await ack();

    let metadata = {};
    try {
      metadata = JSON.parse(view.private_metadata || "{}");
    } catch {
      metadata = {};
    }

    if (metadata.channel && metadata.promptTs) {
      await client.chat.update({
        channel: metadata.channel,
        ts: metadata.promptTs,
        text: `일정 변경을 시작했습니다: ${submission.displayTarget}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*일정 변경을 시작했습니다.*\n변경 대상: ${submission.displayTarget}`
            }
          }
        ]
      }).catch(() => undefined);
    }

    if (!runQaCommand) {
      await client.chat.postMessage({
        channel: metadata.channel,
        thread_ts: metadata.threadTs,
        text: "일정 변경 실행 핸들러가 연결되지 않았습니다."
      });
      return;
    }

    await runQaCommand({
      channel: metadata.channel,
      thread_ts: metadata.threadTs,
      ts: metadata.threadTs,
      text: submission.commandText,
      displayText: submission.displayTarget,
      user: metadata.user || body.user.id
    });
  });
}

module.exports = {
  buildScheduleChangeModal,
  parseSubmission,
  registerScheduleChangeUi
};
