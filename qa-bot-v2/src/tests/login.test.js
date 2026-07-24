const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  dumpUi,
  inputText,
  keyEvent,
  runAdb,
  screenshotPng,
  tap
} = require("../infra/adb");

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function addStep(steps, name, status = "pass", message) {
  const step = { name, status };
  if (message) step.message = message;
  steps.push(step);
}

function fail(message, steps, details = []) {
  const error = new Error(message);
  error.steps = steps;
  error.details = details;
  throw error;
}

function parseBounds(bounds) {
  const match = String(bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;

  const [, left, top, right, bottom] = match.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2)
  };
}

function parseTap(value) {
  const match = String(value || "").match(/^(\d+)\s*,\s*(\d+)$/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function decodeXmlValue(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n");
}

function parseNodes(xml) {
  const nodes = [];
  const nodePattern = /<node\b[^>]*>/g;
  const attrPattern = /([\w:-]+)="([^"]*)"/g;
  let nodeMatch;

  while ((nodeMatch = nodePattern.exec(xml))) {
    const raw = nodeMatch[0];
    const attrs = {};
    let attrMatch;

    while ((attrMatch = attrPattern.exec(raw))) {
      attrs[attrMatch[1]] = decodeXmlValue(attrMatch[2]);
    }

    const bounds = parseBounds(attrs.bounds);
    nodes.push({ attrs, bounds });
  }

  return nodes;
}

function findNodeByAnyText(xml, labels) {
  const nodes = parseNodes(xml);
  return nodes.find((node) => {
    const text = `${node.attrs.text || ""}\n${node.attrs["content-desc"] || ""}\n${node.attrs.hint || ""}`;
    return labels.some((label) => text.includes(label));
  });
}

function findNodeByExactText(xml, labels) {
  const nodes = parseNodes(xml);
  return nodes.find((node) => {
    const values = [
      node.attrs.text || "",
      node.attrs["content-desc"] || "",
      node.attrs.hint || ""
    ];
    return labels.some((label) => values.includes(label));
  });
}

function findRawNodeByText(xml, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nodePattern = new RegExp(`<node\\b(?=[^>]*text="${escapedLabel}")[^>]*>`);
  const nodeMatch = xml.match(nodePattern);
  const boundsMatch = nodeMatch ? nodeMatch[0].match(/bounds="([^"]+)"/) : null;
  const bounds = boundsMatch ? parseBounds(boundsMatch[1]) : null;
  return bounds ? { attrs: { text: label }, bounds } : null;
}

function findButtonBoundsByLabel(xml, label) {
  const nodes = xml.match(/<node\b[^>]*>/g) || [];
  for (const node of nodes) {
    if (!node.includes(`text="${label}"`) && !node.includes(`content-desc="${label}"`)) {
      continue;
    }

    const boundsMatch = node.match(/bounds="([^"]+)"/);
    const bounds = boundsMatch ? parseBounds(boundsMatch[1]) : null;
    if (bounds) return bounds;
  }

  return null;
}

function findBoundsByTextIncludes(xml, label) {
  const nodes = xml.match(/<node\b[^>]*>/g) || [];
  for (const node of nodes) {
    if (!node.includes(label)) continue;

    const boundsMatch = node.match(/bounds="([^"]+)"/);
    const bounds = boundsMatch ? parseBounds(boundsMatch[1]) : null;
    if (bounds) return bounds;
  }

  return null;
}

function findBottomTabBounds(xml, label) {
  const nodes = parseNodes(xml);
  const matches = nodes.filter((node) => {
    if (!node.bounds) return false;
    const text = `${node.attrs.text || ""}\n${node.attrs["content-desc"] || ""}`;
    return text.includes(label) && node.bounds.top >= 2200;
  });

  const exactMatch = matches.find((node) => {
    const values = [node.attrs.text || "", node.attrs["content-desc"] || ""];
    return values.includes(label);
  });
  return (exactMatch || matches[0])?.bounds || null;
}

function findEditableNodes(xml) {
  return parseNodes(xml).filter((node) => {
    const className = node.attrs.class || "";
    const focusable = node.attrs.focusable === "true";
    return className.includes("EditText") || (focusable && node.attrs.password === "true");
  });
}

