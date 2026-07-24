const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

function addStep(steps, name, status = "pass", message) {
  const step = { name, status };
  if (message) step.message = message;
  steps.push(step);
}

function fail(message, steps, details = []) {
  const error = new Error(message);
  error.steps = steps;
  error.details = details;
  throw error;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-");
}

function formatApiDate(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    date: date.getDate()
  };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function parseOffset(offsetLabel) {
  const normalized = String(offsetLabel || "").replace(/\s+/g, "");
  const offsets = {
    "일주일전": { unit: "week", amount: -1, label: "일주일 전" },
    "2주일전": { unit: "week", amount: -2, label: "2주일 전" },
    "2주전": { unit: "week", amount: -2, label: "2주일 전" },
    "한달전": { unit: "month", amount: -1, label: "한달 전" },
    "1달전": { unit: "month", amount: -1, label: "한달 전" },
    "일주일후": { unit: "week", amount: 1, label: "일주일 후" },
    "2주후": { unit: "week", amount: 2, label: "2주 후" },
    "2주일후": { unit: "week", amount: 2, label: "2주 후" },
    "한달후": { unit: "month", amount: 1, label: "한달 후" },
    "1달후": { unit: "month", amount: 1, label: "한달 후" }
  };
  return offsets[normalized] || null;
}

function computePeriod(offsetLabel, now = new Date()) {
  const offset = parseOffset(offsetLabel);
  if (!offset) return null;

  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = offset.unit === "month"
    ? addMonths(base, offset.amount)
    : addDays(base, offset.amount * 7);
  const end = addDays(start, 7);

  return {
    label: offset.label,
    start,
    end,
    startDate: formatDate(start),
    endDate: formatDate(end),
    startApiDate: formatApiDate(start),
    endApiDate: formatApiDate(end)
  };
}

function buildHeaders(config, body) {
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  };

  if (config.qaApi.authHeader) {
    headers.authorization = config.qaApi.authHeader;
  } else if (config.qaApi.token) {
    headers.authorization = `Bearer ${config.qaApi.token}`;
  }
  if (config.qaApi.cookie) {
    headers.cookie = config.qaApi.cookie;
  }

  return headers;
}

function requestJson(url, { method, headers, body }) {
  const target = new URL(url);
  const client = target.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          let parsed = responseBody;
          try {
            parsed = responseBody ? JSON.parse(responseBody) : null;
          } catch (_) {
            parsed = responseBody;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            rawBody: responseBody
          });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("API request timed out after 30000ms"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function safeWriteJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getResponseMessage(response) {
  return (
    response.body?.body?.message ||
    response.body?.message ||
    response.rawBody ||
    ""
  );
}

async function runScheduleChangeTest({ request, config, store }) {
  const steps = [];
  const reservationId = String(request.reservation_id || "").trim();
  const period = computePeriod(request.offset_label || request.offset || "");

  if (!reservationId) {
    fail("계약 변경 예약 번호가 없습니다.", steps, [
      "예: !146183 계약 변경 일주일 후"
    ]);
  }

  if (!period) {
    fail("계약 변경 기간을 해석하지 못했습니다.", steps, [
      "지원 표현: 일주일 전, 2주일전, 한달전, 일주일 후, 2주 후, 한달 후"
    ]);
  }
  addStep(steps, "계약 변경 기간 계산", "pass", `${period.label}: ${period.startDate} ~ ${period.endDate}`);

  if (!config.qaApi.baseUrl) {
    fail("QA_API_BASE_URL이 설정되지 않았습니다.", steps, [
      ".env에 QA_API_BASE_URL=https://... 형식으로 API 서버 주소를 넣어주세요.",
      "인증이 필요한 API면 QA_API_TOKEN 또는 QA_API_COOKIE도 함께 설정해주세요."
    ]);
  }
  addStep(steps, "API 설정 확인");

  const body = JSON.stringify({
    start_date: period.startApiDate,
    end_date: period.endApiDate
  });
  const endpoint = `/v1/reservations/${encodeURIComponent(reservationId)}/unusually-reschedule`;
  const url = new URL(endpoint, config.qaApi.baseUrl).toString();
  const requestPayload = {
    method: "POST",
    url,
    body: JSON.parse(body)
  };
  safeWriteJson(path.join(store.logsDir, "schedule-change-request.json"), requestPayload);

  const response = await requestJson(url, {
    method: "POST",
    headers: buildHeaders(config, body),
    body
  });
  safeWriteJson(path.join(store.logsDir, "schedule-change-response.json"), response);
  addStep(steps, "계약 일정 변경 API 호출", "pass", `HTTP ${response.statusCode}`);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const responseMessage = getResponseMessage(response);
    const details = [
      "리포트의 logs/schedule-change-request.json 요청값을 확인해주세요.",
      "리포트의 logs/schedule-change-response.json 응답값을 확인해주세요."
    ];
    if (response.statusCode === 401) {
      details.unshift(
        "API가 Authentication required를 반환했습니다.",
        ".env에 QA_API_AUTH_HEADER=Bearer ... 또는 QA_API_TOKEN=... 값을 설정해야 합니다.",
        "세션 쿠키 방식이면 QA_API_COOKIE=... 값을 설정해주세요."
      );
    }
    if (responseMessage) {
      details.unshift(`API 응답 메시지: ${responseMessage}`);
    }
    fail(`계약 일정 변경 API가 실패했습니다. HTTP ${response.statusCode}`, steps, [
      ...details
    ]);
  }

  return {
    test_id: "TC-SCHEDULE-CHANGE-001",
    name: "계약 일정 변경",
    env: "api",
    status: "pass",
    device: "api",
    steps,
    schedule_change: {
      reservation_id: reservationId,
      offset: period.label,
      type: "PERIOD",
      start_date: period.startDate,
      end_date: period.endDate,
      endpoint,
      applies_price_recalculation: false,
      status_code: response.statusCode
    },
    artifacts: {
      logs: [
        path.join(store.logsDir, "schedule-change-request.json"),
        path.join(store.logsDir, "schedule-change-response.json")
      ]
    }
  };
}

module.exports = {
  computePeriod,
  parseOffset,
  runScheduleChangeTest
};
