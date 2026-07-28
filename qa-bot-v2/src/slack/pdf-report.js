const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

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

function extractReportDirs(text) {
  const dirs = [];
  const pattern = /리포트:\s*(\/[^\n]+)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const reportDir = match[1].trim();
    if (reportDir && fs.existsSync(path.join(reportDir, "result.json"))) {
      dirs.push(reportDir);
    }
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
  const summaryLines = [
    `테스트: ${result.name || result.test_id}`,
    `상태: ${String(result.status || "unknown").toUpperCase()}`,
    `환경: ${result.env || "-"}`,
    `디바이스: ${result.device || "-"}`,
    `소요시간: ${result.duration_ms || 0}ms`,
    `run_id: ${result.run_id || "-"}`
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
    ...objectLines(result.contract_request, "contract_request"),
    ...objectLines(result.approved_contract, "approved_contract"),
    ...objectLines(result.rejected_contract, "rejected_contract"),
    ...objectLines(result.schedule_change, "schedule_change"),
    ...objectLines(result.toss_deposit, "toss_deposit")
  ];

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
    ${section("실패 정보", errorLines)}
    ${preSection("에러 스택", errorStack)}
    ${section("테스트 조건", conditionLines)}
    ${section("기타 이슈", appWarningLines)}
    ${section("실행 단계", stepLines)}
    ${section("아티팩트", artifactLines)}
    ${diagnosticSections}
  </section>`;
}

function buildReportHtml(results) {
  const overallStatus = results.every((item) => item.result.status === "pass") ? "pass" : "fail";
  const summaryLines = results.map(({ result }, index) => {
    const status = String(result.status || "unknown").toUpperCase();
    const error = result.status === "fail" && result.error ? ` - ${result.error}` : "";
    return `${index + 1}. [${status}] ${result.name || result.test_id} (${result.duration_ms || 0}ms)${error}`;
  });
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
  const reportDirs = extractReportDirs(responseText);
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
