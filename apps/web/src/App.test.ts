import { describe, expect, test } from "bun:test";
import { Permission } from "@opengeni/contracts";

import {
  capabilityErrorToast,
  filterCapabilityCatalogItems,
  summarizePackContents,
} from "./lib/capabilities";
import {
  projectSessionTimeline,
  sanitizeEventForDisplay,
  summarizeSessionFailure,
} from "./lib/events";
import {
  buildApiKeyPermissionGroups,
  buildSessionMcpPermissionGroups,
  delegableApiKeyPermissions,
} from "./lib/permissions";
import { parseCheckoutOutcome, workspaceAgentPath, workspaceSessionPath, workspaceSessionsPath } from "./lib/routes";
import {
  emptyAdvancedSessionDraft,
  submissionExtrasFromAdvancedSessionDraft,
} from "./lib/session-create";
import {
  buildTools,
  enabledWorkspaceCapabilityMcpServers,
  gitHubRepositoryResource,
  mergeMcpServerOptions,
  selectedAvailableCapabilityToolIds,
} from "./lib/session-tools";
import {
  agentConfigFromFormState,
  formStateFromScheduledTask,
  scheduleFromFormState,
  summarizeLastRun,
} from "./lib/scheduled-tasks";
import { entitlementEntries, formatEntitlementValue } from "./lib/format";
import { listViewState } from "./lib/load-state";
import { upsertWorkspace, workspaceCreationAccountId } from "./lib/workspaces";
import type {
  AccessContext,
  CapabilityCatalogItem,
  GitHubRepository,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
  Session,
  SessionEvent,
  Workspace,
} from "./types";

describe("workspace route helpers", () => {
  test("builds canonical workspace-scoped console URLs", () => {
    expect(workspaceSessionsPath("workspace-1")).toBe("/workspaces/workspace-1/sessions");
    expect(workspaceSessionPath("workspace-1", "session-1")).toBe("/workspaces/workspace-1/sessions/session-1");
  });

  test("the legacy agent home maps onto the sessions index", () => {
    expect(workspaceAgentPath("workspace-1")).toBe("/workspaces/workspace-1/sessions");
  });

  test("does not build legacy unscoped session URLs", () => {
    expect(workspaceSessionPath("workspace-1", "session-1")).not.toBe("/sessions/session-1");
  });
});

