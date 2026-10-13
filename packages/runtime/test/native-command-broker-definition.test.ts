import { expect, test } from "bun:test";
import {
  decodeNativeBrokerCommandDefinition as decode,
  encodeNativeBrokerCommandDefinition as encode,
  NATIVE_BROKER_DEFINITION_MAX_BYTES,
  type NativeBrokerCommandDefinition,
} from "../src/sandbox/providers/native-command-broker-definition";

function fixture(
  delta: Partial<NativeBrokerCommandDefinition> = {},
): NativeBrokerCommandDefinition {
  return {
    mode: "pipe",
    cwd: "/workspace",
    argv: ["/bin/true"],
    env: [],
    rows: 0,
    columns: 0,
    ...delta,
  };
}

test("minimal definition matches the frozen native big-endian vector", () => {
  expect(Buffer.from(encode(fixture({ cwd: "/", argv: ["x"] }))).toString("hex")).toBe(
    "4f47434431000000000000000000000100000000000000012f0000000178",
  );
});

test.each(["pipe", "pty"] as const)(
  "%s preserves literal argv, ordered env and Unicode without shell expansion",
  (mode) => {
    const input = fixture({
      mode,
      rows: mode === "pty" ? 24 : 0,
      columns: mode === "pty" ? 80 : 0,
      cwd: "/workspace/🦎 α",
      argv: ["/bin/sh", "-c", "printf '$NAME'", ""],
      env: [
        ["NAME", "line1\nline2\t=🦎"],
        ["EMPTY", ""],
        ["__proto__", "literal"],
      ],
    });
    expect(decode(encode(input))).toEqual(input);
  },
);

test("every truncated prefix is rejected without emitting the embedded secret", () => {
  const input = encode(fixture({ env: [["PRIVATE_VALUE", "sentinel-sensitive-value"]] }));
  for (let size = 0; size < input.length; size++) {
    expect(() => decode(input.subarray(0, size))).toThrow("definition is invalid or exceeds");
  }
});

test.each(
  [
    { mode: "other" },
    { rows: 1 },
    { columns: 1 },
    { mode: "pty", rows: 0, columns: 80 },
    { mode: "pty", rows: 24, columns: 0 },
    { rows: 65536 },
    { rows: 0.5 },
    { rows: -1 },
    { cwd: "relative" },
    { cwd: "" },
    { argv: [] },
    { argv: [""] },
    {
      env: [
        ["A", "one"],
        ["A", "two"],
      ],
    },
    { env: [["1A", "value"]] },
    { env: [["A=B", "value"]] },
    { env: [["", "value"]] },
    { env: [["A-B", "value"]] },
    { argv: ["x", "a\0b"] },
    { cwd: "/a\0b" },
    { env: [["X", "a\0b"]] },
    { argv: ["x", "\ud800"] },
    { env: [["X", "\udfff"]] },
    { argv: ["x", "a".repeat(131072)] },
    { argv: Array(1025).fill("x") },
    { env: [["A", "x".repeat(131070)]] },
    { runAs: "root" },
    { inheritEnv: true },
  ].map((delta, index) => [index, delta] as const),
)("invalid or unsupported definition %i is refused", (_index, delta) => {
  expect(() => encode({ ...fixture(), ...delta } as NativeBrokerCommandDefinition)).toThrow(
    "definition is invalid or exceeds",
  );
});

test("all header flags, counts, noncanonical UTF-8 and trailing bytes are checked", () => {
  const source = encode(fixture());
  for (const [index, value] of [
    [0, 0],
    [4, 50],
    [5, 1],
    [6, 2],
    [7, 1],
    [12, 255],
    [16, 255],
  ] as const) {
    const bytes = Uint8Array.from(source);
    bytes[index] = value;
    expect(() => decode(bytes)).toThrow();
  }
  expect(() => decode(Buffer.concat([source, Buffer.from([0])]))).toThrow();
  const encoded = encode(fixture({ argv: ["x", "aa"] }));
  for (const invalid of [
    [0xc0, 0xaf],
    [0xc2, 0],
    [0xff, 0xff],
    [0xc2, 0x20],
  ]) {
    const input = Uint8Array.from(encoded);
    input.set(invalid, input.length - 2);
    expect(() => decode(input)).toThrow();
  }
});

test("exact byte, string and entry limits pass while the next byte fails", () => {
  const exact = fixture({ cwd: "/", argv: ["a".repeat(131071), "b".repeat(262144 - 33 - 131071)] });
  const data = encode(exact);
  expect(data).toHaveLength(NATIVE_BROKER_DEFINITION_MAX_BYTES);
  expect(decode(data)).toEqual(exact);
  expect(() => encode({ ...exact, argv: [exact.argv[0]!, exact.argv[1]! + "b"] })).toThrow();
  expect(() => decode(Buffer.concat([data, Buffer.from([0])]))).toThrow();
  for (const value of [
    fixture({ argv: Array(1024).fill("x") }),
    fixture({ env: Array.from({ length: 1024 }, (_, i) => [`K${i}`, ""] as [string, string]) }),
    fixture({ env: [["A", "x".repeat(131069)]] }),
  ]) {
    expect(decode(encode(value))).toEqual(value);
  }
});

test("inputs are not mutated and returned buffers and arrays do not share writable custody", () => {
  const value = fixture({ env: [["A", "one"]] });
  const data = encode(value);
  const decoded = decode(data);
  decoded.argv[0] = "changed";
  decoded.env[0]![1] = "changed";
  expect(value.argv[0]).toBe("/bin/true");
  expect(value.env[0]![1]).toBe("one");
  expect(decode(data)).toEqual(value);
});
