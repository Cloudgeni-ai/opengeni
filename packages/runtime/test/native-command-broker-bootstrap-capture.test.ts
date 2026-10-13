import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { captureNativeBrokerBootstrap } from "../src/sandbox/providers/native-command-broker-bootstrap-capture";
import {
  encodeNativeBrokerFrame,
  type NativeBrokerFrame,
} from "../src/sandbox/providers/native-command-broker-wire";
import type { NativeBrokerOutputPage } from "../src/sandbox/providers/native-command-broker-output";

const brokerId = "54f6dfdf-ae52-469c-b926-253f49213288";
const binary = Buffer.alloc(10000, 23);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pin = {
  artifactSha256: sha(binary),
  byteSize: binary.length,
  target: "linux-amd64" as const,
};
const identity = { sandboxId: "sb-bootstrap", taskId: "ta-bootstrap" };
function wire(data = binary) {
  const values = [
    {
      kind: "hello",
      offset: 0,
      payload: Buffer.from(
        JSON.stringify({
          protocol: "native-command-broker-v1",
          sealedExec: "execveat",
          pipeCapability: "native-subreaper-broker-channel-v1",
          ptyCapability: "native-subreaper-broker-channel-pty-v1",
          artifact: {
            byteSize: data.length,
            target: pin.target,
            seals: 15,
            device: "5",
            inode: "20",
          },
        }),
      ),
    },
  ];
  for (let offset = 0; offset < data.length; offset += 8192)
    values.push({ kind: "artifact", offset, payload: data.subarray(offset, offset + 8192) });
  return values
    .map((frame, index) =>
      encodeNativeBrokerFrame({
        direction: "response",
        brokerId,
        ownerEpoch: 1,
        sequence: index + 1,
        requestId: brokerId,
        commandId: null,
        ...frame,
      } as NativeBrokerFrame),
    )
    .map((value) => Buffer.from(value).toString("ascii"))
    .join("");
}
function page(data: string, entryId = "1-0"): NativeBrokerOutputPage {
  return {
    ...identity,
    requestedFileDescriptor: 1,
    entryId,
    items: [{ fileDescriptor: 1, data }],
    eof: false,
  };
}
function channel(pages: NativeBrokerOutputPage[]) {
  let reads = 0,
    closed = 0;
  return {
    ...identity,
    get reads() {
      return reads;
    },
    get closed() {
      return closed;
    },
    async *output(cursor: string, signal?: AbortSignal) {
      expect(cursor).toBe("0-0");
      expect(signal).toBeDefined();
      reads++;
      try {
        for (const value of pages) yield value;
      } finally {
        closed++;
      }
    },
  };
}
test("captures and verifies a fragmented initial prefix without writes or journal authority", async () => {
  const text = wire();
  const pages = Array.from({ length: Math.ceil(text.length / 1000) }, (_, index) =>
    page(text.slice(index * 1000, (index + 1) * 1000), `${index + 1}-0`),
  );
  const source = channel(pages);
  const result = await captureNativeBrokerBootstrap(source, brokerId, pin);
  expect(result.bootstrap).toMatchObject({
    commandAdmission: false,
    lastSequence: 3,
    artifactSha256: pin.artifactSha256,
    transcriptSha256: sha(text),
  });
  expect(result.initialState.input).toMatchObject({ pending: null, lastReservedInputIndex: 0 });
  expect(result.initialState.output).toMatchObject({
    cursor: `${pages.length}-0`,
    partialBase64: "",
    lastSequence: 3,
    providerEof: false,
  });
  expect(
    result.entries
      .filter((entry) => entry.kind === "frame")
      .map((entry) => entry.value)
      .join(""),
  ).toBe(text);
  expect(result.entries.filter((entry) => entry.kind === "page")).toHaveLength(pages.length);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.initialState.output)).toBe(true);
  expect(result.entries.every(Object.isFrozen)).toBe(true);
  expect(source.closed).toBe(1);
  pages[0]!.items[0]!.data = "changed";
  expect(result.entries.find((entry) => entry.kind === "page")!.value).not.toContain("changed");
});
test("maximum artifact size has a complete 33-frame prefix", async () => {
  const data = Buffer.alloc(256 * 1024, 21);
  const result = await captureNativeBrokerBootstrap(channel([page(wire(data))]), brokerId, {
    ...pin,
    artifactSha256: sha(data),
    byteSize: data.length,
  });
  expect(result.bootstrap.lastSequence).toBe(33);
});
test("exact repeated pages are idempotent; changed replays are not", async () => {
  const text = wire();
  const first = page(text.slice(0, 900));
  const last = page(text.slice(900), "2-0");
  const result = await captureNativeBrokerBootstrap(channel([first, first, last]), brokerId, pin);
  expect(result.entries.filter((entry) => entry.kind === "page")).toHaveLength(2);
  await expect(
    captureNativeBrokerBootstrap(channel([first, page("changed"), last]), brokerId, pin),
  ).rejects.toThrow();
});
test.each([
  (value: NativeBrokerOutputPage) => ({ ...value, sandboxId: "sb-other" }),
  (value: NativeBrokerOutputPage) => ({ ...value, taskId: "ta-other" }),
  (value: NativeBrokerOutputPage) => ({ ...value, eof: true }),
  (value: NativeBrokerOutputPage) => ({ ...value, requestedFileDescriptor: 2 }),
  (value: NativeBrokerOutputPage) => ({ ...value, items: [{ fileDescriptor: 2, data: wire() }] }),
  (value: NativeBrokerOutputPage) => ({
    ...value,
    items: [{ fileDescriptor: 1, data: wire() + "OGB1" }],
  }),
  (value: NativeBrokerOutputPage) => ({ ...value, extra: true }),
])("invalid initial output is never retained: %#", async (change) => {
  const source = channel([change(page(wire())) as NativeBrokerOutputPage]);
  await expect(captureNativeBrokerBootstrap(source, brokerId, pin)).rejects.toThrow();
  expect(source.closed).toBe(1);
});
test("an incomplete stream, wrong pin, extra frame and excess empty observations fail closed", async () => {
  await expect(
    captureNativeBrokerBootstrap(channel([page(wire().slice(0, 300))]), brokerId, pin),
  ).rejects.toThrow();
  await expect(
    captureNativeBrokerBootstrap(channel([page(wire())]), brokerId, {
      ...pin,
      artifactSha256: "f".repeat(64),
    }),
  ).rejects.toThrow();
  const extra = Buffer.from(
    encodeNativeBrokerFrame({
      direction: "response",
      brokerId,
      ownerEpoch: 1,
      sequence: 4,
      requestId: brokerId,
      commandId: null,
      kind: "status",
      offset: 0,
      payload: Buffer.from("{}"),
    }),
  ).toString("ascii");
  await expect(
    captureNativeBrokerBootstrap(channel([page(wire() + extra)]), brokerId, pin),
  ).rejects.toThrow();
  await expect(
    captureNativeBrokerBootstrap(
      channel(Array.from({ length: 129 }, () => page("", ""))),
      brokerId,
      pin,
    ),
  ).rejects.toThrow();
});
test("pre-abort makes zero reads; in-flight cancellation reaches the original output channel", async () => {
  const control = new AbortController();
  control.abort(new Error("fixture abort"));
  const source = channel([page(wire())]);
  await expect(captureNativeBrokerBootstrap(source, brokerId, pin, control.signal)).rejects.toThrow(
    "fixture abort",
  );
  expect(source.reads).toBe(0);
  const pending = new AbortController();
  let observed: AbortSignal | undefined;
  const capture = captureNativeBrokerBootstrap(
    {
      ...identity,
      async *output(_cursor, signal) {
        observed = signal;
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
        yield page(wire());
      },
    },
    brokerId,
    pin,
    pending.signal,
  );
  pending.abort(new Error("in-flight fixture abort"));
  await expect(capture).rejects.toThrow("in-flight fixture abort");
  expect(observed?.aborted).toBe(true);
});
