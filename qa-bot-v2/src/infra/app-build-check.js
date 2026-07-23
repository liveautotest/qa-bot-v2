const { runAdb } = require("./adb");
const {
  downloadReleaseBinary,
  getLatestRelease
} = require("./firebase-app-distribution");

function parseInstalledVersion(dumpsysOutput) {
  const versionName = dumpsysOutput.match(/versionName=([^\s]+)/)?.[1] || "";
  const versionCode =
    dumpsysOutput.match(/versionCode=(\d+)/)?.[1] ||
    dumpsysOutput.match(/longVersionCode=(\d+)/)?.[1] ||
    "";

  return {
    displayVersion: versionName,
    buildVersion: versionCode
  };
}

async function getInstalledAppVersion(config, device, appPackage) {
  const result = await runAdb(config, device, ["shell", "dumpsys", "package", appPackage]);
  return parseInstalledVersion(result.stdout);
}

function isBuildOlder(installed, latest) {
  const installedBuild = Number(installed.buildVersion || 0);
  const latestBuild = Number(latest.buildVersion || 0);
  if (installedBuild && latestBuild) return installedBuild < latestBuild;
  return installed.buildVersion !== latest.buildVersion;
}

function normalizeEnv(env) {
  return env === "stg" ? "staging" : env;
}

function getFirebaseAppId(config, env) {
  const normalizedEnv = normalizeEnv(env);
  const appIds = {
    staging: config.firebaseStagingAppId,
    dev: config.firebaseDevAppId
  };
  return appIds[normalizedEnv] || "";
}

function requireBuildCheckConfig(config, env) {
  const missing = [];
  if (!config.firebaseProjectNumber) missing.push("FIREBASE_PROJECT_NUMBER");
  if (!getFirebaseAppId(config, env)) {
    missing.push(normalizeEnv(env) === "dev" ? "FIREBASE_DEV_APP_ID" : "FIREBASE_STAGING_APP_ID");
  }
  if (!config.firebaseServiceAccountPath) missing.push("FIREBASE_SERVICE_ACCOUNT_PATH");
  if (missing.length > 0) {
    throw new Error(`Missing Firebase App Distribution config: ${missing.join(", ")}`);
  }
}

async function ensureLatestAppBuild({ request, config, store }) {
  const appBuildConfig = config.appBuild || {};
  if (!appBuildConfig.enabled) {
    return {
      status: "skipped",
      reason: "APP_BUILD_CHECK_ENABLED is not true."
    };
  }

  const env = request.env || "staging";
  const normalizedEnv = normalizeEnv(env);
  if (normalizedEnv !== "staging" && normalizedEnv !== "dev") {
    return {
      status: "skipped",
      reason: `Build auto-check is only enabled for staging/dev. env=${env}`
    };
  }

  requireBuildCheckConfig(appBuildConfig, normalizedEnv);

  const role = request.role || "guest";
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  const installedBefore = await getInstalledAppVersion(config, device, appPackage);
  const latestRelease = await getLatestRelease({
    ...appBuildConfig,
    firebaseAppId: getFirebaseAppId(appBuildConfig, normalizedEnv)
  });
  if (!latestRelease) {
    throw new Error("Firebase App Distribution latest release was not found.");
  }

  const latest = {
    displayVersion: latestRelease.displayVersion || "",
    buildVersion: latestRelease.buildVersion || "",
    firebaseConsoleUri: latestRelease.firebaseConsoleUri || "",
    testingUri: latestRelease.testingUri || ""
  };

  const result = {
    status: "pass",
    env,
    package: appPackage,
    installed_before: installedBefore,
    latest,
    action: "already_latest"
  };

  if (!isBuildOlder(installedBefore, latest)) {
    store.appendLog(
      "runner.log",
      `app build check: already latest ${installedBefore.displayVersion} (${installedBefore.buildVersion})`
    );
    return result;
  }

  if (!appBuildConfig.autoInstallLatestStaging) {
    result.status = "fail";
    result.action = "blocked_outdated";
    throw Object.assign(
      new Error(
        `스테이징 앱이 최신 빌드가 아닙니다. 단말=${installedBefore.displayVersion} (${installedBefore.buildVersion}), Firebase=${latest.displayVersion} (${latest.buildVersion})`
      ),
      {
        app_build: result,
        details: [
          "AUTO_INSTALL_LATEST_STAGING=true 설정이 없어서 자동 설치하지 않았습니다.",
          "단말의 스테이징 앱을 최신 빌드로 업데이트한 뒤 다시 실행해주세요."
        ]
      }
    );
  }

  const apkPath = await downloadReleaseBinary(latestRelease, appBuildConfig.downloadDir);
  result.action = "installed_latest";
  result.downloaded_apk = apkPath;
  await runAdb(config, device, ["install", "-r", apkPath]);
  const installedAfter = await getInstalledAppVersion(config, device, appPackage);
  result.installed_after = installedAfter;

  if (isBuildOlder(installedAfter, latest)) {
    result.status = "fail";
    throw Object.assign(
      new Error(
        `최신 스테이징 APK 설치 후에도 빌드가 최신이 아닙니다. 설치 후=${installedAfter.displayVersion} (${installedAfter.buildVersion}), Firebase=${latest.displayVersion} (${latest.buildVersion})`
      ),
      {
        app_build: result,
        details: ["Firebase App Distribution의 최신 APK와 단말 설치 결과가 일치하는지 확인해주세요."]
      }
    );
  }

  store.appendLog(
    "runner.log",
    `app build check: installed latest ${installedAfter.displayVersion} (${installedAfter.buildVersion})`
  );
  return result;
}

module.exports = {
  ensureLatestAppBuild,
  getInstalledAppVersion,
  parseInstalledVersion
};
