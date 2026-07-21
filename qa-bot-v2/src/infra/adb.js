const { execFile } = require("child_process");

function runAdb(config, deviceId, args) {
  return new Promise((resolve, reject) => {
    const adbArgs = deviceId ? ["-s", deviceId, ...args] : args;

    execFile(config.adbPath, adbArgs, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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

function runAdbBuffer(config, deviceId, args) {
  return new Promise((resolve, reject) => {
    const adbArgs = deviceId ? ["-s", deviceId, ...args] : args;

    execFile(
      config.adbPath,
      adbArgs,
      { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
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
