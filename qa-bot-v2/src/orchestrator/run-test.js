const { getTest } = require("./test-registry");
const { createRunStore } = require("./run-store");

async function runTest(request, config) {
  const test = getTest(request.test);
  if (!test) {
    throw new Error(`Unknown test: ${request.test}`);
  }

  const store = createRunStore(config.reportBaseDir, request);
  const startedAt = Date.now();

  try {
    const result = await test({
      request: store.request,
      config,
      store
    });

    const finalResult = {
      ...result,
      run_id: store.runId,
      duration_ms: Date.now() - startedAt,
      artifacts: {
        ...(result.artifacts || {}),
        report_dir: store.runDir
      }
    };

    store.writeResult(finalResult);
    return finalResult;
  } catch (error) {
    const role = request.role || "guest";
    const testIds = {
      login: "TC-LOGIN-001",
      logout: "TC-LOGOUT-001"
    };
    const finalResult = {
      run_id: store.runId,
      test_id: testIds[request.test] || "TC-UNKNOWN",
      name:
        request.test === "login" || request.test === "logout"
          ? `${role} ${request.test === "login" ? "로그인" : "로그아웃"}`
          : request.test,
      env: request.env,
      status: "fail",
      device: config.devices && config.devices[role] ? config.devices[role] : "unknown",
      duration_ms: Date.now() - startedAt,
      failed_step: "runner",
      error: error.message,
      error_details: error.details || [],
      error_stack: error.stack,
      possible_causes: ["테스트 코드 예외", "환경 설정 누락", "디바이스 상태 문제"],
      steps: error.steps || [],
      artifacts: {
        report_dir: store.runDir
      }
    };

    store.writeResult(finalResult);
    return finalResult;
  }
}

module.exports = {
  runTest
};
