import type { GitHub } from "./github";
import {
  BATCH_PREFIX,
  BUILD_PREFIX,
  DEFAULT_SETTINGS,
  IN_BATCH_LABEL,
  PRIORITY_LABEL,
  QUEUE_LABEL,
  VERSION_BRANCH,
  decide,
  inBatchChanges,
  isControlPlane,
  numberTaken,
  numberedFiles,
  parseManifest,
  renderManifest,
  runningBatch,
  squashTitle,
  type Action,
  type Batch,
  type Manifest,
  type Member,
  type NumberedFile,
  type Observation,
  type QueuedPull,
  type Settings,
} from "./model";

export const PR_CHECK = "PR CI";
export const PR_WORKFLOW = ".github/workflows/pr-ci.yml";

export const CONFLICTING =
  "it conflicts with main. Merge main into the branch, then queue it again.";

/** File statuses that put a new path on main. */
const ADDED = new Set(["added", "renamed", "copied"]);

export const VERSION_OVERLAP =
  "main changed files this Version PR also changes after it was generated, so it cannot land as reviewed. Run the Open Version PR workflow to regenerate it from current main; do not merge main into it.";

export const IN_BATCH_COLOR = "fbca04";
export const IN_BATCH_DESCRIPTION =
  "In the running merge batch. Don't push or remove queue-ready until it lands or leaves.";

export class LandingMismatch extends Error {}

export interface PassOptions {
  settings?: Settings;
  now?: () => number;
  log?: (line: string) => void;
  randomId?: () => string;
}

interface Context {
  gh: GitHub;
  settings: Settings;
  now: () => number;
  log: (line: string) => void;
  randomId: () => string;
  /** GraphQL node IDs of queued PRs with auto-merge on, for ejection. */
  autoMerge: Map<number, string>;
  /** PRs this pass ejected: their departure is the batcher's doing, not their author's. */
  ejected: Set<number>;
}

function context(gh: GitHub, options: PassOptions): Context {
  return {
    gh,
    settings: options.settings ?? DEFAULT_SETTINGS,
    now: options.now ?? Date.now,
    log: options.log ?? ((line) => console.log(line)),
    randomId: options.randomId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 12)),
    autoMerge: new Map(),
    ejected: new Set(),
  };
}

async function observe(ctx: Context): Promise<Observation> {
  const { gh } = ctx;
  const now = ctx.now();
  const mainSha = await gh.mainSha();
  const pulls: QueuedPull[] = [];
  ctx.autoMerge.clear();
  // Main's numbered files per directory, read once a pass and only when needed.
  const mainNumbered = new Map<string, Promise<NumberedFile[]>>();
  const onMain = (directory: string) => {
    let files = mainNumbered.get(directory);
    if (!files) {
      files = gh.listDirectory(directory.replace(/\/$/, ""), mainSha).then(numberedFiles);
      mainNumbered.set(directory, files);
    }
    return files;
  };
  for (const pull of await gh.queuedPulls(QUEUE_LABEL)) {
    if (pull.draft || !pull.sameRepository) continue;
    if (pull.autoMergeAt !== null) ctx.autoMerge.set(pull.number, pull.id);
    const check = await gh.check(pull.headSha, PR_CHECK);
    const green =
      check?.status === "completed" &&
      check.conclusion === "success" &&
      check.workflow === PR_WORKFLOW &&
      check.runHeadSha === pull.headSha;
    const changed = green ? await gh.pullFiles(pull.number) : [];
    const files = changed?.flatMap((f) => (f.previous ? [f.path, f.previous] : [f.path])) ?? null;
    const added = numberedFiles(
      (changed ?? []).filter((f) => ADDED.has(f.status)).map((f) => f.path),
    );
    let conflict = pull.mergeable === "CONFLICTING" ? CONFLICTING : null;
    for (const directory of new Set(added.map((f) => f.slot.slice(0, f.slot.lastIndexOf("/") + 1))))
      conflict ??= numberTaken(added, await onMain(directory));
    pulls.push({
      number: pull.number,
      title: pull.title,
      headSha: pull.headSha,
      queuedAt: Math.min(
        ...[pull.labeledAt, pull.autoMergeAt].filter((t): t is number => t !== null),
      ),
      greenAt: green ? (check.completedAt ?? now) : null,
      conflict,
      slots: added.map((f) => f.slot),
      priority: pull.labels.includes(PRIORITY_LABEL),
      version: pull.headRef === VERSION_BRANCH,
      // Too many files to list is treated like a CI change: it runs alone.
      controlPlane: files === null || isControlPlane(files),
    });
  }
  const batches: Batch[] = [];
  for (const branch of await gh.branches(BATCH_PREFIX)) {
    const commit = await gh.commit(branch.sha);
    const manifest = parseManifest(commit.message);
    if (!manifest || branch.name !== `${BATCH_PREFIX}${manifest.id}`) {
      ctx.log(`Deleting ${branch.name}: it is not a batch this batcher built`);
      await gh.deleteBranch(branch.name);
      continue;
    }
    batches.push({
      branch: branch.name,
      tip: branch.sha,
      manifest,
      createdAt: commit.date,
      runs: await gh.runs(branch.name, branch.sha),
    });
  }
  return { now, mainSha, pulls, batches };
}

