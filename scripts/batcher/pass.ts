import {
  GitHubError,
  isTransientGitHubFailure,
  refusesRetry,
  type CommitSummary,
  type GitHub,
  type PullFile,
} from "./github";
import { MIGRATIONS_DIR } from "../migration-ordinals";
import {
  REGENERATION_ARTIFACT,
  REGENERATION_FILE,
  parseRegeneration,
  type Regeneration,
} from "./regenerate";
import { planMigrationMoves, type TreeEntry } from "./renumber";
import {
  BATCH_PREFIX,
  BUILD_PREFIX,
  DEFAULT_SETTINGS,
  IN_BATCH_LABEL,
  PRIORITY_LABEL,
  PRODUCTION_BRANCH,
  QUEUE_LABEL,
  VERSION_BRANCH,
  decide,
  failedRun,
  inBatchChanges,
  isControlPlane,
  numberTaken,
  numberedFiles,
  parseManifest,
  renumberable,
  renderManifest,
  ownMembers,
  runningBatches,
  squashTitle,
  takenNumbers,
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

export const CONFLICTING = "it conflicts with main";

const code = (path: string) => `\`${path}\``;

/** A conflict regenerating cannot settle, naming the files that conflict. */
export const conflictsIn = (paths: string[]) =>
  `it conflicts with main in ${paths.map(code).join(", ")}`;

export const couldNotRegenerate = (detail: string) =>
  `it conflicts with main and the batcher could not regenerate its generated files: ${detail}`;

/** Marks the one notice per PR head that it conflicts with main and is skipped. */
/**
 * How far a commit's date may run ahead of GitHub's clock (it is set by
 * whoever made the commit) when looking for the notices given about it.
 */
const COMMIT_DATE_SKEW_MS = 24 * 60 * 60_000;
const conflictMarker = (headSha: string) => `<!-- merge-batcher:conflict ${headSha} -->`;

/** File statuses that put a new path on main. */
const ADDED = new Set(["added", "renamed", "copied"]);

export const VERSION_OVERLAP =
  "main changed files this Version PR also changes after it was generated, so it cannot land as reviewed. Run the Open Version PR workflow to regenerate it from current main; do not merge main into it.";

export const VERSION_CI_FAILED =
  "its PR CI failed on its current head, and while a Version PR is queued no other PR builds. Rerun or fix its PR CI, or run the Open Version PR workflow again.";

/** How long a queued Version PR holds main without a PR CI run on its head. */
export const VERSION_CI_DEADLINE_MS = 60 * 60_000;

export const VERSION_CI_MISSING =
  "no PR CI run has passed or is running on its current head within an hour of queueing it, and while a Version PR is queued no other PR builds. Rerun PR CI on its head (or run the Open Version PR workflow again), then queue it again.";

export const VERSION_UNCHECKABLE =
  "it changes too many files to compare with main, so the merge queue cannot tell whether it is current. Land it by hand with the merge batcher off.";

/** Marks the one notice per Version PR head that main has overtaken it. */
const versionBehindMarker = (headSha: string) => `<!-- merge-batcher:version-behind ${headSha} -->`;
/** Marks the one notice per Version PR head that it holds main while its PR CI runs. */
const versionHoldMarker = (headSha: string) => `<!-- merge-batcher:version-hold ${headSha} -->`;
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
  /** Head, branch and changed files of each queued PR whose migration the pass moves. */
  renumbering: Map<number, { headSha: string; headRef: string; files: PullFile[] }>;
  /** Head and branch of each queued PR whose generated files the pass regenerates. */
  regenerating: Map<number, { headSha: string; headRef: string }>;
  /** Numbered slots each queued PR adds, as last observed. */
  queuedSlots: Map<number, string[]>;
  /** Plan only: create no branches, not even scratch ones. */
  dryRun: boolean;
  /**
   * PRs this pass ejected or parked: their departure from a batch is the
   * batcher's doing, not their author's.
   */
  ejected: Set<number>;
  /** Batch runs GitHub refused to run again in this pass, by run ID: their failure is final. */
  unretryable: Set<number>;
}

function context(gh: GitHub, options: PassOptions & { dryRun?: boolean }): Context {
  return {
    gh,
    settings: options.settings ?? DEFAULT_SETTINGS,
    now: options.now ?? Date.now,
    log: options.log ?? ((line) => console.log(line)),
    randomId: options.randomId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 12)),
    autoMerge: new Map(),
    renumbering: new Map(),
    regenerating: new Map(),
    queuedSlots: new Map(),
    dryRun: options.dryRun ?? false,
    ejected: new Set(),
    unretryable: new Set(),
  };
}

