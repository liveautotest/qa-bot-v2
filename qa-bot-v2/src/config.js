const fs = require("fs");
const path = require("path");

function parseEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  const body = fs.readFileSync(filePath, "utf8");

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    values[key] = value;
  }

  return values;
}

function loadConfig() {
  const projectRoot = path.resolve(__dirname, "..");
  const localEnv = parseEnvFile(path.join(projectRoot, ".env"));
  const externalEnv = parseEnvFile(process.env.QA_ENV_PATH);
  const env = { ...localEnv, ...externalEnv, ...process.env };

  return {
    projectRoot,
    dryRun: env.QA_DRY_RUN !== "false",
    reportBaseDir: path.resolve(projectRoot, env.QA_REPORT_BASE_DIR || "reports"),
    slackBotToken: env.SLACK_BOT_TOKEN || "",
    slackAppToken: env.SLACK_APP_TOKEN || "",
    slackResultChannel: env.SLACK_RESULT_CHANNEL || "",
    slackResultChannelAllowlist: env.SLACK_RESULT_CHANNEL_ALLOWLIST || "",
    adbPath: env.ADB_PATH || "adb",
    devices: {
      guest: env.ADB_GUEST_DEVICE || "",
      host: env.ADB_HOST_DEVICE || ""
    },
    androidPackages: {
      staging: env.ANDROID_STAGING_PACKAGE || "com.live1month.live1month.staging",
      stg: env.ANDROID_STAGING_PACKAGE || "com.live1month.live1month.staging",
      dev: env.ANDROID_DEV_PACKAGE || "com.live1month.live1month.dev",
      prod: env.ANDROID_PROD_PACKAGE || "com.live1month.live1month"
    },
    appBuild: {
      enabled: env.APP_BUILD_CHECK_ENABLED === "true",
      autoInstallLatestStaging:
        env.AUTO_INSTALL_LATEST_STAGING === "true" || env.AUTO_INSTALL_LATEST_APP === "true",
      firebaseProjectNumber: env.FIREBASE_PROJECT_NUMBER || "",
      firebaseStagingAppId: env.FIREBASE_STAGING_APP_ID || "",
      firebaseDevAppId: env.FIREBASE_DEV_APP_ID || "",
      firebaseServiceAccountPath: env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
      downloadDir: path.resolve(projectRoot, env.APP_BUILD_DOWNLOAD_DIR || ".tmp/app-builds")
    },
    tossAdmin: {
      url: env.TOSS_ADMIN_URL || "",
      mid: env.TOSS_ADMIN_MID || "",
      email: env.TOSS_ADMIN_EMAIL || "",
      password: env.TOSS_ADMIN_PASSWORD || "",
      headless: env.TOSS_ADMIN_HEADLESS === "true",
      chromePath: env.TOSS_ADMIN_CHROME_PATH || "",
      profileDir: env.TOSS_ADMIN_PROFILE_DIR || ".tmp/toss-admin-profile",
      keepOpenOnFail: env.TOSS_ADMIN_KEEP_OPEN_ON_FAIL === "true"
    },
    accounts: {
      guest: {
        email: env.GUEST_EMAIL || "",
        password: env.GUEST_PASSWORD || ""
      },
      host: {
        email: env.HOST_EMAIL || "",
        password: env.HOST_PASSWORD || ""
      }
    },
    login: {
      dismissUpdateLaterTap: env.LOGIN_DISMISS_UPDATE_LATER_TAP || "",
      firstLoginTap: env.LOGIN_FIRST_LOGIN_TAP || "",
      submitTap: env.LOGIN_SUBMIT_TAP || ""
    }
  };
}

module.exports = {
  loadConfig
};
