import { z } from "zod";

export const SESSION_ARCHIVE_MANIFEST_FORMAT = "opengeni.session-archive-manifest" as const;
export const SESSION_ARCHIVE_MANIFEST_VERSION = 1 as const;
export const SESSION_ARCHIVE_MANIFEST_MAX_ROOTS = 100_000;
export const SESSION_ARCHIVE_MANIFEST_MAX_MEMBERS = 1_000_000;

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const DecimalRevision = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "revision must be an unsigned canonical decimal string")
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX, "revision exceeds PostgreSQL bigint");

export const SessionArchiveAction = z.enum(["archive", "unarchive"]);
export type SessionArchiveAction = z.infer<typeof SessionArchiveAction>;

export const SessionArchiveView = z.enum(["live", "archived", "all"]);
export type SessionArchiveView = z.infer<typeof SessionArchiveView>;

export const SessionArchiveChecksum = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "checksum must be sha256:<64 lower-case hex>");
export type SessionArchiveChecksum = z.infer<typeof SessionArchiveChecksum>;

export const SessionArchiveOperationCategory = z.enum([
  "create_child",
  "queue_mutation",
  "send_message",
  "steer",
  "control",
  "turn_claim",
  "attempt_update",
  "event_append",
  "goal_mutation",
  "workflow_wake",
  "child_callback",
  "schedule_fire",
  "job_mutation",
  "sandbox_route",
  "sandbox_lease",
  "sandbox_pty",
  "sandbox_viewer",
  "file_mutation",
  "metadata_mutation",
]);
export type SessionArchiveOperationCategory = z.infer<typeof SessionArchiveOperationCategory>;

export const SessionArchiveDenial = z
  .object({
    code: z.enum(["session_archived", "archived_ancestry"]),
    targetSessionId: z.string().uuid(),
    archivedAncestorSessionId: z.string().uuid(),
    archiveRootSessionId: z.string().uuid(),
    archiveSealId: z.string().uuid(),
    archiveRevision: DecimalRevision,
    operation: SessionArchiveOperationCategory,
    retryable: z.literal(false),
  })
  .strict();
export type SessionArchiveDenial = z.infer<typeof SessionArchiveDenial>;

export const SessionArchiveBlockerCode = z.enum([
  "session_lifecycle_live",
  "turn_unsettled",
  "attempt_unsettled",
  "queue_pending",
  "composer_draft_pending",
  "system_update_pending",
  "child_callback_pending",
  "workflow_wake_pending",
  "goal_active",
  "goal_wake_pending",
  "durable_wait_active",
  "background_job_active",
  "schedule_reuse_active",
  "schedule_fire_pending",
  "sandbox_operation_active",
  "sandbox_viewer_active",
  "sandbox_pty_active",
  "sandbox_lease_exclusive",
  "sandbox_recovery_active",
  "sandbox_route_switch_active",
  "invariant_unproven",
]);
export type SessionArchiveBlockerCode = z.infer<typeof SessionArchiveBlockerCode>;

