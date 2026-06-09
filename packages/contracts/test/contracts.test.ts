import { describe, expect, test } from "bun:test";
import {
  AddDocumentRequest,
  CapabilityCatalogResponse,
  ClientConfig,
  ClientSessionEvent,
  CreateCapabilityCatalogItemRequest,
  CreateKnowledgeMemoryRequest,
  CreateSocialConnectionRequest,
  CreateSocialPostRequest,
  CreateDocumentBaseRequest,
  CreateScheduledTaskRequest,
  CreateSessionRequest,
  DocumentSearchRequest,
  EnablePackRequest,
  KnowledgeMemorySearchRequest,
  MarketingDailyAnalysisTaskRequest,
  ResourceRef,
  SessionBusMessage,
  UpdateKnowledgeMemoryRequest,
} from "../src";

describe("contracts", () => {
  test("accepts create session defaults", () => {
    const payload = CreateSessionRequest.parse({ initialMessage: "inspect repo" });
    expect(payload.resources).toEqual([]);
    expect(payload.tools).toEqual([]);
    expect(payload.metadata).toEqual({});
  });

  test("accepts MCP tool refs on create session", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      tools: [{ kind: "mcp", id: "docs" }],
    });
    expect(payload.tools).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("accepts repository and file resources on create session", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect resources",
      resources: [
        { kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" },
        { kind: "file", fileId },
      ],
    });
    expect(payload.resources).toEqual([
      { kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" },
      { kind: "file", fileId },
    ]);
  });

  test("rejects old metadata-based resources", () => {
    expect(() => ResourceRef.parse({
      kind: "repository",
      uri: "https://github.com/acme/app.git",
      metadata: { ref: "main" },
    })).toThrow();
  });

  test("rejects invalid tool refs", () => {
    expect(() => CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      tools: [{ kind: "document", id: "docs" }],
    })).toThrow();
  });

  test("accepts model and reasoning effort on create session", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    expect(payload.model).toBe("gpt-5.5");
    expect(payload.reasoningEffort).toBe("xhigh");
  });

  test("accepts client config payloads", () => {
    const payload = ClientConfig.parse({
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5"],
      defaultReasoningEffort: "high",
      allowedReasoningEfforts: ["low", "medium", "high"],
      mcpServers: [{ id: "opengeni", name: "OpenGeni" }],
      fileUploads: { enabled: true, maxSizeBytes: 5_000_000_000 },
      auth: { required: true, headerName: "authorization", scheme: "bearer" },
    });
    expect(payload.defaultReasoningEffort).toBe("high");
    expect(payload.fileUploads.enabled).toBe(true);
    expect(payload.auth.required).toBe(true);
    expect(payload.mcpServers[0]?.id).toBe("opengeni");
  });

  test("accepts structured scheduled task definitions", () => {
    const payload = CreateScheduledTaskRequest.parse({
      name: "Daily check",
      schedule: { type: "calendar", timeZone: "Europe/Oslo", hour: 9, minute: 30 },
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Check repository health",
        resources: [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
        tools: [{ kind: "mcp", id: "opengeni" }],
      },
    });
    expect(payload.schedule.type).toBe("calendar");
    expect(payload.agentConfig.tools[0]?.id).toBe("opengeni");
  });

  test("accepts pack enable and marketing daily analysis defaults", () => {
    expect(EnablePackRequest.parse({})).toEqual({ metadata: {} });
    const payload = MarketingDailyAnalysisTaskRequest.parse({
      connectionIds: ["00000000-0000-4000-8000-000000000020"],
      timeZone: "Europe/Oslo",
    });
    expect(payload.hour).toBe(9);
    expect(payload.minute).toBe(0);
    expect(payload.runMode).toBe("new_session_per_run");
    expect(payload.overlapPolicy).toBe("skip");
  });

  test("accepts social connector and post payloads", () => {
    const connection = CreateSocialConnectionRequest.parse({
      provider: "linkedin",
      accountHandle: "example-company",
      credentialRef: "secret://marketing/linkedin/example-company",
    });
    expect(connection.status).toBe("connected");
    expect(connection.scopes).toEqual([]);

    const post = CreateSocialPostRequest.parse({
      connectionId: "00000000-0000-4000-8000-000000000020",
      text: "Launch post",
      publishedAt: "2026-06-06T09:00:00Z",
      metrics: { impressions: 1200, likes: 42 },
    });
    expect(post.metrics.likes).toBe(42);
  });

  test("accepts capability catalog entries and enable defaults", () => {
    const create = CreateCapabilityCatalogItemRequest.parse({
      kind: "mcp",
      source: "public_registry",
      name: "Example MCP",
      endpointUrl: "https://example.com/mcp",
    });
    expect(create.category).toBe("custom");
    expect(create.tags).toEqual([]);

    const catalog = CapabilityCatalogResponse.parse({
      items: [{
        id: "mcp:example",
        kind: "mcp",
        source: "public_registry",
        name: "Example MCP",
        endpointUrl: "https://example.com/mcp",
        runtime: { available: true, mcpServerId: "example", transport: "streamable-http" },
      }],
      installations: [],
    });
    expect(catalog.items[0]?.runtime.mcpServerId).toBe("example");
    expect(catalog.items[0]?.enabled).toBe(false);
  });

  test("rejects empty user message command", () => {
    expect(() => ClientSessionEvent.parse({
      type: "user.message",
      payload: { text: "" },
    })).toThrow();
  });

  test("accepts per-turn resources, tools, and model settings on user messages", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const payload = ClientSessionEvent.parse({
      type: "user.message",
      payload: {
        text: "use this too",
        resources: [{ kind: "file", fileId }],
        tools: [{ kind: "mcp", id: "docs" }],
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
      },
    });
    expect(payload.type).toBe("user.message");
    if (payload.type !== "user.message") throw new Error("expected user.message");
    expect(payload.payload.resources).toEqual([{ kind: "file", fileId }]);
    expect(payload.payload.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    expect(payload.payload.model).toBe("gpt-5.5");
    expect(payload.payload.reasoningEffort).toBe("xhigh");
  });

  test("keeps text-only user messages compatible", () => {
    const payload = ClientSessionEvent.parse({
      type: "user.message",
      payload: { text: "hello" },
    });
    expect(payload.type).toBe("user.message");
    if (payload.type !== "user.message") throw new Error("expected user.message");
    expect(payload.payload.resources).toEqual([]);
    expect(payload.payload.tools).toEqual([]);
  });

  test("accepts full realtime bus messages", () => {
    const message = SessionBusMessage.parse({
      sessionId: "00000000-0000-4000-8000-000000000001",
      events: [{
        id: "00000000-0000-4000-8000-000000000002",
        sessionId: "00000000-0000-4000-8000-000000000001",
        sequence: 1,
        type: "agent.message.delta",
        payload: { text: "hi" },
        occurredAt: new Date().toISOString(),
      }],
    });
    expect(message.events[0]?.type).toBe("agent.message.delta");
  });

  test("accepts document service request contracts", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    expect(CreateDocumentBaseRequest.parse({ name: "Runbooks", description: "Ops docs" })).toEqual({
      name: "Runbooks",
      description: "Ops docs",
    });
    expect(AddDocumentRequest.parse({ fileId })).toEqual({ fileId });
    expect(DocumentSearchRequest.parse({ query: "network policy", limit: 20 })).toEqual({
      query: "network policy",
      limit: 20,
    });
    expect(DocumentSearchRequest.parse({ query: "ADR-42", mode: "hybrid", sourceKinds: ["repository"] })).toEqual({
      query: "ADR-42",
      mode: "hybrid",
      sourceKinds: ["repository"],
      limit: 5,
    });
  });

  test("accepts knowledge memory contracts", () => {
    expect(CreateKnowledgeMemoryRequest.parse({
      text: "Prefer Azure Blob for production object storage.",
      kind: "decision",
      confidence: 0.9,
    })).toEqual({
      text: "Prefer Azure Blob for production object storage.",
      status: "proposed",
      kind: "decision",
      scope: "workspace",
      sourceRefs: [],
      confidence: 0.9,
      metadata: {},
    });
    expect(UpdateKnowledgeMemoryRequest.parse({ status: "approved", reviewedBy: "operator" })).toEqual({
      status: "approved",
      reviewedBy: "operator",
    });
    expect(KnowledgeMemorySearchRequest.parse({ status: "approved" })).toEqual({
      status: "approved",
      limit: 20,
    });
  });

  test("rejects invalid document service requests", () => {
    expect(() => CreateDocumentBaseRequest.parse({ name: "" })).toThrow();
    expect(() => AddDocumentRequest.parse({ fileId: "not-a-uuid" })).toThrow();
    expect(() => DocumentSearchRequest.parse({ query: "" })).toThrow();
    expect(() => CreateKnowledgeMemoryRequest.parse({ text: "", confidence: 1.1 })).toThrow();
  });
});
