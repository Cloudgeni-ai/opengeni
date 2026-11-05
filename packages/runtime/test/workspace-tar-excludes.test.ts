import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ComputeSandboxSession } from "../src/sandbox/compute/session";
import { OpenSandboxSession } from "../src/sandbox/providers/opensandbox-adapter";
import {
  fingerprintSandboxWorkspace,
  probeRemoteWorkspaceSize,
  readRemoteWorkspaceContentManifest,
} from "../src/sandbox/workspace-archive";
import {
  workspaceTarExcludeArgs,
  workspaceTopLevelExcludeGlobs,
} from "../src/sandbox/workspace-tar-excludes";

// Compute and OpenSandbox build their own workspace tar. It must leave out
// exactly what the workspace fingerprint (and the Agents SDK's tar) leaves
// out: each ephemeral path anchored at `./` with its glob characters escaped.
// The old unanchored, unescaped `--exclude=<path>` also dropped a nested
// `docs/target` for a top-level `target`, and `w[1]/node_modules` matched
// `w1/node_modules`, so a restore of such a tar could never verify.

const EPHEMERAL = ["target", "w[1]/node_modules"];
const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspaceTree(): string {
  const root = mkdtempSync(join(tmpdir(), "og-tar-excludes-"));
  created.push(root);
  const files = [
    "target/build.o",
    "docs/target/keep.md",
    "w[1]/node_modules/pkg/index.js",
    "w[1]/src/main.ts",
    "w1/node_modules/pkg/index.js",
    ".opengeni-old-1234/stale.txt",
    ".opengeni-restore-5678/staging.txt",
    "docs/.opengeni-old-notes/kept.txt",
    "README.md",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), file);
  }
  return root;
}

