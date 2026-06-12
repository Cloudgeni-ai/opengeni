import { describe, expect, test } from "bun:test";
import { Permission } from "@opengeni/contracts";
import {
  agentConfigFromFormState,
  buildApiKeyPermissionGroups,
  buildTools,
  delegableApiKeyPermissions,
  capabilityErrorToast,
  enabledWorkspaceCapabilityMcpServers,
  filterCapabilityCatalogItems,
  formStateFromScheduledTask,
  gitHubRepositoryResource,
  mergeMcpServerOptions,
  projectSessionTimeline,
  sanitizeEventForDisplay,
  scheduleFromFormState,
  selectedAvailableCapabilityToolIds,
  summarizePackContents,
  workspaceAgentPath,
  workspaceSessionPath,
} from "./App";
import type { CapabilityCatalogItem, GitHubRepository, ResourceRef, ScheduledTask, ScheduledTaskScheduleSpec, Session, SessionEvent } from "./types";

describe("workspace route helpers", () => {
  test("builds canonical workspace-scoped console URLs", () => {
    expect(workspaceAgentPath("workspace-1")).toBe("/workspaces/workspace-1/agent");
    expect(workspaceSessionPath("workspace-1", "session-1")).toBe("/workspaces/workspace-1/sessions/session-1");
  });

  test("does not build legacy unscoped session URLs", () => {
    expect(workspaceSessionPath("workspace-1", "session-1")).not.toBe("/sessions/session-1");
  });
});

describe("api key permission options", () => {
  test("groups offer every contracts Permission exactly once", () => {
    const offered = buildApiKeyPermissionGroups().flatMap((group) => group.permissions);
    expect(offered.length).toBe(new Set(offered).size);
    expect([...offered].sort()).toEqual([...Permission.options].sort());
  });

  test("groups have no catch-all bucket and keep workspace first, admin last", () => {
    const labels = buildApiKeyPermissionGroups().map((group) => group.label);
    expect(labels).toEqual([
      "Workspace",
      "Sessions",
      "Files & documents",
      "Scheduled tasks",
      "Environments",
      "GitHub",
      "Goals",
      "Admin & account",
    ]);
  });

  test("offers the scopes the old hardcoded list omitted", () => {
    const offered = buildApiKeyPermissionGroups().flatMap((group) => group.permissions);
    const previouslyMissing: Permission[] = ["environments:manage", "environments:use", "goals:manage", "workspace:admin", "github:manage", "workspace:create", "billing:read", "billing:manage", "members:manage", "account:read", "account:admin"];
    for (const permission of previouslyMissing) {
      expect(offered).toContain(permission);
    }
  });

  test("workspace:admin grants can delegate every permission", () => {
    expect(delegableApiKeyPermissions(["workspace:admin"])).toEqual(new Set(Permission.options));
  });

  test("non-admin grants can only delegate their own permissions", () => {
    const delegable = delegableApiKeyPermissions(["sessions:read", "files:read", "api_keys:manage"]);
    expect([...delegable].sort()).toEqual(["api_keys:manage", "files:read", "sessions:read"]);
    expect(delegable.has("environments:manage")).toBe(false);
  });

  test("empty grants can delegate nothing", () => {
    expect(delegableApiKeyPermissions([]).size).toBe(0);
  });
});

