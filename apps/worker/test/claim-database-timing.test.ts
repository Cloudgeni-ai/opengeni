import { describe, expect, mock, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import { startDatabaseTiming } from "../../../packages/db/src/database-timing";
import { measureClaimDatabaseScopes } from "../src/activities/agent-turn/claim-database-timing";

function metrics() {
  const observeHistogram = mock<Observability["observeHistogram"]>(() => undefined);
  const incrementCounter = mock<Observability["incrementCounter"]>(() => undefined);
  const observability = new Proxy(
    { observeHistogram, incrementCounter },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
  ) as unknown as Observability;
  return { observability, observeHistogram, incrementCounter };
}

describe("claim database attribution", () => {
  test("aggregates nested scopes without mistaking them for separate claim latency", async () => {
    const m = metrics();
    const result = await measureClaimDatabaseScopes(m.observability, async () => {
      const outer = startDatabaseTiming("scoped_callback");
      startDatabaseTiming("transaction_admission")("completed");
      for (let i = 0; i < 3; i++) {
        startDatabaseTiming("savepoint_admission")("completed");
        startDatabaseTiming("rls_setup")("completed");
        startDatabaseTiming("scoped_callback")("completed");
      }
      outer("completed");
      return "claimed";
    });
    expect(result).toBe("claimed");
    expect(m.observeHistogram).toHaveBeenCalledTimes(4);
    expect(m.incrementCounter).toHaveBeenCalledWith({
      name: "opengeni_turn_claim_database_scopes_total",
      help: "Database scope stages observed during claims, including nested scopes and retries.",
      labels: { stage: "scoped_callback", outcome: "completed" },
      amount: 4,
    });
  });

  test("parallel claims keep their counts and failures isolated", async () => {
    const first = metrics();
    const second = metrics();
    const gate = Promise.withResolvers<void>();
    const failure = new Error("original database failure");
    const a = measureClaimDatabaseScopes(first.observability, async () => {
      const end = startDatabaseTiming("transaction_admission");
      await gate.promise;
      end("failed");
      throw failure;
    });
    await measureClaimDatabaseScopes(second.observability, async () => {
      startDatabaseTiming("transaction_admission")("completed");
    });
    gate.resolve();
    await expect(a).rejects.toBe(failure);
    expect(first.incrementCounter.mock.calls[0]?.[0].labels?.outcome).toBe("failed");
    expect(second.incrementCounter.mock.calls[0]?.[0].labels?.outcome).toBe("completed");
    expect(first.incrementCounter).toHaveBeenCalledTimes(1);
    expect(second.incrementCounter).toHaveBeenCalledTimes(1);
  });

  test("diagnostic failure cannot replace a database error or successful result", async () => {
    const m = metrics();
    m.observeHistogram.mockImplementation(() => {
      throw new Error("exporter unavailable");
    });
    const failure = new Error("claim refused");
    await expect(
      measureClaimDatabaseScopes(m.observability, async () => {
        startDatabaseTiming("transaction_admission")("failed");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      await measureClaimDatabaseScopes(m.observability, async () => {
        startDatabaseTiming("transaction_admission")("completed");
        return "claimed";
      }),
    ).toBe("claimed");
  });
});
