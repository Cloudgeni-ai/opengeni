import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { reduceModalRawOutputPage, type ModalRawOutputPage } from "@opengeni/runtime/sandbox";
import { collectModalRawOutputPage } from "../src/sandbox/providers/modal-command-raw-page";
import { MODAL_ROUTER_READ_PAGE_BYTES } from "../src/sandbox/providers/modal-command-router-wire";

function cursor(): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-original",
    taskId: "task-original",
    execId: "11111111-1111-4111-8111-111111111111",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}

function page(
  expected = cursor(),
  stdout: number[] = [],
  stderr: number[] = [],
  eof = false,
  code: number | null = null,
): ModalRawOutputPage {
  return collectModalRawOutputPage(
    expected,
    {
      stdout: { bytes: Uint8Array.from(stdout), eof },
      stderr: { bytes: Uint8Array.from(stderr), eof },
    },
    { source: "router_poll", code },
  ).raw;
}

test("raw split E2 82 plus AC advances each stream by its own received bytes", () => {
  const initial = cursor();
  const first = page(initial, [0xe2, 0x82], [0x41]);
  const partial = reduceModalRawOutputPage(first, initial);
  expect(partial.chunks.map((chunk) => [chunk.stream, chunk.text])).toEqual([["stderr", "A"]]);
  expect(partial.command.streams.stdout).toEqual({
    byteOffset: 2,
    utf8Remainder: "4oI=",
    eof: false,
    exitCode: null,
  });
  expect(partial.command.streams.stderr.byteOffset).toBe(1);
  const second = page(partial.command, [0xac], [], true, 0);
  const completed = reduceModalRawOutputPage(second, partial.command);
  expect(completed.chunks.map((chunk) => [chunk.stream, chunk.text])).toEqual([["stdout", "€"]]);
  expect(completed.command.streams.stdout.byteOffset).toBe(3);
  expect(completed.command.streams.stderr.byteOffset).toBe(1);
  expect(completed.command.streams.stdout.utf8Remainder).toBe("");
  expect(completed.exitCode).toBe(0);
  expect(initial).toEqual(cursor());
});

test("incomplete EOF flush emits replacement, never a missing AC byte", () => {
  const expected = cursor();
  expected.streams.stdout.byteOffset = 2;
  expected.streams.stdout.utf8Remainder = "4oI=";
  const output = reduceModalRawOutputPage(page(expected, [], [], true, 0), expected);
  expect(output.chunks.map((chunk) => chunk.text)).toEqual(["�"]);
  expect(output.command.streams.stdout.byteOffset).toBe(2);
  expect(output.command.streams.stdout.utf8Remainder).toBe("");
});

test.each([
  [[0xff, 0xfe], "��"],
  [[0xe2, 0x28, 0xa1], "�(�"],
] as const)("invalid UTF-8 is reduced from raw bytes %j", (bytes, text) => {
  const expected = cursor();
  const output = reduceModalRawOutputPage(page(expected, [...bytes], [], true, 0), expected);
  expect(output.chunks.map((chunk) => chunk.text)).toEqual([text]);
  expect(output.command.streams.stdout.byteOffset).toBe(bytes.length);
});

test("empty first EOF cannot introduce decoded text", () => {
  const expected = cursor();
  const raw = page(expected, [], [], true, 0);
  expect(reduceModalRawOutputPage(raw, expected).chunks).toEqual([]);
  expect(() =>
    reduceModalRawOutputPage({ ...raw, stdout: "fabricated" } as never, expected),
  ).toThrow();
  expect(() =>
    reduceModalRawOutputPage({ ...raw, chunks: [{ text: "€" }] } as never, expected),
  ).toThrow();
});

test.each(["byteOffset", "utf8Remainder", "eof"] as const)(
  "claimed %s must equal the exact byte reduction",
  (field) => {
    const expected = cursor();
    const raw = page(expected, [0xe2, 0x82]);
    if (field === "byteOffset") raw.command.streams.stdout.byteOffset++;
    if (field === "utf8Remainder") raw.command.streams.stdout.utf8Remainder = "";
    if (field === "eof") raw.command.streams.stdout.eof = true;
    expect(() => reduceModalRawOutputPage(raw, expected)).toThrow("delta or remainder");
  },
);

