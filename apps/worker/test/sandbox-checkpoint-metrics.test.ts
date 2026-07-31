import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  recordSandboxCheckpointArtifactGauges,
  recordSandboxCheckpointArtifactOutcome,
  recordSandboxDeadlineRotationsRequested,
  recordSandboxRotationBacklogGauges,
} from "../src/observability-metrics";

function workerObservability() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("sandbox checkpoint and deadline metrics", () => {
  test("publishes every bounded lifecycle/backlog series, including zeroes", async () => {
    const observability = workerObservability();
    recordSandboxCheckpointArtifactGauges(observability, {
      candidate: 1,
      current: 2,
      previous: 3,
      delete_pending: 4,
      deleting: 5,
      delete_failed: 6,
      deleted: 7,
    });
    recordSandboxRotationBacklogGauges(observability, {
      requested: 8,
      overdue: 0,
      turnBlocked: 9,
      directBlocked: 10,
      processBlocked: 11,
    });

    const metrics = await observability.prometheusMetrics();
    for (const [state, value] of Object.entries({
      candidate: 1,
      current: 2,
      previous: 3,
      delete_pending: 4,
      deleting: 5,
      delete_failed: 6,
      deleted: 7,
    })) {
      expect(metrics).toMatch(
        new RegExp(
          `opengeni_sandbox_checkpoint_artifacts\\{[^}]*state="${state}"[^}]*\\} ${value}\\b`,
        ),
      );
    }
    for (const [kind, value] of Object.entries({
      requested: 8,
      overdue: 0,
      turn_blocked: 9,
      direct_blocked: 10,
      process_blocked: 11,
    })) {
      expect(metrics).toMatch(
        new RegExp(`opengeni_sandbox_rotation_backlog\\{[^}]*kind="${kind}"[^}]*\\} ${value}\\b`),
      );
    }
  });

  test("counts only positive, fixed-cardinality operation outcomes", async () => {
    const observability = workerObservability();
    recordSandboxCheckpointArtifactOutcome(observability, "claimed", 3);
    recordSandboxCheckpointArtifactOutcome(observability, "deleted", 0);
    recordSandboxDeadlineRotationsRequested(observability, 2);
    recordSandboxDeadlineRotationsRequested(observability, 0);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_checkpoint_artifact_operations_total\{[^}]*outcome="claimed"[^}]*\} 3\b/,
    );
    expect(metrics).not.toMatch(
      /opengeni_sandbox_checkpoint_artifact_operations_total\{outcome="deleted"/,
    );
    expect(metrics).toMatch(/opengeni_sandbox_deadline_rotations_requested_total\{[^}]*\} 2\b/);
  });
});
