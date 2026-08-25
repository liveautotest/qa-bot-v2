const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const locks = new Set();
const lockDir = path.resolve(__dirname, "../../.tmp/device-locks");

function lockPathFor(key) {
  const digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 20);
  return path.join(lockDir, `${digest}.lock`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function acquireProcessLock(key) {
  fs.mkdirSync(lockDir, { recursive: true });
  const filePath = lockPathFor(key);
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ deviceId: key, pid: process.pid, token, createdAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(filePath, "wx");
      fs.writeFileSync(fd, payload, "utf8");
      fs.closeSync(fd);
      return { filePath, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readLock(filePath);
      if (existing && isProcessAlive(Number(existing.pid))) {
        throw new Error(`Device is already busy: ${key}`);
      }
      if (!existing) {
        let ageMs;
        try {
          ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
        } catch (statError) {
          if (statError.code === "ENOENT") continue;
          throw statError;
        }
        // 다른 프로세스가 잠금 내용을 기록 중인 짧은 구간에는 활성 잠금으로 취급한다.
        if (ageMs < 30000) throw new Error(`Device is already busy: ${key}`);
      }

      // 소유 프로세스가 종료된 잠금만 제거하고 한 번 다시 획득한다.
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }

  throw new Error(`Device is already busy: ${key}`);
}

function releaseProcessLock(lock) {
  if (!lock) return;
  const existing = readLock(lock.filePath);
  if (existing?.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function withDeviceLock(deviceId, fn) {
  const key = deviceId || "default-device";

  if (locks.has(key)) {
    throw new Error(`Device is already busy: ${key}`);
  }

  locks.add(key);
  let processLock;
  try {
    processLock = acquireProcessLock(key);
    return await fn();
  } finally {
    releaseProcessLock(processLock);
    locks.delete(key);
  }
}

module.exports = {
  withDeviceLock
};
