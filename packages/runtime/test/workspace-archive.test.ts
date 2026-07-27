import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  captureVerifiedWorkspaceArchive,
  parseWorkspaceArchiveDescriptor,
  readVerifiedWorkspaceArchive,
  verifyRestoredWorkspace,
  WorkspaceArchiveIntegrityError,
  type WorkspaceTreeFingerprint,
} from "../src/sandbox/workspace-archive";

function fingerprintLine(fingerprint: WorkspaceTreeFingerprint): string {
  return [
    "OPENGENI_WORKSPACE_FINGERPRINT_V1",
    fingerprint.sha256,
    fingerprint.entryCount,
    fingerprint.fileCount,
    fingerprint.totalFileBytes,
  ].join(" ");
}

function sessionWithFingerprints(
  fingerprints: WorkspaceTreeFingerprint[],
  archive = new TextEncoder().encode("durable-workspace-archive"),
) {
  let probes = 0;
  let captures = 0;
  return {
    session: {
      async exec() {
        const fingerprint = fingerprints[Math.min(probes, fingerprints.length - 1)]!;
        probes += 1;
        return { stdout: `${fingerprintLine(fingerprint)}\n`, exitCode: 0 };
      },
      async persistWorkspace() {
        captures += 1;
        return archive;
      },
    },
    counts: () => ({ probes, captures }),
  };
}

const stableTree: WorkspaceTreeFingerprint = {
  algorithm: "sha256",
  sha256: "a".repeat(64),
  entryCount: 5,
  fileCount: 3,
  totalFileBytes: 29,
};

describe("verified workspace archives", () => {
  test("stable capture records exact archive bytes/hash and deterministic tree metadata", async () => {
    const archive = new TextEncoder().encode("exact-selected-archive");
    const fake = sessionWithFingerprints([stableTree, stableTree], archive);
    const capturedAt = 1_900_000_000_000;

    const verified = await captureVerifiedWorkspaceArchive(fake.session, capturedAt);
    const expectedHash = createHash("sha256").update(archive).digest("hex");
    expect(verified.bytes).toEqual(archive);
    expect(verified.base64).toBe(Buffer.from(archive).toString("base64"));
    expect(verified.descriptor).toEqual({
      version: 1,
      revision: `wa1:${capturedAt}:${expectedHash}`,
      archiveSha256: expectedHash,
      archiveBytes: archive.length,
      capturedAt: new Date(capturedAt).toISOString(),
      workspace: stableTree,
    });
    expect(parseWorkspaceArchiveDescriptor(verified.descriptor)).toEqual(verified.descriptor);
    expect(readVerifiedWorkspaceArchive(verified.base64, verified.descriptor)).toEqual(verified);
    expect(fake.counts()).toEqual({ probes: 2, captures: 1 });
  });

  test("a workspace mutation during capture rejects the candidate revision", async () => {
    const changedTree: WorkspaceTreeFingerprint = {
      ...stableTree,
      sha256: "b".repeat(64),
      totalFileBytes: stableTree.totalFileBytes + 1,
    };
    const fake = sessionWithFingerprints([stableTree, changedTree]);

    const error = await captureVerifiedWorkspaceArchive(fake.session).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkspaceArchiveIntegrityError);
    expect(error).toMatchObject({ code: "workspace_changed_during_capture", retryable: true });
    expect(fake.counts()).toEqual({ probes: 2, captures: 1 });
  });

  test("archive bytes must match the selected descriptor exactly", async () => {
    const fake = sessionWithFingerprints([stableTree, stableTree]);
    const verified = await captureVerifiedWorkspaceArchive(fake.session, 1_900_000_000_001);
    const corrupted = Buffer.from("different-archive-bytes").toString("base64");

    const error = (() => {
      try {
        readVerifiedWorkspaceArchive(corrupted, verified.descriptor);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(WorkspaceArchiveIntegrityError);
    expect(error).toMatchObject({ code: "archive_hash_mismatch", retryable: false });
  });

  test("restored-tree verification rejects a plausible partial workspace", async () => {
    const partialTree: WorkspaceTreeFingerprint = {
      ...stableTree,
      sha256: "c".repeat(64),
      entryCount: stableTree.entryCount - 1,
      fileCount: stableTree.fileCount - 1,
    };
    const fake = sessionWithFingerprints([partialTree]);
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000000002:${"d".repeat(64)}`,
      archiveSha256: "d".repeat(64),
      archiveBytes: 32,
      capturedAt: "2030-03-17T17:46:42.000Z",
      workspace: stableTree,
    };

    const error = await verifyRestoredWorkspace(fake.session, descriptor).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkspaceArchiveIntegrityError);
    expect(error).toMatchObject({ code: "workspace_fingerprint_mismatch", retryable: false });
    expect(fake.counts()).toEqual({ probes: 1, captures: 0 });
  });
});
