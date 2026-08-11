const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const {
  buildResultJudgment,
  formatFigmaValidationDetailLines
} = require("./slack-reporter");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findChromeExecutable(config) {
  const candidates = [
    config.tossAdmin?.chromePath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);

  return candidates.find((filePath) => fs.existsSync(filePath)) || "";
}

function findReportDirByRunId(reportBaseDir, runId) {
  if (!reportBaseDir || !runId) return "";
  const reportDir = path.join(reportBaseDir, runId);
  return fs.existsSync(path.join(reportDir, "result.json")) ? reportDir : "";
}

function extractReportDirs(text, config = {}) {
  const dirs = [];
  const pattern = /리포트:\s*(\/[^\n]+)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const reportDir = match[1].trim();
    if (reportDir && fs.existsSync(path.join(reportDir, "result.json"))) {
      dirs.push(reportDir);
    }
  }

  const runIdPattern = /\brun_id:\s*(qa-[^\s]+)/g;
  while ((match = runIdPattern.exec(String(text || "")))) {
    const reportDir = findReportDirByRunId(config.reportBaseDir, match[1].trim());
    if (reportDir) dirs.push(reportDir);
  }

  return Array.from(new Set(dirs));
}

function readResult(reportDir) {
  return JSON.parse(fs.readFileSync(path.join(reportDir, "result.json"), "utf8"));
}

function formatStep(step, index) {
  const status = String(step.status || "unknown").toUpperCase();
  const message = step.message ? ` - ${step.message}` : "";
  return `${index + 1}. [${status}] ${step.name || "unnamed"}${message}`;
}

function section(title, lines) {
  const visibleLines = (lines || []).filter(Boolean);
  if (!visibleLines.length) return "";
  return [
    `<h2>${escapeHtml(title)}</h2>`,
    "<ul>",
    ...visibleLines.map((line) => `<li>${escapeHtml(line).replace(/\n/g, "<br>")}</li>`),
    "</ul>"
  ].join("\n");
}

function preSection(title, body) {
  if (!body) return "";
  return [
    `<h2>${escapeHtml(title)}</h2>`,
    `<pre>${escapeHtml(body)}</pre>`
  ].join("\n");
}

function objectLines(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const label = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return objectLines(item, label);
    }
    if (Array.isArray(item)) {
      return [`${label}: ${item.join(", ")}`];
    }
    return item === undefined || item === null || item === "" ? [] : [`${label}: ${item}`];
  });
}

function readTextPreview(filePath, maxChars = 2000) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    const body = fs.readFileSync(filePath, "utf8");
    return body.length > maxChars
      ? `${body.slice(0, maxChars)}\n...truncated ${body.length - maxChars} chars`
      : body;
  } catch (error) {
    return `Failed to read ${filePath}: ${error.message}`;
  }
}

function listDiagnosticFiles(reportDir, result) {
  const logsDir = path.join(reportDir, "logs");
  const fromArtifacts = result.artifacts?.logs || [];
  const fromDirectory = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir)
      .filter((name) => {
        const lower = name.toLowerCase();
        return (
          lower.includes("request") ||
          lower.includes("response") ||
          lower.includes("error") ||
          lower.includes("logcat") ||
          lower.includes("runner")
        );
      })
      .map((name) => path.join(logsDir, name))
    : [];

  return Array.from(new Set([...fromArtifacts, ...fromDirectory]))
    .filter((filePath) => /\.(json|txt|log)$/i.test(filePath))
    .filter((filePath) => fs.existsSync(filePath))
    .slice(0, 6);
}

