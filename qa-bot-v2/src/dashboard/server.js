const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");
const reports = require("./lib/reports");
const devices = require("./lib/devices");

const config = loadConfig();
const PORT = config.dashboard?.port || 4321;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function normalizeRemoteAddress(address = "") {
  const value = String(address || "").trim();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function ipv4ToInteger(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((result, part) => ((result << 8) | part) >>> 0, 0);
}

function matchesIpv4Cidr(address, cidr) {
  const [network, prefixText] = String(cidr).split("/");
  const addressValue = ipv4ToInteger(address);
  const networkValue = ipv4ToInteger(network);
  const prefix = Number(prefixText);
  if (addressValue === null || networkValue === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (networkValue & mask);
}

function isDashboardClientAllowed(address, allowedCidrs = []) {
  const normalized = normalizeRemoteAddress(address);
  if (normalized === "::1") return true;
  return allowedCidrs.some((cidr) => matchesIpv4Cidr(normalized, cidr));
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("요청 본문이 너무 큽니다."));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("요청 본문이 올바른 JSON이 아닙니다."));
      }
    });
    req.on("error", reject);
  });
}

async function postDashboardStartMessage(testId, platform, role, config) {
  if (!config.slackBotToken || !config.slackTestResultChannel) return null;

  const test = TEST_CATALOG.find((t) => t.id === testId);
  const clientLabel =
    platform === "ios" ? "iOS APP" : platform === "android" ? "Android APP" : test?.platform === "ios" ? "iOS APP" : test?.platform === "android" ? "Android APP" : "Android APP / iOS APP";
  const roleLabel = { guest: "게스트", host: "호스트", admin: "어드민" }[role] || role;
  const validationItem = `${roleLabel} ${test?.label || testId}`;

  try {
    const { WebClient } = require("@slack/web-api");
    const client = new WebClient(config.slackBotToken, { retryConfig: { retries: 1 } });
    const posted = await client.chat.postMessage({
      channel: config.slackTestResultChannel,
      text: [
        "자동화 테스트를 시작했습니다.",
        "완료되면 이 스레드에 결과를 남길게요.",
        "테스터: 대시보드",
        `클라이언트: ${clientLabel}`,
        `검증 항목: ${validationItem}`
      ].join("\n")
    });
    return { channel: config.slackTestResultChannel, threadTs: posted.ts };
  } catch (error) {
    console.warn("대시보드 시작 알림 전송 실패:", error.message);
    return null;
  }
}

async function postDashboardResultToSlack(result, config, thread) {
  if (!result || !config.slackBotToken || !config.slackTestResultChannel) return;

  let formatResult;
  try {
    ({ formatResult } = require("../slack/slack-reporter"));
  } catch (error) {
    console.warn("슬랙 결과 포맷 모듈 로드 실패, 알림을 건너뜁니다:", error.message);
    return;
  }

  try {
    const { WebClient } = require("@slack/web-api");
    const client = new WebClient(config.slackBotToken, { retryConfig: { retries: 1 } });
    await client.chat.postMessage({
      channel: thread?.channel || config.slackTestResultChannel,
      text: formatResult(result),
      thread_ts: thread?.threadTs
    });
  } catch (error) {
    console.warn("대시보드 실행 결과 슬랙 알림 실패:", error.message);
  }
}

