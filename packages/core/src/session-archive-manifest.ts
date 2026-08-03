import { createHash, timingSafeEqual } from "node:crypto";
import {
  canonicalizeSessionArchiveManifest,
  SessionArchiveAction,
  SessionArchiveChecksum as SessionArchiveChecksumSchema,
  SessionArchiveReceiptAuthority,
  SessionArchiveReceiptMember,
  stringifySessionArchiveManifest,
  type CanonicalSessionArchiveManifest,
  type SessionArchiveManifestRoot,
} from "@opengeni/contracts/session-archive";

export type SessionArchiveChecksum = `sha256:${string}`;

function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): SessionArchiveChecksum {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

function canonicalIdempotencyKey(value: string): string {
  if (value.length < 1 || value.length > 200) {
    throw new Error("Session archive idempotency key must contain 1-200 characters");
  }
  return value;
}

function canonicalTargetSealId(
  action: SessionArchiveAction,
  targetSealId: string | null,
): string | null {
  if (action === "archive") {
    if (targetSealId !== null) {
      throw new Error("Session archive request must not name a target seal");
    }
    return null;
  }
  if (targetSealId === null) {
    throw new Error("Session unarchive request must name a target seal");
  }
  return canonicalUuid(targetSealId);
}

function canonicalResultingSealId(
  action: SessionArchiveAction,
  resultingSealId: string | null,
): string | null {
  if (action === "archive") {
    if (resultingSealId === null) {
      throw new Error("Session archive receipt must name its resulting seal");
    }
    return canonicalUuid(resultingSealId);
  }
  if (resultingSealId !== null) {
    throw new Error("Session unarchive receipt must not name a resulting seal");
  }
  return null;
}

function canonicalReceiptMembers(input: unknown[]) {
  const members = input
    .map((member) => {
      const parsed = SessionArchiveReceiptMember.parse(member);
      return {
        sessionId: canonicalUuid(parsed.sessionId),
        parentSessionId: parsed.parentSessionId ? canonicalUuid(parsed.parentSessionId) : null,
        depth: parsed.depth,
        beforeArchiveRevision: parsed.beforeArchiveRevision,
        afterArchiveRevision: parsed.afterArchiveRevision,
        beforeArchived: parsed.beforeArchived,
        afterArchived: parsed.afterArchived,
      };
    })
    .sort((left, right) => compareCanonicalIds(left.sessionId, right.sessionId));
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.sessionId)) {
      throw new Error(`Duplicate session archive coverage member ${member.sessionId}`);
    }
    seen.add(member.sessionId);
  }
  return members;
}

function assertCoverageRoot(
  members: ReturnType<typeof canonicalReceiptMembers>,
  rootSessionId: string,
): void {
  const root = members.find((member) => member.sessionId === rootSessionId);
  if (!root || root.depth !== 0) {
    throw new Error(`Session archive coverage must contain root ${rootSessionId} at depth 0`);
  }
}

export function sessionArchiveManifestChecksum(input: unknown): SessionArchiveChecksum {
  return sha256(stringifySessionArchiveManifest(input));
}

export function sessionArchiveRequestHash(input: {
  workspaceId: string;
  action: SessionArchiveAction;
  manifestChecksum: string;
  rootSessionId: string;
  rootChecksum: string;
  targetSealId: string | null;
  idempotencyKey: string;
}): SessionArchiveChecksum {
  const action = SessionArchiveAction.parse(input.action);
  return sha256(
    JSON.stringify({
      format: "opengeni.session-archive-request",
      version: 1,
      workspaceId: canonicalUuid(input.workspaceId),
      action,
      manifestChecksum: SessionArchiveChecksumSchema.parse(input.manifestChecksum),
      rootSessionId: canonicalUuid(input.rootSessionId),
      rootChecksum: SessionArchiveChecksumSchema.parse(input.rootChecksum),
      targetSealId: canonicalTargetSealId(action, input.targetSealId),
      idempotencyKey: canonicalIdempotencyKey(input.idempotencyKey),
    }),
  );
}