function buildResultSectionHtml(result, reportDir, index = 1) {
  const statusClass = result.status === "pass" ? "pass" : "fail";
  const judgment = buildResultJudgment(result);
  const summaryLines = [
    `판정: ${judgment.conclusion}`,
    `요청자: ${judgment.requester}`,
    `환경/디바이스: ${judgment.env} / ${judgment.device}`,
    `소요시간: ${judgment.duration}`,
    `run_id: ${judgment.runId}`
  ];

  const judgmentLines = result.status === "pass"
    ? [
      ...judgment.verified.map((line) => `검증 완료: ${line}`),
      ...judgment.conditions.map((line) => line.replace(/^- /, "조건: "))
    ]
    : [
      `실패 위치: ${judgment.failedStep}`,
      `마지막 성공: ${judgment.lastPassed}`,
      `마지막 진행: ${judgment.lastProgress}`,
      `의심 영역: ${judgment.suspectedArea}`,
      ...judgment.nextChecks.map((line) => `다음 확인: ${line}`)
    ];

  const errorLines = result.status === "fail"
    ? [
      `실패 단계: ${result.failed_step || "runner"}`,
      `에러: ${result.error || "unknown"}`,
      ...(result.error_details || [])
    ]
    : [];
  const errorStack = result.error_stack || "";

  const conditionLines = [
    ...objectLines(result.search_conditions, "search"),
    ...objectLines(result.contract_conditions, "contract"),
    ...objectLines(result.payment_conditions, "payment"),
    ...objectLines(result.contract_extension, "contract_extension"),
    ...objectLines(result.contract_extension_approval, "contract_extension_approval"),
    ...objectLines(result.figma_validation, "figma_validation"),
    ...objectLines(result.contract_request, "contract_request"),
    ...objectLines(result.approved_contract, "approved_contract"),
    ...objectLines(result.rejected_contract, "rejected_contract"),
    ...objectLines(result.toss_deposit, "toss_deposit"),
    ...objectLines(result.review_write, "review_write"),
    ...objectLines(result.review_edit, "review_edit"),
    ...objectLines(result.review_delete, "review_delete")
  ];
  const figmaValidationLines = formatFigmaValidationDetailLines(result.figma_validation, { maxItems: 100 });

  const appWarningLines = (result.app_warnings || []).flatMap((warning) => [
    `${warning.name || "warning"}: ${warning.message || ""}`,
    ...(warning.details || [])
  ]);

  const stepLines = (result.steps || []).map(formatStep);
  const artifactLines = [
    `report_dir: ${reportDir}`,
    ...((result.artifacts?.logs || []).map((filePath) => `log: ${filePath}`)),
    ...((result.artifacts?.screenshots || []).map((filePath) => `screenshot: ${filePath}`))
  ];
  const diagnosticFiles = listDiagnosticFiles(reportDir, result);
  const diagnosticSections = diagnosticFiles.map((filePath) => preSection(
    `로그 상세 - ${path.basename(filePath)}`,
    readTextPreview(filePath)
  )).join("\n");

  return `
  <section class="result-section">
    <h1>${index}. ${escapeHtml(result.name || result.test_id)}</h1>
    <div class="meta"><span class="badge ${statusClass}">${escapeHtml(String(result.status || "unknown").toUpperCase())}</span></div>
    <div class="box">
      <ul>${summaryLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
    </div>
    ${section(result.status === "pass" ? "검증 요약" : "실패 판단 요약", judgmentLines)}
    ${section("실패 정보", errorLines)}
    ${preSection("에러 스택", errorStack)}
    ${section("테스트 조건", conditionLines)}
    ${section("Figma 기준 비교", figmaValidationLines)}
    ${section("기타 이슈", appWarningLines)}
    ${section("실행 단계", stepLines)}
    ${section("아티팩트", artifactLines)}
    ${diagnosticSections}
  </section>`;
}

