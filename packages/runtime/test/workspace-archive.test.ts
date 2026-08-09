import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureVerifiedWorkspaceArchive,
  describeNativeSnapshotArchive,
  parseWorkspaceArchiveDescriptor,
  readVerifiedWorkspaceArchive,
  verifyRestoredWorkspace,
  WorkspaceArchiveIntegrityError,
  type WorkspaceTreeFingerprint,
} from "../src/sandbox/workspace-archive";

const linuxTest = test.skipIf(process.platform !== "linux");

function fingerprintLine(fingerprint: WorkspaceTreeFingerprint): string {
  return [
    "OPENGENI_WORKSPACE_FINGERPRINT_V1",
    fingerprint.sha256,
    fingerprint.entryCount,
    fingerprint.fileCount,
    fingerprint.totalFileBytes,
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sessionWithFingerprints(
  fingerprints: WorkspaceTreeFingerprint[],
  archive = new TextEncoder().encode("durable-workspace-archive"),
) {
  let probes = 0;
  let captures = 0;
  const commands: string[] = [];
  return {
    session: {
      async exec(input: { cmd: string }) {
        commands.push(input.cmd);
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
    commands: () => commands,
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
    expect(verified.kind).toBe("tar");
    expect(parseWorkspaceArchiveDescriptor(verified.descriptor)).toEqual(verified.descriptor);
    expect(readVerifiedWorkspaceArchive(verified.base64, verified.descriptor)).toEqual(verified);
    expect(fake.counts()).toEqual({ probes: 2, captures: 1 });
  });

  test("native provider receipts bypass tar tree probes and retain exact provider identity", async () => {
    const nativeBytes = new TextEncoder().encode(
      'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-123","workspace_persistence":"snapshot_filesystem"}',
    );
    let probes = 0;
    const session = {
      state: { workspacePersistence: "snapshot_filesystem" },
      async exec() {
        probes += 1;
        throw new Error("native receipt capture must not run a tar fingerprint");
      },
      async persistWorkspace() {
        return nativeBytes;
      },
    };

    const verified = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_005);

    expect(probes).toBe(0);
    expect(verified.kind).toBe("provider_snapshot");
    expect(verified.nativeSnapshot).toEqual({
      provider: "modal_snapshot_filesystem",
      snapshotId: "im-123",
      workspacePersistence: "snapshot_filesystem",
    });
    expect(verified.descriptor).toEqual(
      describeNativeSnapshotArchive(nativeBytes, 1_900_000_000_005),
    );
    expect(parseWorkspaceArchiveDescriptor(verified.descriptor)).toEqual(verified.descriptor);
    expect(readVerifiedWorkspaceArchive(verified.base64, verified.descriptor)).toEqual(verified);
    await expect(verifyRestoredWorkspace(session, verified.descriptor)).resolves.toBeNull();
    expect(probes).toBe(0);
  });

  test("portable policy bypasses a replacing native capture and verifies the tar", async () => {
    const archive = new TextEncoder().encode("portable-non-replacing-archive");
    let configuredCaptures = 0;
    let portableCaptures = 0;
    let probes = 0;
    const session = {
      state: { workspacePersistence: "snapshot" },
      async exec() {
        probes += 1;
        return { stdout: `${fingerprintLine(stableTree)}\n`, exitCode: 0 };
      },
      async persistWorkspace() {
        configuredCaptures += 1;
        throw new Error("replacing native capture must not run");
      },
      async persistWorkspaceTar() {
        portableCaptures += 1;
        return archive;
      },
    };

    const verified = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_007, {
      requestId: "11111111-1111-4111-8111-111111111111",
      strategy: "portable_tar",
    });

    expect(verified.kind).toBe("tar");
    expect(configuredCaptures).toBe(0);
    expect(portableCaptures).toBe(1);
    expect(probes).toBe(2);
  });

  test("legacy v1 metadata around a native receipt must be durably upgraded before restore", () => {
    const nativeBytes = new TextEncoder().encode(
      'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-legacy","workspace_persistence":"snapshot_filesystem"}',
    );
    const archiveSha256 = createHash("sha256").update(nativeBytes).digest("hex");
    const legacy = {
      version: 1 as const,
      revision: `wa1:1900000000006:${archiveSha256}`,
      archiveSha256,
      archiveBytes: nativeBytes.length,
      capturedAt: new Date(1_900_000_000_006).toISOString(),
      workspace: stableTree,
    };

    let error: unknown;
    try {
      readVerifiedWorkspaceArchive(Buffer.from(nativeBytes).toString("base64"), legacy);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceArchiveIntegrityError);
    expect(error).toMatchObject({
      code: "native_snapshot_reference_invalid",
      retryable: false,
    });
  });

  test("a native mode that silently falls back to tar is rejected instead of mislabeled", async () => {
    const fake = {
      state: { workspacePersistence: "snapshot_filesystem" },
      async persistWorkspace() {
        return new TextEncoder().encode("not-a-native-receipt");
      },
    };

    const error = await captureVerifiedWorkspaceArchive(fake).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "native_snapshot_fallback_unverified",
      retryable: false,
    });
  });

  linuxTest("an explicit SDK mount fallback retains the real tar verification path", async () => {
    const archive = new TextEncoder().encode("verified-mounted-workspace-tar");
    const fake = sessionWithFingerprints([stableTree, stableTree], archive);
    const excludedPath = "mount weird'quote";
    const session = {
      ...fake.session,
      state: {
        workspacePersistence: "snapshot_filesystem",
        manifest: {
          ephemeralPersistencePaths: () => new Set([excludedPath]),
        },
      },
    };

    const verified = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_009);
    expect(verified.kind).toBe("tar");
    expect(verified.descriptor.version).toBe(1);
    expect(fake.counts()).toEqual({ probes: 2, captures: 1 });
    expect(fake.commands()).toHaveLength(2);

    const root = mkdtempSync(join(tmpdir(), "opengeni-fingerprint-"));
    try {
      mkdirSync(join(root, excludedPath), { recursive: true });
      writeFileSync(join(root, "retained.txt"), "retained-one");
      writeFileSync(join(root, excludedPath, "ephemeral.txt"), "ephemeral-one");
      const command = fake.commands()[0]!.replace("cd /workspace", `cd ${shellQuote(root)}`);
      const run = () => {
        const result = Bun.spawnSync(["/bin/bash", "-c", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        return Buffer.from(result.stdout).toString("utf8");
      };
      const before = run();
      writeFileSync(join(root, excludedPath, "ephemeral.txt"), "ephemeral-two");
      expect(run()).toBe(before);
      writeFileSync(join(root, "retained.txt"), "retained-two");
      expect(run()).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tar verification ignores provider-specific hardlink inode topology", async () => {
    const commands: string[] = [];
    const session = {
      async exec(input: { cmd: string }) {
        commands.push(input.cmd);
        return { stdout: `${fingerprintLine(stableTree)}\n`, exitCode: 0 };
      },
      async persistWorkspace() {
        return new TextEncoder().encode("tar-with-content-equivalent-hardlinks");
      },
    };

    await captureVerifiedWorkspaceArchive(session, 1_900_000_000_012);

    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command.includes("--hard-dereference"))).toBe(true);
  });

  test("host-backed workspaces fingerprint the SDK archive projection without sandbox exec", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-host-fingerprint-"));
    const excludedPath = "ephemeral";
    const retainedSdkSnapshotExcludedPath = "sdk-snapshot-only";
    try {
      mkdirSync(join(root, "nested"), { recursive: true });
      mkdirSync(join(root, excludedPath), { recursive: true });
      mkdirSync(join(root, retainedSdkSnapshotExcludedPath), { recursive: true });
      writeFileSync(join(root, "nested", "retained.txt"), "retained-one");
      writeFileSync(join(root, "nested", "empty.txt"), "");
      writeFileSync(join(root, excludedPath, "ignored.txt"), "ignored-one");
      writeFileSync(join(root, retainedSdkSnapshotExcludedPath, "retained.txt"), "snapshot-one");
      let execCalls = 0;
      const session = {
        state: {
          workspaceRootPath: root,
          // Agents SDK 0.13.x uses this only for serializeSessionState()'s
          // snapshot primitive. Direct persistWorkspace(), which this path
          // invokes, deliberately excludes only manifest-ephemeral paths.
          snapshotExcludedPaths: [retainedSdkSnapshotExcludedPath],
          manifest: {
            ephemeralPersistencePaths: () => new Set([excludedPath]),
          },
        },
        async exec() {
          execCalls += 1;
          throw new Error("host-backed fingerprint must not execute inside the sandbox");
        },
        async persistWorkspace() {
          return new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              directories: ["nested", retainedSdkSnapshotExcludedPath],
              files: [
                {
                  path: "nested/empty.txt",
                  data: "",
                },
                {
                  path: "nested/retained.txt",
                  data: readFileSync(join(root, "nested", "retained.txt")).toString("base64"),
                },
                {
                  path: `${retainedSdkSnapshotExcludedPath}/retained.txt`,
                  data: readFileSync(
                    join(root, retainedSdkSnapshotExcludedPath, "retained.txt"),
                  ).toString("base64"),
                },
              ],
            }),
          );
        },
      };

      const first = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_013);
      expect(first.descriptor.workspace.projection).toBe("sdk_local_archive_v1");
      expect(first.descriptor.workspace.entryCount).toBe(5);
      expect(first.descriptor.workspace.fileCount).toBe(3);
      expect(first.descriptor.workspace.totalFileBytes).toBe(24);
      expect(execCalls).toBe(0);

      writeFileSync(join(root, excludedPath, "ignored.txt"), "ignored-two");
      const second = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_014);
      expect(second.descriptor.workspace).toEqual(first.descriptor.workspace);
      writeFileSync(join(root, retainedSdkSnapshotExcludedPath, "retained.txt"), "snapshot-two");
      const snapshotOnlyChange = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_015);
      expect(snapshotOnlyChange.descriptor.workspace.sha256).not.toBe(
        first.descriptor.workspace.sha256,
      );
      writeFileSync(join(root, "nested", "retained.txt"), "retained-two");
      const third = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_016);
      expect(third.descriptor.workspace.sha256).not.toBe(first.descriptor.workspace.sha256);
      expect(execCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("host-backed capture rejects SDK archive bytes that do not match the fenced workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-host-archive-mismatch-"));
    try {
      writeFileSync(join(root, "truth.txt"), "live-truth");
      const session = {
        state: { workspaceRootPath: root },
        async persistWorkspace() {
          return new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              directories: [],
              files: [
                {
                  path: "truth.txt",
                  data: Buffer.from("different-archive").toString("base64"),
                },
              ],
            }),
          );
        },
      };

      const error = await captureVerifiedWorkspaceArchive(session).catch((caught) => caught);
      expect(error).toBeInstanceOf(WorkspaceArchiveIntegrityError);
      expect(error).toMatchObject({ code: "workspace_changed_during_capture", retryable: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy host-backed descriptors retain their original GNU-tar verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-legacy-fingerprint-"));
    let probes = 0;
    try {
      const session = {
        state: { workspaceRootPath: root },
        async exec() {
          probes += 1;
          return { stdout: `${fingerprintLine(stableTree)}\n`, exitCode: 0 };
        },
      };
      await expect(
        verifyRestoredWorkspace(session, {
          version: 1,
          revision: `wa1:1900000000016:${"e".repeat(64)}`,
          archiveSha256: "e".repeat(64),
          archiveBytes: 32,
          capturedAt: new Date(1_900_000_000_016).toISOString(),
          workspace: stableTree,
        }),
      ).resolves.toEqual(stableTree);
      expect(probes).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("descriptor revision hash and timestamp must match their common fields", () => {
    const archive = new TextEncoder().encode("descriptor-consistency");
    const descriptor = describeNativeSnapshotArchive(
      new TextEncoder().encode(
        'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-consistent","workspace_persistence":"snapshot_filesystem"}',
      ),
      1_900_000_000_010,
    )!;

    expect(
      parseWorkspaceArchiveDescriptor({
        ...descriptor,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      }),
    ).toBeNull();
    expect(
      parseWorkspaceArchiveDescriptor({
        ...descriptor,
        capturedAt: new Date(1_900_000_000_011).toISOString(),
      }),
    ).toBeNull();

    expect(
      parseWorkspaceArchiveDescriptor({
        version: 1,
        revision: `wa1:1900000000012:${"f".repeat(64)}`,
        archiveSha256: "f".repeat(64),
        archiveBytes: 1,
        capturedAt: new Date(1_900_000_000_012).toISOString(),
        workspace: { ...stableTree, projection: "unknown_projection" },
      }),
    ).toBeNull();
  });

  test("accepts Modal execCommand output wrapped in the provider response banner", async () => {
    const line = fingerprintLine(stableTree);
    let probes = 0;
    const session = {
      async execCommand() {
        probes += 1;
        return [
          "Chunk ID: abc123",
          "Wall time: 0.2 seconds",
          "Process exited with code 0",
          "Final output:",
          "",
          "Output:",
          line,
          "",
        ].join("\n");
      },
      async persistWorkspace() {
        return new TextEncoder().encode("modal-workspace-archive");
      },
    };

    const verified = await captureVerifiedWorkspaceArchive(session, 1_900_000_000_004);

    expect(verified.descriptor.workspace).toEqual(stableTree);
    expect(probes).toBe(2);
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

  test("retries only GNU tar's transient restored-root metadata race", async () => {
    let probes = 0;
    const session = {
      async exec() {
        probes += 1;
        return probes === 1
          ? {
              stdout: "",
              stderr: "tar: .: file changed as we read it\n",
              exitCode: 1,
            }
          : { stdout: `${fingerprintLine(stableTree)}\n`, stderr: "", exitCode: 0 };
      },
    };

    await expect(
      verifyRestoredWorkspace(session, {
        version: 1,
        revision: `wa1:1900000000002:${"d".repeat(64)}`,
        archiveSha256: "d".repeat(64),
        archiveBytes: 32,
        capturedAt: "2030-03-17T17:46:42.000Z",
        workspace: stableTree,
      }),
    ).resolves.toEqual(stableTree);
    expect(probes).toBe(2);
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
