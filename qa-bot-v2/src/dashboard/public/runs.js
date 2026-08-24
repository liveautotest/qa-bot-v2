const PAGE_SIZE = 30;

let allRuns = [];
let totalCount = 0;
let activeFilter = "all";
let searchTerm = "";
let expandedRunId = null;

function filteredRuns() {
  return allRuns.filter((run) => {
    if (activeFilter === "android" && platformOf(run) !== "android") return false;
    if (activeFilter === "ios" && platformOf(run) !== "ios") return false;
    if (activeFilter === "fail" && run.status !== "fail") return false;
    if (activeFilter === "critical" && run.failure_class !== "critical") return false;
    if (searchTerm && !String(run.name || "").toLowerCase().includes(searchTerm)) return false;
    return true;
  });
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
          `<div class="step ${s.status === "pass" ? "ok" : "bad"}"><span class="dot"></span><span class="label">${escapeHtml(s.name)}${s.message ? " — " + escapeHtml(s.message) : ""}</span></div>`
      )
      .join("");

    const errorBlock = run.error
      ? `
        <p class="error-msg">Error: ${escapeHtml(run.error)}</p>
        <div class="error-log">
          <div class="head"><span>error_stack</span><span>run_id: ${escapeHtml(run.run_id)}</span></div>
          <pre>${escapeHtml(run.error_stack || run.error || "")}</pre>
        </div>`
      : "";

    const screenshotLinks = (run.artifact_files?.screenshots || [])
      .map((f) => `<a href="/artifacts/${run.run_id}/screenshots/${f}" target="_blank">▤ ${escapeHtml(f)}</a>`)
      .join("");
    const logLinks = (run.artifact_files?.logs || [])
      .map((f) => `<a href="/artifacts/${run.run_id}/logs/${f}" target="_blank">≡ ${escapeHtml(f)}</a>`)
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
  const runs = filteredRuns();

  document.getElementById("count-label").textContent = `총 ${totalCount}건 중 ${allRuns.length}건 불러옴 · ${runs.length}건 표시`;

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
          : `<span class="badge fail">FAIL</span><span class="badge ${run.failure_class === "critical" ? "critical" : "retry"}">${run.failure_class === "critical" ? "기능장애" : "재시도 대상"}</span>`;

      const row = `
        <div class="log-row${isExpanded ? " expanded" : ""}" data-run-id="${run.run_id}">
          <span class="platform mono">${platform}</span>
          <span class="test">${escapeHtml(run.name || run.test_id)}</span>
          <span class="badge env">${escapeHtml(run.env || "-")}</span>
          <span class="device-tag">${escapeHtml(run.role || "")}</span>
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

async function loadMore() {
  try {
    const data = await fetchJson(`/api/runs?limit=${PAGE_SIZE}&offset=${allRuns.length}`);
    totalCount = data.total;
    allRuns = allRuns.concat(data.runs);
    renderLog();
    document.getElementById("load-more").style.display = allRuns.length >= totalCount ? "none" : "block";
  } catch (error) {
    document.getElementById("count-label").textContent = "불러오지 못했습니다: " + error.message;
  }
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.filter;
    renderLog();
  });
});

document.getElementById("search-box").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  renderLog();
});

document.getElementById("load-more").addEventListener("click", loadMore);

loadMore();
