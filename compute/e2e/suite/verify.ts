// Checks what the suite's results claim against the hosts' journals (env.sh
// suite runs it on the workstation once host-logs has copied them): each
// sleep check passes only if the sandbox's last completed step before the
// wake took it to the level asked for. The suite already waits for the
// host's state to report the level; the journal is the record of it, made by
// the host itself. It also counts, from the guests' consoles, how often each
// sandbox's agent restored and reconnected at once (once per move or host
// loss is expected, not once per restore). Every wake inside a sleep
// check's window, and the one that ends it, is printed with what asked for it
// (compute.wake.by: fleet, agent_link or guest_port); a proof that names what
// must wake it (the sleeps: agent_link) fails on any other. A checkpoint check
// passes only if the journal shows a completed checkpoint of its sandbox
// while its streams were open (begun and completed inside the window). Before
// each pause to save or checkpoint, the host asks the guest to write its
// disks out and warns only when it does not ("guest did not write its disks
// out"): a sleep or checkpoint proof fails on such a warning for its sandbox
// inside its window.
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
  type JournalProof,
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
/** A host's warning that the guest did not write its disks out before a
 * pause, so the copy was saved as it was. */
type Unsynced = { at: number; sandbox: string; host: string };
const unsynced: Unsynced[] = [];
// host-<name>.log is each host's journal at the end of the run;
// host-<name>@<instance>.log one the suite kept before stopping that
// machine (host-loss), whose journal its replacement does not have. A
// machine that came back keeps its journal, so an event can be in both:
// it counts once. A kept journal is read only once it is known good: its
// name well formed, declared by a check's journal proof of any status (host, instance and
// boot), and its header, written on the machine itself, naming that same
// instance and boot. Any other file is left out, with the reason.
const declared = new Map<string, JournalProof>();
for (const result of saved.results) {
  for (const proof of result.proofs ?? []) {
    if (proof.kind === "journal") declared.set(`host-${proof.host}@${proof.instance}.log`, proof);
  }
}
const kept = new Map<string, { instance: string; boot: string }>();
const refused = new Map<string, string>();
const journals = readdirSync(dir).filter((name) => {
  if (!/^host-.*\.log$/.test(name)) return false;
  if (!name.includes("@")) {
    if (/^host-[a-z0-9-]+\.log$/.test(name)) return true;
    console.error(`${name}: not a host journal's name; not used`);
    return false;
  }
  const refuse = (why: string) => {
    refused.set(name, why);
    console.error(`${name}: ${why}; not used`);
    return false;
  };
  const named = /^host-([a-z0-9-]+)@([0-9]+)\.log$/.exec(name);
  if (!named) return refuse("not a kept journal's name (host-<name>@<instance id>.log)");
  const proof = declared.get(name);
  if (!proof) return refuse("no check of this run declared it");
  const header = /^# instance=([0-9]+) boot=([0-9a-f-]{36})\n/.exec(
    readFileSync(`${dir}/${name}`, "utf8"),
  );
  if (!header) return refuse("it has no instance and boot header");
  if (header[1] !== proof.instance) {
    return refuse(`its header names instance ${header[1]}, not ${proof.instance}`);
  }
  if (header[2] !== proof.boot)
    return refuse(`its header names boot ${header[2]}, not ${proof.boot}`);
  kept.set(name, { instance: header[1]!, boot: header[2]! });
  return true;
});
const seen = new Set<string>();
const seenUnsynced = new Set<string>();
for (const name of journals) {
  for (const line of readFileSync(`${dir}/${name}`, "utf8").split("\n")) {
    if (line.includes("guest did not write its disks out")) {
      // The journal may colour the fields: plain text first.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      const host = name.replace(/^host-|(@[^@]*)?\.log$/g, "");
      const id = /\bid=([0-9a-f]{32})\b/.exec(plain)?.[1] ?? "";
      const at = Date.parse(plain.split(" ")[0] ?? "");
      const key = `${host} ${plain.split(" ")[0]} ${id}`;
      if (!seenUnsynced.has(key)) {
        seenUnsynced.add(key);
        unsynced.push({ at: Number.isFinite(at) ? at : Number.NaN, sandbox: id, host });
      }
      continue;
    }
    const at = line.indexOf("compute_event: ");
    if (at < 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(at + "compute_event: ".length));
    } catch {
      continue;
    }
    if (event.event !== "compute.step" || event["compute.outcome"] !== "done") continue;
    const host = name.replace(/^host-|(@[^@]*)?\.log$/g, "");
    const key = `${host} ${String(event.time_unix_nano)} ${String(event["compute.sandbox.id"])} ${String(event["compute.step"])}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
      host,
    });
  }
}
steps.sort((a, b) => a.at - b.at);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 22);

/** A step that woke the sandbox, with its cause and what asked for it. */
const wake = (s: Step) => `${s.step} (${s.cause}${s.by ? `, by ${s.by}` : ""}) at ${clock(s.at)}`;

/** The hosts' warnings that `sandbox`'s guest did not write its disks out
 * inside `from`..`to`: one whose sandbox or time cannot be read counts as
 * this sandbox's, inside. */
function unsyncedIn(sandbox: string, from: number, to: number): string | undefined {
  const found = unsynced.filter(
    (one) =>
      (one.sandbox === "" || one.sandbox === sandbox) &&
      (Number.isNaN(one.at) || (one.at >= from && one.at <= to)),
  );
  if (found.length === 0) return undefined;
  return `host journal: the guest did not write its disks out before ${found.length} pause(s) to copy it (${found.map((one) => `${Number.isNaN(one.at) ? "?" : clock(one.at)} on ${one.host}`).join(", ")})`;
}

/** Why the journals do not show `proof`, or how they do. */
function check(proof: Proof): { ok: boolean; how: string } {
  if (proof.kind === "journal") return keptJournal(proof);
  return proof.kind === "checkpoint" ? checkpointed(proof) : leveled(proof);
}

function keptJournal(proof: JournalProof): { ok: boolean; how: string } {
  const name = `host-${proof.host}@${proof.instance}.log`;
  const found = kept.get(name);
  if (!found) {
    const why = refused.get(name);
    return { ok: false, how: why ? `${name} not used: ${why}` : `no kept journal ${name}` };
  }
  if (found.boot !== proof.boot) {
    return { ok: false, how: `${name} is of boot ${found.boot}, not ${proof.boot}` };
  }
  return {
    ok: true,
    how: `kept journal of ${proof.host}: instance ${proof.instance}, boot ${proof.boot}`,
  };
}

function leveled(proof: LevelProof): { ok: boolean; how: string } {
  if (journals.length === 0) return { ok: false, how: "no host journals to verify the level with" };
  const from = Date.parse(proof.from);
  const to = Date.parse(proof.to);
  const notSynced = unsyncedIn(proof.sandbox, from, to);
  if (notSynced) return { ok: false, how: notSynced };
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
  if (proof.by && woke.by !== proof.by) {
    return {
      ok: false,
      how: `host journal: ${proof.level} at ${clock(last.at)} on ${last.host}, woken by ${wake(woke)}, not by ${proof.by}${wakes}`,
    };
  }
  return {
    ok: true,
    how:
      `host journal: ${proof.level} at ${clock(last.at)} on ${last.host}, woken from it by ${wake(woke)}, ` +
      `begun ${((woke.start - to) / 1000).toFixed(2)} s after the suite's request${wakes}; no warning that the guest did not write its disks out`,
  };
}