async function observe(ctx: Context): Promise<Observation> {
  const { gh } = ctx;
  const now = ctx.now();
  const mainSha = await gh.mainSha();
  const pulls: QueuedPull[] = [];
  ctx.autoMerge.clear();
  ctx.renumbering.clear();
  ctx.regenerating.clear();
  ctx.queuedSlots.clear();
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
    const ownRun = check?.workflow === PR_WORKFLOW && check.runHeadSha === pull.headSha;
    const current = ownRun && check?.status === "completed";
    const green = current && check?.conclusion === "success";
    const version = pull.headRef === VERSION_BRANCH;
    const changed = green ? await gh.pullFiles(pull.number) : [];
    const files = changed?.flatMap((f) => (f.previous ? [f.path, f.previous] : [f.path])) ?? null;
    const added = numberedFiles(
      (changed ?? []).filter((f) => ADDED.has(f.status)).map((f) => f.path),
    );
    const queuedAt = Math.min(
      ...[pull.labeledAt, pull.autoMergeAt].filter((t): t is number => t !== null),
    );
    // A Version PR is regenerated, never merged with main. A Git conflict
    // means main changed a file it also changes, so the overlap check below
    // holds it for a regenerate instead of ejecting it.
    // Any other conflict may be only in generated files, which the batcher
    // regenerates; never on a production branch, which only lands as it is,
    // nor for a member of the running batch, whose branch it must not move.
    // What regenerating cannot settle parks the PR: it keeps its label and is
    // skipped until a new head merges main cleanly. A head it was told about
    // is not regenerated again.
    const conflicting = pull.mergeable === "CONFLICTING" && !version;
    let parked: QueuedPull["parked"] = null;
    if (conflicting && (await parkNoted(gh, pull.number, pull.headSha)))
      parked = { reason: CONFLICTING, noted: true };
    else if (conflicting && pull.headRef === PRODUCTION_BRANCH)
      parked = { reason: CONFLICTING, noted: false };
    // Leaving the running batch, it is regenerated in the next pass.
    else if (conflicting && pull.labels.includes(IN_BATCH_LABEL))
      parked = { reason: CONFLICTING, noted: false, recheck: true };
    const regenerate = conflicting && parked === null;
    let conflict: string | null = null;
    if (regenerate)
      ctx.regenerating.set(pull.number, { headSha: pull.headSha, headRef: pull.headRef });
    let headAt: number | undefined;
    if (version) {
      headAt = (await gh.commit(pull.headSha)).date;
      // It holds the queue, so it leaves when its PR CI failed, or when no run
      // passed or is running an hour after it was queued (or pushed). A
      // cancelled or skipped run is not a failure: a rerun can still pass.
      if (current && (check?.conclusion === "failure" || check?.conclusion === "timed_out"))
        conflict = VERSION_CI_FAILED;
      else if (
        !green &&
        !(ownRun && !current) &&
        now - Math.max(queuedAt, headAt) > VERSION_CI_DEADLINE_MS
      )
        conflict = VERSION_CI_MISSING;
    }
    const renumber: string[] = [];
    // Numbers are compared once the conflict is settled, on the new head.
    for (const directory of new Set(
      conflicting ? [] : added.map((f) => f.slot.slice(0, f.slot.lastIndexOf("/") + 1)),
    )) {
      const main = await onMain(directory);
      const taken = takenNumbers(added, main);
      // A Git conflict needs a person anyway; otherwise the batcher moves what
      // it can, never on a release or production branch.
      if (
        pull.mergeable !== "CONFLICTING" &&
        changed !== null &&
        pull.headRef !== VERSION_BRANCH &&
        pull.headRef !== PRODUCTION_BRANCH &&
        taken.every(({ file }) => renumberable(file))
      )
        renumber.push(...taken.map(({ file }) => file.path));
      else conflict ??= numberTaken(added, main);
    }
    if (conflict === null && renumber.length && changed !== null)
      ctx.renumbering.set(pull.number, {
        headSha: pull.headSha,
        headRef: pull.headRef,
        files: changed,
      });
    // Only a held Version PR is compared: main moves under it only when the
    // batch in flight when it was queued lands.
    let behind = false;
    if (version && conflict === null) {
      const overlaps = await versionOverlaps(gh, mainSha, pull.headSha, pull.number);
      if (overlaps === null) conflict = VERSION_UNCHECKABLE;
      else behind = overlaps;
    }
    pulls.push({
      number: pull.number,
      title: pull.title,
      headSha: pull.headSha,
      queuedAt,
      greenAt: green ? (check?.completedAt ?? now) : null,
      conflict,
      parked: conflict === null ? parked : null,
      renumber: conflict === null ? renumber : [],
      regenerate,
      slots: added.map((f) => f.slot),
      priority: pull.labels.includes(PRIORITY_LABEL),
      version,
      behind,
      ...(headAt === undefined ? {} : { headAt }),
      // Too many files to list is treated like a CI change: it runs alone.
      controlPlane: files === null || isControlPlane(files),
    });
    ctx.queuedSlots.set(
      pull.number,
      added.map((f) => f.slot),
    );
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
    const batch: Batch = {
      branch: branch.name,
      tip: branch.sha,
      manifest,
      createdAt: commit.date,
      runs: (await withFailedJobs(ctx, await gh.runs(branch.name, branch.sha))).map((summary) =>
        ctx.unretryable.has(summary.id) ? { ...summary, final: true as const } : summary,
      ),
    };
    if (manifest.base === mainSha) batch.sameTree = await sameTree(ctx, batch, commit, pulls);
    else if (manifest.stackedOn) batch.parentLanded = await parentLanded(gh, manifest, mainSha);
    batches.push(batch);
  }
  return { now, mainSha, pulls, batches };
}

