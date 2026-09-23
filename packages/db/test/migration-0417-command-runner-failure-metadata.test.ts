import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SessionCommandFailure } from "@opengeni/contracts";

test("0417 adds one bounded rolling failure field without delivery or ACK state", () => {
  const source = readFileSync(
    new URL("../drizzle/0417_command_runner_failure_metadata.sql", import.meta.url),
    "utf8",
  );
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source.match(/ADD COLUMN/g)).toHaveLength(1);
  expect(source).toContain("ADD COLUMN runner_failure jsonb");
  expect(source).toContain("octet_length(runner_failure::text) <= 8192");
  expect(source).not.toContain("CREATE TABLE");
});

test("typed runner failure metadata has a bounded exact-detail contract", () => {
  const value = {
    code: "OP_OVERFLOW",
    detail: { retained_bytes: "268435456" },
    retryable: false as const,
  };
  expect(SessionCommandFailure.parse(value)).toEqual(value);
  expect(
    SessionCommandFailure.safeParse({ ...value, detail: { large: "x".repeat(2049) } }).success,
  ).toBe(false);
  expect(
    SessionCommandFailure.safeParse({
      ...value,
      detail: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, "0"])),
    }).success,
  ).toBe(false);
  expect(
    SessionCommandFailure.safeParse({
      ...value,
      detail: { a: "x".repeat(2048), b: "x".repeat(2048) },
    }).success,
  ).toBe(false);
});
