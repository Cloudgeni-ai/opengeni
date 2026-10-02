import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  recordSandboxCheckpointArtifactGauges,
  recordSandboxCheckpointArtifactOutcome,
  recordSandboxDeadlineRotationsRequested,
  recordSandboxInventoryProjectionFailure,
  recordSandboxInventoryProjectionSuccess,
  recordSandboxAutomaticRecoverySelected,
  recordSandboxRecoveryObservationGauges,
  sandboxAutomaticRecoveryOutcome,
  recordSandboxProviderMissingBeforeCapture,
  recordSandboxRotationBacklogGauges,
  runtimeMetricsHooksForObservability,
} from "../src/observability-metrics";
import { recordWorkspaceCaptureCompleted } from "../src/activities/workspace-capture";

function workerObservability() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("sandbox checkpoint and deadline metrics", () => {
  test("physical capture timing uses bounded backend and outcome labels", async () => {
    const observability = workerObservability();
    const hooks = runtimeMetricsHooksForObservability(observability);
    hooks.onWorkspaceCapture?.({ backend: "modal", outcome: "completed", durationSeconds: 60 });
    hooks.onWorkspaceCapture?.({
      backend: "private-provider",
      outcome: "failed",
      durationSeconds: 2,
    });
    hooks.onWorkspaceCapture?.({ backend: "modal", outcome: "completed", durationSeconds: NaN });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toContain("opengeni_workspace_capture_duration_seconds");
    expect(metrics).toContain('backend="unknown"');
    expect(metrics).toContain('outcome="failed"');
    expect(metrics).not.toContain("private-provider");
    expect(metrics).not.toContain("NaN");
    await observability.flush();
  });
  test("physical and logical capture timings coexist in one worker registry", async () => {
    // The runtime hook (physical warm capture) and the turn-end logical capture
    // share the worker's Observability. Each histogram keeps its own label set,
    // so recording both in either order must not fail the registry.
    for (const physicalFirst of [true, false]) {
      const observability = workerObservability();
      const hooks = runtimeMetricsHooksForObservability(observability);
      const physical = () =>
        hooks.onWorkspaceCapture?.({ backend: "modal", outcome: "completed", durationSeconds: 3 });
      const logical = () => recordWorkspaceCaptureCompleted(observability, 1_500);
      if (physicalFirst) {
        physical();
        logical();
      } else {
        logical();
        physical();
      }
      const metrics = await observability.prometheusMetrics();
      expect(metrics).toMatch(
        /opengeni_workspace_capture_duration_seconds_count\{[^}]*backend="modal"[^}]*\} 1/,
      );
      expect(metrics).toMatch(
        /opengeni_workspace_capture_revision_duration_seconds_count\{[^}]*\} 1/,
      );
      expect(metrics).toContain("opengeni_workspace_capture_total{");
      await observability.flush();
    }
  });
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
      interactionBlocked: 12,
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
      interaction_blocked: 12,
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

  test("provider-before-capture loss has only a bounded backend label", async () => {
    const observability = workerObservability();
    recordSandboxProviderMissingBeforeCapture(observability, "modal");
    recordSandboxProviderMissingBeforeCapture(observability, "opaque-instance-id");

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_provider_missing_before_capture_total\{[^}]*backend="modal"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_provider_missing_before_capture_total\{[^}]*backend="unknown"[^}]*\} 1\b/,
    );
    expect(metrics).not.toContain("opaque-instance-id");
  });

  test("publishes bounded per-domain projection freshness and failures", async () => {
    const observability = workerObservability();
    recordSandboxInventoryProjectionSuccess(observability, "leases", 1_700_000_000);
    recordSandboxInventoryProjectionSuccess(observability, "checkpoint_artifacts", 1_700_000_001);
    recordSandboxInventoryProjectionFailure(observability, "leases");

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_inventory_refresh_timestamp_seconds\{[^}]*domain="leases"[^}]*\} 1700000000\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_inventory_refresh_timestamp_seconds\{[^}]*domain="checkpoint_artifacts"[^}]*\} 1700000001\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_inventory_refresh_failures_total\{[^}]*domain="leases"[^}]*\} 1\b/,
    );
  });

  test("projects committed recovery observations as bounded fixed-kind gauges", async () => {
    const observability = workerObservability();
    recordSandboxRecoveryObservationGauges(observability, {
      providerLosses: 2,
      fallbackSelections: 1,
    });
    recordSandboxInventoryProjectionSuccess(observability, "recovery_observations", 1_700_000_002);
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_recovery_observations_recent\{[^}]*kind="provider_missing_before_capture"[^}]*\} 2\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_recovery_observations_recent\{[^}]*kind="checkpoint_fallback_selected"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_recovery_observations_recent\{[^}]*kind="fresh_workspace_selected"[^}]*\} 0\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_inventory_refresh_timestamp_seconds\{[^}]*domain="recovery_observations"[^}]*\} 1700000002\b/,
    );
  });

  test("automatic continuity outcomes stay a closed low-cardinality set", async () => {
    const observability = workerObservability();
    expect(sandboxAutomaticRecoveryOutcome({ lane: "checkpoint", groupSessionCount: 1 })).toBe(
      "selected",
    );
    expect(sandboxAutomaticRecoveryOutcome({ lane: "checkpoint", groupSessionCount: 3 })).toBe(
      "selected_shared",
    );
    expect(sandboxAutomaticRecoveryOutcome({ lane: "fresh_workspace", groupSessionCount: 3 })).toBe(
      "fresh_workspace",
    );
    recordSandboxAutomaticRecoverySelected(observability, "modal", "selected_shared");
    recordSandboxAutomaticRecoverySelected(observability, "modal", "fresh_workspace");
    recordSandboxAutomaticRecoverySelected(observability, "sb-provider-id", "fresh_workspace");
    recordSandboxRecoveryObservationGauges(observability, {
      providerLosses: 1,
      fallbackSelections: 0,
      freshWorkspaceSelections: 2,
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_checkpoint_fallback_total\{[^}]*backend="modal"[^}]*outcome="selected_shared"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_checkpoint_fallback_total\{[^}]*backend="modal"[^}]*outcome="fresh_workspace"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_checkpoint_fallback_total\{[^}]*backend="unknown"[^}]*outcome="fresh_workspace"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_recovery_observations_recent\{[^}]*kind="fresh_workspace_selected"[^}]*\} 2\b/,
    );
    expect(metrics).not.toContain("sb-provider-id");
  });
});
