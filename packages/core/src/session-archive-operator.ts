import {
  canonicalizeSessionArchiveManifest,
  SessionArchiveApplyResponse,
  SessionArchivePlanResponse,
  SessionArchiveReceipt,
  SessionArchiveReceiptEvidence,
  type CanonicalSessionArchiveManifest,
  type SessionArchiveApplyRequest,
  type SessionArchiveManifestRoot,
  type SessionArchiveReceipt as SessionArchiveReceiptType,
  type SessionArchiveReceiptEvidence as SessionArchiveReceiptEvidenceType,
} from "@opengeni/contracts/session-archive";
import {
  assertSessionArchiveManifestChecksum,
  sessionArchiveCoverageChecksum,
  sessionArchiveRootChecksum,
  type SessionArchiveChecksum,
} from "./session-archive-manifest";

export type SessionArchiveOperatorClient = {
  applySessionArchive(workspaceId: string, request: SessionArchiveApplyRequest): Promise<unknown>;
  getSessionArchiveReceipt(workspaceId: string, receiptId: string): Promise<unknown>;
  listSessionArchiveReceipts(
    workspaceId: string,
    options: { manifestChecksum?: string; rootChecksum?: string },
  ): Promise<unknown>;
};

export type ValidatedSessionArchivePlan = {
  manifest: CanonicalSessionArchiveManifest;
  manifestChecksum: SessionArchiveChecksum;
  canApply: boolean;
  roots: Array<{
    root: SessionArchiveManifestRoot;
    rootChecksum: SessionArchiveChecksum;
    canApply: boolean;
    blockerCount: number;
  }>;
};

export type SessionArchiveOperatorProgress = {
  rootIndex: number;
  rootCount: number;
  rootSessionId: string;
  rootChecksum: SessionArchiveChecksum;
  receiptId: string;
  replay: boolean;
};

export type SessionArchiveBulkApplyResult = {
  manifestChecksum: SessionArchiveChecksum;
  rootCount: number;
  memberCount: number;
  appliedRootCount: number;
  replayedRootCount: number;
  receipts: SessionArchiveReceiptType[];
  evidence: SessionArchiveReceiptEvidenceType[];
};

function operatorError(message: string): never {
  throw new Error(`Session archive operator verification failed: ${message}`);
}

function rootChecksumMap(manifest: CanonicalSessionArchiveManifest): Map<string, string> {
  return new Map(
    manifest.roots.map((root) => [
      sessionArchiveRootChecksum(manifest, root.rootSessionId),
      root.rootSessionId,
    ]),
  );
}

/**
 * Fail-closed local verification for a read-only server plan. No server state
 * is trusted merely because it was returned by the planning endpoint.
 */
export function validateSessionArchivePlan(input: unknown): ValidatedSessionArchivePlan {
  const plan = SessionArchivePlanResponse.parse(input);
  const manifest = canonicalizeSessionArchiveManifest(plan.manifest);
  const manifestChecksum = assertSessionArchiveManifestChecksum(manifest, plan.manifestChecksum);
  const rootsById = new Map(manifest.roots.map((root) => [root.rootSessionId, root]));
  if (plan.roots.length !== manifest.roots.length) {
    operatorError(
      `plan returned ${plan.roots.length} root results for ${manifest.roots.length} manifest roots`,
    );
  }

  const seen = new Set<string>();
  const roots = plan.roots.map((plannedRoot) => {
    const rootId = plannedRoot.rootSessionId.toLowerCase();
    const root = rootsById.get(rootId);
    if (!root || seen.has(rootId)) {
      operatorError(`plan root ${rootId} is missing from or duplicated in the manifest`);
    }
    seen.add(rootId);
    if ((plannedRoot.targetSealId?.toLowerCase() ?? null) !== root.targetSealId) {
      operatorError(`plan root ${rootId} target seal differs from the manifest`);
    }
    if (plannedRoot.memberCount !== root.memberCount) {
      operatorError(`plan root ${rootId} member count differs from the manifest`);
    }
    const expectedRootChecksum = sessionArchiveRootChecksum(manifest, rootId);
    if (plannedRoot.rootChecksum !== expectedRootChecksum) {
      operatorError(`plan root ${rootId} checksum differs from canonical coverage`);
    }
    if (plannedRoot.canApply !== (plannedRoot.blockers.length === 0)) {
      operatorError(`plan root ${rootId} canApply disagrees with its blockers`);
    }
    return {
      root,
      rootChecksum: expectedRootChecksum,
      canApply: plannedRoot.canApply,
      blockerCount: plannedRoot.blockers.length,
    };
  });
  const expectedCanApply = roots.every((root) => root.canApply);
  if (plan.canApply !== expectedCanApply) {
    operatorError("bulk canApply disagrees with the per-root results");
  }
  return { manifest, manifestChecksum, canApply: plan.canApply, roots };
}

