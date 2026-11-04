import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureVerifiedWorkspaceArchive,
  findRebuildableWorkspacePaths,
  REBUILDABLE_WORKSPACE_PATHS_MAX,
  type WorkspaceTreeFingerprint,
} from "../src/sandbox/workspace-archive";

const linuxTest = test.skipIf(process.platform !== "linux");

const stableTree: WorkspaceTreeFingerprint = {
  algorithm: "sha256",
  sha256: "b".repeat(64),
  entryCount: 4,
  fileCount: 2,
  totalFileBytes: 12,
};

function fingerprintLine(fingerprint: WorkspaceTreeFingerprint): string {
  return [
    "OPENGENI_WORKSPACE_FINGERPRINT_V1",
    fingerprint.sha256,
    fingerprint.entryCount,
    fingerprint.fileCount,
    fingerprint.totalFileBytes,
  ].join(" ");
}

function reducibleSession(options: { nativeReceipt?: boolean } = {}) {
  const configured = new Set<unknown>(["already-ephemeral"]);
  const seenDuringCapture: string[][] = [];
  const commands: string[] = [];
  const manifest: { ephemeralPersistencePaths?: () => Set<unknown> } = {};
  const ownConfigured = () => configured;
  manifest.ephemeralPersistencePaths = ownConfigured;
  const persist = async () => {
    seenDuringCapture.push([...(manifest.ephemeralPersistencePaths?.() ?? [])].map(String).sort());
    if (options.nativeReceipt) {
      return {
        kind: "modal_snapshot_filesystem",
        snapshotId: "im-native",
      } as unknown as Uint8Array;
    }
    return new TextEncoder().encode("reduced-workspace-tar");
  };
  const session = {
    state: { manifest },
    async exec(input: { cmd: string }) {
      commands.push(input.cmd);
      return { stdout: `${fingerprintLine(stableTree)}\n`, exitCode: 0 };
    },
    persistWorkspace: persist,
    persistWorkspaceTar: persist,
  };
  return { session, manifest, ownConfigured, seenDuringCapture, commands };
}

