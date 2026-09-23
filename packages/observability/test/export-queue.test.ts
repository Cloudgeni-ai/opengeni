import { expect, test } from "bun:test";
import { ExportQueue } from "../src/export-queue";
import { createObservability } from "../src";

test("outage retries stop at three, recover and never expose exception data", async () => {
  const outcomes: string[] = [];
  const queue = new ExportQueue((outcome) => outcomes.push(outcome));
  let calls = 0;
  queue.enqueue(async () => {
    calls++;
    throw new Error("SECRET_CANARY");
  });
  queue.enqueue(async () => {});
  await queue.flush();
  expect(calls).toBe(3);
  expect(outcomes).toEqual(["retried", "retried", "failed", "exported"]);
});

test("hung exporter has bounded outstanding work and flush deadline", async () => {
  const outcomes: string[] = [];
  const queue = new ExportQueue((outcome) => outcomes.push(outcome));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  for (let i = 0; i < 1000; i++)
    queue.enqueue(async () => {
      calls++;
      await blocked;
    });
  const started = performance.now();
  await queue.flush(10);
  expect(performance.now() - started).toBeLessThan(500);
  expect(calls).toBe(1);
  expect(outcomes.filter((x) => x === "dropped")).toHaveLength(744);
  release();
  await queue.flush();
  expect(calls).toBe(256);
});

test("public batch saturation exposes drops and never creates concurrent export requests", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  let calls = 0;
  const obs = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityMetricsEnabled: true,
      observabilityStructuredLogs: false,
      observabilityOtlpEndpoint: "http://collector",
      observabilityOtlpHeaders: "",
    },
    {
      component: "api",
      exporter: async (_url, body) => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        expect((body as any).resourceSpans.length).toBeLessThanOrEqual(32);
        await blocked;
        active--;
      },
    },
  );
  for (let i = 0; i < 10000; i++) obs.startSpan("bounded").end();
  await obs.flush(5);
  expect(peak).toBe(1);
  expect(calls).toBe(1);
  const metrics = await obs.prometheusMetrics();
  expect(metrics).toMatch(
    /opengeni_telemetry_exports_total\{[^\n]*outcome="dropped"[^\n]*\} [1-9]/,
  );
  release();
  await obs.flush();
  expect(peak).toBe(1);
  expect(calls).toBeLessThanOrEqual(9);
});