/**
 * Whether main is exactly the members of the batch this one was built on,
 * landed in order on this batch's base: one first-parent step each, each
 * carrying that batch's landing marker and the tree CI tested at that point.
 */
async function parentLanded(gh: GitHub, manifest: Manifest, mainSha: string): Promise<boolean> {
  const { stackedOn } = manifest;
  if (!stackedOn) return false;
  let sha: string | undefined = mainSha;
  for (let index = stackedOn.count - 1; index >= 0; index--) {
    if (sha === undefined) return false;
    const commit = await gh.commit(sha);
    if (
      commit.tree !== manifest.members[index]!.tree ||
      !commit.message.split("\n").includes(`Batch: ${stackedOn.id}`)
    )
      return false;
    sha = commit.parents[0];
  }
  return sha === manifest.base;
}

/**
 * The failed jobs of each finished run that did not pass, which a bisection
 * blames (see `Manifest.blame`). Not knowing them only means a retry.
 */
async function withFailedJobs(ctx: Context, runs: Batch["runs"]): Promise<Batch["runs"]> {
  return Promise.all(
    runs.map(async (summary) => {
      if (!failedRun(summary)) return summary;
      try {
        return { ...summary, failedJobs: await ctx.gh.failedJobs(summary.id, summary.attempt) };
      } catch (error) {
        ctx.log(`Could not list the failed jobs of ${summary.url}: ${String(error)}`);
        return { ...summary, failedJobs: null };
      }
    }),
  );
}

/**
 * Members that pushed a new head while their batch runs, whose new head merged
 * at the member's place in the candidate gives exactly the tree CI is testing
 * there. Merging the same main into a branch again or rebasing it does that, so
 * the batch carries on and lands the new head instead of starting over. Each
 * check merges on a scratch branch; anything unexpected keeps the old rule. A
 * new head that conflicts or takes a used migration number is never kept: it
 * is parked or ejected. A dry run merges nothing, so it reports every new head.
 */
