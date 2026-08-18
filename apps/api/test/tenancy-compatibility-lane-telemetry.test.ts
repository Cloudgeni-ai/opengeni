// OPE-204 phase E: a pre-0277 `/workspace` writer with no recorded authority
// is a bounded compatibility lane, not a fault. It must be countable so an
// operator can watch it drain, and the count must stay content-free and
// separate from the structural failure signal operators page on.
import { describe, expect, test } from "bun:test";
import { createObservability, type Observability } from "@opengeni/observability";
import {
  channelAOperationFailureDiagnostic,
  observeChannelAOperationFailure,
  type ChannelAServices,
} from "../src/sandbox/channel-a";

function observability(): Observability {
  return createObservability(
    {
      serviceName: "opengeni",
      environment: "test",
      deploymentRevision: "revision-test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: true,
      observabilityOtlpHeaders: "",
    },
    { component: "api", now: () => 1 },
  );
}

/** The fence type lives in `@opengeni/db` and is raised deep inside admission;
 * the API classifies it structurally, exactly as reproduced here. */
function fenced(code: string): Error {
  const error = new Error(`workspace writer fenced: ${code}`);
  error.name = "SandboxWorkspaceMutationFencedError";
  return Object.assign(error, { code });
}

async function laneCount(obs: Observability, lane: string): Promise<number | null> {
  const line = (await obs.prometheusMetrics())
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith("opengeni_tenancy_compatibility_lane_uses_total{") &&
        candidate.includes(`lane="${lane}"`),
    );
  if (!line) return null;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

function observe(obs: Observability, error: unknown): void {
  observeChannelAOperationFailure({ observability: obs } as unknown as ChannelAServices, {
    workspaceId: "1f9c9a34-0c7f-4f8f-9d64-0f2f7f4f2f11",
    sandboxGroupId: "2f9c9a34-0c7f-4f8f-9d64-0f2f7f4f2f22",
    backend: "modal",
    operation: "fs.write",
    durationMs: 12,
    error,
  });
}

describe("workspace-writer compatibility lane telemetry", () => {
  test("counts an unattributed pre-0277 writer as a compatibility lane use", async () => {
    const obs = observability();
    observe(obs, fenced("authority_unattributed"));
    expect(await laneCount(obs, "workspace_writer_unattributed")).toBe(1);

    const metrics = await obs.prometheusMetrics();
    const laneLines = metrics
      .split("\n")
      .filter((line) => line.startsWith("opengeni_tenancy_compatibility_lane_uses_total{"))
      .join("\n");
    // Content-free: no workspace, sandbox group, backend, or operation.
    expect(laneLines).not.toContain("1f9c9a34");
    expect(laneLines).not.toContain("2f9c9a34");
    expect(laneLines).not.toContain("modal");
    expect(laneLines).not.toContain("fs.write");
  });

  test("a revoked grant is an authorization outcome, not a compatibility lane", async () => {
    const obs = observability();
    observe(obs, fenced("authority_revoked"));
    expect(await laneCount(obs, "workspace_writer_unattributed")).toBe(0);
  });

  test("ordinary fences and unrelated failures never touch the lane counter", async () => {
    const obs = observability();
    observe(obs, fenced("attempt_fenced"));
    observe(obs, fenced("lease_fenced"));
    observe(obs, new Error("provider exploded"));
    expect(await laneCount(obs, "workspace_writer_unattributed")).toBe(0);
  });

  test("the lane stays out of the unexpected-failure signal operators page on", () => {
    // Both authority fences are deliberate rejections; only the lane counter
    // distinguishes the compatibility one.
    expect(channelAOperationFailureDiagnostic(fenced("authority_unattributed"))).toEqual({
      reason: "request_rejected",
      status: 409,
      errorCode: "sandbox_channel_a_operation_failed",
    });
    expect(channelAOperationFailureDiagnostic(fenced("authority_revoked"))).toEqual({
      reason: "request_rejected",
      status: 403,
      errorCode: "sandbox_channel_a_operation_failed",
    });
  });
});
