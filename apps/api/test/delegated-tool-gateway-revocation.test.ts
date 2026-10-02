import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import * as db from "@opengeni/db";
import * as runtime from "@opengeni/runtime/workspace-tool-gateway";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prepareWorkspaceToolGateway } from "../src/workspace-tool-gateway";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:gateway-person";

describe("delegated Codex Apps physical-request authority", () => {
  let active: boolean;
  let revokeAt: "never" | "token_refresh" | "native_authorization";
  let nativeReads: number;
  let providerCalls: number;
  let deps: ApiRouteDeps;
  let auth: {
    withAuthorization<T>(
      use: (token: { accessToken: string; chatgptAccountId: string | null }) => Promise<T>,
    ): Promise<T>;
  };
  const restores: Array<() => void> = [];

  beforeEach(() => {
    active = true;
    revokeAt = "never";
    nativeReads = 0;
    providerCalls = 0;
    const settings = testSettings({ productAccessMode: "managed" });
    settings.mcpServers = [
      {
        id: "codex_apps",
        url: "https://chatgpt.com/backend-api/codex/apps",
        transport: "streamable_http",
      },
    ];
    deps = { db: {} as db.Database, settings } as ApiRouteDeps;
    const profiles = spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: "gateway-person", name: "Person", email: "person@example.test" },
    ]);
    const native = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () => {
      nativeReads++;
      return {
        mode: "managed",
        subjectId,
        accountGrants: active
          ? [{ accountId: organizationId, subjectId, permissions: ["account:read"] }]
          : [],
        workspaceGrants: active
          ? [
              {
                accountId: organizationId,
                workspaceId,
                subjectId,
                principalKind: "human_session",
                permissions: ["workspace:read"],
              },
            ]
          : [],
        defaultAccountId: organizationId,
        defaultWorkspaceId: workspaceId,
      };
    });
    const catalog = spyOn(core, "resolveWorkspaceCatalogSettings").mockResolvedValue({
      settings,
    } as Awaited<ReturnType<typeof core.resolveWorkspaceCatalogSettings>>);
    const enabled = spyOn(core, "settingsWithEnabledCapabilityMcpServers").mockResolvedValue(
      settings,
    );
    const connections = spyOn(db, "buildConnectionTokenResolver").mockReturnValue(async () => ({
      status: "missing",
    }));
    const credential = spyOn(core, "resolveCodexAppsCredentialIdForRun").mockResolvedValue(
      "credential",
    );
    const tokens = spyOn(db, "buildCodexTokenResolver").mockReturnValue({
      getToken: async () => {
        if (revokeAt === "token_refresh") active = false;
        return { accessToken: "test-token-not-a-real-credential", chatgptAccountId: null };
      },
    } as ReturnType<typeof db.buildCodexTokenResolver>);
    const nativeAuthorization = spyOn(db, "withCodexAppsRequestAuthorization").mockImplementation(
      async (_database, _scope, use) => {
        if (revokeAt === "native_authorization") active = false;
        return await use();
      },
    );
    const prepare = spyOn(runtime, "prepareWorkspaceToolGatewayTools").mockImplementation(
      async (_settings, _refs, options) => {
        auth = options!.codexAppsAuth!;
        return {
          toolGateway: {},
          toolGatewayCatalog: { entries: [] },
          close: async () => {},
        } as Awaited<ReturnType<typeof runtime.prepareWorkspaceToolGatewayTools>>;
      },
    );
    for (const mock of [
      profiles,
      native,
      catalog,
      enabled,
      connections,
      credential,
      tokens,
      nativeAuthorization,
      prepare,
    ])
      restores.push(() => mock.mockRestore());
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
  });

  async function invoke(): Promise<Response> {
    const app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    app.get("/", async (context) => {
      const authorization = await core.requireAccessGrantAuthorization(
        context,
        deps,
        workspaceId,
        "workspace:read",
      );
      const prepared = await prepareWorkspaceToolGateway(deps, authorization, context);
      try {
        await auth.withAuthorization(async () => {
          providerCalls++;
        });
        return context.text("ok");
      } finally {
        await prepared.close();
      }
    });
    const request = new Request("https://api.example.test/");
    core.stampDelegatedHumanAuthorization(request, {
      organizationId,
      subjectId,
      permissions: ["workspace:read"],
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
    });
    return await app.fetch(request);
  }

  test("unchanged live authority reaches the provider after fresh reauthorization", async () => {
    expect((await invoke()).status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(nativeReads).toBeGreaterThanOrEqual(5);
  });

  for (const boundary of ["token_refresh", "native_authorization"] as const)
    test(`membership revoked during ${boundary} never reaches the provider`, async () => {
      revokeAt = boundary;
      expect((await invoke()).status).toBe(403);
      expect(active).toBe(false);
      expect(providerCalls).toBe(0);
      expect(nativeReads).toBeGreaterThanOrEqual(5);
    });
});
