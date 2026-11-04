import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import {
  recordModelPreparationPhase,
  recordRepositorySkillDiscoveryFailure,
  runtimeMetricsHooksForObservability,
} from "../src/observability-metrics";

function workerObservability() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("repository skill discovery metrics", () => {
  test("a missing skills folder is its own setup-operation outcome", async () => {
    const observability = workerObservability();
    const hooks = runtimeMetricsHooksForObservability(observability);
    hooks.onSandboxSetupOperation?.({
      backend: "modal",
      op: "listDir",
      purpose: "repository_skills",
      outcome: "not_found",
      durationSeconds: 0.1,
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_setup_operation_duration_seconds_count\{[^}]*outcome="not_found"[^}]*\} 1/,
    );
    expect(metrics).not.toMatch(
      /opengeni_sandbox_setup_operation_duration_seconds_count\{[^}]*outcome="failed"/,
    );
    await observability.flush();
  });

  test("discovery failures carry a bounded error class and handling", async () => {
    const observability = workerObservability();
    recordRepositorySkillDiscoveryFailure(observability, {
      backend: "modal",
      errorClass: "permission_denied",
      handling: "degraded",
    });
    recordRepositorySkillDiscoveryFailure(observability, {
      backend: "private-provider",
      errorClass: "secret message text",
      handling: "secret",
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_repository_skill_discovery_failures_total\{[^}]*backend="modal"[^}]*error_class="permission_denied"[^}]*handling="degraded"[^}]*\} 1/,
    );
    expect(metrics).toMatch(
      /opengeni_repository_skill_discovery_failures_total\{[^}]*backend="unknown"[^}]*error_class="other"[^}]*handling="other"[^}]*\} 1/,
    );
    expect(metrics).not.toContain("secret");
    expect(metrics).not.toContain("private-provider");
    await observability.flush();
  });

  test("a failed discovery measurement from the runtime reaches the failure counter", async () => {
    const observability = workerObservability();
    recordModelPreparationPhase(observability, {
      provider: "openai",
      backend: "modal",
      measurement: {
        phase: "repository_skill_discovery",
        outcome: "failed",
        durationSeconds: 0.2,
        count: 2,
        failure: { errorClass: "workspace_unavailable", handling: "propagated" },
      },
    });
    recordModelPreparationPhase(observability, {
      provider: "openai",
      backend: "modal",
      measurement: {
        phase: "repository_skill_discovery",
        outcome: "completed",
        durationSeconds: 0.1,
      },
    });
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_repository_skill_discovery_failures_total\{[^}]*error_class="workspace_unavailable"[^}]*handling="propagated"[^}]*\} 1/,
    );
    expect(metrics).toContain("model_prepare_repository_skill_discovery");
    await observability.flush();
  });
});