function deterministicOperationKey(
  manifestChecksum: SessionArchiveChecksum,
  rootChecksum: SessionArchiveChecksum,
): string {
  return `session-archive:${manifestChecksum.slice(7)}:${rootChecksum.slice(7)}`;
}

function verifyReceiptIdentity(input: {
  receipt: SessionArchiveReceiptType;
  manifest: CanonicalSessionArchiveManifest;
  manifestChecksum: SessionArchiveChecksum;
  root: SessionArchiveManifestRoot;
  rootChecksum: SessionArchiveChecksum;
  expectedOperationKey?: string;
}): void {
  const { receipt, manifest, manifestChecksum, root, rootChecksum, expectedOperationKey } = input;
  if (receipt.workspaceId.toLowerCase() !== manifest.workspaceId) {
    operatorError(`receipt ${receipt.id} belongs to another workspace`);
  }
  if (receipt.action !== manifest.action) {
    operatorError(`receipt ${receipt.id} action differs from the manifest`);
  }
  if (receipt.manifestChecksum !== manifestChecksum) {
    operatorError(`receipt ${receipt.id} bulk checksum differs from the manifest`);
  }
  if (receipt.rootChecksum !== rootChecksum) {
    operatorError(`receipt ${receipt.id} root checksum differs from the manifest`);
  }
  if (receipt.rootSessionId.toLowerCase() !== root.rootSessionId) {
    operatorError(`receipt ${receipt.id} names the wrong root`);
  }
  if (receipt.memberCount !== root.memberCount) {
    operatorError(`receipt ${receipt.id} member count differs from the manifest`);
  }
  if (expectedOperationKey !== undefined && receipt.operationKey !== expectedOperationKey) {
    operatorError(`receipt ${receipt.id} operation key differs from the deterministic request`);
  }
  if (
    manifest.action === "unarchive" &&
    receipt.sealId.toLowerCase() !== root.targetSealId?.toLowerCase()
  ) {
    operatorError(`receipt ${receipt.id} released a seal other than the manifest target`);
  }
}

