import { describe, expect, test } from "bun:test";
import {
  canonicalizeSessionArchiveManifest,
  type CanonicalSessionArchiveManifest,
  type SessionArchiveApplyRequest,
  type SessionArchiveManifest,
  type SessionArchiveManifestRoot,
  type SessionArchiveReceipt,
  type SessionArchiveReceiptEvidence,
} from "@opengeni/contracts/session-archive";
import {
  sessionArchiveCoverageChecksum,
  sessionArchiveManifestChecksum,
  sessionArchiveRootChecksum,
} from "../src/session-archive-manifest";
import {
  applySessionArchiveBulk,
  validateSessionArchivePlan,
  verifySessionArchiveReceiptEvidence,
  type SessionArchiveOperatorClient,
} from "../src/session-archive-operator";

const workspaceId = "00000000-0000-4000-8000-000000000100";
const rootA = "00000000-0000-4000-8000-000000000010";
const childA = "00000000-0000-4000-8000-000000000011";
const rootB = "00000000-0000-4000-8000-000000000020";
const sealA = "00000000-0000-4000-8000-000000000030";
const sealB = "00000000-0000-4000-8000-000000000031";

function archiveManifest(): CanonicalSessionArchiveManifest {
  return canonicalizeSessionArchiveManifest({
    format: "opengeni.session-archive-manifest",
    version: 1,
    workspaceId,
    action: "archive",
    totalMemberCount: 3,
    roots: [
      {
        rootSessionId: rootB,
        targetSealId: null,
        memberCount: 1,
        members: [
          {
            sessionId: rootB,
            parentSessionId: null,
            depth: 0,
            expectedArchiveRevision: "8",
            expectedArchived: false,
          },
        ],
      },
      {
        rootSessionId: rootA,
        targetSealId: null,
        memberCount: 2,
        members: [
          {
            sessionId: childA,
            parentSessionId: rootA,
            depth: 1,
            expectedArchiveRevision: "11",
            expectedArchived: false,
          },
          {
            sessionId: rootA,
            parentSessionId: null,
            depth: 0,
            expectedArchiveRevision: "4",
            expectedArchived: false,
          },
        ],
      },
    ],
  });
}

function receiptEvidence(input: {
  manifest: CanonicalSessionArchiveManifest;
  root: SessionArchiveManifestRoot;
  receiptId: string;
  sealId: string;
  operationKey: string;
  afterArchived?: boolean;
}): SessionArchiveReceiptEvidence {
  const manifestChecksum = sessionArchiveManifestChecksum(input.manifest);
  const rootChecksum = sessionArchiveRootChecksum(input.manifest, input.root.rootSessionId);
  const members = input.root.members.map((member) => ({
    sessionId: member.sessionId,
    parentSessionId: member.parentSessionId,
    depth: member.depth,
    beforeArchiveRevision: member.expectedArchiveRevision,
    afterArchiveRevision: (BigInt(member.expectedArchiveRevision) + 1n).toString(),
    beforeArchived: member.expectedArchived,
    afterArchived: input.afterArchived ?? input.manifest.action === "archive",
  }));
  const coverageChecksum = sessionArchiveCoverageChecksum({
    workspaceId,
    action: input.manifest.action,
    rootSessionId: input.root.rootSessionId,
    sealId: input.sealId,
    members,
  });
  return {
    receipt: {
      id: input.receiptId,
      workspaceId,
      action: input.manifest.action,
      operationKey: input.operationKey,
      manifestChecksum,
      rootChecksum,
      rootSessionId: input.root.rootSessionId,
      sealId: input.sealId,
      memberCount: input.root.memberCount,
      coverageChecksum,
      committedAt: "2026-07-19T00:00:00.000Z",
    },
    members,
  };
}

function operationKey(manifest: SessionArchiveManifest, root: SessionArchiveManifestRoot): string {
  return `session-archive:${sessionArchiveManifestChecksum(manifest).slice(7)}:${sessionArchiveRootChecksum(manifest, root.rootSessionId).slice(7)}`;
}

