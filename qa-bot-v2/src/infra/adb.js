const { execFile } = require("child_process");

function execAdb(config, adbArgs, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, adbArgs, { maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function shouldRetryAdb(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /device .* not found|cannot connect to daemon|failed to check server version|daemon not running/i.test(message);
}

async function startAdbServer(config) {
  await execAdb(config, ["start-server"]).catch(() => {});
}

async function appendDeviceListToError(config, error) {
  const result = await execAdb(config, ["devices", "-l"]).catch(() => null);
  if (!result) return error;

  error.message = `${error.message}\n\nCurrent adb devices:\n${result.stdout.trim() || "(none)"}`;
  return error;
}

async function runAdb(config, deviceId, args) {
  const adbArgs = deviceId ? ["-s", deviceId, ...args] : args;

  try {
    return await execAdb(config, adbArgs);
  } catch (error) {
    if (!shouldRetryAdb(error)) throw error;

    // USB/daemon 상태가 잠깐 흔들리는 경우가 있어 서버를 깨우고 한 번만 재시도한다.
    await startAdbServer(config);
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      return await execAdb(config, adbArgs);
    } catch (retryError) {
      throw await appendDeviceListToError(config, retryError);
    }
  }
}

async function runAdbBuffer(config, deviceId, args) {
  const adbArgs = deviceId ? ["-s", deviceId, ...args] : args;

  try {
    return await execAdb(config, adbArgs, { encoding: "buffer" });
  } catch (error) {
    if (!shouldRetryAdb(error)) throw error;

    await startAdbServer(config);
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      return await execAdb(config, adbArgs, { encoding: "buffer" });
    } catch (retryError) {
      throw await appendDeviceListToError(config, retryError);
    }
  }
}

async function tap(config, deviceId, x, y) {
  return runAdb(config, deviceId, ["shell", "input", "tap", String(x), String(y)]);
}

async function inputText(config, deviceId, value) {
  const escaped = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\s/g, "%s")
    .replace(/[()<>|;&*~"'`$]/g, "\\$&");

  return runAdb(config, deviceId, ["shell", "input", "text", escaped]);
}

async function keyEvent(config, deviceId, keyCode) {
  return runAdb(config, deviceId, ["shell", "input", "keyevent", String(keyCode)]);
}

async function dumpUi(config, deviceId) {
  const result = await runAdb(config, deviceId, ["exec-out", "uiautomator", "dump", "/dev/tty"]);
  return result.stdout;
}

async function screenshotPng(config, deviceId) {
  const result = await runAdbBuffer(config, deviceId, ["exec-out", "screencap", "-p"]);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngStart = result.stdout.indexOf(pngSignature);

  if (pngStart === -1) {
    throw new Error("ADB screencap output did not contain a PNG image.");
  }

  return result.stdout.subarray(pngStart);
}

module.exports = {
  dumpUi,
  inputText,
  keyEvent,
  runAdb,
  runAdbBuffer,
  screenshotPng,
  tap
};
