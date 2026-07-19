import { createHash, timingSafeEqual } from "node:crypto";
import {
  canonicalizeSessionArchiveManifest,
  stringifySessionArchiveManifest,
  type CanonicalSessionArchiveManifest,
  type SessionArchiveManifestRoot,
} from "@opengeni/contracts/session-archive";

export type SessionArchiveChecksum = `sha256:${string}`;

function sha256(value: string): SessionArchiveChecksum {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function sessionArchiveManifestChecksum(input: unknown): SessionArchiveChecksum {
  return sha256(stringifySessionArchiveManifest(input));
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