/** Verify exact durable member evidence and return its parsed receipt. */
export function verifySessionArchiveReceiptEvidence(input: {
  evidence: unknown;
  manifest: unknown;
  manifestChecksum: string;
  rootSessionId: string;
  rootChecksum: string;
  expectedOperationKey?: string;
}): SessionArchiveReceiptType {
  const evidence: SessionArchiveReceiptEvidenceType = SessionArchiveReceiptEvidence.parse(
    input.evidence,
  );
  const manifest = canonicalizeSessionArchiveManifest(input.manifest);
  const manifestChecksum = assertSessionArchiveManifestChecksum(manifest, input.manifestChecksum);
  const rootId = input.rootSessionId.toLowerCase();
  const root = manifest.roots.find((candidate) => candidate.rootSessionId === rootId);
  if (!root) {
    operatorError(`root ${rootId} is absent from the manifest`);
  }
  const rootChecksum = sessionArchiveRootChecksum(manifest, rootId);
  if (input.rootChecksum !== rootChecksum) {
    operatorError(`root ${rootId} caller checksum differs from canonical coverage`);
  }
  verifyReceiptIdentity({
    receipt: evidence.receipt,
    manifest,
    manifestChecksum,
    root,
    rootChecksum,
    ...(input.expectedOperationKey !== undefined
      ? { expectedOperationKey: input.expectedOperationKey }
      : {}),
  });

  if (evidence.members.length !== root.members.length) {
    operatorError(`receipt ${evidence.receipt.id} has incomplete member evidence`);
  }
  const evidenceById = new Map(
    evidence.members.map((member) => [member.sessionId.toLowerCase(), member]),
  );
  if (evidenceById.size !== evidence.members.length) {
    operatorError(`receipt ${evidence.receipt.id} has duplicate member evidence`);
  }
  for (const expected of root.members) {
    const member = evidenceById.get(expected.sessionId);
    if (!member) {
      operatorError(`receipt ${evidence.receipt.id} omits session ${expected.sessionId}`);
    }
    if ((member.parentSessionId?.toLowerCase() ?? null) !== expected.parentSessionId) {
      operatorError(
        `receipt ${evidence.receipt.id} changed parent evidence for ${expected.sessionId}`,
      );
    }
    if (member.depth !== expected.depth) {
      operatorError(
        `receipt ${evidence.receipt.id} changed depth evidence for ${expected.sessionId}`,
      );
    }
    if (
      member.beforeArchiveRevision !== expected.expectedArchiveRevision ||
      member.beforeArchived !== expected.expectedArchived
    ) {
      operatorError(
        `receipt ${evidence.receipt.id} violated the revision fence for ${expected.sessionId}`,
      );
    }
    if (BigInt(member.afterArchiveRevision) !== BigInt(member.beforeArchiveRevision) + 1n) {
      operatorError(
        `receipt ${evidence.receipt.id} has a non-monotonic revision for ${expected.sessionId}`,
      );
    }
    if (manifest.action === "archive" && !member.afterArchived) {
      operatorError(`receipt ${evidence.receipt.id} did not archive ${expected.sessionId}`);
    }
  }

  const coverageChecksum = sessionArchiveCoverageChecksum({
    workspaceId: manifest.workspaceId,
    action: manifest.action,
    rootSessionId: root.rootSessionId,
    sealId: evidence.receipt.sealId,
    members: evidence.members,
  });
  if (evidence.receipt.coverageChecksum !== coverageChecksum) {
    operatorError(`receipt ${evidence.receipt.id} coverage checksum is invalid`);
  }
  return evidence.receipt;
}

/**
 * Resume or apply every root sequentially. Existing receipts are verified
 * before they are trusted; newly committed roots are verified before the next
 * root is submitted. Each root uses a deterministic replay-safe operation key.
 */
