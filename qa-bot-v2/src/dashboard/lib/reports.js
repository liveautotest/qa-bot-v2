const fs = require("fs");
const path = require("path");

const RUN_ID_PATTERN = /^qa-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/;

const CODE_ISSUE_PATTERNS = [
  /찾지 못했습니다/,
  /Unhandled endpoint/,
  /홈 화면으로 이동하지 않았습니다/
];

const INFRA_PATTERNS = [
  /fetch failed/i,
  /연결/,
  /timeout/i,
  /already busy/i
];

function parseRunIdDate(runId) {
  const match = RUN_ID_PATTERN.exec(runId || "");
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
}

function classifyFailure(result) {
  if (result.status !== "fail") return null;
  const message = String(result.error || "");
  if (CODE_ISSUE_PATTERNS.some((pattern) => pattern.test(message))) return "script";
  if (INFRA_PATTERNS.some((pattern) => pattern.test(message))) return "infra";
  // 빌드설치는 "앱 기능"이 아니라 Firebase에서 받아 설치하는 절차 자체를 테스트하는 거라,
  // 여기서 나는 실패는 대부분 우리 설치 스크립트 쪽 문제일 가능성이 높다.
  // (진짜 앱 결함이라기보단 코드/환경 문제일 확률이 커서 기능장애로 몰지 않는다)
  if (String(result.test_id || "").toUpperCase().includes("BUILD-INSTALL")) return "script";
  return "critical";
}

function listRunDirs(reportBaseDir) {
  if (!fs.existsSync(reportBaseDir)) return [];
  return fs
    .readdirSync(reportBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function readResult(reportBaseDir, runId) {
  const resultPath = path.join(reportBaseDir, runId, "result.json");
  try {
    const raw = fs.readFileSync(resultPath, "utf8");
    const result = JSON.parse(raw);
    result.run_id = result.run_id || runId;
    result.ran_at = parseRunIdDate(result.run_id);
    result.failure_class = classifyFailure(result);
    return result;
  } catch (error) {
    return null;
  }
}

function getRecentRuns(reportBaseDir, limit = 20, offset = 0) {
  const runIds = listRunDirs(reportBaseDir).slice(offset, offset + limit);
  return runIds.map((runId) => readResult(reportBaseDir, runId)).filter(Boolean);
}

function countAllRuns(reportBaseDir) {
  return listRunDirs(reportBaseDir).length;
}

function getAllRuns(reportBaseDir, maxScan = 500) {
  const runIds = listRunDirs(reportBaseDir).slice(0, maxScan);
  return runIds.map((runId) => readResult(reportBaseDir, runId)).filter(Boolean);
}

function isBuildInstall(run) {
  return String(run.test_id || "").toUpperCase().includes("BUILD-INSTALL");
}

function getQaRuns(reportBaseDir, maxScan = 500) {
  return getAllRuns(reportBaseDir, maxScan).filter((r) => !isBuildInstall(r));
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getTodayStats(reportBaseDir) {
  const now = new Date();
  const runs = getQaRuns(reportBaseDir).filter((r) => r.ran_at && isSameDay(r.ran_at, now));

  const total = runs.length;
  const passed = runs.filter((r) => r.status === "pass").length;
  const failed = runs.filter((r) => r.status === "fail");
  const critical = failed.filter((r) => r.failure_class === "critical").length;
  const script = failed.filter((r) => r.failure_class === "script").length;
  const infra = failed.filter((r) => r.failure_class === "infra").length;
  const durations = runs.map((r) => r.duration_ms).filter((n) => typeof n === "number");
  const avgDurationMs = durations.length
    ? durations.reduce((sum, n) => sum + n, 0) / durations.length
    : 0;

  return {
    total,
    passed,
    failed: failed.length,
    critical,
    script,
    infra,
    passRate: total ? Math.round((passed / total) * 100) : null,
    failRate: total ? Math.round((failed.length / total) * 100) : null,
    avgDurationSec: Math.round((avgDurationMs / 1000) * 10) / 10
  };
}

function getTrend(reportBaseDir, days = 7) {
  const runs = getQaRuns(reportBaseDir);
  const buckets = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - i);
    const dayRuns = runs.filter((r) => r.ran_at && isSameDay(r.ran_at, day));
    const total = dayRuns.length;
    const passed = dayRuns.filter((r) => r.status === "pass").length;
    buckets.push({
      date: day.toISOString().slice(0, 10),
      total,
      passRate: total ? Math.round((passed / total) * 100) : null
    });
  }

  return buckets;
}

function getTopFailingTests(reportBaseDir, days = 7, limit = 5) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const runs = getQaRuns(reportBaseDir).filter(
    (r) => r.status === "fail" && r.ran_at && r.ran_at >= cutoff
  );

  const groups = new Map();
  for (const run of runs) {
    const key = `${run.name || run.test_id}::${run.env || ""}`;
    if (!groups.has(key)) {
      groups.set(key, { name: run.name || run.test_id, env: run.env, count: 0, classes: [] });
    }
    const group = groups.get(key);
    group.count += 1;
    group.classes.push(run.failure_class);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      failure_class: group.classes.includes("critical")
        ? "critical"
        : group.classes.includes("script")
          ? "script"
          : "infra"
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function getTeamActivity(reportBaseDir, maxScan = 300) {
  const runs = getAllRuns(reportBaseDir, maxScan);
  const groups = new Map();

  for (const run of runs) {
    const key = run.requested_by || "알 수 없음";
    if (!groups.has(key)) {
      groups.set(key, { name: key, total: 0, passed: 0, failed: 0, lastRunAt: null, sources: new Set() });
    }
    const group = groups.get(key);
    group.total += 1;
    if (run.status === "pass") group.passed += 1;
    if (run.status === "fail") group.failed += 1;
    if (run.source) group.sources.add(run.source);
    if (!group.lastRunAt || (run.ran_at && run.ran_at > group.lastRunAt)) {
      group.lastRunAt = run.ran_at;
    }
  }

  return Array.from(groups.values())
    .map((g) => ({ ...g, sources: Array.from(g.sources) }))
    .sort((a, b) => b.total - a.total);
}

function getBuildHistory(reportBaseDir, limit = 30) {
  const runs = getAllRuns(reportBaseDir, 500).filter((r) =>
    String(r.test_id || "").toUpperCase().includes("BUILD-INSTALL")
  );
  return runs.slice(0, limit);
}

function platformOfTest(run) {
  return String(run.test_id || "").toUpperCase().startsWith("TC-IOS") ? "ios" : "android";
}

function getFilteredRuns(reportBaseDir, filters = {}, maxScan = 5000) {
  const { platform, status, critical, q } = filters;
  return getAllRuns(reportBaseDir, maxScan).filter((run) => {
    if (platform && platformOfTest(run) !== platform) return false;
    if (status && run.status !== status) return false;
    if (critical && run.failure_class !== "critical") return false;
    if (q && !String(run.name || run.test_id || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

module.exports = {
  getAllRuns,
  getQaRuns,
  getFilteredRuns,
  getRecentRuns,
  countAllRuns,
  getTodayStats,
  getTopFailingTests,
  getTrend,
  getTeamActivity,
  getBuildHistory,
  readResult
};
