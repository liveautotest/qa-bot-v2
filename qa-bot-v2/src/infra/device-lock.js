const locks = new Set();

async function withDeviceLock(deviceId, fn) {
  const key = deviceId || "default-device";

  if (locks.has(key)) {
    throw new Error(`Device is already busy: ${key}`);
  }

  locks.add(key);
  try {
    return await fn();
  } finally {
    locks.delete(key);
  }
}

module.exports = {
  withDeviceLock
};
