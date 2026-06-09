import { describe, expect, test } from "bun:test";
import { ScheduleNotFoundError, ScheduleOverlapPolicy } from "@temporalio/client";
import { HTTPException } from "hono/http-exception";
import {
  allowedCorsOrigin,
  httpStatusForError,
  normalizeResources,
  replaySessionEvents,
  routeLabel,
  validateGitHubRepositorySelection,
  withDefaultEnabledCapabilityMcpTools,
  workflowIdForSession,
} from "../src/app";
import { discoverMcpRegistryCapabilities, validateMcpCapabilityConnection } from "../src/domain/capabilities";
import { shouldCreateScheduleAfterUpdateError, temporalOverlapPolicy, temporalScheduleSpec } from "../src/index";
import type { CapabilityCatalogItem, SessionEvent } from "@opengeni/contracts";

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
      { kind: "mcp", id: "cap-4fetch" },
    ]);
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
    expect(() => validateGitHubRepositorySelection([
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
    expect(() => validateGitHubRepositorySelection([
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
    expect(routeLabel("/v1/sessions/session-1/events/stream")).toBe("/v1/sessions/:id/events/stream");
    expect(routeLabel("/v1/sessions/session-1/turns/turn-1")).toBe("/v1/sessions/:id/turns/:turnId");
    expect(routeLabel("/v1/files/uploads/upload-1/complete")).toBe("/v1/files/uploads/:id/complete");
    expect(routeLabel("/v1/document-bases/base-1/documents")).toBe("/v1/document-bases/:id/documents");
    expect(routeLabel("/v1/documents/document-1/reindex")).toBe("/v1/documents/:id/reindex");
    expect(routeLabel("/v1/knowledge/search")).toBe("/v1/knowledge/search");
    expect(routeLabel("/v1/knowledge/memories/memory-1")).toBe("/v1/knowledge/memories/:id");
    expect(routeLabel("/v1/scheduled-tasks/task-1/runs")).toBe("/v1/scheduled-tasks/:id/runs");
    expect(routeLabel("/v1/capabilities")).toBe("/v1/capabilities");
    expect(routeLabel("/v1/capabilities/discovery/mcp-registry")).toBe("/v1/capabilities/discovery/mcp-registry");
    expect(routeLabel("/v1/capabilities/mcp%3Aexample/enable")).toBe("/v1/capabilities/:id/enable");
    expect(routeLabel("/v1/capabilities/mcp%3Aexample/disable")).toBe("/v1/capabilities/:id/disable");
    expect(routeLabel("/v1/packs/marketing-social-daily-analysis/enable")).toBe("/v1/packs/:id/enable");
    expect(routeLabel("/v1/packs/marketing-social-daily-analysis/scheduled-tasks")).toBe("/v1/packs/:id/scheduled-tasks");
    expect(routeLabel("/v1/social/connections")).toBe("/v1/social/connections");
    expect(routeLabel("/v1/social/posts")).toBe("/v1/social/posts");
    expect(routeLabel("/v1/unregistered/resource-1")).toBe("/v1/unknown");
  });

  test("preserves HTTPException status codes in error metrics", () => {
    expect(httpStatusForError(new HTTPException(401))).toBe(401);
    expect(httpStatusForError(new Error("boom"))).toBe(500);
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
        available: false,
        notes: "This MCP declares required remote headers. Capability credential injection is not implemented yet.",
      },
      metadata: {
        requiredHeaders: ["Authorization"],
      },
    });
    expect(item?.tools).toEqual([]);
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
