const path = require("path");
const { withDeviceLock } = require("../infra/device-lock");
const {
  acceptAlert,
  activateApp,
  createSession,
  releaseSession,
  getAlertText,
  launchApp,
  typeText
} = require("../infra/ios-wda");
const {
  dumpNodes,
  findExactNode,
  findNode,
  saveFailureArtifacts,
  tapNode,
  waitForNodes
} = require("./helpers/ios-automation");

// login.test.js(AOS)와 같은 자리에 있는 iOS 버전.
// 다만 실제 iOS 앱 화면의 accessibility label/name은 아직 실기기/시뮬레이터로 검증되지 않았다.
// 아래 라벨(예: "이메일/휴대폰 번호로 시작하기")은 AOS와 동일한 문구를 쓴다는 가정이며,
// 첫 실행 후 실제 화면과 다르면 이 파일의 라벨 상수만 조정하면 된다.

const LOGIN_ENTRY_LABEL = "이메일/휴대폰 번호로 시작하기";
const HOME_TAB_LABELS = ["홈", "탐색", "채팅", "내 정보"];
const NOTIFICATION_PERMISSION_PATTERN = /알림을 보내고자|send you notifications/i;
const TRACKING_PERMISSION_PATTERN = /추적|track/i;
const FIRST_LAUNCH_GUIDE_PATTERN = "더 나은 서비스 제공을 위해";

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

function isLoggedInHome(nodes) {
  return !!findNode(nodes, HOME_TAB_LABELS, { visible: true });
}

function isLoginEntryScreen(nodes) {
  return !!findNode(nodes, [LOGIN_ENTRY_LABEL], { visible: true });
}

function findEditableNodes(nodes) {
  return nodes.filter((node) => ["TextField", "SecureTextField"].includes(node.attrs.type));
}

async function acceptSystemPermissionIfPresent(
  wdaUrl,
  sessionId,
  pattern,
  stepName,
  steps,
  timeoutMs = 1500
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alertText;
    try {
      alertText = await getAlertText(wdaUrl, sessionId);
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    // 로그인 오류나 서비스 확인 팝업은 자동 승인하지 않는다.
    if (!pattern.test(alertText)) return false;

    await acceptAlert(wdaUrl, sessionId);
    addStep(steps, stepName);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return true;
  }
  return false;
}

