import { defineSchema } from "./define-schema";
import { z } from "zod";

const checkpointSelectionFields = () => ({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  sandboxGroupId: z.string().uuid(),
  leaseId: z.string().uuid(),
  routeEpoch: z.number().int().nonnegative(),
  authorityEpoch: z.number().int().positive(),
  leaseEpoch: z.number().int().nonnegative(),
  workspaceGeneration: z.number().int().nonnegative(),
  archiveGeneration: z.number().int().nonnegative(),
  revision: z.string().min(1).max(512),
  capturedAt: z.string().datetime(),
});

/** Public, content-free selection of a registered native checkpoint, offered
 * for human consent. Never include native provider bindings. */
export const SandboxRecoverySelection = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      ...checkpointSelectionFields(),
      artifactId: z.string().uuid(),
    })
    .strict(),
);
export type SandboxRecoverySelection = z.infer<typeof SandboxRecoverySelection>;

/** The checkpoint automatic recovery restores, native or portable. `artifactId`
 * is the registered native checkpoint (Modal), or null for a portable archive,
 * whose bytes are verified against `revision` instead. Only human consent uses
 * {@link SandboxRecoverySelection}, which always names a native checkpoint. */
export const SandboxCheckpointSelection = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      ...checkpointSelectionFields(),
      artifactId: z.string().uuid().nullable(),
    })
    .strict(),
);
export type SandboxCheckpointSelection = z.infer<typeof SandboxCheckpointSelection>;

/** Exact failed/current workspace selection; portable archives need no native
 * checkpoint artifact. Contains no object keys or provider credentials. */
export const SandboxRecoveryTarget = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      sessionId: z.string().uuid(),
      sandboxGroupId: z.string().uuid(),
      leaseId: z.string().uuid(),
      routeEpoch: z.number().int().nonnegative(),
      authorityEpoch: z.number().int().positive(),
      leaseEpoch: z.number().int().nonnegative(),
      workspaceGeneration: z.number().int().nonnegative(),
      archiveGeneration: z.number().int().nonnegative().nullable(),
      revision: z.string().min(1).max(512).nullable(),
      restoreStatus: z.string().min(1).max(64),
      restoreCompletedAt: z.string().datetime().nullable(),
    })
    .strict(),
);
export type SandboxRecoveryTarget = z.infer<typeof SandboxRecoveryTarget>;

export const SandboxRecoveryProjection = /* @__PURE__ */ defineSchema(() =>
  z
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
      /** The registered native checkpoint a person can consent to restore, and
       * for an automatic Retry its checkpoint when that one is native. */
      checkpoint: SandboxRecoverySelection.nullable(),
      operationId: z.string().uuid().nullable(),
      target: SandboxRecoveryTarget.optional(),
      retryAvailable: z.boolean().optional(),
      freshWorkspaceAvailable: z.boolean().optional(),
      groupSessionCount: z.number().int().positive().optional(),
      /** Retry may elect a system-selected verified checkpoint; no consent POST. */
      automaticAvailable: z.boolean().optional(),
      /** What an automatic Retry will do: restore `automaticCheckpoint`, or
       * continue on a new empty workspace because no usable checkpoint survived
       * the loss. */
      automaticLane: z.enum(["checkpoint", "fresh_workspace"]).optional(),
      /** The checkpoint an automatic Retry restores (lane `checkpoint`), native
       * or portable. Older readers use `checkpoint`, which is set only when it
       * is native. */
      automaticCheckpoint: SandboxCheckpointSelection.optional(),
      /** For a timed recovery wait: the earliest time a Retry or a new message
       * can let Opengeni decide again. Nothing proceeds by itself before then. */
      availableAt: z.string().datetime().optional(),
    })
    .strict(),
);
export type SandboxRecoveryProjection = z.infer<typeof SandboxRecoveryProjection>;

/** Why a definitively lost managed sandbox continues on an empty workspace. */
export const SandboxFreshWorkspaceReason = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "archive_unavailable",
    "archive_unverified",
    "checkpoint_unrestorable",
    "checkpoint_restore_failed",
    "restore_abandoned",
  ]),
);
export type SandboxFreshWorkspaceReason = z.infer<typeof SandboxFreshWorkspaceReason>;

