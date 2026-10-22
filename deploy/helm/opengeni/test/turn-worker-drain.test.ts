import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = resolve(import.meta.dir, "..");

type Env = { name: string; value?: string };
type Deployment = {
  kind: string;
  metadata: { name: string };
  spec: {
    strategy?: { type?: string; rollingUpdate?: { maxSurge?: number; maxUnavailable?: number } };
    template: {
      spec: { terminationGracePeriodSeconds: number; containers: Array<{ env?: Env[] }> };
    };
  };
};

// The worker's own defaults and fixed margins (apps/worker/src/worker-shutdown.ts).
const APP_DEFAULT_GRACE_MS = 90_000;
const APP_DEFAULT_FORCE_MS = 105_000;
const CHECKPOINT_WINDOW_MS = 10_000;
const PROCESS_EXIT_MARGIN_MS = 10_000;

async function helm(args: string[], values: Record<string, unknown> = {}) {
  const binary = Bun.which("helm");
  if (!binary) throw new Error("helm is required for chart render tests");
  const child = Bun.spawn([binary, "template", "drain", chart, ...args, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function render(values: Record<string, unknown> = {}, args: string[] = []) {
  const result = await helm(args, values);
  if (result.exitCode !== 0) throw new Error(`helm template failed: ${result.stderr}`);
  return parseAllDocuments(result.stdout)
    .map((document) => document.toJS() as Deployment)
    .filter((manifest) => manifest?.kind === "Deployment");
}

async function renderError(values: Record<string, unknown>): Promise<string> {
  const result = await helm([], values);
  expect(result.exitCode).not.toBe(0);
  return result.stderr;
}

function deployment(manifests: Deployment[], name: string): Deployment {
  const found = manifests.find((manifest) => manifest.metadata.name === name);
  if (!found) throw new Error(`missing Deployment ${name}`);
  return found;
}

function env(manifest: Deployment, name: string): string | undefined {
  return manifest.spec.template.spec.containers[0]?.env?.find((entry) => entry.name === name)
    ?.value;
}

/** The turn worker's effective sequence, as the worker resolves it from env. */
function turnSequence(manifest: Deployment) {
  const graceMs = Number(
    env(manifest, "OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS") ?? APP_DEFAULT_GRACE_MS,
  );
  const forceMs = Number(
    env(manifest, "OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS") ?? APP_DEFAULT_FORCE_MS,
  );
  return {
    graceMs,
    forceMs,
    podGraceMs: manifest.spec.template.spec.terminationGracePeriodSeconds * 1_000,
  };
}

function expectConsistentSequence(manifest: Deployment) {
  const { graceMs, forceMs, podGraceMs } = turnSequence(manifest);
  // Turns drain naturally before the checkpoint, keep a checkpoint window
  // before the SDK force stop, and the process exits before the kubelet kill.
  expect(graceMs).toBeGreaterThanOrEqual(0);
  expect(graceMs + CHECKPOINT_WINDOW_MS).toBeLessThanOrEqual(forceMs);
  expect(forceMs + PROCESS_EXIT_MARGIN_MS).toBeLessThan(podGraceMs);
}

describe("turn worker natural drain", () => {
  test("defaults surge a replacement and drain 90s naturally, force at 105s, inside 120s", async () => {
    const manifests = await render();
    const turns = deployment(manifests, "drain-opengeni-worker-turns");
    expect(turns.spec.strategy).toEqual({
      type: "RollingUpdate",
      rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    });
    expect(turnSequence(turns)).toEqual({ graceMs: 90_000, forceMs: 105_000, podGraceMs: 120_000 });
    expectConsistentSequence(turns);

    // The control worker keeps its own sequence and pod grace.
    const control = deployment(manifests, "drain-opengeni-worker-control");
    expect(control.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
    expect(env(control, "OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS")).toBeUndefined();
    expect(env(control, "OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS")).toBeUndefined();
  });

  test("a longer turn pod grace lengthens the derived drain without touching control", async () => {
    const manifests = await render({ worker: { turns: { terminationGracePeriodSeconds: 300 } } });
    const turns = deployment(manifests, "drain-opengeni-worker-turns");
    expect(turnSequence(turns)).toEqual({
      graceMs: 270_000,
      forceMs: 285_000,
      podGraceMs: 300_000,
    });
    expectConsistentSequence(turns);
    expect(
      deployment(manifests, "drain-opengeni-worker-control").spec.template.spec
        .terminationGracePeriodSeconds,
    ).toBe(120);
  });

  test("a shorter shared worker grace shortens the derived turn sequence to fit", async () => {
    const turns = deployment(
      await render({ worker: { terminationGracePeriodSeconds: 60 } }),
      "drain-opengeni-worker-turns",
    );
    expect(turnSequence(turns)).toEqual({ graceMs: 30_000, forceMs: 45_000, podGraceMs: 60_000 });
    expectConsistentSequence(turns);
  });

  test("explicit grace and force are rendered when they fit", async () => {
    const turns = deployment(
      await render({ worker: { turns: { shutdown: { graceSeconds: 60, forceSeconds: 100 } } } }),
      "drain-opengeni-worker-turns",
    );
    expect(turnSequence(turns)).toEqual({ graceMs: 60_000, forceMs: 100_000, podGraceMs: 120_000 });
    expectConsistentSequence(turns);
  });

  test("an explicit force time without the exit margin inside the pod grace fails", async () => {
    expect(await renderError({ worker: { turns: { shutdown: { forceSeconds: 110 } } } })).toContain(
      "worker.turns.shutdown.forceSeconds (110) plus the 10-second process exit margin must stay below the turn pod terminationGracePeriodSeconds (120)",
    );
    expect(
      await renderError({
        worker: { turns: { terminationGracePeriodSeconds: 90, shutdown: { forceSeconds: 100 } } },
      }),
    ).toContain("must stay below the turn pod terminationGracePeriodSeconds (90)");
  });

  test("an explicit grace that leaves no checkpoint window before the force time fails", async () => {
    expect(await renderError({ worker: { turns: { shutdown: { graceSeconds: 100 } } } })).toContain(
      "worker.turns.shutdown.graceSeconds (100) must end at least 10 seconds before forceSeconds (105)",
    );
    expect(
      await renderError({
        worker: { turns: { shutdown: { graceSeconds: 95, forceSeconds: 100 } } },
      }),
    ).toContain("graceSeconds (95) must end at least 10 seconds before forceSeconds (100)");
  });

  test("fractional or negative seconds are rejected", async () => {
    expect(await renderError({ worker: { turns: { shutdown: { graceSeconds: 90.5 } } } })).not.toBe(
      "",
    );
    expect(await renderError({ worker: { turns: { shutdown: { forceSeconds: 5 } } } })).not.toBe(
      "",
    );
    expect(
      await renderError({ worker: { turns: { terminationGracePeriodSeconds: -1 } } }),
    ).not.toBe("");
  });

  test("a variable set in config is owned there and not overridden by the chart", async () => {
    const turns = deployment(
      await render({ config: { OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS: "30000" } }),
      "drain-opengeni-worker-turns",
    );
    expect(env(turns, "OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS")).toBeUndefined();
    expect(env(turns, "OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS")).toBe("105000");
  });

  test("worker.extraEnv cannot silently fight the chart-owned sequence", async () => {
    expect(
      await renderError({
        worker: { extraEnv: [{ name: "OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS", value: "200000" }] },
      }),
    ).toContain("extraEnv cannot repeat a variable or override chart-owned environment entries");
  });

  test("every example profile renders a consistent turn drain sequence", async () => {
    const examples = (await readdir(chart)).filter((file) =>
      /^values\..+\.example\.yaml$/u.test(file),
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const manifests = await render({ secret: { create: true } }, ["-f", resolve(chart, example)]);
      const turns = manifests.find(
        (manifest) => manifest.metadata.name === "drain-opengeni-worker-turns",
      );
      if (turns) expectConsistentSequence(turns);
    }
  });
});
