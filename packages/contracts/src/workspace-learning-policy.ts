import { z } from "zod";

export const WORKSPACE_LEARNING_POLICY_MAX_SOURCE_OVERRIDES = 256;
export const WORKSPACE_LEARNING_POLICY_SOURCE_KIND_MAX_CHARS = 96;
export const WORKSPACE_LEARNING_POLICY_SOURCE_ID_MAX_CHARS = 1_024;
export const WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS = 4_096;
export const WORKSPACE_LEARNING_POLICY_DEFAULT_OFF_REVISION_ID =
  "workspace-learning-policy:default-off:v1";

export const WorkspaceLearningMode = z.enum(["off", "suggest", "automatic"]);
export type WorkspaceLearningMode = z.infer<typeof WorkspaceLearningMode>;

export const WorkspaceLearningOverrideMode = z.enum(["inherit", "off", "suggest", "automatic"]);
export type WorkspaceLearningOverrideMode = z.infer<typeof WorkspaceLearningOverrideMode>;

export function normalizeWorkspaceLearningSourceKind(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}

export const WorkspaceLearningSourceKind = z
  .string()
  .transform(normalizeWorkspaceLearningSourceKind)
  .pipe(
    z
      .string()
      .min(1)
      .max(WORKSPACE_LEARNING_POLICY_SOURCE_KIND_MAX_CHARS)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
  );
export type WorkspaceLearningSourceKind = z.infer<typeof WorkspaceLearningSourceKind>;

export const WorkspaceLearningSourceId = z
  .string()
  .min(1)
  .max(WORKSPACE_LEARNING_POLICY_SOURCE_ID_MAX_CHARS)
  .refine(
    (value) => value.trim() === value,
    "learning source ids must not contain edge whitespace",
  );
export type WorkspaceLearningSourceId = z.infer<typeof WorkspaceLearningSourceId>;

export const WorkspaceLearningSourceRef = z.object({
  kind: WorkspaceLearningSourceKind,
  id: WorkspaceLearningSourceId,
});
export type WorkspaceLearningSourceRef = z.infer<typeof WorkspaceLearningSourceRef>;

export const WorkspaceLearningSourceOverrideInput = WorkspaceLearningSourceRef.extend({
  mode: WorkspaceLearningOverrideMode,
});
export type WorkspaceLearningSourceOverrideInput = z.infer<
  typeof WorkspaceLearningSourceOverrideInput
>;

export const WorkspaceLearningSourceOverride = WorkspaceLearningSourceRef.extend({
  mode: WorkspaceLearningMode,
});
export type WorkspaceLearningSourceOverride = z.infer<typeof WorkspaceLearningSourceOverride>;

export const WorkspaceLearningSourceOverrides = z
  .array(WorkspaceLearningSourceOverride)
  .max(WORKSPACE_LEARNING_POLICY_MAX_SOURCE_OVERRIDES);
export type WorkspaceLearningSourceOverrides = z.infer<typeof WorkspaceLearningSourceOverrides>;