function localRunner(workspace: string, privateRoot: string) {
  const rewrite = (value: string) =>
    value
      .replaceAll("/tmp/opengeni-private", privateRoot)
      .replaceAll("'/workspace'", `'${workspace}'`)
      .replaceAll("cd /workspace\n", `cd ${workspace}\n`)
      .replaceAll("cd /workspace 2>", `cd ${workspace} 2>`);
  return {
    scripts: [] as string[],
    run(cmd: string) {
      this.scripts.push(cmd);
      const result = spawnSync("bash", ["-c", rewrite(cmd)], { encoding: "utf8" });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    read(path: string) {
      return new Uint8Array(readFileSync(rewrite(path)));
    },
  };
}

function archiveMembers(bytes: Uint8Array): string[] {
  const dir = mkdtempSync(join(tmpdir(), "og-tar-list-"));
  created.push(dir);
  const file = join(dir, "capture.tar");
  writeFileSync(file, bytes);
  const listed = spawnSync("tar", ["-tf", file], { encoding: "utf8" });
  expect(listed.status).toBe(0);
  return listed.stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith("/"))
    .map((line) => line.replace(/^\.\//u, ""))
    .sort();
}

function manifestState() {
  return {
    sandboxId: "sbx-test",
    manifest: { ephemeralPersistencePaths: () => new Set(EPHEMERAL) },
  };
}

async function computeArchive(
  workspace: string,
): Promise<{ members: string[]; script: string; bytes: Uint8Array }> {
  const privateRoot = mkdtempSync(join(tmpdir(), "og-tar-private-"));
  created.push(privateRoot);
  const runner = localRunner(workspace, privateRoot);
  const session = Object.create(ComputeSandboxSession.prototype) as Record<string, unknown>;
  Object.assign(session, {
    state: manifestState(),
    archiveLimits: undefined,
    exec: async (args: { cmd: string }) => runner.run(args.cmd),
    readFile: async (args: { path: string }) => runner.read(args.path),
  });
  const bytes = await (session as unknown as ComputeSandboxSession).persistWorkspaceTar();
  return { members: archiveMembers(bytes), script: runner.scripts[0]!, bytes };
}

async function openSandboxArchive(
  workspace: string,
): Promise<{ members: string[]; script: string; bytes: Uint8Array }> {
  const privateRoot = mkdtempSync(join(tmpdir(), "og-tar-private-"));
  created.push(privateRoot);
  const runner = localRunner(workspace, privateRoot);
  const session = Object.create(OpenSandboxSession.prototype) as Record<string, unknown>;
  Object.assign(session, {
    state: manifestState(),
    archiveLimits: undefined,
    execToCompletion: async (args: { cmd: string }) => runner.run(args.cmd),
    readFile: async (args: { path: string }) => runner.read(args.path),
    deletePath: async () => undefined,
  });
  const bytes = await (session as unknown as OpenSandboxSession).persistWorkspaceTar();
  return { members: archiveMembers(bytes), script: runner.scripts[0]!, bytes };
}

const EXPECTED_MEMBERS = [
  "README.md",
  "docs/.opengeni-old-notes/kept.txt",
  "docs/target/keep.md",
  "w1/node_modules/pkg/index.js",
  "w[1]/src/main.ts",
].sort();

/** The backend's session over a local tree, for the workspace fingerprint
 * and content manifest (both run through `exec`). */
function fingerprintSession(
  prototype: object,
  workspace: string,
): Parameters<typeof fingerprintSandboxWorkspace>[0] {
  const privateRoot = mkdtempSync(join(tmpdir(), "og-tar-private-"));
  created.push(privateRoot);
  const runner = localRunner(workspace, privateRoot);
  const session = Object.create(prototype) as Record<string, unknown>;
  Object.assign(session, {
    state: manifestState(),
    exec: async (args: { cmd: string }) => runner.run(args.cmd),
  });
  return session;
}

function extract(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "og-tar-restored-"));
  created.push(dir);
  const file = join(dir, "..", `${dir.split("/").pop()}.tar`);
  created.push(file);
  writeFileSync(file, bytes);
  const result = spawnSync("tar", ["-xf", file, "-C", dir], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return dir;
}

describe("backend workspace tar exclusions", () => {
  for (const [name, capture] of [
    ["compute", computeArchive],
    ["OpenSandbox", openSandboxArchive],
  ] as const) {
    test(`${name} leaves out exactly the anchored, escaped ephemeral paths`, async () => {
      const { members, script } = await capture(workspaceTree());
      expect(members).toEqual(EXPECTED_MEMBERS);
      // The Agents SDK's own tar passes `--exclude=./target` and
      // `--exclude=./w\[1\]/node_modules` (after shell unquoting).
      expect(script).toContain("'--exclude=./target'");
      expect(script).toContain("'--exclude=./w\\[1\\]/node_modules'");
      expect(script).not.toContain("'--exclude=target'");
    });
  }

  // A failed cleanup can leave a restore's staging or backup folder in the
  // workspace. The archive always left those out, but the fingerprint and
  // content manifest counted them, so a save taken while one was present could
  // never verify on restore (its fingerprint described files the archive
  // never held).
  for (const [name, prototype, capture] of [
    ["compute", ComputeSandboxSession.prototype, computeArchive],
    ["OpenSandbox", OpenSandboxSession.prototype, openSandboxArchive],
  ] as const) {
    test(`${name}: a restore of a save taken beside leftover restore folders verifies`, async () => {
      const source = workspaceTree();
      const { bytes } = await capture(source);
      const restored = extract(bytes);
      const before = fingerprintSession(prototype, source);
      const after = fingerprintSession(prototype, restored);
      expect(await fingerprintSandboxWorkspace(after)).toEqual(
        await fingerprintSandboxWorkspace(before),
      );
      expect(await readRemoteWorkspaceContentManifest(after)).toEqual(
        await readRemoteWorkspaceContentManifest(before),
      );
      // The size walk (the metric a failed save's size is compared with)
      // measures the same files as the archive holds.
      const sourceSize = await probeRemoteWorkspaceSize(before);
      expect(sourceSize).not.toBeNull();
      expect(await probeRemoteWorkspaceSize(after)).toEqual(sourceSize);
      expect(sourceSize).not.toEqual(
        await probeRemoteWorkspaceSize(fingerprintSession({}, source)),
      );
    });
  }

  // Saves recorded before this change carry the old fingerprint. Without a
  // leftover folder the extra exclusions match nothing, so those still verify.
  test("without leftover restore folders the fingerprint is unchanged", async () => {
    const source = workspaceTree();
    for (const leftover of [".opengeni-old-1234", ".opengeni-restore-5678"]) {
      rmSync(join(source, leftover), { recursive: true, force: true });
    }
    const withGlobs = fingerprintSession(ComputeSandboxSession.prototype, source);
    const withoutGlobs = fingerprintSession({}, source);
    expect(await fingerprintSandboxWorkspace(withGlobs)).toEqual(
      await fingerprintSandboxWorkspace(withoutGlobs),
    );
    expect(await readRemoteWorkspaceContentManifest(withGlobs)).toEqual(
      await readRemoteWorkspaceContentManifest(withoutGlobs),
    );
  });

  test("an empty path is dropped instead of becoming a no-op `./` pattern", () => {
    expect(workspaceTarExcludeArgs(["", "target"], [".opengeni-old-*"])).toEqual([
      "'--exclude=./.opengeni-old-*'",
      "'--exclude=./target'",
    ]);
  });

  // The archive and the fingerprint apply one check to the top-level globs.
  // An entry that isn't a plain top-level name throws on both sides instead
  // of being dropped by one of them, which would make them disagree.
  test("an invalid top-level glob throws for the archive and the fingerprint alike", async () => {
    const source = workspaceTree();
    for (const glob of [".cache/*", "a\\b", "", ".", "..", "x\ny"]) {
      expect(() => workspaceTopLevelExcludeGlobs([glob])).toThrow(TypeError);
      expect(() => workspaceTarExcludeArgs([], [glob])).toThrow(TypeError);
      const session = fingerprintSession({ workspaceArchiveExcludedGlobs: () => [glob] }, source);
      await expect(fingerprintSandboxWorkspace(session)).rejects.toThrow(TypeError);
      await expect(readRemoteWorkspaceContentManifest(session)).rejects.toThrow(TypeError);
      // The size walk is observability only: no measurement, not an error.
      expect(await probeRemoteWorkspaceSize(session)).toBeNull();
    }
    expect(workspaceTopLevelExcludeGlobs(["b*", "a*", "b*"])).toEqual(["a*", "b*"]);
  });
});