async function sameTree(
  ctx: Context,
  batch: Batch,
  tip: CommitSummary,
  pulls: QueuedPull[],
): Promise<Record<number, string>> {
  const { gh } = ctx;
  const { manifest } = batch;
  const same: Record<number, string> = {};
  const heads = new Map(
    pulls
      .filter(
        (p) => p.conflict === null && p.parked === null && !p.renumber.length && !p.regenerate,
      )
      .map((p) => [p.number, p.headSha]),
  );
  // Only its own members: the ones it was built on are rechecked in their batch.
  const moved = manifest.members.flatMap((member, index) => {
    const head = heads.get(member.number);
    return index >= (manifest.stackedOn?.count ?? 0) &&
      head !== undefined &&
      head !== member.head &&
      !member.version
      ? [{ member, index, head }]
      : [];
  });
  if (!moved.length || ctx.dryRun) return same;
  // The candidate each member was merged into: walk the tip's first parents
  // back through the members' merge commits to the base.
  const before: string[] = [];
  let sha = tip.parents[0];
  for (let index = manifest.members.length - 1; index >= 0; index--) {
    if (sha === undefined) return same;
    const merge = await gh.commit(sha);
    if (merge.tree !== manifest.members[index]!.tree) return same;
    sha = merge.parents[0];
    before[index] = sha!;
  }
  if (sha !== manifest.base) return same;
  for (const { member, index, head } of moved) {
    const scratch = `${BUILD_PREFIX}${manifest.id}-recheck-${member.number}`;
    try {
      await gh.createBranch(scratch, before[index]!);
      const result = await gh.mergeInto(
        scratch,
        head,
        `Batch ${manifest.id}: recheck #${member.number}`,
      );
      if (result.kind === "merged" && result.tree === member.tree) {
        ctx.log(`#${member.number} has a new head with the tree batch ${manifest.id} tests`);
        same[member.number] = head;
      }
    } catch (error) {
      ctx.log(`Could not recheck #${member.number}'s new head: ${String(error)}`);
    } finally {
      await gh.deleteBranch(scratch);
    }
  }
  return same;
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

/** Whether a PR was already told that this head conflicts with main and is skipped. */
async function parkNoted(gh: GitHub, number: number, headSha: string): Promise<boolean> {
  // A notice for a head is newer than that head, give or take a skewed
  // commit date (a commit's date is set by whoever made it).
  const since = (await gh.commit(headSha)).date - COMMIT_DATE_SKEW_MS;
  const marker = conflictMarker(headSha);
  return (await gh.commentBodies(number, since)).some((body) => body.includes(marker));
}

/**
 * A PR that conflicts with main in a way only its author can settle keeps its
 * label and place in the queue, but is skipped until a new head merges main
 * cleanly and passes PR CI. It is told so once per head, naming what
 * conflicts.
 */
async function park(ctx: Context, number: number, headSha: string, reason: string, recheck?: true) {
  const told = ctx.ejected.has(number);
  ctx.ejected.add(number);
  if (recheck) {
    // Unmarked, so the next pass, with the PR out of the batch, checks it
    // again; this pass tells it once.
    if (told) return;
    ctx.log(`Taking #${number} out of the running batch: ${reason}`);
    await ctx.gh.comment(
      number,
      `The merge queue took this PR out of the running batch because ${reason}. It keeps its \`${QUEUE_LABEL}\` label and its place in the queue. The queue checks it again shortly: it regenerates conflicting generated files itself, and otherwise says which files conflict. You don't need to queue it again.`,
    );
    return;
  }
  if (await parkNoted(ctx.gh, number, headSha)) return;
  ctx.log(`Skipping #${number} until it merges main cleanly: ${reason}`);
  await ctx.gh.comment(
    number,
    `${conflictMarker(headSha)}\nThe merge queue is skipping this PR for now because ${reason}. It keeps its \`${QUEUE_LABEL}\` label and its place in the queue. Merge main into the branch and resolve the conflict: once the new head merges cleanly with main and PR CI passes on it, it is batched automatically. You don't need to queue it again.`,
  );
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
  const others = ownMembers(manifest)
    .filter((m) => m.number !== changed)
    .map((m) => `#${m.number}`);
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
    // The members of the running batch and of the one built on it, if any.
    const { front, stacked } = runningBatches(batches);
    const members = [front, stacked].flatMap((b) =>
      b ? ownMembers(b.manifest).map((m) => m.number) : [],
    );
    const { add, remove } = inBatchChanges(members, await gh.labelled(IN_BATCH_LABEL));
    if (add.length)
      await attempt(`create the ${IN_BATCH_LABEL} label`, () =>
        gh.ensureLabel(IN_BATCH_LABEL, IN_BATCH_COLOR, IN_BATCH_DESCRIPTION),
      );
    for (const number of add) {
      ctx.log(`Marking #${number} ${IN_BATCH_LABEL}`);
      await attempt(`mark #${number}`, () => gh.addLabel(number, IN_BATCH_LABEL));
    }
    for (const number of remove) {
      ctx.log(`Unmarking #${number} ${IN_BATCH_LABEL}`);
      await attempt(`unmark #${number}`, () => gh.removeLabel(number, IN_BATCH_LABEL));
    }
  });
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const slotOf = (path: string) => numberedFiles([path])[0]?.slot ?? path;

/**
 * Main took the number of a migration a queued PR adds. Merge main into the
 * PR's branch and move the migration, and every later one the PR adds so they
 * keep their order, to the next free numbers with their companion tests and
 * references, as `scripts/renumber-migration.ts --next` would, all through
 * GitHub's API: the pass never runs PR code. The PR stays queued and is
 * batched once PR CI passes on its new head. Anything the move cannot settle
 * on its own ejects the PR with the manual command, as before; GitHub being
 * down or throttling, or the network failing, only postpones the move to the
 * next pass. Once the branch is updated, nothing after it ejects the PR.
 */
async function moveMigrations(ctx: Context, number: number, paths: string[]) {
  const manual = (reason: string) =>
    eject(
      ctx,
      number,
      `main already uses the number of ${paths.map((p) => `\`${fileName(p)}\``).join(", ")} and the batcher could not move it: ${reason} Merge main into the branch and move it to the next free number: \`bun scripts/renumber-migration.ts ${fileName(paths[0]!).replace(/\.sql$/, "")} --next\`.`,
    );
  try {
    await tryMoveMigrations(ctx, number, paths, manual);
  } catch (error) {
    if (isTransientGitHubFailure(error)) {
      const detail =
        error instanceof GitHubError ? `GitHub answered ${error.status}` : String(error);
      ctx.log(`Not moving #${number}'s migration this pass: ${detail}`);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await manual(`moving it failed (${detail.slice(0, 300)}).`);
  }
}

