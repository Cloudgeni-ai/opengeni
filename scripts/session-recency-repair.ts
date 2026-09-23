/** Operator-only, explicit-ID repair. Never infers that missing events prove inactivity. */
import { readFile } from "node:fs/promises";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { SESSION_EVENT_RAW_DELTA_TYPES } from "@opengeni/contracts";
import {
  createDb,
  lockSessionEventWriteRows,
  withWorkspaceRls,
  rlsContextForWorkspace,
  type Database,
} from "@opengeni/db";
import { withRestoredSessionActivityRlsContext } from "../packages/db/src/database";
import { sql } from "drizzle-orm";
import { z } from "zod";

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const Candidate = z
  .object({
    sessionId: z.string().uuid(),
    expectedUpdatedAt: timestamp,
    expectedRevision: z.string().regex(/^\d+$/),
    expectedSequence: z.number().int().nonnegative(),
    proposedUpdatedAt: timestamp,
  })
  .strict();
export const RecencyRepairManifest = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().uuid(),
    // The operator must independently establish the bookkeeping incident. This is
    // an attestation, not a conclusion inferred from retained event coverage.
    evidence: z.string().min(1).max(2000),
    candidates: z.array(Candidate).min(1).max(50),
  })
  .strict()
  .refine(
    (m) => new Set(m.candidates.map((c) => c.sessionId)).size === m.candidates.length,
    "duplicate session IDs",
  );
export type RecencyRepairPlan = z.infer<typeof RecencyRepairManifest>;

type EvidenceRow = z.infer<typeof Candidate> & { status: string; activeTurnId: string | null };
async function evidence(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<EvidenceRow | null> {
  const rows = await db.execute(sql`
    select s.id as "sessionId", s.status, s.active_turn_id as "activeTurnId",
      to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expectedUpdatedAt",
      s.activity_revision::text as "expectedRevision",
      coalesce(c.last_sequence, s.last_sequence) as "expectedSequence",
      to_char(greatest(s.created_at,
        (select max(e.occurred_at) from session_events e
          where e.workspace_id = s.workspace_id and e.session_id = s.id
            and e.type not in (${sql.join(
              SESSION_EVENT_RAW_DELTA_TYPES.map((t) => sql`${t}`),
              sql`, `,
            )})),
        (select max(greatest(t.started_at, t.finished_at)) from session_turns t
          where t.workspace_id = s.workspace_id and t.session_id = s.id)
      ) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "proposedUpdatedAt"
    from sessions s left join session_event_cursors c
      on c.workspace_id = s.workspace_id and c.session_id = s.id
    where s.workspace_id = ${workspaceId}::uuid and s.id = ${sessionId}::uuid
  `);
  return (rows as unknown as EvidenceRow[])[0] ?? null;
}

export async function previewSessionRecencyRepair(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
  incidentEvidence: string,
): Promise<RecencyRepairPlan> {
  z.string().uuid().parse(workspaceId);
  z.array(z.string().uuid()).min(1).max(50).parse(sessionIds);
  const candidates = [];
  for (const sessionId of sessionIds) {
    const row = await db.transaction(
      async (transaction) => {
        const tx = transaction as unknown as Database;
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        return await withWorkspaceRls(tx, workspaceId, async (scoped) =>
          evidence(scoped, workspaceId, sessionId),
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!row || row.status !== "idle" || row.activeTurnId !== null) {
      throw new Error(`Session ${sessionId} is unavailable or not idle`);
    }
    const { status: _status, activeTurnId: _activeTurnId, ...candidate } = row;
    if (candidate.proposedUpdatedAt >= candidate.expectedUpdatedAt) {
      throw new Error(`Session ${sessionId} has no older reconstruction candidate`);
    }
    candidates.push(candidate);
  }
  return RecencyRepairManifest.parse({
    version: 1,
    workspaceId,
    evidence: incidentEvidence,
    candidates,
  });
}

export async function applySessionRecencyRepair(db: Database, input: RecencyRepairPlan) {
  const plan = RecencyRepairManifest.parse(input);
  const results = [];
  for (const candidate of plan.candidates) {
    const outcome = await db.transaction(async (transaction) => {
      const outer = transaction as unknown as Database;
      // Bound the workspace lookup and tenancy fence as well as the row locks.
      await outer.execute(sql`set local lock_timeout = '5s'`);
      await outer.execute(sql`set local statement_timeout = '10s'`);
      const context = {
        ...(await rlsContextForWorkspace(outer, plan.workspaceId)),
        workspaceId: plan.workspaceId,
      };
      return await withRestoredSessionActivityRlsContext(outer, context, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        // Canonical session + cursor locks serialize semantic and raw event writers.
        await lockSessionEventWriteRows(tx, {
          workspaceId: plan.workspaceId,
          sessionIds: [candidate.sessionId],
          controlLock: "share",
        });
        const current = await evidence(tx, plan.workspaceId, candidate.sessionId);
        if (!current || current.status !== "idle" || current.activeTurnId !== null) return "stale";
        if (current.expectedUpdatedAt === candidate.proposedUpdatedAt) return "already_applied";
        if (
          candidate.proposedUpdatedAt >= candidate.expectedUpdatedAt ||
          current.expectedUpdatedAt !== candidate.expectedUpdatedAt ||
          current.expectedRevision !== candidate.expectedRevision ||
          current.expectedSequence !== candidate.expectedSequence ||
          current.proposedUpdatedAt !== candidate.proposedUpdatedAt
        )
          return "stale";
        await tx.execute(sql`update sessions set updated_at = ${candidate.proposedUpdatedAt}::timestamptz
        where workspace_id = ${plan.workspaceId}::uuid and id = ${candidate.sessionId}::uuid`);
        // The normal outer activity gate advances the revision; never rewind it.
        return "applied";
      });
    });
    results.push({ sessionId: candidate.sessionId, outcome });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const applyPath = value("--apply");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client = createDb(settings.databaseUrl, searchPath ? { searchPath } : {});
  try {
    if (applyPath) {
      const plan = RecencyRepairManifest.parse(JSON.parse(await readFile(applyPath, "utf8")));
      console.log(JSON.stringify(await applySessionRecencyRepair(client.db, plan), null, 2));
    } else {
      const plan = await previewSessionRecencyRepair(
        client.db,
        value("--workspace-id") ?? "",
        (value("--session-ids") ?? "").split(","),
        value("--evidence") ?? "",
      );
      console.log(JSON.stringify(plan, null, 2));
    }
  } finally {
    await client.close();
  }
}
if (import.meta.main) await main();