export async function applySessionArchiveBulk(input: {
  client: SessionArchiveOperatorClient;
  manifest: unknown;
  approvedManifestChecksum: string;
  onProgress?: (progress: SessionArchiveOperatorProgress) => void | Promise<void>;
}): Promise<SessionArchiveBulkApplyResult> {
  const manifest = canonicalizeSessionArchiveManifest(input.manifest);
  const manifestChecksum = assertSessionArchiveManifestChecksum(
    manifest,
    input.approvedManifestChecksum,
  );
  const rootByChecksum = rootChecksumMap(manifest);
  const listed = await input.client.listSessionArchiveReceipts(manifest.workspaceId, {
    manifestChecksum,
  });
  if (!Array.isArray(listed)) {
    operatorError("receipt list response is not an array");
  }

  const receiptsByRootChecksum = new Map<string, SessionArchiveReceiptType>();
  const evidenceByRootChecksum = new Map<string, SessionArchiveReceiptEvidenceType>();
  for (const candidate of listed) {
    const receipt = SessionArchiveReceipt.parse(candidate);
    const rootId = rootByChecksum.get(receipt.rootChecksum);
    if (!rootId) {
      operatorError(`receipt ${receipt.id} names a root outside the approved manifest`);
    }
    if (receiptsByRootChecksum.has(receipt.rootChecksum)) {
      operatorError(`multiple receipts exist for root ${rootId}`);
    }
    const evidence = await input.client.getSessionArchiveReceipt(manifest.workspaceId, receipt.id);
    const parsedEvidence = SessionArchiveReceiptEvidence.parse(evidence);
    if (JSON.stringify(receipt) !== JSON.stringify(parsedEvidence.receipt)) {
      operatorError("compact and durable receipt evidence identify different commits");
    }
    const verified = verifySessionArchiveReceiptEvidence({
      evidence: parsedEvidence,
      manifest,
      manifestChecksum,
      rootSessionId: rootId,
      rootChecksum: receipt.rootChecksum,
    });
    receiptsByRootChecksum.set(receipt.rootChecksum, verified);
    evidenceByRootChecksum.set(receipt.rootChecksum, parsedEvidence);
  }

  let manifestRegistered = receiptsByRootChecksum.size > 0;
  let appliedRootCount = 0;
  let replayedRootCount = receiptsByRootChecksum.size;
  for (const [rootIndex, root] of manifest.roots.entries()) {
    const rootChecksum = sessionArchiveRootChecksum(manifest, root.rootSessionId);
    let receipt = receiptsByRootChecksum.get(rootChecksum);
    let replay = receipt !== undefined;
    if (!receipt) {
      const operationKey = deterministicOperationKey(manifestChecksum, rootChecksum);
      const request: SessionArchiveApplyRequest = {
        manifest: manifestRegistered ? null : manifest,
        manifestChecksum,
        rootSessionId: root.rootSessionId,
        rootChecksum,
        idempotencyKey: operationKey,
      };
      const response = SessionArchiveApplyResponse.parse(
        await input.client.applySessionArchive(manifest.workspaceId, request),
      );
      verifyReceiptIdentity({
        receipt: response.receipt,
        manifest,
        manifestChecksum,
        root,
        rootChecksum,
        expectedOperationKey: operationKey,
      });
      const evidence = await input.client.getSessionArchiveReceipt(
        manifest.workspaceId,
        response.receipt.id,
      );
      receipt = verifySessionArchiveReceiptEvidence({
        evidence,
        manifest,
        manifestChecksum,
        rootSessionId: root.rootSessionId,
        rootChecksum,
        expectedOperationKey: operationKey,
      });
      if (JSON.stringify(receipt) !== JSON.stringify(response.receipt)) {
        operatorError("apply response and durable receipt evidence identify different commits");
      }
      if (
        response.rootArchive.archiveRevision !==
          evidenceRootAfterRevision(evidence, root.rootSessionId) ||
        response.rootArchive.archived !== evidenceRootAfterArchived(evidence, root.rootSessionId)
      ) {
        operatorError(`apply response root projection disagrees with receipt ${receipt.id}`);
      }
      manifestRegistered = true;
      replay = response.replay;
      if (response.replay) {
        replayedRootCount += 1;
      } else {
        appliedRootCount += 1;
      }
      receiptsByRootChecksum.set(rootChecksum, receipt);
      evidenceByRootChecksum.set(rootChecksum, SessionArchiveReceiptEvidence.parse(evidence));
    }
    await input.onProgress?.({
      rootIndex,
      rootCount: manifest.roots.length,
      rootSessionId: root.rootSessionId,
      rootChecksum,
      receiptId: receipt.id,
      replay,
    });
  }

  return {
    manifestChecksum,
    rootCount: manifest.roots.length,
    memberCount: manifest.totalMemberCount,
    appliedRootCount,
    replayedRootCount,
    receipts: manifest.roots.map((root) => {
      const checksum = sessionArchiveRootChecksum(manifest, root.rootSessionId);
      const receipt = receiptsByRootChecksum.get(checksum);
      if (!receipt) {
        return operatorError(`no verified receipt exists for root ${root.rootSessionId}`);
      }
      return receipt;
    }),
    evidence: manifest.roots.map((root) => {
      const checksum = sessionArchiveRootChecksum(manifest, root.rootSessionId);
      const evidence = evidenceByRootChecksum.get(checksum);
      if (!evidence) {
        return operatorError(`no verified evidence exists for root ${root.rootSessionId}`);
      }
      return evidence;
    }),
  };
}

function parseEvidence(input: unknown): SessionArchiveReceiptEvidenceType {
  return SessionArchiveReceiptEvidence.parse(input);
}

function evidenceRootAfterRevision(input: unknown, rootSessionId: string): string {
  const root = parseEvidence(input).members.find(
    (member) => member.sessionId.toLowerCase() === rootSessionId.toLowerCase(),
  );
  return root?.afterArchiveRevision ?? operatorError(`receipt omits root ${rootSessionId}`);
}

function evidenceRootAfterArchived(input: unknown, rootSessionId: string): boolean {
  const root = parseEvidence(input).members.find(
    (member) => member.sessionId.toLowerCase() === rootSessionId.toLowerCase(),
  );
  return root?.afterArchived ?? operatorError(`receipt omits root ${rootSessionId}`);
}
