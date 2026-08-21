const { inputText, runAdb } = require("../infra/adb");

async function getCurrentIme(config, device) {
  try {
    const result = await runAdb(config, device, [
      "shell",
      "settings",
      "get",
      "secure",
      "default_input_method"
    ]);
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function inputUnicodeText(config, device, value, store, options = {}) {
  const text = String(value);
  const needsUnicodeIme = /[^\x20-\x7E]/.test(text);

  if (!needsUnicodeIme) {
    await inputText(config, device, text);
    return;
  }

  // `adb shell input text` can return success while silently dropping Hangul.
  // Route non-ASCII values through ADB Keyboard before trusting the command result.
  store.appendLog("runner.log", "unicode text detected; using ADB Keyboard input");

  const adbKeyboard = "com.android.adbkeyboard/.AdbIME";
  const previousIme = await getCurrentIme(config, device);
  const imeList = await runAdb(config, device, ["shell", "ime", "list", "-s"]);
  if (!imeList.stdout.includes(adbKeyboard)) {
    throw new Error("ADB Keyboard가 설치되어 있지 않아 한글 텍스트를 자동 입력할 수 없습니다.");
  }

  try {
    await runAdb(config, device, ["shell", "ime", "set", adbKeyboard]);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Switching IMEs can detach a focused WebView input. Re-focus it after the switch.
    if (typeof options.refocus === "function") {
      await options.refocus();
      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    const message = Buffer.from(text, "utf8").toString("base64");
    await runAdb(config, device, [
      "shell",
      "am",
      "broadcast",
      "-a",
      "ADB_INPUT_B64",
      "--es",
      "msg",
      message
    ]);
    await new Promise((resolve) => setTimeout(resolve, 350));
  } finally {
    if (previousIme && previousIme !== adbKeyboard) {
      await runAdb(config, device, ["shell", "ime", "set", previousIme]).catch((error) => {
        store.appendLog("runner.log", `failed to restore ime ${previousIme}: ${error.message}`);
      });
    }
  }
}

module.exports = {
  inputUnicodeText
};