function buildReportHtml(results) {
  const overallStatus = results.every((item) => item.result.status === "pass") ? "pass" : "fail";
  const judgments = results.map(({ result }) => buildResultJudgment(result));
  const totalMs = results.reduce((sum, item) => sum + (Number(item.result.duration_ms) || 0), 0);
  const failed = judgments.filter((judgment) => judgment.status === "FAIL");
  const summaryLines = judgments.map((judgment, index) => {
    return `${index + 1}. [${judgment.status}] ${judgment.title} - ${judgment.conclusion}`;
  });
  const decisionLines = [
    `최종 상태: ${overallStatus.toUpperCase()}`,
    `총 실행 수: ${results.length}개`,
    `실패 수: ${failed.length}개`,
    `총 소요시간: ${Math.round(totalMs / 1000)}초`,
    failed[0] ? `우선 확인 대상: ${failed[0].title} - ${failed[0].failureReason}` : "우선 확인 대상: 없음"
  ];
  const resultSections = results.map(({ result, reportDir }, index) => (
    buildResultSectionHtml(result, reportDir, index + 1)
  )).join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
      color: #202124;
      font-size: 12px;
      line-height: 1.55;
      margin: 32px;
    }
    h1 { font-size: 22px; margin: 0 0 12px; }
    h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 3px 0; word-break: break-word; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-weight: 700; color: #fff; }
    .pass { background: #188038; }
    .fail { background: #d93025; }
    .meta { color: #5f6368; margin-bottom: 18px; }
    .box { border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; background: #fafafa; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      background: #f8f9fa;
      padding: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10px;
      line-height: 1.45;
    }
    .page-break { break-after: page; }
    .result-section { break-before: page; }
  </style>
</head>
<body>
  <h1>QA 자동화 통합 리포트</h1>
  <div class="meta"><span class="badge ${overallStatus}">${escapeHtml(overallStatus.toUpperCase())}</span></div>
  <h2>결과 판정</h2>
  <div class="box">
    <ul>${decisionLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
  </div>
  <h2>실행 요약</h2>
  <div class="box">
    <ul>${summaryLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
  </div>
  ${resultSections}
</body>
</html>`;
}

async function renderPdf({ config, html, pdfPath }) {
  const chromePath = findChromeExecutable(config);
  if (!chromePath) {
    throw new Error("Chrome executable not found for PDF report generation.");
  }

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "16mm",
        bottom: "16mm",
        left: "14mm",
        right: "14mm"
      }
    });
  } finally {
    await browser.close();
  }
}

async function createPdfReport({ config, reportDir }) {
  const result = readResult(reportDir);
  const pdfPath = path.join(reportDir, `${result.run_id || path.basename(reportDir)}.pdf`);
  await renderPdf({
    config,
    html: buildReportHtml([{ result, reportDir }]),
    pdfPath
  });
  return {
    pdfPath,
    result
  };
}

async function createCombinedPdfReport({ config, reportDirs }) {
  const items = reportDirs.map((reportDir) => ({
    reportDir,
    result: readResult(reportDir)
  }));
  if (!items.length) return null;

  const first = items[0].result;
  const last = items[items.length - 1].result;
  const status = items.every((item) => item.result.status === "pass") ? "pass" : "fail";
  const outputDir = items[items.length - 1].reportDir;
  const baseName = items.length === 1
    ? first.run_id || path.basename(outputDir)
    : `${last.run_id || path.basename(outputDir)}-combined`;
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);

  await renderPdf({
    config,
    html: buildReportHtml(items),
    pdfPath
  });

  return {
    pdfPath,
    status,
    title: items.length === 1
      ? `[${String(first.status || "unknown").toUpperCase()}] ${first.name || first.test_id}`
      : `[${status.toUpperCase()}] QA 자동화 통합 리포트 (${items.length}개 실행)`
  };
}

async function uploadPdfReports({ client, config, channel, threadTs, responseText }) {
  const reportDirs = extractReportDirs(responseText, config);
  const combined = await createCombinedPdfReport({ config, reportDirs });
  if (!combined) return [];

  await client.filesUploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file: fs.createReadStream(combined.pdfPath),
    filename: path.basename(combined.pdfPath),
    title: combined.title
  });

  return [combined.pdfPath];
}

module.exports = {
  createCombinedPdfReport,
  createPdfReport,
  extractReportDirs,
  uploadPdfReports
};
