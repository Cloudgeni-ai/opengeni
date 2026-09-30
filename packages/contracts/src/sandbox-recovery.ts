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
    /** What an automatic Retry will do: restore `checkpoint`, or continue on a
     * new empty workspace because no usable checkpoint survived the loss. */
    automaticLane: z.enum(["checkpoint", "fresh_workspace"]).optional(),
    /** For a timed recovery wait: the earliest time a Retry or a new message
     * can let OpenGeni decide again. Nothing proceeds by itself before then. */
    availableAt: z.string().datetime().optional(),
  })
  .strict();
export type SandboxRecoveryProjection = z.infer<typeof SandboxRecoveryProjection>;

/** Why a definitively lost managed sandbox continues on an empty workspace. */
export const SandboxFreshWorkspaceReason = z.enum([
  "archive_unavailable",
  "archive_unverified",
  "checkpoint_unrestorable",
  "checkpoint_restore_failed",
]);
export type SandboxFreshWorkspaceReason = z.infer<typeof SandboxFreshWorkspaceReason>;

/** Durable, content-free fresh-workspace decision for one group member. */
export const SandboxFreshWorkspaceRecovery = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
    sandboxGroupId: z.string().uuid(),
    leaseId: z.string().uuid(),
    leaseEpoch: z.number().int().nonnegative(),
    workspaceGeneration: z.number().int().nonnegative(),
    archiveGeneration: z.number().int().nonnegative().nullable(),
    lostAt: z.string().datetime(),
    reason: SandboxFreshWorkspaceReason,
  })
  .strict();
export type SandboxFreshWorkspaceRecovery = z.infer<typeof SandboxFreshWorkspaceRecovery>;

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

/** Stable tail instructions, sourced from a durable system recovery receipt.
 * `shared` names the sandbox this session shares with other sessions; every
 * member of that group receives its own receipt for the same selection. */
export function automaticSandboxRecoveryDiscontinuity(
  selection: SandboxRecoverySelection,
  scope: "session" | "shared" = "session",
): string {
  const subject =
    scope === "shared"
      ? "the latest verified checkpoint of the sandbox this session shares with other sessions"
      : "this session's latest verified checkpoint";
  return `Filesystem discontinuity: after the managed sandbox was lost, OpenGeni selected ${subject}, captured at ${selection.capturedAt} (archive generation ${selection.archiveGeneration}, pre-recovery workspace generation ${selection.workspaceGeneration}). Newer filesystem changes may be unavailable; the generation gap is not a count of lost files or edits. Conversation and tool receipts remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the restored filesystem before relying on previous work. Never automatically replay prior commands or operations with unknown outcomes. Checkpoint selection alone is not proof that restoration succeeded.`;
}

/** Stable tail instructions for continuing on a new empty workspace. The text
 * is true on every later turn too: it names the loss, not the current tree. */
export function freshWorkspaceSandboxRecoveryDiscontinuity(
  recovery: SandboxFreshWorkspaceRecovery,
): string {
  return `Filesystem discontinuity: the previous managed sandbox was lost at ${recovery.lostAt} and there is no checkpoint OpenGeni can restore automatically, so OpenGeni continued this session on a new empty workspace. Files, repository clones, installed packages and running processes from before that time are not available in this workspace; do not assume they exist. Anything now in the workspace was created after that loss. Conversation and tool receipts from before it remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the current filesystem before relying on previous work, and recreate what you need deliberately. Never automatically replay prior commands or operations with unknown outcomes.`;
}