describe("projectSessionTimeline", () => {
  // Timeline projection itself (deltas, tool matching, grouping, ...) is
  // @opengeni/react's `buildTimeline`, tested in packages/react. These tests
  // cover the console-specific layer: event sanitization composed under it
  // and the initial-message fallback.
  test("keeps messages and activity in event order through the package projection", () => {
    const events = [
      event(1, "user.message", { text: "Inspect the repo" }),
      event(2, "turn.started", {}),
      event(3, "agent.message.delta", { text: "I will inspect first." }),
      event(4, "agent.reasoning.delta", { text: "Checking the repository state." }),
      event(5, "agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }),
      event(6, "agent.toolCall.output", { id: "call-1", output: "ok" }),
      event(7, "agent.message.delta", { text: "The repo is ready." }),
    ];

    const items = projectSessionTimeline(session(), events);

    expect(items.map((item) => item.kind)).toEqual(["user-message", "agent-message", "reasoning", "tool-call", "agent-message"]);
    expect(items[1]).toMatchObject({ kind: "agent-message", text: "I will inspect first.", streaming: false });
    expect(items[3]).toMatchObject({ kind: "tool-call", status: "complete" });
    expect(items[4]).toMatchObject({ kind: "agent-message", text: "The repo is ready.", streaming: true });
  });

  test("renders reasoning summary text", () => {
    const items = projectSessionTimeline(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", { text: "Checking credentials" }),
      event(3, "agent.reasoning.delta", { text: " and repository state." }),
    ]);

    const reasoning = items.find((item) => item.kind === "reasoning");
    expect(reasoning).toBeDefined();
    expect(JSON.stringify(reasoning)).toContain("Checking credentials and repository state.");
  });

  test("renders legacy reasoning item payloads safely", () => {
    const items = projectSessionTimeline(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", {
        item: {
          rawItem: {
            content: [{ type: "input_text", text: "Legacy summary text." }],
          },
        },
      }),
    ]);

    const reasoning = items.find((item) => item.kind === "reasoning");
    expect(JSON.stringify(reasoning)).toContain("Legacy summary text.");
    expect(JSON.stringify(reasoning)).not.toContain("rawItem");
  });

  test("turn completion finalizes running items", () => {
    const items = projectSessionTimeline(session(), [
      event(1, "user.message", { text: "Check auth" }),
      event(2, "agent.reasoning.delta", { text: "Checking auth." }),
      event(3, "agent.message.completed", { text: "Done." }),
      event(4, "turn.completed", { output: "Done." }),
    ]);

    expect(items.find((item) => item.kind === "reasoning")).toMatchObject({ streaming: false });
    expect(JSON.stringify(items)).not.toContain("\"running\"");
  });

  test("keeps per-turn attachments on user messages", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const items = projectSessionTimeline(session(), [
      event(1, "user.message", {
        text: "Use this file",
        resources: [{ kind: "file", fileId, mountPath: `files/${fileId}` }],
        tools: [{ kind: "mcp", id: "docs" }],
      }),
    ]);

    expect(items[0]).toMatchObject({
      kind: "user-message",
      resources: [{ kind: "file", fileId, mountPath: `files/${fileId}` }],
      tools: [{ kind: "mcp", id: "docs" }],
    });
  });

  test("falls back to the initial message while the event log is empty", () => {
    const items = projectSessionTimeline(session({ initialMessage: "Bootstrap the cluster" }), []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user-message", text: "Bootstrap the cluster" });
  });

  test("hides archived terminal failure payloads in the main timeline projection", () => {
    const items = projectSessionTimeline(session({ status: "failed" }), [
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.failed", {
        error: "Failed to apply a Modal sandbox manifest: RESOURCE_EXHAUSTED",
      }),
      event(3, "sandbox.operation.failed", {
        error: "/modal.client.ModalClient/SandboxTerminate RESOURCE_EXHAUSTED",
      }),
    ]);

    expect(JSON.stringify(items)).not.toContain("RESOURCE_EXHAUSTED");
    expect(JSON.stringify(items)).toContain("Historical failure payload hidden in the web console.");
  });

  test("keeps active failure payloads visible in the main timeline projection", () => {
    const items = projectSessionTimeline(session({ status: "running" }), [
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.failed", { error: "Current run failed" }),
    ]);

    expect(JSON.stringify(items)).toContain("Current run failed");
  });

  test("redacts active provider-internal sandbox failures in the main timeline projection", () => {
    const items = projectSessionTimeline(session({ status: "running" }), [
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.failed", {
        error: "Failed to apply a Modal sandbox manifest and close the sandbox. Manifest error: /modal.client.ModalClient/ContainerFilesystemExec RESOURCE_EXHAUSTED: Bandwidth exhausted or memory limit exceeded",
      }),
    ]);

    const json = JSON.stringify(items);
    expect(json).not.toContain("RESOURCE_EXHAUSTED");
    expect(json).not.toContain("ModalClient");
    expect(json).toContain("temporary capacity limit");
  });
});

