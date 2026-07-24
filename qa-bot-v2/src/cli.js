const { loadConfig } = require("./config");
const { runTest } = require("./orchestrator/run-test");

function parseArgs(argv) {
  const args = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value = ""] = arg.slice(2).split("=");
    args[key] = value || true;
  }

  return args;
}

async function main() {
  const [testName, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!testName) {
    throw new Error("Usage: node src/cli.js <login|logout|search|search-flexible|contract-request|contract-cancel-request|contract-cancel-confirmed|contract-approve|contract-reject|contract-payment|schedule-change|toss-deposit-approve> --env=staging --role=guest");
  }

  const config = loadConfig();
  const request = {
    test: testName,
    env: args.env || (testName === "toss-deposit-approve" ? "toss" : testName === "schedule-change" ? "api" : "staging"),
    role: args.role || (testName === "toss-deposit-approve" ? "admin" : testName === "schedule-change" ? "api" : "guest"),
    payment_method: args.method || args.payment_method,
    reservation_id: args.reservation_id || args.reservation || args.id,
    offset_label: args.offset || args.offset_label,
    requested_by: "local-cli",
    source: "cli"
  };

  const result = await runTest(request, config);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
