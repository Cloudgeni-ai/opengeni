// Checks what the suite's results claim against the hosts' journals (env.sh
// suite runs it on the workstation once host-logs has copied them): each
// sleep check passes only if the sandbox's last completed step before the
// wake took it to the level asked for. The fabric's API does not report a
// sandbox's level, and a host acknowledges a sleep before the sleep is done,
// so without this a sleep that never happened would pass.
//
//   bun verify.ts <run directory>   (results.json and host-*.log)
//
// Rewrites results.json and results.md; exits 1 when a check failed or was
// skipped, as run.ts does.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { counts, render, type LevelProof, type Meta, type Result } from "./report.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun verify.ts <run directory>");
  process.exit(2);
}
const saved = JSON.parse(readFileSync(`${dir}/results.json`, "utf8")) as Meta & { results: Result[] };

type Step = { at: number; sandbox: string; step: string; cause: string; before: string; after: string; host: string };
const steps: Step[] = [];
const journals = readdirSync(dir).filter((name) => /^host-.*\.log$/.test(name));
for (const name of journals) {
  for (const line of readFileSync(`${dir}/${name}`, "utf8").split("\n")) {
    const at = line.indexOf("compute_event: ");
    if (at < 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(at + "compute_event: ".length));
    } catch {
      continue;
    }
    if (event.event !== "compute.step" || event["compute.outcome"] !== "done") continue;
    steps.push({
      at: Number(BigInt(String(event.time_unix_nano)) / 1_000_000n),
      sandbox: String(event["compute.sandbox.id"]),
      step: String(event["compute.step"]),
      cause: String(event["compute.cause"] ?? ""),
      before: String(event["compute.level.before"] ?? ""),
      after: String(event["compute.level.after"] ?? ""),
      host: name.replace(/^host-|\.log$/g, ""),
    });
  }
}
steps.sort((a, b) => a.at - b.at);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 22);

/** Why the journals do not show `proof`, or how they do. */
function check(proof: LevelProof): { ok: boolean; how: string } {
  if (journals.length === 0) return { ok: false, how: "no host journals to verify the level with" };
  const from = Date.parse(proof.from);
  const to = Date.parse(proof.to);
  const mine = steps.filter((s) => s.sandbox === proof.sandbox);
  const during = mine.filter((s) => s.at >= from && s.at <= to);
  const last = during.at(-1);
  if (!last || last.after !== proof.level) {
    return {
      ok: false,
      how:
        `host journal: the sandbox was not at ${proof.level} when the next request came (` +
        (last ? `its last completed step before it, ${last.step} at ${clock(last.at)}, left it ${last.after}` : "no step completed between the sleep and the request") +
        ")",
    };
  }
  const woke = mine.find((s) => s.at > to && s.before === proof.level);
  return {
    ok: true,
    how:
      `host journal: ${proof.level} at ${clock(last.at)} on ${last.host}` +
      (woke ? `, woken from it by ${woke.step} (${woke.cause}) at ${clock(woke.at)}` : ""),
  };
}

for (const result of saved.results) {
  if (!result.proofs?.length || result.status !== "pass") continue;
  const checked = result.proofs.map(check);
  result.detail = `${result.detail}; ${checked.map((one) => one.how).join("; ")}`;
  if (checked.some((one) => !one.ok)) result.status = "fail";
}

writeFileSync(`${dir}/results.json`, JSON.stringify(saved, null, 2));
writeFileSync(`${dir}/results.md`, render(saved, saved.results, true));
process.exit(counts(saved.results, "fail") + counts(saved.results, "skip") > 0 ? 1 : 0);
