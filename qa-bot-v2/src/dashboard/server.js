const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");
const reports = require("./lib/reports");
const devices = require("./lib/devices");

const config = loadConfig();
const PORT = Number(process.env.DASHBOARD_PORT || 4321);
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

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

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

    if (pathname === "/api/runs") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 200);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const platform = url.searchParams.get("platform") || "";
      const status = url.searchParams.get("status") || "";
      const critical = url.searchParams.get("critical") === "true";
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      const hasFilter = Boolean(platform || status || critical || q);

      let allMatching;
      if (hasFilter) {
        allMatching = reports.getFilteredRuns(config.reportBaseDir, { platform, status, critical, q }, 5000);
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

server.listen(PORT, () => {
  console.log(`QA Ops 대시보드: http://localhost:${PORT}`);
});