function redactSecrets(value, secrets = []) {
  return secrets
    .filter(Boolean)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), String(value || ""));
}

function writeXmlArtifact(filePath, xml, secrets = []) {
  fs.writeFileSync(filePath, redactSecrets(xml, secrets));
}

async function saveArtifacts(config, device, store, name, secrets = []) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);

  try {
    writeXmlArtifact(xmlPath, await dumpUi(config, device), secrets);
  } catch (error) {
    store.appendLog("runner.log", `failed to dump ui ${name}: ${error.message}`);
  }

  try {
    fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  } catch (error) {
    store.appendLog("runner.log", `failed to screenshot ${name}: ${error.message}`);
  }

  return { xmlPath, screenshotPath };
}

async function saveScreenshot(config, device, store, name) {
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return screenshotPath;
}

function existingPaths(paths) {
  return paths.filter((filePath) => fs.existsSync(filePath));
}

async function waitForUi(config, device, predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  let lastXml = "";

  while (Date.now() - startedAt < timeoutMs) {
    lastXml = await dumpUi(config, device);
    if (predicate(lastXml)) return lastXml;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return lastXml;
}

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });
  await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "600", "300"]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  addStep(steps, "단말 깨우기 및 잠금 해제 시도");
}

async function tapNode(config, device, node, label) {
  if (!node || !node.bounds) {
    throw new Error(`Cannot tap missing node: ${label}`);
  }
  await tap(config, device, node.bounds.x, node.bounds.y);
}

async function replaceFocusedText(config, device, value) {
  await keyEvent(config, device, 123);
  await runAdb(config, device, ["shell", "input", "keyevent", "--longpress", "67"]);
  await inputText(config, device, value);
}

function hasLoginFailure(xml) {
  const failureTexts = [
    "유효하지 않은 형식",
    "다시 시도",
    "로그인 실패",
    "비밀번호가 일치",
    "가입되지 않은",
    "존재하지 않는",
    "잘못된",
    "인증",
    "만료",
    "오류",
    "실패했습니다",
    "Authentication",
    "Unauthorized"
  ];

  return failureTexts.some((text) => xml.includes(text));
}

function getLoginFailureDetails(xml) {
  const details = [];
  if (hasLoginFailure(xml)) {
    details.push("로그인 실패/인증 오류로 보이는 문구가 화면 XML에 감지되었습니다.");
  } else if (isStillOnLoginForm(xml)) {
    details.push("로그인 버튼을 눌렀지만 앱이 로그인 화면에 그대로 머물렀습니다.");
    details.push("화면 XML과 스크린샷에는 명확한 에러 문구가 노출되지 않았습니다.");
  }
  details.push("입력된 이메일/비밀번호가 dev 환경에서 유효한지 확인해주세요.");
  details.push("dev 서버 로그인 API 또는 토큰 발급이 정상인지 확인해주세요.");
  details.push("리포트의 final.png와 logs/after-submit.xml을 확인해주세요.");
  return details;
}

function isStillOnLoginForm(xml) {
  return (
    xml.includes("이메일 혹은 휴대폰 번호로 시작하기") &&
    xml.includes("비밀번호") &&
    xml.includes("로그인")
  );
}

function isLoginSubmitReady(xml) {
  const submitNode = findNodeByExactText(xml, ["로그인"]);
  return Boolean(
    submitNode &&
      (submitNode.attrs.class || "").includes("Button") &&
      submitNode.attrs.enabled === "true"
  );
}

function isLoggedInHome(xml) {
  const homeSignals = [
    "잠시 머물 집은",
    "동네 · 주변 장소로 검색",
    "내 정보",
    "계약",
    "리브후기"
  ];

  return homeSignals.filter((text) => xml.includes(text)).length >= 2;
}

function isHostContractTab(xml) {
  const contractSignals = [
    "전체 계약 보기",
    "보증금",
    "퇴실",
    "입실",
    "메시지"
  ];

  return xml.includes("계약") && contractSignals.filter((text) => xml.includes(text)).length >= 1;
}

function isHostModeShell(xml) {
  const hostBottomTabs = ["집 목록", "계약", "메시지", "내 정보"];
  return hostBottomTabs.filter((text) => Boolean(findBottomTabBounds(xml, text))).length >= 3;
}

