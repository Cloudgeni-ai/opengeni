import { expect, test } from "bun:test";
import {
  assertBaselineAdvanceScope,
  parseRuntimePostureBaseline,
} from "./runtime-posture-baseline";

test("a migration cannot move its own previous-binary goalposts", () => {
  const pin = "scripts/runtime-posture-baseline.json";
  expect(() =>
    assertBaselineAdvanceScope([pin, "packages/db/drizzle/9999_example.sql"], true),
  ).toThrow();
  expect(() =>
    assertBaselineAdvanceScope([pin, "packages/db/src/runtime-posture.ts"], true),
  ).toThrow();
  expect(() =>
    assertBaselineAdvanceScope([pin, "docs/migrations-expand-contract.md"], true),
  ).not.toThrow();
  expect(() =>
    assertBaselineAdvanceScope(["packages/db/drizzle/9999_example.sql"], true),
  ).not.toThrow();
  expect(() =>
    assertBaselineAdvanceScope([pin, "packages/db/src/runtime-posture.ts"], false),
  ).not.toThrow();
});

test("the compatibility baseline cannot silently follow HEAD or a moving production tag", () => {
  for (const sourceCommit of ["HEAD", "main", "production", "v4.2.0", "a".repeat(39), ""]) {
    expect(() =>
      parseRuntimePostureBaseline({
        schemaVersion: 1,
        status: "bootstrap",
        sourceCommit,
        release: null,
      }),
    ).toThrow();
  }
  expect(
    parseRuntimePostureBaseline({
      schemaVersion: 1,
      status: "bootstrap",
      sourceCommit: "a".repeat(40),
      release: null,
    }).status,
  ).toBe("bootstrap");
  expect(() =>
    parseRuntimePostureBaseline({
      schemaVersion: 1,
      status: "production",
      sourceCommit: "a".repeat(40),
      release: null,
    }),
  ).toThrow();
  expect(
    parseRuntimePostureBaseline({
      schemaVersion: 1,
      status: "production",
      sourceCommit: "a".repeat(40),
      release: "release receipt",
    }).status,
  ).toBe("production");
});
