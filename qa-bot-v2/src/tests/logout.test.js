const fs = require("fs");
const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  dumpUi,
  keyEvent,
  runAdb,
  screenshotPng,
  tap
} = require("../infra/adb");

function addStep(steps, name, status = "pass") {
  steps.push({ name, status });
}

function fail(message, steps, details = []) {
  const error = new Error(message);
  error.steps = steps;
  error.details = details;
  throw error;
}

function parseNodes(xml) {
  return (xml.match(/<node\b[^>]*>/g) || []).map((raw) => {
    const attrs = {};
    for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[match[1]] = match[2];
    }

    const match = String(attrs.bounds || "").match(
      /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/
    );
    const bounds = match
      ? {
          left: Number(match[1]),
          top: Number(match[2]),
          right: Number(match[3]),
          bottom: Number(match[4]),
          x: Math.round((Number(match[1]) + Number(match[3])) / 2),
          y: Math.round((Number(match[2]) + Number(match[4])) / 2)
        }
      : null;

    return { attrs, bounds };
  });
}

function labelOf(node) {
  return `${node.attrs.text || ""}\n${node.attrs["content-desc"] || ""}`;
}

function findNode(xml, label) {
  const matches = parseNodes(xml).filter((node) => labelOf(node).includes(label));
  return matches.find((node) => node.attrs.clickable === "true") || matches[0];
}

function isLoggedOut(xml) {
  const hasStartButton = xml.includes("이메일/휴대폰 번호로 시작하기");
  const hasMyInfoLoginPrompt =
    xml.includes("로그인해 주세요") &&
    xml.includes("회원가입 / 로그인하기");
  const hasLoginForm =
    xml.includes("이메일 혹은 휴대폰 번호로 시작하기") &&
    xml.includes("비밀번호") &&
    xml.includes("로그인");
  return hasStartButton || hasMyInfoLoginPrompt || hasLoginForm;
}

function hasLogoutConfirmDialog(xml) {
  return xml.includes("로그아웃 하시겠습니까?");
}