describe("reduced workspace saves", () => {
  test("omitPaths leaves folders out of this capture only and records them", async () => {
    const fake = reducibleSession();
    const verified = await captureVerifiedWorkspaceArchive(fake.session, 1_900_000_000_000, {
      requestId: "reduced-1",
      strategy: "portable_tar",
      omitPaths: [
        "./web/node_modules/",
        "node_modules",
        "../escape",
        "/abs",
        "a/./b",
        "node_modules",
      ],
    });

    expect(verified.kind).toBe("tar");
    expect(verified.descriptor).toMatchObject({
      version: 1,
      omittedPaths: ["node_modules", "web/node_modules"],
    });
    // The provider saw the widened exclusions; unsafe paths were dropped, never widened.
    expect(fake.seenDuringCapture).toEqual([
      ["already-ephemeral", "node_modules", "web/node_modules"],
    ]);
    // The before/after fingerprint leaves the same folders out.
    expect(fake.commands).toHaveLength(2);
    for (const command of fake.commands) {
      expect(command).toContain("web/node_modules");
    }
    // The live manifest gets its own exclusions back.
    expect(fake.manifest.ephemeralPersistencePaths).toBe(fake.ownConfigured);
    expect([...fake.manifest.ephemeralPersistencePaths!()]).toEqual(["already-ephemeral"]);
  });

  test("a capture without omitPaths records no omitted folders", async () => {
    const fake = reducibleSession();
    const verified = await captureVerifiedWorkspaceArchive(fake.session, 1_900_000_000_001, {
      requestId: "full-1",
    });
    expect(verified.descriptor).not.toHaveProperty("omittedPaths");
    expect(fake.seenDuringCapture).toEqual([["already-ephemeral"]]);
  });

  test("a reduced capture that returns a native snapshot is rejected and the manifest restored", async () => {
    const fake = reducibleSession({ nativeReceipt: true });
    const error = await captureVerifiedWorkspaceArchive(fake.session, 1_900_000_000_002, {
      requestId: "reduced-native",
      omitPaths: ["node_modules"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(fake.manifest.ephemeralPersistencePaths).toBe(fake.ownConfigured);
  });

  test("a session that cannot leave paths out fails clearly instead of saving everything", async () => {
    const error = await captureVerifiedWorkspaceArchive(
      {
        async exec() {
          return { stdout: `${fingerprintLine(stableTree)}\n`, exitCode: 0 };
        },
        async persistWorkspace() {
          return new TextEncoder().encode("full-tar");
        },
      },
      1_900_000_000_003,
      { requestId: "reduced-no-manifest", omitPaths: ["node_modules"] },
    ).catch((caught) => caught);
    expect(error).toMatchObject({ code: "workspace_fingerprint_unavailable" });
  });

  test("findRebuildableWorkspacePaths parses the folders and the kept size", async () => {
    const output = [
      "D node_modules",
      "D web/.next",
      "D web/node_modules",
      "D ../outside",
      "OPENGENI_REBUILDABLE_V1 7 4096 4",
      "",
    ].join("\n");
    const result = await findRebuildableWorkspacePaths({
      async exec() {
        return { stdout: output, exitCode: 0 };
      },
    });
    expect(result).toEqual({
      paths: ["node_modules", "web/.next", "web/node_modules"],
      kept: { fileCount: 7, totalFileBytes: 4096 },
    });
  });

  test("findRebuildableWorkspacePaths returns null without its summary line or a session", async () => {
    expect(
      await findRebuildableWorkspacePaths({
        async exec() {
          return { stdout: "D node_modules\n", exitCode: 0 };
        },
      }),
    ).toBeNull();
    expect(
      await findRebuildableWorkspacePaths({
        async exec() {
          throw new Error("exec failed");
        },
      }),
    ).toBeNull();
    expect(await findRebuildableWorkspacePaths(null)).toBeNull();
  });

  linuxTest("the in-box walk finds rebuildable folders without entering .git", async () => {
    let script = "";
    await findRebuildableWorkspacePaths({
      async exec(input: { cmd: string }) {
        script = input.cmd;
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(script).toContain("cd /workspace");

    const root = mkdtempSync(join(tmpdir(), "opengeni-rebuildable-"));
    try {
      const file = (path: string, body = "x") => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), body);
      };
      file("src/index.ts", "12345");
      file("node_modules/pkg/index.js", "dependency");
      file("web/.next/cache/chunk.js", "built");
      file("web/package.json", "{}");
      file("api/.venv/lib/site.py", "venv");
      file("crate/Cargo.toml", "[package]");
      file("crate/target/debug/bin", "rust-build");
      file("notes/target/plan.md", "kept");
      file(".git/objects/node_modules/blob", "git");
      const result = Bun.spawnSync(
        ["/bin/bash", "-c", script.replace("cd /workspace", `cd ${root}`)],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      const lines = Buffer.from(result.stdout).toString("utf8").trim().split("\n").sort();
      // Kept regular files: src/index.ts, web/package.json, crate/Cargo.toml,
      // notes/target/plan.md and the .git blob (5 + 2 + 9 + 4 + 3 bytes).
      expect(lines).toEqual([
        "D api/.venv",
        "D crate/target",
        "D node_modules",
        "D web/.next",
        "OPENGENI_REBUILDABLE_V1 5 23 4",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("more folders than the walk can list means no reduced save", async () => {
    const listed = (count: number) =>
      Array.from({ length: Math.min(count, REBUILDABLE_WORKSPACE_PATHS_MAX) }, (_, index) => {
        return `D p${String(index).padStart(4, "0")}/node_modules`;
      });
    const walk = (count: number) =>
      findRebuildableWorkspacePaths({
        async exec() {
          return {
            stdout: [`OPENGENI_REBUILDABLE_V1 1 1 ${count}`, ...listed(count)].join("\n"),
            exitCode: 0,
          };
        },
      });
    expect((await walk(REBUILDABLE_WORKSPACE_PATHS_MAX))?.paths).toHaveLength(
      REBUILDABLE_WORKSPACE_PATHS_MAX,
    );
    // The folders past the limit would be kept unsized, so nothing is reduced.
    expect(await walk(REBUILDABLE_WORKSPACE_PATHS_MAX + 1)).toBeNull();
  });

  linuxTest("an unreadable folder still sizes the rest", async () => {
    if (process.getuid?.() === 0) return;
    let script = "";
    await findRebuildableWorkspacePaths({
      async exec(input: { cmd: string }) {
        script = input.cmd;
        return { stdout: "", exitCode: 0 };
      },
    });
    const root = mkdtempSync(join(tmpdir(), "opengeni-rebuildable-"));
    try {
      writeFileSync(join(root, "kept.txt"), "abc");
      mkdirSync(join(root, "node_modules"));
      mkdirSync(join(root, "locked"));
      chmodSync(join(root, "locked"), 0o000);
      const result = Bun.spawnSync(
        ["/bin/bash", "-c", script.replace("cd /workspace", `cd ${root}`)],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(Buffer.from(result.stdout).toString("utf8").trim().split("\n").sort()).toEqual([
        "D node_modules",
        "OPENGENI_REBUILDABLE_V1 1 3 1",
      ]);
    } finally {
      chmodSync(join(root, "locked"), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