async function advanceFirstLaunchGuideIfPresent(wdaUrl, sessionId, steps, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const nodes = await dumpNodes(wdaUrl, sessionId);
    const guide = findNode(nodes, [FIRST_LAUNCH_GUIDE_PATTERN], { visible: true });
    const nextButton = findExactNode(nodes, ["다음"], { visible: true, enabled: true });
    // WebView에서 '다음'이 Button이 아닌 StaticText로 노출되므로 실제 텍스트 좌표를 누른다.
    if (guide && nextButton) {
      await tapNode(wdaUrl, sessionId, nextButton, "iOS 최초 실행 안내 다음 버튼", steps);
      addStep(steps, "iOS 최초 실행 안내 팝업 다음");
      await new Promise((resolve) => setTimeout(resolve, 700));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

async function runIosLoginTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "staging";
  const account = (config.accounts && config.accounts[role]) || {};
  const iosBuild = (config.appBuild && config.appBuild.ios) || {};
  const wdaUrl = iosBuild.wdaUrls && iosBuild.wdaUrls[role];
  const bundleId = iosBuild.bundleIds && iosBuild.bundleIds[env === "stg" ? "staging" : env];
  const steps = [];

  if (!wdaUrl) {
    throw new Error(
      `iOS 단말/시뮬레이터의 WDA URL을 찾지 못했습니다 (role: ${role}). IOS_${role.toUpperCase()}_WDA_URL을 확인해주세요.`
    );
  }
  if (!bundleId) {
    throw new Error(`iOS bundle id를 찾지 못했습니다 (env: ${env}).`);
  }
  if (!account.email || !account.password) {
    throw new Error(`계정 정보를 찾지 못했습니다 (role: ${role}).`);
  }

  return withDeviceLock(wdaUrl, async () => {
    let sessionId;

    try {
      sessionId = await createSession(wdaUrl, bundleId);
      addStep(steps, "WDA 세션 생성", "pass", wdaUrl);

      // 대상 앱이 이미 홈 화면에 열려 있으면 launch API를 호출하지 않고 세션을 재사용한다.
      // 현재 화면을 읽을 수 없거나 홈이 아니면 아래의 기존 앱 실행/로그인 복구를 수행한다.
      try {
        const currentNodes = await dumpNodes(wdaUrl, sessionId);
        if (isLoggedInHome(currentNodes)) {
          addStep(steps, "현재 iOS 앱 화면 로그인 세션 재사용");
          addStep(steps, `기존 ${role} 로그인 세션 확인`);
          return {
            test_id: "TC-IOS-LOGIN-001",
            name: `iOS ${role} 로그인`,
            env,
            status: "pass",
            device: wdaUrl,
            steps,
            session_reused: true,
            artifacts: { screenshots: [], logs: [] }
          };
        }
      } catch (error) {
        // 빠른 확인 실패는 로그인 실패가 아니다. 기존 복구 흐름이 앱을 실행해 다시 판정한다.
        store.appendLog("runner.log", `current iOS session check skipped: ${error.message}`);
      }

      await launchApp(wdaUrl, sessionId, bundleId);
      addStep(steps, "iOS 앱 실행", "pass", bundleId);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const acceptedNotification = await acceptSystemPermissionIfPresent(
        wdaUrl,
        sessionId,
        NOTIFICATION_PERMISSION_PATTERN,
        "iOS 알림 권한 팝업 허용",
        steps,
        3000
      );
      const advancedGuide = await advanceFirstLaunchGuideIfPresent(
        wdaUrl,
        sessionId,
        steps,
        acceptedNotification ? 5000 : 1500
      );
      await acceptSystemPermissionIfPresent(
        wdaUrl,
        sessionId,
        TRACKING_PERMISSION_PATTERN,
        "iOS 추적 권한 팝업 허용",
        steps,
        advancedGuide ? 5000 : 700
      );
      if (advancedGuide) {
        await activateApp(wdaUrl, sessionId, bundleId);
        addStep(steps, "iOS 권한 처리 후 앱 화면 복귀");
        await new Promise((resolve) => setTimeout(resolve, 700));
      }

      let nodes = await dumpNodes(wdaUrl, sessionId);

      if (isLoggedInHome(nodes)) {
        addStep(steps, `기존 ${role} 로그인 세션 확인`);
        return {
          test_id: "TC-IOS-LOGIN-001",
          name: `iOS ${role} 로그인`,
          env,
          status: "pass",
          device: wdaUrl,
          steps,
          session_reused: true,
          artifacts: { screenshots: [], logs: [] }
        };
      }

      if (!isLoginEntryScreen(nodes)) {
        nodes = await waitForNodes(wdaUrl, sessionId, isLoginEntryScreen, 10000);
      }

      const entryButton = findNode(nodes, [LOGIN_ENTRY_LABEL], { visible: true });
      if (!entryButton) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "login-entry-not-found", nodes);
        fail(
          "로그인 시작 화면을 찾지 못했습니다.",
          steps,
          [
            `찾던 라벨: ${LOGIN_ENTRY_LABEL}`,
            "iOS 실제 화면 문구가 다르면 ios-login.test.js의 LOGIN_ENTRY_LABEL을 조정해주세요.",
            `리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`
          ]
        );
      }
      await tapNode(wdaUrl, sessionId, entryButton, "로그인 시작 버튼", steps);
      addStep(steps, "로그인 시작 버튼 탭");

      nodes = await waitForNodes(wdaUrl, sessionId, (candidate) => findEditableNodes(candidate).length >= 2, 10000);
      const editables = findEditableNodes(nodes);
      if (editables.length < 2) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "login-inputs-not-found", nodes);
        fail(
          "이메일/비밀번호 입력 필드를 찾지 못했습니다.",
          steps,
          [
            "로그인 시작 버튼을 누른 뒤에도 입력 화면(TextField 2개)이 보이지 않았습니다.",
            `리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`
          ]
        );
      }

      await tapNode(wdaUrl, sessionId, editables[0], "이메일 입력", steps);
      await typeText(wdaUrl, sessionId, account.email);
      addStep(steps, "이메일 입력");

      await tapNode(wdaUrl, sessionId, editables[1], "비밀번호 입력", steps);
      await typeText(wdaUrl, sessionId, account.password);
      addStep(steps, "비밀번호 입력");

      nodes = await dumpNodes(wdaUrl, sessionId);
      const loginSubmitButton = findNode(nodes, ["로그인"], { visible: true });
      if (!loginSubmitButton) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "login-submit-not-found", nodes);
        fail(
          "로그인 제출 버튼을 찾지 못했습니다.",
          steps,
          [`리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`]
        );
      }
      await tapNode(wdaUrl, sessionId, loginSubmitButton, "로그인 제출 버튼", steps);
      addStep(steps, "로그인 제출 버튼 탭");

      nodes = await waitForNodes(wdaUrl, sessionId, isLoggedInHome, 20000);
      if (!isLoggedInHome(nodes)) {
        const artifacts = await saveFailureArtifacts(wdaUrl, sessionId, store, "login-final", nodes);
        fail(
          "로그인 제출 후에도 홈 화면으로 이동하지 않았습니다.",
          steps,
          [`리포트의 ${path.basename(artifacts.screenshotPath)} 화면을 확인해주세요.`]
        );
      }

      addStep(steps, "로그인 완료 확인");

      return {
        test_id: "TC-IOS-LOGIN-001",
        name: `iOS ${role} 로그인`,
        env,
        status: "pass",
        device: wdaUrl,
        steps,
        artifacts: { screenshots: [], logs: [] }
      };
    } catch (error) {
      if (!error.steps) error.steps = steps;
      throw error;
    } finally {
      if (sessionId) {
        await releaseSession(wdaUrl, sessionId);
      }
    }
  });
}

module.exports = {
  runIosLoginTest
};
