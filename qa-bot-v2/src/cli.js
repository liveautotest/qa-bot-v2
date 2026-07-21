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
    throw new Error("Usage: node src/cli.js <login|logout> --env=staging --role=guest");
  }

  const config = loadConfig();
  const request = {
    test: testName,
    env: args.env || "staging",
    role: args.role || "guest",
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