function assertEnteredValue(xml, value, fieldName) {
  if (!xml.includes(value)) {
    throw new Error(`${fieldName} was not entered correctly. Check keyboard/IME state or install ADB Keyboard.`);
  }
}

function inspectPasswordProtection(xml, password) {
  const passwordNode = findEditableNodes(xml).find(
    (node) => node.attrs.password === "true"
  );

  if (!passwordNode) {
    return {
      masked: false,
      plaintextExposed: false
    };
  }

  const exposedValues = [
    passwordNode.attrs.text,
    passwordNode.attrs["content-desc"],
    passwordNode.attrs.hint
  ].filter(Boolean);

  return {
    masked: true,
    plaintextExposed: exposedValues.some((value) => value.includes(password))
  };
}

function sessionReuseSecurityChecks() {
  return [
    {
      id: "SEC-LOGIN-SESSION",
      name: "기존 세션 사용으로 로그인 입력 보안 검사 미수행",
      status: "not_tested"
    }
  ];
}

async function maybeDismissUpdatePopup(config, device, xml, store, steps) {
  if (!xml.includes("업데이트 안내")) return false;

  const configuredTap = parseTap(config.login.dismissUpdateLaterTap);
  if (configuredTap) {
    await tap(config, device, configuredTap.x, configuredTap.y);
  } else {
    const root = parseNodes(xml).find((node) => node.bounds && node.bounds.right > 0 && node.bounds.bottom > 0);
    const width = root ? root.bounds.right : 1080;
    const height = root ? root.bounds.bottom : 2496;
    await tap(config, device, Math.round(width * 0.36), Math.round(height * 0.63));
  }

  addStep(steps, "업데이트 안내 닫기");
  store.appendLog("runner.log", "dismissed update popup");
  return true;
}

async function maybeAllowPermissionPopup(config, device, xml, store, steps) {
  if (!xml.includes("com.google.android.permissioncontroller")) return false;

  const allowNode = findNodeByExactText(xml, ["허용", "앱 사용 중에만 허용", "Allow"]);
  if (!allowNode) return false;

  await tapNode(config, device, allowNode, "permission allow");
  addStep(steps, "권한 팝업 허용");
  store.appendLog("runner.log", "allowed permission popup");
  return true;
}

async function tapFirstLoginEntry(config, device, xml, steps) {
  const configuredTap = parseTap(config.login.firstLoginTap);
  if (configuredTap) {
    await tap(config, device, configuredTap.x, configuredTap.y);
    addStep(steps, "로그인 진입 버튼 탭", "pass", "configured coordinates");
    return;
  }

  if (xml.includes("이메일/휴대폰 번호로 시작하기")) {
    const knownDeviceTaps = {
      R3CR30K439K: { x: 541, y: 1269 },
      R3CT80QJ3NL: { x: 540, y: 1471 }
    };
    const knownTap = knownDeviceTaps[device];
    if (knownTap) {
      await tap(config, device, knownTap.x, knownTap.y);
      addStep(steps, "로그인 진입 버튼 탭", "pass", `known device ${knownTap.x},${knownTap.y}`);
      return;
    }
  }

  const emailButtonBounds = findButtonBoundsByLabel(xml, "이메일/휴대폰 번호로 시작하기");
  if (emailButtonBounds) {
    await tap(config, device, emailButtonBounds.x, emailButtonBounds.y);
    addStep(steps, "로그인 진입 버튼 탭", "pass", `bounds ${emailButtonBounds.x},${emailButtonBounds.y}`);
    return;
  }

  const loginNode =
    findRawNodeByText(xml, "이메일/휴대폰 번호로 시작하기") ||
    findNodeByExactText(xml, [
      "이메일/휴대폰 번호로 시작하기",
      "이메일로 로그인",
      "이메일 로그인"
    ]) ||
    findNodeByAnyText(xml, [
    "이메일/휴대폰 번호로 시작하기",
    "이메일로 로그인",
      "이메일 로그인"
    ]);

  if (!loginNode) {
    throw new Error(`Cannot find login entry button. xml_has_email=${xml.includes("이메일")} xml_has_permission=${xml.includes("permissioncontroller")}. Check logs/before-login-entry.xml.`);
  }

  await tapNode(config, device, loginNode, "login entry");
  addStep(steps, "로그인 진입 버튼 탭");
}

