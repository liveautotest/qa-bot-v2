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

async function inputUnicodeText(config, device, value, store) {
  try {
    await inputText(config, device, value);
    return;
  } catch (error) {
    store.appendLog(
      "runner.log",
      `adb input text failed for unicode value, retrying with ADB Keyboard: ${error.message}`
    );
  }

  const adbKeyboard = "com.android.adbkeyboard/.AdbIME";
  const previousIme = await getCurrentIme(config, device);
  const imeList = await runAdb(config, device, ["shell", "ime", "list", "-s"]);
  if (!imeList.stdout.includes(adbKeyboard)) {
    throw new Error("ADB Keyboard가 설치되어 있지 않아 한글 텍스트를 자동 입력할 수 없습니다.");
  }

  await runAdb(config, device, ["shell", "ime", "set", adbKeyboard]);
  const message = Buffer.from(String(value), "utf8").toString("base64");
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

  if (previousIme && previousIme !== adbKeyboard) {
    await runAdb(config, device, ["shell", "ime", "set", previousIme]).catch((error) => {
      store.appendLog("runner.log", `failed to restore ime ${previousIme}: ${error.message}`);
    });
  }
}

module.exports = {
  inputUnicodeText
};
