#!/usr/bin/env bun

import { getSettings } from "@opengeni/config";
import type { ConnectionCredentialsPort } from "@opengeni/contracts";
import { loadWorkspaceEnvironmentForRunWithCredentials } from "../apps/worker/src/activities/environment";

const counts = [1, 5, 25] as const;
const providerDelaysMs = [0, 10, 50, 100] as const;
const samples = 5;
const concurrency = 4;
const settings = getSettings();
const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

const receipts = [];
for (const count of counts) {
  const ids = Array.from({ length: count }, (_, index) => uuid(index + 1));
  for (const providerDelayMs of providerDelaysMs) {
    const sequential: number[] = [];
    const bounded: number[] = [];
    let sequentialPeak = 0;
    let boundedPeak = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const sequentialProvider = provider(ids, providerDelayMs);
      const sequentialStartedAt = performance.now();
      const current = await loadSequential(ids, sequentialProvider.load);
      sequential.push(performance.now() - sequentialStartedAt);
      sequentialPeak = Math.max(sequentialPeak, sequentialProvider.peak());

      const boundedProvider = provider(ids, providerDelayMs);
      const boundedStartedAt = performance.now();
      const candidate = await loadBounded(ids, boundedProvider.load, concurrency);
      bounded.push(performance.now() - boundedStartedAt);
      boundedPeak = Math.max(boundedPeak, boundedProvider.peak());
      if (JSON.stringify(candidate) !== JSON.stringify(current)) {
        throw new Error(`ordered merge parity failed for count=${count} delay=${providerDelayMs}`);
      }
      if (current.ORDER !== String(count - 1) || Object.keys(current).length !== count + 1) {
        throw new Error(`current precedence/result failed for count=${count}`);
      }
    }
    receipts.push({
      count,
      providerDelayMs,
      samples,
      concurrency,
      sequentialMs: distribution(sequential),
      boundedMs: distribution(bounded),
      sequentialPeak,
      boundedPeak,
      contentParity: "pass",
    });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      modelCalls: 0,
      invariant:
        "Both paths call the exact host sandboxSecrets loader once per distinct frozen variable-set id and merge complete values in listed order; later sets retain precedence.",
      receipts,
    },
    null,
    2,
  )}\n`,
);

function provider(ids: string[], delayMs: number) {
  const byId = new Map(ids.map((id, index) => [id, index]));
  let active = 0;
  let maximum = 0;
  const load: NonNullable<ConnectionCredentialsPort["sandboxSecrets"]> = async (request) => {
    const index = byId.get(request.variableSetId);
    if (index === undefined) throw new Error("unexpected variable set id");
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        workspaceId: scope.workspaceId,
        id: request.variableSetId,
        name: `set-${index}`,
        description: null,
        values: {
          [`SET_${String(index).padStart(2, "0")}`]: "x".repeat(1_024),
          ORDER: String(index),
        },
      };
    } finally {
      active -= 1;
    }
  };
  return { load, peak: () => maximum };
}

async function loadSequential(
  ids: string[],
  sandboxSecrets: NonNullable<ConnectionCredentialsPort["sandboxSecrets"]>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const id of ids) {
    const loaded = await loadWorkspaceEnvironmentForRunWithCredentials(
      null as never,
      settings,
      scope,
      id,
      sandboxSecrets,
    );
    Object.assign(values, loaded?.values ?? {});
  }
  return values;
}

async function loadBounded(
  ids: string[],
  sandboxSecrets: NonNullable<ConnectionCredentialsPort["sandboxSecrets"]>,
  width: number,
): Promise<Record<string, string>> {
  const loaded = new Array<Record<string, string>>(ids.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, ids.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        const id = ids[index];
        if (!id) return;
        const value = await loadWorkspaceEnvironmentForRunWithCredentials(
          null as never,
          settings,
          scope,
          id,
          sandboxSecrets,
        );
        loaded[index] = value?.values ?? {};
      }
    }),
  );
  return Object.assign({}, ...loaded);
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}
