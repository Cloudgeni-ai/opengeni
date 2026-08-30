import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectPortableAppArchive } from "../src";
import { runOgAppCli, type OgAppCliIo } from "../src/cli";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function io(cwd: string): { io: OgAppCliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

describe("og-app CLI", () => {
  test("initializes, validates, and deterministically packs a browser-ready static app", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-app-authoring-"));
    temporaryRoots.push(root);
    const output = io(root);

    expect(await runOgAppCli(["init", "status", "--name", "Status console"], output.io)).toBe(0);
    const entry = await readFile(join(root, "status", "index.html"), "utf8");
    expect(entry).toContain("Status console");
    expect(entry).not.toContain("@opengeni/app-sdk");

    expect(await runOgAppCli(["validate", "status"], output.io)).toBe(0);
    expect(await runOgAppCli(["pack", "status"], output.io)).toBe(0);
    const archivePath = join(root, "status.ogapp.tar");
    const firstArchive = new Uint8Array(await readFile(archivePath));
    expect(inspectPortableAppArchive(firstArchive).sourceManifest.slug).toBe("status-console");

    await rm(archivePath);
    expect(await runOgAppCli(["pack", "status"], output.io)).toBe(0);
    expect(new Uint8Array(await readFile(archivePath))).toEqual(firstArchive);
    expect(output.stderr).toEqual([]);
  });
});
