// Checks what the suite's results claim against the hosts' journals (env.sh
// suite runs it on the workstation once host-logs has copied them): each
// sleep check passes only if the sandbox's last completed step before the
// wake took it to the level asked for. The suite already waits for the
// host's state to report the level; the journal is the record of it, made by
// the host itself. It also counts, from the guests' consoles, how often each
// sandbox's agent restored and reconnected at once (once per move or host
// loss is expected, not once per restore). Every wake inside a sleep
// check's window, and the one that ends it, is printed with what asked for it
// (compute.wake.by: fleet, agent_link or guest_port). A checkpoint check
// passes only if the journal shows a completed checkpoint of its sandbox
// while its streams were open (begun and completed inside the window).
//
//   bun verify.ts <run directory>   (results.json and host-*.log)
//
// Rewrites results.json and results.md; exits 1 when a check failed or was
// skipped, as run.ts does.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  counts,
  render,
  type CheckpointProof,
  type LevelProof,
  type Meta,
  type Proof,
  type Result,
} from "./report.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun verify.ts <run directory>");
  process.exit(2);
}
const saved = JSON.parse(readFileSync(`${dir}/results.json`, "utf8")) as Meta & {
  results: Result[];
};

/** A completed step: when it began and ended (ms), on which host. */
type Step = {
  start: number;
  at: number;
  sandbox: string;
  step: string;
  cause: string;
  by: string;
  before: string;
  after: string;
  host: string;
};
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
    const ended = Number(BigInt(String(event.time_unix_nano)) / 1_000_000n);
    steps.push({
      start: ended - Number(event["compute.duration_us"] ?? 0) / 1_000,
      at: ended,
      sandbox: String(event["compute.sandbox.id"]),
      step: String(event["compute.step"]),
      cause: String(event["compute.cause"] ?? ""),
      by: String(event["compute.wake.by"] ?? ""),
      before: String(event["compute.level.before"] ?? ""),
      after: String(event["compute.level.after"] ?? ""),
      host: name.replace(/^host-|\.log$/g, ""),
    });
  }
}
steps.sort((a, b) => a.at - b.at);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 22);

/** A step that woke the sandbox, with its cause and what asked for it. */
const wake = (s: Step) => `${s.step} (${s.cause}${s.by ? `, by ${s.by}` : ""}) at ${clock(s.at)}`;

/** Why the journals do not show `proof`, or how they do. */
function check(proof: Proof): { ok: boolean; how: string } {
  return proof.kind === "checkpoint" ? checkpointed(proof) : leveled(proof);
}

