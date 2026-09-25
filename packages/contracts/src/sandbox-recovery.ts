import { z } from "zod";

/** Public, content-free selection. Never include native provider bindings. */
export const SandboxRecoverySelection = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
    sandboxGroupId: z.string().uuid(),
    leaseId: z.string().uuid(),
    routeEpoch: z.number().int().nonnegative(),
    authorityEpoch: z.number().int().positive(),
    leaseEpoch: z.number().int().nonnegative(),
    workspaceGeneration: z.number().int().nonnegative(),
    archiveGeneration: z.number().int().nonnegative(),
    artifactId: z.string().uuid(),
    revision: z.string().min(1).max(512),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type SandboxRecoverySelection = z.infer<typeof SandboxRecoverySelection>;

export const SandboxRecoveryProjection = z
  .object({
    version: z.literal(1),
    status: z.enum([
      "unsupported",
      "blocked",
      "eligible",
      "consent_accepted",
      "restoring",
      "restored",
    ]),
    reason: z.string().max(128).nullable(),
    checkpoint: SandboxRecoverySelection.nullable(),
    operationId: z.string().uuid().nullable(),
    /** Retry may elect a system-selected verified checkpoint; no consent POST. */
    automaticAvailable: z.boolean().optional(),
  })
  .strict();
export type SandboxRecoveryProjection = z.infer<typeof SandboxRecoveryProjection>;

export const SandboxRecoveryRequest = z
  .object({
    operationId: z.string().uuid(),
    acceptHistoricalCheckpoint: z.literal(true),
    selection: SandboxRecoverySelection,
  })
  .strict();
export type SandboxRecoveryRequest = z.infer<typeof SandboxRecoveryRequest>;

export const SandboxRecoveryResponse = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    operationId: z.string().uuid(),
    recovery: SandboxRecoveryProjection,
  })
  .strict();
export type SandboxRecoveryResponse = z.infer<typeof SandboxRecoveryResponse>;

/** Re-injected from durable receipts on every attempt, not lossy transcript state. */
export function sandboxRecoveryDiscontinuity(selection: SandboxRecoverySelection): string {
  return `Filesystem discontinuity: the human explicitly consented to restoring this session's workspace from the checkpoint captured at ${selection.capturedAt} (archive generation ${selection.archiveGeneration}, pre-recovery workspace generation ${selection.workspaceGeneration}). Newer filesystem changes are unavailable. The generation gap is not a count of lost files or edits. Conversation and tool receipts remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the current filesystem before relying on previous work. Never automatically replay prior commands or operations with unknown outcomes to rebuild missing files. Consent alone is not proof that restoration succeeded.`;
}

/** Stable tail instructions, sourced from a durable system recovery receipt. */
export function automaticSandboxRecoveryDiscontinuity(selection: SandboxRecoverySelection): string {
  return `Filesystem discontinuity: after the managed sandbox was lost, OpenGeni selected this session's latest verified checkpoint captured at ${selection.capturedAt} (archive generation ${selection.archiveGeneration}, pre-recovery workspace generation ${selection.workspaceGeneration}). Newer filesystem changes may be unavailable; the generation gap is not a count of lost files or edits. Conversation and tool receipts remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the restored filesystem before relying on previous work. Never automatically replay prior commands or operations with unknown outcomes. Checkpoint selection alone is not proof that restoration succeeded.`;
}