async function tryMoveMigrations(
  ctx: Context,
  number: number,
  paths: string[],
  manual: (reason: string) => Promise<void>,
) {
  const { gh } = ctx;
  const pull = ctx.renumbering.get(number);
  if (!pull) return manual("its changed files could not be listed.");
  const mainSha = await gh.mainSha();
  const scratch = `${BUILD_PREFIX}renumber-${number}-${ctx.randomId()}`;
  await gh.createBranch(scratch, pull.headSha);
  try {
    let base = { sha: pull.headSha, tree: (await gh.commit(pull.headSha)).tree };
    const branchPoint = (await gh.compareFiles(mainSha, pull.headSha))?.mergeBase;
    if (branchPoint !== mainSha) {
      const merged = await gh.mergeInto(scratch, mainSha, `Merge main into #${number}`);
      if (merged.kind === "conflict") return await park(ctx, number, pull.headSha, CONFLICTING);
      base = merged;
    }
    const changed = pull.files.filter((f) => f.status !== "removed").map((f) => f.path);
    const added = pull.files
      .filter((f) => ADDED.has(f.status) && f.path.startsWith(`${MIGRATIONS_DIR}/`))
      .map((f) => f.path);
    const reserved = [...ctx.queuedSlots]
      .filter(([other]) => other !== number)
      .flatMap(([, slots]) => slots)
      .filter((slot) => slot.startsWith(`${MIGRATIONS_DIR}/`))
      .map((slot) => Number(slot.slice(MIGRATIONS_DIR.length + 1)));
    const plan = planMigrationMoves({
      paths,
      added,
      ledger: (await gh.listDirectory(MIGRATIONS_DIR, base.sha)).map(fileName),
      reserved,
      changed,
      files: await gh.readFiles(base.sha, changed),
      // Which lines the PR wrote, and what its migration numbers meant then.
      mainFiles: await gh.readFiles(mainSha, changed),
      ...(branchPoint
        ? { branchLedger: (await gh.listDirectory(MIGRATIONS_DIR, branchPoint)).map(fileName) }
        : {}),
    });
    if (plan.kind === "manual") return await manual(plan.reason);
    const moved = plan.moves.map((m) => `\`${fileName(m.from)}\` to \`${fileName(m.to)}\``);
    const tree = await gh.createTree(base.tree, plan.entries);
    const commit = await gh.createCommit(
      tree,
      [base.sha],
      `Move migration ${plan.moves.map((m) => fileName(m.from).replace(/\.sql$/, "")).join(", ")} to the next free number\n\nMain already uses its number. Moved by the merge batcher, as \`scripts/renumber-migration.ts --next\` does.`,
    );
    try {
      // Fast-forward only: if the PR moved meanwhile, the next pass looks again.
      await gh.updateBranch(pull.headRef, commit);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
      const head = await gh.branchHead(pull.headRef);
      if (head !== null && head !== pull.headSha) {
        ctx.log(`Not moving #${number}'s migration: its branch moved meanwhile`);
        return;
      }
      // Refused while the branch stayed put (a ruleset, a protected branch):
      // retrying would fail the same way every pass.
      return await manual("GitHub refused to update its branch.");
    }
    // Later moves this pass go above the new numbers too.
    ctx.queuedSlots.set(number, [
      ...(ctx.queuedSlots.get(number) ?? []).filter(
        (slot) => !plan.moves.some((move) => slotOf(move.from) === slot),
      ),
      ...plan.moves.map((move) => slotOf(move.to)),
    ]);
    ctx.log(`Moved #${number}'s migration ${moved.join(", ")} as ${commit}`);
    // The branch is fixed; a failed note must not eject the PR as unmoved.
    await gh
      .comment(
        number,
        `Main already uses the number of a migration this PR adds, so the merge batcher merged main into the branch and moved ${moved.join(", ")}, with its tests and references (${commit}). The PR stays queued and is batched once PR CI passes on the new head. Pull the branch before you push to it again.`,
      )
      .catch((error: unknown) =>
        ctx.log(`Could not tell #${number} about the move: ${String(error)}`),
      );
  } finally {
    // Leftover scratch branches are removed at the start of every pass.
    await gh
      .deleteBranch(scratch)
      .catch((error: unknown) => ctx.log(`Could not delete ${scratch}: ${String(error)}`));
  }
}

/**
 * A queued PR conflicts with main. Two PRs that both regenerated one generated
 * file conflict there although neither did anything wrong, so before parking
 * it the batcher asks a regeneration run (scripts/ci/regenerate-merge.ts),
 * which merges main and runs the PR's generators with a read-only token. This
 * pass never runs PR code: it checks the run's result and writes it to the
 * branch through GitHub's API as three commits, main's version of the
 * conflicted files, the merge of main, whose tree must be exactly the one the
 * run regenerated on, and the regenerated files. Anything else parks the PR
 * (it keeps its label and is skipped until a new head merges main cleanly),
 * naming the files that conflict; GitHub failing only postpones it a pass.
 */
