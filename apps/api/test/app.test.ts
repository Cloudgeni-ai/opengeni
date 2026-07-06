import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ScheduleNotFoundError, ScheduleOverlapPolicy } from "@temporalio/client";
import { HTTPException } from "hono/http-exception";
import {
  allowedCorsOrigin,
  createApp,
  httpStatusForError,
  normalizeResources,
  replaySessionEvents,
  routeLabel,
  validateGitHubRepositorySelectionShape,
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
  workflowIdForSession,
} from "../src/app";
import type { AppDependencies } from "../src/app";
import { shouldCreateScheduleAfterUpdateError, temporalOverlapPolicy, temporalScheduleSpec } from "../src/index";
import { stripeCheckoutSessionCreateParams, stripeCustomerProvider } from "../src/routes/billing";
import { applyCapabilityEnablement, discoverMcpRegistryCapabilities, settingsWithMcpCapabilityServers, validateMcpCapabilityConnection } from "@opengeni/core";
import { configuredAllowedModels, type Settings } from "@opengeni/config";
import { encryptEnvironmentValue } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { ClientConfig, type CapabilityCatalogItem, type CapabilityInstallation, type SessionEvent } from "@opengeni/contracts";

describe("API helpers", () => {
  test("normalizes repository resources into sandbox mount paths", () => {
    const [resource] = normalizeResources([{
      kind: "repository",
      uri: "https://github.com/OpenAI/example.git",
      ref: "main",
      subpath: "/infra/",
    }]);

    expect(resource).toEqual({
      kind: "repository",
      uri: "https://github.com/OpenAI/example.git",
      ref: "main",
      subpath: "infra",
      mountPath: "repos/OpenAI/example",
    });
  });

  test("normalizes file resources into sandbox mount paths", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    expect(normalizeResources([{ kind: "file", fileId }])).toEqual([{
      kind: "file",
      fileId,
      mountPath: `files/${fileId}`,
    }]);
  });

  test("uses stable workflow ids for sessions", () => {
    expect(workflowIdForSession("abc")).toBe("session-abc");
  });

  test("adds enabled capability MCPs to default session tools", () => {
    expect(withDefaultEnabledCapabilityMcpTools(
      [{ kind: "mcp", id: "opengeni" }],
      { mcpServers: [{ id: "opengeni", url: "https://example.com/mcp", cacheToolsList: false }] },
      {
        mcpServers: [
          { id: "opengeni", url: "https://example.com/mcp", cacheToolsList: false },
          { id: "cap-4fetch", url: "https://example.com/4fetch", cacheToolsList: false },
          { id: "cap-4fetch", url: "https://example.com/4fetch", cacheToolsList: false },
        ],
      },
    )).toEqual([
      { kind: "mcp", id: "opengeni" },
      // AUTO-ATTACHED capability MCPs carry optional:true so a broken/expired
      // credential is non-fatal (skipped, turn proceeds) instead of failing the
      // whole turn before the model runs.
      { kind: "mcp", id: "cap-4fetch", optional: true },
    ]);
  });

  test("validateToolRefs applies MCP optional tri-state semantics", () => {
    const runtimeSettings = {
      mcpServers: [
        { id: "opengeni", url: "https://example.com/mcp", cacheToolsList: false },
        { id: "cap-notebook", url: "https://example.com/notebook", cacheToolsList: false },
      ],
    };

    expect(validateToolRefs([{ kind: "mcp", id: "cap-notebook" }], runtimeSettings as never))
      .toEqual([{ kind: "mcp", id: "cap-notebook" }]);
    expect(validateToolRefs([{ kind: "mcp", id: "cap-notebook", optional: true }], runtimeSettings as never))
      .toEqual([{ kind: "mcp", id: "cap-notebook", optional: true }]);
    expect(() => validateToolRefs([{ kind: "mcp", id: "missing" }], runtimeSettings as never))
      .toThrow("unknown MCP server id: missing");
    expect(validateToolRefs([{ kind: "mcp", id: "missing", optional: true }], runtimeSettings as never))
      .toEqual([]);
    expect(validateToolRefs([
      { kind: "mcp", id: "cap-notebook", optional: true },
      { kind: "mcp", id: "cap-notebook" },
    ], runtimeSettings as never)).toEqual([{ kind: "mcp", id: "cap-notebook" }]);
  });

  test("maps scheduled task schedules into Temporal specs", () => {
    expect(temporalScheduleSpec({ type: "interval", everySeconds: 90, startAt: "2026-05-08T10:00:00.000Z", endAt: "2026-05-08T11:00:00.000Z" })).toEqual({
      intervals: [{ every: "90s" }],
      startAt: new Date("2026-05-08T10:00:00.000Z"),
      endAt: new Date("2026-05-08T11:00:00.000Z"),
    });
    expect(temporalScheduleSpec({ type: "calendar", timeZone: "Europe/Oslo", hour: 9, minute: 30, daysOfWeek: ["MONDAY"] })).toEqual({
      calendars: [{ hour: 9, minute: 30, second: 0, dayOfWeek: ["MONDAY"] }],
      timezone: "Europe/Oslo",
    });
    expect(temporalScheduleSpec({ type: "once", runAt: "2026-05-08T12:34:56.000+02:00", timeZone: "Europe/Oslo" })).toEqual({
      calendars: [{ year: 2026, month: "MAY", dayOfMonth: 8, hour: 10, minute: 34, second: 56 }],
      timezone: "UTC",
    });
  });

  test("maps scheduled task overlap policies into Temporal policies", () => {
    expect(temporalOverlapPolicy("allow_concurrent")).toBe(ScheduleOverlapPolicy.ALLOW_ALL);
    expect(temporalOverlapPolicy("skip")).toBe(ScheduleOverlapPolicy.SKIP);
    expect(temporalOverlapPolicy("buffer_one")).toBe(ScheduleOverlapPolicy.BUFFER_ONE);
  });

  test("only creates a schedule after update when Temporal reports not found", () => {
    expect(shouldCreateScheduleAfterUpdateError(new ScheduleNotFoundError("missing", "schedule-1"))).toBe(true);
    expect(shouldCreateScheduleAfterUpdateError(new Error("network unavailable"))).toBe(false);
  });

  test("rejects selected GitHub App repos from multiple installations", () => {
    expect(() => validateGitHubRepositorySelectionShape([
      {
        kind: "repository",
        uri: "https://github.com/a/one.git",
        ref: "main",
        githubInstallationId: 1,
        githubRepositoryId: 11,
      },
      {
        kind: "repository",
        uri: "https://github.com/b/two.git",
        ref: "main",
        githubInstallationId: 2,
        githubRepositoryId: 22,
      },
    ])).toThrow("one installation");
  });

  test("rejects incomplete GitHub App repository metadata", () => {
    expect(() => validateGitHubRepositorySelectionShape([
      {
        kind: "repository",
        uri: "https://github.com/a/one.git",
        ref: "main",
        githubInstallationId: 1,
      },
    ])).toThrow("positive github_installation_id");
  });

  test("matches CORS origins against the full origin string", () => {
    const pattern = String.raw`https?://(localhost|127\.0\.0\.1)(:\d+)?`;

    expect(allowedCorsOrigin(pattern, "http://localhost:3000")).toBe(true);
    expect(allowedCorsOrigin(pattern, "http://127.0.0.1:3000")).toBe(true);
    expect(allowedCorsOrigin(pattern, "http://localhost.evil.com")).toBe(false);
    expect(allowedCorsOrigin(pattern, "https://evil.com/http://localhost:3000")).toBe(false);
  });

  test("normalizes dynamic route labels for metrics", () => {
    const workspace = "00000000-0000-4000-8000-000000000001";
    expect(routeLabel(`/v1/workspaces/${workspace}/sessions/session-1/events/stream`)).toBe("/v1/workspaces/:workspaceId/sessions/:id/events/stream");
    expect(routeLabel(`/v1/workspaces/${workspace}/sessions/session-1/turns/turn-1`)).toBe("/v1/workspaces/:workspaceId/sessions/:id/turns/:turnId");
    expect(routeLabel(`/v1/workspaces/${workspace}/files/uploads/upload-1/complete`)).toBe("/v1/workspaces/:workspaceId/files/uploads/:id/complete");
    expect(routeLabel(`/v1/workspaces/${workspace}/document-bases/base-1/documents`)).toBe("/v1/workspaces/:workspaceId/document-bases/:id/documents");
    expect(routeLabel(`/v1/workspaces/${workspace}/document-bases/base-1/documents/document-1`)).toBe("/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId");
    expect(routeLabel(`/v1/workspaces/${workspace}/document-bases/base-1/documents/document-1/reindex`)).toBe("/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId/reindex");
    expect(routeLabel(`/v1/workspaces/${workspace}/knowledge/search`)).toBe("/v1/workspaces/:workspaceId/knowledge/search");
    expect(routeLabel(`/v1/workspaces/${workspace}/knowledge/memories/memory-1`)).toBe("/v1/workspaces/:workspaceId/knowledge/memories/:id");
    expect(routeLabel(`/v1/workspaces/${workspace}/scheduled-tasks/task-1/runs`)).toBe("/v1/workspaces/:workspaceId/scheduled-tasks/:id/runs");
    expect(routeLabel(`/v1/workspaces/${workspace}/capabilities`)).toBe("/v1/workspaces/:workspaceId/capabilities");
    expect(routeLabel(`/v1/workspaces/${workspace}/capabilities/discovery/mcp-registry`)).toBe("/v1/workspaces/:workspaceId/capabilities/discovery/mcp-registry");
    expect(routeLabel(`/v1/workspaces/${workspace}/capabilities/mcp%3Aexample/enable`)).toBe("/v1/workspaces/:workspaceId/capabilities/:id/enable");
    expect(routeLabel(`/v1/workspaces/${workspace}/capabilities/mcp%3Aexample/disable`)).toBe("/v1/workspaces/:workspaceId/capabilities/:id/disable");
    expect(routeLabel(`/v1/workspaces/${workspace}/packs/marketing-social-daily-analysis/enable`)).toBe("/v1/workspaces/:workspaceId/packs/:id/enable");
    expect(routeLabel(`/v1/workspaces/${workspace}/packs/marketing-social-daily-analysis/scheduled-tasks`)).toBe("/v1/workspaces/:workspaceId/packs/marketing-social-daily-analysis/scheduled-tasks");
    expect(routeLabel(`/v1/workspaces/${workspace}/social/connections`)).toBe("/v1/workspaces/:workspaceId/social/connections");
    expect(routeLabel(`/v1/workspaces/${workspace}/social/posts`)).toBe("/v1/workspaces/:workspaceId/social/posts");
    expect(routeLabel(legacyRoute("sessions", "session-1", "events", "stream"))).toBe("/v1/unknown");
    expect(routeLabel("/v1/unregistered/resource-1")).toBe("/v1/unknown");
    expect(routeLabel("/readyz")).toBe("/readyz");
  });

  test("preserves HTTPException status codes in error metrics", () => {
    expect(httpStatusForError(new HTTPException(401))).toBe(401);
    expect(httpStatusForError(new Error("boom"))).toBe(500);
  });

  test("readyz reports a failing dependency", async () => {
    const app = createApp({
      settings: testSettings(),
      db: {} as never,
      bus: { isConnected: () => true } as never,
      workflowClient: {} as never,
      managedAuth: null,
      readinessChecks: {
        db: async () => {},
        nats: () => {
          throw new Error("nats down");
        },
        temporal: async () => {},
      },
    });

    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    const body = await response.json() as { ok: boolean; checks: { nats: { ok: boolean; error?: string } } };
    expect(body.ok).toBe(false);
    expect(body.checks.nats.ok).toBe(false);
    expect(body.checks.nats.error).toContain("nats down");
  });

  test("builds Stripe Checkout sessions that can collect tax addresses for existing customers", () => {
    const params = stripeCheckoutSessionCreateParams({
      accountId: "00000000-0000-4000-8000-000000000001",
      customerId: "cus_test",
      amountCents: 2550,
      amountMicros: 25_500_000,
      creditsProductId: "prod_opengeni_credits",
      publicBaseUrl: "https://app.opengeni.ai",
      idempotencyKey: "checkout:test",
    });

    expect(params.mode).toBe("payment");
    expect(params.customer).toBe("cus_test");
    expect(params.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(2550);
    expect(params.line_items?.[0]?.price_data?.product).toBe("prod_opengeni_credits");
    expect(params.metadata?.opengeni_credit_amount_usd).toBe("25.50");
    expect(params.metadata?.opengeni_credit_idempotency_key).toBe("checkout:test");
    expect(params.payment_intent_data?.metadata?.opengeni_account_id).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("restricts Stripe Checkout return URLs to the public OpenGeni origin", () => {
    const params = stripeCheckoutSessionCreateParams({
      accountId: "00000000-0000-4000-8000-000000000001",
      customerId: "cus_test",
      amountCents: 2500,
      amountMicros: 25_000_000,
      publicBaseUrl: "https://app.opengeni.ai",
      successUrl: "https://app.opengeni.ai/billing?checkout=success&source=test",
      cancelUrl: "https://app.opengeni.ai/billing?checkout=cancelled&source=test",
      idempotencyKey: "checkout:test-return-url",
    });

    expect(params.success_url).toBe("https://app.opengeni.ai/billing?checkout=success&source=test");
    expect(params.cancel_url).toBe("https://app.opengeni.ai/billing?checkout=cancelled&source=test");
    expect(() => stripeCheckoutSessionCreateParams({
      accountId: "00000000-0000-4000-8000-000000000001",
      customerId: "cus_test",
      amountCents: 2500,
      amountMicros: 25_000_000,
      publicBaseUrl: "https://app.opengeni.ai",
      successUrl: "https://evil.example/checkout",
      idempotencyKey: "checkout:test-open-redirect",
    })).toThrow("successUrl must use the OpenGeni public origin");
  });

  test("namespaces Stripe customer mirrors by live and test mode", () => {
    expect(stripeCustomerProvider({ livemode: true } as never)).toBe("stripe:live");
    expect(stripeCustomerProvider({ livemode: false } as never)).toBe("stripe:test");
    expect(stripeCustomerProvider({ settings: { stripeSecretKey: "rk_live_example" } } as never)).toBe("stripe:live");
    expect(stripeCustomerProvider({ settings: { stripeSecretKey: "sk_test_example" } } as never)).toBe("stripe:test");
  });

  test("discovers public MCP registry servers with bounded latest-version search", async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: URL) => {
      requests.push(url.toString());
      return new Response(JSON.stringify({
        servers: [{
          server: {
            name: "io.github.example/github-mcp",
            title: "GitHub MCP",
            description: "GitHub repository automation",
            version: "1.2.3",
            remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
            repository: { url: "https://github.com/example/github-mcp" },
          },
          _meta: {
            "io.modelcontextprotocol.registry/official": {
              status: "active",
              isLatest: true,
              updatedAt: "2026-06-07T00:00:00.000Z",
            },
          },
        }],
        metadata: { count: 1 },
      }), { status: 200 });
    };

    const items = await discoverMcpRegistryCapabilities({ query: "github", limit: 5, fetchImpl });
    const requestedUrl = new URL(requests[0]!);

    expect(requests).toHaveLength(1);
    expect(requestedUrl.pathname).toBe("/v0.1/servers");
    expect(requestedUrl.searchParams.get("search")).toBe("github");
    expect(requestedUrl.searchParams.get("version")).toBe("latest");
    expect(requestedUrl.searchParams.get("limit")).toBe("5");
    expect(items[0]).toMatchObject({
      kind: "mcp",
      source: "public_registry",
      name: "GitHub MCP",
      endpointUrl: "https://example.com/mcp",
      runtime: {
        available: true,
        transport: "streamable-http",
      },
    });
  });

  test("marks registry MCPs with required headers as credential-gated", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: "ai.example/secure-mcp",
          title: "Secure MCP",
          description: "Requires a bearer token",
          version: "1.0.0",
          remotes: [{
            type: "streamable-http",
            url: "https://secure.example/mcp",
            headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
          }],
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 });

    const [item] = await discoverMcpRegistryCapabilities({ query: "secure", limit: 5, fetchImpl });

    expect(item).toMatchObject({
      name: "Secure MCP",
      authModel: "credential_ref",
      runtime: {
        available: true,
        transport: "streamable-http",
        notes: 'This MCP requires credential header(s) Authorization supplied in the enable request.',
      },
      metadata: {
        requiredHeaders: ["Authorization"],
      },
    });
    expect(item?.tags).toContain("requires-credentials");
    expect(item?.tools).toHaveLength(1);
  });

  test("records MCP connectivity metadata after a successful enable probe", async () => {
    const metadata = await validateMcpCapabilityConnection(capabilityItem({
      id: "mcp:test",
      kind: "mcp",
      name: "Test MCP",
      endpointUrl: "https://example.com/mcp",
      runtime: { available: true, mcpServerId: "cap-test", transport: "streamable-http", notes: null },
    }), async (input) => {
      expect(input).toMatchObject({
        id: "cap-test",
        name: "Test MCP",
        url: "https://example.com/mcp",
        timeoutMs: 15000,
      });
      return { toolCount: 3 };
    });

    expect(metadata.mcpConnectivity).toMatchObject({
      status: "ok",
      toolCount: 3,
    });
  });

  test("passes credential headers to the MCP enable probe", async () => {
    const metadata = await validateMcpCapabilityConnection(capabilityItem({
      id: "mcp:secure",
      kind: "mcp",
      name: "Secure MCP",
      endpointUrl: "https://secure.example/mcp",
      runtime: { available: true, mcpServerId: "cap-secure", transport: "streamable-http", notes: null },
    }), async (input) => {
      expect(input.headers).toEqual({ Authorization: "Bearer probe-token" });
      return { toolCount: 1 };
    }, { Authorization: "Bearer probe-token" });

    expect(metadata.mcpConnectivity).toMatchObject({ status: "ok", toolCount: 1 });
  });

  test("merges enabled capability MCPs with decrypted credential headers into runtime settings", () => {
    const key = randomBytes(32);
    const settings = testSettings({ environmentsEncryptionKey: Buffer.from(key).toString("base64") });
    const merged = settingsWithMcpCapabilityServers(settings, [{
      capabilityId: "mcp:secure",
      id: "cap-secure",
      name: "Secure MCP",
      url: "https://secure.example/mcp",
      headersEncrypted: { Authorization: encryptEnvironmentValue(key, "Bearer runtime-token") },
    }]);

    const server = merged.mcpServers.find((candidate) => candidate.id === "cap-secure");
    expect(server?.headers).toEqual({ Authorization: "Bearer runtime-token" });
  });

  test("merges enabled capability MCPs with connection refs into runtime settings", () => {
    const connectionRef = {
      providerDomain: "api.example.com",
      kind: "api_key" as const,
      scopes: ["read"],
      subjectScope: "workspace" as const,
    };
    const merged = settingsWithMcpCapabilityServers(testSettings(), [{
      capabilityId: "mcp:brokered",
      id: "cap-brokered",
      name: "Brokered MCP",
      url: "https://brokered.example/mcp",
      connectionRef,
    }]);

    const server = merged.mcpServers.find((candidate) => candidate.id === "cap-brokered");
    expect(server?.connectionRef).toEqual(connectionRef);
    expect(server?.headers).toBeUndefined();
  });

  test("omits credential-header capability MCPs when their headers cannot be decrypted", () => {
    const key = randomBytes(32);
    const otherKey = randomBytes(32);
    const withoutKey = settingsWithMcpCapabilityServers(testSettings(), [{
      capabilityId: "mcp:secure",
      id: "cap-secure",
      name: "Secure MCP",
      url: "https://secure.example/mcp",
      headersEncrypted: { Authorization: encryptEnvironmentValue(key, "Bearer runtime-token") },
    }]);
    expect(withoutKey.mcpServers.find((candidate) => candidate.id === "cap-secure")).toBeUndefined();

    const wrongKey = settingsWithMcpCapabilityServers(
      testSettings({ environmentsEncryptionKey: Buffer.from(otherKey).toString("base64") }),
      [{
        capabilityId: "mcp:secure",
        id: "cap-secure",
        name: "Secure MCP",
        url: "https://secure.example/mcp",
        headersEncrypted: { Authorization: encryptEnvironmentValue(key, "Bearer runtime-token") },
      }],
    );
    expect(wrongKey.mcpServers.find((candidate) => candidate.id === "cap-secure")).toBeUndefined();

    const headerless = settingsWithMcpCapabilityServers(testSettings(), [{
      capabilityId: "mcp:open",
      id: "cap-open",
      name: "Open MCP",
      url: "https://open.example/mcp",
    }]);
    expect(headerless.mcpServers.find((candidate) => candidate.id === "cap-open")).toMatchObject({ url: "https://open.example/mcp" });
  });

  test("rejects MCP enablement when the server cannot initialize", async () => {
    const item = capabilityItem({
      id: "mcp:broken",
      kind: "mcp",
      name: "Broken MCP",
      endpointUrl: "https://broken.example/mcp",
      runtime: { available: true, mcpServerId: "cap-broken", transport: "streamable-http", notes: null },
    });

    await expect(validateMcpCapabilityConnection(item, async () => {
      throw new Error("TLS handshake failure");
    })).rejects.toThrow("could not be enabled");
  });

  test("replays SSE history across all pages", async () => {
    const events = Array.from({ length: 1005 }, (_, index) => ({
      id: `event-${index + 1}`,
      sessionId: "session-1",
      sequence: index + 1,
      type: "agent.message.delta",
      payload: { text: String(index + 1) },
      occurredAt: "2026-05-07T00:00:00.000Z",
    } satisfies SessionEvent));
    const sent: number[] = [];
    const pageRequests: Array<{ after: number; limit: number }> = [];

    await replaySessionEvents(
      async (after, limit) => {
        pageRequests.push({ after, limit });
        return events.filter((event) => event.sequence > after).slice(0, limit);
      },
      async (event) => {
        sent.push(event.sequence);
      },
      0,
      1000,
    );

    expect(sent).toHaveLength(1005);
    expect(sent[0]).toBe(1);
    expect(sent.at(-1)).toBe(1005);
    expect(pageRequests).toEqual([
      { after: 0, limit: 1000 },
      { after: 1000, limit: 1000 },
    ]);
  });
});

