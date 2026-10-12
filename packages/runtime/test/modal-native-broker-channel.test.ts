import { expect, test } from "bun:test";
import { ModalNativeBrokerChannel } from "../src/sandbox/providers/modal-native-broker-channel";
import { ModalClient } from "modal";

function fixture(extra: Record<string, unknown> = {}) {
  const calls: { kind: string; input: unknown; signal?: AbortSignal }[] = [];
  let closed = 0;
  const port = {
    async sandboxGetTaskId(input: unknown, options: { signal: AbortSignal }) {
      calls.push({ kind: "task", input, signal: options.signal });
      return { taskId: "ta-exact" };
    },
    async sandboxStdinWrite(input: unknown, options: { signal: AbortSignal }) {
      calls.push({ kind: "write", input, signal: options.signal });
    },
    async *sandboxGetLogs(input: unknown, options: { signal: AbortSignal }) {
      calls.push({ kind: "logs", input, signal: options.signal });
      yield { entryId: "2-0", items: [{ fileDescriptor: 1, data: "frame" }], eof: false };
      yield { entryId: "", items: [], eof: true };
    },
    ...extra,
  };
  const channel = new ModalNativeBrokerChannel(
    port as never,
    { sandboxId: "sb-exact", taskId: "ta-exact" },
    () => closed++,
  );
  return { calls, channel, closed: () => closed };
}
const input = () => ({ index: 7, input: Buffer.from("opaque exact wire\n"), eof: false as const });

test("one indexed write uses the exact initial task and never terminates initial stdin", async () => {
  const f = fixture();
  await f.channel.write(input());
  expect(f.calls.map((call) => call.kind)).toEqual(["task", "write"]);
  expect(f.calls[1]!.input).toEqual({ sandboxId: "sb-exact", ...input() });
  expect(f.calls[0]!.signal).toBe(f.calls[1]!.signal);
});

test("mismatched and terminal initial tasks cause zero writes", async () => {
  for (const response of [
    { taskId: "other" },
    { taskId: "ta-exact", taskResult: { exitcode: 0 } },
    {},
  ]) {
    const f = fixture({ sandboxGetTaskId: async () => response });
    await expect(f.channel.write(input())).rejects.toThrow("no longer matches");
    expect(f.calls).toHaveLength(0);
  }
});

test("unknown write has exactly one call and preserves original error", async () => {
  let calls = 0;
  const failure = new Error("private transport failure");
  const f = fixture({
    sandboxStdinWrite: async () => {
      calls++;
      throw failure;
    },
  });
  await expect(f.channel.write(input())).rejects.toBe(failure);
  expect(calls).toBe(1);
});

test("zero, wrapped index, oversized body and initial EOF fail before provider calls", async () => {
  const f = fixture();
  for (const change of [
    { index: 0 },
    { index: 0x100000000 },
    { index: 1.5 },
    { input: Buffer.alloc(12289) },
    { input: Buffer.alloc(0) },
    { eof: true },
  ]) {
    await expect(f.channel.write({ ...input(), ...change } as never)).rejects.toThrow("Invalid");
  }
  expect(f.calls).toHaveLength(0);
});

test("preaborted observation/write does not touch the provider; in-flight abort reaches it", async () => {
  const controller = new AbortController();
  const f = fixture();
  controller.abort(new Error("closed caller"));
  await expect(f.channel.write(input(), controller.signal)).rejects.toThrow("closed caller");
  await expect(f.channel.output("0-0", controller.signal).next()).rejects.toThrow("closed caller");
  expect(f.calls).toHaveLength(0);
  const during = new AbortController();
  const active = fixture({
    sandboxGetTaskId: async (_input: unknown, options: { signal: AbortSignal }) => {
      during.abort(new Error("interrupted"));
      expect(options.signal.aborted).toBe(true);
      return { taskId: "ta-exact" };
    },
  });
  await expect(active.channel.write(input(), during.signal)).rejects.toThrow("interrupted");
  expect(active.calls).toHaveLength(0);
});

test("stdout pages retain exact cursor and empty cursor-less EOF without inventing command exits", async () => {
  const f = fixture();
  const pages = [];
  for await (const page of f.channel.output("1-0")) pages.push(page);
  expect(f.calls[0]!.input).toEqual({
    sandboxId: "sb-exact",
    fileDescriptor: 1,
    timeout: 55,
    lastEntryId: "1-0",
  });
  expect(pages).toEqual([
    {
      sandboxId: "sb-exact",
      taskId: "ta-exact",
      requestedFileDescriptor: 1,
      entryId: "2-0",
      items: [{ fileDescriptor: 1, data: "frame" }],
      eof: false,
    },
    {
      sandboxId: "sb-exact",
      taskId: "ta-exact",
      requestedFileDescriptor: 1,
      entryId: "",
      items: [],
      eof: true,
    },
  ]);
});

test("foreign descriptors cannot be relabelled as initial stdout", async () => {
  const f = fixture({
    async *sandboxGetLogs() {
      yield { entryId: "1-0", items: [{ fileDescriptor: 2, data: "error" }], eof: false };
    },
  });
  await expect(f.channel.output("0-0").next()).rejects.toThrow("foreign stream");
});

test("close releases only its own host connection, exactly once", async () => {
  const f = fixture();
  f.channel.close();
  f.channel.close();
  expect(f.closed()).toBe(1);
  await expect(f.channel.write(input())).rejects.toThrow("closed");
  await expect(f.channel.output("0-0").next()).rejects.toThrow("closed");
  expect(f.calls).toHaveLength(0);
});

test("production factory requires original authenticated profile and exact SDK", () => {
  expect(() =>
    ModalNativeBrokerChannel.fromClient({ version: () => "0.10.0" } as ModalClient, {
      sandboxId: "sb-exact",
      taskId: "ta-exact",
    }),
  ).toThrow("Verified");
  expect(() =>
    ModalNativeBrokerChannel.fromClient({ version: () => "0.9.0" } as ModalClient, {
      sandboxId: "sb-exact",
      taskId: "ta-exact",
    }),
  ).toThrow("authenticated");
});
