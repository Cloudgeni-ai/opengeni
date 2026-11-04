import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import {
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
});