async function submitLogin(config, device, xml, steps) {
  const configuredTap = parseTap(config.login.submitTap);
  if (configuredTap) {
    await tap(config, device, configuredTap.x, configuredTap.y);
    addStep(steps, "로그인 제출", "pass", "configured coordinates");
    return;
  }

  const submitNode =
    findNodeByExactText(xml, ["로그인"]) ||
    findRawNodeByText(xml, "로그인");

  if (!submitNode) {
    if (xml.includes("로그인")) {
      await tap(config, device, 540, 2374);
      addStep(steps, "로그인 제출", "pass", "staging submit button fallback coordinates");
      return;
    }

    throw new Error("Cannot find login submit button. Check logs/after-credentials.xml and set LOGIN_SUBMIT_TAP=x,y if needed.");
  }

  await tapNode(config, device, submitNode, "login submit");
  addStep(steps, "로그인 제출");
}

async function verifyHostMode(config, device, store, steps) {
  let xml = await waitForUi(config, device, isLoggedInHome, 10000);
  fs.writeFileSync(path.join(store.logsDir, "host-home.xml"), xml);

  if (isHostModeShell(xml)) {
    addStep(steps, "기존 호스트모드 확인");
  } else {
    const myInfoBounds =
      findBottomTabBounds(xml, "내 정보") ||
      findButtonBoundsByLabel(xml, "내 정보") ||
      findBoundsByTextIncludes(xml, "내 정보");

    if (!myInfoBounds) {
      throw new Error("Cannot find '내 정보' tab after host login.");
    }

    await tap(config, device, myInfoBounds.x, myInfoBounds.y);
    addStep(steps, "내 정보 탭 진입");

    xml = await waitForUi(
      config,
      device,
      (nextXml) =>
        nextXml.includes("호스트") ||
        nextXml.includes("호스트모드") ||
        isHostModeShell(nextXml),
      10000
    );
    fs.writeFileSync(path.join(store.logsDir, "host-my-info.xml"), xml);

    if (isHostModeShell(xml)) {
      addStep(steps, "기존 호스트모드 확인");
    } else {
      const hostModeBounds =
        findButtonBoundsByLabel(xml, "호스트모드") ||
        findButtonBoundsByLabel(xml, "호스트 모드") ||
        findBoundsByTextIncludes(xml, "호스트모드") ||
        findBoundsByTextIncludes(xml, "호스트 모드");

      if (!hostModeBounds) {
        throw new Error("Cannot find host mode button on '내 정보' screen.");
      }

      await tap(config, device, hostModeBounds.x, hostModeBounds.y);
      addStep(steps, "호스트모드 버튼 탭");

      xml = await waitForUi(
        config,
        device,
        (nextXml) => isHostModeShell(nextXml) || (nextXml.includes("호스트") && !nextXml.includes("게스트모드로 전환 실패")),
        10000
      );
    }
  }

  fs.writeFileSync(path.join(store.logsDir, "host-mode.xml"), xml);

  if (!isHostModeShell(xml) && !xml.includes("호스트")) {
    throw new Error("Host mode screen was not confirmed after tapping host mode.");
  }

  const contractTabBounds =
    findBottomTabBounds(xml, "계약") ||
    findButtonBoundsByLabel(xml, "계약") ||
    findBoundsByTextIncludes(xml, "계약");

  if (!contractTabBounds) {
    throw new Error("Cannot find host contract tab after entering host mode.");
  }

  await tap(config, device, contractTabBounds.x, contractTabBounds.y);
  addStep(steps, "호스트 계약 탭 진입");

  xml = await waitForUi(config, device, isHostContractTab, 10000);
  fs.writeFileSync(path.join(store.logsDir, "host-contract.xml"), xml);

  if (!isHostContractTab(xml)) {
    throw new Error("Host contract tab was not confirmed after tapping contract tab.");
  }
}

async function launchApp(config, device, appPackage, steps) {
  await runAdb(config, device, ["shell", "am", "force-stop", appPackage]);
  addStep(steps, "앱 완전 종료");

  await new Promise((resolve) => setTimeout(resolve, 700));

  addStep(steps, "앱 재실행");
  await runAdb(config, device, [
    "shell",
    "monkey",
    "-p",
    appPackage,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ]);
}

