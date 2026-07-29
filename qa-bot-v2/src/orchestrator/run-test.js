const { getTest } = require("./test-registry");
const { createRunStore } = require("./run-store");
const { ensureLatestAppBuild } = require("../infra/app-build-check");

async function runTest(request, config) {
  const test = getTest(request.test);
  if (!test) {
    throw new Error(`Unknown test: ${request.test}`);
  }

  const store = createRunStore(config.reportBaseDir, request);
  const startedAt = Date.now();
  let appBuild = null;

  try {
    appBuild = store.request.skip_app_build_check
      ? {
        status: "skipped",
        reason: "Skipped by parent flow after a prior app build check."
      }
      : await ensureLatestAppBuild({
        request: store.request,
        config,
        store
      });

    const result = await test({
      request: store.request,
      config,
      store
    });

    const finalResult = {
      ...result,
      app_build: appBuild,
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
      logout: "TC-LOGOUT-001",
      search: "TC-SEARCH-001",
      "search-flexible": "TC-SEARCH-002",
      "contract-request": "TC-CONTRACT-001",
      "contract-approve": "TC-CONTRACT-APPROVE-001",
      "contract-reject": "TC-CONTRACT-REJECT-001",
      "contract-cancel-confirmed": "TC-CONTRACT-CANCEL-CONFIRMED-001",
      "contract-cancel-request": "TC-CONTRACT-CANCEL-REQUEST-001",
      "contract-extension": "TC-CONTRACT-EXTENSION-001",
      "contract-extension-approve": "TC-CONTRACT-EXTENSION-APPROVE-001",
      "contract-payment": "TC-CONTRACT-PAYMENT-001",
      "schedule-change": "TC-SCHEDULE-CHANGE-001",
      "toss-deposit-approve": "TC-TOSS-DEPOSIT-APPROVE-001"
    };
    const testNames = {
      login: "로그인",
      logout: "로그아웃",
      search: "집 검색",
      "search-flexible": "유연한 일정 검색",
      "contract-request": "계약 요청",
      "contract-approve": "계약 승인",
      "contract-reject": "계약 요청 거절",
      "contract-cancel-confirmed": "계약 확정 취소",
      "contract-cancel-request": "계약 요청 취소",
      "contract-extension": "계약 연장",
      "contract-extension-approve": "계약 연장 수락",
      "contract-payment": "계약 결제",
      "schedule-change": "계약 일정 변경",
      "toss-deposit-approve": "무통장 입금 승인"
    };
    const finalResult = {
      run_id: store.runId,
      test_id: testIds[request.test] || "TC-UNKNOWN",
      name: testNames[request.test] ? `${role} ${testNames[request.test]}` : request.test,
      env: request.env,
      status: "fail",
      device: request.test === "toss-deposit-approve"
        ? "browser"
        : request.test === "schedule-change"
          ? "api"
          : config.devices && config.devices[role] ? config.devices[role] : "unknown",
      duration_ms: Date.now() - startedAt,
      failed_step: "runner",
      error: error.message,
      error_details: error.details || [],
      error_stack: error.stack,
      app_build: error.app_build || appBuild,
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
