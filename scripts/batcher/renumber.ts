// Moving a queued PR's migration off a number main already uses, planned from
// file contents read through GitHub's API. Pure: the pass reads and writes.
import {
  MIGRATIONS_DIR,
  formatOrdinal,
  isRewritableTextPath,
  nextFreeOrdinal,
  parseMigrationFile,
  planRenumber,
  selectCompanionTests,
  type MigrationName,
} from "../migration-ordinals";

/** A file at a commit. `text` is null for binary or unreadable content. */
export interface RepoFile {
  text: string | null;
  /** Git file mode, like "100644". */
  mode: string;
  oid: string;
}

/** One entry of a new Git tree on top of a base tree; `sha: null` deletes the path. */
export type TreeEntry =
  | { path: string; mode: string; sha: string | null }
  | { path: string; mode: string; content: string };

export interface MigrationMove {
  from: string;
  to: string;
}

export type MovePlan =
  | { kind: "moved"; moves: MigrationMove[]; entries: TreeEntry[] }
  | { kind: "manual"; reason: string };

const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Git's mode for a symbolic link: its blob is a target path, never rewritten. */
const SYMLINK_MODE = "120000";

/**
 * Move each of `paths` (migrations this PR adds whose numbers main already
 * uses), and every migration in `added` numbered at or above the lowest of
 * them, to the next free numbers in their order, as
 * `scripts/renumber-migration.ts --next` does: rename the SQL file and its
 * companion tests and rewrite references. Moving the later ones too keeps the
 * PR's migrations running in the order its author wrote them. Only the PR's
 * own changed files are read and rewritten, since nothing else can name a
 * migration the PR adds. Anything the tool would leave for a person (a changed
 * text file that could not be read, or a bare number it cannot attribute)
 * makes the plan manual.
 */
export function planMigrationMoves(input: {
  paths: readonly string[];
  /** Every migration this PR adds. */
  added?: readonly string[];
  /** Every file name in the migrations directory at the merged commit. */
  ledger: readonly string[];
  /**
   * Numbers other queued PRs add. A moved migration goes above them too, so it
   * does not collide again when they land first; skipping numbers is harmless.
   */
  reserved?: readonly number[];
  /** Every path the PR changes that is still there at the merged commit. */
  changed?: readonly string[];
  /** The PR's changed files as they are at the merged commit. */
  files: ReadonlyMap<string, RepoFile>;
}): MovePlan {
  const reservedAbove = Math.max(-1, ...(input.reserved ?? [])) + 1;
  let ledger = input.ledger
    .map((file) => parseMigrationFile(file))
    .filter((entry): entry is MigrationName => entry !== null);
  const rewritable = (path: string, file: RepoFile) =>
    file.text !== null && file.mode !== SYMLINK_MODE && isRewritableTextPath(path);
  for (const path of input.changed ?? []) {
    const file = input.files.get(path);
    if (isRewritableTextPath(path) && (!file || (file.mode !== SYMLINK_MODE && file.text === null)))
      return { kind: "manual", reason: `\`${name(path)}\` could not be read as text.` };
  }
  const texts = new Map<string, string>();
  for (const [path, file] of input.files) if (rewritable(path, file)) texts.set(path, file.text!);
  /** Where each current path came from, for its mode and unchanged blob. */
  const origin = new Map([...texts.keys()].map((path) => [path, path]));
  const moves: MigrationMove[] = [];
  const ordinal = (path: string) => Number(parseMigrationFile(path)?.ordinal ?? Number.NaN);
  const lowest = Math.min(...input.paths.map(ordinal));
  const moving = [
    ...new Set([...input.paths, ...(input.added ?? []).filter((path) => ordinal(path) >= lowest)]),
  ].sort((a, b) => ordinal(a) - ordinal(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of moving) {
    const from = parseMigrationFile(path);
    if (!from || path !== `${MIGRATIONS_DIR}/${from.file}`)
      return { kind: "manual", reason: `\`${name(path)}\` is not a migration file name.` };
    if (!texts.has(path))
      return { kind: "manual", reason: `\`${name(path)}\` could not be read as text.` };
    const siblings = ledger.filter((entry) => entry.ordinal === from.ordinal);
    const plan = planRenumber({
      from,
      toOrdinal: formatOrdinal(Math.max(Number(nextFreeOrdinal(ledger)), reservedAbove)),
      files: texts,
      companionTests: selectCompanionTests(texts, from, siblings),
    });
    if (plan.unrewrittenBare.length)
      return {
        kind: "manual",
        reason: `${plan.unrewrittenBare.map((p) => `\`${p}\``).join(", ")} mentions ${from.ordinal} without naming \`${from.basename}\`, so the batcher cannot tell which migration it means.`,
      };
    for (const rename of plan.renames) {
      const text = texts.get(rename.from)!;
      texts.delete(rename.from);
      texts.set(rename.to, text);
      origin.set(rename.to, origin.get(rename.from)!);
      origin.delete(rename.from);
    }
    for (const [target, text] of plan.contents) texts.set(target, text);
    ledger = [...ledger.filter((entry) => entry.file !== from.file), plan.to];
    moves.push({ from: path, to: `${MIGRATIONS_DIR}/${plan.to.file}` });
  }
  const entries: TreeEntry[] = [];
  for (const [path, file] of input.files)
    if (rewritable(path, file) && !texts.has(path))
      entries.push({ path, mode: file.mode, sha: null });
  for (const [path, text] of texts) {
    const source = input.files.get(origin.get(path)!)!;
    if (origin.get(path) === path && source.text === text) continue;
    entries.push(
      source.text === text
        ? { path, mode: source.mode, sha: source.oid }
        : { path, mode: source.mode, content: text },
    );
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { kind: "moved", moves, entries };
}
