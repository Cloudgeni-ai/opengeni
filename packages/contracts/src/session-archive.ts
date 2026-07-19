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

function canonicalUuid(value: string): string {
  return value.toLowerCase();
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
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    }))
    .sort((left, right) => left.rootSessionId.localeCompare(right.rootSessionId));

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
    if (!rootMember || rootMember.depth !== 0) {
      manifestError(`root ${root.rootSessionId} must be present exactly once at depth 0`);
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