async function eject(ctx: Context, number: number, reason: string) {
  ctx.log(`Ejecting #${number}: ${reason}`);
  ctx.ejected.add(number);
  await ctx.gh.comment(
    number,
    `Removed from the merge queue because ${reason}\n\nFix it, then add the \`${QUEUE_LABEL}\` label again.`,
  );
  await ctx.gh.removeLabel(number, QUEUE_LABEL);
  const autoMerge = ctx.autoMerge.get(number);
  if (autoMerge) await ctx.gh.disableAutoMerge(autoMerge);
}

async function abandon(ctx: Context, batch: Batch, reason: string, changed?: number) {
  ctx.log(`Abandoning ${batch.branch}: ${reason}`);
  for (const ci of batch.runs) if (ci.status !== "completed") await ctx.gh.cancelRun(ci.id);
  await ctx.gh.deleteBranch(batch.branch);
  if (changed !== undefined && !ctx.ejected.has(changed))
    await tellChanged(ctx, batch.manifest, reason, changed);
}

/** Show whoever changed a member what that cost. Best effort: never fails the pass. */
async function tellChanged(ctx: Context, manifest: Manifest, reason: string, changed: number) {
  const others = manifest.members.filter((m) => m.number !== changed).map((m) => `#${m.number}`);
  const restarted = others.length
    ? ` It restarted CI for ${others.join(", ")}, which are tested again without this PR.`
    : "";
  try {
    await ctx.gh.comment(
      changed,
      `Merge batch \`${manifest.id}\` was cancelled because ${reason} while CI was testing it.${restarted}\n\nWhile a PR has the \`${IN_BATCH_LABEL}\` label, don't push to it or remove \`${QUEUE_LABEL}\`. Wait until it lands or the label goes away.`,
    );
  } catch (error) {
    ctx.log(`Could not comment on #${changed}: ${String(error)}`);
  }
}

/**
 * Make the `in-batch` label name exactly the members of the running batch, so
 * people and agents can see which PRs must not change. Runs at the end of
 * every pass; a failure is logged and the next pass tries again.
 */
