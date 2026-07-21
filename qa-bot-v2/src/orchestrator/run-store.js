const fs = require("fs");
const path = require("path");

function pad(value) {
  return String(value).padStart(2, "0");
}

function createRunId(request, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");

  const parts = ["qa", stamp, request.test, request.env];
  if (request.role) parts.push(request.role);
  return parts.join("-");
}

function createRunStore(reportBaseDir, request) {
  const runId = createRunId(request);
  const runDir = path.join(reportBaseDir, runId);
  const screenshotsDir = path.join(runDir, "screenshots");
  const logsDir = path.join(runDir, "logs");

  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const fullRequest = {
    run_id: runId,
    ...request,
    created_at: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(runDir, "request.json"),
    JSON.stringify(fullRequest, null, 2)
  );

  return {
    runId,
    runDir,
    screenshotsDir,
    logsDir,
    request: fullRequest,
    writeResult(result) {
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify(result, null, 2)
      );
    },
    appendLog(fileName, line) {
      fs.appendFileSync(path.join(logsDir, fileName), `${line}\n`);
    }
  };
}

module.exports = {
  createRunId,
  createRunStore
};
