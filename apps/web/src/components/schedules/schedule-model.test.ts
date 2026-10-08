import { describe, expect, test } from "bun:test";

import type { ScheduledTask } from "@/types";
import { formStateFromScheduledTask } from "@/lib/scheduled-tasks";
import {
  selectedConnectionAccounts,
  type ConnectedAccountGroup,
} from "@/components/capabilities/session-connection-accounts";

import {
  SCHEDULE_FREQUENCIES,
  cadenceOfSchedule,
  createRequestFromDraft,
  deriveScheduleName,
  mergeScheduleConnectionAccounts,
  newScheduleDraft,
  nextRunOf,
  scheduleAgentOpeningMessage,
  scheduleErrorText,
  scheduleInheritsChatSettings,
  scheduleConnectionAccountIntent,
  scheduleWords,
  sortSchedulesForList,
  specFromCadence,
  updateRequestFromDraft,
  type ScheduleDraft,
} from "./schedule-model";

// Sunday 27 Sep 2026, 12:00 UTC.
const NOW = new Date("2026-09-27T12:00:00.000Z");

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    accountId: "00000000-0000-4000-8000-0000000000aa",
    workspaceId: "00000000-0000-4000-8000-0000000000bb",
    name: "Check AWS cost anomalies",
    ownerSubjectId: "dev",
    status: "active",
    schedule: { type: "calendar", timeZone: "Europe/Oslo", hour: 8, minute: 0 },
    temporalScheduleId: "t",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    action: { kind: "agent_turn" },
    agentConfig: { prompt: "Compare spend.", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "subject", subjectId: "dev" },
    createdByContext: {},
    authorityRevision: 1,
    executionDigest: "0".repeat(64),
    reusableSessionId: null,
    targetSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  } as ScheduledTask;
}

describe("schedule cadence", () => {
  test("never offers monthly: the API can't store a day of the month", () => {
    expect(SCHEDULE_FREQUENCIES).not.toContain("monthly");
  });

  test("a new schedule defaults to every weekday at 09:00 in the viewer's zone", () => {
    const draft = newScheduleDraft({ includeOpenGeniTool: false }, "Europe/Oslo");
    expect(draft.cadence).toEqual({
      timeZone: "Europe/Oslo",
      rule: { frequency: "weekdays", time: "09:00" },
    });
    expect(specFromCadence(draft.cadence!, NOW)).toEqual({
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 9,
      minute: 0,
      daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    });
  });

  test("describes stored specs in words, including 30-day intervals and on-demand", () => {
    expect(scheduleWords(task().schedule, NOW).short).toBe("Every day at 08:00 · Oslo");
    expect(scheduleWords({ type: "interval", everySeconds: 2_592_000 }, NOW).short).toBe(
      "Every 30 days",
    );
    expect(scheduleWords({ type: "manual" }, NOW).short).toBe("Only when you run it");
    expect(cadenceOfSchedule({ type: "manual" })).toBeNull();
  });

  test("paused and on-demand schedules have no next run", () => {
    expect(nextRunOf(task(), NOW)?.toISOString()).toBe("2026-09-28T06:00:00.000Z");
    expect(nextRunOf(task({ status: "paused" }), NOW)).toBeNull();
    expect(nextRunOf(task({ schedule: { type: "manual" } }), NOW)).toBeNull();
  });

  test("lists active schedules by next run, then the rest by name", () => {
    const hourly = task({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Hourly",
      schedule: { type: "interval", everySeconds: 3_600 },
    });
    const paused = task({
      id: "00000000-0000-4000-8000-000000000003",
      name: "A paused one",
      status: "paused",
    });
    const daily = task();
    expect(sortSchedulesForList([paused, daily, hourly], NOW).map((each) => each.name)).toEqual([
      "Hourly",
      "Check AWS cost anomalies",
      "A paused one",
    ]);
  });
});

