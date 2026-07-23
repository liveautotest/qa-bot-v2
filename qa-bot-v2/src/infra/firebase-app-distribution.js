const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const API_HOST = "firebaseappdistribution.googleapis.com";

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

async function getAccessToken(serviceAccountPath) {
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

async function listReleases({ projectNumber, appId, serviceAccountPath }) {
  const accessToken = await getAccessToken(serviceAccountPath);
  return requestJson({
    method: "GET",
    hostname: API_HOST,
    path:
      `/v1/projects/${encodeURIComponent(projectNumber)}` +
      `/apps/${encodeURIComponent(appId)}/releases?pageSize=1&orderBy=createTime%20desc`,
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
  const destination = path.join(destinationDir, `staging-${buildVersion}.apk`);
  return downloadFile(release.binaryDownloadUri, destination);
}

module.exports = {
  downloadReleaseBinary,
  getLatestRelease
};
