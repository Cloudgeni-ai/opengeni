// The checks' shared parts: a named check that records its outcome, the
// fleet's own view of a sandbox, and the results file.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const results = process.env.CONFORMANCE_RESULTS ?? "results";
mkdirSync(results, { recursive: true });

let passed = 0;
const failures = [];

/** Runs `fn` as the check `name`; its value, or `undefined` if it failed. */
export async function check(suite, name, fn) {
  const start = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - start);
    passed += 1;
    const shown = detail === undefined ? "" : JSON.stringify(detail).slice(0, 160);
    console.log(`ok    ${name} ${ms} ms ${shown}`);
    appendFileSync(
      join(results, `${suite}.jsonl`),
      `${JSON.stringify({ name, ok: true, ms, detail })}\n`,
    );
    return detail ?? true;
  } catch (error) {
    const ms = Math.round(performance.now() - start);
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    failures.push(name);
    console.log(`FAIL  ${name} ${ms} ms ${text.slice(0, 400)}`);
    appendFileSync(
      join(results, `${suite}.jsonl`),
      `${JSON.stringify({ name, ok: false, ms, error: text })}\n`,
    );
    return undefined;
  }
}

/** Ends the suite: its tally, and a failing exit status if any check failed. */
export function finish(suite, measured = {}) {
  writeFileSync(join(results, `${suite}-measured.json`), JSON.stringify(measured, null, 2));
  console.log(`\n${suite}: ${passed}/${passed + failures.length} checks passed`);
  for (const name of failures) console.log(`  failed: ${name}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** How deep the host lets `id` sleep now: `running`, `paused`, `saved`, ... */
export function level(id) {
  const command = process.env.CONFORMANCE_HOST_STATUS;
  if (!command) throw new Error("CONFORMANCE_HOST_STATUS is not set");
  const [program, ...args] = command.split(" ");
  const reply = JSON.parse(execFileSync(program, args, { encoding: "utf8" }));
  const sandboxes = reply.status?.sandboxes ?? reply.sandboxes ?? reply.Status?.sandboxes ?? [];
  const found = sandboxes.find((sandbox) => String(sandbox.id) === id);
  return found?.level;
}

/** Waits up to `ms` for `id` to reach a level in `levels`; the level reached. */
export async function untilLevel(id, levels, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const now = level(id);
    if (levels.includes(now)) return now;
    if (Date.now() > deadline)
      throw new Error(`level ${now}, not ${levels.join(" or ")}, after ${ms} ms`);
    await sleep(500);
  }
}

/** Asks the fleet service to put `id` to sleep at `level`. */
export async function sleepTo(id, levelName) {
  const response = await fetch(`${process.env.CONFORMANCE_FLEET_API}/v1/sandboxes/${id}/sleep`, {
    method: "POST",
    headers: { "x-api-key": process.env.E2B_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ level: levelName }),
  });
  expect(response.ok, `sleep ${levelName}: ${response.status} ${await response.text()}`);
}
