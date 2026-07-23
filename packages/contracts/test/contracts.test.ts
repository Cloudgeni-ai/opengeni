import { describe, expect, test } from "bun:test";
import {
  AddDocumentRequest,
  assertUniqueResourceMountPaths,
  approvalIdentifier,
  CapabilityCatalogResponse,
  evaluateWorkspaceModelPolicy,
  CapabilityPack,
  ClientConfig,
  ClientModel,
  ClientSessionEvent,
  CreateCapabilityCatalogItemRequest,
  CreateKnowledgeMemoryRequest,
  CreateSocialConnectionRequest,
  CreateSocialPostRequest,
  CreateDocumentBaseRequest,
  CreateCheckoutRequest,
  CreateScheduledTaskRequest,
  CreateSessionRequest,
  DocumentSearchRequest,
  EnablePackRequest,
  GitCredentialBindingId,
  gitCredentialBindingIdForRepository,
  gitCredentialProviderForRepository,
  KnowledgeMemorySearchRequest,
  MarketingDailyAnalysisTaskRequest,
  mergeToolRefs,
  McpServerConnectionRef,
  OAuthStartRequest,
  OPENGENI_API_CONTRACT_REVISION,
  RequestHumanInputToolInput,
  RepositoryResourceRef,
  ResourceRef,
  SessionBusMessage,
  SessionMcpServerMetadata,
  SubmitHumanInputResponseRequest,
  CLEARED_RUN_STATE_BLOB,
  CLEARED_RUN_STATE_MARKER,
  isClearedRunStateBlob,
  ToolAuthNeededPayload,
  CredentialAuthNeededPayload,
  defaultRepositoryMountPath,
  mergeResourceRefs,
  normalizeResourceMountPath,
  resourceMountPathCollisionKey,
} from "../src";

