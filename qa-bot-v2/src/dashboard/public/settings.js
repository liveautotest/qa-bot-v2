function kvRow(key, value) {
  const isUnset = value === "" || value == null;
  const display = typeof value === "boolean" ? (value ? "켜짐" : "꺼짐") : value;
  return `<div class="kv-row"><span class="k">${escapeHtml(key)}</span><span class="v${isUnset ? " unset" : ""}">${isUnset ? "(미설정)" : escapeHtml(display)}</span></div>`;
}

async function load() {
  const el = document.getElementById("settings-list");
  try {
    const cfg = await fetchJson("/api/config/settings");
    el.innerHTML =
      kvRow("리포트 저장 위치", cfg.reportBaseDir) +
      kvRow("대시보드 포트", cfg.dashboardPort) +
      kvRow("Dry-run 모드", cfg.dryRun) +
      kvRow("앱 빌드 사전확인 사용", cfg.appBuildEnabled) +
      kvRow("최신 staging 자동설치", cfg.autoInstallLatestStaging) +
      kvRow("Firebase 프로젝트 번호", cfg.firebaseProjectNumber);
  } catch (error) {
    el.innerHTML = `<div class="empty-state">불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
  }
}

load();