describe("buildTools", () => {
  test("adds OpenGeni tool once when enabled", () => {
    expect(buildTools(undefined, false, true)).toEqual([{ kind: "mcp", id: "opengeni" }]);
    expect(buildTools([{ kind: "mcp", id: "opengeni" }], false, true)).toEqual([{ kind: "mcp", id: "opengeni" }]);
  });

  test("adds document search and file download tools once when enabled", () => {
    expect(buildTools(undefined, true, false)).toEqual([{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "files" }]);
    expect(buildTools([{ kind: "mcp", id: "docs" }], true, false)).toEqual([{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "files" }]);
    expect(buildTools([{ kind: "mcp", id: "files" }], true, false)).toEqual([{ kind: "mcp", id: "files" }, { kind: "mcp", id: "docs" }]);
  });

  test("preserves existing tools when document search is disabled", () => {
    expect(buildTools([{ kind: "mcp", id: "custom" }], false, false)).toEqual([{ kind: "mcp", id: "custom" }]);
  });

  test("combines OpenGeni with document tools", () => {
    expect(buildTools(undefined, true, true)).toEqual([
      { kind: "mcp", id: "opengeni" },
      { kind: "mcp", id: "docs" },
      { kind: "mcp", id: "files" },
    ]);
  });

  test("adds enabled custom MCP tools once", () => {
    expect(buildTools([{ kind: "mcp", id: "custom" }], false, false, ["custom", "search"])).toEqual([
      { kind: "mcp", id: "custom" },
      { kind: "mcp", id: "search" },
    ]);
  });

  test("selects enabled custom MCPs by default for future agent turns", () => {
    expect([...selectedAvailableCapabilityToolIds(new Set(["old"]), ["cap-4fetch", "cap-search"])]).toEqual(["cap-4fetch", "cap-search"]);
  });

  test("preserves explicit custom MCP deselection across config refreshes", () => {
    expect([...selectedAvailableCapabilityToolIds(new Set(["cap-search"]), ["cap-4fetch", "cap-search"], new Set(["cap-4fetch", "cap-search"]))]).toEqual(["cap-search"]);
    expect([...selectedAvailableCapabilityToolIds(new Set(["cap-search"]), ["cap-4fetch", "cap-search", "cap-new"], new Set(["cap-4fetch", "cap-search"]))]).toEqual(["cap-search", "cap-new"]);
  });

  test("derives enabled runtime-ready MCPs from workspace capabilities", () => {
    expect(enabledWorkspaceCapabilityMcpServers([
      capabilityItem({
        id: "mcp:ready",
        kind: "mcp",
        name: "Ready MCP",
        enabled: true,
        runtime: { available: true, mcpServerId: "cap-ready", transport: "streamable-http", notes: null },
      }),
      capabilityItem({
        id: "mcp:disabled",
        kind: "mcp",
        name: "Disabled MCP",
        enabled: false,
        runtime: { available: true, mcpServerId: "cap-disabled", transport: "streamable-http", notes: null },
      }),
      capabilityItem({
        id: "mcp:gated",
        kind: "mcp",
        name: "Gated MCP",
        enabled: true,
        runtime: { available: false, mcpServerId: "cap-gated", transport: "streamable-http", notes: null },
      }),
      capabilityItem({ id: "api:social", kind: "api", name: "Social API", enabled: true }),
    ])).toEqual([{ id: "cap-ready", name: "Ready MCP" }]);
  });

  test("merges configured and workspace MCP options without duplicates", () => {
    expect(mergeMcpServerOptions(
      [{ id: "configured", name: "Configured" }, { id: "shared", name: "Configured Shared" }],
      [{ id: "shared", name: "Workspace Shared" }, { id: "workspace", name: "Workspace" }],
    )).toEqual([
      { id: "configured", name: "Configured" },
      { id: "shared", name: "Configured Shared" },
      { id: "workspace", name: "Workspace" },
    ]);
  });
});