describe("catalog connectionRef exposure", () => {
  function installation(config: Record<string, unknown>): CapabilityInstallation {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      accountId: "00000000-0000-0000-0000-0000000000a1",
      workspaceId: "00000000-0000-0000-0000-0000000000b1",
      capabilityId: "mcp:secure",
      kind: "mcp",
      status: "active",
      config,
      metadata: { mcpConnectivity: { status: "ok", toolCount: 1 } },
      enabledAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
  }

  const secureMcp = () => capabilityItem({
    id: "mcp:secure",
    kind: "mcp",
    name: "Secure MCP",
    source: "public_registry",
    endpointUrl: "https://secure.example/mcp",
    runtime: { available: true, mcpServerId: "cap-secure", transport: "streamable-http", notes: null },
  });

  test("an item enabled through a connection lists its connectionRef back", () => {
    const ref = { connectionId: "conn-42", providerDomain: "secure.example", kind: "api_key" };
    const listed = applyCapabilityEnablement(secureMcp(), installation({ connectionRef: ref }), new Set());
    expect(listed.enabled).toBe(true);
    expect(listed.connectionRef).toEqual(ref);
  });

  test("an item enabled with credential headers (no connection) lists connectionRef null", () => {
    const listed = applyCapabilityEnablement(secureMcp(), installation({ headerNames: ["authorization"] }), new Set());
    expect(listed.enabled).toBe(true);
    expect(listed.connectionRef).toBeNull();
  });
});

