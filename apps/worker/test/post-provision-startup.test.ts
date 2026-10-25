import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { sandboxStartupPhaseObserver } from "../src/activities/agent-turn/sandbox-startup-phase";
import { withSandboxStartupPhases } from "../src/activities/agent-turn/sandbox-startup-phase";
import type { TurnEventPublisher } from "../src/activities/agent-turn/model-usage";

// Exercise the production stage, including its all-settled/error ordering.
const source = readFileSync(
  new URL("../src/activities/agent-turn/sandbox-establish.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("// Post-provision prerequisites:");
const end = source.indexOf("const provisionedSetupSession =", start);
if (start < 0 || end < 0) throw new Error("Missing post-provision stage");
const stage = new Function(
  "ports",
  new Bun.Transpiler({ loader: "ts" }).transformSync(`
  const { startRunGitCredentialsMint, mintSandboxCodemodeToken, managedCodemodeClientDownload, attachRunCredentialRenewal } = ports;
  const activeSandboxBackend = 'modal', groupBoxBackend = 'modal', sandboxCodemodeToken = 'fixture';
  const runSettings = {}, connectionScope = {}, codemodeAuthority = {}, objectStorage = {}, initialRunCredentialMaterial = {};
  const provisioned = { established: { session: {} } };
  const measure = (_phase, work) => work();
  return (async () => { ${source.slice(start, end)} return { lazyGitTokens, lazyCodemodeToken, lazyCodemodeClientDownload }; })();
`),
) as (ports: Record<string, () => Promise<unknown>>) => Promise<unknown>;

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("publication and materialization overlap the remaining mint wait; success joins all three", async () => {
  const mint = gate<unknown>(),
    publication = gate<unknown>(),
    materialization = gate<unknown>();
  const started: string[] = [];
  let settled = false;
  const result = stage({
    startRunGitCredentialsMint: () => {
      started.push("mint");
      return mint.promise;
    },
    mintSandboxCodemodeToken: async () => ({ token: "fixture" }),
    managedCodemodeClientDownload: () => {
      started.push("publication");
      return publication.promise;
    },
    attachRunCredentialRenewal: () => {
      started.push("materialization");
      return materialization.promise;
    },
  }).finally(() => {
    settled = true;
  });
  expect(started).toEqual(["mint", "publication", "materialization"]);
  mint.resolve({ gitTokens: { github: "fixture" } });
  publication.resolve({ url: "https://storage.example/client" });
  await flush();
  expect(settled).toBe(false);
  materialization.resolve(undefined);
  expect(await result).toEqual({
    lazyGitTokens: { github: "fixture" },
    lazyCodemodeToken: { token: "fixture" },
    lazyCodemodeClientDownload: { url: "https://storage.example/client" },
  });
});

test.each(["mint", "publication", "materialization"])(
  "%s failure retains identity and waits for other started work",
  async (failurePhase) => {
    const held = gate<unknown>();
    const error = new Error("original failure");
    let settled = false;
    const operations = ["mint", "publication", "materialization"];
    const pendingPhase = operations.find((phase) => phase !== failurePhase)!;
    const work = (phase: string) => async () => {
      if (phase === failurePhase) throw error;
      if (phase === pendingPhase) await held.promise;
      return undefined;
    };
    const result = stage({
      startRunGitCredentialsMint: work("mint"),
      mintSandboxCodemodeToken: async () => ({ token: "fixture" }),
      managedCodemodeClientDownload: work("publication"),
      attachRunCredentialRenewal: work("materialization"),
    }).catch((reason) => {
      settled = true;
      return reason;
    });
    await flush();
    expect(settled).toBe(false);
    held.resolve(undefined);
    expect(await result).toBe(error);
  },
);

test("multiple failures retain serial precedence, including token mint failure", async () => {
  const tokenError = new Error("token");
  await expect(
    stage({
      startRunGitCredentialsMint: async () => undefined,
      mintSandboxCodemodeToken: async () => {
        throw tokenError;
      },
      managedCodemodeClientDownload: async () => {
        throw new Error("publication");
      },
      attachRunCredentialRenewal: async () => {
        throw new Error("materialization");
      },
    }),
  ).rejects.toBe(tokenError);
});

test("startup receipts record actual interval and bounded failure without leaking errors", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const events: Parameters<TurnEventPublisher>[0] = [];
  const publish = (async (batch) => {
    events.push(...batch);
    return { events: [], accepted: true, canonicalStartupMilestones: [] };
  }) satisfies TurnEventPublisher;
  const measure = sandboxStartupPhaseObserver({
    observability,
    provider: "test",
    backend: "modal",
    publish,
  });
  const held = gate<object>();
  const result = measure("client_readiness", () => held.promise);
  expect(events).toHaveLength(0);
  const value = {};
  held.resolve(value);
  expect(await result).toBe(value);
  const error = new Error("private-token-do-not-record");
  await expect(
    measure("credential_mint", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(events).toHaveLength(0);
  await measure.flush();
  expect(events.map((event) => event.type)).toEqual([
    "turn.startup.phase.completed",
    "turn.startup.phase.failed",
  ]);
  expect(events[0]!.occurredAt).toBeInstanceOf(Date);
  expect(events[0]!.payload).toMatchObject({
    phase: "client_readiness",
    durationMs: expect.any(Number),
  });
  const metrics = await observability.prometheusMetrics();
  expect(metrics).toContain('phase="client_readiness"');
  expect(metrics).toContain('phase="credential_mint"');
  expect(JSON.stringify(events) + metrics).not.toContain(error.message);
});

test("telemetry failures cannot replace an operation value or cancellation", async () => {
  const measure = sandboxStartupPhaseObserver({
    observability: {
      startSpan: () => {
        throw new Error("exporter");
      },
    } as never,
    provider: "test",
    backend: "compute",
    publish: async () => {
      throw new Error("publication");
    },
  });
  expect(await measure("credential_resolution", async () => 7)).toBe(7);
  await measure.flush();
  const abort = new DOMException("cancelled", "AbortError");
  await expect(
    measure("credential_materialization", async () => {
      throw abort;
    }),
  ).rejects.toBe(abort);
  await measure.flush();
});

test("one boundary batches receipts on failure and retains operation timestamps during slow delivery", async () => {
  const delivery = gate<void>();
  let calls = 0;
  let batch: Parameters<TurnEventPublisher>[0] = [];
  const failure = new Error("setup failed");
  const observability = createObservability(testSettings(), { component: "worker" });
  const run = withSandboxStartupPhases(
    {
      observability,
      provider: "test",
      backend: "modal",
      publish: async (events) => {
        calls++;
        batch = events;
        await delivery.promise;
        return { events: [], accepted: true, canonicalStartupMilestones: [] };
      },
    },
    async (measure) => {
      await measure("credential_mint", async () => undefined);
      await measure("client_publication", async () => {
        throw failure;
      });
    },
  ).catch((error) => error);
  await flush();
  expect(calls).toBe(1);
  expect(batch).toHaveLength(2);
  const captured = JSON.stringify(batch);
  await Bun.sleep(10);
  delivery.resolve();
  expect(await run).toBe(failure);
  expect(JSON.stringify(batch)).toBe(captured);
  expect(await observability.prometheusMetrics()).toContain('phase="startup_phase_delivery"');
});
