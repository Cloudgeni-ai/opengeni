import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";

import {
  recordSessionCreated,
  recordUserMessageAccepted,
  registerProductUsageMetricBaselines,
} from "../src/product-usage-metrics";

describe("product usage counters", () => {
  test("count sessions and messages with closed labels only", async () => {
    const observability = createObservability(testSettings(), { component: "api" });
    registerProductUsageMetricBaselines(observability);
    recordSessionCreated(observability, {
      surface: "web",
      createdByKind: "subject",
      parentSessionId: null,
    });
    recordSessionCreated(observability, {
      surface: "agent",
      createdByKind: "subject",
      parentSessionId: crypto.randomUUID(),
    });
    recordSessionCreated(observability, {
      surface: null,
      createdByKind: "something-else",
      parentSessionId: undefined,
    });
    recordUserMessageAccepted(observability, { surface: "slack" });
    recordUserMessageAccepted(observability, { surface: "not-a-surface" as never });
    const metrics = await observability.prometheusMetrics();
    const value = (pattern: RegExp) => Number(metrics.match(pattern)?.[1]);
    expect(
      value(
        /opengeni_sessions_created_total\{(?=[^}]*surface="web")(?=[^}]*created_by_kind="subject")(?=[^}]*root="true")[^}]*\} (\d+)/,
      ),
    ).toBe(1);
    expect(
      value(
        /opengeni_sessions_created_total\{(?=[^}]*surface="agent")(?=[^}]*root="false")(?=[^}]*created_by_kind="subject")[^}]*\} (\d+)/,
      ),
    ).toBe(1);
    expect(
      value(
        /opengeni_sessions_created_total\{(?=[^}]*surface="unknown")(?=[^}]*created_by_kind="service")(?=[^}]*root="true")[^}]*\} (\d+)/,
      ),
    ).toBe(1);
    expect(value(/opengeni_user_messages_total\{(?=[^}]*surface="slack")[^}]*\} (\d+)/)).toBe(1);
    expect(value(/opengeni_user_messages_total\{(?=[^}]*surface="unknown")[^}]*\} (\d+)/)).toBe(1);
    // Baselines publish quiet surfaces at zero.
    expect(value(/opengeni_user_messages_total\{(?=[^}]*surface="mcp")[^}]*\} (\d+)/)).toBe(0);
    expect(metrics).not.toContain("not-a-surface");
    expect(metrics).not.toContain("something-else");
    await observability.flush();
  });
});