/** Durable, content-free fresh-workspace decision for one group member. */
export const SandboxFreshWorkspaceRecovery = /* @__PURE__ */ defineSchema(() =>
  z
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
    .strict(),
);
export type SandboxFreshWorkspaceRecovery = z.infer<typeof SandboxFreshWorkspaceRecovery>;

export const SandboxRecoveryRequest = /* @__PURE__ */ defineSchema(() =>
  z.union([
    z
      .object({
        operationId: z.string().uuid(),
        acceptHistoricalCheckpoint: z.literal(true),
        selection: SandboxRecoverySelection,
      })
      .strict(),
    z
      .object({
        operationId: z.string().uuid(),
        action: z.literal("retry"),
        target: SandboxRecoveryTarget,
      })
      .strict(),
    z
      .object({
        operationId: z.string().uuid(),
        action: z.literal("continue_fresh"),
        acceptEmptyWorkspace: z.literal(true),
        target: SandboxRecoveryTarget,
      })
      .strict(),
  ]),
);
export type SandboxRecoveryRequest = z.infer<typeof SandboxRecoveryRequest>;

export const SandboxRecoveryResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      outcome: z.enum(["accepted", "replayed"]),
      operationId: z.string().uuid(),
      recovery: SandboxRecoveryProjection,
    })
    .strict(),
);
export type SandboxRecoveryResponse = z.infer<typeof SandboxRecoveryResponse>;

/** Re-injected from durable receipts on every attempt, not lossy transcript state. */
export function sandboxRecoveryDiscontinuity(selection: SandboxRecoverySelection): string {
  return `Filesystem discontinuity: the human explicitly consented to restoring this session's workspace from the checkpoint captured at ${selection.capturedAt} (archive generation ${selection.archiveGeneration}, pre-recovery workspace generation ${selection.workspaceGeneration}). Newer filesystem changes are unavailable. The generation gap is not a count of lost files or edits. Conversation and tool receipts remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the current filesystem before relying on previous work. Never automatically replay prior commands or operations with unknown outcomes to rebuild missing files. Consent alone is not proof that restoration succeeded.`;
}

/** Stable tail instructions, sourced from a durable system recovery receipt.
 * `shared` names the sandbox this session shares with other sessions; every
 * member of that group receives its own receipt for the same selection. */
export function automaticSandboxRecoveryDiscontinuity(
  selection: SandboxCheckpointSelection,
  scope: "session" | "shared" = "session",
): string {
  const subject =
    scope === "shared"
      ? "the latest verified checkpoint of the sandbox this session shares with other sessions"
      : "this session's latest verified checkpoint";
  return `Filesystem discontinuity: after the managed sandbox was lost, Opengeni selected ${subject}, captured at ${selection.capturedAt} (archive generation ${selection.archiveGeneration}, pre-recovery workspace generation ${selection.workspaceGeneration}). Newer filesystem changes may be unavailable; the generation gap is not a count of lost files or edits. Conversation and tool receipts remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the restored filesystem before relying on previous work. Never automatically replay prior commands or operations with unknown outcomes. Checkpoint selection alone is not proof that restoration succeeded.`;
}

/** Stable tail instructions for continuing on a new empty workspace. The text
 * is true on every later turn too: it names the loss, not the current tree. */
export function freshWorkspaceSandboxRecoveryDiscontinuity(
  recovery: SandboxFreshWorkspaceRecovery,
): string {
  if (recovery.reason === "restore_abandoned") {
    return `Filesystem discontinuity: at ${recovery.lostAt}, an authorized person chose to continue this sandbox group on a new empty workspace after restoration failed. The previous archive is retained for recovery, but its files, repository clones, installed packages and processes are not present in this workspace. Conversation and tool receipts remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the current filesystem before relying on previous work. Recreate what you need deliberately; never automatically replay commands or operations with unknown outcomes. Selection alone does not prove the new workspace is ready.`;
  }
  return `Filesystem discontinuity: the previous managed sandbox was lost at ${recovery.lostAt} and there is no checkpoint Opengeni can restore automatically, so Opengeni continued this session on a new empty workspace. Files, repository clones, installed packages and running processes from before that time are not available in this workspace; do not assume they exist. Anything now in the workspace was created after that loss. Conversation and tool receipts from before it remain historical evidence, not proof that their files still exist. External effects are not undone. Verify the current filesystem before relying on previous work, and recreate what you need deliberately. Never automatically replay prior commands or operations with unknown outcomes.`;
}