function fakeClient(input: {
  manifest: CanonicalSessionArchiveManifest;
  existing?: SessionArchiveReceiptEvidence[];
  mutateEvidence?: (evidence: SessionArchiveReceiptEvidence) => SessionArchiveReceiptEvidence;
}): SessionArchiveOperatorClient & { requests: SessionArchiveApplyRequest[] } {
  const requests: SessionArchiveApplyRequest[] = [];
  const evidenceById = new Map(
    (input.existing ?? []).map((evidence) => [evidence.receipt.id, evidence]),
  );
  return {
    requests,
    async listSessionArchiveReceipts(): Promise<SessionArchiveReceipt[]> {
      return (input.existing ?? []).map((evidence) => evidence.receipt);
    },
    async applySessionArchive(_workspaceId, request): Promise<unknown> {
      requests.push(request);
      const root = input.manifest.roots.find(
        (candidate) => candidate.rootSessionId === request.rootSessionId,
      );
      if (!root) throw new Error("test requested unknown root");
      const index = input.manifest.roots.indexOf(root);
      const evidence = receiptEvidence({
        manifest: input.manifest,
        root,
        receiptId: `00000000-0000-4000-8000-00000000004${index}`,
        sealId: index === 0 ? sealA : sealB,
        operationKey: request.idempotencyKey,
      });
      evidenceById.set(evidence.receipt.id, evidence);
      const rootMember = evidence.members.find(
        (member) => member.sessionId === root.rootSessionId,
      )!;
      return {
        receipt: evidence.receipt,
        replay: false,
        rootArchive: {
          archived: rootMember.afterArchived,
          archiveRevision: rootMember.afterArchiveRevision,
          activeSealCount: 1,
          archivedAt: "2026-07-19T00:00:00.000Z",
          nearestFence: {
            sessionId: root.rootSessionId,
            rootSessionId: root.rootSessionId,
            sealId: evidence.receipt.sealId,
            archiveRevision: rootMember.afterArchiveRevision,
          },
        },
      };
    },
    async getSessionArchiveReceipt(_workspaceId, receiptId): Promise<unknown> {
      const evidence = evidenceById.get(receiptId);
      if (!evidence) throw new Error(`missing test receipt ${receiptId}`);
      return input.mutateEvidence?.(structuredClone(evidence)) ?? evidence;
    },
  };
}