describe("schedule names", () => {
  test("derives a name from the first sentence without the cadence prefix", () => {
    expect(deriveScheduleName("Every weekday at 08:00: summarize open incidents. Then stop.")).toBe(
      "Summarize open incidents",
    );
    const long = deriveScheduleName(
      "Look at Sentry issues first seen in the last hour for the web and api projects and group them",
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("schedule requests", () => {
  const base = (): ScheduleDraft => ({
    ...newScheduleDraft({ includeOpenGeniTool: false }, "Europe/Oslo"),
    prompt: "Summarize open incidents.",
  });

  test("a new-chat schedule is created with the default overlap and its attachments", () => {
    const request = createRequestFromDraft(
      { ...base(), overlapPolicy: "skip", variableSetId: "vs-1", rigId: "rig-1" },
      { now: NOW, learningScope: "workspace" },
    );
    expect(request.overlapPolicy).toBe("allow_concurrent");
    if (!("agentConfig" in request)) throw new Error("Expected a separate agent");
    expect(request.variableSetId).toBe("vs-1");
    expect(request.rigId).toBe("rig-1");
    expect(request.name).toBe("Summarize open incidents");
    expect(request.metadata).toEqual({});
  });

  test("an ongoing chat keeps Skip", () => {
    const request = createRequestFromDraft(
      { ...base(), runMode: "reusable_session", overlapPolicy: "skip" },
      { now: NOW, learningScope: "workspace" },
    );
    expect(request.overlapPolicy).toBe("skip");
  });

  test("an existing-chat message carries no copied execution settings", () => {
    const request = createRequestFromDraft(
      {
        ...base(),
        runMode: "existing_session",
        targetSessionId: "00000000-0000-4000-8000-000000000099",
        variableSetId: "stale-set",
        rigId: "stale-environment",
      },
      { now: NOW, learningScope: "workspace" },
    );
    expect(request).toMatchObject({
      targetSessionId: "00000000-0000-4000-8000-000000000099",
      prompt: "Summarize open incidents.",
    });
    expect("agentConfig" in request).toBe(false);
    expect("variableSetId" in request).toBe(false);
    expect("rigId" in request).toBe(false);
  });

  test("moving a schedule sends only its new destination and changed message", () => {
    const initial = base();
    const stored = task();
    const request = updateRequestFromDraft(
      stored,
      initial,
      {
        ...initial,
        runMode: "existing_session",
        targetSessionId: "destination",
        prompt: "Review urgent incidents.",
      },
      { now: NOW },
    );
    expect(request).toEqual({
      expectedExecutionDigest: stored.executionDigest,
      runMode: "existing_session",
      targetSessionId: "destination",
      prompt: "Review urgent incidents.",
      name: "Review urgent incidents",
    });
  });

  test("an edit sends the schedule and attachments only when they changed", () => {
    const initial: ScheduleDraft = { ...base(), variableSetId: "vs-1", rigId: null };
    const untouched = updateRequestFromDraft(
      task(),
      initial,
      { ...initial, name: "Renamed" },
      {
        now: NOW,
      },
    );
    expect(untouched.name).toBe("Renamed");
    expect("schedule" in untouched).toBe(false);
    expect("variableSetId" in untouched).toBe(false);
    expect("rigId" in untouched).toBe(false);

    const changed = updateRequestFromDraft(
      task(),
      initial,
      {
        ...initial,
        variableSetId: null,
        rigId: "rig-2",
        cadence: { timeZone: "Europe/Oslo", rule: { frequency: "hourly" } },
      },
      { now: NOW },
    );
    expect(changed.schedule).toEqual({ type: "interval", everySeconds: 3_600 });
    expect(changed.variableSetId).toBeNull();
    expect(changed.rigId).toBe("rig-2");
  });

  test("an edit keeps a stored description it no longer shows", () => {
    const stored = task({ metadata: { scheduleDescription: "Old summary", other: 1 } });
    const initial: ScheduleDraft = { ...base(), description: "Old summary" };
    const request = updateRequestFromDraft(stored, initial, initial, { now: NOW });
    expect(request.metadata).toBeUndefined();
    expect(request).toEqual({ expectedExecutionDigest: stored.executionDigest });
  });

  test("separate-agent message edits preserve hidden settings through a narrow patch", () => {
    const stored = task();
    stored.agentConfig.approvalTimeoutSeconds = 300;
    stored.agentConfig.maxNestedAgentDepth = 0;
    stored.agentConfig.bundledSkillIds = [];
    const initial = { ...base(), name: stored.name };
    const request = updateRequestFromDraft(
      stored,
      initial,
      { ...initial, prompt: "New message" },
      { now: NOW },
    );
    expect(request).toEqual({
      expectedExecutionDigest: stored.executionDigest,
      prompt: "New message",
    });
    const changedTools = updateRequestFromDraft(
      stored,
      initial,
      { ...initial, includeOpenGeniTool: true },
      { now: NOW },
    );
    expect(changedTools.agentConfig).toMatchObject({
      approvalTimeoutSeconds: 300,
      maxNestedAgentDepth: 0,
      bundledSkillIds: [],
    });
    expect(changedTools.agentConfig).not.toHaveProperty("connectionAccountsFrozen");
  });

  test("a model edit retains the existing tools' startup and failure policy", () => {
    const stored = task();
    stored.agentConfig.tools = [
      { kind: "mcp", id: "example", eager: true, optional: true },
      { kind: "mcp", id: "opengeni", eager: true },
    ];
    const initial = {
      ...base(),
      ...formStateFromScheduledTask(stored),
      modelFollowsDefault: false,
    };
    const patch = updateRequestFromDraft(
      stored,
      initial,
      { ...initial, model: "example-model" },
      { now: NOW },
    );
    expect(patch.agentConfig?.tools).toEqual(stored.agentConfig.tools);
  });

  test("unrelated edits retain individually omitted model and reasoning settings", () => {
    for (const policy of [{ reasoningEffort: "high" as const }, { model: "example-model" }]) {
      const stored = task();
      Object.assign(stored.agentConfig, policy);
      const initial = {
        ...base(),
        ...formStateFromScheduledTask(stored, {
          model: "default-model",
          reasoningEffort: "medium",
          modelFollowsDefault: true,
        }),
      };
      const patch = updateRequestFromDraft(
        stored,
        initial,
        { ...initial, includeOpenGeniTool: true },
        { now: NOW },
      );
      expect(patch.agentConfig?.model).toEqual(stored.agentConfig.model);
      expect(patch.agentConfig?.reasoningEffort).toEqual(stored.agentConfig.reasoningEffort);
    }
  });

  test("edits preserve exact message bytes in narrow, full and destination patches", () => {
    const stored = task();
    const initial = { ...base(), ...formStateFromScheduledTask(stored) };
    const prompt = "\n  Keep this indentation.  \n";
    for (const change of [
      {},
      { includeOpenGeniTool: true },
      { runMode: "existing_session" as const, targetSessionId: "destination" },
    ]) {
      const patch = updateRequestFromDraft(
        stored,
        initial,
        { ...initial, ...change, prompt },
        { now: NOW },
      );
      expect(patch.prompt ?? patch.agentConfig?.prompt).toBe(prompt);
    }
  });

  test("a materialized reusable chat ignores hidden settings while keeping message edits", () => {
    const stored = task({ runMode: "reusable_session", reusableSessionId: "existing-chat" });
    const initial = { ...base(), ...formStateFromScheduledTask(stored) };
    const draft = {
      ...initial,
      model: "default-resolved-later",
      includeOpenGeniTool: !initial.includeOpenGeniTool,
      machineSandboxId: "default-machine-loaded-later",
      variableSetId: "unused-set",
      rigId: "unused-environment",
      prompt: "Updated message",
    };
    const agentLearning = {
      scope: "workspace" as const,
      operationId: "operation",
      expectedVersion: 1,
      settings: {},
    };
    expect(scheduleInheritsChatSettings(stored)).toBe(true);
    expect(updateRequestFromDraft(stored, initial, draft, { now: NOW, agentLearning })).toEqual({
      expectedExecutionDigest: stored.executionDigest,
      prompt: "Updated message",
      agentLearning,
    });
    const separate = updateRequestFromDraft(
      stored,
      initial,
      { ...draft, runMode: "new_session_per_run" },
      { now: NOW, agentLearning },
    );
    expect(separate.agentConfig?.model).toBe("default-resolved-later");
    expect(separate.variableSetId).toBe("unused-set");
    expect(separate.rigId).toBe("unused-environment");
    expect(separate.agentLearning).toEqual(agentLearning);
    expect(scheduleInheritsChatSettings({ ...stored, reusableSessionId: null })).toBe(false);
  });

  test("materialized reusable schedules still edit message resources and Slack channel", () => {
    const stored = task({ runMode: "reusable_session", reusableSessionId: "existing-chat" });
    stored.agentConfig.model = "stored-default";
    stored.agentConfig.slackBotConnectionId = "bot";
    stored.agentConfig.slackBotChannelId = "old-channel";
    stored.agentConfig.tools = [{ kind: "mcp", id: "example", optional: true }];
    const initial = { ...base(), ...formStateFromScheduledTask(stored) };
    const resources = [
      { kind: "repository" as const, uri: "https://example.com/example/repo.git", ref: "main" },
    ];
    const patch = updateRequestFromDraft(
      stored,
      initial,
      {
        ...initial,
        resources,
        slackBotChannelId: "new-channel",
        model: "hidden-unapplied-change",
        mcpServerIds: [],
      },
      { now: NOW },
    );
    expect(patch.agentConfig).toEqual({
      ...stored.agentConfig,
      resources,
      slackBotChannelId: "new-channel",
    });
  });

  test("editing one account group retains hidden and first-party choices", () => {
    const saved = [
      { serverId: "example", connectionId: "old-choice" },
      { serverId: "unavailable", connectionId: "retained-choice" },
      { serverId: "github:personal", connectionId: "repository-choice" },
      { serverId: "google-drive-publishing", connectionId: "publication-choice" },
      { serverId: "removed", connectionId: "removed-choice" },
    ];
    const selection = { serverId: "example", connectionId: "new-choice" };
    expect(
      mergeScheduleConnectionAccounts(saved, [selection], ["example"], {
        selectedServerIds: ["example", "unavailable"],
        resources: [
          {
            kind: "repository",
            uri: "https://example.com/example/repo.git",
            ref: "main",
            connectionType: "github_personal",
          },
        ],
      }),
    ).toEqual([saved[1]!, saved[2]!, saved[3]!, selection]);
  });

  test("retargeted and materialized chats retain only accounts their current tools can use", () => {
    for (const runMode of ["existing_session", "reusable_session"] as const) {
      const stored = task({
        runMode,
        targetSessionId: runMode === "existing_session" ? "source-chat" : null,
        reusableSessionId: runMode === "reusable_session" ? "current-chat" : null,
      });
      stored.agentConfig.tools =
        runMode === "existing_session" ? [] : [{ kind: "mcp", id: "old-tool" }];
      const saved = [
        { serverId: "old-tool", connectionId: "old-account" },
        { serverId: "retained-tool", connectionId: "hidden-retained-account" },
      ];
      stored.agentConfig.connectionAccounts = saved;
      const initial = { ...base(), ...formStateFromScheduledTask(stored) };
      const selection = { serverId: "current-tool", connectionId: "chosen-account" };
      const merged = mergeScheduleConnectionAccounts(saved, [selection], ["current-tool"], {
        selectedServerIds: ["current-tool", "retained-tool"],
        resources: [],
        chat: { resources: [], firstPartyMcpTools: [], firstPartyMcpPermissions: [] },
      });
      const patch = updateRequestFromDraft(
        stored,
        initial,
        {
          ...initial,
          ...(runMode === "existing_session" ? { targetSessionId: "destination-chat" } : {}),
          connectionAccounts: merged,
        },
        { now: NOW },
      );
      expect(patch.connectionAccounts).toEqual([saved[1]!, selection]);
    }
  });

  test("retargeting retains only eligible first-party account choices", () => {
    const saved = [
      { serverId: "github:personal", connectionId: "repository-choice" },
      { serverId: "google-drive-publishing", connectionId: "publication-choice" },
    ];
    const destination = {
      selectedServerIds: [],
      resources: [
        {
          kind: "repository" as const,
          uri: "https://example.com/example/repo.git",
          ref: "main",
          connectionType: "github_personal" as const,
        },
      ],
      chat: {
        resources: [],
        firstPartyMcpTools: [
          "editable_artifact_export",
          "editable_artifact_export_status",
        ] as const,
        firstPartyMcpPermissions: ["artifacts:read", "artifacts:publish"],
      },
    };
    expect(
      mergeScheduleConnectionAccounts(saved, [], [], {
        ...destination,
        chat: { ...destination.chat, firstPartyMcpTools: [...destination.chat.firstPartyMcpTools] },
      }),
    ).toEqual(saved);
    expect(
      mergeScheduleConnectionAccounts(saved, [], [], {
        ...destination,
        selectedServerIds: ["github:personal", "google-drive-publishing"],
        resources: [],
        chat: { resources: [], firstPartyMcpTools: [], firstPartyMcpPermissions: [] },
      }),
    ).toEqual([]);
    expect(
      mergeScheduleConnectionAccounts(saved, [], [], {
        ...destination,
        chat: {
          resources: [],
          firstPartyMcpTools: [...destination.chat.firstPartyMcpTools],
          firstPartyMcpPermissions: ["artifacts:read"],
        },
      }),
    ).toEqual([saved[0]!]);
    expect(
      mergeScheduleConnectionAccounts(saved, [], [], {
        ...destination,
        chat: {
          ...destination.chat,
          firstPartyMcpTools: [...destination.chat.firstPartyMcpTools],
          firstPartyMcpPermissions: [],
        },
      }),
    ).toEqual([saved[0]!]);
    expect(
      mergeScheduleConnectionAccounts(saved, [], [], {
        ...destination,
        chat: {
          ...destination.chat,
          firstPartyMcpTools: [...destination.chat.firstPartyMcpTools],
          firstPartyMcpPermissions: null,
        },
      }),
    ).toEqual(saved);
  });

  test("removing the last reusable message repository removes its account during a picker edit", () => {
    const stored = task({ runMode: "reusable_session", reusableSessionId: "current-chat" });
    stored.agentConfig.resources = [
      {
        kind: "repository",
        uri: "https://example.com/example/repo.git",
        ref: "main",
        connectionType: "github_personal",
      },
    ];
    stored.agentConfig.connectionAccounts = [
      { serverId: "github:personal", connectionId: "repository-choice" },
    ];
    const initial = { ...base(), ...formStateFromScheduledTask(stored) };
    const selection = { serverId: "current-tool", connectionId: "chosen-account" };
    const draft = { ...initial, resources: [] };
    draft.connectionAccounts = mergeScheduleConnectionAccounts(
      initial.connectionAccounts ?? [],
      [selection],
      ["current-tool"],
      {
        selectedServerIds: ["current-tool"],
        resources: draft.resources,
        chat: { resources: [], firstPartyMcpTools: [], firstPartyMcpPermissions: [] },
      },
    );
    const patch = updateRequestFromDraft(stored, initial, draft, { now: NOW });
    expect(patch.connectionAccounts).toEqual([selection]);
    expect(patch.agentConfig?.resources).toEqual([]);
  });

  test("bound-chat and preserved message repositories both retain their account during picker edits", () => {
    const repository = {
      kind: "repository" as const,
      uri: "https://example.com/example/repo.git",
      ref: "main",
      connectionType: "github_personal" as const,
    };
    const repositoryAccount = { serverId: "github:personal", connectionId: "repository-choice" };
    const selection = { serverId: "example", connectionId: "new-choice" };
    for (const runMode of ["existing_session", "reusable_session"] as const) {
      for (const repositorySource of ["chat", "message"] as const) {
        const stored = task({
          runMode,
          targetSessionId: runMode === "existing_session" ? "bound-chat" : null,
          reusableSessionId: runMode === "reusable_session" ? "bound-chat" : null,
        });
        stored.agentConfig.connectionAccounts = [repositoryAccount];
        stored.agentConfig.resources = repositorySource === "message" ? [repository] : [];
        const initial = { ...base(), ...formStateFromScheduledTask(stored) };
        const connectionAccounts = mergeScheduleConnectionAccounts(
          initial.connectionAccounts ?? [],
          [selection],
          ["example"],
          {
            selectedServerIds: ["example"],
            resources: initial.resources,
            chat: {
              resources: repositorySource === "chat" ? [repository] : [],
              firstPartyMcpTools: [],
              firstPartyMcpPermissions: [],
            },
          },
        );
        const patch = updateRequestFromDraft(
          stored,
          initial,
          {
            ...initial,
            connectionAccounts,
          },
          { now: NOW },
        );
        expect(patch.connectionAccounts).toEqual([repositoryAccount, selection]);
        expect(patch.agentConfig).toBeUndefined();
      }
    }
  });
});

describe("schedule account edit intent", () => {
  const saved = [{ serverId: "retained", connectionId: "chosen-account" }];
  const groups = [
    {
      serverId: "retained",
      name: "Retained",
      accounts: [{ id: "chosen-account" }, { id: "later-account" }],
    },
    { serverId: "empty", name: "Empty", accounts: [{ id: "not-authorized" }] },
    { serverId: "added", name: "Added", accounts: [{ id: "new-account" }] },
  ] as ConnectedAccountGroup[];
  const input = {
    saved,
    frozen: true,
    initialServerIds: ["retained", "empty"],
    selectedServerIds: ["retained", "empty", "added"],
    editedServerIds: [] as string[],
    destinationChanged: false,
    toolsChanged: false,
  };

  function submission(intent: ReturnType<typeof scheduleConnectionAccountIntent>) {
    const selection = selectedConnectionAccounts(
      groups.filter((group) => intent.changedServerIds.includes(group.serverId)),
      intent.choices,
    );
    expect(selection.unresolved).toEqual([]);
    return mergeScheduleConnectionAccounts(saved, selection.selections, intent.changedServerIds, {
      selectedServerIds: input.selectedServerIds,
      resources: [],
    });
  }

  test("enabling a connector saves its displayed accounts and preserves unrelated saved choices", () => {
    const intent = scheduleConnectionAccountIntent({ ...input, toolsChanged: true });
    expect(intent.choices).toEqual({ retained: ["chosen-account"], empty: [] });
    expect(intent.changedServerIds).toEqual(["added"]);
    const accounts = submission(intent);
    expect(accounts).toEqual([...saved, { serverId: "added", connectionId: "new-account" }]);
    const stored = task();
    stored.agentConfig.tools = [
      { kind: "mcp", id: "retained" },
      { kind: "mcp", id: "empty" },
    ];
    stored.agentConfig.connectionAccounts = saved;
    stored.agentConfig.connectionAccountsFrozen = true;
    const initial = {
      ...newScheduleDraft({ includeOpenGeniTool: false }),
      ...formStateFromScheduledTask(stored),
    };
    const patch = updateRequestFromDraft(
      stored,
      initial,
      {
        ...initial,
        mcpServerIds: input.selectedServerIds,
        connectionAccounts: accounts,
      },
      { now: NOW },
    );
    expect(patch.connectionAccounts).toEqual(accounts);
  });

  test("a destination change captures only newly applicable connector defaults", () => {
    const intent = scheduleConnectionAccountIntent({ ...input, destinationChanged: true });
    expect(intent.changed).toBe(true);
    expect(intent.changedServerIds).toEqual(["added"]);
    expect(submission(intent)).toEqual([
      ...saved,
      { serverId: "added", connectionId: "new-account" },
    ]);
  });

  test("loading a chat with new tools never authorizes its accounts during a message edit", () => {
    const intent = scheduleConnectionAccountIntent(input);
    expect(intent.changed).toBe(false);
    expect(intent.changedServerIds).toEqual([]);
    expect(intent.choices).toEqual({ retained: ["chosen-account"], empty: [], added: [] });
    expect(submission(intent)).toEqual(saved);
  });

  test("an account-only edit cannot default other frozen-empty groups", () => {
    const intent = scheduleConnectionAccountIntent({ ...input, editedServerIds: ["retained"] });
    const selection = selectedConnectionAccounts(
      groups.filter((group) => intent.changedServerIds.includes(group.serverId)),
      { ...intent.choices, retained: ["later-account"] },
    );
    expect(selection.unresolved).toEqual([]);
    expect(
      mergeScheduleConnectionAccounts(saved, selection.selections, intent.changedServerIds, {
        selectedServerIds: input.selectedServerIds,
        resources: [],
      }),
    ).toEqual([{ serverId: "retained", connectionId: "later-account" }]);
  });
});

describe("schedule errors", () => {
  test("drops the API prefix and the request reference", () => {
    expect(
      scheduleErrorText(
        new Error(
          "Opengeni API 422: self-hosted scheduled tasks require a Connected Machine; select a machine before saving Reference: 58f70db6-fcc9-4e4a-8b58-064908f49d53.",
        ),
      ),
    ).toBe(
      "Self-hosted scheduled tasks require a Connected Machine; select a machine before saving.",
    );
  });
});

describe("scheduleAgentOpeningMessage", () => {
  test("carries only the scheduling request and the person's time zone", () => {
    const message = scheduleAgentOpeningMessage(
      "  Every weekday morning, summarize new Sentry errors and post them to #eng \n",
      "Europe/Oslo",
    );
    expect(message).toBe(
      "Help me create a schedule in this workspace.\n\nEvery weekday morning, summarize new Sentry errors and post them to #eng\n\nMy time zone is Europe/Oslo.",
    );
  });
});
