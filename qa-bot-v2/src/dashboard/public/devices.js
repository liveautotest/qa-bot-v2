function kvRow(key, value) {
  const isUnset = !value;
  return `<div class="kv-row"><span class="k">${escapeHtml(key)}</span><span class="v${isUnset ? " unset" : ""}">${isUnset ? "(미설정)" : escapeHtml(value)}</span></div>`;
}

function renderRack(deviceList) {
  const el = document.getElementById("rack");
  el.innerHTML = deviceList
    .map((d) => {
      const offlineClass = d.connected ? "" : " offline";
      const ledClass = d.connected ? "led-ok" : "led-off";
      const meta = d.connected ? d.os || d.identifier || "" : d.reason || "연결 안 됨";
      return `
        <div class="device${offlineClass}">
          <span class="device-led ${ledClass}"></span>
          <div class="screen-preview"></div>
          <p class="name">${escapeHtml(d.label)}</p>
          <p class="meta">${escapeHtml(meta)}</p>
          <p class="sub">${d.identifier ? escapeHtml(d.identifier) : ""}</p>
        </div>`;
    })
    .join("");
}

async function load() {
  try {
    const [deviceList, cfg] = await Promise.all([
      fetchJson("/api/devices"),
      fetchJson("/api/config/devices")
    ]);

    renderRack(deviceList);

    document.getElementById("android-config").innerHTML =
      kvRow("ADB 경로", cfg.adbPath) +
      kvRow("게스트 단말 시리얼", cfg.android?.guest) +
      kvRow("호스트 단말 시리얼", cfg.android?.host) +
      kvRow("dev 패키지명", cfg.androidPackages?.dev) +
      kvRow("staging 패키지명", cfg.androidPackages?.staging);

    document.getElementById("ios-config").innerHTML =
      kvRow("게스트 단말 UDID", cfg.ios?.devices?.guest) +
      kvRow("호스트 단말 UDID", cfg.ios?.devices?.host) +
      kvRow("게스트 WDA URL", cfg.ios?.wdaUrls?.guest) +
      kvRow("호스트 WDA URL", cfg.ios?.wdaUrls?.host) +
      kvRow("dev bundle id", cfg.ios?.bundleIds?.dev) +
      kvRow("staging bundle id", cfg.ios?.bundleIds?.staging);
  } catch (error) {
    document.getElementById("rack").innerHTML = `<div class="empty-state">불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
  }
}

document.getElementById("refresh-btn").addEventListener("click", load);
load();
