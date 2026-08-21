const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { downloadFile, listReleases } = require("../infra/firebase-app-distribution");
const { getInstalledAppVersion, installApp, uninstallApp } = require("../infra/ios-devicectl");

// tests/build-install.test.js(Android)와 동일한 구조. 다른 점은:
// - 설치 파일이 .apk가 아니라 .ipa (내부에 Payload/xxx.app 폴더가 zip으로 들어있음)
// - adb install 대신 xcrun devicectl device install app
// - 버전 확인은 dumpsys 대신 devicectl device info apps

const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
const releaseCache = new Map();

function normalizeEnv(env) {
  return env === "stg" ? "staging" : env;
}

function getIosAppBuildConfig(config) {
  return (config.appBuild && config.appBuild.ios) || {};
}

function getFirebaseAppId(config, env) {
  const iosBuild = getIosAppBuildConfig(config);
  return normalizeEnv(env) === "dev" ? iosBuild.firebaseDevAppId : iosBuild.firebaseStagingAppId;
}

function requireBuildInstallConfig(config, env) {
  const missing = [];
  const appBuild = config.appBuild || {};
  if (!appBuild.firebaseProjectNumber) missing.push("FIREBASE_PROJECT_NUMBER");
  if (!getFirebaseAppId(config, env)) {
    missing.push(normalizeEnv(env) === "dev" ? "FIREBASE_IOS_DEV_APP_ID" : "FIREBASE_IOS_STAGING_APP_ID");
  }
  if (missing.length) {
    throw new Error(`iOS 빌드 설치 설정이 없습니다: ${missing.join(", ")}`);
  }
}

function compareBuildVersion(left, right) {
  const a = Number(left || 0);
  const b = Number(right || 0);
  if (Number.isFinite(a) && Number.isFinite(b) && (a || b)) return a - b;
  return String(left || "").localeCompare(String(right || ""));
}

function formatVersion(version) {
  if (!version) return "미설치";
  const name = version.displayVersion || "unknown";
  const code = version.buildVersion || "unknown";
  return `${name} (${code})`;
}

async function getIosFirebaseReleases(config, env, pageSize = 20, { forceRefresh = false } = {}) {
  requireBuildInstallConfig(config, env);
  const appBuild = config.appBuild || {};
  const appId = getFirebaseAppId(config, env);
  const cacheKey = `ios:${appBuild.firebaseProjectNumber}:${appId}`;
  const cached = releaseCache.get(cacheKey);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.cachedAt < RELEASE_CACHE_TTL_MS &&
    cached.pageSize >= pageSize
  ) {
    return cached.releases;
  }

  const response = await listReleases({
    projectNumber: appBuild.firebaseProjectNumber,
    appId,
    serviceAccountPath: appBuild.firebaseServiceAccountPath,
    pageSize
  });
  const releases = response.releases || [];
  releaseCache.set(cacheKey, { cachedAt: Date.now(), pageSize, releases });
  return releases;
}

async function findTargetRelease(config, request) {
  const releases = await getIosFirebaseReleases(config, request.env, 30);
  if (!releases.length) throw new Error("Firebase App Distribution(iOS) 릴리즈를 찾지 못했습니다.");

  const releaseName = request.release_name || "";
  const buildVersion = request.build_version || "";
  const hasExplicitTarget = Boolean(releaseName || buildVersion);
  const target = releases.find((release) => release.name === releaseName) ||
    releases.find((release) => String(release.buildVersion || "") === String(buildVersion));

  if (hasExplicitTarget && !target) {
    throw new Error(`선택한 iOS Firebase 빌드를 찾지 못했습니다: ${releaseName || buildVersion}`);
  }

  return {
    releases,
    target: target || releases[0]
  };
}

async function downloadIpa(release, destinationDir) {
  if (!release.binaryDownloadUri) {
    throw new Error("Firebase latest release does not include binaryDownloadUri.");
  }

  const buildVersion = release.buildVersion || "unknown";
  const appName = String(release.name || "app").split("/apps/")[1]?.split("/")[0] || "app";
  const destination = path.join(destinationDir, `${appName}-${buildVersion}.ipa`);

  if (fs.existsSync(destination)) {
    const stat = fs.statSync(destination);
    const header = Buffer.alloc(2);
    const fd = fs.openSync(destination, "r");
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    // .ipa도 zip 포맷이라 "PK" 시그니처로 정상 다운로드 여부를 확인한다.
    if (stat.size > 1024 * 1024 && header.toString("utf8") === "PK") {
      return destination;
    }
  }

  return downloadFile(release.binaryDownloadUri, destination);
}