describe("session archive bulk operator", () => {
  test("locally verifies the complete read-only plan instead of trusting the server", () => {
    const manifest = archiveManifest();
    const plan = {
      manifest,
      manifestChecksum: sessionArchiveManifestChecksum(manifest),
      canApply: true,
      roots: manifest.roots.map((root) => ({
        rootSessionId: root.rootSessionId,
        targetSealId: root.targetSealId,
        rootChecksum: sessionArchiveRootChecksum(manifest, root.rootSessionId),
        memberCount: root.memberCount,
        canApply: true,
        blockers: [],
      })),
    };
    const validated = validateSessionArchivePlan(plan);
    expect(validated.manifestChecksum).toBe(plan.manifestChecksum);
    expect(validated.roots.map((root) => root.root.rootSessionId)).toEqual([rootA, rootB]);

    expect(() =>
      validateSessionArchivePlan({ ...plan, manifestChecksum: `sha256:${"f".repeat(64)}` }),
    ).toThrow("checksum mismatch");
    expect(() => validateSessionArchivePlan({ ...plan, canApply: false })).toThrow(
      "bulk canApply disagrees",
    );
    const tampered = structuredClone(plan);
    tampered.roots[0]!.rootChecksum = `sha256:${"e".repeat(64)}`;
    expect(() => validateSessionArchivePlan(tampered)).toThrow(
      "checksum differs from canonical coverage",
    );
  });

  test("registers one bulk manifest, applies roots sequentially, and verifies every receipt", async () => {
    const manifest = archiveManifest();
    const client = fakeClient({ manifest });
    const progress: string[] = [];
    const result = await applySessionArchiveBulk({
      client,
      manifest,
      approvedManifestChecksum: sessionArchiveManifestChecksum(manifest),
      onProgress: ({ rootSessionId }) => progress.push(rootSessionId),
    });

    expect(result).toMatchObject({
      rootCount: 2,
      memberCount: 3,
      appliedRootCount: 2,
      replayedRootCount: 0,
    });
    expect(result.receipts).toHaveLength(2);
    expect(progress).toEqual([rootA, rootB]);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]!.manifest).toEqual(manifest);
    expect(client.requests[1]!.manifest).toBeNull();
    for (const [index, request] of client.requests.entries()) {
      const root = manifest.roots[index]!;
      expect(request).toMatchObject({
        manifestChecksum: sessionArchiveManifestChecksum(manifest),
        rootSessionId: root.rootSessionId,
        rootChecksum: sessionArchiveRootChecksum(manifest, root.rootSessionId),
        idempotencyKey: operationKey(manifest, root),
      });
      expect(request.idempotencyKey.length).toBeLessThanOrEqual(200);
    }
  });

  test("verifies existing receipts, skips committed roots, and resumes without resending the manifest", async () => {
    const manifest = archiveManifest();
    const existing = receiptEvidence({
      manifest,
      root: manifest.roots[0]!,
      receiptId: "00000000-0000-4000-8000-000000000050",
      sealId: sealA,
      operationKey: "another-authorized-operator-key",
    });
    const client = fakeClient({ manifest, existing: [existing] });
    const result = await applySessionArchiveBulk({
      client,
      manifest,
      approvedManifestChecksum: sessionArchiveManifestChecksum(manifest),
    });

    expect(result).toMatchObject({ appliedRootCount: 1, replayedRootCount: 1 });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.rootSessionId).toBe(rootB);
    expect(client.requests[0]!.manifest).toBeNull();
  });

  test("rejects tampered durable evidence before submitting another root", async () => {
    const manifest = archiveManifest();
    const existing = receiptEvidence({
      manifest,
      root: manifest.roots[0]!,
      receiptId: "00000000-0000-4000-8000-000000000051",
      sealId: sealA,
      operationKey: "existing-key",
    });
    existing.receipt.coverageChecksum = `sha256:${"0".repeat(64)}`;
    const client = fakeClient({ manifest, existing: [existing] });

    await expect(
      applySessionArchiveBulk({
        client,
        manifest,
        approvedManifestChecksum: sessionArchiveManifestChecksum(manifest),
      }),
    ).rejects.toThrow("coverage checksum is invalid");
    expect(client.requests).toHaveLength(0);
  });

  test("rejects a compact receipt that disagrees with its durable evidence", async () => {
    const manifest = archiveManifest();
    const existing = receiptEvidence({
      manifest,
      root: manifest.roots[0]!,
      receiptId: "00000000-0000-4000-8000-000000000053",
      sealId: sealA,
      operationKey: "existing-key",
    });
    const client = fakeClient({
      manifest,
      existing: [existing],
      mutateEvidence: (evidence) => ({
        ...evidence,
        receipt: {
          ...evidence.receipt,
          id: "00000000-0000-4000-8000-000000000054",
        },
      }),
    });

    await expect(
      applySessionArchiveBulk({
        client,
        manifest,
        approvedManifestChecksum: sessionArchiveManifestChecksum(manifest),
      }),
    ).rejects.toThrow("compact and durable receipt evidence identify different commits");
    expect(client.requests).toHaveLength(0);
  });

  test("accepts an unarchive receipt that remains archived under an overlapping seal", () => {
    const manifest = canonicalizeSessionArchiveManifest({
      format: "opengeni.session-archive-manifest",
      version: 1,
      workspaceId,
      action: "unarchive",
      totalMemberCount: 1,
      roots: [
        {
          rootSessionId: rootA,
          targetSealId: sealA,
          memberCount: 1,
          members: [
            {
              sessionId: rootA,
              parentSessionId: null,
              depth: 0,
              expectedArchiveRevision: "9",
              expectedArchived: true,
            },
          ],
        },
      ],
    });
    const evidence = receiptEvidence({
      manifest,
      root: manifest.roots[0]!,
      receiptId: "00000000-0000-4000-8000-000000000052",
      sealId: sealA,
      operationKey: "unarchive-overlap",
      afterArchived: true,
    });
    expect(
      verifySessionArchiveReceiptEvidence({
        evidence,
        manifest,
        manifestChecksum: sessionArchiveManifestChecksum(manifest),
        rootSessionId: rootA,
        rootChecksum: sessionArchiveRootChecksum(manifest, rootA),
      }).id,
    ).toBe(evidence.receipt.id);

    const wrongSeal = structuredClone(evidence);
    wrongSeal.receipt.sealId = sealB;
    wrongSeal.receipt.coverageChecksum = sessionArchiveCoverageChecksum({
      workspaceId,
      action: "unarchive",
      rootSessionId: rootA,
      sealId: sealB,
      members: wrongSeal.members,
    });
    expect(() =>
      verifySessionArchiveReceiptEvidence({
        evidence: wrongSeal,
        manifest,
        manifestChecksum: sessionArchiveManifestChecksum(manifest),
        rootSessionId: rootA,
        rootChecksum: sessionArchiveRootChecksum(manifest, rootA),
      }),
    ).toThrow("released a seal other than the manifest target");
  });
});
