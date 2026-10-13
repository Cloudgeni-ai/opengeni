import { z } from "zod";
import { withRestoredSessionActivityRlsContext, type Database } from "./database";
import { recordRetiredChildNotice, retireInterruptedSessionTurn } from "./index";
import { repairEmptyQueuedSessionProjection } from "./empty-session-queue";

export const INTERRUPTED_TURN_RETIREMENT_MARKER = "-- OPENGENI_INTERRUPTED_TURN_RETIREMENT_STAGE";
export const INTERRUPTED_TURN_RETIREMENT_MIGRATION = "0764_interrupted_turn_recovery.sql";

const manifestSchema = z
  .object({
    operationId: z.uuid(),
    targets: z
      .array(
        z
          .object({
            accountId: z.uuid(),
            workspaceId: z.uuid(),
            sessionId: z.uuid(),
            turnId: z.uuid(),
            workflowId: z.string().min(1).max(255),
            expectedVersion: z.number().int().positive(),
            expectedLastSequence: z.number().int().positive(),
          })
          .strict(),
      )
      .min(0)
      .max(1000),
    emptyQueuedSessions: z
      .array(
        z
          .object({
            accountId: z.uuid(),
            workspaceId: z.uuid(),
            sessionId: z.uuid(),
            expectedLastSequence: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict();
export type InterruptedTurnRetirementManifest = z.infer<typeof manifestSchema>;

/** Operator intent is explicit and private. An ordinary upgrade must never
 * cancel another installation's intentionally resumable paused work. */
export function parseInterruptedTurnRetirementManifest(
  value: unknown,
): InterruptedTurnRetirementManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid interrupted-turn retirement manifest");
  const allTargets = [...parsed.data.targets, ...(parsed.data.emptyQueuedSessions ?? [])];
  if (allTargets.length < 1 || allTargets.length > 1000)
    throw new Error("Invalid interrupted-turn retirement manifest");
  if (new Set(allTargets.map((target) => target.sessionId)).size !== allTargets.length)
    throw new Error("Interrupted-turn retirement targets must name unique sessions");
  return parsed.data;
}

export async function migrateInterruptedTurnRetirement(
  db: Database,
  value?: InterruptedTurnRetirementManifest,
): Promise<void> {
  if (value === undefined) return;
  const manifest = parseInterruptedTurnRetirementManifest(value);
  const ordered = [
    ...manifest.targets.map((target) => ({ ...target, kind: "turn" as const })),
    ...(manifest.emptyQueuedSessions ?? []).map((target) => ({
      ...target,
      kind: "empty" as const,
    })),
  ].sort(
    (a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.sessionId.localeCompare(b.sessionId),
  );
  const workspaces = new Map<string, typeof ordered>();
  for (const target of ordered) {
    const targets = workspaces.get(target.workspaceId) ?? [];
    if (targets[0] && targets[0].accountId !== target.accountId)
      throw new Error("Interrupted-turn retirement workspace has conflicting accounts");
    targets.push(target);
    workspaces.set(target.workspaceId, targets);
  }
  for (const targets of workspaces.values()) {
    await withRestoredSessionActivityRlsContext(db, targets[0]!, async (scoped) => {
      for (const target of targets) {
        if (target.kind === "empty") {
          await repairEmptyQueuedSessionProjection(scoped, {
            ...target,
            operationId: manifest.operationId,
          });
          continue;
        }
        const result = await retireInterruptedSessionTurn(scoped, target.workspaceId, {
          ...target,
          operationId: manifest.operationId,
        });
        if (result.action !== "failed" || result.turnId !== target.turnId)
          throw new Error("Interrupted-turn retirement target changed or is unsafe");
      }
      // A selected child may itself be a selected parent's descendant. First
      // validate and settle every target against the reviewed event cursors;
      // only then append parent receipts, in this same atomic transaction.
      for (const target of targets)
        if (target.kind === "turn")
          await recordRetiredChildNotice(scoped, target.workspaceId, {
            ...target,
            operationId: manifest.operationId,
          });
    });
  }
}