function unzipIpa(ipaPath, extractDir) {
  return new Promise((resolve, reject) => {
    execFile("unzip", ["-o", ipaPath, "-d", extractDir], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function extractAppBundle(ipaPath) {
  const extractDir = `${ipaPath}.extracted`;
  await unzipIpa(ipaPath, extractDir);
  const payloadDir = path.join(extractDir, "Payload");
  const entries = fs.readdirSync(payloadDir).filter((name) => name.endsWith(".app"));
  if (!entries.length) {
    throw new Error(".ipa 안에서 .app 번들을 찾지 못했습니다.");
  }
  return path.join(payloadDir, entries[0]);
}

async function runIosBuildInstallTest({ request, config, store }) {
  const env = normalizeEnv(request.env || "staging");
  const role = request.role || "guest";
  const iosBuild = getIosAppBuildConfig(config);
  const device = (iosBuild.devices && iosBuild.devices[role]) || "";
  const bundleId = (iosBuild.bundleIds && iosBuild.bundleIds[env]) || "";
  const steps = [];
  const startedAt = Date.now();

  const addStep = (name, status = "pass", message = "") => {
    steps.push({ name, status, ...(message ? { message } : {}) });
  };

  if (env !== "staging" && env !== "dev") {
    throw Object.assign(new Error("iOS 빌드 설치는 dev/stg만 지원합니다."), { steps });
  }
  if (!device) {
    throw Object.assign(new Error(`iOS 테스터 단말 식별자를 찾지 못했습니다: ${role}`), { steps });
  }
  if (!bundleId) {
    throw Object.assign(new Error(`iOS bundle id를 찾지 못했습니다: ${env}`), { steps });
  }

  const { target } = await findTargetRelease(config, { ...request, env });
  addStep(
    "Firebase 빌드 목록 확인",
    "pass",
    `${target.displayVersion || "unknown"} (${target.buildVersion || "unknown"})`
  );

  let installedBefore = null;
  try {
    installedBefore = await getInstalledAppVersion(device, bundleId);
    addStep("단말 기존 설치 버전 확인", "pass", formatVersion(installedBefore));
  } catch (error) {
    installedBefore = { displayVersion: "", buildVersion: "" };
    addStep("단말 기존 설치 버전 확인", "pass", "미설치 또는 버전 확인 불가");
    store.appendLog("runner.log", `installed version check skipped: ${error.message}`);
  }

  const compare = compareBuildVersion(target.buildVersion, installedBefore.buildVersion);
  let installAction = "same-version";
  let actionLabel = "동일 버전, 설치 생략";

  if (!installedBefore.buildVersion) {
    installAction = "new-install";
    actionLabel = "신규 설치";
  } else if (compare > 0) {
    installAction = "update";
    actionLabel = "업데이트 설치";
  } else if (compare < 0) {
    installAction = "downgrade-reinstall";
    actionLabel = "삭제 후 낮은 버전 설치";
  }

  const buildResult = (extra = {}) => ({
    test_id: "TC-IOS-BUILD-INSTALL-001",
    name: `iOS ${role} 빌드 설치`,
    env,
    status: "pass",
    device,
    role,
    duration_ms: Date.now() - startedAt,
    build_install: {
      client: "ios",
      tester_role: role,
      bundle_id: bundleId,
      verified_at: new Date().toISOString(),
      installed_before: installedBefore,
      target_build: {
        displayVersion: target.displayVersion || "",
        buildVersion: target.buildVersion || "",
        firebaseConsoleUri: target.firebaseConsoleUri || "",
        releaseNotes: (target.releaseNotes && target.releaseNotes.text) || ""
      },
      action: installAction,
      action_label: actionLabel,
      ...extra
    },
    steps
  });

  if (installAction === "same-version") {
    return buildResult();
  }

  const ipaPath = await downloadIpa(target, config.appBuild.downloadDir);
  addStep("설치 IPA 준비", "pass", path.basename(ipaPath));

  const appBundlePath = await extractAppBundle(ipaPath);
  addStep(".ipa 압축 해제", "pass", path.basename(appBundlePath));

  if (installAction === "downgrade-reinstall") {
    await uninstallApp(device, bundleId).catch((error) => {
      store.appendLog("runner.log", `uninstall before downgrade ignored: ${error.message}`);
    });
    addStep("기존 앱 삭제", "pass", bundleId);
  }

  await installApp(device, appBundlePath);
  addStep("앱 설치", "pass", actionLabel);

  const installedAfter = await getInstalledAppVersion(device, bundleId);
  addStep("설치 후 버전 확인", "pass", formatVersion(installedAfter));

  if (compareBuildVersion(installedAfter.buildVersion, target.buildVersion) !== 0) {
    throw Object.assign(
      new Error(
        `설치 후 버전이 선택한 빌드와 다릅니다. 설치 후=${formatVersion(installedAfter)}, 선택=${target.displayVersion || "unknown"} (${target.buildVersion || "unknown"})`
      ),
      { steps }
    );
  }

  return buildResult({ installed_after: installedAfter, ipa_path: ipaPath });
}

module.exports = {
  getIosFirebaseReleases,
  runIosBuildInstallTest
};