const TEST_CATALOG = [
  { id: "login", label: "로그인", platform: "android" },
  { id: "logout", label: "로그아웃", platform: "android" },
  { id: "search", label: "정확한 일정 검색", platform: "android" },
  { id: "search-flexible", label: "유연한 일정 검색", platform: "android" },
  { id: "conversational-search", label: "대화형 검색", platform: "android" },
  {
    id: "contract-request",
    label: "계약 요청",
    platform: "android",
    extraFields: [
      {
        key: "payment_method",
        label: "결제수단 (분할결제 테스트 시 선택)",
        type: "select",
        optional: true,
        options: [
          { value: "", label: "(선택 안 함)" },
          { value: "card", label: "일반카드" },
          { value: "bank-transfer", label: "무통장" },
          { value: "auto-card", label: "등록카드" },
          { value: "split-payment", label: "분할결제" }
        ]
      }
    ]
  },
  { id: "contract-cancel-request", label: "계약 요청 취소", platform: "android" },
  { id: "contract-cancel-confirmed", label: "계약 확정 취소", platform: "android" },
  { id: "contract-extension", label: "계약 연장", platform: "android" },
  { id: "contract-extension-approve", label: "계약 연장 승인", platform: "android" },
  {
    id: "contract-payment",
    label: "계약 결제",
    platform: "android",
    extraFields: [
      {
        key: "payment_method",
        label: "결제수단",
        type: "select",
        options: [
          { value: "card", label: "일반카드" },
          { value: "bank-transfer", label: "무통장" },
          { value: "auto-card", label: "등록카드" },
          { value: "split-payment", label: "분할결제" }
        ]
      }
    ]
  },
  { id: "contract-approve", label: "계약 승인", platform: "android" },
  { id: "contract-reject", label: "계약 요청 거절", platform: "android" },
  { id: "toss-deposit-approve", label: "무통장 입금 승인 (토스)", platform: "android", fixedEnv: "toss" },
  {
    id: "console-schedule-change",
    label: "콘솔 일정 변경",
    platform: "android",
    fixedEnv: "api",
    extraFields: [{ key: "reservation_id", label: "예약 번호", type: "text" }]
  },
  {
    id: "console-deposit-return",
    label: "콘솔 보증금 반환/보류",
    platform: "android",
    extraFields: [
      { key: "reservation_id", label: "예약 번호", type: "text" },
      {
        key: "deposit_action",
        label: "처리 방식",
        type: "select",
        options: [
          { value: "반환", label: "반환" },
          { value: "보류", label: "보류" }
        ]
      }
    ]
  },
  { id: "review-profile", label: "리브후기 프로필", platform: "android" },
  { id: "review-schedule-select", label: "리브후기 일정선택", platform: "android" },
  { id: "review-detail", label: "리브후기 상세", platform: "android" },
  { id: "review-write", label: "리뷰 작성", platform: "android" },
  { id: "review-edit", label: "리뷰 수정", platform: "android" },
  { id: "review-delete", label: "리뷰 삭제", platform: "android" },
  { id: "coupon-box", label: "쿠폰함", platform: "android" },
  {
    id: "build-install",
    label: "빌드 설치",
    platform: "android",
    extraFields: [
      { key: "release_name", label: "릴리즈명 (선택)", type: "text", optional: true },
      { key: "build_version", label: "빌드 버전 (선택)", type: "text", optional: true }
    ]
  },
  {
    id: "ios-build-install",
    label: "빌드 설치",
    platform: "ios",
    extraFields: [{ key: "release_name", label: "릴리즈명 (선택)", type: "text", optional: true }]
  },
  { id: "ios-login", label: "로그인", platform: "ios" },
  { id: "ios-search", label: "정확한 일정 검색", platform: "ios" },
  { id: "ios-search-flexible", label: "유연한 일정 검색", platform: "ios" },
  { id: "ios-contract-request", label: "계약 요청", platform: "ios" },
  { id: "ios-contract-cancel-request", label: "계약 요청 취소", platform: "ios" }
];


function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

async function buildDeviceList() {
  const roles = ["guest", "host"];
  const result = [];

  for (const role of roles) {
    const androidSerial = config.devices?.[role];
    const androidState = await devices.getAndroidDeviceState(config.adbPath, androidSerial);
    const androidOs = androidState.connected
      ? await devices.getAndroidOsVersion(config.adbPath, androidSerial)
      : "";

    result.push({
      platform: "android",
      role,
      label: `안드로이드 · ${role === "guest" ? "게스트" : "호스트"}`,
      identifier: androidSerial || "",
      os: androidOs,
      connected: androidState.connected,
      reason: androidState.reason
    });

    const wdaUrl = config.appBuild?.ios?.wdaUrls?.[role];
    const wdaState = await devices.getWdaState(wdaUrl);

    result.push({
      platform: "ios",
      role,
      label: `iOS · ${role === "guest" ? "게스트" : "호스트"}`,
      identifier: config.appBuild?.ios?.devices?.[role] || "",
      os: "",
      connected: wdaState.connected,
      reason: wdaState.reason
    });
  }

  return result;
}

