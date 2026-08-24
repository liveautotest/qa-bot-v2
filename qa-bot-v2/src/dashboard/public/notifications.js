function kvRow(key, value) {
  const isUnset = !value;
  return `<div class="kv-row"><span class="k">${escapeHtml(key)}</span><span class="v${isUnset ? " unset" : ""}">${isUnset ? "(미설정)" : escapeHtml(value)}</span></div>`;
}

async function load() {
  try {
    const cfg = await fetchJson("/api/config/notifications");

    document.getElementById("result-channel").innerHTML =
      kvRow("채널 ID", cfg.resultChannel) +
      kvRow("Allowlist", cfg.resultChannelAllowlist);

    document.getElementById("test-channel").innerHTML =
      kvRow("채널 ID", cfg.testResultChannel) +
      kvRow("Allowlist", cfg.testResultChannelAllowlist);
  } catch (error) {
    document.getElementById("result-channel").innerHTML = `<div class="empty-state">불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
  }
}

load();
