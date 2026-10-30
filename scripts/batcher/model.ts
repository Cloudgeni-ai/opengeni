// Pure decisions for the merge batcher. Everything here is a function of one
// observation of GitHub, so a pass can be repeated or interrupted at any point.

export const QUEUE_LABEL = "queue-ready";
export const PRIORITY_LABEL = "queue-priority";
export const VERSION_BRANCH = "changeset-release/main";
export const BATCH_PREFIX = "batch/";
export const BUILD_PREFIX = "batch-build/";
export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const MANIFEST_TRAILER = "Batch-Manifest: ";

/** Changes to CI or to the batcher itself are tested and landed alone. */
export const CONTROL_PLANE = [/^\.github\//, /^scripts\/ci\//, /^scripts\/batcher\//];

/**
 * Directories whose files carry a number that must be unique, such as database
 * migrations. Two changes that add the same number merge cleanly in Git but
 * fail CI together, so the batcher compares numbers before it tests anything.
 */
export const NUMBERED_FILES: {
  directory: string;
  pattern: RegExp;
  fix: (file: string) => string;
}[] = [
  {
    directory: "packages/db/drizzle/",
    pattern: /^(\d+)_[^/]+\.sql$/,
    fix: (file) =>
      `Merge main into the branch and move it to the next free number: \`bun scripts/renumber-migration.ts ${file.replace(/\.sql$/, "")} --next\`.`,
  },
];

export interface NumberedFile {
  /** Directory and number, like "packages/db/drizzle/1072". */
  slot: string;
  /** The number as the file name writes it, like "1072". */
  number: string;
  path: string;
}

/** The numbered files among these paths. */
export function numberedFiles(paths: string[]): NumberedFile[] {
  const found: NumberedFile[] = [];
  for (const path of paths)
    for (const { directory, pattern } of NUMBERED_FILES) {
      if (!path.startsWith(directory)) continue;
      const match = pattern.exec(path.slice(directory.length));
      if (match) found.push({ slot: `${directory}${Number(match[1])}`, number: match[1]!, path });
    }
  return found;
}

/**
 * Why a change's added numbered files cannot land on main: the first one whose
 * number main already uses for another file, or null.
 */
export function numberTaken(added: NumberedFile[], onMain: NumberedFile[]): string | null {
  const taken = new Map(onMain.map((file) => [file.slot, file.path]));
  for (const file of added) {
    const other = taken.get(file.slot);
    if (other === undefined || other === file.path) continue;
    const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const entry = NUMBERED_FILES.find(({ directory }) => file.path.startsWith(directory))!;
    return `\`${name(file.path)}\` uses number ${file.number}, which main already uses for \`${name(other)}\`. ${entry.fix(name(file.path))}`;
  }
  return null;
}

export interface Settings {
  /** Once the oldest ready PR has waited this long, build a batch. */
  windowMs: number;
  maxBatch: number;
  /** A batch whose CI has not appeared after this long is rebuilt. */
  startTimeoutMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  windowMs: 3 * 60_000,
  maxBatch: 12,
  startTimeoutMs: 10 * 60_000,
};

export interface QueuedPull {
  number: number;
  title: string;
  headSha: string;
  /** When it was (last) queued: the queue-ready label or auto-merge. */
  queuedAt: number;
  /** When PR CI passed on this exact head, or null while it has not. */
  greenAt: number | null;
  /** Why the PR cannot land on main as it is (a Git conflict, a number main already uses), or null. */
  conflict: string | null;
  /** Numbered slots its added files use; two members of one batch never share one. */
  slots: string[];
  priority: boolean;
  version: boolean;
  controlPlane: boolean;
}

export interface Member {
  number: number;
  title: string;
  head: string;
  /** Tree after this member was merged into the candidate. */
  tree: string;
  version?: true;
}

export interface Manifest {
  schemaVersion: 2;
  id: string;
  base: string;
  members: Member[];
  /** Groups still to test, in order, while a failed batch is being bisected. */
  pending: number[][];
}

export interface BatchRun {
  id: number;
  workflow: string;
  status: string;
  conclusion: string | null;
  attempt: number;
  url: string;
}

export interface Batch {
  branch: string;
  tip: string;
  manifest: Manifest;
  createdAt: number;
  runs: BatchRun[];
}

export interface Observation {
  now: number;
  mainSha: string;
  pulls: QueuedPull[];
  batches: Batch[];
}

export type Action =
  | { kind: "abandon"; batch: Batch; reason: string }
  | { kind: "retry"; batch: Batch; runs: BatchRun[] }
  | { kind: "land"; batch: Batch }
  | { kind: "eject"; number: number; reason: string }
  | { kind: "build"; members: QueuedPull[]; pending: number[][] }
  | { kind: "wait"; until: number };

export type Verdict =
  | { kind: "running" }
  | { kind: "missing" }
  | { kind: "passed" }
  | { kind: "retry"; runs: BatchRun[] }
  | { kind: "failed"; runs: BatchRun[] };

const PASSING = new Set(["success", "skipped", "neutral"]);

export function isControlPlane(files: string[]): boolean {
  return files.some((file) => CONTROL_PLANE.some((pattern) => pattern.test(file)));
}

/** Every workflow the batch push started must pass, and CI must be one of them. */
export function verdict(batch: Batch, now: number, settings: Settings): Verdict {
  const ci = batch.runs.filter((run) => run.workflow === CI_WORKFLOW);
  if (!ci.length)
    return now - batch.createdAt > settings.startTimeoutMs
      ? { kind: "missing" }
      : { kind: "running" };
  if (batch.runs.some((run) => run.status !== "completed")) return { kind: "running" };
  const failed = batch.runs.filter((run) => !PASSING.has(run.conclusion ?? ""));
  if (!failed.length) return { kind: "passed" };
  // One cheap retry of only the failed jobs absorbs flaky tests before blame.
  if (failed.every((run) => run.attempt < 2)) return { kind: "retry", runs: failed };
  return { kind: "failed", runs: failed };
}

function fifo(a: QueuedPull, b: QueuedPull) {
  return a.queuedAt - b.queuedAt || a.number - b.number;
}

/** When a PR became ready to batch: queued and green on its current head. */
export function readyAt(pull: QueuedPull): number {
  return Math.max(pull.queuedAt, pull.greenAt ?? Infinity);
}

/**
 * Choose the next batch. Priority and Version PRs go first; a failed batch's
 * remaining halves come next; then ready PRs in queue order. CI and batcher
 * changes run alone. A priority PR already in a failed batch's halves keeps
 * its place there: building every priority PR again would retest the batch
 * that just failed, unsplit, on every pass.
 */
export function nextBatch(
  pulls: QueuedPull[],
  pending: number[][],
  now: number,
  settings: Settings,
): Action | null {
  const ready = pulls.filter((p) => p.greenAt !== null && p.conflict === null).sort(fifo);
  if (!ready.length) return null;
  const alone = (p: QueuedPull) => p.version || p.controlPlane;

  const bisecting = new Set(pending.flat());
  const urgent = ready.filter((p) => (p.priority || p.version) && !bisecting.has(p.number));
  if (urgent.length) {
    const first = urgent[0]!;
    const members = alone(first)
      ? [first]
      : compatible(
          urgent.filter((p) => !alone(p)),
          settings,
        );
    return { kind: "build", members, pending };
  }

  for (let index = 0; index < pending.length; index++) {
    const group = pending[index]!.map((n) => ready.find((p) => p.number === n)).filter(
      (p): p is QueuedPull => p !== undefined,
    );
    if (!group.length) continue;
    const rest = pending.slice(index + 1);
    if (group.some(alone)) {
      const first = group[0]!;
      const others = group.filter((p) => p !== first).map((p) => p.number);
      return { kind: "build", members: [first], pending: others.length ? [others, ...rest] : rest };
    }
    return { kind: "build", members: group.slice(0, settings.maxBatch), pending: rest };
  }

  if (alone(ready[0]!)) return { kind: "build", members: [ready[0]!], pending: [] };
  const members = compatible(
    ready.filter((p) => !p.controlPlane),
    settings,
  );
  if (members.length < settings.maxBatch) {
    const oldest = Math.min(...members.map(readyAt));
    if (now - oldest < settings.windowMs)
      return { kind: "wait", until: oldest + settings.windowMs };
  }
  return { kind: "build", members, pending: [] };
}

/** Up to maxBatch PRs in order, skipping any that adds a number an earlier one adds. */
function compatible(candidates: QueuedPull[], settings: Settings): QueuedPull[] {
  const members: QueuedPull[] = [];
  const taken = new Set<string>();
  for (const pull of candidates) {
    if (pull.slots.some((slot) => taken.has(slot))) continue;
    members.push(pull);
    for (const slot of pull.slots) taken.add(slot);
    if (members.length === settings.maxBatch) break;
  }
  return members;
}

function split<T>(items: T[]): [T[], T[]] {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/** Decide everything one pass should do, in order. */
export function decide(observation: Observation, settings: Settings = DEFAULT_SETTINGS): Action[] {
  const { now, mainSha } = observation;
  const actions: Action[] = [];
  let pulls = observation.pulls;
  let pending: number[][] = [];
  const byNumber = new Map(pulls.map((p) => [p.number, p]));

  for (const pull of pulls)
    if (pull.conflict !== null)
      actions.push({ kind: "eject", number: pull.number, reason: pull.conflict });

  const batches = [...observation.batches].sort((a, b) => b.createdAt - a.createdAt);
  for (const extra of batches.slice(1))
    actions.push({ kind: "abandon", batch: extra, reason: "only one batch runs at a time" });
  const batch = batches[0];

  if (batch) {
    const { manifest } = batch;
    const numbers = manifest.members.map((m) => m.number);
    // An interrupted batch is tested again first, keeping any bisection.
    pending = [numbers, ...manifest.pending];
    const left = manifest.members.find((m) => byNumber.get(m.number)?.headSha !== m.head);
    // A priority PR goes into the next batch; it never cancels a running one.
    let reason: string | null = null;
    if (manifest.base !== mainSha) reason = "main moved since the batch was built";
    else if (left)
      reason = byNumber.has(left.number)
        ? `#${left.number} has a new head`
        : `#${left.number} left the queue`;
    if (reason) actions.push({ kind: "abandon", batch, reason });
    else {
      const result = verdict(batch, now, settings);
      if (result.kind === "running") return actions;
      if (result.kind === "missing") {
        actions.push({ kind: "abandon", batch, reason: "its CI never started" });
      } else if (result.kind === "retry") {
        actions.push({ kind: "retry", batch, runs: result.runs });
        return actions;
      } else if (result.kind === "passed") {
        actions.push({ kind: "land", batch });
        const landed = new Set(numbers);
        pulls = pulls.filter((p) => !landed.has(p.number));
        pending = manifest.pending;
      } else {
        actions.push({ kind: "abandon", batch, reason: "its CI failed" });
        if (numbers.length === 1) {
          const run = result.runs.find((r) => r.workflow === CI_WORKFLOW) ?? result.runs[0]!;
          actions.push({
            kind: "eject",
            number: numbers[0]!,
            reason: `it failed CI on top of main, also after a retry: ${run.url}`,
          });
          pulls = pulls.filter((p) => p.number !== numbers[0]);
          pending = manifest.pending;
        } else {
          // Bisect: test the first half now and keep the second half next in line.
          const [first, second] = split(numbers);
          pending = [first, second, ...manifest.pending];
        }
      }
    }
  }

  const next = nextBatch(
    pulls.filter((p) => p.conflict === null),
    pending,
    now,
    settings,
  );
  if (next) actions.push(next);
  return actions;
}

export function batchTitle(id: string, members: { number: number }[]): string {
  return `Batch ${id}: ${members.map((m) => `#${m.number}`).join(", ")}`;
}

export function renderManifest(manifest: Manifest): string {
  return `${batchTitle(manifest.id, manifest.members)}\n\n${MANIFEST_TRAILER}${JSON.stringify(manifest)}\n`;
}

export function parseManifest(message: string): Manifest | null {
  const line = message.split("\n").find((l) => l.startsWith(MANIFEST_TRAILER));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(MANIFEST_TRAILER.length)) as Manifest;
    const sha = /^[0-9a-f]{40}$/;
    if (
      value.schemaVersion !== 2 ||
      !/^[0-9a-f]{12}$/.test(value.id) ||
      !sha.test(value.base) ||
      !Array.isArray(value.members) ||
      !value.members.length ||
      value.members.some(
        (m) =>
          !Number.isSafeInteger(m.number) ||
          typeof m.title !== "string" ||
          !sha.test(m.head) ||
          !sha.test(m.tree),
      ) ||
      !Array.isArray(value.pending) ||
      value.pending.some((g) => !Array.isArray(g) || g.some((n) => !Number.isSafeInteger(n)))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** The landed commit title: the PR title with its number, like a GitHub squash. */
export function squashTitle(member: Pick<Member, "number" | "title">): string {
  const title = member.title.trim().replace(/\s*\(#\d+\)$/, "");
  return `${title} (#${member.number})`;
}
