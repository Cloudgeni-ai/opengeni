import { sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, type Database } from "./database";

const Target = z.object({
  accountId: z.uuid(),
  workspaceId: z.uuid(),
  sandboxGroupId: z.uuid(),
  leaseId: z.uuid(),
  leaseEpoch: z.number().int().positive(),
  instanceId: z.string().min(1).max(512),
  browserSessionId: z.uuid(),
  controllerGeneration: z.string().min(1).max(256),
  // Absent means the provider-deadline checkpoint (the pre-0705 shape). `idle`
  // saves a browser nobody used for the sandbox idle grace; only the reaper's
  // locked idle decision prepares it (with `idleMs`), workers only continue it.
  reason: z.enum(["provider_deadline", "idle"]).optional(),
  idleMs: z.number().int().min(60_000).optional(),
});
const Claim = z.object({
  operationId: z.uuid(),
  state: z.enum(["prepared", "dispatched", "completed"]),
});
export type BrowserDeadlineCheckpointTarget = z.infer<typeof Target>;
export type BrowserDeadlineCheckpointClaim = z.infer<typeof Claim>;

/** Private, bounded system inventory. It contains no user session authority or profile bytes. */
export async function listBrowserDeadlineCheckpoints(
  db: Database,
  limit = 100,
): Promise<BrowserDeadlineCheckpointTarget[]> {
  const rows = await rawRows<{ target: unknown }>(
    db,
    sql`select target from opengeni_private.list_browser_deadline_checkpoints(${limit}) target`,
  );
  return rows.map((row) => Target.parse(row.target));
}

/** The definer rechecks and locks the exact lease, holder, operation and controller.
 * A provider-deadline checkpoint prepares only after provider rotation is
 * already requested; an idle checkpoint prepares only an active browser unused
 * for `idleMs`. */
export async function browserDeadlineCheckpoint(
  db: Database,
  target: BrowserDeadlineCheckpointTarget,
  options: { prepare?: boolean; touch?: boolean } = {},
): Promise<BrowserDeadlineCheckpointClaim | null> {
  const value = Target.parse(target);
  const [row] = await rawRows<{ claim: unknown }>(
    db,
    sql`select opengeni_private.browser_deadline_checkpoint(
      ${JSON.stringify(value)}::jsonb, ${options.prepare === true}, ${options.touch === true}
    ) as claim`,
  );
  return row?.claim == null ? null : Claim.parse(row.claim);
}