async function waitForUi(config, device, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  let xml = "";
  while (Date.now() - startedAt < timeoutMs) {
    xml = await dumpUi(config, device);
    if (predicate(xml)) return xml;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return xml;
}

async function saveArtifacts(config, device, store, name, xml) {
  const xmlPath = path.join(store.logsDir, `${name}.xml`);
  const screenshotPath = path.join(store.screenshotsDir, `${name}.png`);
  fs.writeFileSync(xmlPath, xml || (await dumpUi(config, device)));
  fs.writeFileSync(screenshotPath, await screenshotPng(config, device));
  return { xmlPath, screenshotPath };
}

async function getScreenSize(config, device) {
  const { stdout } = await runAdb(config, device, ["shell", "wm", "size"]);
  const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : { width: 1080, height: 2640 };
}

function findLogoutTapCandidates(xml) {
  const direct = findNode(xml, "로그아웃");
  if (direct?.bounds) {
    const height = direct.bounds.bottom - direct.bounds.top;
    const textY = Math.round(direct.bounds.top + height * 0.75);
    return [
      { x: direct.bounds.left + 80, y: textY, label: "logout visible text" },
      { x: direct.bounds.left + 130, y: textY, label: "logout text area" },
      { x: direct.bounds.left + 240, y: textY, label: "logout row left" },
      { x: direct.bounds.x, y: textY, label: "logout row lower center" }
    ];
  }

  // Flutter groups the visible logout row into the top of the manager-tools node.
  const version = findNode(xml, "현재 버전");
  const managerTools = findNode(xml, "매니저 도구");
  if (!version?.bounds || !managerTools?.bounds) return null;

  const managerHeight = managerTools.bounds.bottom - managerTools.bounds.top;
  if (managerHeight < 250) return null;
  const y = managerTools.bounds.top - 75;
  return [
    { x: 80, y, label: "inferred logout visible text" },
    { x: 130, y, label: "inferred logout text area" },
    { x: 240, y, label: "inferred logout row left" },
    { x: 540, y, label: "inferred logout row lower center" }
  ];
}

async function centerLogoutRowIfNeeded(config, device, candidates) {
  const firstCandidate = candidates && candidates[0];
  if (!firstCandidate || firstCandidate.y < 1650) return null;

  await runAdb(config, device, [
    "shell", "input", "swipe", "540", "2050", "540", "1250", "450"
  ]);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const xml = await dumpUi(config, device);
  const centeredCandidates = findLogoutTapCandidates(xml);
  return centeredCandidates ? { xml, candidates: centeredCandidates } : null;
}

async function tapLogoutAndWaitForDialog(config, device, candidates, store) {
  for (const candidate of candidates) {
    await tap(config, device, candidate.x, candidate.y);
    store.appendLog(
      "runner.log",
      `tapped logout candidate ${candidate.label} at ${candidate.x},${candidate.y}`
    );

    const xml = await waitForUi(config, device, hasLogoutConfirmDialog, 2500);
    if (hasLogoutConfirmDialog(xml)) return xml;
  }

  return dumpUi(config, device);
}

async function confirmLoggedOutAfterSubmit(config, device, store, steps) {
  let xml = await waitForUi(
    config,
    device,
    (nextXml) => isLoggedOut(nextXml) || Boolean(findNode(nextXml, "내 정보")),
    15000
  );

  if (isLoggedOut(xml)) return xml;

  const myInfo = findNode(xml, "내 정보");
  if (myInfo?.bounds) {
    await tap(config, device, myInfo.bounds.x, myInfo.bounds.y);
    addStep(steps, "로그아웃 후 내 정보 탭 진입");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    xml = await waitForUi(config, device, isLoggedOut, 8000);
  }

  await saveArtifacts(config, device, store, "logout-final", xml);
  return xml;
}

function buildAlreadyLoggedOutResult({ role, env, device, steps, store, screenshotName, logName }) {
  addStep(steps, "이미 로그아웃된 상태 확인");
  return {
    test_id: "TC-LOGOUT-001",
    name: `${role} 로그아웃`,
    env,
    status: "pass",
    device,
    session_already_logged_out: true,
    steps,
    artifacts: {
      screenshots: [path.join(store.screenshotsDir, screenshotName)],
      logs: [path.join(store.logsDir, logName)]
    }
  };
}

async function runLogoutTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const device = config.devices[role] || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await keyEvent(config, device, 224);
    await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch(() => {});
    addStep(steps, "단말 깨우기 및 잠금 해제 시도");

    await runAdb(config, device, [
      "shell",
      "monkey",
      "-p",
      appPackage,
      "-c",
      "android.intent.category.LAUNCHER",
      "1"
    ]);
    addStep(steps, "앱 실행");
    await new Promise((resolve) => setTimeout(resolve, 2500));

    let xml = await dumpUi(config, device);
    await saveArtifacts(config, device, store, "logout-start", xml);

    if (isLoggedOut(xml)) {
      return buildAlreadyLoggedOutResult({
        role,
        env,
        device,
        steps,
        store,
        screenshotName: "logout-start.png",
        logName: "logout-start.xml"
      });
    }

    let myInfo = findNode(xml, "내 정보");
    for (let count = 0; !myInfo && count < 6; count += 1) {
      await keyEvent(config, device, 4);
      await new Promise((resolve) => setTimeout(resolve, 800));
      xml = await dumpUi(config, device);
      if (isLoggedOut(xml)) break;
      myInfo = findNode(xml, "내 정보");
    }

    if (isLoggedOut(xml)) {
      addStep(steps, "이미 로그아웃된 상태 확인");
    } else {
      if (!myInfo?.bounds) {
        fail(
          "내 정보 탭을 찾지 못해서 로그아웃 화면으로 이동하지 못했습니다.",
          steps,
          [
            "앱이 홈 화면이 아니거나 하단 탭 UI가 예상과 다를 수 있습니다.",
            "리포트의 logout-start.png 화면을 확인해주세요."
          ]
        );
      }
      await tap(config, device, myInfo.bounds.x, myInfo.bounds.y);
      addStep(steps, "내 정보 탭 진입");
      await new Promise((resolve) => setTimeout(resolve, 1200));

      for (let count = 0; count < 5; count += 1) {
        await runAdb(config, device, [
          "shell", "input", "swipe", "540", "1200", "540", "2100", "500"
        ]);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      let logoutTapCandidates = null;
      for (let count = 0; count < 12; count += 1) {
        xml = await dumpUi(config, device);
        logoutTapCandidates = findLogoutTapCandidates(xml);
        if (logoutTapCandidates) break;
        await runAdb(config, device, [
          "shell", "input", "swipe", "540", "1800", "540", "1300", "400"
        ]);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      if (!logoutTapCandidates) {
        await saveArtifacts(config, device, store, "logout-button-not-found", xml);
        fail(
          "내 정보 화면에서 로그아웃 버튼을 찾지 못했습니다.",
          steps,
          [
            "내 정보 화면에 진입한 뒤 아래로 스크롤했지만 '로그아웃' 문구가 XML에 잡히지 않았습니다.",
            "리포트의 logout-button-not-found.png 화면을 확인해주세요."
          ]
        );
      }

      const centeredLogout = await centerLogoutRowIfNeeded(
        config,
        device,
        logoutTapCandidates
      );
      if (centeredLogout) {
        xml = centeredLogout.xml;
        logoutTapCandidates = centeredLogout.candidates;
        store.appendLog("runner.log", "moved logout row toward screen center before tapping");
      }

      await saveArtifacts(config, device, store, "before-logout", xml);
      xml = await tapLogoutAndWaitForDialog(
        config,
        device,
        logoutTapCandidates,
        store
      );
      addStep(steps, "로그아웃 버튼 탭");
      await saveArtifacts(config, device, store, "logout-confirm-dialog", xml);
      if (!hasLogoutConfirmDialog(xml)) {
        fail(
          "로그아웃 버튼은 찾았지만, 버튼을 눌러도 확인 팝업이 뜨지 않았습니다.",
          steps,
          [
            "자동화가 로그아웃 행 내부 좌표 3곳을 순서대로 탭했습니다.",
            "행이 화면 아래쪽에 있으면 먼저 화면 가운데로 올린 뒤 다시 탭합니다.",
            "앱이 탭을 받지 않았거나 탭 좌표 계산 방식이 맞지 않을 수 있습니다.",
            "리포트의 before-logout.png와 logout-confirm-dialog.png를 비교해주세요.",
            "실제 탭 좌표는 runner.log에 기록됩니다."
          ]
        );
      }

      const screen = await getScreenSize(config, device);
      await tap(
        config,
        device,
        Math.round(screen.width * 0.7),
        Math.round(screen.height * 0.52)
      );
      addStep(steps, "로그아웃 팝업 확인 버튼 탭");
    }

    xml = await confirmLoggedOutAfterSubmit(config, device, store, steps);
    const finalArtifacts = await saveArtifacts(config, device, store, "logout-final", xml);
    if (!isLoggedOut(xml)) {
      fail(
        "로그아웃 확인 버튼을 눌렀지만 로그아웃 상태를 확인하지 못했습니다.",
        steps,
        [
          "로그아웃 후 홈 화면으로 돌아가면 내 정보 탭에 다시 진입해 로그인 시작 화면을 확인합니다.",
          "내 정보 탭에서도 로그인 시작 화면이 확인되지 않았습니다.",
          "리포트의 logout-final.png 화면을 확인해주세요."
        ]
      );
    }

    addStep(steps, "로그아웃 완료 확인");
    return {
      test_id: "TC-LOGOUT-001",
      name: `${role} 로그아웃`,
      env,
      status: "pass",
      device,
      steps,
      artifacts: {
        screenshots: [finalArtifacts.screenshotPath],
        logs: [
          path.join(store.logsDir, "logout-start.xml"),
          finalArtifacts.xmlPath
        ]
      }
    };
  });
}

module.exports = {
  runLogoutTest
};
