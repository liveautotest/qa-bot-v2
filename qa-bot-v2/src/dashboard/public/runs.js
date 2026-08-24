const PAGE_SIZE = 30;

let currentPage = 0;
let totalCount = 0;
let allRuns = [];
let activeFilter = "all";
let searchTerm = "";
let expandedRunId = null;
let searchDebounceTimer = null;

function buildQuery() {
  const params = new URLSearchParams();
  params.set("limit", PAGE_SIZE);
  params.set("offset", currentPage * PAGE_SIZE);
  if (activeFilter === "android") params.set("platform", "android");
  if (activeFilter === "ios") params.set("platform", "ios");
  if (activeFilter === "fail") params.set("status", "fail");
  if (activeFilter === "critical") params.set("critical", "true");
  if (searchTerm) params.set("q", searchTerm);
  return params.toString();
}

function failureBadgeHtml(failureClass) {
  if (failureClass === "critical") return `<span class="badge critical">기능장애</span>`;
  if (failureClass === "script") return `<span class="badge script">코드 확인 필요</span>`;
  return `<span class="badge retry">재시도 대상</span>`;
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

  if (!allRuns.length) {
    el.innerHTML = `<div class="empty-state">조건에 맞는 실행 기록이 없습니다.</div>`;
    return;
  }

  el.innerHTML = allRuns
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

function renderPagination() {
  const totalPages = Math.max(Math.ceil(totalCount / PAGE_SIZE), 1);
  document.getElementById("page-info").textContent = `${currentPage + 1} / ${totalPages} 페이지 · 총 ${totalCount}건`;
  document.getElementById("prev-page").disabled = currentPage <= 0;
  document.getElementById("next-page").disabled = currentPage + 1 >= totalPages;
}

async function loadPage() {
  document.getElementById("count-label").textContent = "불러오는 중…";
  try {
    const data = await fetchJson(`/api/runs?${buildQuery()}`);
    totalCount = data.total;
    allRuns = data.runs;
    expandedRunId = null;
    renderLog();
    renderPagination();
    document.getElementById("count-label").textContent = `총 ${totalCount}건`;
  } catch (error) {
    document.getElementById("count-label").textContent = "불러오지 못했습니다: " + error.message;
  }
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.filter;
    currentPage = 0;
    loadPage();
  });
});

document.getElementById("search-box").addEventListener("input", (e) => {
  const value = e.target.value.trim().toLowerCase();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchTerm = value;
    currentPage = 0;
    loadPage();
  }, 300);
});

document.getElementById("prev-page").addEventListener("click", () => {
  if (currentPage > 0) {
    currentPage -= 1;
    loadPage();
  }
});

document.getElementById("next-page").addEventListener("click", () => {
  const totalPages = Math.max(Math.ceil(totalCount / PAGE_SIZE), 1);
  if (currentPage + 1 < totalPages) {
    currentPage += 1;
    loadPage();
  }
});

loadPage();
