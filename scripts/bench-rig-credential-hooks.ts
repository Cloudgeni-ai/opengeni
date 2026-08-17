#!/usr/bin/env bun

import {
  runBeforeAgentStartHooks,
  sandboxLifecycleHooksForIds,
} from "../packages/runtime/src/index";

const counts = [1, 2, 10, 50] as const;
const commandRoundTripsMs = [0, 20, 100] as const;
const samples = 5;
const environment = {
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "secret",
  AZURE_TENANT_ID: "tenant",
};

const receipts = [];
for (const count of counts) {
  for (const commandRoundTripMs of commandRoundTripsMs) {
    const durations: number[] = [];
    const commandCounts: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      let commands = 0;
      const hooks = sandboxLifecycleHooksForIds(Array(count).fill("azure-cli-login"));
      const startedAt = performance.now();
      await runBeforeAgentStartHooks({} as never, hooks, {
        environment,
        commandRunner: async () => {
          commands += 1;
          if (commandRoundTripMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, commandRoundTripMs));
          }
          return { exitCode: 0, output: "" };
        },
      });
      durations.push(performance.now() - startedAt);
      commandCounts.push(commands);
    }
    receipts.push({
      count,
      commandRoundTripMs,
      samples,
      durationMs: distribution(durations),
      commandCounts,
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
        "The exact runtime hook resolver and beforeAgentStart runner receive the rig's credential-hook list; every resulting hook command is counted without contacting Azure.",
      receipts,
    },
    null,
    2,
  )}\n`,
);

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
