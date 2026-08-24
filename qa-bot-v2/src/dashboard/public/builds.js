const ACTION_LABELS = {
  "new-install": "신규 설치",
  update: "업데이트 설치",
  "downgrade-reinstall": "다운그레이드 재설치",
  "same-version": "동일 버전, 생략"
};

async function load() {
  const tbody = document.getElementById("builds-body");
  try {
    const builds = await fetchJson("/api/builds?limit=50");
    if (!builds.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">빌드설치 실행 기록이 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = builds
      .map((b) => {
        const platform = platformOf(b) === "ios" ? "iOS" : "Android";
        const target = b.build_install?.target_build;
        const version = target ? `${escapeHtml(target.displayVersion || "")} (${escapeHtml(target.buildVersion || "")})` : "-";
        const action = b.build_install?.action_label || ACTION_LABELS[b.build_install?.action] || "-";
        const statusBadge =
          b.status === "pass" ? `<span class="badge pass">PASS</span>` : `<span class="badge fail">FAIL</span>`;

        return `
          <tr>
            <td class="mono" style="font-size:11px;color:var(--text-mute);">${timeAgo(b.ran_at)}</td>
            <td>${platform}</td>
            <td>${escapeHtml(b.role || "-")}</td>
            <td><span class="badge env">${escapeHtml(b.env || "-")}</span></td>
            <td class="mono">${version}</td>
            <td>${escapeHtml(action)}</td>
            <td>${statusBadge}</td>
          </tr>`;
      })
      .join("");
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">불러오지 못했습니다: ${escapeHtml(error.message)}</td></tr>`;
  }
}

load();
