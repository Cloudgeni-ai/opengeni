#!/usr/bin/env bun

import { verifyRigProviderImageColdBoot } from "../apps/worker/src/activities/rig-verification";

const counts = [0, 1, 10, 100] as const;
const commandRoundTripsMs = [0, 20, 100] as const;
const samples = 3;
const receipts = [];

for (const count of counts) {
  const checks = Array.from({ length: count }, (_, index) => ({
    name: `check-${index}`,
    command: `true # check-${index}`,
  }));
  for (const commandRoundTripMs of commandRoundTripsMs) {
    const durations: number[] = [];
    const commandCounts: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      let commands = 0;
      const startedAt = performance.now();
      await verifyRigProviderImageColdBoot(
        {
          settings: { rigSetupTimeoutMs: 120_000 } as never,
          db: {} as never,
          observability: {} as never,
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          buildRequestId: "33333333-3333-4333-8333-333333333333",
          rigVersionId: "44444444-4444-4444-8444-444444444444",
          sessionIdPrefix: "rig-check-benchmark",
          imageId: "im-benchmark",
          contentHash: `sha256:${"a".repeat(64)}`,
          checks,
          lifecycle: {
            signal: new AbortController().signal,
            cleanupDeadlineAtMs: null,
            dispose: () => undefined,
          },
        },
        {
          runOwnedSandbox: async (_input, run) =>
            await run(
              {
                backendId: "modal",
                client: {},
                instanceId: "sb-benchmark",
                session: {},
                sessionState: {},
              } as never,
              {
                signal: new AbortController().signal,
                commandRunner: async () => {
                  commands += 1;
                  if (commandRoundTripMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, commandRoundTripMs));
                  }
                  return { exitCode: 0, output: "ok" };
                },
                ownership: {
                  leaseId: "lease-benchmark",
                  leaseEpoch: 1,
                  workspaceGeneration: 0,
                  instanceId: "sb-benchmark",
                },
              },
            ),
          now: () => new Date(0),
        },
      );
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
        "The provider-image cold-boot validator executes one marker probe and every declared check in listed order; the benchmark replaces only command transport latency.",
      receipts,
    },
    null,
    2,
  )}\n`,
);

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  };
}