function platformOfTestId(testId) {
  return String(testId || "").toUpperCase().startsWith("TC-IOS") ? "ios" : "android";
}

function attachLastRunPerDevice(deviceList, recentRuns) {
  for (const device of deviceList) {
    const lastRun = recentRuns.find(
      (run) => run.role === device.role && platformOfTestId(run.test_id) === device.platform
    );
    device.lastRun = lastRun
      ? {
          name: lastRun.name,
          status: lastRun.status,
          duration_ms: lastRun.duration_ms,
          ran_at: lastRun.ran_at
        }
      : null;
  }
  return deviceList;
}

function isSafeSegment(segment) {
  return typeof segment === "string" && segment.length > 0 && !segment.includes("..") && !segment.includes("/");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (!isDashboardClientAllowed(req.socket.remoteAddress, config.dashboard?.allowedCidrs)) {
      sendJson(res, 403, { error: "dashboard access is restricted to the allowed network" });
      return;
    }

    if (pathname === "/api/test-catalog" && req.method === "GET") {
      sendJson(res, 200, { tests: TEST_CATALOG });
      return;
    }

    if (pathname === "/api/run-test" && req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      const testId = String(body.test || "");
      const selectedPlatform = String(body.platform || "");
      if (!TEST_CATALOG.some((t) => t.id === testId)) {
        sendJson(res, 400, { error: `알 수 없는 테스트입니다: ${testId}` });
        return;
      }
      if (!body.env) {
        sendJson(res, 400, { error: "env 값이 필요합니다." });
        return;
      }

      let runTest;
      try {
        runTest = require("../orchestrator/run-test").runTest;
      } catch (error) {
        console.error("테스트 실행 모듈 로드 실패:", error.message);
        sendJson(res, 500, {
          error:
            "테스트 실행 모듈을 불러오지 못했습니다. 이 서버에 전체 의존성(npm install)이 설치되어 있는지 확인해주세요."
        });
        return;
      }

      const request = {
        test: testId,
        env: body.env,
        role: body.role || "guest",
        payment_method: body.payment_method || undefined,
        split_start: body.split_start || undefined,
        split_end: body.split_end || undefined,
        reservation_id: body.reservation_id || undefined,
        deposit_action: body.deposit_action || undefined,
        release_name: body.release_name || undefined,
        build_version: body.build_version || undefined,
        requested_by: "dashboard",
        source: "dashboard"
      };

      // 결과를 기다리지 않고 즉시 응답 - 실제 실행은 백그라운드에서 진행되고
      // 완료되면 다른 실행들과 동일하게 reports/ 에 기록되어 실행 기록에서 확인 가능
      (async () => {
        const threadPromise = postDashboardStartMessage(testId, selectedPlatform, request.role, config);
        try {
          // 슬랙 !검증과 동일하게, 이 테스트가 사전 로그인이 필요한지 판단해서
          // 필요하면 실제 테스트 전에 로그인을 먼저 실행한다 (command-router.js와 같은 판단 로직 재사용)
          let loginRole = "";
          let buildLoginTestId = null;
          try {
            const router = require("../slack/command-router");
            if (typeof router.requiredLoginRoleForTest === "function") {
              loginRole = router.requiredLoginRoleForTest(testId);
            }
            buildLoginTestId = router.prerequisiteLoginTestFor;
          } catch (error) {
            console.warn("사전 로그인 판단 모듈 로드 실패, 사전 로그인 없이 진행:", error.message);
          }

          // contract-extension/contract-extension-approve는 슬랙에서도 사전 로그인 대신
          // "일단 실행해보고 세션 문제면 재시도"하는 lazy-login 방식이라 여기서는 건너뜀
          const usesLazyLogin = testId === "contract-extension" || testId === "contract-extension-approve";

          if (loginRole && buildLoginTestId && !usesLazyLogin) {
            const loginTestId = buildLoginTestId(testId);
            const loginResult = await runTest(
              {
                test: loginTestId,
                env: request.env,
                role: loginRole,
                host_home_only: loginRole === "host",
                requested_by: "dashboard",
                source: "dashboard-prerequisite"
              },
              config
            );
            if (loginResult && loginResult.status !== "pass") {
              console.warn(`[대시보드 사전 로그인 실패] ${testId}는 로그인 실패로 실행하지 않습니다.`);
              await postDashboardResultToSlack(loginResult, config, await threadPromise);
              return;
            }
          }

          const result = await runTest(request, config);
          await postDashboardResultToSlack(result, config, await threadPromise);
        } catch (error) {
          console.error(`[대시보드 테스트 실행 실패] ${testId}:`, error.message);
        }
      })();

      sendJson(res, 202, { started: true, test: testId });
      return;
    }

    if (pathname === "/api/config/devices") {
      sendJson(res, 200, {
        adbPath: config.adbPath,
        android: config.devices,
        ios: {
          devices: config.appBuild?.ios?.devices,
          wdaUrls: config.appBuild?.ios?.wdaUrls,
          bundleIds: config.appBuild?.ios?.bundleIds
        },
        androidPackages: config.androidPackages
      });
      return;
    }

    if (pathname === "/api/config/notifications") {
      sendJson(res, 200, {
        resultChannel: config.slackResultChannel || "",
        resultChannelAllowlist: config.slackResultChannelAllowlist || "",
        testResultChannel: config.slackTestResultChannel || "",
        testResultChannelAllowlist: config.slackTestResultChannelAllowlist || ""
      });
      return;
    }

    if (pathname === "/api/config/settings") {
      sendJson(res, 200, {
        reportBaseDir: config.reportBaseDir,
        dashboardPort: PORT,
        dryRun: config.dryRun,
        appBuildEnabled: Boolean(config.appBuild?.enabled),
        autoInstallLatestStaging: Boolean(config.appBuild?.autoInstallLatestStaging),
        firebaseProjectNumber: config.appBuild?.firebaseProjectNumber || "(미설정)"
      });
      return;
    }

    if (pathname === "/api/builds") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 100);
      const builds = reports.getBuildHistory(config.reportBaseDir, limit);
      sendJson(res, 200, builds);
      return;
    }

    if (pathname === "/api/team") {
      sendJson(res, 200, reports.getTeamActivity(config.reportBaseDir));
      return;
    }

    if (pathname === "/api/summary") {
      const stats = reports.getTodayStats(config.reportBaseDir);
      const trend = reports.getTrend(config.reportBaseDir, 7);
      const topFailing = reports.getTopFailingTests(config.reportBaseDir, 7, 5);
      sendJson(res, 200, { stats, trend, topFailing });
      return;
    }

    if (pathname === "/api/devices") {
      const recentRuns = reports.getRecentRuns(config.reportBaseDir, 30);
      const deviceList = await buildDeviceList();
      attachLastRunPerDevice(deviceList, recentRuns);
      sendJson(res, 200, deviceList);
      return;
    }

    if (pathname === "/api/runs/recent" && req.method === "DELETE") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 200);
      const result = reports.deleteRecentRuns(config.reportBaseDir, limit);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/runs") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 200);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const platform = url.searchParams.get("platform") || "";
      const status = url.searchParams.get("status") || "";
      const critical = url.searchParams.get("critical") === "true";
      const failureClass = url.searchParams.get("failureClass") || "";
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      const hasFilter = Boolean(platform || status || critical || failureClass || q);

      let allMatching;
      if (hasFilter) {
        allMatching = reports.getFilteredRuns(config.reportBaseDir, { platform, status, critical, failureClass, q }, 5000);
      } else {
        allMatching = null;
      }

      const total = hasFilter ? allMatching.length : reports.countAllRuns(config.reportBaseDir);
      const pageRuns = hasFilter
        ? allMatching.slice(offset, offset + limit)
        : reports.getRecentRuns(config.reportBaseDir, limit, offset);

      const runs = pageRuns.map((run) => ({
        run_id: run.run_id,
        name: run.name,
        test_id: run.test_id,
        env: run.env,
        role: run.role,
        device: run.device,
        status: run.status,
        failure_class: run.failure_class,
        duration_ms: run.duration_ms,
        ran_at: run.ran_at,
        requested_by: run.requested_by,
        source: run.source,
        error: run.error || null
      }));
      sendJson(res, 200, { runs, total, limit, offset });
      return;
    }

    if (pathname === "/api/screenshots" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const data = reports.getRunsWithScreenshots(config.reportBaseDir, { limit, offset });
      sendJson(res, 200, data);
      return;
    }

    if (pathname === "/api/screenshots" && req.method === "DELETE") {
      const result = reports.deleteAllScreenshots(config.reportBaseDir);
      sendJson(res, 200, result);
      return;
    }

    const screenshotFileMatch = pathname.match(/^\/api\/screenshots\/([^/]+)\/([^/]+)$/);
    if (screenshotFileMatch && req.method === "DELETE") {
      const [, runId, filename] = screenshotFileMatch;
      if (!isSafeSegment(runId) || !isSafeSegment(filename)) {
        sendJson(res, 400, { error: "invalid path" });
        return;
      }
      const deleted = reports.deleteScreenshotFile(config.reportBaseDir, runId, filename);
      sendJson(res, deleted ? 200 : 404, { deleted });
      return;
    }

    const screenshotRunMatch = pathname.match(/^\/api\/screenshots\/([^/]+)$/);
    if (screenshotRunMatch && req.method === "DELETE") {
      const [, runId] = screenshotRunMatch;
      if (!isSafeSegment(runId)) {
        sendJson(res, 400, { error: "invalid path" });
        return;
      }
      const deletedCount = reports.deleteRunScreenshots(config.reportBaseDir, runId);
      sendJson(res, 200, { deletedCount });
      return;
    }

    const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runDetailMatch) {
      const runId = runDetailMatch[1];
      if (!isSafeSegment(runId)) {
        sendJson(res, 400, { error: "invalid run_id" });
        return;
      }
      const run = reports.readResult(config.reportBaseDir, runId);
      if (!run) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const runDir = path.join(config.reportBaseDir, runId);
      const listSafe = (sub) => {
        const dir = path.join(runDir, sub);
        return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      };
      run.artifact_files = {
        screenshots: listSafe("screenshots"),
        logs: listSafe("logs")
      };
      sendJson(res, 200, run);
      return;
    }

    const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)\/(screenshots|logs)\/([^/]+)$/);
    if (artifactMatch) {
      const [, runId, kind, filename] = artifactMatch;
      if (!isSafeSegment(runId) || !isSafeSegment(filename)) {
        res.writeHead(400);
        res.end("invalid path");
        return;
      }
      const filePath = path.join(config.reportBaseDir, runId, kind, filename);
      serveStaticFile(res, filePath);
      return;
    }

    const staticPath = pathname === "/" ? "/index.html" : pathname;
    const resolved = path.join(PUBLIC_DIR, staticPath);
    if (!resolved.startsWith(PUBLIC_DIR)) {
      res.writeHead(400);
      res.end("invalid path");
      return;
    }
    serveStaticFile(res, resolved);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

function startDashboardServer() {
  if (server.listening) return Promise.resolve(server);

  return new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);
    server.once("error", handleError);
    server.listen(PORT, () => {
      server.off("error", handleError);
      console.log(`QA Ops 대시보드: http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startDashboardServer().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  isDashboardClientAllowed,
  startDashboardServer
};
