import { describe, expect, test } from "bun:test";
import {
  requestStaleRigProviderImageRefresh,
  rigProviderImageRefreshWorkflowId,
} from "../src/activities/rig-provider-image-refresh";

const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT = `sha256:${"b".repeat(64)}`;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("stale sandbox environment provider image refresh", () => {
  test("a ready image built on an older base asks once for a rebuild on the current base", async () => {
    const starts: unknown[] = [];
    const requested = requestStaleRigProviderImageRefresh({
      selection: { reason: "content_mismatch", contentHash: CONTENT },
      turnUsesDeploymentBase: true,
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      start: async (input) => {
        starts.push(input);
        return "started";
      },
      warn: () => {
        throw new Error("no warning expected");
      },
    });
    await settle();
    expect(requested).toBe(true);
    expect(starts).toEqual([
      { workspaceId: WORKSPACE_ID, versionId: VERSION_ID, contentHash: CONTENT },
    ]);
  });

  test("selected, missing, unproven and binding-mismatched images start nothing", async () => {
    let starts = 0;
    for (const reason of [
      "selected",
      "missing",
      "not_ready",
      "not_cold_boot_validated",
      "provider_unsupported",
      "provider_binding_unavailable",
      "provider_binding_mismatch",
    ] as const) {
      const requested = requestStaleRigProviderImageRefresh({
        selection: { reason, contentHash: CONTENT },
        turnUsesDeploymentBase: true,
        workspaceId: WORKSPACE_ID,
        versionId: VERSION_ID,
        start: async () => {
          starts += 1;
          return "started";
        },
        warn: () => undefined,
      });
      expect(requested).toBe(false);
    }
    await settle();
    expect(starts).toBe(0);
  });

  test("a version with setup that was never built for the backend asks once for a build", async () => {
    const starts: unknown[] = [];
    const requested = requestStaleRigProviderImageRefresh({
      selection: { reason: "unbuilt", contentHash: CONTENT },
      turnUsesDeploymentBase: true,
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      start: async (input) => {
        starts.push(input);
        return "started";
      },
      warn: () => {
        throw new Error("no warning expected");
      },
    });
    await settle();
    expect(requested).toBe(true);
    expect(starts).toEqual([
      { workspaceId: WORKSPACE_ID, versionId: VERSION_ID, contentHash: CONTENT },
    ]);
  });

  test("a build that stopped without finishing asks once for a new build", async () => {
    const starts: unknown[] = [];
    const requested = requestStaleRigProviderImageRefresh({
      selection: { reason: "build_abandoned", contentHash: CONTENT },
      turnUsesDeploymentBase: true,
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      start: async (input) => {
        starts.push(input);
        return "started";
      },
      warn: () => {
        throw new Error("no warning expected");
      },
    });
    await settle();
    expect(requested).toBe(true);
    expect(starts).toEqual([
      { workspaceId: WORKSPACE_ID, versionId: VERSION_ID, contentHash: CONTENT },
    ]);
  });

  test("a turn on a workspace-selected base never asks for a deployment-base rebuild", async () => {
    let starts = 0;
    const requested = requestStaleRigProviderImageRefresh({
      selection: { reason: "content_mismatch", contentHash: CONTENT },
      turnUsesDeploymentBase: false,
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      start: async () => {
        starts += 1;
        return "started";
      },
      warn: () => undefined,
    });
    await settle();
    expect(requested).toBe(false);
    expect(starts).toBe(0);
  });

  test("a failed start only warns; the turn never waits on or fails from it", async () => {
    const warnings: string[] = [];
    const requested = requestStaleRigProviderImageRefresh({
      selection: { reason: "content_mismatch", contentHash: CONTENT },
      turnUsesDeploymentBase: true,
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      start: async () => {
        throw new Error("temporal unavailable");
      },
      warn: (message) => warnings.push(message),
    });
    expect(requested).toBe(true);
    await settle();
    expect(warnings).toEqual(["sandbox environment provider image refresh could not start"]);
  });

  test("the workflow id dedupes per version, content and UTC day", () => {
    const now = new Date("2026-11-03T23:59:00.000Z");
    const first = rigProviderImageRefreshWorkflowId({
      versionId: VERSION_ID,
      contentHash: CONTENT,
      now,
    });
    expect(first).toBe(
      rigProviderImageRefreshWorkflowId({ versionId: VERSION_ID, contentHash: CONTENT, now }),
    );
    expect(first).not.toBe(
      rigProviderImageRefreshWorkflowId({
        versionId: VERSION_ID,
        contentHash: `sha256:${"c".repeat(64)}`,
        now,
      }),
    );
    expect(first).not.toBe(
      rigProviderImageRefreshWorkflowId({
        versionId: VERSION_ID,
        contentHash: CONTENT,
        now: new Date("2026-11-04T00:01:00.000Z"),
      }),
    );
  });
});