export function workspaceLearningSourceKey(source: WorkspaceLearningSourceRef): string {
  return `${source.kind}\u0000${source.id}`;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

/**
 * Canonicalize caller input before hashing or persistence. `inherit` is a
 * request-only reset operation: inherited entries are deliberately absent from
 * immutable revisions so the persisted policy stays sparse and transparent.
 */
export function canonicalizeWorkspaceLearningSourceOverrides(
  input: readonly WorkspaceLearningSourceOverrideInput[],
): WorkspaceLearningSourceOverride[] {
  if (input.length > WORKSPACE_LEARNING_POLICY_MAX_SOURCE_OVERRIDES) {
    throw new Error(
      `workspace learning policy supports at most ${WORKSPACE_LEARNING_POLICY_MAX_SOURCE_OVERRIDES} source overrides`,
    );
  }
  const seen = new Set<string>();
  const canonical: WorkspaceLearningSourceOverride[] = [];
  for (const candidate of input) {
    const parsed = WorkspaceLearningSourceOverrideInput.parse(candidate);
    const key = workspaceLearningSourceKey(parsed);
    if (seen.has(key)) {
      throw new Error(`duplicate workspace learning source override: ${parsed.kind}/${parsed.id}`);
    }
    seen.add(key);
    if (parsed.mode !== "inherit") canonical.push(parsed as WorkspaceLearningSourceOverride);
  }
  canonical.sort((left, right) => {
    const kindOrder = compareUtf8(left.kind, right.kind);
    return kindOrder === 0 ? compareUtf8(left.id, right.id) : kindOrder;
  });
  return WorkspaceLearningSourceOverrides.parse(canonical);
}

const revisionIdentityShape = {
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
};

export const WorkspaceLearningPolicyRevisionIdentity = z.object(revisionIdentityShape);
export type WorkspaceLearningPolicyRevisionIdentity = z.infer<
  typeof WorkspaceLearningPolicyRevisionIdentity
>;

export const WorkspaceLearningPolicyRevision = z.object({
  ...revisionIdentityShape,
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  workspaceMode: WorkspaceLearningMode,
  sourceOverrides: WorkspaceLearningSourceOverrides,
  supersedesRevisionId: z.string().uuid().nullable(),
  createdBySubjectId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type WorkspaceLearningPolicyRevision = z.infer<typeof WorkspaceLearningPolicyRevision>;

export const WorkspaceLearningPolicyHead = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revision: z.number().int().positive(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  activationVersion: z.number().int().positive(),
  activatedAt: z.string().datetime(),
});
export type WorkspaceLearningPolicyHead = z.infer<typeof WorkspaceLearningPolicyHead>;

export const WorkspaceLearningPolicyActivationType = z.enum(["activate", "rollback"]);
export type WorkspaceLearningPolicyActivationType = z.infer<
  typeof WorkspaceLearningPolicyActivationType
>;

export const WorkspaceLearningPolicyActivationEvent = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: WorkspaceLearningPolicyActivationType,
  activationVersion: z.number().int().positive(),
  oldRevision: WorkspaceLearningPolicyRevisionIdentity.nullable(),
  newRevision: WorkspaceLearningPolicyRevisionIdentity,
  actorSubjectId: z.string().min(1),
  reason: z.string().min(1).max(WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS),
  createdAt: z.string().datetime(),
});
export type WorkspaceLearningPolicyActivationEvent = z.infer<
  typeof WorkspaceLearningPolicyActivationEvent
>;

export const WorkspaceLearningPolicySnapshot = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  attemptId: z.string().uuid(),
  executionGeneration: z.number().int().positive(),
  revision: WorkspaceLearningPolicyRevisionIdentity.nullable(),
  activationVersion: z.number().int().nonnegative(),
  activatedAt: z.string().datetime().nullable(),
  workspaceMode: WorkspaceLearningMode,
  sourceOverrides: WorkspaceLearningSourceOverrides,
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
});
export type WorkspaceLearningPolicySnapshot = z.infer<typeof WorkspaceLearningPolicySnapshot>;

export const WorkspaceLearningPolicyRouterContext = z.object({
  mode: WorkspaceLearningMode,
  snapshotId: z.string().uuid(),
  revisionId: z.string().min(1).max(512),
});
export type WorkspaceLearningPolicyRouterContext = z.infer<
  typeof WorkspaceLearningPolicyRouterContext
>;

export const WorkspaceLearningPolicyEffectiveMode = WorkspaceLearningPolicyRouterContext.extend({
  inherited: z.boolean(),
  source: WorkspaceLearningSourceRef,
  policyRevision: WorkspaceLearningPolicyRevisionIdentity.nullable(),
  activationVersion: z.number().int().nonnegative(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WorkspaceLearningPolicyEffectiveMode = z.infer<
  typeof WorkspaceLearningPolicyEffectiveMode
>;

/** Stable router seam: resolve only from an immutable accepted-attempt snapshot. */
export function resolveWorkspaceLearningPolicyEffectiveMode(
  snapshot: WorkspaceLearningPolicySnapshot,
  source: WorkspaceLearningSourceRef,
): WorkspaceLearningPolicyEffectiveMode {
  const parsedSnapshot = WorkspaceLearningPolicySnapshot.parse(snapshot);
  const parsedSource = WorkspaceLearningSourceRef.parse(source);
  const override = parsedSnapshot.sourceOverrides.find(
    (candidate) => candidate.kind === parsedSource.kind && candidate.id === parsedSource.id,
  );
  return WorkspaceLearningPolicyEffectiveMode.parse({
    mode: override?.mode ?? parsedSnapshot.workspaceMode,
    inherited: override === undefined,
    source: parsedSource,
    policyRevision: parsedSnapshot.revision,
    activationVersion: parsedSnapshot.activationVersion,
    snapshotId: parsedSnapshot.id,
    revisionId: parsedSnapshot.revision?.id ?? WORKSPACE_LEARNING_POLICY_DEFAULT_OFF_REVISION_ID,
    snapshotHash: parsedSnapshot.snapshotHash,
  });
}

/** Exact provider-neutral context consumed by the canonical durable-learning router. */
export function workspaceLearningPolicyRouterContext(
  effectiveMode: WorkspaceLearningPolicyEffectiveMode,
): WorkspaceLearningPolicyRouterContext {
  return WorkspaceLearningPolicyRouterContext.parse(effectiveMode);
}
