const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// infra/adb.js(Android)와 대응되는 iOS 버전. Xcode에 포함된 `xcrun devicectl`을 그대로 씀.
// WebDriverAgent 같은 원격 리모컨 앱이 필요 없음 - 케이블로 연결된 Mac에서
// "앱 설치/삭제/버전 확인"만 하면 되는 작업(빌드 설치)이라 devicectl만으로 충분하다.
//
// 실제 커맨드 문법은 Xcode 버전에 따라 달라질 수 있다. 이 파일은 다음을 근거로 작성됨:
// - `xcrun devicectl device install app --help`
// - `xcrun devicectl device info apps --help` (실제로 실행해서 JSON 스키마 확인함)
// `uninstallApp`의 정확한 서브커맨드 문법은 아직 실제 실행으로 검증되지 않았다 (다운그레이드
// 재설치 시나리오에서만 쓰이며, 실패해도 나머지 설치 흐름은 계속 진행되도록 짜여 있음).

function runDevicectl(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "xcrun",
      ["devicectl", ...args],
      { maxBuffer: 1024 * 1024 * 20, timeout: 5 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function installApp(deviceId, appBundlePath) {
  return runDevicectl(["device", "install", "app", "--device", deviceId, appBundlePath]);
}

async function launchAppWithUrl(deviceId, bundleId, url) {
  return runDevicectl([
    "device",
    "process",
    "launch",
    "--device",
    deviceId,
    "--payload-url",
    url,
    bundleId
  ]);
}

async function uninstallApp(deviceId, bundleId) {
  // 검증 필요: devicectl의 실제 uninstall 서브커맨드 문법과 다를 수 있음.
  return runDevicectl(["device", "uninstall", "app", "--device", deviceId, bundleId]);
}

async function getInstalledAppVersion(deviceId, bundleId) {
  const jsonPath = path.join(
    os.tmpdir(),
    `ios-app-info-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );

  try {
    await runDevicectl([
      "device",
      "info",
      "apps",
      "--device",
      deviceId,
      "--bundle-id",
      bundleId,
      "--json-output",
      jsonPath
    ]);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const app = parsed.result && parsed.result.apps && parsed.result.apps[0];
    if (!app) return { displayVersion: "", buildVersion: "" };

    return {
      displayVersion: app.version || "",
      buildVersion: app.bundleVersion || ""
    };
  } finally {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  }
}

module.exports = {
  getInstalledAppVersion,
  installApp,
  launchAppWithUrl,
  uninstallApp
};