async function markMembers(ctx: Context) {
  const { gh } = ctx;
  const attempt = async (what: string, call: () => Promise<void>) => {
    try {
      await call();
    } catch (error) {
      ctx.log(`Could not ${what}: ${String(error)}`);
    }
  };
  await attempt(`update the ${IN_BATCH_LABEL} label`, async () => {
    const batches: { createdAt: number; manifest: Manifest }[] = [];
    for (const branch of await gh.branches(BATCH_PREFIX)) {
      const commit = await gh.commit(branch.sha);
      const manifest = parseManifest(commit.message);
      if (manifest && branch.name === `${BATCH_PREFIX}${manifest.id}`)
        batches.push({ createdAt: commit.date, manifest });
    }
    const running = runningBatch(batches);
    const members = running?.manifest.members.map((m) => m.number) ?? [];
    const { add, remove } = inBatchChanges(members, await gh.labelled(IN_BATCH_LABEL));
    if (add.length)
      await attempt(`create the ${IN_BATCH_LABEL} label`, () =>
        gh.ensureLabel(IN_BATCH_LABEL, IN_BATCH_COLOR, IN_BATCH_DESCRIPTION),
      );
    for (const number of add) {
      ctx.log(`Marking #${number} ${IN_BATCH_LABEL} (batch ${running!.manifest.id})`);
      await attempt(`mark #${number}`, () => gh.addLabel(number, IN_BATCH_LABEL));
    }
    for (const number of remove) {
      ctx.log(`Unmarking #${number} ${IN_BATCH_LABEL}`);
      await attempt(`unmark #${number}`, () => gh.removeLabel(number, IN_BATCH_LABEL));
    }
  });
}

/**
 * Land each member as one squash commit through GitHub's merge API, so the
 * PR shows as merged. A Version PR keeps a true merge commit for release
 * provenance. Each landed tree must equal the tree CI tested at that point.
 */
async function land(ctx: Context, batch: Batch) {
  const { gh } = ctx;
  const { manifest } = batch;
  const tip = await gh.commit(batch.tip);
  if (tip.tree !== manifest.members.at(-1)!.tree) {
    await abandon(ctx, batch, "its tip is not the candidate it describes");
    return;
  }
  if ((await gh.mainSha()) !== manifest.base) return;
  for (const member of manifest.members) {
    const sha = await gh.mergePull(member.number, {
      sha: member.head,
      method: member.version ? "merge" : "squash",
      ...(member.version ? {} : { title: squashTitle(member) }),
      message: `Batch: ${manifest.id}`,
    });
    const landed = await gh.commit(sha);
    if (landed.tree !== member.tree) {
      const message = `Landed #${member.number} as ${sha} with tree ${landed.tree}, but batch ${manifest.id} tested tree ${member.tree} at that point.`;
      await gh.comment(member.number, `The merge batcher stopped: ${message}`);
      throw new LandingMismatch(message);
    }
    ctx.log(`Landed #${member.number} as ${sha}`);
  }
  await gh.deleteBranch(batch.branch);
}

async function versionOverlaps(gh: GitHub, base: string, head: string): Promise<boolean> {
  const own = await gh.compareFiles(base, head);
  if (!own) return true;
  const main = await gh.compareFiles(own.mergeBase, base);
  if (!main) return true;
  const changed = new Set(main.files);
  return own.files.some((file) => changed.has(file));
}

/**
 * Merge the members onto main on a scratch branch with GitHub's own merge,
 * then publish the tip with its manifest as batch/<id>. That one push starts CI.
 */
