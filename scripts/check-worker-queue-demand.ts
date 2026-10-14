import { readdir } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { run, testTool } from "../deploy/helm/opengeni/test/queue-demand-tooling";

// Same deployment-test discovery/isolation convention as the CI artifacts job.
// No application install, lockfile rewrite, cluster access or deployment.
const root = resolve(import.meta.dir, "..");
const chart = resolve(root, "deploy/helm/opengeni");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { output: { type: "string" } },
});
const [helm, promtool] = await Promise.all([testTool("helm"), testTool("promtool")]);
const env = {
  ...process.env,
  OPENGENI_HELM: helm,
  OPENGENI_PROMTOOL: promtool,
  PATH: `${dirname(helm)}${delimiter}${process.env.PATH ?? ""}`,
};
const commands = [
  [helm, "version", "--short"],
  [promtool, "--version"],
  [helm, "lint", chart],
  ...(await readdir(chart))
    .filter((name) => name.startsWith("values.") && name.endsWith(".yaml"))
    .sort()
    .map((name) => [helm, "lint", chart, "-f", resolve(chart, name)]),
  ...(await readdir(resolve(chart, "test")))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => [process.execPath, "test", resolve(chart, "test", name)]),
  [process.execPath, "test", resolve(root, "scripts/helm-upgrade-contract.test.ts")],
];
let failures = 0;
const results: Array<{ command: string[]; code: number; stdout: string; stderr: string }> = [];
for (const command of commands) {
  console.info(`Checking ${command.slice(1).join(" ")}`);
  const result = await run(command, root, env);
  results.push({ command, ...result });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) failures++;
}
console.info(`${commands.length} isolated checks; ${failures} failed`);
if (values.output) {
  await Bun.write(
    values.output,
    JSON.stringify(
      { checkedAt: new Date().toISOString(), checks: commands.length, failures, results },
      null,
      2,
    ),
  );
}
process.exitCode = failures ? 1 : 0;
