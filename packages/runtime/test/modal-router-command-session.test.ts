import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  type ProviderCommandSession,
  withProviderCommandHandle,
} from "../src/sandbox/provider-command-session";
import type { ChannelASession } from "../src/sandbox/channel-a";

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

test("a failed first read retains identity without inventing an output capture", async () => {
  const session: ChannelASession & ProviderCommandSession = {};
  const command = locator();
  let reads = 0,
    starts = 0,
    captures = 0;
  installModalCommandSession(session, {
    start: async () => {
      starts++;
      return command;
    },
    read: async (value) => {
      if (reads++ === 0) throw new Error("observation unavailable");
      return {
        command: value,
        expected: value as ModalRouterProviderCommand,
        chunks: [],
        exitCode: null,
      };
    },
    readProbe: async () => {
      throw new Error("unexpected probe");
    },
    write: async () => {},
  });
  const first = await withProviderCommandHandle(3, () => session.execCommand!({ cmd: "work" }));
  session.bindProviderCommand!(3, command, {
    load: async () => command,
    acknowledge: async () => {
      throw new Error("unexpected legacy acknowledgement");
    },
    reserveInput: async () => 0,
    captureRouterPage: async (page) => {
      captures++;
      return { command: page.command, captured: true };
    },
  });
  expect(await session.captureCommandOutput!(first)).toBe(true);
  expect(captures).toBe(0);
  expect(session.getProviderCommand!(3)).toEqual(command);
  const next = await session.writeStdin!({ sessionId: 3, chars: "", yieldTimeMs: 1 });
  expect(await session.captureCommandOutput!(next)).toBe(true);
  expect(captures).toBe(1);
  expect(starts).toBe(1);
});

test("byte-offset sessions atomically capture before acknowledging or replaying", async () => {
  const session: ChannelASession & ProviderCommandSession = {};
  let stored = locator(),
    failCapture = true,
    commits = 0,
    reads = 0;
  const output = "hello €";
  installModalCommandSession(session, {
    start: async () => locator(),
    read: async (value) => {
      reads++;
      if (value.kind !== "modal-router-v1") throw new Error("unexpected legacy identity");
      const command = structuredClone(value);
      command.streams.stdout = {
        byteOffset: Buffer.byteLength(output),
        utf8Remainder: "",
        eof: true,
        exitCode: 0,
      };
      command.streams.stderr = { byteOffset: 0, utf8Remainder: "", eof: true, exitCode: 0 };
      return {
        command,
        expected: value,
        exitCode: 0,
        chunks: [{ stream: "stdout", chunkId: "provider-page", text: output }],
      };
    },
    readProbe: async () => {
      throw new Error("not a materialization test");
    },
    write: async () => {},
  });
  // Force a yielded command so its original locator can be bound before reading.
  session.bindProviderCommand!(1, stored, {
    load: async () => stored,
    acknowledge: async () => {
      throw new Error("legacy append/ack must not run");
    },
    reserveInput: async () => 0,
    captureRouterPage: async (page) => {
      if (failCapture) throw new Error("database unavailable");
      expect(page.stdout).toBe(output);
      expect(page.stderr).toBe("");
      stored = page.command;
      commits++;
      return { command: stored, captured: true };
    },
  });
  await expect(session.writeStdin!({ sessionId: 1, chars: "", yieldTimeMs: 250 })).rejects.toThrow(
    "database unavailable",
  );
  expect(stored.streams.stdout.byteOffset).toBe(0);
  failCapture = false;
  const receipt = await session.writeStdin!({ sessionId: 1, chars: "", yieldTimeMs: 250 });
  expect(await session.captureCommandOutput!(receipt)).toBe(true);
  expect(reads).toBe(2);
  expect(commits).toBe(1);
  expect(stored.streams.stdout.byteOffset).toBe(Buffer.byteLength(output));
  expect(session.getProviderCommandOutput!(receipt)).toBeNull();
});

test("stdin reserves byte count and cursor-CAS loss adopts the winning cursor", async () => {
  const session: ChannelASession & ProviderCommandSession = {};
  let reserved: number | undefined, written: number | undefined;
  const original = locator();
  const winner = structuredClone(original);
  winner.streams.stdout.byteOffset = 20;
  let captures = 0;
  installModalCommandSession(session, {
    start: async () => original,
    read: async (command) => ({
      command,
      expected: command as ModalRouterProviderCommand,
      exitCode: null,
      chunks: [],
    }),
    readProbe: async () => {
      throw new Error("not a materialization test");
    },
    write: async (_command, _chars, offset) => {
      written = offset;
    },
  });
  session.bindProviderCommand!(2, original, {
    load: async () => original,
    acknowledge: async () => {
      throw new Error("legacy acknowledgment forbidden");
    },
    reserveInput: async (byteLength) => {
      reserved = byteLength;
      return 17;
    },
    captureRouterPage: async () => ({ command: winner, captured: ++captures > 1 }),
  });
  const receipt = await session.writeStdin!({ sessionId: 2, chars: "€", yieldTimeMs: 250 });
  expect(reserved).toBe(3);
  expect(written).toBe(17);
  expect(await session.captureCommandOutput!(receipt)).toBe(true);
  expect(session.getProviderCommand!(2)).toEqual(winner);
});
