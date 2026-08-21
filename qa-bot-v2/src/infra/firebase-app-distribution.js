const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const API_HOST = "firebaseappdistribution.googleapis.com";
const FIREBASE_CLI_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function requestJson({ method, hostname, path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname,
        path: requestPath,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(new Error(`Failed to parse JSON response: ${error.message}`));
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const file = fs.createWriteStream(destination);

    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destination);
          downloadFile(res.headers.location, destination).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destination);
          reject(new Error(`Download failed with HTTP ${res.statusCode}`));
          return;
        }

        res.pipe(file);
        file.on("finish", () => {
          file.close(() => resolve(destination));
        });
      })
      .on("error", (error) => {
        file.close();
        if (fs.existsSync(destination)) fs.unlinkSync(destination);
        reject(error);
      });
  });
}

function createServiceAccountJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600
  };

  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedToken)
    .sign(serviceAccount.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${unsignedToken}.${signature}`;
}

async function getServiceAccountAccessToken(serviceAccountPath) {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  const assertion = createServiceAccountJwt(serviceAccount);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  }).toString();

  const response = await requestJson({
    method: "POST",
    hostname: "oauth2.googleapis.com",
    path: "/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  return response.access_token;
}

function getFirebaseCliConfigPath() {
  return path.join(process.env.HOME || "", ".config", "configstore", "firebase-tools.json");
}

function readFirebaseCliRefreshToken(configPath = getFirebaseCliConfigPath()) {
  if (!fs.existsSync(configPath)) {
    throw new Error("Firebase CLI 로그인 정보를 찾지 못했습니다. firebase login 후 다시 실행해주세요.");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const refreshToken = config.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("Firebase CLI refresh token이 없습니다. firebase login --reauth 후 다시 실행해주세요.");
  }
  return refreshToken;
}

async function getFirebaseCliAccessToken() {
  const refreshToken = readFirebaseCliRefreshToken();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: FIREBASE_CLI_CLIENT_ID,
    client_secret: FIREBASE_CLI_CLIENT_SECRET,
    grant_type: "refresh_token"
  }).toString();

  const response = await requestJson({
    method: "POST",
    hostname: "oauth2.googleapis.com",
    path: "/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  return response.access_token;
}

async function getAccessToken(serviceAccountPath) {
  if (serviceAccountPath) {
    return getServiceAccountAccessToken(serviceAccountPath);
  }

  // 서비스 계정 키 파일 없이도 이 Mac의 `firebase login` 세션을 재사용한다.
  // 토큰 값은 로그/리포트에 남기지 않고 access token 교환에만 사용한다.
  return getFirebaseCliAccessToken();
}

async function listReleases({ projectNumber, appId, serviceAccountPath, pageSize = 10 }) {
  const accessToken = await getAccessToken(serviceAccountPath);
  return requestJson({
    method: "GET",
    hostname: API_HOST,
    path:
      `/v1/projects/${encodeURIComponent(projectNumber)}` +
      `/apps/${encodeURIComponent(appId)}/releases?pageSize=${encodeURIComponent(pageSize)}&orderBy=createTime%20desc`,
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

async function getLatestRelease(config) {
  const response = await listReleases({
    projectNumber: config.firebaseProjectNumber,
    appId: config.firebaseAppId || config.firebaseStagingAppId,
    serviceAccountPath: config.firebaseServiceAccountPath
  });

  return response.releases && response.releases.length > 0 ? response.releases[0] : null;
}

async function downloadReleaseBinary(release, destinationDir) {
  if (!release.binaryDownloadUri) {
    throw new Error("Firebase latest release does not include binaryDownloadUri.");
  }

  const buildVersion = release.buildVersion || "unknown";
  const appName = String(release.name || "app").split("/apps/")[1]?.split("/")[0] || "app";
  const destination = path.join(destinationDir, `${appName}-${buildVersion}.apk`);

  // Firebase 릴리즈 바이너리는 앱 ID와 versionCode 기준으로 고정된다.
  // 이미 정상적으로 내려받은 APK가 있으면 200MB 이상의 재다운로드를 생략한다.
  if (fs.existsSync(destination)) {
    const stat = fs.statSync(destination);
    const header = Buffer.alloc(2);
    const fd = fs.openSync(destination, "r");
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (stat.size > 1024 * 1024 && header.toString("utf8") === "PK") {
      return destination;
    }
  }

  return downloadFile(release.binaryDownloadUri, destination);
}

module.exports = {
  downloadFile,
  downloadReleaseBinary,
  getLatestRelease,
  listReleases,
  readFirebaseCliRefreshToken
};
