import { expect, test } from "bun:test";
import type { EnrollmentRecord } from "@opengeni/db";
import { fleetAgentProgress } from "../src/sandbox/fleet";

test("fleet reports retained blockers and elapsed hold without connection authority", () => {
  const update: NonNullable<EnrollmentRecord["agentUpdate"]> = {
    operationId: "00000000-0000-4000-8000-000000000001",
    status: "waiting_for_idle",
    targetVersion: "0.1.109",
    expectedBinarySha256: null,
    errorCode: "update_busy_interactions",
    retryable: true,
    rolledBack: false,
    connectionInstanceId: "connection-private-to-owner",
    connectionGeneration: 7,
    requestedAt: "2026-10-20T01:00:00Z",
    updatedAt: "2026-10-20T02:00:00Z",
    completedAt: null,
    blockers: [{ kind: "browser_action", count: 1 }],
  };
  const progress = fleetAgentProgress(
    { agentVersion: "0.1.108", agentUpdate: update },
    Date.parse("2026-10-20T03:00:00Z"),
  );
  expect(progress.agentUpdate).toEqual({
    status: update.status,
    targetVersion: update.targetVersion,
    errorCode: update.errorCode,
    requestedAt: update.requestedAt,
    updatedAt: update.updatedAt,
    waitingForMs: 2 * 60 * 60_000,
    blockers: update.blockers,
  });
  expect(JSON.stringify(progress)).not.toContain(update.connectionInstanceId);
  expect(fleetAgentProgress({ agentVersion: null, agentUpdate: null })).toEqual({
    agentVersion: null,
    agentUpdate: null,
  });
  expect(
    fleetAgentProgress({
      agentVersion: "0.1.109",
      agentUpdate: { ...update, status: "succeeded", blockers: [] },
    }).agentUpdate?.waitingForMs,
  ).toBeNull();
});