describe("Stripe checkout return", () => {
  // Regression: the API bakes `/billing?checkout=success` into every checkout
  // session, but the console had no `/billing` route, so the post-payment
  // redirect rendered "Page not found". The /billing route now validates this
  // search param and forwards onto the account page.
  test("recognizes the success and cancelled outcomes Stripe redirects with", () => {
    expect(parseCheckoutOutcome({ checkout: "success" })).toBe("success");
    expect(parseCheckoutOutcome({ checkout: "cancelled" })).toBe("cancelled");
  });

  test("drops unknown or absent outcomes so no stray confirmation renders", () => {
    expect(parseCheckoutOutcome({ checkout: "bogus" })).toBeUndefined();
    expect(parseCheckoutOutcome({})).toBeUndefined();
    expect(parseCheckoutOutcome({ checkout: "" })).toBeUndefined();
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

describe("session MCP permission groups", () => {
  // The session create form reuses the API key dialog's grouped picker idiom
  // for firstPartyMcpPermissions, minus account-level scopes a workspace
  // session can never exercise.
  test("offers only contracts permissions, each exactly once", () => {
    const offered = buildSessionMcpPermissionGroups().flatMap((group) => group.permissions);
    expect(offered.length).toBe(new Set(offered).size);
    for (const permission of offered) {
      expect([...Permission.options] as string[]).toContain(permission);
    }
  });

  test("excludes account-only scopes but keeps workspace scopes", () => {
    const offered: string[] = buildSessionMcpPermissionGroups().flatMap((group) => group.permissions);
    for (const accountScope of ["account:read", "account:admin", "members:manage", "billing:read", "billing:manage", "workspace:create"]) {
      expect(offered).not.toContain(accountScope);
    }
    for (const workspaceScope of ["sessions:create", "goals:manage", "environments:use", "workspace:admin"]) {
      expect(offered).toContain(workspaceScope);
    }
  });
});

describe("advanced session create draft", () => {
  test("an untouched draft adds nothing to the create payload", () => {
    expect(submissionExtrasFromAdvancedSessionDraft(emptyAdvancedSessionDraft())).toEqual({});
  });

  test("maps sandbox, environment, goal, and MCP scope into the payload", () => {
    const draft = {
      ...emptyAdvancedSessionDraft(),
      sandboxBackend: "docker" as const,
      environmentId: "env-1",
      goalText: "  Keep CI green  ",
      goalSuccessCriteria: "All checks pass for 7 days",
      goalMaxAutoContinuations: "12",
      customMcpPermissions: true,
      mcpPermissions: new Set(["sessions:read", "goals:manage"]),
    };
    expect(submissionExtrasFromAdvancedSessionDraft(draft)).toEqual({
      sandboxBackend: "docker",
      environmentId: "env-1",
      goal: {
        text: "Keep CI green",
        successCriteria: "All checks pass for 7 days",
        maxAutoContinuations: 12,
      },
      firstPartyMcpPermissions: ["sessions:read", "goals:manage"],
    });
  });

  test("ignores goal sub-fields without goal text and bad numbers", () => {
    const draft = {
      ...emptyAdvancedSessionDraft(),
      goalSuccessCriteria: "criteria without a goal",
      goalMaxAutoContinuations: "-3",
    };
    expect(submissionExtrasFromAdvancedSessionDraft(draft)).toEqual({});
    const withGoal = { ...draft, goalText: "goal", goalMaxAutoContinuations: "not-a-number" };
    expect(submissionExtrasFromAdvancedSessionDraft(withGoal)).toEqual({ goal: { text: "goal", successCriteria: "criteria without a goal" } });
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
    const items = projectSessionTimeline(session({ status: "cancelled" }), [
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

  test("treats failed sessions as live: failure payloads stay visible for the revival flow", () => {
    // Failed sessions are revivable by sending a new message, so the timeline
    // must keep behaving like an active session (no archived placeholders).
    const items = projectSessionTimeline(session({ status: "failed" }), [
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.failed", { error: "Last turn failed" }),
    ]);

    expect(JSON.stringify(items)).toContain("Last turn failed");
    expect(JSON.stringify(items)).not.toContain("Historical failure payload hidden in the web console.");
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

describe("summarizeSessionFailure", () => {
  test("reports the latest failure reason and the re-dispatch history", () => {
    const summary = summarizeSessionFailure([
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.preempted", { turnId: "turn-1" }),
      event(3, "turn.failed", { error: "First failure" }),
      event(4, "turn.preempted", { turnId: "turn-2" }),
      event(5, "turn.failed", { error: "Provider exploded" }),
    ], "failed");

    expect(summary.reason).toBe("Provider exploded");
    expect(summary.failedAt).toBe(event(5, "turn.failed", {}).occurredAt);
    expect(summary.redispatchCount).toBe(2);
    expect(summary.failedTurnCount).toBe(2);
  });

  test("redacts provider-internal failure reasons like the timeline does", () => {
    const summary = summarizeSessionFailure([
      event(1, "turn.failed", {
        error: "/modal.client.ModalClient/ContainerFilesystemExec RESOURCE_EXHAUSTED",
      }),
    ], "failed");

    expect(summary.reason).not.toContain("RESOURCE_EXHAUSTED");
    expect(summary.reason).toContain("Sandbox setup failed");
  });

  test("reports nothing for a clean session", () => {
    expect(summarizeSessionFailure([event(1, "user.message", { text: "hi" })], "failed")).toEqual({
      reason: null,
      failedAt: null,
      redispatchCount: 0,
      failedTurnCount: 0,
    });
  });
});

describe("buildTools", () => {
  test("adds a selected MCP tool once", () => {
    expect(buildTools(undefined, ["opengeni"])).toEqual([{ kind: "mcp", id: "opengeni" }]);
    expect(buildTools([{ kind: "mcp", id: "opengeni" }], ["opengeni"])).toEqual([{ kind: "mcp", id: "opengeni" }]);
  });

  test("pulls in the file download helper whenever document search is selected", () => {
    expect(buildTools(undefined, ["docs"])).toEqual([{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "files" }]);
    expect(buildTools([{ kind: "mcp", id: "docs" }], ["docs"])).toEqual([{ kind: "mcp", id: "docs" }, { kind: "mcp", id: "files" }]);
    expect(buildTools([{ kind: "mcp", id: "files" }], ["docs"])).toEqual([{ kind: "mcp", id: "files" }, { kind: "mcp", id: "docs" }]);
  });

  test("preserves existing tools when nothing is selected", () => {
    expect(buildTools([{ kind: "mcp", id: "custom" }], [])).toEqual([{ kind: "mcp", id: "custom" }]);
  });

  test("combines OpenGeni with document tools", () => {
    expect(buildTools(undefined, ["opengeni", "docs"])).toEqual([
      { kind: "mcp", id: "opengeni" },
      { kind: "mcp", id: "docs" },
      { kind: "mcp", id: "files" },
    ]);
  });

  test("adds selected MCP tools once", () => {
    expect(buildTools([{ kind: "mcp", id: "custom" }], ["custom", "search"])).toEqual([
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

describe("scheduled task run summaries", () => {
  test("summarizes the most recent run with honest tones", () => {
    const summary = summarizeLastRun([
      taskRun({ id: "run-1", firedAt: "2026-06-10T08:00:00.000Z", status: "dispatched" }),
      taskRun({ id: "run-2", firedAt: "2026-06-11T08:00:00.000Z", status: "failed", error: "no capacity" }),
    ]);
    expect(summary?.run.id).toBe("run-2");
    expect(summary?.tone).toBe("failed");
    expect(summary?.label).toContain("no capacity");
  });

  test("returns null with no runs and pending tone for queued runs", () => {
    expect(summarizeLastRun([])).toBeNull();
    expect(summarizeLastRun([taskRun({ status: "queued" })])?.tone).toBe("pending");
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
    }), "cancelled");

    expect(JSON.stringify(sanitized.payload)).not.toContain("RESOURCE_EXHAUSTED");
    expect(sanitized.payload).toEqual({
      archived: true,
      status: "cancelled",
      message: "Historical failure payload hidden in the web console.",
    });
  });

  test("keeps active failure payloads available for current-run debugging", () => {
    const active = sanitizeEventForDisplay(event(7, "turn.failed", {
      error: "Current run failed",
    }), "running");

    expect(active.payload).toEqual({ error: "Current run failed" });
  });

  test("keeps failed-session failure payloads available: failed sessions are revivable, not archived", () => {
    const active = sanitizeEventForDisplay(event(7, "turn.failed", {
      error: "Last turn failed",
    }), "failed");

    expect(active.payload).toEqual({ error: "Last turn failed" });
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
    createIdempotencyKey: null,
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

function taskRun(patch: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return {
    id: "run-1",
    accountId: "account-1",
    workspaceId: "workspace-1",
    taskId: "task-1",
    status: "dispatched",
    triggerType: "scheduled",
    scheduledAt: null,
    firedAt: "2026-06-11T08:00:00.000Z",
    sessionId: null,
    triggerEventId: null,
    error: null,
    createdAt: "2026-06-11T08:00:00.000Z",
    updatedAt: "2026-06-11T08:00:00.000Z",
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

describe("listViewState", () => {
  test("a failed load renders as error, never as the empty state", () => {
    expect(listViewState({ loading: false, error: new Error("boom"), count: 0 })).toBe("error");
  });

  test("the error wins over a concurrent load so retries stay honest", () => {
    expect(listViewState({ loading: true, error: new Error("boom"), count: 0 })).toBe("error");
  });

  test("data already on screen keeps rendering through a refresh failure", () => {
    expect(listViewState({ loading: false, error: new Error("boom"), count: 3 })).toBe("ready");
  });

  test("initial load and true emptiness keep their states", () => {
    expect(listViewState({ loading: true, error: null, count: 0 })).toBe("loading");
    expect(listViewState({ loading: false, error: null, count: 0 })).toBe("empty");
  });
});

describe("entitlement formatting", () => {
  test("booleans read as enabled/disabled and arrays join", () => {
    expect(formatEntitlementValue(true)).toBe("enabled");
    expect(formatEntitlementValue(false)).toBe("disabled");
    expect(formatEntitlementValue(["gpt-5.5", "o4"])).toBe("gpt-5.5, o4");
    expect(formatEntitlementValue([])).toBe("none");
    expect(formatEntitlementValue(25)).toBe("25");
  });

  test("entries sort by name for a stable render", () => {
    expect(entitlementEntries({ "sessions.max": 10, "models.allowed": ["gpt-5.5"], "packs.custom": true })).toEqual([
      { name: "models.allowed", value: "gpt-5.5" },
      { name: "packs.custom", value: "enabled" },
      { name: "sessions.max", value: "10" },
    ]);
  });
});

describe("workspace switcher helpers", () => {
  function accessContext(patch: Partial<AccessContext> = {}): AccessContext {
    return {
      mode: "managed",
      subjectId: "subject-1",
      accountGrants: [],
      workspaceGrants: [],
      defaultAccountId: null,
      defaultWorkspaceId: null,
      ...patch,
    };
  }

  test("prefers the active workspace's account when it can create there", () => {
    const context = accessContext({
      defaultAccountId: "account-default",
      accountGrants: [
        { accountId: "account-default", subjectId: "subject-1", permissions: ["workspace:create"] },
        { accountId: "account-active", subjectId: "subject-1", permissions: ["account:admin"] },
      ],
    });
    expect(workspaceCreationAccountId(context, "account-active")).toBe("account-active");
  });

  test("falls back to the default account, then any creatable grant", () => {
    const context = accessContext({
      defaultAccountId: "account-default",
      accountGrants: [{ accountId: "account-default", subjectId: "subject-1", permissions: ["workspace:create"] }],
    });
    expect(workspaceCreationAccountId(context, "account-other")).toBe("account-default");

    const indirect = accessContext({
      accountGrants: [{ accountId: "account-3", subjectId: "subject-1", permissions: ["workspace:create"] }],
    });
    expect(workspaceCreationAccountId(indirect, null)).toBe("account-3");
  });

  test("returns null when no account grant can create — the affordance hides", () => {
    const context = accessContext({
      defaultAccountId: "account-default",
      accountGrants: [{ accountId: "account-default", subjectId: "subject-1", permissions: ["billing:read"] }],
    });
    expect(workspaceCreationAccountId(context, null)).toBeNull();
  });

  test("upsertWorkspace replaces renamed workspaces and appends created ones", () => {
    const existing = workspaceFixture({ id: "workspace-1", name: "old" });
    const renamed = workspaceFixture({ id: "workspace-1", name: "new" });
    const created = workspaceFixture({ id: "workspace-2", name: "second" });
    expect(upsertWorkspace([existing], renamed).map((workspace) => workspace.name)).toEqual(["new"]);
    expect(upsertWorkspace([existing], created).map((workspace) => workspace.id)).toEqual(["workspace-1", "workspace-2"]);
  });

  function workspaceFixture(patch: Partial<Workspace> & Pick<Workspace, "id" | "name">): Workspace {
    return {
      accountId: "account-1",
      slug: null,
      externalSource: null,
      externalId: null,
      agentInstructions: null,
      createdAt: "2026-06-11T08:00:00.000Z",
      updatedAt: "2026-06-11T08:00:00.000Z",
      ...patch,
    };
  }
});
