const { getTest } = require("./test-registry");
const { createRunStore } = require("./run-store");
const { ensureLatestAppBuild } = require("../infra/app-build-check");
const { dumpUi, runAdb } = require("../infra/adb");
const { maybeDismissHostReportPopup } = require("../tests/login.test");

function getAndroidPostTestTarget(request, config) {
  // Login already launches the app and finishes on a verified home screen.
  // Relaunching it again can recreate delayed host WebView notices.
  if (request.test === "login") return null;
  if (request.test === "toss-deposit-approve") return null;
  if (request.test === "console-schedule-change") return null;
  if (request.test === "console-deposit-return") return null;
  if (request.test === "build-install") return null;
  if (String(request.test || "").startsWith("ios-")) return null;
  if (request.env === "api" || request.env === "toss") return null;

  const role = request.role || "guest";
  const device = config.devices && config.devices[role];
  const appPackage = config.androidPackages && config.androidPackages[request.env];
  if (!device || !appPackage) return null;

  return { device, appPackage };
}

async function relaunchAndroidAppAfterPass({ request, config, result, store }) {
  const target = getAndroidPostTestTarget(request, config);
  if (!target) return { status: "skipped" };

  try {
    await runAdb(config, target.device, ["shell", "am", "force-stop", target.appPackage]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await runAdb(config, target.device, [
      "shell",
      "monkey",
      "-p",
      target.appPackage,
      "-c",
      "android.intent.category.LAUNCHER",
      "1"
    ]);

    if ((request.role || "guest") === "host") {
      // Let the native shell start; the helper observes delayed WebView notices.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const hostXml = await dumpUi(config, target.device);
      await maybeDismissHostReportPopup(
        config,
        target.device,
        hostXml,
        store,
        Array.isArray(result.steps) ? result.steps : []
      );
    }

    if (Array.isArray(result.steps)) {
      result.steps.push({
        name: "테스트 완료 후 앱 종료 및 재실행",
        status: "pass"
      });
    }

    return {
      status: "pass",
      device: target.device,
      app_package: target.appPackage
    };
  } catch (error) {
    store.appendLog("runner.log", `post-test app relaunch failed: ${error.message}`);
    if (Array.isArray(result.steps)) {
      result.steps.push({
        name: "테스트 완료 후 앱 종료 및 재실행",
        status: "warning",
        message: error.message
      });
    }

    return {
      status: "warning",
      device: target.device,
      app_package: target.appPackage,
      message: error.message
    };
  }
}

async function runTest(request, config) {
  const test = getTest(request.test);
  if (!test) {
    throw new Error(`Unknown test: ${request.test}`);
  }

  const store = createRunStore(config.reportBaseDir, request);
  const startedAt = Date.now();
  let appBuild = null;

  try {
    appBuild = store.request.skip_app_build_check ||
      store.request.test === "console-schedule-change" ||
      store.request.test === "console-deposit-return" ||
      store.request.test === "build-install" ||
      String(store.request.test || "").startsWith("ios-")
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
    const postTestAppRelaunch = result.status === "pass"
      ? await relaunchAndroidAppAfterPass({
        request: store.request,
        config,
        result,
        store
      })
      : { status: "skipped" };

    const finalResult = {
      ...result,
      app_build: appBuild,
      post_test_app_relaunch: postTestAppRelaunch,
      app_warnings: [
        ...(result.app_warnings || []),
        ...(postTestAppRelaunch.status === "warning"
          ? [`테스트 완료 후 앱 재실행 실패: ${postTestAppRelaunch.message}`]
          : [])
      ],
      requested_by: store.request.requested_by,
      source: store.request.source,
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
      "conversational-search": "TC-CONVERSATIONAL-SEARCH-001",
      "contract-request": "TC-CONTRACT-001",
      "contract-approve": "TC-CONTRACT-APPROVE-001",
      "contract-reject": "TC-CONTRACT-REJECT-001",
      "contract-cancel-confirmed": "TC-CONTRACT-CANCEL-CONFIRMED-001",
      "contract-cancel-request": "TC-CONTRACT-CANCEL-REQUEST-001",
      "contract-extension": "TC-CONTRACT-EXTENSION-001",
      "contract-extension-approve": "TC-CONTRACT-EXTENSION-APPROVE-001",
      "contract-payment": "TC-CONTRACT-PAYMENT-001",
      "toss-deposit-approve": "TC-TOSS-DEPOSIT-APPROVE-001",
      "console-schedule-change": "TC-CONSOLE-SCHEDULE-CHANGE-001",
      "console-deposit-return": "TC-CONSOLE-DEPOSIT-RETURN-001",
      "review-detail": "TC-INTERNAL-REFACTOR-003",
      "review-delete": "TC-INTERNAL-REFACTOR-007",
      "review-profile": "TC-INTERNAL-REFACTOR-001",
      "review-schedule-select": "TC-INTERNAL-REFACTOR-002",
      "coupon-box": "TC-INTERNAL-REFACTOR-004",
      "review-edit": "TC-INTERNAL-REFACTOR-006",
      "review-write": "TC-INTERNAL-REFACTOR-005",
      "build-install": "TC-BUILD-INSTALL-001",
      "ios-build-install": "TC-IOS-BUILD-INSTALL-001",
      "ios-login": "TC-IOS-LOGIN-001",
      "ios-search": "TC-IOS-SEARCH-001",
      "ios-search-flexible": "TC-IOS-SEARCH-002"
    };
    const testNames = {
      login: "로그인",
      logout: "로그아웃",
      search: "집 검색",
      "search-flexible": "유연한 일정 검색",
      "conversational-search": "대화형 검색",
      "contract-request": "계약 요청",
      "contract-approve": "계약 승인",
      "contract-reject": "계약 요청 거절",
      "contract-cancel-confirmed": "계약 확정 취소",
      "contract-cancel-request": "계약 요청 취소",
      "contract-extension": "계약 연장",
      "contract-extension-approve": "계약 연장 수락",
      "contract-payment": "계약 결제",
      "toss-deposit-approve": "무통장 입금 승인",
      "console-schedule-change": "콘솔 계약 일정 변경",
      "console-deposit-return": "콘솔 보증금 반환 처리",
      "review-detail": "리브후기 상세",
      "review-delete": "리뷰 삭제",
      "review-profile": "리브후기 프로필",
      "review-schedule-select": "리브후기 일정 선택",
      "coupon-box": "쿠폰함",
      "review-edit": "리뷰 수정",
      "review-write": "리뷰 작성",
      "build-install": "빌드 설치",
      "ios-build-install": "iOS 빌드 설치",
      "ios-login": "iOS 로그인",
      "ios-search": "iOS 정확한 일정 검색",
      "ios-search-flexible": "iOS 유연한 일정 검색"
    };
    const finalResult = {
      run_id: store.runId,
      test_id: testIds[request.test] || "TC-UNKNOWN",
      name: testNames[request.test]
        ? (String(request.test).startsWith("ios-")
            ? testNames[request.test].replace(/^iOS\s+/, `iOS ${role} `)
            : `${role} ${testNames[request.test]}`)
        : request.test,
      env: request.env,
      status: "fail",
      device: request.test === "toss-deposit-approve" ||
        request.test === "console-schedule-change" ||
        request.test === "console-deposit-return"
        ? "browser"
        : String(request.test || "").startsWith("ios-")
          ? (config.appBuild && config.appBuild.ios && config.appBuild.ios.devices && config.appBuild.ios.devices[role]) || "unknown"
          : config.devices && config.devices[role] ? config.devices[role] : "unknown",
      duration_ms: Date.now() - startedAt,
      failed_step: "runner",
      error: error.message,
      error_details: error.details || [],
      error_stack: error.stack,
      app_build: error.app_build || appBuild,
      requested_by: store.request.requested_by,
      source: store.request.source,
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
