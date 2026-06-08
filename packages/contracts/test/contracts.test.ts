import { describe, expect, test } from "bun:test";
import {
  AddDocumentRequest,
  ClientConfig,
  ClientSessionEvent,
  CreateDocumentBaseRequest,
  CreateScheduledTaskRequest,
  CreateSessionRequest,
  DocumentSearchRequest,
  ResourceRef,
  SessionBusMessage,
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
      productAccessMode: "managed",
      auth: { mode: "managedSession", session: "cookie" },
    });
    expect(payload.defaultReasoningEffort).toBe("high");
    expect(payload.fileUploads.enabled).toBe(true);
    expect(payload.auth.mode).toBe("managedSession");
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
      workspaceId: "00000000-0000-4000-8000-000000000100",
      sessionId: "00000000-0000-4000-8000-000000000001",
      events: [{
        id: "00000000-0000-4000-8000-000000000002",
        workspaceId: "00000000-0000-4000-8000-000000000100",
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
  });

  test("rejects invalid document service requests", () => {
    expect(() => CreateDocumentBaseRequest.parse({ name: "" })).toThrow();
    expect(() => AddDocumentRequest.parse({ fileId: "not-a-uuid" })).toThrow();
    expect(() => DocumentSearchRequest.parse({ query: "" })).toThrow();
  });
});
