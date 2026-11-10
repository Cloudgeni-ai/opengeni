import { describe, expect, test } from "bun:test";
import { SubscriptionCoreCodexLeaseLostError } from "@opengeni/db";
import { admitCoreCodexDispatch } from "../src/activities/agent-turn/codex-core-capacity";
import { CodexIncludedUsageExhaustedError } from "../src/activities/agent-turn/codex-credit-policy";

class LocalLeaseLost extends Error {}

function harness(options: { reserveError?: Error; credits?: Error } = {}) {
  const steps: string[] = [];
  let lost = false;
  const lease = {
    assertUsable: () => {
      steps.push("local_lease");
      if (lost) throw new LocalLeaseLost("lease lost");
    },
    markLost: () => {
      steps.push("mark_lost");
      lost = true;
    },
    assertCurrentForDispatch: async () => {
      steps.push("lease_read");
      if (lost) throw new LocalLeaseLost("lease lost");
    },
  };
  return {
    steps,
    loseLease: () => {
      lost = true;
    },
    deps: {
      lease,
      assertSourceConnected: async () => {
        steps.push("source_read");
      },
      assertCredits: async () => {
        steps.push("credits");
        if (options.credits) throw options.credits;
      },
    },
    reserve: async () => {
      steps.push("reserve");
      if (options.reserveError) throw options.reserveError;
      return { operationId: "op" };
    },
  };
}

describe("core Codex dispatch admission", () => {
  test("a reserved request is fenced by its reservation alone, with no separate source or lease read", async () => {
    const { deps, reserve, steps } = harness();
    await admitCoreCodexDispatch({ ...deps, reserve });
    expect(steps).toEqual(["local_lease", "credits", "local_lease", "reserve"]);
  });

  test("without a reservation (title custody reserves its own) the source and live lease are read", async () => {
    const { deps, steps } = harness();
    await admitCoreCodexDispatch({ ...deps, reserve: null });
    expect(steps).toEqual(["source_read", "credits", "lease_read"]);
  });

  test("a lease the reservation finds lost marks the local holder lost", async () => {
    const leaseLost = new SubscriptionCoreCodexLeaseLostError();
    const { deps, reserve, steps } = harness({ reserveError: leaseLost });
    await expect(admitCoreCodexDispatch({ ...deps, reserve })).rejects.toBe(leaseLost);
    expect(steps.at(-1)).toBe("mark_lost");
    // The next request stops locally, before any database work.
    await expect(admitCoreCodexDispatch({ ...deps, reserve })).rejects.toBeInstanceOf(
      LocalLeaseLost,
    );
    expect(steps.filter((step) => step === "reserve")).toHaveLength(1);
  });

  test("other reservation refusals do not mark the lease lost", async () => {
    const refused = new Error("source disconnected");
    const { deps, reserve, steps } = harness({ reserveError: refused });
    await expect(admitCoreCodexDispatch({ ...deps, reserve })).rejects.toBe(refused);
    expect(steps).not.toContain("mark_lost");
  });

  test("a locally lost lease or known exhaustion never reserves", async () => {
    const lostLease = harness();
    lostLease.loseLease();
    await expect(
      admitCoreCodexDispatch({ ...lostLease.deps, reserve: lostLease.reserve }),
    ).rejects.toBeInstanceOf(LocalLeaseLost);
    expect(lostLease.steps).not.toContain("reserve");

    const exhausted = harness({ credits: new CodexIncludedUsageExhaustedError(null) });
    await expect(
      admitCoreCodexDispatch({ ...exhausted.deps, reserve: exhausted.reserve }),
    ).rejects.toBeInstanceOf(CodexIncludedUsageExhaustedError);
    expect(exhausted.steps).not.toContain("reserve");
  });
});
