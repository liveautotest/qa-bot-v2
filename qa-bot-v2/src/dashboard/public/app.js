const REFRESH_MS = 5000;

let allRuns = [];
let activeFilter = "all";
let searchTerm = "";
let expandedRunId = null;
let searchDebounceTimer = null;

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

function formatDuration(ms) {
  if (typeof ms !== "number") return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

function platformOf(run) {
  return String(run.test_id || "").toLowerCase().startsWith("tc-ios") ? "ios" : "android";
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

function renderStats(stats) {
  const el = document.getElementById("stats");
  const passRate = stats.passRate == null ? "-" : `${stats.passRate}%`;
  const failRate = stats.failRate == null ? "-" : `${stats.failRate}%`;

  el.innerHTML = `
    <div class="stat"><p class="label">오늘 실행</p><p class="value">${stats.total}건</p>
      <p class="delta">${stats.passed} 성공 · <span style="color:var(--bad);">${stats.failed} 실패</span></p></div>
    <div class="stat"><p class="label">성공률</p><p class="value ok">${passRate}</p></div>
    <div class="stat"><p class="label">실패율</p><p class="value" style="color:var(--bad);">${failRate}</p>
      <p class="delta">기능장애 ${stats.critical} · 자동화코드이슈 ${stats.script} · 인프라 ${stats.infra}</p></div>
    <div class="stat"><p class="label">평균 소요</p><p class="value">${stats.avgDurationSec}<span style="font-size:14px;">s</span></p></div>
  `;
}

function renderTrend(trend) {
  const el = document.getElementById("trend");
  const todayRate = trend.length ? trend[trend.length - 1].passRate : null;
  const dayLabels = ["일", "월", "화", "수", "목", "금", "토"];

  const bars = trend
    .map((d, i) => {
      const isToday = i === trend.length - 1;
      const rate = d.passRate == null ? 0 : d.passRate;
      const low = d.passRate != null && d.passRate < 70;
      const label = isToday ? "오늘" : dayLabels[new Date(d.date).getDay()];
      return `<div class="day"><div class="bar${low ? " low" : ""}" style="height:${d.total ? rate : 4}%"></div><span class="day-label">${label}</span></div>`;
    })
    .join("");

  el.innerHTML = `
    <div>
      <p class="today">${todayRate == null ? "-" : todayRate + "%"}</p>
      <p class="today-label">오늘 성공률</p>
    </div>
    <div class="days">${bars}</div>
  `;
}

function failureBadgeHtml(failureClass) {
  if (failureClass === "critical") return `<span class="badge critical">기능장애</span>`;
  if (failureClass === "script") return `<span class="badge script">자동화코드이슈</span>`;
  return `<span class="badge retry">재시도 대상</span>`;
}

function renderFailRank(topFailing) {
  const el = document.getElementById("fail-rank");
  if (!topFailing.length) {
    el.innerHTML = `<div class="empty-state">최근 7일간 실패한 테스트가 없습니다.</div>`;
    return;
  }
  const max = Math.max(...topFailing.map((t) => t.count));
  el.innerHTML = topFailing
    .map((t) => {
      const badge = failureBadgeHtml(t.failure_class);
      const width = Math.round((t.count / max) * 100);
      return `
        <div class="fail-row">
          <span class="test">${t.name}${t.env ? ` ${t.env}` : ""}</span>
          ${badge}
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <span class="rate">${t.count}회 실패</span>
        </div>`;
    })
    .join("");
}

function deviceIllustrationSvg(platform) {
  if (platform === "ios") {
    return `<svg viewBox="0 0 60 100" width="42" height="70" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="2" width="54" height="96" rx="12" stroke="currentColor" stroke-width="2.5"/>
      <rect x="21" y="7" width="18" height="5" rx="2.5" fill="currentColor" opacity="0.4"/>
      <rect x="22" y="88" width="16" height="3" rx="1.5" fill="currentColor" opacity="0.4"/>
    </svg>`;
  }
  // 안드로이드 단말은 실제로 폴더블(Galaxy Z Flip 계열)이라 접힌 형태로 표현 (세로로 세운 모양)
  return `<svg viewBox="0 0 60 100" width="42" height="70" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="2" width="54" height="96" rx="12" stroke="currentColor" stroke-width="2.5"/>
    <line x1="3" y1="50" x2="57" y2="50" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
    <rect x="19" y="14" width="22" height="16" rx="3" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
    <circle cx="30" cy="40" r="2.2" fill="currentColor" opacity="0.45"/>
  </svg>`;
}

function renderDevices(deviceList) {
  const el = document.getElementById("rack");
  el.innerHTML = deviceList
    .map((d) => {
      const offlineClass = d.connected ? "" : " offline";
      const ledClass = d.connected ? "led-ok" : "led-off";
      const meta = d.connected ? d.os || d.identifier || "" : d.reason || "연결 안 됨";
      const testRow = d.lastRun
        ? `<span class="test-name">${d.lastRun.name}</span><span class="badge ${d.lastRun.status}">${d.lastRun.status === "pass" ? "PASS" : "FAIL"}</span>`
        : `<span class="test-name">-</span><span class="badge idle">대기</span>`;
      const sub = d.lastRun
        ? `${formatDuration(d.lastRun.duration_ms)} · ${timeAgo(d.lastRun.ran_at)}`
        : d.connected
          ? "아직 실행 이력 없음"
          : "";
      const reconnectBtn =
        !d.connected && d.platform === "ios"
          ? `<span class="reconnect-btn" onclick="location.reload()">↻ WDA 재연결 확인</span>`
          : "";

      return `
        <div class="device${offlineClass}">
          <span class="device-led ${ledClass}"></span>
          <div class="screen-preview">${deviceIllustrationSvg(d.platform)}</div>
          <p class="name">${d.label}</p>
          <p class="meta">${meta}</p>
          <div class="test-row">${testRow}</div>
          <p class="sub">${sub}</p>
          ${reconnectBtn}
        </div>`;
    })
    .join("");
}

function buildRunsQuery() {
  const params = new URLSearchParams();
  params.set("limit", 30);
  if (activeFilter === "android") params.set("platform", "android");
  if (activeFilter === "ios") params.set("platform", "ios");
  if (activeFilter === "fail") params.set("status", "fail");
  if (activeFilter === "critical") params.set("critical", "true");
  if (searchTerm) params.set("q", searchTerm);
  return params.toString();
}

async function renderDetail(runId) {
  const container = document.getElementById(`detail-${runId}`);
  if (!container) return;
  container.innerHTML = `<div class="empty-state">불러오는 중…</div>`;

  try {
    const run = await fetchJson(`/api/runs/${runId}`);
    const steps = (run.steps || [])
      .map(
        (s) =>
          `<div class="step ${s.status === "pass" ? "ok" : "bad"}"><span class="dot"></span><span class="label">${s.name}${s.message ? " — " + s.message : ""}</span></div>`
      )
      .join("");

    const errorBlock = run.error
      ? `
        <p class="error-msg">Error: ${run.error}</p>
        <div class="error-log">
          <div class="head"><span>error_stack</span><span>run_id: ${run.run_id}</span></div>
          <pre>${(run.error_stack || run.error || "").replace(/</g, "&lt;")}</pre>
        </div>`
      : "";

    const screenshotLinks = (run.artifact_files?.screenshots || [])
      .map((f) => `<a href="/artifacts/${run.run_id}/screenshots/${f}" target="_blank">▤ ${f}</a>`)
      .join("");
    const logLinks = (run.artifact_files?.logs || [])
      .map((f) => `<a href="/artifacts/${run.run_id}/logs/${f}" target="_blank">≡ ${f}</a>`)
      .join("");

    container.innerHTML = `
      <div class="steps">${steps || '<p style="font-size:12px;color:var(--text-faint);">단계 기록 없음</p>'}</div>
      ${errorBlock}
      <div class="artifact-links">${screenshotLinks}${logLinks}</div>
    `;
  } catch (error) {
    container.innerHTML = `<div class="empty-state">상세 정보를 불러오지 못했습니다.</div>`;
  }
}

function renderLog() {
  const el = document.getElementById("log");
  const runs = allRuns;

  if (!runs.length) {
    el.innerHTML = `<div class="empty-state">조건에 맞는 실행 기록이 없습니다.</div>`;
    return;
  }

  el.innerHTML = runs
    .map((run) => {
      const isExpanded = run.run_id === expandedRunId;
      const platform = platformOf(run) === "ios" ? "iOS" : "AOS";
      const statusBadge =
        run.status === "pass"
          ? `<span class="badge pass">PASS</span><span></span>`
          : `<span class="badge fail">FAIL</span>${failureBadgeHtml(run.failure_class)}`;

      const row = `
        <div class="log-row${isExpanded ? " expanded" : ""}" data-run-id="${run.run_id}">
          <span class="platform mono">${platform}</span>
          <span class="test">${run.name || run.test_id}</span>
          <span class="badge env">${run.env || "-"}</span>
          <span class="device-tag">${run.role || ""}</span>
          ${statusBadge}
          <span class="time">${formatDuration(run.duration_ms)}</span>
          <span class="ago">${timeAgo(run.ran_at)}</span>
          <span class="chevron">${isExpanded ? "⌄" : "›"}</span>
        </div>`;

      const detail = isExpanded ? `<div class="detail" id="detail-${run.run_id}"></div>` : "";
      return row + detail;
    })
    .join("");

  el.querySelectorAll(".log-row").forEach((rowEl) => {
    rowEl.addEventListener("click", () => {
      const runId = rowEl.dataset.runId;
      expandedRunId = expandedRunId === runId ? null : runId;
      renderLog();
      if (expandedRunId) renderDetail(expandedRunId);
    });
  });
}

async function refreshAll() {
  try {
    const [summary, deviceList, runsResponse] = await Promise.all([
      fetchJson("/api/summary"),
      fetchJson("/api/devices"),
      fetchJson(`/api/runs?${buildRunsQuery()}`)
    ]);

    renderStats(summary.stats);
    renderTrend(summary.trend);
    renderFailRank(summary.topFailing);
    renderDevices(deviceList);

    allRuns = runsResponse.runs;
    renderLog();

    if (expandedRunId && allRuns.some((r) => r.run_id === expandedRunId)) {
      renderDetail(expandedRunId);
    }

    document.getElementById("last-updated").textContent =
      new Date().toLocaleTimeString("ko-KR") + " 마지막 갱신 · 5초마다 자동 새로고침";
  } catch (error) {
    document.getElementById("last-updated").textContent = "데이터를 불러오지 못했습니다: " + error.message;
  }
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.filter;
    refreshAll();
  });
});

document.getElementById("search-box").addEventListener("input", (e) => {
  const value = e.target.value.trim().toLowerCase();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchTerm = value;
    refreshAll();
  }, 300);
});

const refreshBtn = document.getElementById("refresh-btn");
const refreshBtnDefaultText = refreshBtn.textContent;
refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("loading");
  refreshBtn.textContent = "↻ 새로고침 중…";
  try {
    await refreshAll();
  } finally {
    refreshBtn.classList.remove("loading");
    refreshBtn.textContent = refreshBtnDefaultText;
  }
});

document.getElementById("delete-recent-btn").addEventListener("click", async () => {
  if (!confirm("최근 실행 기록 30건을 삭제할까요?\n스크린샷/로그와 함께 전부 삭제되며 되돌릴 수 없습니다.\n(그 이전 기록은 남아있어요, 실행 기록 페이지에서 확인 가능합니다)")) return;
  try {
    await fetch("/api/runs/recent?limit=30", { method: "DELETE" });
    refreshAll();
  } catch (error) {
    alert("삭제 실패: " + error.message);
  }
});

refreshAll();
setInterval(refreshAll, REFRESH_MS);