describe("capability catalog helpers", () => {
  test("filters by kind and search text", () => {
    const items = [
      capabilityItem({ id: "mcp:docs", kind: "mcp", name: "Document Search", category: "knowledge", tags: ["docs"] }),
      capabilityItem({ id: "api:social", kind: "api", name: "Social Accounts", category: "marketing", tags: ["social"] }),
    ];

    expect(filterCapabilityCatalogItems(items, "mcp", "document").map((item) => item.id)).toEqual(["mcp:docs"]);
    expect(filterCapabilityCatalogItems(items, "all", "marketing").map((item) => item.id)).toEqual(["api:social"]);
  });

  test("labels MCP probe failures as connection failures", () => {
    expect(capabilityErrorToast(
      new Error('API 422: MCP capability "4fetch" could not be enabled because OpenGeni could not initialize https://api.4fetch.com/mcp/v1/fetch: Unable to connect.'),
      "Capability update failed",
    )).toEqual({
      title: "MCP connection failed",
      description: 'MCP capability "4fetch" could not be enabled because OpenGeni could not initialize https://api.4fetch.com/mcp/v1/fetch: Unable to connect.',
    });
  });

  test("summarizes pack contents from tools and metadata", () => {
    const summary = summarizePackContents(capabilityItem({
      id: "pack:marketing-social-daily-analysis",
      kind: "pack",
      name: "Marketing social daily analysis",
      tools: [{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "opengeni" }],
      metadata: {
        skill: "social-media-marketing",
        firstPartyMcpTools: ["social_posts_recent"],
        connectors: [{
          id: "x",
          name: "X",
          authModel: "oauth2_authorization_code_pkce",
          providers: ["x"],
          scopes: ["tweet.read"],
          required: false,
        }],
        knowledge: [{
          id: "marketing-playbook",
          name: "Marketing playbook",
          description: "Brand voice and campaign context.",
        }],
        scheduledTaskTemplates: [{
          id: "daily-social-analysis",
          name: "Daily social analysis",
          defaultSchedule: { type: "calendar", timeZone: "UTC", hour: 9, minute: 0 },
        }],
      },
    }));

    expect(summary).toMatchObject({
      hasContents: true,
      mcpServerIds: ["docs", "opengeni"],
      firstPartyMcpTools: ["social_posts_recent"],
      skills: ["social-media-marketing"],
      connectors: [{ id: "x", name: "X", scopes: ["tweet.read"] }],
      knowledge: [{ id: "marketing-playbook", name: "Marketing playbook" }],
      scheduledTaskTemplates: [{ id: "daily-social-analysis", name: "Daily social analysis", scheduleSummary: "Calendar at 09:00 UTC" }],
    });
  });
});

describe("scheduled task form helpers", () => {
  test("hydrates and serializes once schedules", () => {
    const task = scheduledTask({
      type: "once",
      runAt: "2026-05-12T10:00:00.000Z",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    const form = formStateFromScheduledTask(task);

    expect(form.scheduleType).toBe("once");
    expect(scheduleFromFormState(form)).toEqual(task.schedule);
  });

  test("hydrates and serializes interval schedules", () => {
    const task = scheduledTask({ type: "interval", everySeconds: 1800 });
    const form = formStateFromScheduledTask(task);

    expect(form.scheduleType).toBe("interval");
    expect(form.intervalMinutes).toBe(30);
    expect(scheduleFromFormState(form)).toEqual({ type: "interval", everySeconds: 1800 });
  });

  test("hydrates and serializes calendar schedules", () => {
    const task = scheduledTask({ type: "calendar", timeZone: "Europe/Oslo", hour: 9, minute: 5 });
    const form = formStateFromScheduledTask(task);

    expect(form.scheduleType).toBe("calendar");
    expect(form.calendarTime).toBe("09:05");
    expect(scheduleFromFormState(form)).toEqual({ type: "calendar", timeZone: "Europe/Oslo", hour: 9, minute: 5 });
  });

  test("initializes OpenGeni tool checkbox from existing tools", () => {
    expect(formStateFromScheduledTask(scheduledTask({ type: "interval", everySeconds: 60 })).includeOpenGeniTool).toBe(true);
    expect(formStateFromScheduledTask(scheduledTask(
      { type: "interval", everySeconds: 60 },
      { agentConfig: { ...scheduledTaskAgentConfig(), tools: [] } },
    )).includeOpenGeniTool).toBe(false);
  });

  test("preserves existing agent config while updating prompt and OpenGeni tool", () => {
    const resources: ResourceRef[] = [{ kind: "repository", uri: "https://github.com/example/repo.git", ref: "main", mountPath: "repos/example/repo" }];
    const task = scheduledTask({ type: "interval", everySeconds: 60 }, {
      agentConfig: {
        prompt: "old",
        resources,
        tools: [{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "opengeni" }],
        metadata: { owner: "ops" },
        model: "gpt-5.5",
        reasoningEffort: "high",
        sandboxBackend: "docker",
      },
    });
    const form = { ...formStateFromScheduledTask(task), prompt: "new", includeOpenGeniTool: false };

    expect(form.resources).toEqual(resources);
    expect(agentConfigFromFormState(form, task)).toEqual({
      prompt: "new",
      resources,
      tools: [{ kind: "mcp", id: "docs" }],
      metadata: { owner: "ops" },
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandboxBackend: "docker",
    });
  });

  test("uses form resources in saved agent config while preserving model settings", () => {
    const task = scheduledTask({ type: "interval", everySeconds: 60 }, {
      agentConfig: {
        ...scheduledTaskAgentConfig(),
        resources: [{ kind: "repository", uri: "https://github.com/example/old.git", ref: "main", mountPath: "repos/example/old" }],
        metadata: { owner: "ops" },
        model: "gpt-5.5",
        reasoningEffort: "high",
        sandboxBackend: "docker",
      },
    });
    const selectedResources: ResourceRef[] = [{
      kind: "repository",
      uri: "https://github.com/example/new.git",
      ref: "develop",
      mountPath: "repos/example/new",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }];
    const form = { ...formStateFromScheduledTask(task), resources: selectedResources };

    expect(agentConfigFromFormState(form, task)).toMatchObject({
      resources: selectedResources,
      metadata: { owner: "ops" },
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandboxBackend: "docker",
    });
  });
});

describe("GitHub repository resources", () => {
  test("uses normal git resources for public GitHub App repositories", () => {
    expect(gitHubRepositoryResource(githubRepository({ private: false }), "main")).toEqual({
      kind: "repository",
      uri: "https://github.com/example/public.git",
      ref: "main",
      mountPath: "repos/example/public",
    });
  });

  test("keeps installation metadata for private GitHub App repositories", () => {
    expect(gitHubRepositoryResource(githubRepository({ private: true }), "main")).toEqual({
      kind: "repository",
      uri: "https://github.com/example/public.git",
      ref: "main",
      mountPath: "repos/example/public",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    });
  });
});

describe("sanitizeEventForDisplay", () => {
  test("hides historical terminal failure payloads in the web console", () => {
    const sanitized = sanitizeEventForDisplay(event(7, "turn.failed", {
      error: "Failed to apply a Modal sandbox manifest: RESOURCE_EXHAUSTED",
    }), "failed");

    expect(JSON.stringify(sanitized.payload)).not.toContain("RESOURCE_EXHAUSTED");
    expect(sanitized.payload).toEqual({
      archived: true,
      status: "failed",
      message: "Historical failure payload hidden in the web console.",
    });
  });

  test("keeps active failure payloads available for current-run debugging", () => {
    const active = sanitizeEventForDisplay(event(7, "turn.failed", {
      error: "Current run failed",
    }), "running");

    expect(active.payload).toEqual({ error: "Current run failed" });
  });

  test("redacts active provider-internal sandbox failures in debug payloads", () => {
    const active = sanitizeEventForDisplay(event(7, "turn.failed", {
      error: "Failed to apply a Modal sandbox manifest and close the sandbox. Manifest error: /modal.client.ModalClient/ContainerFilesystemExec RESOURCE_EXHAUSTED: Bandwidth exhausted or memory limit exceeded",
    }), "running");

    expect(JSON.stringify(active.payload)).not.toContain("RESOURCE_EXHAUSTED");
    expect(JSON.stringify(active.payload)).not.toContain("ModalClient");
    expect(active.payload).toEqual({
      error: "Sandbox setup failed because the execution provider reported a temporary capacity limit. Start a new session.",
      redacted: true,
    });
  });
});

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    accountId: "account-1",
    workspaceId: "workspace-1",
    status: "running",
    initialMessage: "Inspect the repo",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    environmentId: null,
    firstPartyMcpPermissions: null,
    temporalWorkflowId: null,
    activeTurnId: "turn-1",
    lastSequence: 0,
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    ...patch,
  };
}

