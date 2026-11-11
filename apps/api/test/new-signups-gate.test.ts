import { describe, expect, test } from "bun:test";

import { createManagedAuthNewSignupsGate } from "../src/auth/new-signups-gate";

type Step = { signups_enabled: boolean } | "missing" | "error";

function scriptedDb(steps: Step[]) {
  let reads = 0;
  const db = {
    execute: async () => {
      const step = steps[Math.min(reads, steps.length - 1)]!;
      reads += 1;
      if (step === "error") throw new Error("database unavailable");
      if (step === "missing") return [];
      return [{ revision: reads, signups_enabled: step.signups_enabled, changed_at: new Date() }];
    },
  };
  return { db: db as never, reads: () => reads };
}

describe("managed auth new sign-ups gate", () => {
  test("reads the runtime switch on every decision so a flip applies to the next request", async () => {
    const { db, reads } = scriptedDb([
      { signups_enabled: true },
      { signups_enabled: false },
      { signups_enabled: true },
    ]);
    const gate = createManagedAuthNewSignupsGate({
      db,
      settings: { managedAuthNewSignupsEnabled: true },
    });
    expect(await gate.signupsOpen()).toBe(true);
    expect(await gate.signupsOpen()).toBe(false);
    expect(await gate.signupsOpen()).toBe(true);
    expect(reads()).toBe(3);
  });

  test("the deployment ceiling closes sign-ups without consulting the switch", async () => {
    const { db, reads } = scriptedDb([{ signups_enabled: true }]);
    const gate = createManagedAuthNewSignupsGate({
      db,
      settings: { managedAuthNewSignupsEnabled: false },
    });
    expect(await gate.signupsOpen()).toBe(false);
    expect(reads()).toBe(0);
  });

  test("a failed read keeps the last observed value, else the deployment ceiling", async () => {
    const warnings: string[] = [];
    const observability = { warn: (message: string) => warnings.push(message) };
    const cold = createManagedAuthNewSignupsGate({
      db: scriptedDb(["error"]).db,
      settings: { managedAuthNewSignupsEnabled: true },
      observability,
    });
    expect(await cold.signupsOpen()).toBe(true);

    const warm = createManagedAuthNewSignupsGate({
      db: scriptedDb([{ signups_enabled: false }, "error"]).db,
      settings: { managedAuthNewSignupsEnabled: true },
      observability,
    });
    expect(await warm.signupsOpen()).toBe(false);
    expect(await warm.signupsOpen()).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  test("no revision (schema before migration 0585) follows the ceiling", async () => {
    const gate = createManagedAuthNewSignupsGate({
      db: scriptedDb(["missing"]).db,
      settings: { managedAuthNewSignupsEnabled: true },
    });
    expect(await gate.signupsOpen()).toBe(true);
  });
});
