/**
 * Store timing profiles for finished turns that have none, rebuilt from each
 * turn's session event log. Idempotent and resumable: a turn that already has
 * a profile is skipped, so a run can be stopped and started again at any time.
 * The control maintenance sweep keeps recent turns current on its own; this
 * fills in history.
 *
 * Usage:
 *   bun run db:backfill-turn-timing-profiles [--workspace <uuid>] [--since <iso>] [--until <iso>]
 */
import {
  createDb,
  listWorkspaceIdsAfter,
  recordMissingTurnTimingProfiles,
  type Database,
} from "@opengeni/db";

export type BackfillTurnTimingProfilesArguments = {
  workspaceId: string | null;
  since: Date;
  until: Date;
};

export type BackfillTurnTimingProfilesTotals = {
  workspaces: number;
  turns: number;
  inserted: number;
  updated: number;
  failed: number;
  failedWorkspaces: number;
};

const WORKSPACE_PAGE_SIZE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseBackfillTurnTimingProfilesArguments(
  argv: readonly string[],
  now = new Date(),
): BackfillTurnTimingProfilesArguments {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  const known = new Set(["--workspace", "--since", "--until"]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!known.has(argv[index]!)) throw new Error(`unknown argument: ${argv[index]}`);
  }
  const date = (flag: string, fallback: Date) => {
    const raw = value(flag);
    if (raw === null) return fallback;
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) throw new Error(`${flag} must be an ISO date`);
    return parsed;
  };
  const workspaceId = value("--workspace");
  if (workspaceId !== null && !UUID.test(workspaceId)) {
    throw new Error("--workspace must be a workspace id");
  }
  const since = date("--since", new Date(0));
  const until = date("--until", now);
  if (until <= since) throw new Error("--until must be after --since");
  return { workspaceId, since, until };
}

/** Profile every workspace's missing turns in the window, one workspace at a time. */
export async function backfillTurnTimingProfiles(
  db: Database,
  input: BackfillTurnTimingProfilesArguments,
  dependencies: {
    record?: typeof recordMissingTurnTimingProfiles;
    listWorkspaces?: typeof listWorkspaceIdsAfter;
    log?: (line: Record<string, unknown>) => void;
  } = {},
): Promise<BackfillTurnTimingProfilesTotals> {
  const record = dependencies.record ?? recordMissingTurnTimingProfiles;
  const listWorkspaces = dependencies.listWorkspaces ?? listWorkspaceIdsAfter;
  const log = dependencies.log ?? ((line) => console.log(JSON.stringify(line)));
  const totals: BackfillTurnTimingProfilesTotals = {
    workspaces: 0,
    turns: 0,
    inserted: 0,
    updated: 0,
    failed: 0,
    failedWorkspaces: 0,
  };
  const profileWorkspace = async (workspaceId: string) => {
    totals.workspaces += 1;
    try {
      const pass = await record(db, {
        workspaceId,
        since: input.since,
        until: input.until,
        onError: (error, turnId) =>
          log({
            workspaceId,
            turnId,
            error: error instanceof Error ? error.message : String(error),
          }),
      });
      totals.turns += pass.turns;
      totals.inserted += pass.inserted;
      totals.updated += pass.updated;
      totals.failed += pass.failed;
      if (pass.turns > 0) log({ workspaceId, ...pass });
    } catch (error) {
      totals.failedWorkspaces += 1;
      log({ workspaceId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (input.workspaceId) {
    await profileWorkspace(input.workspaceId);
    return totals;
  }
  let after: string | null = null;
  for (;;) {
    const page = await listWorkspaces(db, { afterId: after, limit: WORKSPACE_PAGE_SIZE });
    for (const workspaceId of page) await profileWorkspace(workspaceId);
    if (page.length < WORKSPACE_PAGE_SIZE) return totals;
    after = page.at(-1)!;
  }
}

async function main(): Promise<void> {
  const input = parseBackfillTurnTimingProfilesArguments(process.argv.slice(2));
  const databaseUrl =
    process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";
  const client = createDb(databaseUrl);
  try {
    const totals = await backfillTurnTimingProfiles(client.db, input);
    console.log(
      JSON.stringify({
        since: input.since.toISOString(),
        until: input.until.toISOString(),
        ...totals,
      }),
    );
    if (totals.failed > 0 || totals.failedWorkspaces > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