export const SessionArchiveBlocker = z
  .object({
    code: SessionArchiveBlockerCode,
    sessionId: z.string().uuid(),
    resourceId: z.string().nullable().default(null),
    state: z.string().nullable().default(null),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type SessionArchiveBlocker = z.infer<typeof SessionArchiveBlocker>;

export const SessionArchiveProjection = z
  .object({
    archived: z.boolean(),
    archiveRevision: DecimalRevision,
    activeSealCount: z.number().int().nonnegative(),
    archivedAt: z.string().nullable(),
    nearestFence: z
      .object({
        sessionId: z.string().uuid(),
        rootSessionId: z.string().uuid(),
        sealId: z.string().uuid(),
        archiveRevision: DecimalRevision,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SessionArchiveProjection = z.infer<typeof SessionArchiveProjection>;

export const SessionArchiveManifestMember = z
  .object({
    sessionId: z.string().uuid(),
    parentSessionId: z.string().uuid().nullable(),
    depth: z.number().int().nonnegative().max(10_000),
    expectedArchiveRevision: DecimalRevision,
    expectedArchived: z.boolean(),
  })
  .strict();
export type SessionArchiveManifestMember = z.infer<typeof SessionArchiveManifestMember>;

export const SessionArchiveManifestRoot = z
  .object({
    rootSessionId: z.string().uuid(),
    targetSealId: z.string().uuid().nullable(),
    memberCount: z.number().int().positive().max(SESSION_ARCHIVE_MANIFEST_MAX_MEMBERS),
    members: z.array(SessionArchiveManifestMember).min(1).max(SESSION_ARCHIVE_MANIFEST_MAX_MEMBERS),
  })
  .strict();
export type SessionArchiveManifestRoot = z.infer<typeof SessionArchiveManifestRoot>;

export const SessionArchiveManifest = z
  .object({
    format: z.literal(SESSION_ARCHIVE_MANIFEST_FORMAT),
    version: z.literal(SESSION_ARCHIVE_MANIFEST_VERSION),
    workspaceId: z.string().uuid(),
    action: SessionArchiveAction,
    totalMemberCount: z.number().int().positive().max(SESSION_ARCHIVE_MANIFEST_MAX_MEMBERS),
    roots: z.array(SessionArchiveManifestRoot).min(1).max(SESSION_ARCHIVE_MANIFEST_MAX_ROOTS),
  })
  .strict();
export type SessionArchiveManifest = z.infer<typeof SessionArchiveManifest>;

export type CanonicalSessionArchiveManifest = SessionArchiveManifest;

export const SessionArchivePlanRequest = z
  .object({
    action: SessionArchiveAction,
    roots: z
      .array(
        z
          .object({
            rootSessionId: z.string().uuid(),
            targetSealId: z.string().uuid().nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(SESSION_ARCHIVE_MANIFEST_MAX_ROOTS),
  })
  .strict()
  .superRefine((request, context) => {
    const seenRoots = new Set<string>();
    for (const [index, root] of request.roots.entries()) {
      const rootSessionId = root.rootSessionId.toLowerCase();
      if (seenRoots.has(rootSessionId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate root ${rootSessionId}`,
          path: ["roots", index, "rootSessionId"],
        });
      }
      seenRoots.add(rootSessionId);
      if (request.action === "archive" && root.targetSealId !== null) {
        context.addIssue({
          code: "custom",
          message: "archive plan roots must not name a target seal",
          path: ["roots", index, "targetSealId"],
        });
      }
      if (request.action === "unarchive" && root.targetSealId === null) {
        context.addIssue({
          code: "custom",
          message: "unarchive plan roots must name their target seal",
          path: ["roots", index, "targetSealId"],
        });
      }
    }
  });
export type SessionArchivePlanRequest = z.infer<typeof SessionArchivePlanRequest>;

export const SessionArchivePlanRoot = z
  .object({
    rootSessionId: z.string().uuid(),
    targetSealId: z.string().uuid().nullable(),
    rootChecksum: SessionArchiveChecksum,
    memberCount: z.number().int().positive(),
    canApply: z.boolean(),
    blockers: z.array(SessionArchiveBlocker),
  })
  .strict();
export type SessionArchivePlanRoot = z.infer<typeof SessionArchivePlanRoot>;

export const SessionArchivePlanResponse = z
  .object({
    manifest: SessionArchiveManifest,
    manifestChecksum: SessionArchiveChecksum,
    canApply: z.boolean(),
    roots: z.array(SessionArchivePlanRoot).min(1),
  })
  .strict();
export type SessionArchivePlanResponse = z.infer<typeof SessionArchivePlanResponse>;

export const SessionArchiveApplyRequest = z
  .object({
    /**
     * The full bulk manifest is required until the server has durably
     * registered this exact manifestChecksum. Resumptions may then send null.
     */
    manifest: SessionArchiveManifest.nullable(),
    manifestChecksum: SessionArchiveChecksum,
    rootSessionId: z.string().uuid(),
    rootChecksum: SessionArchiveChecksum,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.manifest !== null &&
      !request.manifest.roots.some(
        (root) => root.rootSessionId.toLowerCase() === request.rootSessionId.toLowerCase(),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "apply rootSessionId must be present in the supplied bulk manifest",
        path: ["rootSessionId"],
      });
    }
  });
export type SessionArchiveApplyRequest = z.infer<typeof SessionArchiveApplyRequest>;

export const SessionArchiveReceiptAuthority = z
  .object({
    /** Authenticated technical caller that submitted the mutation. */
    actorSubjectId: z.string().min(1).max(1024),
    /** Subject whose grant authorized the archive mutation. */
    grantSubjectId: z.string().min(1).max(1024),
    /** Exact permission or policy authority accepted by the server. */
    grantAuthority: z.string().min(1).max(128),
  })
  .strict();
export type SessionArchiveReceiptAuthority = z.infer<typeof SessionArchiveReceiptAuthority>;

export const SessionArchiveReceiptPrecondition = z
  .object({
    /** Apply is permitted only after the locked closure proves zero blockers. */
    blockerCount: z.literal(0),
    memberCount: z.number().int().positive(),
    checksum: SessionArchiveChecksum,
  })
  .strict();
export type SessionArchiveReceiptPrecondition = z.infer<typeof SessionArchiveReceiptPrecondition>;

export const SessionArchiveReceipt = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    action: SessionArchiveAction,
    operationKey: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
    requestHash: SessionArchiveChecksum,
    authority: SessionArchiveReceiptAuthority,
    manifestChecksum: SessionArchiveChecksum,
    rootChecksum: SessionArchiveChecksum,
    rootSessionId: z.string().uuid(),
    /** Seal selected for release; null for archive. */
    targetSealId: z.string().uuid().nullable(),
    /** Seal created by archive; null for unarchive. */
    resultingSealId: z.string().uuid().nullable(),
    /** Compatibility alias for resultingSealId on archive and targetSealId on unarchive. */
    sealId: z.string().uuid(),
    memberCount: z.number().int().positive(),
    precondition: SessionArchiveReceiptPrecondition,
    coverageChecksum: SessionArchiveChecksum,
    committedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.operationKey !== receipt.idempotencyKey) {
      context.addIssue({
        code: "custom",
        message: "operationKey must equal idempotencyKey",
        path: ["operationKey"],
      });
    }
    if (receipt.precondition.memberCount !== receipt.memberCount) {
      context.addIssue({
        code: "custom",
        message: "precondition memberCount must equal receipt memberCount",
        path: ["precondition", "memberCount"],
      });
    }
    if (receipt.action === "archive") {
      if (receipt.targetSealId !== null) {
        context.addIssue({
          code: "custom",
          message: "archive receipt must not name a target seal",
          path: ["targetSealId"],
        });
      }
      if (receipt.resultingSealId === null || receipt.resultingSealId !== receipt.sealId) {
        context.addIssue({
          code: "custom",
          message: "archive receipt sealId must equal its resulting seal",
          path: ["resultingSealId"],
        });
      }
    } else {
      if (receipt.targetSealId === null || receipt.targetSealId !== receipt.sealId) {
        context.addIssue({
          code: "custom",
          message: "unarchive receipt sealId must equal its target seal",
          path: ["targetSealId"],
        });
      }
      if (receipt.resultingSealId !== null) {
        context.addIssue({
          code: "custom",
          message: "unarchive receipt must not name a resulting seal",
          path: ["resultingSealId"],
        });
      }
    }
  });
export type SessionArchiveReceipt = z.infer<typeof SessionArchiveReceipt>;

export const SessionArchiveReceiptMember = z
  .object({
    sessionId: z.string().uuid(),
    parentSessionId: z.string().uuid().nullable(),
    depth: z.number().int().nonnegative(),
    beforeArchiveRevision: DecimalRevision,
    afterArchiveRevision: DecimalRevision,
    beforeArchived: z.boolean(),
    afterArchived: z.boolean(),
  })
  .strict();
export type SessionArchiveReceiptMember = z.infer<typeof SessionArchiveReceiptMember>;

export const SessionArchiveApplyResponse = z
  .object({
    receipt: SessionArchiveReceipt,
    replay: z.boolean(),
    rootArchive: SessionArchiveProjection,
  })
  .strict();
export type SessionArchiveApplyResponse = z.infer<typeof SessionArchiveApplyResponse>;

export const SessionArchiveReceiptEvidence = z
  .object({
    receipt: SessionArchiveReceipt,
    members: z.array(SessionArchiveReceiptMember),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.members.length !== evidence.receipt.memberCount) {
      context.addIssue({
        code: "custom",
        message: "receipt evidence member count differs from its compact receipt",
        path: ["members"],
      });
    }
    let previousSessionId: string | null = null;
    for (const [index, member] of evidence.members.entries()) {
      const sessionId = member.sessionId.toLowerCase();
      if (member.sessionId !== sessionId) {
        context.addIssue({
          code: "custom",
          message: "receipt evidence session IDs must be lower-case",
          path: ["members", index, "sessionId"],
        });
      }
      if (
        member.parentSessionId !== null &&
        member.parentSessionId !== member.parentSessionId.toLowerCase()
      ) {
        context.addIssue({
          code: "custom",
          message: "receipt evidence parent session IDs must be lower-case",
          path: ["members", index, "parentSessionId"],
        });
      }
      if (previousSessionId !== null && previousSessionId >= sessionId) {
        context.addIssue({
          code: "custom",
          message: "receipt evidence members must be uniquely ordered by session ID",
          path: ["members", index, "sessionId"],
        });
      }
      previousSessionId = sessionId;
    }
  });
export type SessionArchiveReceiptEvidence = z.infer<typeof SessionArchiveReceiptEvidence>;

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestError(message: string): never {
  throw new Error(`Invalid session archive manifest: ${message}`);
}

/**
 * Parse and canonicalize a bulk archive manifest.
 *
 * Canonical manifests use lower-case UUIDs, canonical decimal revisions, roots
 * ordered by root UUID, members ordered by session UUID, and an explicit JSON
 * object-key order (see {@link stringifySessionArchiveManifest}). Callers hash
 * only that canonical string. This deliberately avoids timestamps and actor
 * data so the same approved manifest remains replayable across retries.
 */
export function canonicalizeSessionArchiveManifest(
  input: unknown,
): CanonicalSessionArchiveManifest {
  const parsed = SessionArchiveManifest.parse(input);
  const roots = parsed.roots
    .map((root) => ({
      rootSessionId: canonicalUuid(root.rootSessionId),
      targetSealId: root.targetSealId ? canonicalUuid(root.targetSealId) : null,
      memberCount: root.memberCount,
      members: root.members
        .map((member) => ({
          sessionId: canonicalUuid(member.sessionId),
          parentSessionId: member.parentSessionId ? canonicalUuid(member.parentSessionId) : null,
          depth: member.depth,
          expectedArchiveRevision: member.expectedArchiveRevision,
          expectedArchived: member.expectedArchived,
        }))
        .sort((left, right) => compareCanonicalIds(left.sessionId, right.sessionId)),
    }))
    .sort((left, right) => compareCanonicalIds(left.rootSessionId, right.rootSessionId));

  const seenRoots = new Set<string>();
  const seenMembers = new Set<string>();
  let totalMemberCount = 0;
  for (const root of roots) {
    if (seenRoots.has(root.rootSessionId)) {
      manifestError(`duplicate root ${root.rootSessionId}`);
    }
    seenRoots.add(root.rootSessionId);
    if (parsed.action === "archive" && root.targetSealId !== null) {
      manifestError(`archive root ${root.rootSessionId} must not name a target seal`);
    }
    if (parsed.action === "unarchive" && root.targetSealId === null) {
      manifestError(`unarchive root ${root.rootSessionId} must name its target seal`);
    }
    if (root.memberCount !== root.members.length) {
      manifestError(
        `root ${root.rootSessionId} memberCount ${root.memberCount} does not match ${root.members.length} members`,
      );
    }
    const membersById = new Map(root.members.map((member) => [member.sessionId, member]));
    const rootMember = membersById.get(root.rootSessionId);
    if (!rootMember || rootMember.depth !== 0 || rootMember.parentSessionId !== null) {
      manifestError(`root ${root.rootSessionId} must be present at depth 0 with no parent`);
    }
    for (const member of root.members) {
      if (seenMembers.has(member.sessionId)) {
        manifestError(`session ${member.sessionId} appears in more than one root`);
      }
      seenMembers.add(member.sessionId);
      if (member.sessionId !== root.rootSessionId) {
        const parent = member.parentSessionId ? membersById.get(member.parentSessionId) : undefined;
        if (!parent) {
          manifestError(
            `session ${member.sessionId} has parent ${member.parentSessionId ?? "null"} outside root ${root.rootSessionId}`,
          );
        }
        if (parent.depth + 1 !== member.depth) {
          manifestError(
            `session ${member.sessionId} depth ${member.depth} does not follow parent depth ${parent.depth}`,
          );
        }
      }
    }
    totalMemberCount += root.members.length;
  }
  if (parsed.totalMemberCount !== totalMemberCount) {
    manifestError(
      `totalMemberCount ${parsed.totalMemberCount} does not match ${totalMemberCount} members`,
    );
  }

  return {
    format: SESSION_ARCHIVE_MANIFEST_FORMAT,
    version: SESSION_ARCHIVE_MANIFEST_VERSION,
    workspaceId: canonicalUuid(parsed.workspaceId),
    action: parsed.action,
    totalMemberCount,
    roots,
  };
}

/** JSON key order is part of archive-manifest v1's checksum contract. */
export function stringifySessionArchiveManifest(input: unknown): string {
  const manifest = canonicalizeSessionArchiveManifest(input);
  return JSON.stringify({
    format: manifest.format,
    version: manifest.version,
    workspaceId: manifest.workspaceId,
    action: manifest.action,
    totalMemberCount: manifest.totalMemberCount,
    roots: manifest.roots.map((root) => ({
      rootSessionId: root.rootSessionId,
      targetSealId: root.targetSealId,
      memberCount: root.memberCount,
      members: root.members.map((member) => ({
        sessionId: member.sessionId,
        parentSessionId: member.parentSessionId,
        depth: member.depth,
        expectedArchiveRevision: member.expectedArchiveRevision,
        expectedArchived: member.expectedArchived,
      })),
    })),
  });
}