describe("contracts", () => {
  test("models provider-neutral MCP bindings with exact selected repository scope", () => {
    const binding = McpServerConnectionRef.parse({
      connectionId: "host:github:one",
      provider: "github",
      providerDomain: "github.com",
      kind: "app_install",
      selectedResources: [
        { kind: "repository", id: "101" },
        { kind: "repository", id: "202" },
      ],
    });
    expect(binding.selectedResources?.map((resource) => resource.id)).toEqual(["101", "202"]);
    expect(() =>
      McpServerConnectionRef.parse({
        connectionId: "azure-one",
        provider: "azure_devops",
        providerDomain: "dev.azure.com",
        selectedResources: [
          { kind: "repository", id: "repo-guid" },
          { kind: "repository", id: "repo-guid" },
        ],
      }),
    ).toThrow("selectedResources must not contain duplicates");
    expect(() =>
      McpServerConnectionRef.parse({
        providerDomain: "gitlab.example",
        selectedResources: [{ kind: "repository", id: "42" }],
      }),
    ).toThrow("selectedResources requires connectionId");
  });

  test("auth-needed events accept opaque embedded-host connection identities", () => {
    expect(
      ToolAuthNeededPayload.parse({
        serverId: "provider-tools",
        providerDomain: "provider.example",
        connectionId: "host:connection:42",
        provider: "gitlab",
        reason: "unsupported_auth",
        selectedResources: [{ kind: "repository", id: "project-42" }],
      }).connectionId,
    ).toBe("host:connection:42");
    expect(
      CredentialAuthNeededPayload.parse({
        credentialClass: "run",
        providerDomain: "cloud.example",
        connectionId: "host:cloud:7",
        reason: "missing_connection",
      }).connectionId,
    ).toBe("host:cloud:7");
  });

  test("extracts approval identity from every serialized interruption shape", () => {
    expect(approvalIdentifier({ id: "approval-direct" })).toBe("approval-direct");
    expect(approvalIdentifier({ rawItem: { callId: "approval-call" } })).toBe("approval-call");
    expect(approvalIdentifier({ rawItem: { id: 42 } })).toBe("42");
    expect(approvalIdentifier({ name: "approval-name" })).toBe("approval-name");
    expect(approvalIdentifier({ approvalId: "unsupported-shape" })).toBeNull();
    expect(approvalIdentifier(null)).toBeNull();
  });

  test("accepts create session defaults", () => {
    const payload = CreateSessionRequest.parse({ initialMessage: "inspect repo" });
    expect(payload.resources).toEqual([]);
    expect(payload.tools).toEqual([]);
    expect(payload.metadata).toEqual({});
  });

  test("accepts only a UUID as a caller-preallocated session id", () => {
    const requestedSessionId = "00000000-0000-4000-8000-000000000042";
    expect(
      CreateSessionRequest.parse({
        initialMessage: "inspect repo",
        requestedSessionId,
      }).requestedSessionId,
    ).toBe(requestedSessionId);
    expect(() =>
      CreateSessionRequest.parse({
        initialMessage: "inspect repo",
        requestedSessionId: "host-session-42",
      }),
    ).toThrow();
  });

  test("accepts opaque bounded repository credential bindings and access intent", () => {
    expect(
      ResourceRef.parse({
        kind: "repository",
        uri: "https://gitlab.example/acme/repo.git",
        ref: "main",
        provider: "gitlab",
        credentialBindingId: "host/opaque binding:1",
        access: "read",
      }),
    ).toMatchObject({
      credentialBindingId: "host/opaque binding:1",
      access: "read",
    });
    expect(GitCredentialBindingId.safeParse("x".repeat(256)).success).toBe(true);
    expect(GitCredentialBindingId.safeParse("x".repeat(257)).success).toBe(false);
    expect(GitCredentialBindingId.safeParse("").success).toBe(false);
  });

  test("derives portable host-aware repository mount paths", () => {
    expect(defaultRepositoryMountPath("https://github.com/acme/app.git")).toBe(
      "repos/github.com/acme/app",
    );
    expect(defaultRepositoryMountPath("https://gitlab.com/acme/app.git")).toBe(
      "repos/gitlab.com/acme/app",
    );
    expect(defaultRepositoryMountPath("https://dev.azure.com/acme/project/_git/app")).toBe(
      "repos/dev.azure.com/acme/project/_git/app",
    );
    expect(defaultRepositoryMountPath("https://git.example.com:8443/acme/app.git")).toBe(
      "repos/git.example.com%3A8443/acme/app",
    );
    expect(() => defaultRepositoryMountPath("ssh://git.example.com/acme/app.git")).toThrow(
      "invalid repository URI",
    );
    expect(normalizeResourceMountPath("repos\\github.com\\acme\\app")).toBe(
      "repos/github.com/acme/app",
    );
    expect(resourceMountPathCollisionKey("repos/GitHub.com/Acme/App")).toBe(
      "repos/github.com/acme/app",
    );
    expect(resourceMountPathCollisionKey("repos/example.com/acme/caf\u00e9")).toBe(
      resourceMountPathCollisionKey("repos/example.com/acme/cafe\u0301"),
    );
    expect(() => defaultRepositoryMountPath("https://github.com/acme/aux.git")).toThrow(
      "invalid resource mount path",
    );
    expect(normalizeResourceMountPath("repos/github.com/acme/aux-repository")).toBe(
      "repos/github.com/acme/aux-repository",
    );
  });

  test("rejects non-portable and traversal mount paths", () => {
    for (const path of [
      "/repos/acme/app",
      "C:\\repos\\acme\\app",
      "repos/../secrets",
      "repos//acme/app",
      "repos/./acme",
      "repos/acme/",
      "repos/acme/NUL",
      "repos/acme/trailing.",
      "repos/acme/a:b",
    ]) {
      expect(() => normalizeResourceMountPath(path), path).toThrow("invalid resource mount path");
    }
  });

  test("resource merges compare effective mount paths case-insensitively", () => {
    const github = {
      kind: "repository" as const,
      uri: "https://github.com/acme/app.git",
      ref: "main",
    };
    const gitlab = {
      kind: "repository" as const,
      uri: "https://gitlab.com/acme/app.git",
      ref: "main",
    };
    expect(mergeResourceRefs([github], [gitlab], { rejectConflicts: true })).toHaveLength(2);
    expect(() =>
      mergeResourceRefs(
        [{ ...github, mountPath: "repos/shared/App" }],
        [{ ...gitlab, mountPath: "repos/SHARED/app" }],
        { rejectConflicts: true },
      ),
    ).toThrow("resource mount path is already attached");
    expect(() =>
      mergeResourceRefs(
        [
          { ...github, mountPath: "repos/shared/App" },
          { ...gitlab, mountPath: "repos/SHARED/app" },
        ],
        [],
        { rejectConflicts: true },
      ),
    ).toThrow("resource mount path is already attached");
  });

  test("runtime uniqueness rejects repeated resources before materialization", () => {
    const resource = {
      kind: "repository" as const,
      uri: "https://github.com/acme/app.git",
      ref: "main",
    };
    expect(() => assertUniqueResourceMountPaths([resource, resource])).toThrow(
      "resource mount path is already attached",
    );
  });

  test("derives one canonical binding id across legacy provider-id shapes", () => {
    const nonNumericGitHub = RepositoryResourceRef.parse({
      kind: "repository",
      uri: "https://github.com/acme/repo.git",
      ref: "main",
      provider: "github",
      installationId: "external-installation",
    });
    expect(gitCredentialProviderForRepository(nonNumericGitHub)).toBe("github");
    expect(gitCredentialBindingIdForRepository(nonNumericGitHub)).toBe("github");

    const numericGitHub = RepositoryResourceRef.parse({
      ...nonNumericGitHub,
      installationId: "123",
    });
    expect(gitCredentialBindingIdForRepository(numericGitHub)).toBe("github-installation:123");

    const gitlabWithStrayLegacyAlias = RepositoryResourceRef.parse({
      kind: "repository",
      uri: "https://gitlab.example/acme/repo.git",
      ref: "main",
      provider: "gitlab",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    });
    expect(gitCredentialBindingIdForRepository(gitlabWithStrayLegacyAlias)).toBe("gitlab");
  });

  test("accepts MCP tool refs on create session", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      tools: [
        { kind: "mcp", id: "docs" },
        { kind: "mcp", id: "context7", optional: true },
      ],
    });
    expect(payload.tools).toEqual([
      { kind: "mcp", id: "docs" },
      { kind: "mcp", id: "context7", optional: true },
    ]);
  });

  test("accepts per-session MCP servers and credential rotations without response value echo", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      tools: [{ kind: "mcp", id: "crm" }],
      mcpServers: [
        {
          id: "crm",
          name: "CRM MCP",
          url: "https://crm.example/mcp",
          allowedTools: ["workouts.list"],
          timeoutMs: 1500,
          cacheToolsList: false,
          headers: { Authorization: "Bearer create-secret" },
        },
      ],
    });
    expect(payload.mcpServers[0]?.headers).toEqual({ Authorization: "Bearer create-secret" });
    const hostPayload = CreateSessionRequest.parse({
      initialMessage: "inspect host repo",
      tools: [{ kind: "mcp", id: "host_gitlab" }],
      mcpServers: [
        {
          id: "host_gitlab",
          url: "https://gitlab-tools.example/mcp",
          connectionRef: {
            connectionId: "cloud-connection:gitlab:42",
            providerDomain: "gitlab.example",
            kind: "oauth2",
          },
        },
      ],
    });
    expect(hostPayload.mcpServers[0]?.connectionRef?.connectionId).toBe(
      "cloud-connection:gitlab:42",
    );
    expect(() =>
      CreateSessionRequest.parse({
        initialMessage: "bad url",
        mcpServers: [{ id: "bad", url: "http://example.com/mcp" }],
      }),
    ).toThrow();

    const event = ClientSessionEvent.parse({
      type: "user.message",
      payload: {
        text: "rotate",
        mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer rotated-secret" } }],
      },
    });
    expect(event.type).toBe("user.message");
    if (event.type !== "user.message") {
      throw new Error("expected user.message");
    }
    expect(event.payload.mcpCredentialUpdates?.[0]?.headers.Authorization).toBe(
      "Bearer rotated-secret",
    );

    const metadata = SessionMcpServerMetadata.parse({
      id: "crm",
      name: "CRM MCP",
      url: "https://crm.example/mcp",
      headerNames: ["Authorization"],
      credentialVersion: 2,
    });
    expect(metadata).toEqual({
      id: "crm",
      name: "CRM MCP",
      url: "https://crm.example/mcp",
      headerNames: ["Authorization"],
      credentialVersion: 2,
      connectionRef: null,
    });
    expect(() =>
      SessionMcpServerMetadata.parse({
        ...metadata,
        headers: { Authorization: "Bearer must-not-echo" },
      }),
    ).toThrow();
  });

  test("OAuth start request rejects non-URL resources", () => {
    expect(() => OAuthStartRequest.parse({ resource: "example.com" })).toThrow();
    expect(OAuthStartRequest.parse({ resource: "https://mcp.example.com/mcp" }).resource).toBe(
      "https://mcp.example.com/mcp",
    );
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
    expect(() =>
      ResourceRef.parse({
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        metadata: { ref: "main" },
      }),
    ).toThrow();
  });

  test("rejects invalid tool refs", () => {
    expect(() =>
      CreateSessionRequest.parse({
        initialMessage: "inspect repo",
        tools: [{ kind: "document", id: "docs" }],
      }),
    ).toThrow();
  });

  test("accepts model and reasoning effort on create session", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
    expect(payload.model).toBe("gpt-5.6-sol");
    expect(payload.reasoningEffort).toBe("xhigh");
  });

  test("accepts and trims per-session instructions", () => {
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      instructions: "  You are the reviewer persona. Be terse.  ",
    });
    expect(payload.instructions).toBe("You are the reviewer persona. Be terse.");
  });

  test("omitting per-session instructions leaves it undefined (byte-identical to today)", () => {
    const payload = CreateSessionRequest.parse({ initialMessage: "inspect repo" });
    expect(payload.instructions).toBeUndefined();
  });

  test("rejects empty / whitespace-only per-session instructions", () => {
    expect(() =>
      CreateSessionRequest.parse({
        initialMessage: "inspect repo",
        instructions: "",
      }),
    ).toThrow();
    expect(() =>
      CreateSessionRequest.parse({
        initialMessage: "inspect repo",
        instructions: "   ",
      }),
    ).toThrow();
  });

  test("rejects per-session instructions over the 32768-char cap", () => {
    expect(() =>
      CreateSessionRequest.parse({
        initialMessage: "inspect repo",
        instructions: "x".repeat(32769),
      }),
    ).toThrow();
    // Exactly at the cap is accepted.
    const payload = CreateSessionRequest.parse({
      initialMessage: "inspect repo",
      instructions: "x".repeat(32768),
    });
    expect(payload.instructions?.length).toBe(32768);
  });

  test("accepts client config payloads", () => {
    const payload = ClientConfig.parse({
      apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
      deploymentRevision: "test-sha",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
      defaultReasoningEffort: "high",
      allowedReasoningEfforts: ["low", "medium", "high"],
      mcpServers: [{ id: "opengeni", name: "OpenGeni" }],
      fileUploads: { enabled: true, maxSizeBytes: 5_000_000_000 },
      productAccessMode: "managed",
      auth: { mode: "managedSession", session: "cookie" },
    });
    expect(payload.defaultReasoningEffort).toBe("high");
    expect(payload.deploymentRevision).toBe("test-sha");
    expect(payload.fileUploads.enabled).toBe(true);
    expect(payload.auth.mode).toBe("managedSession");
    expect(payload.mcpServers[0]?.id).toBe("opengeni");
    // models defaults to [] for back-compat (callers reading only allowedModels
    // are unaffected when the host hasn't populated the richer list).
    expect(payload.models).toEqual([]);
  });

  test("round-trips the provider-grouped models list on client config", () => {
    const models = [
      {
        id: "gpt-5.6-sol",
        label: "gpt-5.6-sol",
        provider: "openai",
        providerLabel: "OpenAI",
        api: "responses" as const,
        contextWindowTokens: 1_050_000,
      },
      {
        id: "accounts/fireworks/models/glm-5p2",
        label: "GLM 5.2",
        provider: "fireworks",
        providerLabel: "Fireworks AI",
        api: "chat" as const,
        contextWindowTokens: 1_048_576,
      },
    ];
    const payload = ClientConfig.parse({
      apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
      deploymentRevision: "test-sha",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol", "accounts/fireworks/models/glm-5p2"],
      models,
      defaultReasoningEffort: "high",
      allowedReasoningEfforts: ["low", "medium", "high"],
      fileUploads: { enabled: true, maxSizeBytes: 5_000_000_000 },
      productAccessMode: "managed",
    });
    expect(payload.models).toEqual(models);
    expect(payload.models[1]?.api).toBe("chat");
  });

  test("rejects a client model with an unknown wire api", () => {
    expect(() =>
      ClientModel.parse({
        id: "m",
        label: "m",
        provider: "p",
        providerLabel: "P",
        api: "grpc",
      }),
    ).toThrow();
  });

  test("accepts checkout requests that use the caller default account", () => {
    const payload = CreateCheckoutRequest.parse({ amountUsd: 25.5 });
    expect(payload.amountUsd).toBe(25.5);
    expect(payload.accountId).toBeUndefined();
    expect(CreateCheckoutRequest.parse({ amountUsd: 5 }).amountUsd).toBe(5);
    expect(CreateCheckoutRequest.parse({ amountUsd: 19.99 }).amountUsd).toBe(19.99);
    expect(() => CreateCheckoutRequest.parse({ amountUsd: 4.99 })).toThrow();
    expect(() => CreateCheckoutRequest.parse({ amountUsd: 5.001 })).toThrow();
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
      items: [
        {
          id: "mcp:example",
          kind: "mcp",
          source: "public_registry",
          name: "Example MCP",
          endpointUrl: "https://example.com/mcp",
          runtime: { available: true, mcpServerId: "example", transport: "streamable-http" },
        },
      ],
      installations: [],
    });
    expect(catalog.items[0]?.runtime.mcpServerId).toBe("example");
    expect(catalog.items[0]?.enabled).toBe(false);
  });

  test("rejects empty user message command", () => {
    expect(() =>
      ClientSessionEvent.parse({
        type: "user.message",
        payload: { text: "" },
      }),
    ).toThrow();
  });

  test("validates structured human-input questions and typed client responses", () => {
    const input = RequestHumanInputToolInput.parse({
      questions: [
        {
          id: "environment",
          kind: "single_select",
          prompt: "Where should this run?",
          options: [
            { id: "staging", label: "Staging" },
            { id: "production", label: "Production" },
          ],
        },
        {
          id: "notes",
          kind: "text",
          prompt: "Anything else?",
          required: false,
          validation: { maxLength: 200 },
        },
      ],
      allowSkip: true,
      expiresInSeconds: 300,
    });
    expect(input.questions[0]).toMatchObject({ required: true, allowOther: false });
    expect(input.questions[1]?.options).toEqual([]);

    const response = SubmitHumanInputResponseRequest.parse({
      outcome: "answered",
      answers: [{ questionId: "environment", values: ["staging"] }],
    });
    expect(
      ClientSessionEvent.parse({
        type: "user.humanInputResponse",
        clientEventId: "human-response-1",
        payload: {
          requestId: "00000000-0000-4000-8000-000000000001",
          response,
        },
      }),
    ).toMatchObject({ type: "user.humanInputResponse" });

    expect(() =>
      RequestHumanInputToolInput.parse({
        questions: [
          {
            id: "bad",
            kind: "text",
            prompt: "Bad",
            options: [{ id: "not-allowed", label: "Not allowed" }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      RequestHumanInputToolInput.parse({
        questions: [
          {
            id: "duplicate",
            kind: "multi_select",
            prompt: "Bad",
            options: [
              { id: "same", label: "One" },
              { id: "same", label: "Two" },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  test("accepts per-turn resources, tools, and model settings on user messages", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const payload = ClientSessionEvent.parse({
      type: "user.message",
      payload: {
        text: "use this too",
        resources: [{ kind: "file", fileId }],
        tools: [{ kind: "mcp", id: "docs" }],
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    });
    expect(payload.type).toBe("user.message");
    if (payload.type !== "user.message") throw new Error("expected user.message");
    expect(payload.payload.resources).toEqual([{ kind: "file", fileId }]);
    expect(payload.payload.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    expect(payload.payload.model).toBe("gpt-5.6-sol");
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
      events: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          workspaceId: "00000000-0000-4000-8000-000000000100",
          sessionId: "00000000-0000-4000-8000-000000000001",
          sequence: 1,
          type: "agent.message.delta",
          payload: { text: "hi" },
          occurredAt: new Date().toISOString(),
        },
      ],
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
    expect(
      DocumentSearchRequest.parse({
        query: "network policy",
        limit: 20,
        mode: "hybrid",
        sourceKinds: ["repository"],
      }),
    ).toEqual({
      query: "network policy",
      limit: 20,
      mode: "hybrid",
      sourceKinds: ["repository"],
    });
  });

  test("accepts knowledge memory contracts", () => {
    expect(
      CreateKnowledgeMemoryRequest.parse({
        text: "Prefer Azure Blob for production object storage.",
        kind: "decision",
        confidence: 0.9,
      }),
    ).toEqual({
      text: "Prefer Azure Blob for production object storage.",
      status: "active",
      kind: "decision",
      scope: "workspace",
      sourceRefs: [],
      confidence: 0.9,
      metadata: {},
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

  test("mergeToolRefs: strict beats optional for the same server", () => {
    // A server that is both optional and strict must end up STRICT. This keeps
    // explicit strict selections fail-loud when they collide with optional pack
    // refs or auto-attached capability MCP defaults.
    expect(
      mergeToolRefs(
        [{ kind: "mcp", id: "cap-notebook", optional: true }],
        [{ kind: "mcp", id: "cap-notebook" }],
      ),
    ).toEqual([{ kind: "mcp", id: "cap-notebook" }]);
    // Order-independent: explicit first, optional second → still strict.
    expect(
      mergeToolRefs(
        [{ kind: "mcp", id: "cap-notebook" }],
        [{ kind: "mcp", id: "cap-notebook", optional: true }],
      ),
    ).toEqual([{ kind: "mcp", id: "cap-notebook" }]);
    // Both optional → stays optional (non-fatal on connect).
    expect(
      mergeToolRefs(
        [{ kind: "mcp", id: "cap-notebook", optional: true }],
        [{ kind: "mcp", id: "cap-notebook", optional: true }],
      ),
    ).toEqual([{ kind: "mcp", id: "cap-notebook", optional: true }]);
  });
});

describe("capability pack runtime manifest fields", () => {
  const baseManifest = {
    id: "infra-runtime",
    name: "Infra runtime",
    description: "Infrastructure operations pack.",
    role: "infrastructure",
    category: "infrastructure",
    version: "0.1.0",
  };
  const skill = {
    name: "infra-ops",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: infra-ops\ndescription: Operate infra.\n---\n# Infra ops\n",
      },
      { path: "references/runbook.md", content: "Runbook." },
    ],
  };

  test("packs without runtime fields keep their existing shape", () => {
    const pack = CapabilityPack.parse(baseManifest);
    expect(pack.sandboxImage).toBeUndefined();
    expect(pack.skills).toEqual([]);
  });

  test("accepts a sandbox image ref and inline skills", () => {
    const pack = CapabilityPack.parse({
      ...baseManifest,
      sandboxImage:
        "ghcr.io/example/infra-sandbox@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      skills: [skill],
    });
    expect(pack.sandboxImage).toContain("@sha256:");
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/runbook.md",
    ]);
  });

  test("requires every skill to include a top-level SKILL.md", () => {
    expect(() =>
      CapabilityPack.parse({
        ...baseManifest,
        skills: [
          { name: "infra-ops", files: [{ path: "references/runbook.md", content: "Runbook." }] },
        ],
      }),
    ).toThrow();
  });

  test("rejects unsafe skill file paths", () => {
    for (const path of [
      "../escape.md",
      "/absolute.md",
      "a//b.md",
      "./SKILL.md",
      "refs/../SKILL.md",
      "refs\\windows.md",
    ]) {
      expect(() =>
        CapabilityPack.parse({
          ...baseManifest,
          skills: [
            {
              name: "infra-ops",
              files: [
                { path: "SKILL.md", content: "x" },
                { path, content: "x" },
              ],
            },
          ],
        }),
      ).toThrow();
    }
  });

  test("rejects skill names that are not a single safe path segment", () => {
    for (const name of ["infra/ops", "..", ".hidden", "-leading", ""]) {
      expect(() =>
        CapabilityPack.parse({
          ...baseManifest,
          skills: [{ name, files: [{ path: "SKILL.md", content: "x" }] }],
        }),
      ).toThrow();
    }
  });

  test("rejects duplicate skill names and duplicate file paths", () => {
    expect(() =>
      CapabilityPack.parse({
        ...baseManifest,
        skills: [skill, { ...skill, description: "duplicate" }],
      }),
    ).toThrow();
    expect(() =>
      CapabilityPack.parse({
        ...baseManifest,
        skills: [
          {
            name: "infra-ops",
            files: [
              { path: "SKILL.md", content: "a" },
              { path: "SKILL.md", content: "b" },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("cleared run-state sentinel", () => {
  test("the canonical blob is recognized as cleared", () => {
    expect(isClearedRunStateBlob(CLEARED_RUN_STATE_BLOB)).toBe(true);
    // Tolerant of extra fields so a future sentinel addition can't resurrect context.
    expect(
      isClearedRunStateBlob(JSON.stringify({ [CLEARED_RUN_STATE_MARKER]: true, note: "x" })),
    ).toBe(true);
  });

  test("real run-state blobs and junk are NOT treated as cleared", () => {
    // A real Agents-SDK serialized run state (carries $schemaVersion/history).
    expect(
      isClearedRunStateBlob(
        JSON.stringify({ $schemaVersion: "1.11", currentTurn: 1, generatedItems: [] }),
      ),
    ).toBe(false);
    expect(isClearedRunStateBlob(null)).toBe(false);
    expect(isClearedRunStateBlob(undefined)).toBe(false);
    expect(isClearedRunStateBlob("")).toBe(false);
    expect(isClearedRunStateBlob("not json")).toBe(false);
    expect(isClearedRunStateBlob(JSON.stringify({ [CLEARED_RUN_STATE_MARKER]: false }))).toBe(
      false,
    );
    expect(isClearedRunStateBlob("null")).toBe(false);
  });
});

describe("evaluateWorkspaceModelPolicy", () => {
  test("no policy allows everything", () => {
    expect(
      evaluateWorkspaceModelPolicy(null, { providerId: "azure", modelId: "gpt-5.6-sol" }),
    ).toEqual({ allowed: true });
  });

  test("null fields are unrestricted", () => {
    expect(
      evaluateWorkspaceModelPolicy(
        { allowedProviders: null, allowedModels: null },
        { providerId: "azure", modelId: "gpt-5.6-sol" },
      ),
    ).toEqual({ allowed: true });
  });

  test("provider allowlist blocks a non-listed provider (the codex-only posture)", () => {
    const policy = { allowedProviders: ["codex-subscription"], allowedModels: null };
    expect(
      evaluateWorkspaceModelPolicy(policy, { providerId: "azure", modelId: "gpt-5.6-sol" }),
    ).toEqual({ allowed: false, reason: "provider" });
    expect(
      evaluateWorkspaceModelPolicy(policy, {
        providerId: "codex-subscription",
        modelId: "codex/gpt-5.6-sol",
      }),
    ).toEqual({ allowed: true });
  });

  test("model allowlist is an ADDITIONAL restriction on top of providers", () => {
    const policy = {
      allowedProviders: ["codex-subscription"],
      allowedModels: ["codex/gpt-5.6-sol"],
    };
    expect(
      evaluateWorkspaceModelPolicy(policy, {
        providerId: "codex-subscription",
        modelId: "codex/gpt-5.6-luna",
      }),
    ).toEqual({ allowed: false, reason: "model" });
    expect(
      evaluateWorkspaceModelPolicy(policy, {
        providerId: "codex-subscription",
        modelId: "codex/gpt-5.6-sol",
      }),
    ).toEqual({ allowed: true });
  });

  test("empty arrays are an explicit total block, not unrestricted", () => {
    expect(
      evaluateWorkspaceModelPolicy(
        { allowedProviders: [], allowedModels: null },
        { providerId: "codex-subscription", modelId: "codex/gpt-5.6-sol" },
      ),
    ).toEqual({ allowed: false, reason: "provider" });
  });
});
