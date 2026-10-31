// Pure decisions for the merge batcher. Everything here is a function of one
// observation of GitHub, so a pass can be repeated or interrupted at any point.

export const QUEUE_LABEL = "queue-ready";
export const PRIORITY_LABEL = "queue-priority";
/** Marks the members of the running batch; the batcher keeps it in sync every pass. */
export const IN_BATCH_LABEL = "in-batch";
export const VERSION_BRANCH = "changeset-release/main";
/** Deployed history: its migrations may already have run, so they never move. */
export const PRODUCTION_BRANCH = "production";
export const BATCH_PREFIX = "batch/";
export const BUILD_PREFIX = "batch-build/";
export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const MANIFEST_TRAILER = "Batch-Manifest: ";

/** Changes to CI or to the batcher itself are tested and landed alone. */
export const CONTROL_PLANE = [
  /^\.github\//,
  /^scripts\/ci\//,
  /^scripts\/batcher\//,
  // The batcher plans migration renumbering with it.
  /^scripts\/migration-ordinals\.ts$/,
];

/**
 * Directories whose files carry a number that must be unique, such as database
 * migrations. Two changes that add the same number merge cleanly in Git but
 * fail CI together, so the batcher compares numbers before it tests anything. A
 * directory with `renumber` has files the batcher moves to a free number itself.
 */
