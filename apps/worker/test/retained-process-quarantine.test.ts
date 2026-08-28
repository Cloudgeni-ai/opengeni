import { describe, expect, test } from "bun:test";

import {
  RETAINED_PROCESS_BINDING_QUARANTINE_AFTER_ATTEMPTS,
  RETAINED_PROCESS_BINDING_QUARANTINE_RETRY_MS,
  retainedProcessReconciliationDeferral,
} from "../src/activities/sandbox-lease";

const settings = { sandboxLeaseReaperPeriodMs: 30_000 };

describe("retained-process binding quarantine", () => {
  test("quarantines repeated binding failures without manufacturing terminal proof", () => {
    for (const outcome of ["provider_binding_missing", "provider_binding_mismatch"] as const) {
      expect(
        retainedProcessReconciliationDeferral(
          settings,
          { reconcileAttempts: RETAINED_PROCESS_BINDING_QUARANTINE_AFTER_ATTEMPTS },
          outcome,
        ),
      ).toEqual({
        durableOutcome: `quarantined_${outcome}`,
        metricOutcome:
          outcome === "provider_binding_missing"
            ? "quarantined_binding_missing"
            : "quarantined_binding_mismatch",
        retryAfterMs: RETAINED_PROCESS_BINDING_QUARANTINE_RETRY_MS,
        quarantined: true,
      });
    }
  });

  test("keeps early and transient observations on bounded exponential retry", () => {
    expect(
      retainedProcessReconciliationDeferral(
        settings,
        { reconcileAttempts: RETAINED_PROCESS_BINDING_QUARANTINE_AFTER_ATTEMPTS - 1 },
        "provider_binding_missing",
      ),
    ).toEqual({
      durableOutcome: "provider_binding_missing",
      metricOutcome: "provider_binding_missing",
      retryAfterMs: 240_000,
      quarantined: false,
    });
    expect(
      retainedProcessReconciliationDeferral(
        settings,
        { reconcileAttempts: RETAINED_PROCESS_BINDING_QUARANTINE_AFTER_ATTEMPTS + 10 },
        "provider_timeout",
      ),
    ).toEqual({
      durableOutcome: "provider_timeout",
      metricOutcome: "provider_timeout",
      retryAfterMs: 300_000,
      quarantined: false,
    });
  });
});