function scheduledTaskAgentConfig(): ScheduledTask["agentConfig"] {
  return {
    prompt: "Run task",
    resources: [],
    tools: [{ kind: "mcp", id: "opengeni" }],
    metadata: {},
    model: "gpt-5.5",
    reasoningEffort: "high",
  };
}

function scheduledTask(schedule: ScheduledTaskScheduleSpec, patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "00000000-0000-4000-8000-000000000100",
    accountId: "account-1",
    workspaceId: "workspace-1",
    name: "Task",
    status: "active",
    schedule,
    temporalScheduleId: "scheduled-task-1",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: scheduledTaskAgentConfig(),
    reusableSessionId: null,
    environmentId: null,
    metadata: {},
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...patch,
  };
}

function githubRepository(patch: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 456,
    installationId: 123,
    fullName: "example/public",
    name: "public",
    private: false,
    htmlUrl: "https://github.com/example/public",
    cloneUrl: "https://github.com/example/public.git",
    defaultBranch: "main",
    accountLogin: "example",
    accountType: "Organization",
    ...patch,
  };
}

function capabilityItem(patch: Partial<CapabilityCatalogItem> & Pick<CapabilityCatalogItem, "id" | "kind" | "name">): CapabilityCatalogItem {
  return {
    source: "built_in",
    description: null,
    category: "general",
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

function event(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence,
    type,
    payload,
    occurredAt: `2026-05-07T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}
