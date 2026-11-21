import { expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { repairMissedSessionWorkflowWakes } from "../src/activities/parent-wake";

test("each failed quiescence repair row logs its error class and SQLSTATE only", async () => {
  const logs: Array<{ message: string; attributes: Record<string, unknown> }> = [];
  const observability = {
    error: (message: string, attributes: Record<string, unknown> = {}) =>
      logs.push({ message, attributes }),
  };
  await repairMissedSessionWorkflowWakes(
    { db: {} as Database, observability: observability as never },
    100,
    {
      repairPendingChildTerminalResultWakes: async () => ({
        examined: 0,
        registered: 0,
        failed: 0,
        cursor: null,
      }),
      repairMissingQuiescenceReceiptWakes: async () => ({
        examined: 3,
        registered: 1,
        failed: 2,
        failures: [
          { errorName: "DrizzleQueryError", sqlState: "40P01", sqlStateClass: "40" },
          { errorName: "TypeError", sqlState: null, sqlStateClass: null },
        ],
        cursor: null,
      }),
    },
  );
  expect(logs).toEqual([
    {
      message: "Missing quiescence-receipt wake repair failed",
      attributes: { examined: 3, registered: 1, failed: 2 },
    },
    {
      message: "Missing quiescence-receipt wake repair row failed",
      attributes: { errorName: "DrizzleQueryError", sqlState: "40P01", sqlStateClass: "40" },
    },
    {
      message: "Missing quiescence-receipt wake repair row failed",
      attributes: { errorName: "TypeError", sqlState: null, sqlStateClass: null },
    },
  ]);
});