async function build(ctx: Context, members: QueuedPull[], pending: number[][]) {
  const { gh } = ctx;
  const base = await gh.mainSha();
  const id = ctx.randomId();
  const scratch = `${BUILD_PREFIX}${id}`;
  const built: Member[] = [];
  let head = base;
  await gh.createBranch(scratch, base);
  try {
    for (const pull of members) {
      if (pull.version && (await versionOverlaps(gh, base, pull.headSha))) {
        await eject(ctx, pull.number, VERSION_OVERLAP);
        continue;
      }
      const result = await gh.mergeInto(
        scratch,
        pull.headSha,
        `Batch ${id}: merge #${pull.number}`,
      );
      if (result.kind === "conflict") {
        if (head === base)
          await eject(
            ctx,
            pull.number,
            "it conflicts with main. Merge main into the branch, then queue it again.",
          );
        else ctx.log(`Deferring #${pull.number}: it conflicts with an earlier PR in this batch`);
        continue;
      }
      head = result.sha;
      built.push({
        number: pull.number,
        title: pull.title,
        head: pull.headSha,
        tree: result.tree,
        ...(pull.version ? { version: true as const } : {}),
      });
    }
    if (!built.length) return;
    const manifest: Manifest = { schemaVersion: 2, id, base, members: built, pending };
    const tip = await gh.createCommit(built.at(-1)!.tree, [head], renderManifest(manifest));
    await gh.createBranch(`${BATCH_PREFIX}${id}`, tip);
    ctx.log(
      `Started batch ${id} on ${base.slice(0, 10)}: ${built.map((m) => `#${m.number}`).join(", ")}`,
    );
  } finally {
    await gh.deleteBranch(scratch);
  }
}

async function act(ctx: Context, action: Action) {
  switch (action.kind) {
    case "abandon":
      return abandon(ctx, action.batch, action.reason, action.changed);
    case "retry":
      for (const ci of action.runs) {
        ctx.log(`Retrying the failed jobs of ${ci.url}`);
        await ctx.gh.rerunFailedJobs(ci.id);
      }
      return;
    case "land":
      return land(ctx, action.batch);
    case "eject":
      return eject(ctx, action.number, action.reason);
    case "build":
      return build(ctx, action.members, action.pending);
    case "wait":
      return;
  }
}

export function describe(action: Action): string {
  switch (action.kind) {
    case "abandon":
      return `abandon ${action.batch.branch}: ${action.reason}`;
    case "retry":
      return `retry failed jobs of ${action.runs.map((r) => r.url).join(", ")}`;
    case "land":
      return `land ${action.batch.branch}: ${action.batch.manifest.members.map((m) => `#${m.number}`).join(", ")}`;
    case "eject":
      return `eject #${action.number}: ${action.reason}`;
    case "build":
      return `build ${action.members.map((m) => `#${m.number}`).join(", ")}${action.pending.length ? ` (then ${JSON.stringify(action.pending)})` : ""}`;
    case "wait":
      return `wait until ${new Date(action.until).toISOString()} to collect more PRs`;
  }
}

/**
 * Observe, decide and act until nothing is left to do now. Waits for the
 * batching window inside the pass when it ends before `deadline`.
 */
export async function run(
  gh: GitHub,
  options: PassOptions & {
    deadline: number;
    dryRun?: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<Action[]> {
  const ctx = context(gh, options);
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const done: Action[] = [];
  for (const branch of await gh.branches(BUILD_PREFIX))
    if (!options.dryRun) await gh.deleteBranch(branch.name);
  try {
    for (let round = 0; round < 20; round++) {
      const actions = decide(await observe(ctx), ctx.settings);
      if (!actions.length) {
        ctx.log("Nothing to do");
        break;
      }
      for (const action of actions) ctx.log(`Plan: ${describe(action)}`);
      if (options.dryRun) return actions;
      let waitUntil: number | null = null;
      for (const action of actions) {
        if (action.kind === "wait") waitUntil = action.until;
        else await act(ctx, action);
        done.push(action);
      }
      if (waitUntil !== null) {
        if (waitUntil > options.deadline) break;
        // Clear the label of an abandoned batch before waiting for a new one.
        await markMembers(ctx);
        await sleep(Math.max(0, waitUntil - ctx.now()) + 1_000);
        continue;
      }
      // Only a landing, an ejection or an abandoned batch can make more work now.
      if (!actions.some((a) => a.kind === "land" || a.kind === "eject" || a.kind === "abandon"))
        break;
    }
  } finally {
    if (!options.dryRun) await markMembers(ctx);
  }
  return done;
}
