import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { runtimeMetricsHooksForObservability } from "../src/observability-metrics";

describe("sandbox create image-source metrics", () => {
  test("separates provider-immutable starts from logical-image starts with bounded labels", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const hooks = runtimeMetricsHooksForObservability(observability);
    hooks.onSandboxCreate?.({
      backend: "modal",
      imageSource: "provider_immutable",
      outcome: "completed",
      durationSeconds: 7.5,
    });
    hooks.onSandboxCreate?.({
      backend: "modal",
      imageSource: "logical",
      outcome: "completed",
      durationSeconds: 18,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_creates_total\{[^}]*backend="modal"[^}]*image_source="provider_immutable"[^}]*outcome="completed"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_create_duration_seconds_sum\{[^}]*backend="modal"[^}]*image_source="provider_immutable"[^}]*\} 7\.5\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_create_duration_seconds_sum\{[^}]*backend="modal"[^}]*image_source="logical"[^}]*\} 18\b/,
    );
    expect(metrics).not.toMatch(/image_id|rig_version_id|workspace_id|session_id/);
  });
});
