import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "@openai/agents/sandbox";
import { RunloopSandboxSession } from "@openai/agents-extensions/sandbox/runloop";
import { ExecutionResult } from "@runloop/api-client";
import { executeSynchronousCommand } from "../src/sandbox/synchronous-command";
import type { ChannelASession } from "../src/sandbox/channel-a";

function fixture(
  truncated: boolean,
  fault?: "missing-exit" | "stdout-loss" | "stderr-loss",
  nativeEnvironment: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "runloop-synchronous-collection-"));
  let starts = 0;
  const reads = { stdout: 0, stderr: 0 };
  const executionId = crypto.randomUUID();
  let command = "";
  let raw: ExecutionResult | undefined;
  const stream = async function* (
    name: "stdout" | "stderr",
    text: string,
    devbox: string,
    execution: string,
  ) {
    expect(devbox).toBe("db-stream");
    expect(execution).toBe(executionId);
    reads[name]++;
    yield { output: text.slice(0, 3) };
    if (fault === `${name}-loss`) throw new Error("original execution log transport lost");
    yield { output: text.slice(3) };
  };
  const session = new RunloopSandboxSession({
    state: {
      devboxId: "db-stream",
      manifest: new Manifest({ root }),
      pauseOnExit: false,
      environment: { CAPTURE_MODE: "original" },
    },
    sdk: {
      devbox: {
        create: async () => {
          throw new Error("must not provision");
        },
        createFromBlueprintName: async () => {
          throw new Error("must not provision");
        },
        fromId: () => {
          throw new Error("must not reconnect");
        },
      },
    },
    devbox: {
      id: "db-stream",
      cmd: {
        exec: async (source, params) => {
          expect(params?.last_n).toBe("2000");
          starts++;
          command = source;
          const child = Bun.spawn(["/bin/sh", "-c", source], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...nativeEnvironment },
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          // The actual native ExecutionResult owns the truncation/full-log
          // decision. Only its public original-execution stream endpoints are
          // stubbed; no trusted page or replacement output method is invented.
          const client = {
            devboxes: {
              executions: {
                streamStdoutUpdates: async (devbox: string, execution: string) =>
                  stream("stdout", stdout, devbox, execution),
                streamStderrUpdates: async (devbox: string, execution: string) =>
                  stream("stderr", stderr, devbox, execution),
              },
            },
          };
          raw = new ExecutionResult(
            client as ConstructorParameters<typeof ExecutionResult>[0],
            "db-stream",
            executionId,
            {
              devbox_id: "db-stream",
              execution_id: executionId,
              status: "completed",
              exit_status: fault === "missing-exit" ? null : exitCode,
              stdout: truncated ? "native stdout tail" : stdout,
              stderr: truncated ? "native stderr tail" : stderr,
              stdout_truncated: truncated,
              stderr_truncated: truncated,
            },
          );
          return raw;
        },
      },
      file: {
        read: async () => "",
        write: async () => {},
        download: async () => ({}),
        upload: async () => {},
      },
      resume: async () => {},
      suspend: async () => {},
      shutdown: async () => {},
    },
  });
  return {
    session,
    reads,
    starts: () => starts,
    command: () => command,
    raw: () => raw,
    executionId,
    close: async () => {
      try {
        await session.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test.each([
  [false, 1, 0],
  [false, 10_000, 7],
  [true, 1, 0],
  [true, 10_000, 0],
  [true, 1, 7],
  [true, 10_000, 7],
] as const)(
  "real Runloop ExecutionResult preserves full bytes at truncated %s, tokens %s and exit %s",
  async (truncated, maxOutputTokens, exitCode) => {
    const source = fixture(truncated);
    const stdout = `original\n🙂${"out\n".repeat(6_000)}\n`;
    const stderr = `  🙂${"err\n".repeat(6_000)}\n\n`;
    const command = `printf '%s\\n' "$CAPTURE_MODE"; printf '🙂'; i=0; while [ "$i" -lt 6000 ]; do printf 'out\\n'; i=$((i+1)); done; printf '\\n'; printf '  🙂' >&2; i=0; while [ "$i" -lt 6000 ]; do printf 'err\\n' >&2; i=$((i+1)); done; printf '\\n\\n' >&2; exit ${exitCode}`;
    try {
      const result = await executeSynchronousCommand(source.session, {
        cmd: command,
        maxOutputTokens,
      });
      expect(result).toMatchObject({ stdout, stderr, exitCode });
      expect(source.starts()).toBe(1);
      expect(source.command()).toContain(command);
      expect(source.command()).not.toContain("__OPENGENI_FS_COMPLETION_");
      expect(source.raw()?.executionId).toBe(source.executionId);
      expect(source.reads).toEqual({ stdout: truncated ? 1 : 0, stderr: truncated ? 1 : 0 });
    } finally {
      await source.close();
    }
  },
);

test.each(["missing-exit", "stdout-loss", "stderr-loss"] as const)(
  "real Runloop ExecutionResult %s remains unknown on the original execution without replay",
  async (fault) => {
    const source = fixture(true, fault);
    try {
      await expect(
        executeSynchronousCommand(source.session, {
          cmd: "printf original; printf diagnostic >&2",
          maxOutputTokens: 1,
        }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
      expect(source.starts()).toBe(1);
      expect(source.reads).toEqual({ stdout: 1, stderr: 1 });
      expect(source.raw()?.executionId).toBe(source.executionId);
      expect(source.command()).not.toContain("__OPENGENI_FS_COMPLETION_");
    } finally {
      await source.close();
    }
  },
);

test("the actual Runloop full-log path does not introduce a Python prerequisite", async () => {
  const source = fixture(true, undefined, { PATH: "" });
  source.session.state.environment.PATH = "";
  try {
    expect(
      await executeSynchronousCommand(source.session, {
        cmd: "printf original; printf diagnostic >&2",
        maxOutputTokens: 1,
      }),
    ).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
    expect(source.starts()).toBe(1);
    expect(source.reads).toEqual({ stdout: 1, stderr: 1 });
    expect(source.command()).not.toContain("__OPENGENI_FS_COMPLETION_");
  } finally {
    await source.close();
  }
});

test("ordinary Runloop SDK presentation remains outside trusted filesystem collection", async () => {
  const source = fixture(true);
  try {
    expect(
      await executeSynchronousCommand(source.session, {
        cmd: "printf original; printf diagnostic >&2",
        maxOutputTokens: 1,
      }),
    ).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
    const ordinary = await source.session.execCommand({
      cmd: "printf ordinary; printf diagnostic >&2",
      maxOutputTokens: 1,
    });
    expect(ordinary).not.toStartWith("Native output receipt:");
    expect((source.session as ChannelASession).getSynchronousCommandOutput!(ordinary)).toBeNull();
    expect(source.starts()).toBe(2);
    expect(source.reads).toEqual({ stdout: 2, stderr: 2 });
  } finally {
    await source.close();
  }
});