describe("GET /v1/config/client", () => {
  // The route only reads settings (+ the storage derived from them); db / bus /
  // workflowClient are never touched, so we stub them. managedAuth is forced to
  // null so createApp does not try to stand up Better Auth.
  function appFor(settings: Settings) {
    const deps = {
      settings,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    } satisfies AppDependencies;
    return createApp(deps);
  }

  async function fetchClientConfig(settings: Settings) {
    const response = await appFor(settings).request("/v1/config/client");
    expect(response.status).toBe(200);
    return ClientConfig.parse(await response.json());
  }

  test("returns a models[] whose ids match configuredAllowedModels", async () => {
    const settings = testSettings();
    const config = await fetchClientConfig(settings);

    expect(config.models.length).toBeGreaterThan(0);
    expect(config.models.map((model) => model.id)).toEqual(configuredAllowedModels(settings));
    // Built-in provider models project the openai/azure responses shape.
    const defaultModel = config.models.find((model) => model.id === settings.openaiModel);
    expect(defaultModel).toMatchObject({ provider: "openai", api: "responses" });
  });

  test("includes a registry model when OPENGENI_MODEL_PROVIDERS_JSON is set", async () => {
    const settings = testSettings({
      modelProvidersJson: JSON.stringify([{
        id: "fireworks",
        label: "Fireworks AI",
        api: "chat",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "fw_test",
        models: [{
          id: "accounts/fireworks/models/glm-5p2",
          label: "GLM 5.2",
          contextWindowTokens: 1_048_576,
          reasoningEffort: true,
          hostedWebSearch: false,
        }],
      }]),
    });
    const config = await fetchClientConfig(settings);

    expect(config.models.map((model) => model.id)).toEqual(configuredAllowedModels(settings));
    const glm = config.models.find((model) => model.id === "accounts/fireworks/models/glm-5p2");
    expect(glm).toEqual({
      id: "accounts/fireworks/models/glm-5p2",
      label: "GLM 5.2",
      provider: "fireworks",
      providerLabel: "Fireworks AI",
      api: "chat",
      contextWindowTokens: 1_048_576,
    });
  });
});

function legacyRoute(...segments: string[]): string {
  return ["", "v1", ...segments].join("/");
}

function capabilityItem(patch: Partial<CapabilityCatalogItem> & Pick<CapabilityCatalogItem, "id" | "kind" | "name">): CapabilityCatalogItem {
  return {
    source: "manual",
    description: null,
    category: "custom",
    tags: [],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    tools: [],
    runtime: { available: false, notes: null },
    enabled: false,
    enabledReason: null,
    metadata: {},
    ...patch,
  };
}
