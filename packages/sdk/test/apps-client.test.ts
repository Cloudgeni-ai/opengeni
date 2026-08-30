import { describe, expect, test } from "bun:test";

import {
  OpenGeniAppsClient,
  type OpenGeniAppsControlOperation,
  type OpenGeniAppsControlOperationMap,
  type OpenGeniAppsControlTransport,
} from "../src/apps";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const RELEASE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const LAUNCH_ID = "77777777-7777-4777-8777-777777777777";

describe("OpenGeni Apps SDK client", () => {
  test("keeps every Apps operation behind the injected control transport", async () => {
    const requests: Array<{ operation: OpenGeniAppsControlOperation; input: unknown }> = [];
    const transport: OpenGeniAppsControlTransport = {
      async request(operation, input) {
        requests.push({ operation, input });
        const outputs: {
          [K in OpenGeniAppsControlOperation]: OpenGeniAppsControlOperationMap[K]["output"];
        } = {
          "apps.list": { apps: [], nextCursor: null, truncated: false },
          "apps.get": {
            app: {
              id: APP_ID,
              accountId: ACCOUNT_ID,
              workspaceId: WORKSPACE_ID,
              slug: "status-console",
              title: "Status console",
              description: null,
              status: "active",
              version: 1,
              latestSourceRevisionId: null,
              latestBuildId: null,
              activeReleaseId: null,
              createdBySubjectId: "subject-1",
              createdAt: "2026-08-29T12:00:00.000Z",
              updatedAt: "2026-08-29T12:00:00.000Z",
            },
            sourceRevisions: [],
            builds: [],
            releases: [],
            previews: [],
            toolPolicies: [],
            historyTruncated: false,
          },
          "apps.runtime.catalog": {
            appId: APP_ID,
            releaseId: RELEASE_ID,
            toolPolicyRevisionId: POLICY_ID,
            catalogDigest: "a".repeat(64),
            tools: [],
          },
          "apps.runtime.availableCatalog": {
            appId: APP_ID,
            catalogDigest: "a".repeat(64),
            tools: [],
          },
          "apps.launch.create": {
            launchId: LAUNCH_ID,
            appId: APP_ID,
            releaseId: RELEASE_ID,
            authorityGeneration: "actor:7",
            launchUrl: "https://apps.example.test/run/1",
            appOrigin: "https://apps.example.test",
            nonce: "n".repeat(32),
            expiresAt: "2026-08-29T18:00:00.000Z",
          },
          "apps.runtime.tool.call": {
            operationId: OPERATION_ID,
            status: "succeeded",
            output: { ok: true },
            error: null,
            replayed: false,
          },
        };
        return outputs[operation] as never;
      },
    };
    const client = new OpenGeniAppsClient(transport);

    await client.listApps(" workspace-1 ", { limit: 20 });
    await client.getApp("workspace-1", "app-1");
    await client.getRuntimeCatalog("workspace-1", "app-1", RELEASE_ID);
    await client.getAvailableRuntimeCatalog("workspace-1", "app-1");
    await client.createLaunch("workspace-1", "app-1", { releaseId: RELEASE_ID });
    await client.callRuntimeTool(
      "workspace-1",
      "app-1",
      RELEASE_ID,
      LAUNCH_ID,
      "actor:7",
      "n".repeat(32),
      {
        operationId: OPERATION_ID,
        identity: { serverId: "status", toolName: "read" },
        input: {},
        catalogDigest: "a".repeat(64),
      },
    );

    expect(requests).toEqual([
      { operation: "apps.list", input: { workspaceId: "workspace-1", query: { limit: 20 } } },
      { operation: "apps.get", input: { workspaceId: "workspace-1", appId: "app-1" } },
      {
        operation: "apps.runtime.catalog",
        input: { workspaceId: "workspace-1", appId: "app-1", releaseId: RELEASE_ID },
      },
      {
        operation: "apps.runtime.availableCatalog",
        input: { workspaceId: "workspace-1", appId: "app-1" },
      },
      {
        operation: "apps.launch.create",
        input: {
          workspaceId: "workspace-1",
          appId: "app-1",
          request: { releaseId: RELEASE_ID },
        },
      },
      {
        operation: "apps.runtime.tool.call",
        input: {
          workspaceId: "workspace-1",
          appId: "app-1",
          releaseId: RELEASE_ID,
          launchId: LAUNCH_ID,
          authorityGeneration: "actor:7",
          launchNonce: "n".repeat(32),
          request: {
            operationId: OPERATION_ID,
            identity: { serverId: "status", toolName: "read" },
            input: {},
            catalogDigest: "a".repeat(64),
          },
        },
      },
    ]);
  });

  test("fails before transport dispatch for empty ids and weak launch nonces", async () => {
    let calls = 0;
    const client = new OpenGeniAppsClient({
      async request() {
        calls += 1;
        throw new Error("unreachable");
      },
    });
    await expect(client.getApp("workspace-1", " ")).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.callRuntimeTool("workspace-1", "app-1", "release-1", LAUNCH_ID, "actor:7", "weak", {
        operationId: "11111111-1111-4111-8111-111111111111",
        identity: { serverId: "status", toolName: "read" },
        input: {},
        catalogDigest: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });
});
