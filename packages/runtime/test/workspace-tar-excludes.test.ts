import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ComputeSandboxSession } from "../src/sandbox/compute/session";
import { OpenSandboxSession } from "../src/sandbox/providers/opensandbox-adapter";
import { workspaceTarExcludeArgs } from "../src/sandbox/workspace-tar-excludes";

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
      .replaceAll("'/workspace'", `'${workspace}'`);
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

async function computeArchive(workspace: string): Promise<{ members: string[]; script: string }> {
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
  return { members: archiveMembers(bytes), script: runner.scripts[0]! };
}

async function openSandboxArchive(
  workspace: string,
): Promise<{ members: string[]; script: string }> {
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
  return { members: archiveMembers(bytes), script: runner.scripts[0]! };
}

const EXPECTED_MEMBERS = [
  "README.md",
  "docs/.opengeni-old-notes/kept.txt",
  "docs/target/keep.md",
  "w1/node_modules/pkg/index.js",
  "w[1]/src/main.ts",
].sort();

describe("backend workspace tar exclusions", () => {
  for (const [name, capture] of [
    ["compute", computeArchive],
    ["OpenSandbox", openSandboxArchive],
  ] as const) {
    test(`${name} leaves out exactly the anchored, escaped ephemeral paths`, async () => {
      const { members, script } = await capture(workspaceTree());
      expect(members).toEqual(EXPECTED_MEMBERS);
      for (const arg of workspaceTarExcludeArgs(EPHEMERAL)) expect(script).toContain(arg);
      expect(script).not.toContain("'--exclude=target'");
    });
  }
});
