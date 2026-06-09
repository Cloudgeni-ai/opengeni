import { describe, expect, test } from "bun:test";
import {
  agentConfigFromFormState,
  applySessionStatusEvents,
  buildTools,
  formStateFromScheduledTask,
  gitHubRepositoryResource,
  projectConversation,
  sanitizeEventForDisplay,
  scheduleFromFormState,
} from "./App";
import type { GitHubRepository, ResourceRef, ScheduledTask, ScheduledTaskScheduleSpec, Session, SessionEvent } from "./types";

describe("projectConversation", () => {
  test("keeps assistant messages and activity groups in event order", () => {
    const events = [
      event(1, "user.message", { text: "Inspect the repo" }),
      event(2, "turn.started", {}),
      event(3, "agent.message.delta", { text: "I will inspect first." }),
      event(4, "agent.reasoning.delta", { text: "Checking the repository state." }),
      event(5, "agent.toolCall.created", { id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }),
      event(6, "agent.toolCall.output", { id: "call-1", output: "ok" }),
      event(7, "agent.message.delta", { text: "The repo is ready." }),
    ];

    const turns = projectConversation(session(), events);

    expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant", "activity", "assistant"]);
    expect(turns[1]).toMatchObject({ kind: "assistant", text: "I will inspect first.", status: "complete" });
    expect(turns[2]).toMatchObject({ kind: "activity", status: "complete" });
    expect(turns[3]).toMatchObject({ kind: "assistant", text: "The repo is ready.", status: "running" });
  });

  test("renders reasoning summary text", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", { text: "Checking credentials" }),
      event(3, "agent.reasoning.delta", { text: " and repository state." }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(activity).toBeDefined();
    expect(JSON.stringify(activity)).toContain("Reasoning summary");
    expect(JSON.stringify(activity)).toContain("Checking credentials and repository state.");
    expect(JSON.stringify(activity)).not.toContain("Internal reasoning is hidden.");
  });

  test("renders legacy reasoning item payloads safely", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Think" }),
      event(2, "agent.reasoning.delta", {
        item: {
          rawItem: {
            content: [{ type: "input_text", text: "Legacy summary text." }],
          },
        },
      }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(JSON.stringify(activity)).toContain("Legacy summary text.");
    expect(JSON.stringify(activity)).not.toContain("rawItem");
  });

  test("turn completion completes earlier running activity groups", () => {
    const turns = projectConversation(session(), [
      event(1, "user.message", { text: "Check auth" }),
      event(2, "agent.reasoning.delta", { text: "Checking auth." }),
      event(3, "agent.message.completed", { text: "Done." }),
      event(4, "turn.completed", { output: "Done." }),
    ]);

    const activity = turns.find((turn) => turn.kind === "activity");
    expect(activity).toMatchObject({ kind: "activity", status: "complete" });
    expect(JSON.stringify(activity)).not.toContain("running");
  });

  test("keeps per-turn attachments on user messages", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    const turns = projectConversation(session(), [
      event(1, "user.message", {
        text: "Use this file",
        resources: [{ kind: "file", fileId, mountPath: `files/${fileId}` }],
        tools: [{ kind: "mcp", id: "docs" }],
      }),
    ]);

    expect(turns[0]).toMatchObject({
      kind: "user",
      resources: [{ kind: "file", fileId, mountPath: `files/${fileId}` }],
      tools: [{ kind: "mcp", id: "docs" }],
    });
  });

  test("hides archived terminal failure payloads in the main timeline projection", () => {
    const turns = projectConversation(session({ status: "failed" }), [
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.failed", {
        error: "Failed to apply a Modal sandbox manifest: RESOURCE_EXHAUSTED",
      }),
      event(3, "sandbox.operation.failed", {
        error: "/modal.client.ModalClient/SandboxTerminate RESOURCE_EXHAUSTED",
      }),
    ]);

    expect(JSON.stringify(turns)).not.toContain("RESOURCE_EXHAUSTED");
    expect(JSON.stringify(turns)).toContain("Historical failure payload hidden in the web console.");
  });

  test("keeps active failure payloads visible in the main timeline projection", () => {
    const turns = projectConversation(session({ status: "running" }), [
      event(1, "user.message", { text: "Inspect" }),
      event(2, "turn.failed", { error: "Current run failed" }),
    ]);

    expect(JSON.stringify(turns)).toContain("Current run failed");
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

describe("applySessionStatusEvents", () => {
  test("trusts terminal status events without requiring a session refetch", () => {
    const next = applySessionStatusEvents(session(), [
      event(1, "session.status.changed", { status: "idle" }),
    ]);

    expect(next.status).toBe("idle");
    expect(next.activeTurnId).toBeNull();
  });

  test("ignores invalid status payloads", () => {
    const current = session();
    expect(applySessionStatusEvents(current, [
      event(1, "session.status.changed", { status: "done" }),
    ])).toBe(current);
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
