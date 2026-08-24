async function load() {
  const tbody = document.getElementById("team-body");
  try {
    const team = await fetchJson("/api/team");
    if (!team.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">실행 기록이 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = team
      .map(
        (t) => `
          <tr>
            <td>${escapeHtml(t.name)}</td>
            <td class="mono" style="font-size:11px;color:var(--text-mute);">${escapeHtml(t.sources.join(", ") || "-")}</td>
            <td>${t.total}</td>
            <td style="color:var(--ok);">${t.passed}</td>
            <td style="color:var(--bad);">${t.failed}</td>
            <td class="mono" style="font-size:11px;color:var(--text-mute);">${timeAgo(t.lastRunAt)}</td>
          </tr>`
      )
      .join("");
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">불러오지 못했습니다: ${escapeHtml(error.message)}</td></tr>`;
  }
}

load();
