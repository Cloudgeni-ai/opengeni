import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { withProviderCommandHandle } from "../src/sandbox/provider-command-session";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  executeSynchronousCommand,
  SynchronousCommandOutcomeUnknownError,
} from "../src/sandbox/synchronous-command";
import {
  withNativeSynchronousCommandCollection,
  withoutNativeSynchronousCommandCollection,
} from "../src/sandbox/native-synchronous-collection";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";

function fixture(stdout: string, stderr: string, exitCode = 0, eof = true, readError = false) {
  let starts = 0;
  let reads = 0;
  let receipt = "";
  const session: ChannelASession = {};
  installModalCommandSession(session, {
    start: async () => {
      starts++;
      return {
        kind: "modal-router-v1",
        sandboxId: "sb-synthetic",
        taskId: "task-synthetic",
        execId: `exec-${starts}`,
        streams: {
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      };
    },
    read: async (value) => {
      reads++;
      if (readError) throw new Error("synthetic read unavailable");
      const command = structuredClone(value) as ModalRouterProviderCommand;
      for (const stream of ["stdout", "stderr"] as const) {
        command.streams[stream].byteOffset = Buffer.byteLength(
          stream === "stdout" ? stdout : stderr,
        );
        command.streams[stream].eof = eof;
        command.streams[stream].exitCode = exitCode;
      }
      return {
        command,
        expected: value as ModalRouterProviderCommand,
        chunks: [
          { stream: "stdout" as const, chunkId: "stdout", text: stdout },
          { stream: "stderr" as const, chunkId: "stderr", text: stderr },
        ],
        exitCode,
      };
    },
    readProbe: async () => {
      throw new Error("unexpected probe");
    },
    write: async () => {
      throw new Error("unexpected input write");
    },
  });
  const exec = session.execCommand!.bind(session);
  session.execCommand = async (args) => (receipt = await exec(args));
  return { session, starts: () => starts, reads: () => reads, receipt: () => receipt };
}

for (const [name, stdout, stderr, exitCode] of [
  [
    "separate full streams despite presentation truncation",
    "result €".repeat(1000),
    "diagnostic".repeat(500),
    0,
  ],
  ["empty successful output", "", "", 0],
  ["nonzero exit", "partial result", "failed", 7],
] as const) {
  test(`fast terminal Modal synchronous command preserves ${name}`, async () => {
    const f = fixture(stdout, stderr, exitCode);
    const result = await withProviderCommandHandle(73, () =>
      executeSynchronousCommand(f.session, { cmd: "synthetic", maxOutputTokens: 1 }),
    );
    expect(result).toMatchObject({ stdout, stderr, exitCode });
    expect(f.starts()).toBe(1);
    expect(f.reads()).toBe(1);
    expect(f.session.getProviderCommand!(73)).toBeNull();
    expect(f.session.getProviderCommandOutput!(f.receipt())).toBeNull();
  });
}

test("fast terminal receipt lives through routing snapshot and settlement, then is released", async () => {
  const f = fixture("protocol output", "stderr");
  let settled = 0;
  const proxy = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({ session: f.session, sandboxId: null, kind: "modal" }),
    beforeMutation: async () => ({}),
    providerCommandHandle: () => 74,
    afterMutation: async () => {
      settled++;
      expect(f.session.getProviderCommandOutput!(f.receipt())?.chunks[0]?.text).toBe(
        "protocol output",
      );
    },
  });
  expect(await executeSynchronousCommand(proxy, { cmd: "synthetic" })).toMatchObject({
    stdout: "protocol output",
    stderr: "stderr",
    exitCode: 0,
  });
  expect(settled).toBe(1);
  expect(f.starts()).toBe(1);
  expect(f.session.getProviderCommandOutput!(f.receipt())).toBeNull();
});

test("incomplete EOF and read failure stay unknown without a second Start", async () => {
  for (const failRead of [false, true]) {
    const f = fixture("partial", "", 0, false, failRead);
    await expect(
      withProviderCommandHandle(75, () =>
        executeSynchronousCommand(f.session, { cmd: "synthetic" }),
      ),
    ).rejects.toBeInstanceOf(SynchronousCommandOutcomeUnknownError);
    expect(f.starts()).toBe(1);
    expect(f.reads()).toBe(1);
    if (!failRead) expect(f.session.getProviderCommandOutput!(f.receipt())).toBeNull();
    else expect(f.session.getProviderCommand!(75)?.execId).toBe("exec-1");
  }
});

test("terminal collection clears on rejection and cannot be forged or seen through another session", async () => {
  const f = fixture("trusted", "");
  const other = fixture("other", "");
  await expect(
    withNativeSynchronousCommandCollection(f.session, async () => {
      await withProviderCommandHandle(76, () => f.session.execCommand!({ cmd: "synthetic" }));
      expect(f.session.getProviderCommandOutput!(f.receipt())?.chunks[0]?.text).toBe("trusted");
      expect(f.session.getProviderCommandOutput!(f.receipt() + "forged")).toBeNull();
      expect(other.session.getProviderCommandOutput!(f.receipt())).toBeNull();
      throw new Error("output rejected");
    }),
  ).rejects.toThrow("output rejected");
  expect(f.session.getProviderCommandOutput!(f.receipt())).toBeNull();
});

test("ordinary non-collection terminal commands do not accumulate transient receipts", async () => {
  const f = fixture("ordinary", "");
  for (let handle = 80; handle < 100; handle++) {
    await withProviderCommandHandle(handle, () => f.session.execCommand!({ cmd: "synthetic" }));
    expect(f.session.getProviderCommand!(handle)).toBeNull();
    expect(f.session.getProviderCommandOutput!(f.receipt())).toBeNull();
  }
});

test("concurrent collectors on the same backend isolate receipts and exact cleanup", async () => {
  const f = fixture("concurrent", "");
  const receipts: string[] = [];
  let ready!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  await Promise.all(
    [101, 102].map((handle) =>
      withNativeSynchronousCommandCollection(f.session, async () => {
        const raw = await withProviderCommandHandle(handle, () =>
          f.session.execCommand!({ cmd: "synthetic" }),
        );
        receipts.push(raw);
        if (receipts.length === 2) ready();
        await bothReady;
        expect(f.session.getProviderCommandOutput!(raw)?.exitCode).toBe(0);
        expect(
          f.session.getProviderCommandOutput!(receipts.find((value) => value !== raw)!),
        ).toBeNull();
        expect(
          withoutNativeSynchronousCommandCollection(() => f.session.getProviderCommandOutput!(raw)),
        ).toBeNull();
        expect(f.session.getProviderCommandOutput!(raw)?.exitCode).toBe(0);
      }),
    ),
  );
  for (const raw of receipts) expect(f.session.getProviderCommandOutput!(raw)).toBeNull();
  expect(f.starts()).toBe(2);
});

test("a callback inheriting a finished scope cannot retain new terminal pages", async () => {
  const f = fixture("late", "");
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let late!: Promise<void>;
  await withNativeSynchronousCommandCollection(f.session, async () => {
    late = gate.then(async () => {
      const raw = await withProviderCommandHandle(103, () =>
        f.session.execCommand!({ cmd: "synthetic" }),
      );
      expect(f.session.getProviderCommandOutput!(raw)).toBeNull();
    });
  });
  resume();
  await late;
});