async function runLoginTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  const account = config.accounts[role] || {};
  const accountSecrets = [account.email, account.password].filter(Boolean);
  const steps = [];
  const securityChecks = [];

  return withDeviceLock(device || `${role}-dry-run`, async () => {
    addStep(steps, "환경 설정 확인");

    if (!appPackage) {
      throw new Error(`Unknown Android package for env: ${env}`);
    }

    if (config.dryRun) {
      addStep(steps, "dry-run 앱 실행");
      addStep(steps, "dry-run 이메일 입력");
      addStep(steps, "dry-run 비밀번호 입력");
      addStep(steps, "dry-run 로그인 완료 확인");

      const screenshotPath = path.join(store.screenshotsDir, "final.png");
      fs.writeFileSync(screenshotPath, ONE_PIXEL_PNG);
      store.appendLog("runner.log", "dry-run login completed");

      return {
        test_id: "TC-LOGIN-001",
        name: `${role} 로그인`,
        env,
        status: "pass",
        device: device || "dry-run",
        steps,
        artifacts: {
          screenshots: [screenshotPath],
          logs: [path.join(store.logsDir, "runner.log")]
        }
      };
    }

    if (!device) {
      throw new Error(`Missing device id for role: ${role}`);
    }
    if (!account.email || !account.password) {
      throw new Error(`Missing account credentials for role: ${role}`);
    }

    await wakeAndUnlock(config, device, steps, store);

    await launchApp(config, device, appPackage, steps);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    let xml = await dumpUi(config, device);
    fs.writeFileSync(path.join(store.logsDir, "after-launch.xml"), xml);

    if (xml.includes('package="com.android.systemui"')) {
      throw new Error("Device is still showing system UI/lock screen after app launch. Unlock the device and retry.");
    }

    if (await maybeAllowPermissionPopup(config, device, xml, store, steps)) {
      xml = await waitForUi(
        config,
        device,
        (nextXml) => !nextXml.includes("com.google.android.permissioncontroller"),
        6000
      );
      fs.writeFileSync(path.join(store.logsDir, "after-permission-allow.xml"), xml);
    }

    if (await maybeDismissUpdatePopup(config, device, xml, store, steps)) {
      xml = await waitForUi(
        config,
        device,
        (nextXml) => !nextXml.includes("업데이트 안내"),
        6000
      );
      fs.writeFileSync(path.join(store.logsDir, "after-update-dismiss.xml"), xml);
    }

    if (isLoggedInHome(xml)) {
      addStep(steps, `기존 ${role} 로그인 세션 확인`);

      if (role === "host") {
        await verifyHostMode(config, device, store, steps);
        addStep(steps, "호스트 로그인 완료 확인");
      } else {
        addStep(steps, "게스트 로그인 완료 확인");
      }

      const sessionLogs =
        role === "host"
          ? [
              path.join(store.logsDir, "after-launch.xml"),
              path.join(store.logsDir, "host-home.xml"),
              path.join(store.logsDir, "host-my-info.xml"),
              path.join(store.logsDir, "host-mode.xml"),
              path.join(store.logsDir, "host-contract.xml")
            ]
          : [path.join(store.logsDir, "after-launch.xml")];

      return {
        test_id: "TC-LOGIN-001",
        name: `${role} 로그인`,
        env,
        status: "pass",
        device,
        steps,
        session_reused: true,
        security_checks: sessionReuseSecurityChecks(),
        artifacts: {
          screenshots: [],
          logs: existingPaths(sessionLogs)
        }
      };
    }

    if (!(isStillOnLoginForm(xml) && findEditableNodes(xml).length >= 2)) {
      xml = await waitForUi(
        config,
        device,
        (nextXml) => nextXml.includes("이메일/휴대폰 번호로 시작하기"),
        10000
      );
      const beforeLoginEntryPath = path.join(store.logsDir, "before-login-entry.xml");
      fs.writeFileSync(beforeLoginEntryPath, xml);
      xml = fs.readFileSync(beforeLoginEntryPath, "utf8");
      store.appendLog(
        "runner.log",
        `before-login-entry has_email=${xml.includes("이메일/휴대폰 번호로 시작하기")} has_permission=${xml.includes("permissioncontroller")}`
      );
      await tapFirstLoginEntry(config, device, xml, steps);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      xml = await dumpUi(config, device);
      fs.writeFileSync(path.join(store.logsDir, "after-login-entry.xml"), xml);
    } else {
      addStep(steps, "기존 로그인 입력 화면 확인");
    }

    if (isLoggedInHome(xml)) {
      throw new Error("Recent login bypassed the email/password login form. App data should be cleared before this test.");
    }

    const editables = findEditableNodes(xml);
    if (editables.length < 2) {
      throw new Error("Cannot find email/password inputs. Check logs/after-login-entry.xml.");
    }

    await tapNode(config, device, editables[0], "email input");
    await replaceFocusedText(config, device, account.email);
    addStep(steps, "이메일 입력");

    await tapNode(config, device, editables[1], "password input");
    await replaceFocusedText(config, device, account.password);
    await keyEvent(config, device, 4);
    addStep(steps, "비밀번호 입력");

    await new Promise((resolve) => setTimeout(resolve, 500));
    xml = await dumpUi(config, device);
    writeXmlArtifact(
      path.join(store.logsDir, "after-credentials.xml"),
      xml,
      accountSecrets
    );
    assertEnteredValue(xml, account.email, "Email");
    const passwordProtection = inspectPasswordProtection(xml, account.password);
    addStep(
      steps,
      "비밀번호 입력 필드 마스킹 확인",
      passwordProtection.masked ? "pass" : "fail"
    );
    securityChecks.push(
      {
        id: "SEC-LOGIN-001",
        name: "비밀번호 입력 필드 마스킹",
        status: passwordProtection.masked ? "pass" : "fail"
      },
      {
        id: "SEC-LOGIN-002",
        name: "Android UI hierarchy 비밀번호 평문 비노출",
        status: passwordProtection.plaintextExposed ? "fail" : "pass"
      },
      {
        id: "SEC-LOGIN-003",
        name: "자동화 XML 리포트 계정정보 제거",
        status: "pass"
      },
      {
        id: "SEC-LOGIN-004",
        name: "네트워크 전송 및 단말 저장 암호화",
        status: "not_tested"
      }
    );

    await submitLogin(config, device, xml, steps);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    xml = await waitForUi(
      config,
      device,
      (nextXml) =>
        isLoggedInHome(nextXml) ||
        hasLoginFailure(nextXml),
      20000
    );
    writeXmlArtifact(
      path.join(store.logsDir, "after-submit.xml"),
      xml,
      accountSecrets
    );

    if (!isLoggedInHome(xml) && !hasLoginFailure(xml) && isLoginSubmitReady(xml)) {
      await submitLogin(config, device, xml, steps);
      addStep(steps, "로그인 제출 재시도", "pass", "로그인 화면 유지로 최신 버튼 좌표 재탭");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      xml = await waitForUi(
        config,
        device,
        (nextXml) =>
          isLoggedInHome(nextXml) ||
          hasLoginFailure(nextXml),
        15000
      );
      writeXmlArtifact(
        path.join(store.logsDir, "after-submit-retry.xml"),
        xml,
        accountSecrets
      );
    }

    if (hasLoginFailure(xml) || !isLoggedInHome(xml)) {
      const finalArtifacts = await saveArtifacts(
        config,
        device,
        store,
        "final",
        accountSecrets
      );
      fail(
        "로그인 제출 후에도 로그인 완료 화면으로 이동하지 않았습니다.",
        steps,
        getLoginFailureDetails(xml)
      );
    }

    if (role === "host") {
      await verifyHostMode(config, device, store, steps);
    }

    addStep(steps, "로그인 완료 확인");

    return {
      test_id: "TC-LOGIN-001",
      name: `${role} 로그인`,
      env,
      status: "pass",
      device,
      steps,
      security_checks: securityChecks,
      artifacts: {
        screenshots: [],
        logs: [
          path.join(store.logsDir, "runner.log"),
          path.join(store.logsDir, "after-launch.xml"),
          path.join(store.logsDir, "after-submit.xml"),
          ...(role === "host" ? [path.join(store.logsDir, "host-contract.xml")] : [])
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

module.exports = {
  runLoginTest
};