async function regenerateGenerated(ctx: Context, number: number) {
  const pull = ctx.regenerating.get(number);
  if (!pull) return;
  try {
    await tryRegenerate(ctx, number, pull);
  } catch (error) {
    if (isTransientGitHubFailure(error)) {
      const detail =
        error instanceof GitHubError ? `GitHub answered ${error.status}` : String(error);
      ctx.log(`Not regenerating #${number} this pass: ${detail}`);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await park(ctx, number, pull.headSha, couldNotRegenerate(detail.slice(0, 300)));
  }
}

async function tryRegenerate(
  ctx: Context,
  number: number,
  pull: { headSha: string; headRef: string },
) {
  const { gh } = ctx;
  const mainSha = await gh.mainSha();
  const dispatch = async () => {
    ctx.log(`Regenerating #${number}'s generated files on main ${mainSha.slice(0, 10)}`);
    await gh.dispatchRegeneration(number, pull.headSha, mainSha);
  };
  const [latest] = await gh.regenerations(number, pull.headSha);
  if (!latest) return await dispatch();
  if (latest.status !== "completed") {
    ctx.log(`Waiting for #${number}'s regeneration: ${latest.url}`);
    return;
  }
  if (latest.conclusion !== "success")
    return await park(
      ctx,
      number,
      pull.headSha,
      couldNotRegenerate(`${latest.url} did not succeed`),
    );
  const text = await gh.artifactText(latest.id, REGENERATION_ARTIFACT, REGENERATION_FILE);
  const result = text === null ? null : parseRegeneration(text, number, pull.headSha);
  if (!result)
    return await park(
      ctx,
      number,
      pull.headSha,
      couldNotRegenerate(`${latest.url} left no valid result`),
    );
  if (result.outcome === "conflict")
    return await park(ctx, number, pull.headSha, conflictsIn(result.conflicted));
  if (result.outcome === "clean")
    // Main merged cleanly there; GitHub saw a later main, so ask again on it.
    return result.main === mainSha
      ? await park(ctx, number, pull.headSha, CONFLICTING)
      : await dispatch();
  // The PR's own generators ran in the job that wrote the result, so nothing
  // in it is trusted: the commit it merged must be main or behind it.
  if (
    result.main !== mainSha &&
    (await gh.compareFiles(result.main, mainSha)).mergeBase !== result.main
  )
    return await park(
      ctx,
      number,
      pull.headSha,
      couldNotRegenerate(`${latest.url} merged ${result.main.slice(0, 10)}, which is not on main`),
    );
  await applyRegeneration(ctx, number, pull, result, latest.url);
}

async function applyRegeneration(
  ctx: Context,
  number: number,
  pull: { headSha: string; headRef: string },
  result: Extract<Regeneration, { outcome: "regenerated" }>,
  url: string,
) {
  const { gh } = ctx;
  const listed = result.conflicted.map(code).join(", ");
  const onMain = await gh.readFiles(result.main, result.conflicted);
  const takeMain: TreeEntry[] = result.conflicted.map((path) => {
    const file = onMain.get(path);
    return file ? { path, mode: file.mode, sha: file.oid } : { path, mode: "100644", sha: null };
  });
  const head = await gh.commit(pull.headSha);
  const taken = await gh.createCommit(
    await gh.createTree(head.tree, takeMain),
    [pull.headSha],
    `Take main's ${result.conflicted.join(", ")} before merging main\n\nThe merge batcher regenerates them after the merge.`,
  );
  const scratch = `${BUILD_PREFIX}regenerate-${number}-${ctx.randomId()}`;
  await gh.createBranch(scratch, taken);
  try {
    const merged = await gh.mergeInto(scratch, result.main, `Merge main into #${number}`);
    if (merged.kind === "conflict")
      return await park(ctx, number, pull.headSha, conflictsIn(result.conflicted));
    if (merged.tree !== result.mergedTree)
      return await park(
        ctx,
        number,
        pull.headSha,
        couldNotRegenerate(`GitHub's merge of main differs from the one ${url} regenerated on`),
      );
    const entries: TreeEntry[] = [];
    for (const file of result.files)
      entries.push(
        "deleted" in file
          ? { path: file.path, mode: "100644", sha: null }
          : { path: file.path, mode: file.mode, sha: await gh.createBlob(file.content) },
      );
    const tip = entries.length
      ? await gh.createCommit(
          await gh.createTree(merged.tree, entries),
          [merged.sha],
          `Regenerate ${result.files.map((f) => f.path).join(", ")}\n\nRegenerated by the merge batcher after merging main, with ${result.commands.map(code).join(", ")}.`,
        )
      : merged.sha;
    try {
      // Fast-forward only: if the PR moved meanwhile, the next pass looks again.
      await gh.updateBranch(pull.headRef, tip);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
      const now = await gh.branchHead(pull.headRef);
      if (now !== null && now !== pull.headSha) {
        ctx.log(`Not regenerating #${number}: its branch moved meanwhile`);
        return;
      }
      return await park(
        ctx,
        number,
        pull.headSha,
        couldNotRegenerate("GitHub refused to update its branch"),
      );
    }
    ctx.log(`Regenerated #${number}'s ${result.conflicted.join(", ")} as ${tip}`);
    // The branch is fixed; a failed note must not eject the PR.
    await gh
      .comment(
        number,
        `Main changed generated files this PR also changes, so it conflicted in ${listed}. The merge batcher merged main into the branch, took main's version of them and regenerated them with ${result.commands.map(code).join(", ")} (${tip}, from ${url}). The PR stays queued and is batched once PR CI passes on the new head. Pull the branch before you push to it again.`,
      )
      .catch((error: unknown) =>
        ctx.log(`Could not tell #${number} about the regeneration: ${String(error)}`),
      );
  } finally {
    // Leftover scratch branches are removed at the start of every pass.
    await gh
      .deleteBranch(scratch)
      .catch((error: unknown) => ctx.log(`Could not delete ${scratch}: ${String(error)}`));
  }
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
  // On its base; a batch built on another only on that one landed as tested.
  const main = await gh.mainSha();
  if (manifest.stackedOn ? !(await parentLanded(gh, manifest, main)) : main !== manifest.base)
    return;
  for (const member of ownMembers(manifest)) {
    const sha = await gh.mergePull(member.number, {
      sha: batch.sameTree?.[member.number] ?? member.head,
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

/**
 * Whether main changed files a Version PR also changes since it was generated;
 * null when the PR changes too many files to tell. Main changing too many to
 * list counts as an overlap, which a regenerate settles.
 */
async function versionOverlaps(
  gh: GitHub,
  base: string,
  head: string,
  number: number,
): Promise<boolean | null> {
  const own = await gh.compareFiles(base, head);
  // A release consumes many changesets: past the compare API's 300 files the
  // PR's own paginated file list stands in.
  const ownFiles =
    own.files ??
    (await gh.pullFiles(number))?.flatMap((f) => (f.previous ? [f.path, f.previous] : [f.path])) ??
    null;
  if (ownFiles === null) return null;
  const main = await gh.compareFiles(own.mergeBase, base);
  if (main.files === null) return true;
  const changed = new Set(main.files);
  return ownFiles.some((file) => changed.has(file));
}

/**
 * Merge the members onto main on a scratch branch with GitHub's own merge,
 * then publish the tip with its manifest as batch/<id>. That one push starts CI.
 */
async function build(
  ctx: Context,
  members: QueuedPull[],
  pending: number[][],
  blame: string[] = [],
  aheadOfBisection?: true,
  stackedOn?: Batch,
) {
  const { gh } = ctx;
  const base = await gh.mainSha();
  const id = ctx.randomId();
  const scratch = `${BUILD_PREFIX}${id}`;
  const built: Member[] = [];
  // Built on another batch, it starts from that batch's last merge (its tip
  // without the manifest commit), on the same base, and carries its members.
  let start = base;
  const carried: Member[] = [];
  if (stackedOn) {
    const parentManifest = stackedOn.manifest;
    const tip = await gh.commit(stackedOn.tip);
    const last = tip.parents[0];
    if (
      // It must stand on main: on its base, or on the batch it was built on landed.
      (parentManifest.stackedOn ? stackedOn.parentLanded !== true : parentManifest.base !== base) ||
      last === undefined ||
      tip.tree !== parentManifest.members.at(-1)!.tree ||
      (await gh.commit(last)).tree !== tip.tree
    ) {
      ctx.log(`Not building on batch ${parentManifest.id}: it is not the candidate it describes`);
      return;
    }
    start = last;
    carried.push(...ownMembers(parentManifest));
  }
  let head = start;
  await gh.createBranch(scratch, start);
  try {
    for (const pull of members) {
      // Main moved since this pass observed it; the next pass holds for it.
      if (pull.version) {
        const overlaps = await versionOverlaps(gh, base, pull.headSha, pull.number);
        if (overlaps !== false) {
          ctx.log(
            overlaps
              ? `Not building Version PR #${pull.number}: main changed files it also changes`
              : `Not building Version PR #${pull.number}: it cannot be compared with main`,
          );
          continue;
        }
      }
      const result = await gh.mergeInto(
        scratch,
        pull.headSha,
        `Batch ${id}: merge #${pull.number}`,
      );
      if (result.kind === "conflict") {
        // A Version PR is regenerated, not merged with main: the next pass holds it.
        if (pull.version)
          ctx.log(`Not building Version PR #${pull.number}: it conflicts with main`);
        else if (head === base) await park(ctx, pull.number, pull.headSha, CONFLICTING);
        else
          ctx.log(
            `Deferring #${pull.number}: it conflicts with an earlier PR in this batch or the one it is built on`,
          );
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
    const stacked = stackedOn
      ? { stackedOn: { id: stackedOn.manifest.id, count: carried.length } }
      : {};
    const manifest: Manifest = {
      schemaVersion: 2,
      id,
      base,
      members: [...carried, ...built],
      pending,
      ...(blame.length ? { blame } : {}),
      ...(aheadOfBisection ? { aheadOfBisection } : {}),
      ...stacked,
    };
    const tip = await gh.createCommit(built.at(-1)!.tree, [head], renderManifest(manifest));
    await gh.createBranch(`${BATCH_PREFIX}${id}`, tip);
    ctx.log(
      `Started batch ${id} on ${stackedOn ? `batch ${stackedOn.manifest.id}` : base.slice(0, 10)}: ${built.map((m) => `#${m.number}`).join(", ")}`,
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
      for (const ci of action.runs) await retry(ctx, ci);
      return;
    case "land":
      return land(ctx, action.batch);
    case "eject":
      return eject(ctx, action.number, action.reason);
    case "park":
      return park(ctx, action.number, action.headSha, action.reason, action.recheck);
    case "renumber":
      return moveMigrations(ctx, action.number, action.paths);
    case "regenerate":
      return regenerateGenerated(ctx, action.number);
    case "build":
      return build(
        ctx,
        action.members,
        action.pending,
        action.blame,
        action.aheadOfBisection,
        action.stackedOn,
      );
    case "hold":
      await noteVersionHold(ctx, action);
      return;
    case "wait":
      return;
  }
}

/**
 * Run a failed batch run's failed jobs again. A run that failed before any job
 * started (GitHub could not start the workflow) has none, and GitHub refuses
 * that, so it runs again in full. When GitHub refuses both, the failure is
 * final: the next round judges the batch on it, as for a failed retry.
 */
async function retry(ctx: Context, failed: Batch["runs"][number]) {
  ctx.log(`Retrying the failed jobs of ${failed.url}`);
  try {
    return await ctx.gh.rerunFailedJobs(failed.id);
  } catch (error) {
    if (!refusesRetry(error)) throw error;
  }
  ctx.log(`GitHub cannot retry only the failed jobs of ${failed.url}; running all of it again`);
  try {
    return await ctx.gh.rerunAll(failed.id);
  } catch (error) {
    if (!refusesRetry(error)) throw error;
  }
  ctx.log(`GitHub cannot run ${failed.url} again, so its failure is final`);
  ctx.unretryable.add(failed.id);
}

/**
 * Tell a held Version PR once per head why it holds: that it waits for its
 * PR CI, or that it must be regenerated. A notice for a head can only be
 * newer than that head, so only those comments are read.
 */
async function noteVersionHold(ctx: Context, action: Extract<Action, { kind: "hold" }>) {
  const { number, headSha, headAt, behind } = action;
  const marker = behind ? versionBehindMarker(headSha) : versionHoldMarker(headSha);
  if (
    (await ctx.gh.commentBodies(number, headAt - COMMIT_DATE_SKEW_MS)).some((body) =>
      body.includes(marker),
    )
  )
    return;
  ctx.log(
    behind
      ? `Asking for Version PR #${number} to be regenerated`
      : `Telling Version PR #${number} that it holds main`,
  );
  await ctx.gh.comment(
    number,
    behind
      ? `${marker}\nThe merge queue is holding main for this Version PR, but ${VERSION_OVERLAP} It keeps its place in the queue and lands next.`
      : `${marker}\nThe merge queue is holding main for this Version PR: the batch already running finishes, then nothing else builds until this lands. It builds as soon as PR CI passes on ${headSha.slice(0, 10)}. If no PR CI run passes or is running on it within an hour, it leaves the queue. To land a fix first, remove the queue-ready label from this PR.`,
  );
}

export function describe(action: Action): string {
  switch (action.kind) {
    case "abandon":
      return `abandon ${action.batch.branch}: ${action.reason}`;
    case "retry":
      return `retry failed jobs of ${action.runs.map((r) => r.url).join(", ")}`;
    case "land":
      return `land ${action.batch.branch}: ${ownMembers(action.batch.manifest)
        .map((m) => `#${m.number}`)
        .join(", ")}`;
    case "eject":
      return `eject #${action.number}: ${action.reason}`;
    case "park":
      return `skip #${action.number} until it merges main cleanly: ${action.reason}`;
    case "renumber":
      return `move #${action.number}'s ${action.paths.map(fileName).join(", ")} to the next free number`;
    case "regenerate":
      return `regenerate #${action.number}'s conflicting generated files, or skip it if other files conflict`;
    case "build":
      return `build ${action.members.map((m) => `#${m.number}`).join(", ")}${action.stackedOn ? ` on ${action.stackedOn.branch}` : ""}${action.pending.length ? ` (then ${JSON.stringify(action.pending)})` : ""}${action.blame?.length ? `, bisecting a failure in ${action.blame.join(", ")}` : ""}`;
    case "hold":
      return action.behind
        ? `hold the queue for Version PR #${action.number}: main changed files it also changes, so it waits to be regenerated`
        : `hold the queue for Version PR #${action.number} until PR CI passes on ${action.headSha.slice(0, 10)}`;
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
      const unretryable = ctx.unretryable.size;
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
      // Only a landing, an ejection, an abandoned batch or a run GitHub would
      // not retry (its batch is judged next) can make more work now.
      if (
        !actions.some((a) => a.kind === "land" || a.kind === "eject" || a.kind === "abandon") &&
        ctx.unretryable.size === unretryable
      )
        break;
    }
  } finally {
    if (!options.dryRun) await markMembers(ctx);
  }
  return done;
}
