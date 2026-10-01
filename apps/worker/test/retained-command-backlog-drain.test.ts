import { describe, expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { ModalCommandControl } from "../../../packages/runtime/src/sandbox/providers/modal-command-control";
import { MODAL_ROUTER_READ_PAGE_BYTES as PAGE } from "../../../packages/runtime/src/sandbox/providers/modal-command-router-wire";
import { installModalCommandSession } from "../../../packages/runtime/src/sandbox/providers/modal-command-session";
import type { ChannelASession } from "../../../packages/runtime/src/sandbox/channel-a";
import type { ProviderCommandSession } from "../../../packages/runtime/src/sandbox/provider-command-session";
import {
  RETAINED_PROCESS_OUTPUT_DRAIN_MAX_READS,
  drainRetainedCommandBacklog,
  retainedProcessReconciliationDeferral,
} from "../src/activities/sandbox-lease";

const locator = (): ModalRouterProviderCommand => ({
  kind: "modal-router-v1",
  sandboxId: "sb-test",
  taskId: "task-test",
  execId: "792e06b2-03c7-40f0-baa7-a51cf4bddaf8",
  streams: {
    stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
  },
});

/** The real Modal command control and session adapter over a router that
 * holds `total` bytes of already-written stdout. The command has exited, but
 * as on Modal, its exit is reported only once stdout is read to EOF. A
 * trickling command instead gains 1 KiB per read and never ends. */
function retainedCommand(
  total: number,
  options: { trickle?: boolean; failAtRead?: number; readBytes?: number } = {},
) {
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-test" }) },
    } as never,
    "sb-test",
    "/workspace",
  );
  let reads = 0;
  Object.defineProperty(control, "withRouter", {
    value: async (_task: string, _signal: unknown, run: (router: unknown) => unknown) =>
      await run({
        read: async (_identity: unknown, stream: string, offset: number) => {
          if (stream === "stderr") return { bytes: Buffer.alloc(0), eof: true };
          reads++;
          if (options.failAtRead === reads) throw new Error("provider unavailable");
          const size = options.trickle ? 1024 : Math.min(options.readBytes ?? PAGE, total - offset);
          return {
            bytes: Buffer.alloc(size, 120),
            eof: !options.trickle && offset + size >= total,
          };
        },
        poll: async () => (options.trickle ? null : 0),
      }),
  });
  const session = {} as ChannelASession & ProviderCommandSession;
  installModalCommandSession(session, control);
  let stored = locator();
  let recorded = "";
  session.bindProviderCommand!(7, stored, {
    load: async () => stored,
    acknowledge: async () => {
      throw new Error("byte-offset output never uses the legacy acknowledgement");
    },
    reserveInput: async () => 0,
    captureRouterPage: async (page) => {
      recorded += page.stdout;
      stored = page.command as ModalRouterProviderCommand;
      return { command: stored, captured: true };
    },
  });
  // The reaper's capture step for a byte-offset page: the page was committed
  // during the read, and confirming it consumes the in-memory receipt.
  const capturePage = async (value: unknown) => {
    if (!(await session.captureCommandOutput!(value as string)))
      throw new Error("Byte-offset output requires atomic capture before settlement");
  };
  const probe = async (budget?: { until: number }) =>
    await drainRetainedCommandBacklog(
      session as never,
      7,
      await session.writeStdin!({ sessionId: 7, chars: "", yieldTimeMs: 1000 }),
      capturePage,
      budget,
    );
  return {
    probe,
    reads: () => reads,
    recorded: () => recorded,
    offset: () => stored.streams.stdout.byteOffset,
  };
}

describe("retained command backlog drain", () => {
  test("a finished command's backlog settles within one claim", async () => {
    const command = retainedCommand(5 * PAGE);
    expect(await command.probe()).toEqual({
      status: "proved",
      proof: { outcome: "exited", exitCode: 0, reason: "provider_exit_banner" },
    });
    expect(command.reads()).toBe(5);
    expect(command.offset()).toBe(5 * PAGE);
    expect(command.recorded()).toHaveLength(5 * PAGE);
  });

  test("a command that only trickles output is not re-read and keeps its backoff", async () => {
    const command = retainedCommand(0, { trickle: true });
    expect(await command.probe()).toEqual({ status: "deferred", reason: "provider_running" });
    expect(command.reads()).toBe(1);
  });

  test("the per-claim read budget is bounded and the remaining backlog is reported", async () => {
    const command = retainedCommand(64 * PAGE);
    expect(await command.probe()).toEqual({
      status: "deferred",
      reason: "provider_running",
      outputBacklog: true,
    });
    expect(command.reads()).toBe(RETAINED_PROCESS_OUTPUT_DRAIN_MAX_READS + 1);
    expect(command.offset()).toBe((RETAINED_PROCESS_OUTPUT_DRAIN_MAX_READS + 1) * PAGE);
  });

  test("an exhausted sweep budget stops further reads but keeps the backlog signal", async () => {
    const command = retainedCommand(64 * PAGE);
    expect(await command.probe({ until: Date.now() - 1 })).toEqual({
      status: "deferred",
      reason: "provider_running",
      outputBacklog: true,
    });
    expect(command.reads()).toBe(1);
  });

  test("a provider failure mid-drain keeps the observation already made", async () => {
    const command = retainedCommand(64 * PAGE, { failAtRead: 3 });
    expect(await command.probe()).toEqual({
      status: "deferred",
      reason: "provider_running",
      outputBacklog: true,
    });
    expect(command.offset()).toBe(2 * PAGE);
  });

  test("a finished command is read to exit even when each read returns little", async () => {
    // A cold connection or slow provider can return short pages; the provider's
    // exit report, not the page size, says only unread output remains.
    const command = retainedCommand(PAGE, { readBytes: 200 * 1024 });
    expect(await command.probe()).toMatchObject({
      status: "proved",
      proof: { outcome: "exited", exitCode: 0 },
    });
    expect(command.reads()).toBe(6);
  });

  test("live output returned to the agent is not capped by the recording limit", async () => {
    const command = retainedCommand(20 * PAGE);
    let result = await command.probe();
    while (result.status === "deferred") result = await command.probe();
    expect(result).toMatchObject({ status: "proved", proof: { outcome: "exited", exitCode: 0 } });
    expect(command.offset()).toBe(20 * PAGE);
    expect(command.recorded()).toHaveLength(20 * PAGE);
  });
});

describe("retained command retry while output drains", () => {
  const settings = { sandboxLeaseReaperPeriodMs: 30_000 };

  test("a command with a remaining backlog is re-read at the reaper cadence", () => {
    expect(
      retainedProcessReconciliationDeferral(
        settings,
        { reconcileAttempts: 40 },
        "provider_running",
        true,
      ).retryAfterMs,
    ).toBe(30_000);
  });

  test("a quiet running command and provider failures keep the bounded backoff", () => {
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
