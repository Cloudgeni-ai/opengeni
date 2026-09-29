import { describe, expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import {
  RETAINED_PROCESS_OUTPUT_DRAIN_MAX_READS,
  drainRetainedCommandBacklog,
  retainedProcessReconciliationDeferral,
} from "../src/activities/sandbox-lease";

const PAGE = 1024 * 1024;

function cursor(stdout: number, exitCode: number | null = null): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-test",
    taskId: "task-test",
    execId: "792e06b2-03c7-40f0-baa7-a51cf4bddaf8",
    streams: {
      stdout: { byteOffset: stdout, utf8Remainder: "", eof: exitCode !== null, exitCode },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: exitCode !== null, exitCode },
    },
  };
}

/** A finished command whose output is `pages` provider pages long: every read
 * returns one page, and only the read that reaches EOF reports the exit. */
function backlogSession(pages: number, options: { failAtRead?: number } = {}) {
  const receipts = new Map<string, unknown>();
  let offset = 0,
    reads = 0,
    serial = 0;
  const page = (from: number, to: number, exitCode: number | null) => {
    const text =
      exitCode === null
        ? `Provider output receipt: ${serial++}\nProcess running with session ID 7\nOutput:\n`
        : `Provider output receipt: ${serial++}\nProcess exited with code ${exitCode}\nOutput:\n`;
    receipts.set(text, {
      command: cursor(to, exitCode),
      expected: cursor(from),
      chunks: [],
      exitCode,
    });
    return text;
  };
  const read = () => {
    reads++;
    if (options.failAtRead === reads) throw new Error("provider unavailable");
    const from = offset;
    offset = Math.min(pages * PAGE, offset + PAGE);
    return page(from, offset, offset === pages * PAGE ? 0 : null);
  };
  const session = {
    getProviderCommandOutput: (result: unknown) =>
      (typeof result === "string" ? receipts.get(result) : null) as never,
    writeStdin: async () => read(),
  };
  return { session, first: read(), reads: () => reads };
}

describe("retained command backlog drain", () => {
  test("a finished command's backlog settles within one claim", async () => {
    const { session, first, reads } = backlogSession(5);
    const captured: unknown[] = [];
    const result = await drainRetainedCommandBacklog(session, 7, first, async (value) => {
      captured.push(value);
    });
    expect(result).toEqual({
      status: "proved",
      proof: { outcome: "exited", exitCode: 0, reason: "provider_exit_banner" },
    });
    expect(reads()).toBe(5);
    expect(captured).toHaveLength(4);
  });

  test("a read that made no progress is not repeated", async () => {
    const receipts = new Map<string, unknown>();
    const idle = "Provider output receipt: 0\nProcess running with session ID 7\nOutput:\n";
    receipts.set(idle, { command: cursor(10), expected: cursor(10), chunks: [], exitCode: null });
    let reads = 0;
    const result = await drainRetainedCommandBacklog(
      {
        getProviderCommandOutput: (value: unknown) => receipts.get(value as string) as never,
        writeStdin: async () => {
          reads++;
          return idle;
        },
      },
      7,
      idle,
      async () => {},
    );
    expect(result).toEqual({ status: "deferred", reason: "provider_running" });
    expect(reads).toBe(0);
  });

  test("the per-claim read budget is bounded and progress is reported", async () => {
    const { session, first, reads } = backlogSession(RETAINED_PROCESS_OUTPUT_DRAIN_MAX_READS * 4);
    const result = await drainRetainedCommandBacklog(session, 7, first, async () => {});
    expect(result).toEqual({
      status: "deferred",
      reason: "provider_running",
      outputAdvanced: true,
    });
    expect(reads()).toBe(RETAINED_PROCESS_OUTPUT_DRAIN_MAX_READS + 1);
  });

  test("a provider failure mid-drain keeps the observation already made", async () => {
    const { session, first } = backlogSession(10, { failAtRead: 3 });
    const captured: unknown[] = [];
    const result = await drainRetainedCommandBacklog(session, 7, first, async (value) => {
      captured.push(value);
    });
    expect(result).toEqual({
      status: "deferred",
      reason: "provider_running",
      outputAdvanced: true,
    });
    expect(captured).toHaveLength(1);
  });
});

describe("retained command retry while output drains", () => {
  const settings = { sandboxLeaseReaperPeriodMs: 30_000 };

  test("a running command whose output advanced is re-read at the reaper cadence", () => {
    expect(
      retainedProcessReconciliationDeferral(
        settings,
        { reconcileAttempts: 40 },
        "provider_running",
        true,
      ).retryAfterMs,
    ).toBe(30_000);
  });

  test("a quiet running command keeps the bounded exponential backoff", () => {
    expect(
      retainedProcessReconciliationDeferral(settings, { reconcileAttempts: 40 }, "provider_running")
        .retryAfterMs,
    ).toBe(300_000);
    expect(
      retainedProcessReconciliationDeferral(
        settings,
        { reconcileAttempts: 40 },
        "provider_error",
        true,
      ).retryAfterMs,
    ).toBe(300_000);
  });
});
