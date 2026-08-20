const path = require("path");
const { runAdb } = require("../infra/adb");
const { getInstalledAppVersion } = require("../infra/app-build-check");
const {
  downloadReleaseBinary,
  listReleases
} = require("../infra/firebase-app-distribution");

function normalizeEnv(env) {
  return env === "stg" ? "staging" : env;
}

function getFirebaseAppId(config, env) {
  const appBuild = config.appBuild || {};
  return normalizeEnv(env) === "dev" ? appBuild.firebaseDevAppId : appBuild.firebaseStagingAppId;
}

function requireBuildInstallConfig(config, env) {
  const missing = [];
  const appBuild = config.appBuild || {};
  if (!appBuild.firebaseProjectNumber) missing.push("FIREBASE_PROJECT_NUMBER");
  if (!getFirebaseAppId(config, env)) {
    missing.push(normalizeEnv(env) === "dev" ? "FIREBASE_DEV_APP_ID" : "FIREBASE_STAGING_APP_ID");
  }
  if (missing.length) {
    throw new Error(`Firebase 빌드 설치 설정이 없습니다: ${missing.join(", ")}`);
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

async function getFirebaseReleases(config, env, pageSize = 20) {
  requireBuildInstallConfig(config, env);
  const appBuild = config.appBuild || {};
  const response = await listReleases({
    projectNumber: appBuild.firebaseProjectNumber,
    appId: getFirebaseAppId(config, env),
    serviceAccountPath: appBuild.firebaseServiceAccountPath,
    pageSize
  });
  return response.releases || [];
}

async function findTargetRelease(config, request) {
  const releases = await getFirebaseReleases(config, request.env, 30);
  if (!releases.length) throw new Error("Firebase App Distribution 릴리즈를 찾지 못했습니다.");

  const releaseName = request.release_name || "";
  const buildVersion = request.build_version || "";
  const hasExplicitTarget = Boolean(releaseName || buildVersion);
  const target = releases.find((release) => release.name === releaseName) ||
    releases.find((release) => String(release.buildVersion || "") === String(buildVersion));

  if (hasExplicitTarget && !target) {
    throw new Error(`선택한 Firebase 빌드를 찾지 못했습니다: ${releaseName || buildVersion}`);
  }

  return {
    releases,
    target: target || releases[0]
  };
}

async function runBuildInstallTest({ request, config, store }) {
  const env = normalizeEnv(request.env || "staging");
  const role = request.role || "guest";
  const device = config.devices?.[role] || "";
  const appPackage = config.androidPackages?.[env] || "";
  const steps = [];
  const startedAt = Date.now();

  const addStep = (name, status = "pass", message = "") => {
    steps.push({ name, status, ...(message ? { message } : {}) });
  };

  if (env !== "staging" && env !== "dev") {
    throw Object.assign(new Error("빌드 설치는 dev/stg Android 앱만 지원합니다."), { steps });
  }
  if (!device) throw Object.assign(new Error(`테스터 단말 ID를 찾지 못했습니다: ${role}`), { steps });
  if (!appPackage) throw Object.assign(new Error(`Android 패키지명을 찾지 못했습니다: ${env}`), { steps });

  const { target } = await findTargetRelease(config, { ...request, env });
  addStep("Firebase 빌드 목록 확인", "pass", `${target.displayVersion || "unknown"} (${target.buildVersion || "unknown"})`);

  let installedBefore = null;
  try {
    installedBefore = await getInstalledAppVersion(config, device, appPackage);
    addStep("단말 기존 설치 버전 확인", "pass", formatVersion(installedBefore));
  } catch (error) {
    installedBefore = { displayVersion: "", buildVersion: "" };
    addStep("단말 기존 설치 버전 확인", "pass", "미설치 또는 버전 확인 불가");
    store.appendLog("runner.log", `installed version check skipped: ${error.message}`);
  }

  const compare = compareBuildVersion(target.buildVersion, installedBefore.buildVersion);
  let installAction = "same-version";
  let actionLabel = "동일 버전, 설치 생략";

  if (compare > 0 || !installedBefore.buildVersion) {
    installAction = "update";
    actionLabel = installedBefore.buildVersion ? "업데이트 설치" : "신규 설치";
  } else if (compare < 0) {
    installAction = "downgrade-reinstall";
    actionLabel = "삭제 후 낮은 버전 설치";
  }

  if (installAction === "same-version") {
    return {
      test_id: "TC-BUILD-INSTALL-001",
      name: `${role} 빌드 설치`,
      env,
      status: "pass",
      device,
      role,
      duration_ms: Date.now() - startedAt,
      build_install: {
        tester_role: role,
        package: appPackage,
        verified_at: new Date().toISOString(),
        installed_before: installedBefore,
        target_build: {
          displayVersion: target.displayVersion || "",
          buildVersion: target.buildVersion || "",
          firebaseConsoleUri: target.firebaseConsoleUri || "",
          releaseNotes: target.releaseNotes?.text || ""
        },
        action: installAction,
        action_label: actionLabel
      },
      steps
    };
  }

  const apkPath = await downloadReleaseBinary(target, config.appBuild.downloadDir);
  addStep("Firebase APK 다운로드", "pass", path.basename(apkPath));

  if (installAction === "downgrade-reinstall") {
    // 낮은 versionCode 설치는 Android가 차단하므로 해당 앱 패키지만 삭제한 뒤 설치한다.
    await runAdb(config, device, ["uninstall", appPackage]).catch((error) => {
      store.appendLog("runner.log", `uninstall before downgrade ignored: ${error.message}`);
    });
    addStep("기존 앱 삭제", "pass", appPackage);
  }

  await runAdb(config, device, ["install", "-r", apkPath]);
  addStep("APK 설치", "pass", actionLabel);

  const installedAfter = await getInstalledAppVersion(config, device, appPackage);
  addStep("설치 후 버전 확인", "pass", formatVersion(installedAfter));

  if (compareBuildVersion(installedAfter.buildVersion, target.buildVersion) !== 0) {
    throw Object.assign(
      new Error(`설치 후 버전이 선택한 빌드와 다릅니다. 설치 후=${formatVersion(installedAfter)}, 선택=${target.displayVersion || "unknown"} (${target.buildVersion || "unknown"})`),
      { steps }
    );
  }

  return {
    test_id: "TC-BUILD-INSTALL-001",
    name: `${role} 빌드 설치`,
    env,
    status: "pass",
    device,
    role,
    duration_ms: Date.now() - startedAt,
    build_install: {
      tester_role: role,
      package: appPackage,
      verified_at: new Date().toISOString(),
      installed_before: installedBefore,
      installed_after: installedAfter,
      target_build: {
        displayVersion: target.displayVersion || "",
        buildVersion: target.buildVersion || "",
        firebaseConsoleUri: target.firebaseConsoleUri || "",
        releaseNotes: target.releaseNotes?.text || ""
      },
      action: installAction,
      action_label: actionLabel,
      apk_path: apkPath
    },
    steps
  };
}

module.exports = {
  getFirebaseReleases,
  runBuildInstallTest
};