export const NUMBERED_FILES: {
  directory: string;
  pattern: RegExp;
  fix: (file: string) => string;
  renumber?: true;
}[] = [
  {
    directory: "packages/db/drizzle/",
    pattern: /^(\d+)_[^/]+\.sql$/,
    fix: (file) =>
      `Merge main into the branch and move it to the next free number: \`bun scripts/renumber-migration.ts ${file.replace(/\.sql$/, "")} --next\`.`,
    renumber: true,
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

/** A change's added numbered files whose numbers main already uses for another file. */
export function takenNumbers(
  added: NumberedFile[],
  onMain: NumberedFile[],
): { file: NumberedFile; other: string }[] {
  const taken = new Map(onMain.map((file) => [file.slot, file.path]));
  return added.flatMap((file) => {
    const other = taken.get(file.slot);
    return other === undefined || other === file.path ? [] : [{ file, other }];
  });
}

/** Whether the batcher moves this numbered file to a free number itself. */
export function renumberable(file: NumberedFile): boolean {
  return NUMBERED_FILES.some(
    ({ directory, renumber }) => renumber === true && file.path.startsWith(directory),
  );
}

/**
 * Why a change's added numbered files cannot land on main: the first one whose
 * number main already uses for another file, or null.
 */
export function numberTaken(added: NumberedFile[], onMain: NumberedFile[]): string | null {
  const [first] = takenNumbers(added, onMain);
  if (!first) return null;
  const { file, other } = first;
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const entry = NUMBERED_FILES.find(({ directory }) => file.path.startsWith(directory))!;
  return `\`${name(file.path)}\` uses number ${file.number}, which main already uses for \`${name(other)}\`. ${entry.fix(name(file.path))}`;
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
  /**
   * Why the PR cannot land on main as it is (a Git conflict, a number main
   * already uses, a Version PR whose PR CI failed), or null.
   */
  conflict: string | null;
  /**
   * Added files whose numbers main already uses, which the batcher moves to
   * free numbers on the PR's branch before testing it; empty when none.
   */
  renumber: string[];
  /**
   * It conflicts with main. The batcher merges main into its branch and
   * regenerates the generated files that conflict, or ejects it when other
   * files conflict too; it is not tested meanwhile.
   */
  regenerate: boolean;
  /** Numbered slots its added files use; two members of one batch never share one. */
  slots: string[];
  priority: boolean;
  version: boolean;
  /**
   * A Version PR that main has overtaken in files it also changes. It cannot
   * land as reviewed until it is regenerated; it keeps holding the queue.
   */
  behind: boolean;
  /** A Version PR's head commit time (epoch ms): its notices are looked up from then. */
  headAt?: number;
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
  /**
   * While a failed batch is being bisected: the CI jobs that failed in it, and
   * in the groups bisected before, also after a retry. A group of several PRs
   * failing only in these is split at once instead of being retried, since a
   * retry there almost never passes. Absent outside a bisection.
   */
  blame?: string[];
}

export interface BatchRun {
  id: number;
  workflow: string;
  status: string;
  conclusion: string | null;
  attempt: number;
  url: string;
  /**
   * For a finished run that did not pass: the jobs that failed or timed out in
   * its latest attempt (not the ones cancelled after them); null when GitHub
   * could not list them.
   */
  failedJobs?: string[] | null;
}

export interface Batch {
  branch: string;
  tip: string;
  manifest: Manifest;
  createdAt: number;
  runs: BatchRun[];
  /**
   * Members that pushed a new head whose merge at their place in the candidate
   * gives exactly the tree this batch tests: PR number to that new head.
   */
  sameTree?: Record<number, string>;
}

export interface Observation {
  now: number;
  mainSha: string;
  pulls: QueuedPull[];
  batches: Batch[];
}

export type Action =
  | {
      kind: "abandon";
      batch: Batch;
      reason: string;
      /** The member whose new head or departure from the queue ended the batch. */
      changed?: number;
    }
  | { kind: "retry"; batch: Batch; runs: BatchRun[] }
  | { kind: "land"; batch: Batch }
  | { kind: "eject"; number: number; reason: string }
  | { kind: "renumber"; number: number; paths: string[] }
  | { kind: "regenerate"; number: number }
  | { kind: "build"; members: QueuedPull[]; pending: number[][]; blame?: string[] }
  /** A queued Version PR holds main: nothing else builds until it lands or leaves the queue. */
  | { kind: "hold"; number: number; headSha: string; headAt: number; behind: boolean }
  | { kind: "wait"; until: number };

export type Verdict =
  | { kind: "running" }
  | { kind: "missing" }
  | { kind: "passed" }
  | { kind: "retry"; runs: BatchRun[] }
  /** `repeated`: it failed only in jobs its bisection already blamed, so it was not retried. */
  | { kind: "failed"; runs: BatchRun[]; repeated?: true };

const PASSING = new Set(["success", "skipped", "neutral"]);

/** A finished run that did not pass. */
export function failedRun(run: Pick<BatchRun, "status" | "conclusion">): boolean {
  return run.status === "completed" && !PASSING.has(run.conclusion ?? "");
}

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
  if (failed.every((run) => run.attempt < 2))
    return repeatsBlame(batch, failed)
      ? { kind: "failed", runs: failed, repeated: true }
      : { kind: "retry", runs: failed };
  return { kind: "failed", runs: failed };
}

/**
 * A group of several PRs bisected from a failed batch fails only in jobs that
 * batch already failed also after a retry: retrying it would almost surely
 * fail again. A single PR is always retried before it is ejected, so a flaky
 * job here costs at most one more split, never an innocent PR's place.
 */
function repeatsBlame(batch: Batch, failed: BatchRun[]): boolean {
  const blame = new Set(batch.manifest.blame ?? []);
  if (!blame.size || batch.manifest.members.length < 2) return false;
  return failed.every(
    (run) => !!run.failedJobs?.length && run.failedJobs.every((job) => blame.has(job)),
  );
}

/** The jobs a failed verdict confirms, added to what the bisection blamed before. */
function blamed(before: string[], runs: BatchRun[]): string[] {
  return [...new Set([...before, ...runs.flatMap((run) => run.failedJobs ?? [])])].sort();
}

function fifo(a: QueuedPull, b: QueuedPull) {
  return a.queuedAt - b.queuedAt || a.number - b.number;
}

/** When a PR became ready to batch: queued and green on its current head. */
export function readyAt(pull: QueuedPull): number {
  return Math.max(pull.queuedAt, pull.greenAt ?? Infinity);
}

/**
 * Choose the next batch. A queued Version PR holds the queue: it builds alone
 * once it is green and current with main, and nothing else builds before it
 * lands, so a release operator gets a stable main. Then priority PRs go
 * first, and ready PRs in queue order fill the rest of their batch, so
 * priority PRs that arrive one at a time do not each take a round alone. A
 * failed batch's remaining halves come next; then ready PRs in queue order.
 * CI and batcher changes run alone. A PR already in a failed batch's halves,
 * priority or not, keeps its place there: building it again would retest the
 * batch that just failed, unsplit, on every pass.
 */
export function nextBatch(
  pulls: QueuedPull[],
  pending: number[][],
  now: number,
  settings: Settings,
  blame: string[] = [],
): Action | null {
  const version = pulls.filter((p) => p.version && p.conflict === null).sort(fifo)[0];
  // The batcher never renumbers a Version PR, so green and current is enough.
  if (version)
    return version.greenAt !== null && !version.behind
      ? { kind: "build", members: [version], pending }
      : {
          kind: "hold",
          number: version.number,
          headSha: version.headSha,
          headAt: version.headAt ?? 0,
          behind: version.behind,
        };

  const ready = pulls
    .filter((p) => p.greenAt !== null && p.conflict === null && !p.renumber.length && !p.regenerate)
    .sort(fifo);
  if (!ready.length) return null;
  const alone = (p: QueuedPull) => p.controlPlane;

  const bisecting = new Set(pending.flat());
  const urgent = ready.filter((p) => p.priority && !bisecting.has(p.number));
  if (urgent.length) {
    const first = urgent[0]!;
    if (alone(first)) return { kind: "build", members: [first], pending };
    // Priority PRs first, so a split keeps them in the first half; the oldest
    // ready PRs fill the rest without waiting for the batching window.
    const fill = ready.filter((p) => !p.priority && !bisecting.has(p.number));
    const members = compatible(
      [...urgent, ...fill].filter((p) => !alone(p)),
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
    // Only a group of the bisection is judged against what it blamed; a
    // priority or Version PR in between drops it, which costs only retries.
    const carried = blame.length ? { blame } : {};
    // A member that runs alone goes first; the others stay together, so the
    // group is not tested one member at a time.
    const single = group.find(alone);
    if (single) {
      const others = group.filter((p) => p !== single).map((p) => p.number);
      return {
        kind: "build",
        members: [single],
        pending: others.length ? [others, ...rest] : rest,
        ...carried,
      };
    }
    return { kind: "build", members: group.slice(0, settings.maxBatch), pending: rest, ...carried };
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

/** The running batch: the newest one, as `decide` treats any others as extra. */
export function runningBatch<T extends { createdAt: number }>(batches: T[]): T | undefined {
  return [...batches].sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * Label changes that make the `in-batch` label name exactly the running
 * batch's members, given the PRs that carry it now.
 */
export function inBatchChanges(
  members: number[],
  labelled: number[],
): { add: number[]; remove: number[] } {
  const want = new Set(members);
  const have = new Set(labelled);
  return {
    add: members.filter((n) => !have.has(n)),
    remove: labelled.filter((n) => !want.has(n)),
  };
}

/** Decide everything one pass should do, in order. */
export function decide(observation: Observation, settings: Settings = DEFAULT_SETTINGS): Action[] {
  const { now, mainSha } = observation;
  const actions: Action[] = [];
  let pulls = observation.pulls;
  let pending: number[][] = [];
  let blame: string[] = [];
  const byNumber = new Map(pulls.map((p) => [p.number, p]));

  for (const pull of pulls)
    if (pull.conflict !== null)
      actions.push({ kind: "eject", number: pull.number, reason: pull.conflict });
    else if (pull.regenerate) actions.push({ kind: "regenerate", number: pull.number });
    else if (pull.renumber.length)
      actions.push({ kind: "renumber", number: pull.number, paths: pull.renumber });

  const batch = runningBatch(observation.batches);
  for (const extra of observation.batches.filter((b) => b !== batch))
    actions.push({ kind: "abandon", batch: extra, reason: "only one batch runs at a time" });

  if (batch) {
    const { manifest } = batch;
    const numbers = manifest.members.map((m) => m.number);
    // An interrupted batch is tested again first, keeping any bisection.
    pending = [numbers, ...manifest.pending];
    blame = manifest.blame ?? [];
    // A new head that tests to the same tree (main merged in again, a rebase)
    // changes nothing this batch tests, so it does not restart it.
    const left = manifest.members.find(
      (m) => byNumber.get(m.number)?.headSha !== (batch.sameTree?.[m.number] ?? m.head),
    );
    // A priority PR goes into the next batch; it never cancels a running one.
    let reason: string | null = null;
    let changed: number | undefined;
    if (manifest.base !== mainSha) reason = "main moved since the batch was built";
    else if (left) {
      changed = left.number;
      reason = byNumber.has(left.number)
        ? `#${left.number} has a new head`
        : `#${left.number} left the queue`;
    }
    if (reason)
      actions.push({
        kind: "abandon",
        batch,
        reason,
        ...(changed === undefined ? {} : { changed }),
      });
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
        actions.push({
          kind: "abandon",
          batch,
          reason: result.repeated
            ? "its CI failed only in jobs the batch it was split from failed also after a retry, so it is split without another retry"
            : "its CI failed",
        });
        blame = blamed(blame, result.runs);
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
    blame,
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
      value.pending.some((g) => !Array.isArray(g) || g.some((n) => !Number.isSafeInteger(n))) ||
      (value.blame !== undefined &&
        (!Array.isArray(value.blame) || value.blame.some((job) => typeof job !== "string")))
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
