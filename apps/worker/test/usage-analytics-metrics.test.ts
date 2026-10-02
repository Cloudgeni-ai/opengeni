import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";

import { recordActiveUserGauges, recordCreditGrantGauges } from "../src/observability-metrics";

describe("usage analytics gauges", () => {
  test("publish every presence window and grant class with bounded labels", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    recordActiveUserGauges(observability, {
      "5m": 2,
      "15m": 3,
      "1h": 4,
      "24h": 10,
      "7d": 20,
      "30d": 40,
    });
    recordCreditGrantGauges(observability, {
      signup_trial: { count: 5, micros: 50_000_000 },
      coupon: { count: 1, micros: 5_000_000 },
      manual: { count: 0, micros: 0 },
      other: { count: 0, micros: 0 },
    });
    const metrics = await observability.prometheusMetrics();
    for (const [window, value] of [
      ["5m", 2],
      ["15m", 3],
      ["1h", 4],
      ["24h", 10],
      ["7d", 20],
      ["30d", 40],
    ] as const) {
      expect(metrics).toMatch(
        new RegExp(`opengeni_active_users\\{(?=[^}]*window="${window}")[^}]*\\} ${value}\\n`),
      );
    }
    expect(metrics).toMatch(
      /opengeni_credit_grants_total\{(?=[^}]*grant_class="signup_trial")[^}]*\} 5\n/,
    );
    expect(metrics).toMatch(
      /opengeni_credit_granted_micros_total\{(?=[^}]*grant_class="coupon")[^}]*\} 5000000\n/,
    );
    expect(metrics).toMatch(
      /opengeni_credit_grants_total\{(?=[^}]*grant_class="manual")[^}]*\} 0\n/,
    );
    await observability.flush();
  });
});
