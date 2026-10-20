import { expect, test } from "bun:test";
import { fleetAgentProgress } from "../src/sandbox/fleet";
import type { EnrollmentRecord } from "@opengeni/db";

test("fleet reports a retained update hold without leaking connection coordinates", () => {
  const update: NonNullable<EnrollmentRecord["agentUpdate"]> = {
    operationId: "00000000-0000-4000-8000-000000000001",
    status: "waiting_for_idle",
    targetVersion: "0.1.109",
    expectedBinarySha256: null,
    errorCode: "update_busy_interactions",
    retryable: true,
    rolledBack: false,
    connectionInstanceId: "private-connection",
    connectionGeneration: 7,
    requestedAt: "2026-10-20T01:00:00Z",
    updatedAt: "2026-10-20T02:00:00Z",
    completedAt: null,
  };
  expect(fleetAgentProgress({ agentVersion: "0.1.108", agentUpdate: update })).toEqual({
    agentVersion: "0.1.108",
    agentUpdate: {
      status: "waiting_for_idle",
      targetVersion: "0.1.109",
      waitingReason: "update_busy_interactions",
      requestedAt: update.requestedAt,
      updatedAt: update.updatedAt,
    },
  });
  expect(
    fleetAgentProgress({ agentVersion: "0.1.109", agentUpdate: { ...update, status: "succeeded" } })
      .agentUpdate?.waitingReason,
  ).toBeNull();
  expect(
    fleetAgentProgress({ agentVersion: "0.1.108", agentUpdate: { ...update, status: "failed" } })
      .agentUpdate?.waitingReason,
  ).toBe("update_busy_interactions");
  expect(fleetAgentProgress({ agentVersion: null, agentUpdate: null })).toEqual({
    agentVersion: null,
    agentUpdate: null,
  });
});