test.each(["sandboxId", "taskId", "execId"] as const)(
  "claimed next %s cannot replace the original identity",
  (field) => {
    const expected = cursor();
    const raw = page(expected, [0x41]);
    raw.command[field] = field === "execId" ? "22222222-2222-4222-8222-222222222222" : "different";
    expect(() => reduceModalRawOutputPage(raw, expected)).toThrow("delta or remainder");
  },
);

test("stale expected cursors fail before output can be captured", () => {
  const expected = cursor();
  const raw = page(expected, [0x41]);
  const current = structuredClone(expected);
  current.streams.stderr.byteOffset = 1;
  expect(() => reduceModalRawOutputPage(raw, current)).toThrow("current native cursor");
  expect(current.streams.stdout.byteOffset).toBe(0);
});

test("asymmetric EOF keeps process exit separate from fully drained output", () => {
  const expected = cursor();
  const raw = collectModalRawOutputPage(
    expected,
    {
      stdout: { bytes: Buffer.from("out"), eof: true },
      stderr: { bytes: Buffer.from("err"), eof: false },
    },
    { source: "router_poll", code: 7 },
  ).raw;
  const output = reduceModalRawOutputPage(raw, expected);
  expect(output.exitCode).toBeNull();
  expect(output.providerExited).toBe(true);
  expect(output.command.streams.stdout.exitCode).toBe(7);
  expect(output.command.streams.stderr.exitCode).toBeNull();
});

test("completed streams cannot reopen, advance or rewrite their terminal exit", () => {
  const expected = page(cursor(), [], [], true, 7).command;
  for (const raw of [
    page(expected, [0x41], [], true, 7),
    page(expected, [], [], false),
    page(expected, [], [], true, 8),
  ])
    expect(() => reduceModalRawOutputPage(raw, expected)).toThrow();
});

test("a retained-terminal tag requires the exact already-captured evidence", () => {
  const expected = cursor();
  const forged = page(expected, [], [], true, 0);
  forged.exit = { source: "retained_terminal", code: 0 };
  expect(() => reduceModalRawOutputPage(forged, expected)).toThrow("retained terminal");
  const terminal = forged.command;
  const retained = collectModalRawOutputPage(
    terminal,
    {
      stdout: { bytes: Buffer.alloc(0), eof: true },
      stderr: { bytes: Buffer.alloc(0), eof: true },
    },
    { source: "retained_terminal", code: 0 },
  ).raw;
  expect(reduceModalRawOutputPage(retained, terminal).chunks).toEqual([]);
});

test("saved remainder bytes cannot precede byte zero or exceed native decoder carry", () => {
  const expected = cursor();
  expected.streams.stdout.utf8Remainder = "4oI=";
  expect(() => reduceModalRawOutputPage(page(expected, [], [], true, 0), expected)).toThrow(
    "saved UTF-8",
  );
});

test("raw output is bounded per independent stream", () => {
  const expected = cursor();
  const raw = page(expected);
  raw.streams.stdout.bytes = Buffer.alloc(MODAL_ROUTER_READ_PAGE_BYTES + 1);
  expect(() => reduceModalRawOutputPage(raw, expected)).toThrow("exceeded its bound");
});

test("construction snapshots input bytes and expected cursor without authenticating them", () => {
  const expected = cursor();
  const bytes = Buffer.from("A");
  const raw = collectModalRawOutputPage(
    expected,
    {
      stdout: { bytes, eof: false },
      stderr: { bytes: Buffer.alloc(0), eof: false },
    },
    { source: "router_poll", code: null },
  ).raw;
  bytes[0] = 0x42;
  expected.streams.stdout.byteOffset = 99;
  expect(raw.streams.stdout.bytes[0]).toBe(0x41);
  expect(raw.expected.streams.stdout.byteOffset).toBe(0);
  expect(reduceModalRawOutputPage(raw, raw.expected).chunks[0]?.text).toBe("A");
});
