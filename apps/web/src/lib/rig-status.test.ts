import { describe, expect, test } from "bun:test";
import type { RigChange } from "@/types";
import {
  changeIsPromotable,
  rigChangeStatusView,
  rigCheckHealthView,
  rigCheckResultSummary,
  rigVerificationErrorMessage,
} from "./rig-status";

describe("rig status copy", () => {
  test("a verified setup_append awaits manager promotion", () => {
    const change = fixture({
      kind: "setup_append",
      status: "proposed",
      verification: { passed: true, checksConfigured: false },
    });
    expect(changeIsPromotable(change)).toBe(true);
    expect(rigChangeStatusView(change)).toMatchObject({
      label: "Verified · awaiting manager",
      description: expect.stringContaining("must promote"),
    });
  });

  test("zero checks are explicit and never labeled healthy", () => {
    expect(rigCheckHealthView("not_configured")).toMatchObject({
      label: "No checks configured",
      description: expect.stringContaining("no health signal"),
    });
  });

  test("a failing health record does not misstate infrastructure failure as a check exit", () => {
    expect(rigCheckHealthView("failing")).toMatchObject({
      label: "Verification failed",
      description: expect.stringContaining("could not be run reliably"),
    });
  });

  test("historical merged records keep their existing reader label", () => {
    expect(rigChangeStatusView(fixture({ status: "merged" })).label).toBe("Merged");
  });

  test("structured skips, timeouts, and infrastructure errors are explicit", () => {
    expect(
      rigCheckResultSummary({
        name: "after-setup",
        command: "true",
        status: "skipped",
        exitCode: null,
        skippedReason: "Candidate setup failed; this check did not run.",
      }),
    ).toContain("did not run");
    expect(
      rigCheckResultSummary({
        name: "bounded",
        command: "sleep 60",
        status: "failed",
        exitCode: 124,
        timedOut: true,
      }),
    ).toBe("Timed out");
    expect(rigVerificationErrorMessage({ error: "sandbox launch was ambiguous" })).toBe(
      "sandbox launch was ambiguous",
    );
  });
});

function fixture(overrides: Partial<RigChange>): RigChange {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    rigId: "22222222-2222-4222-8222-222222222222",
    baseVersionId: "33333333-3333-4333-8333-333333333333",
    kind: "definition_edit",
    payload: {},
    status: "proposed",
    proposedBy: "user:test",
    idempotencyKey: null,
    verification: null,
    resultVersionId: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}
