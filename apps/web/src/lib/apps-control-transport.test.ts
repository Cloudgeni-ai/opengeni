import { describe, expect, test } from "bun:test";
import type { OpenGeniAppsControlOperationMap } from "@opengeni/sdk/apps";

import { createOpenGeniAppsHttpTransport } from "./apps-control-transport";

const WORKSPACE_ID = "workspace / one";
const APP_ID = "app / one";

describe("standalone Apps HTTP transport", () => {
  test("maps reads to encoded same-origin routes", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
    const transport = createOpenGeniAppsHttpTransport(async (path, init) => {
      calls.push({ path, init });
      return {} as never;
    });

    await transport.request("apps.list", {
      workspaceId: WORKSPACE_ID,
      query: { limit: 25, cursor: "next / page" },
    });
    await transport.request("apps.get", {
      workspaceId: WORKSPACE_ID,
      appId: APP_ID,
    });
    await transport.request("apps.runtime.catalog", {
      workspaceId: WORKSPACE_ID,
      appId: APP_ID,
      releaseId: "release / one",
    });

    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/workspaces/workspace%20%2F%20one/apps?limit=25&cursor=next+%2F+page",
      "/v1/workspaces/workspace%20%2F%20one/apps/app%20%2F%20one",
      "/v1/workspaces/workspace%20%2F%20one/apps/app%20%2F%20one/runtime/catalog?releaseId=release+%2F+one",
    ]);
    expect(calls.every(({ init }) => init?.method === "GET")).toBe(true);
  });

  test("mints one bounded CSRF token and binds launch/tool identities in headers", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
    const transport = createOpenGeniAppsHttpTransport(async (path, init) => {
      calls.push({ path, init });
      if (path.endsWith("/csrf")) {
        return { token: "c".repeat(43), expiresInSeconds: 3600 } as never;
      }
      return {} as never;
    });
    const launch = {
      workspaceId: WORKSPACE_ID,
      appId: APP_ID,
      request: { releaseId: "11111111-1111-4111-8111-111111111111" },
    } satisfies OpenGeniAppsControlOperationMap["apps.launch.create"]["input"];
    await transport.request("apps.launch.create", launch);
    await transport.request("apps.runtime.tool.call", {
      workspaceId: WORKSPACE_ID,
      appId: APP_ID,
      releaseId: "11111111-1111-4111-8111-111111111111",
      launchId: "22222222-2222-4222-8222-222222222222",
      authorityGeneration: "actor:7:authority",
      launchNonce: "launch_abcdefghijklmnopqrstuvwxyz012345",
      request: {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: "a".repeat(64),
        identity: { serverId: "docs", toolName: "search_documents" },
        input: { query: "status" },
      },
    });

    expect(calls.filter(({ path }) => path.endsWith("/csrf"))).toHaveLength(1);
    expect(calls[1]!.path).toEndWith("/launches");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(launch.request);
    expect(new Headers(calls[1]!.init?.headers).get("x-opengeni-app-csrf")).toBe("c".repeat(43));
    const toolHeaders = new Headers(calls[2]!.init?.headers);
    expect(toolHeaders.get("x-opengeni-app-release-id")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(toolHeaders.get("x-opengeni-app-launch-id")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(toolHeaders.get("x-opengeni-app-authority-generation")).toBe("actor:7:authority");
    expect(toolHeaders.get("x-opengeni-app-launch-nonce")).toBe(
      "launch_abcdefghijklmnopqrstuvwxyz012345",
    );
  });

  test("rejects malformed CSRF responses before a mutation", async () => {
    const transport = createOpenGeniAppsHttpTransport(
      async () =>
        ({
          token: "short",
          expiresInSeconds: 3600,
        }) as never,
    );
    await expect(
      transport.request("apps.launch.create", {
        workspaceId: WORKSPACE_ID,
        appId: APP_ID,
        request: {},
      }),
    ).rejects.toThrow("invalid Apps CSRF token");
  });
});
