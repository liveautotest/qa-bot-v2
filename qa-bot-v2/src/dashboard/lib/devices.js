const { execFile } = require("child_process");

function execFileSafe(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function getAndroidDeviceState(adbPath, serial) {
  if (!serial) return { connected: false, reason: "미설정" };

  const stdout = await execFileSafe(adbPath || "adb", ["devices"]);
  if (stdout === null) return { connected: false, reason: "adb 실행 불가" };

  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(serial));

  if (!line) return { connected: false, reason: "미연결" };
  const state = line.split(/\s+/)[1] || "";
  const connected = state === "device";
  return { connected, reason: connected ? "" : `연결 불안정 (${state || "알 수 없음"})` };
}

async function getAndroidOsVersion(adbPath, serial) {
  if (!serial) return "";
  const stdout = await execFileSafe(adbPath || "adb", [
    "-s",
    serial,
    "shell",
    "getprop",
    "ro.build.version.release"
  ]);
  return stdout ? `Android ${stdout.trim()}` : "";
}

async function getWdaState(wdaUrl) {
  if (!wdaUrl) return { connected: false, reason: "미설정" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${wdaUrl.replace(/\/+$/, "")}/status`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return { connected: false, reason: "WDA 응답 오류" };
    const json = await response.json();
    return { connected: Boolean(json?.value?.ready), reason: "" };
  } catch (error) {
    return { connected: false, reason: "WDA 연결 끊김" };
  }
}

module.exports = {
  getAndroidDeviceState,
  getAndroidOsVersion,
  getWdaState
};
