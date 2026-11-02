import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import { TurnSandboxCommandCancelledError } from "../src/sandbox/turn-tool-cancellation";
import { SynchronousCommandOutcomeUnknownError } from "../src/sandbox/synchronous-command";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(tracked: boolean) {
  const root = mkdtempSync(join(tmpdir(), "opengeni-git-fanout-"));
  roots.push(root);
  const run = (args: string[]) => {
    const p = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(Buffer.from(p.stderr).toString());
  };
  run(["git", "init", "-q"]);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "baseline",
  ]);
  const count = 36;
  for (let i = 0; i < count; i++) writeFileSync(join(root, `file-${i}.txt`), "baseline\n");
  if (tracked) {
    run(["git", "add", "."]);
    run([
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "files",
    ]);
  }
  for (let i = 0; i < count; i++)
    writeFileSync(
      join(root, `file-${i}.txt`),
      `${"changed line".padEnd(1_024, "x")}\n`.repeat(1_100),
    );
  return { root, count };
}

for (const tracked of [true, false]) {
  for (const failure of [null, "unknown", "cancelled", "owner_abort"] as const) {
    const fail = failure !== null;
    test(`oversized ${tracked ? "tracked" : "untracked"} Git review ${fail ? `joins ${failure} without starting queued files` : "reads every file with bounded provider concurrency"}`, async () => {
      const { root, count } = fixture(tracked);
      const spoolRoot = mkdtempSync(join(tmpdir(), "opengeni-git-fanout-spools-"));
      roots.push(spoolRoot);
      let active = 0;
      let peak = 0;
      let started = 0;
      const owner = new AbortController();
      const service = new SandboxChannelAService({
        workspaceRoot: root,
        signal: owner.signal,
        session: {
          exec: async (args) => {
            // The initial combined reads contain no individual filename. Observe
            // the real per-file fallback without replacing Git or its framing.
            const perFile = /file-\d+\.txt/.test(args.cmd);
            if (perFile) {
              started++;
              active++;
              peak = Math.max(peak, active);
              if (failure === "owner_abort" && started === 4) owner.abort("new turn");
            }
            try {
              if (perFile && fail && failure !== "owner_abort") {
                await Bun.sleep(25);
                if (failure === "cancelled") throw new TurnSandboxCommandCancelledError("new turn");
                throw new SynchronousCommandOutcomeUnknownError(null, { stdout: "", stderr: "" });
              }
              const p = Bun.spawn(["/bin/bash", "-c", args.cmd], {
                cwd: root,
                env: { ...process.env, TMPDIR: spoolRoot },
                stdout: "pipe",
                stderr: "pipe",
              });
              const [stdout, stderr, exitCode] = await Promise.all([
                new Response(p.stdout).text(),
                new Response(p.stderr).text(),
                p.exited,
              ]);
              return { stdout, stderr, exitCode };
            } finally {
              if (perFile) active--;
            }
          },
        },
      });
      const request = service.gitDiff({
        path: "",
        fromRef: "HEAD",
        staged: false,
        includeUntracked: !tracked,
        pathspec: [],
        contextLines: 3,
        maxBytesPerFile: 2 * 1024 * 1024,
      });
      if (fail) {
        await expect(request).rejects.toBeInstanceOf(
          failure === "cancelled" || failure === "owner_abort"
            ? TurnSandboxCommandCancelledError
            : SynchronousCommandOutcomeUnknownError,
        );
        expect(started).toBeLessThan(count);
        if (failure === "owner_abort") expect(started).toBe(4);
      } else {
        const result = await request;
        expect(result.files).toHaveLength(count);
        expect(result.files.every((file) => file.hunks.length > 0 && !file.truncated)).toBe(true);
      }
      expect(active).toBe(0);
      expect(readdirSync(spoolRoot)).toEqual([]);
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(4);
    }, 120_000);
  }
}