export function sessionArchivePreconditionChecksum(input: {
  workspaceId: string;
  action: SessionArchiveAction;
  manifestChecksum: string;
  rootSessionId: string;
  rootChecksum: string;
  targetSealId: string | null;
  blockerCount: number;
  members: unknown[];
}): SessionArchiveChecksum {
  if (input.blockerCount !== 0) {
    throw new Error("Session archive precondition proof requires zero blockers");
  }
  const action = SessionArchiveAction.parse(input.action);
  const rootSessionId = canonicalUuid(input.rootSessionId);
  const members = canonicalReceiptMembers(input.members);
  assertCoverageRoot(members, rootSessionId);
  return sha256(
    JSON.stringify({
      format: "opengeni.session-archive-precondition",
      version: 1,
      workspaceId: canonicalUuid(input.workspaceId),
      action,
      manifestChecksum: SessionArchiveChecksumSchema.parse(input.manifestChecksum),
      rootSessionId,
      rootChecksum: SessionArchiveChecksumSchema.parse(input.rootChecksum),
      targetSealId: canonicalTargetSealId(action, input.targetSealId),
      blockerCount: 0,
      memberCount: members.length,
      members: members.map((member) => ({
        sessionId: member.sessionId,
        parentSessionId: member.parentSessionId,
        depth: member.depth,
        beforeArchiveRevision: member.beforeArchiveRevision,
        beforeArchived: member.beforeArchived,
      })),
    }),
  );
}

export function sessionArchiveCoverageChecksum(input: {
  workspaceId: string;
  action: SessionArchiveAction;
  manifestChecksum: string;
  rootSessionId: string;
  rootChecksum: string;
  targetSealId: string | null;
  resultingSealId: string | null;
  requestHash: string;
  idempotencyKey: string;
  authority: unknown;
  preconditionChecksum: string;
  members: unknown[];
}): SessionArchiveChecksum {
  const workspaceId = canonicalUuid(input.workspaceId);
  const action = SessionArchiveAction.parse(input.action);
  const rootSessionId = canonicalUuid(input.rootSessionId);
  const members = canonicalReceiptMembers(input.members);
  assertCoverageRoot(members, rootSessionId);
  const authority = SessionArchiveReceiptAuthority.parse(input.authority);
  return sha256(
    JSON.stringify({
      format: "opengeni.session-archive-coverage",
      version: 2,
      workspaceId,
      action,
      manifestChecksum: SessionArchiveChecksumSchema.parse(input.manifestChecksum),
      rootSessionId,
      rootChecksum: SessionArchiveChecksumSchema.parse(input.rootChecksum),
      targetSealId: canonicalTargetSealId(action, input.targetSealId),
      resultingSealId: canonicalResultingSealId(action, input.resultingSealId),
      requestHash: SessionArchiveChecksumSchema.parse(input.requestHash),
      idempotencyKey: canonicalIdempotencyKey(input.idempotencyKey),
      authority: {
        actorSubjectId: authority.actorSubjectId,
        grantSubjectId: authority.grantSubjectId,
        grantAuthority: authority.grantAuthority,
      },
      preconditionChecksum: SessionArchiveChecksumSchema.parse(input.preconditionChecksum),
      memberCount: members.length,
      members,
    }),
  );
}

/**
 * Per-root checksum used as the replay key for one atomic root batch. The bulk
 * checksum still binds ordering and exact coverage of the complete manifest.
 */
export function sessionArchiveRootChecksum(
  input: unknown,
  rootSessionId: string,
): SessionArchiveChecksum {
  const manifest = canonicalizeSessionArchiveManifest(input);
  const canonicalRootId = rootSessionId.toLowerCase();
  const root = manifest.roots.find((candidate) => candidate.rootSessionId === canonicalRootId);
  if (!root) {
    throw new Error(`Session archive manifest does not contain root ${rootSessionId}`);
  }
  return sha256(stringifyRootEnvelope(manifest, root));
}

function stringifyRootEnvelope(
  manifest: CanonicalSessionArchiveManifest,
  root: SessionArchiveManifestRoot,
): string {
  return JSON.stringify({
    format: manifest.format,
    version: manifest.version,
    workspaceId: manifest.workspaceId,
    action: manifest.action,
    totalMemberCount: root.memberCount,
    roots: [
      {
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
      },
    ],
  });
}

export function assertSessionArchiveManifestChecksum(
  input: unknown,
  expectedChecksum: string,
): SessionArchiveChecksum {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedChecksum)) {
    throw new Error("Session archive manifest checksum must be sha256:<64 lower-case hex>");
  }
  const actual = sessionArchiveManifestChecksum(input);
  const expectedBytes = Buffer.from(expectedChecksum, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new Error(`Session archive manifest checksum mismatch: expected ${expectedChecksum}`);
  }
  return actual;
}
