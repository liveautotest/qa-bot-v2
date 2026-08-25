const PAGE_SIZE = 10;

let currentPage = 0;
let totalCount = 0;
let totalFileCount = 0;
let totalSizeBytes = 0;
let runsData = [];
let selected = new Set();

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function failureBadgeHtml(failureClass) {
  if (failureClass === "critical") return `<span class="badge critical">기능장애</span>`;
  if (failureClass === "script") return `<span class="badge script">자동화코드이슈</span>`;
  return `<span class="badge retry">재시도 대상</span>`;
}

function renderList() {
  const el = document.getElementById("shot-list");

  if (!runsData.length) {
    el.innerHTML = `<div class="empty-state">스크린샷이 남아있는 실행 기록이 없습니다.</div>`;
    return;
  }

  el.innerHTML = runsData
    .map((run) => {
      const platform = platformOf(run) === "ios" ? "iOS" : "AOS";
      const thumbs = run.screenshots
        .map((shot) => {
          const url = `/artifacts/${encodeURIComponent(run.run_id)}/screenshots/${encodeURIComponent(shot.name)}`;
          const key = `${run.run_id}::${shot.name}`;
          const checked = selected.has(key) ? "checked" : "";
          return `
            <div class="shot-thumb" data-run-id="${escapeHtml(run.run_id)}" data-filename="${escapeHtml(shot.name)}">
              <input type="checkbox" class="shot-select" data-key="${escapeHtml(key)}" ${checked}>
              <a href="${url}" target="_blank"><img src="${url}" loading="lazy"></a>
              <span class="shot-delete" title="이 스크린샷 삭제">×</span>
              <span class="shot-name">${escapeHtml(shot.name)} · ${formatBytes(shot.size)}</span>
            </div>`;
        })
        .join("");

      return `
        <div class="shot-card">
          <div class="shot-card-header">
            <span class="platform mono">${platform}</span>
            <span class="test">${escapeHtml(run.name || run.test_id)}</span>
            <span class="badge env">${escapeHtml(run.env || "-")}</span>
            ${failureBadgeHtml(run.failure_class)}
            <span class="ago">${timeAgo(run.ran_at)}</span>
            <span class="shot-delete-run" data-run-id="${escapeHtml(run.run_id)}">이 실행 전체 삭제</span>
          </div>
          ${run.error ? `<p class="error-msg" style="margin:4px 0 10px;">${escapeHtml(run.error)}</p>` : ""}
          <div class="shot-thumbs">${thumbs}</div>
        </div>`;
    })
    .join("");

  el.querySelectorAll(".shot-delete").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      const thumb = event.target.closest(".shot-thumb");
      const runId = thumb.dataset.runId;
      const filename = thumb.dataset.filename;
      if (!confirm(`이 스크린샷을 삭제할까요?\n${filename}`)) return;
      try {
        await fetch(`/api/screenshots/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`, {
          method: "DELETE"
        });
        loadPage();
      } catch (error) {
        alert("삭제 실패: " + error.message);
      }
    });
  });

  el.querySelectorAll(".shot-delete-run").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      const runId = event.target.dataset.runId;
      if (!confirm("이 실행의 스크린샷을 전부 삭제할까요?")) return;
      try {
        await fetch(`/api/screenshots/${encodeURIComponent(runId)}`, { method: "DELETE" });
        loadPage();
      } catch (error) {
        alert("삭제 실패: " + error.message);
      }
    });
  });

  el.querySelectorAll(".shot-select").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const key = checkbox.dataset.key;
      if (checkbox.checked) {
        selected.add(key);
      } else {
        selected.delete(key);
      }
      updateSelectedButton();
    });
  });

  updateSelectedButton();
}

function updateSelectedButton() {
  const btn = document.getElementById("delete-selected-btn");
  if (selected.size > 0) {
    btn.style.display = "";
    btn.textContent = `선택 삭제 (${selected.size})`;
  } else {
    btn.style.display = "none";
  }
}

function renderPagination() {
  const totalPages = Math.max(Math.ceil(totalCount / PAGE_SIZE), 1);
  document.getElementById("page-info").textContent =
    `${currentPage + 1} / ${totalPages} 페이지 · 총 ${totalCount}건 실행 · ${totalFileCount}장 · ${formatBytes(totalSizeBytes)}`;
  document.getElementById("prev-page").disabled = currentPage <= 0;
  document.getElementById("next-page").disabled = currentPage + 1 >= totalPages;
}

async function loadPage() {
  document.getElementById("count-label").textContent = "불러오는 중…";
  try {
    const params = new URLSearchParams();
    params.set("limit", PAGE_SIZE);
    params.set("offset", currentPage * PAGE_SIZE);
    const data = await fetchJson(`/api/screenshots?${params.toString()}`);
    totalCount = data.total;
    totalFileCount = data.totalFileCount;
    totalSizeBytes = data.totalSizeBytes;
    runsData = data.runs;
    renderList();
    renderPagination();
    document.getElementById("count-label").textContent =
      `총 ${totalCount}건 실행 · ${totalFileCount}장 · ${formatBytes(totalSizeBytes)}`;
  } catch (error) {
    document.getElementById("count-label").textContent = "불러오지 못했습니다: " + error.message;
  }
}

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

document.getElementById("delete-all-btn").addEventListener("click", async () => {
  if (!confirm(`정말로 전체 스크린샷을 삭제할까요?\n총 ${totalFileCount}장이 전부 삭제되며 되돌릴 수 없습니다.`)) return;
  try {
    await fetch("/api/screenshots", { method: "DELETE" });
    selected.clear();
    currentPage = 0;
    loadPage();
  } catch (error) {
    alert("전체 삭제 실패: " + error.message);
  }
});

document.getElementById("delete-selected-btn").addEventListener("click", async () => {
  if (!selected.size) return;
  if (!confirm(`선택한 ${selected.size}개 스크린샷을 삭제할까요?`)) return;
  try {
    await Promise.all(
      Array.from(selected).map((key) => {
        const sepIdx = key.indexOf("::");
        const runId = key.slice(0, sepIdx);
        const filename = key.slice(sepIdx + 2);
        return fetch(`/api/screenshots/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`, {
          method: "DELETE"
        });
      })
    );
    selected.clear();
    loadPage();
  } catch (error) {
    alert("선택 삭제 실패: " + error.message);
  }
});

loadPage();
