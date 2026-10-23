// A Connected Mac's agent works from the owner's home folder and runs as the
// Opengeni app, so reading a privacy-guarded folder there shows the owner a
// macOS prompt. Automatic whole-workspace walks must not enter those folders.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { MAC_FILES_ANSWERED_ENV } from "@opengeni/sdk/this-computer";
import {
  MAC_HOME_FILES_DIRS,
  MAC_HOME_PRIVACY_GUARDED_DIRS,
  SandboxChannelAService,
  type ChannelASession,
} from "../src/sandbox";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Runs the exact generated command in a host shell whose `uname` reports `system`. */
function hostShellSession(
  root: string,
  system: string,
  home: string,
  env: Record<string, string> = {},
): ChannelASession {
  const bin = tempDir("mac-home-bin-");
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${system}\n`);
  chmodSync(join(bin, "uname"), 0o755);
  return {
    exec: async (args) => {
      const proc = Bun.spawn(["/bin/sh", "-c", args.cmd], {
        cwd: resolve(root, args.workdir ?? "."),
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  };
}

/** A home folder with a repository in every guarded folder and two ordinary ones. */
function homeWithRepositories(): string {
  const root = tempDir("mac-home-");
  for (const dir of [...MAC_HOME_PRIVACY_GUARDED_DIRS.map((d) => `${d}/project`), "code/app"]) {
    mkdirSync(join(root, dir, ".git"), { recursive: true });
  }
  // A guarded name below the home folder is an ordinary folder.
  mkdirSync(join(root, "code", "Library", ".git"), { recursive: true });
  return root;
}

describe("repository discovery from a Mac's home folder", () => {
  test("never enters the privacy-guarded folders", async () => {
    const root = homeWithRepositories();
    const svc = new SandboxChannelAService({ session: hostShellSession(root, "Darwin", root) });
    expect(await svc.detectReposDetailed()).toEqual({
      repos: ["code/Library", "code/app"],
      complete: true,
      degradedReason: null,
    });
  });

  test("enters Desktop, Documents and Downloads once the owner answered macOS about them", async () => {
    const root = homeWithRepositories();
    const answered = join(tempDir("mac-home-answered-"), "answered");
    writeFileSync(answered, "");
    const svc = new SandboxChannelAService({
      session: hostShellSession(root, "Darwin", root, { [MAC_FILES_ANSWERED_ENV]: answered }),
    });
    expect(await svc.detectReposDetailed()).toEqual({
      repos: [...MAC_HOME_FILES_DIRS.map((dir) => `${dir}/project`), "code/Library", "code/app"],
      complete: true,
      degradedReason: null,
    });
  });

  test("finds every repository off a Mac or outside its home folder", async () => {
    const root = homeWithRepositories();
    const everything = [
      ...MAC_HOME_PRIVACY_GUARDED_DIRS.map((dir) => `${dir}/project`),
      "code/Library",
      "code/app",
    ].sort();
    for (const [system, home] of [
      ["Linux", root],
      ["Darwin", tmpdir()],
    ] as const) {
      const svc = new SandboxChannelAService({ session: hostShellSession(root, system, home) });
      expect(await svc.detectReposDetailed()).toEqual({
        repos: everything,
        complete: true,
        degradedReason: null,
      });
    }
  });

  test("covers the folders macOS guards in a home folder", () => {
    expect([...MAC_HOME_PRIVACY_GUARDED_DIRS].sort()).toEqual(
      [
        ".Trash",
        "Desktop",
        "Documents",
        "Downloads",
        "Library",
        "Movies",
        "Music",
        "Pictures",
      ].sort(),
    );
  });
});
