// WebDriverAgent(WDA) HTTP API에 대한 얇은 래퍼.
// infra/adb.js와 같은 형태로 맞춰서(세션/탭/덤프/스크린샷) AOS 자동화와 대칭 구조를 유지한다.
// WDA는 시뮬레이터/실기기 어느 쪽에 떠 있어도 동일한 HTTP API를 쓰므로,
// config.appBuild.ios.wdaUrls.{guest,host}에 WDA 서버 URL만 넣으면 그대로 재사용할 수 있다.
//
// 참고: WDA 빌드/버전에 따라 일부 엔드포인트 응답 형식이 다를 수 있다.
// 실기기/시뮬레이터에 붙여서 첫 실행 후 필요하면 조정해야 한다.

const DEFAULT_TIMEOUT_MS = 15000;

function trimBaseUrl(wdaUrl) {
  return String(wdaUrl || "").replace(/\/+$/, "");
}

async function wdaRequest(wdaUrl, method, urlPath, body) {
  const url = `${trimBaseUrl(wdaUrl)}${urlPath}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`WDA request failed (${method} ${urlPath}): ${error.message}`);
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`WDA response was not JSON (${method} ${urlPath}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = json?.value?.message || json?.value?.error || text || response.statusText;
    throw new Error(`WDA request failed (${method} ${urlPath}): ${message}`);
  }

  return json;
}

async function isReachable(wdaUrl) {
  try {
    await wdaRequest(wdaUrl, "GET", "/status");
    return true;
  } catch (error) {
    return false;
  }
}

async function createSession(wdaUrl, bundleId) {
  const json = await wdaRequest(wdaUrl, "POST", "/session", {
    capabilities: {
      firstMatch: [
        {
          bundleId,
          shouldWaitForQuiescence: false,
          shouldTerminateApp: false,
          forceAppLaunch: false
        }
      ],
      alwaysMatch: {}
    }
  });
  return json.sessionId || json.value?.sessionId;
}

async function deleteSession(wdaUrl, sessionId) {
  if (!sessionId) return;
  await wdaRequest(wdaUrl, "DELETE", `/session/${sessionId}`).catch(() => {});
}

async function launchApp(wdaUrl, sessionId, bundleId) {
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/wda/apps/launch`, { bundleId });
}

async function activateApp(wdaUrl, sessionId, bundleId) {
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/wda/apps/activate`, { bundleId });
}

async function terminateApp(wdaUrl, sessionId, bundleId) {
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/wda/apps/terminate`, { bundleId }).catch(() => {});
}

async function pressHome(wdaUrl) {
  await wdaRequest(wdaUrl, "POST", "/wda/homescreen").catch(() => {});
}

async function tap(wdaUrl, sessionId, x, y) {
  // 이 WDA 빌드는 레거시 /wda/tap/0 엔드포인트가 없어서 W3C 표준 액션 API로 탭한다.
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x, y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 100 },
          { type: "pointerUp", button: 0 }
        ]
      }
    ]
  });
}

async function swipe(wdaUrl, sessionId, startX, startY, endX, endY, duration = 250) {
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x: startX, y: startY },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration, x: endX, y: endY },
          { type: "pointerUp", button: 0 }
        ]
      }
    ]
  });
}

async function typeText(wdaUrl, sessionId, value) {
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/wda/keys`, {
    value: String(value).split("")
  });
}

async function pressKeyName(wdaUrl, sessionId, name) {
  // 예: "Return", "Delete"
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/wda/keys`, { value: [name] });
}

async function dumpUiTree(wdaUrl, sessionId) {
  const json = await wdaRequest(wdaUrl, "GET", `/session/${sessionId}/source?format=json`);
  return json.value;
}

async function screenshotPng(wdaUrl, sessionId) {
  const json = await wdaRequest(wdaUrl, "GET", `/session/${sessionId}/screenshot`);
  return Buffer.from(json.value, "base64");
}

async function getAlertText(wdaUrl, sessionId) {
  const json = await wdaRequest(wdaUrl, "GET", `/session/${sessionId}/alert/text`);
  return String(json.value || "");
}

async function acceptAlert(wdaUrl, sessionId) {
  await wdaRequest(wdaUrl, "POST", `/session/${sessionId}/alert/accept`, {});
}

module.exports = {
  acceptAlert,
  activateApp,
  createSession,
  deleteSession,
  dumpUiTree,
  getAlertText,
  isReachable,
  launchApp,
  pressHome,
  pressKeyName,
  screenshotPng,
  swipe,
  tap,
  terminateApp,
  typeText
};