function checkpointed(proof: CheckpointProof): { ok: boolean; how: string } {
  if (journals.length === 0)
    return { ok: false, how: "no host journals to verify the checkpoint with" };
  const from = Date.parse(proof.from);
  const to = Date.parse(proof.to);
  const notSynced = unsyncedIn(proof.sandbox, from, to);
  if (notSynced) return { ok: false, how: notSynced };
  const done = steps.filter(
    (s) => s.sandbox === proof.sandbox && s.step === "checkpoint" && s.start >= from && s.at <= to,
  );
  const min = proof.min ?? 1;
  if (done.length < min) {
    return {
      ok: false,
      how: `host journal: ${done.length} checkpoint(s) of the sandbox begun and completed inside the window, not at least ${min}`,
    };
  }
  return {
    ok: true,
    how: `host journal: ${done.length} checkpoint(s) inside the window, at ${done.map((s) => `${clock(s.at)} on ${s.host}`).join(", ")}; no warning that the guest did not write its disks out`,
  };
}

// The checks whose pass rests on the journals: a pass with no proof to
// verify is not one.
const NEEDS_PROOF = /^(sleep-.*|checkpoint|link-stream|vm-crash|host-loss)$/;
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
// Every warning in the run that a guest did not write its disks out, inside
// a proof's window or not.
notes.push(
  `"guest did not write its disks out" warnings: ${unsynced.length}` +
    (unsynced.length
      ? ` (${unsynced.map((one) => `${one.sandbox ? one.sandbox.slice(0, 12) : "an unnamed sandbox"} on ${one.host}${Number.isNaN(one.at) ? "" : ` at ${clock(one.at)}`}`).join(", ")})`
      : ""),
);
saved.notes = notes;
for (const note of notes) console.log(note);

writeFileSync(`${dir}/results.json`, JSON.stringify(saved, null, 2));
writeFileSync(`${dir}/results.md`, render(saved, saved.results, true));
process.exit(counts(saved.results, "fail") + counts(saved.results, "skip") > 0 ? 1 : 0);
