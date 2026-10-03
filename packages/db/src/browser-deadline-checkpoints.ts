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
 * Preparing is allowed only after provider rotation is already requested. */
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
