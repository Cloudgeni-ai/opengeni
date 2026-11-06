import { describe, expect, test } from "bun:test";
import {
  createBackgroundSandboxPreparation,
  preparationBackgroundPublisher,
  preparationPublisher,
} from "../src/activities/agent-turn/background-sandbox-preparation";
import { createTurnSandboxProvisioner } from "../src/activities/agent-turn/sandbox-provision";
import { shouldPrepareManagedSandboxInBackground } from "../src/activities/agent-turn/sandbox-route";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function preparationFor(
  establish: () => Promise<string>,
  options: { warm?: boolean; budgetMs?: number } = {},
) {
  let establishCalls = 0;
  const provisioner = createTurnSandboxProvisioner<string>(
    async () => {
      establishCalls++;
      return await establish();
    },
    { maxRetries: 0 },
  );
  const preparation = createBackgroundSandboxPreparation({
    provisioner,
    homeBoxWarm: async () => options.warm ?? false,
    indexBudgetMs: options.budgetMs ?? 50,
  });
  return { preparation, establishCalls: () => establishCalls };
}

describe("background sandbox preparation", () => {
  test("applies only to repository turns on a lazily provisioned managed box", () => {
    const base = {
      establishPolicy: "on-demand" as const,
      machinePrimary: false,
      groupBoxBackend: "compute" as const,
      hasRepositoryResources: true,
    };
    expect(shouldPrepareManagedSandboxInBackground(base)).toBe(true);
    expect(shouldPrepareManagedSandboxInBackground({ ...base, groupBoxBackend: "modal" })).toBe(
      true,
    );
    expect(
      shouldPrepareManagedSandboxInBackground({ ...base, hasRepositoryResources: false }),
    ).toBe(false);
    expect(shouldPrepareManagedSandboxInBackground({ ...base, establishPolicy: "eager" })).toBe(
      false,
    );
    expect(shouldPrepareManagedSandboxInBackground({ ...base, machinePrimary: true })).toBe(false);
    expect(
      shouldPrepareManagedSandboxInBackground({ ...base, groupBoxBackend: "selfhosted" }),
    ).toBe(false);
    expect(shouldPrepareManagedSandboxInBackground({ ...base, groupBoxBackend: "none" })).toBe(
      false,
    );
  });

  test("a cold box never holds up the model request", async () => {
    const box = deferred<string>();
    const { preparation } = preparationFor(() => box.promise);
    preparation.start();
    const started = performance.now();
    expect(await preparation.indexReady()).toBe(false);
    // No budget wait for a box that was not already running.
    expect(performance.now() - started).toBeLessThan(40);
    box.resolve("box");
  });

  test("the first tool call joins the running preparation instead of starting another", async () => {
    const box = deferred<string>();
    const { preparation, establishCalls } = preparationFor(() => box.promise);
    preparation.start();
    preparation.start();
    expect(await preparation.indexReady()).toBe(false);
    const toolCall = preparation.provisioner.get();
    expect(preparation.joined).toBe(true);
    box.resolve("box");
    expect(await toolCall).toBe("box");
    expect(establishCalls()).toBe(1);
    // A joined preparation is never abandoned at turn end.
    expect(preparation.abandonIfUnjoined()).toBe(false);
  });

  test("a background failure surfaces on the first tool call", async () => {
    const failure = new Error("repository clone failed");
    const { preparation, establishCalls } = preparationFor(async () => {
      throw failure;
    });
    preparation.start();
    await Bun.sleep(0);
    await expect(preparation.provisioner.get()).rejects.toBe(failure);
    expect(establishCalls()).toBe(1);
  });

  test("a warm, prepared box is indexed live within the budget", async () => {
    const { preparation } = preparationFor(async () => "box", { warm: true, budgetMs: 1_000 });
    preparation.start();
    expect(await preparation.indexReady()).toBe(true);
    expect(preparation.settled).toBe(true);
  });

  test("a warm box that still needs setup defers after the budget and is decided once", async () => {
    const box = deferred<string>();
    const { preparation } = preparationFor(() => box.promise, { warm: true, budgetMs: 20 });
    preparation.start();
    expect(await preparation.indexReady()).toBe(false);
    box.resolve("box");
    await Bun.sleep(0);
    // Frozen for the turn even after preparation finishes.
    expect(await preparation.indexReady()).toBe(false);
  });

  test("a turn that ends without needing the box abandons it and stops its progress", async () => {
    const box = deferred<string>();
    const { preparation } = preparationFor(() => box.promise);
    const published: string[] = [];
    const publish = preparationPublisher(preparation, async (events) => {
      published.push(...events.map((event) => event.type));
      return { events: [], accepted: true, canonicalStartupMilestones: [] };
    })!;
    const background: string[] = [];
    const publishInBackground = preparationBackgroundPublisher(preparation, (events) => {
      background.push(...events.map((event) => event.type));
    })!;
    preparation.start();
    await publish([{ type: "rig.setup.started", payload: {} }]);
    expect(preparation.abandonIfUnjoined()).toBe(true);
    expect(preparation.abandoned).toBe(true);
    await publish([{ type: "rig.setup.failed", payload: {} }]);
    publishInBackground([{ type: "turn.startup.phase.failed", payload: {} }]);
    expect(published).toEqual(["rig.setup.started"]);
    expect(background).toEqual([]);
    expect(preparation.abandonIfUnjoined()).toBe(false);
    box.resolve("box");
  });

  test("finished preparation is not abandoned", async () => {
    const { preparation } = preparationFor(async () => "box");
    preparation.start();
    await preparation.provisioner.waitForSettled(1_000);
    expect(preparation.settled).toBe(true);
    expect(preparation.abandonIfUnjoined()).toBe(false);
  });
});
