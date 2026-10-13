import { sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, type Database } from "./database";

/** A locator for already committed native evidence, never caller testimony that
 * a command was absent. SQL reconstructs the two exact closed wire messages and
 * matches their immutable journal hashes under the retained-process lock. */
export const NativeBrokerLaunchRejectionProof = z
  .object({
    requestId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    ownerEpoch: z.number().int().positive().safe(),
    inputSequence: z.number().int().min(1).max(0xffffffff),
    responseSequence: z.number().int().positive().safe(),
  })
  .strict();
export type NativeBrokerLaunchRejectionProof = z.infer<typeof NativeBrokerLaunchRejectionProof>;

export async function requireNativeBrokerLaunchRejection(
  tx: Database,
  scope: { accountId: string; workspaceId: string; sessionId: string; processId: string },
  proof: NativeBrokerLaunchRejectionProof,
): Promise<void> {
  const [row] = await rawRows(
    tx,
    sql`
    select opengeni_private.native_broker_launch_rejection_proven(p, ${JSON.stringify(proof)}::jsonb) as proven
    from sandbox_retained_processes p where p.id = ${scope.processId}::uuid
      and p.account_id = ${scope.accountId}::uuid and p.workspace_id = ${scope.workspaceId}::uuid
      and p.session_id = ${scope.sessionId}::uuid
  `,
  );
  if (row?.proven !== true)
    throw new Error("Native broker launch rejection requires exact committed cancellation proof");
}
