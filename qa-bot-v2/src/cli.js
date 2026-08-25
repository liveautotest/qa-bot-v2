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
    throw new Error("Usage: node src/cli.js <login|logout|search|search-flexible|ios-login|ios-search|ios-search-flexible|ios-contract-request|ios-contract-cancel-request|contract-request|contract-cancel-request|contract-cancel-confirmed|contract-extension|contract-extension-approve|contract-approve|contract-reject|contract-payment|toss-deposit-approve|console-schedule-change|console-deposit-return|build-install|ios-build-install> --env=staging --role=guest");
  }

  const hostDefaultTests = new Set(["contract-approve", "contract-reject", "contract-extension-approve"]);
  const config = loadConfig();
  const request = {
    test: testName,
    env: args.env || (testName === "toss-deposit-approve" ? "toss" : "staging"),
    role: args.role || (testName === "toss-deposit-approve" || testName === "console-schedule-change" || testName === "console-deposit-return" ? "admin" : hostDefaultTests.has(testName) ? "host" : "guest"),
    payment_method: args.method || args.payment_method,
    split_start: args.split_start,
    split_end: args.split_end,
    random_search_profile: args.random_search_profile === true || args.random_search_profile === "true",
    guest_pet_count: args.guest_pet_count === undefined ? undefined : Number(args.guest_pet_count),
    reservation_id: args.reservation_id,
    schedule_shift_label: args.shift || args.schedule_shift_label,
    deposit_action: args.action || args.deposit_action,
    release_name: args.release_name,
    build_version: args.build_version,
    skip_app_build_check: testName === "build-install",
    precheck_only: args.precheck_only === true || args.precheck_only === "true",
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
