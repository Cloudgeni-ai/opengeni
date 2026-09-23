import { expect, test } from "bun:test";
import { retryStartupDependency } from "@opengeni/config";
import {
  isRetryableRuntimeDatabaseStartupError,
  RuntimeDatabasePostureError,
} from "../src/runtime-posture";

test("permanent posture violations preserve their diagnostic and do not retry", async () => {
  const failure = new RuntimeDatabasePostureError([
    "RLS tables are absent from declared contract: unexpected_table",
  ]);
  let attempts = 0;
  let retries = 0;
  await expect(
    retryStartupDependency(
      "PostgreSQL runtime posture",
      async () => {
        attempts++;
        throw failure;
      },
      {
        initialDelayMs: 0,
        maxDelayMs: 0,
        shouldRetry: isRetryableRuntimeDatabaseStartupError,
        onRetry: () => {
          retries++;
        },
      },
    ),
  ).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(retries).toBe(0);
});

test("temporary connection failures still retry and recover", async () => {
  let attempts = 0;
  const result = await retryStartupDependency(
    "PostgreSQL runtime posture",
    async () => {
      if (++attempts < 3) throw Object.assign(new Error("database is starting"), { code: "57P03" });
      return "ready";
    },
    { initialDelayMs: 0, maxDelayMs: 0, shouldRetry: isRetryableRuntimeDatabaseStartupError },
  );
  expect(result).toBe("ready");
  expect(attempts).toBe(3);
});

test("authentication and schema errors are classified through database wrappers", () => {
  for (const code of ["28P01", "28000", "3D000", "42501", "42P01", "42703"]) {
    const postgres = Object.assign(new Error("original database diagnostic"), { code });
    expect(
      isRetryableRuntimeDatabaseStartupError(new Error("query failed", { cause: postgres })),
    ).toBe(false);
  }
  expect(
    isRetryableRuntimeDatabaseStartupError(
      Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    ),
  ).toBe(true);
  const cyclic = new Error("unknown failure");
  cyclic.cause = cyclic;
  expect(isRetryableRuntimeDatabaseStartupError(cyclic)).toBe(true);
});
