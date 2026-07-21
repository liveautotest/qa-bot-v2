function formatHelp() {
  return [
    "사용 가능한 QA 명령어",
    "",
    "자주 쓰는 명령어",
    "!게스트 로그인",
    "!게스트 로그아웃",
    "!호스트 로그인",
    "!호스트 로그아웃",
    "",
    "상세 명령어",
    "!qa help",
    "!qa login env=staging role=guest",
    "!qa login env=staging role=host",
    "!qa logout env=staging role=guest",
    "!qa logout env=staging role=host"
  ].join("\n");
}

function formatResult(result) {
  const icon = result.status === "pass" ? "PASS" : "FAIL";
  const lines = [
    `[${icon}] [${result.test_id}] ${result.name}`,
    "",
    `run_id: ${result.run_id}`,
    `환경: ${result.env}`,
    `디바이스: ${result.device || "unknown"}`,
    `소요시간: ${result.duration_ms}ms`
  ];

  if (result.session_reused) {
    lines.push("로그인 방식: 기존 로그인 세션 사용");
  }

  if (result.session_already_logged_out) {
    lines.push("로그아웃 방식: 이미 로그아웃된 상태");
  }

  if (result.status === "fail") {
    lines.push(`실패 단계: ${result.failed_step || "unknown"}`);
    lines.push(`에러: ${result.error || "unknown"}`);
    if (result.error_details && result.error_details.length > 0) {
      lines.push("확인할 내용:");
      for (const detail of result.error_details) {
        lines.push(`- ${detail}`);
      }
    }
  }

  if (result.security_checks && result.security_checks.length > 0) {
    lines.push("");
    lines.push("로그인 보안 확인:");
    for (const check of result.security_checks) {
      const status =
        check.status === "pass"
          ? "PASS"
          : check.status === "fail"
            ? "FAIL"
            : "NOT TESTED";
      lines.push(`[${status}] ${check.name}`);
    }
  }

  if (result.artifacts && result.artifacts.report_dir) {
    lines.push(`리포트: ${result.artifacts.report_dir}`);
  }

  return lines.join("\n");
}

module.exports = {
  formatHelp,
  formatResult
};