function leveled(proof: LevelProof): { ok: boolean; how: string } {
  if (journals.length === 0) return { ok: false, how: "no host journals to verify the level with" };
  const from = Date.parse(proof.from);
  const to = Date.parse(proof.to);
  const mine = steps.filter((s) => s.sandbox === proof.sandbox);
  const during = mine.filter((s) => s.at >= from && s.at <= to);
  // Any wake inside the window undid a sleep the check asked for.
  const undone = during.filter((s) => s.after === "running" && s.before !== "running");
  const wakes = undone.length ? `; woken inside the window: ${undone.map(wake).join(", ")}` : "";
  const last = during.at(-1);
  if (!last || last.after !== proof.level) {
    return {
      ok: false,
      how:
        `host journal: the sandbox was not at ${proof.level} when the next request came (` +
        (last
          ? `its last completed step before it, ${last.step} at ${clock(last.at)}, left it ${last.after}`
          : "no step completed between the sleep and the request") +
        `)${wakes}`,
    };
  }
  // Nothing may have been changing the sandbox between reaching the level
  // and the suite's request: no other step that ended after the level step
  // and began before the request, whether it began after the level step,
  // at the same moment, or overlapped it (a wake someone else started,
  // still under way when the suite asked).
  const early = mine.filter((s) => s !== last && s.at > last.at && s.start < to);
  if (early.length > 0) {
    return {
      ok: false,
      how:
        `host journal: ${proof.level} at ${clock(last.at)}, but before the suite's request at ${clock(to)} ` +
        early
          .map(
            (s) => `${s.step} (${s.cause}${s.by ? `, by ${s.by}` : ""}) began at ${clock(s.start)}`,
          )
          .join(", ") +
        wakes,
    };
  }
  // The next step woke it from that level, begun at or after the request.
  const woke = mine.find((s) => s !== last && s.at > last.at);
  if (!woke || woke.before !== proof.level || woke.after === proof.level) {
    return {
      ok: false,
      how:
        `host journal: ${proof.level} at ${clock(last.at)} on ${last.host}, and ` +
        (woke
          ? `the next step, ${woke.step} at ${clock(woke.at)}, went ${woke.before} -> ${woke.after}`
          : "no step woke it from there") +
        wakes,
    };
  }
  if (woke.start < to) {
    return {
      ok: false,
      how: `host journal: the wake ${wake(woke)} began ${((to - woke.start) / 1000).toFixed(3)} s before the suite's request${wakes}`,
    };
  }
  return {
    ok: true,
    how:
      `host journal: ${proof.level} at ${clock(last.at)} on ${last.host}, woken from it by ${wake(woke)}, ` +
      `begun ${((woke.start - to) / 1000).toFixed(2)} s after the suite's request${wakes}`,
  };
}

function checkpointed(proof: CheckpointProof): { ok: boolean; how: string } {
  if (journals.length === 0)
    return { ok: false, how: "no host journals to verify the checkpoint with" };
  const from = Date.parse(proof.from);
  const to = Date.parse(proof.to);
  const done = steps.filter(
    (s) => s.sandbox === proof.sandbox && s.step === "checkpoint" && s.start >= from && s.at <= to,
  );
  const min = proof.min ?? 1;
  if (done.length < min) {
    return {
      ok: false,
      how: `host journal: ${done.length} checkpoint(s) of the sandbox completed while the streams were open, not at least ${min}`,
    };
  }
  return {
    ok: true,
    how: `host journal: ${done.length} checkpoint(s) while streaming, at ${done.map((s) => `${clock(s.at)} on ${s.host}`).join(", ")}`,
  };
}

// The checks whose pass rests on the journals: a pass with no proof to
// verify is not one.
const NEEDS_PROOF = /^(sleep-.*|checkpoint|link-stream|stale-restore)$/;
for (const result of saved.results) {
  if (result.status === "pass" && !result.proofs?.length && NEEDS_PROOF.test(result.id)) {
    result.status = "fail";
    result.detail = `${result.detail}; no proof recorded for the hosts' journals to verify`;
    continue;
  }
  if (!result.proofs?.length || result.status !== "pass") continue;
  const checked = result.proofs.map(check);
  result.detail = `${result.detail}; ${checked.map((one) => one.how).join("; ")}`;
  if (checked.some((one) => !one.ok)) result.status = "fail";
}

// The agent's reconnects, per sandbox, from the guest consoles env.sh copied.
const notes: string[] = [];
for (const name of readdirSync(dir).filter((file) => /^consoles-.*\.log$/.test(file))) {
  const text = readFileSync(`${dir}/${name}`, "utf8");
  const tally = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  notes.push(
    `${name.replace(/^consoles-|\.log$/g, "")}: "sandbox restored" ${tally(/sandbox restored/g)}, ` +
      `"reconnecting at once" ${tally(/reconnecting at once/g)}, "connected to control plane" ${tally(/connected to control plane/g)}`,
  );
}
saved.notes = notes;
for (const note of notes) console.log(note);

writeFileSync(`${dir}/results.json`, JSON.stringify(saved, null, 2));
writeFileSync(`${dir}/results.md`, render(saved, saved.results, true));
process.exit(counts(saved.results, "fail") + counts(saved.results, "skip") > 0 ? 1 : 0);
