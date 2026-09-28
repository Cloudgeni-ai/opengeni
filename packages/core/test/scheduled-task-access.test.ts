import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type AccessGrant,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import { GOOGLE_DRIVE_PUBLICATION_SERVER_ID } from "@opengeni/contracts/google-drive";
import { testSettings } from "@opengeni/testing";
import type { AccessGrantAuthorization } from "../src/access";
import {
  isScheduledTaskAccessRefreshHuman,
  planScheduledTaskConnectionAccounts,
  planScheduledTaskConnectors,
  planScheduledTaskOpenGeniTools,
  scheduledTaskAccessSource,
  scheduledTaskAttentionScope,
  scheduledTaskPolicyDriftHasChanges,
  scheduledTaskRunAccessFailures,
} from "../src/domain/scheduled-task-access";

const names = new Map([
  ["linear", "Linear"],
  ["gmail", "Gmail"],
  ["notion", "Notion"],
  ["slack", "Slack"],
]);

describe("scheduled task connector drift", () => {
  test("adds the workspace defaults a new schedule gets and names them", () => {
    const plan = planScheduledTaskConnectors({
      taskTools: [{ kind: "mcp", id: "linear" }],
      defaultTools: [
        { kind: "mcp", id: "linear", optional: true },
        { kind: "mcp", id: "gmail", optional: true },
        { kind: "mcp", id: "opengeni", optional: true },
      ],
      availableServerIds: new Set(["linear", "gmail", "opengeni"]),
      names,
    });
    expect(plan.missing).toEqual([{ id: "gmail", name: "Gmail" }]);
    expect(plan.unavailable).toEqual([]);
    // The task's own strict choice stays strict; the added default stays optional.
    expect(plan.tools).toEqual([
      { kind: "mcp", id: "linear" },
      { kind: "mcp", id: "gmail", optional: true },
    ]);
  });

  test("drops only connectors the workspace no longer sets up and never removes a kept one", () => {
    const plan = planScheduledTaskConnectors({
      taskTools: [
        { kind: "mcp", id: "linear" },
        { kind: "mcp", id: "retired-crm" },
        { kind: "mcp", id: "opengeni" },
      ],
      defaultTools: [],
      availableServerIds: new Set(["linear"]),
      names,
    });
    expect(plan.unavailable).toEqual([{ id: "retired-crm", name: "retired-crm" }]);
    expect(plan.missing).toEqual([]);
    expect(plan.tools).toEqual([
      { kind: "mcp", id: "linear" },
      { kind: "mcp", id: "opengeni" },
    ]);
  });
});

describe("scheduled task connector accounts", () => {
  const binding = (canonicalServerId: string, connectionId: string) => ({
    canonicalServerId,
    connectionId,
  });

  test("keeps usable chosen accounts exactly", () => {
    const plan = planScheduledTaskConnectionAccounts({
      priorSelections: [{ serverId: "linear", connectionId: "c-1" }],
      selectionsFrozen: true,
      priorToolIds: new Set(["linear"]),
      connectionServerIds: ["linear"],
      availableBindings: [binding("linear", "c-1"), binding("linear", "c-2")],
      names,
    });
    expect(plan).toEqual({
      selections: [{ serverId: "linear", connectionId: "c-1" }],
      unavailable: [],
      attachable: [],
    });
  });

  test("replaces a chosen account that can no longer be used and reports it", () => {
    const plan = planScheduledTaskConnectionAccounts({
      priorSelections: [{ serverId: "slack", connectionId: "revoked" }],
      selectionsFrozen: true,
      priorToolIds: new Set(["slack"]),
      connectionServerIds: ["slack"],
      availableBindings: [binding("slack", "reconnected")],
      names,
    });
    expect(plan.unavailable).toEqual([{ id: "slack", name: "Slack" }]);
    expect(plan.selections).toEqual([{ serverId: "slack", connectionId: "reconnected" }]);
  });

  test("keeps the remaining chosen account when only one of two is gone", () => {
    const plan = planScheduledTaskConnectionAccounts({
      priorSelections: [
        { serverId: "gmail", connectionId: "work" },
        { serverId: "gmail", connectionId: "gone" },
      ],
      selectionsFrozen: true,
      priorToolIds: new Set(["gmail"]),
      connectionServerIds: ["gmail"],
      availableBindings: [binding("gmail", "work"), binding("gmail", "personal")],
      names,
    });
    expect(plan.unavailable).toEqual([{ id: "gmail", name: "Gmail" }]);
    expect(plan.selections).toEqual([{ serverId: "gmail", connectionId: "work" }]);
  });

  test("offers an account for a frozen connector that had none, and attaches new connectors silently", () => {
    const plan = planScheduledTaskConnectionAccounts({
      priorSelections: [],
      selectionsFrozen: true,
      priorToolIds: new Set(["slack"]),
      connectionServerIds: ["slack", "gmail"],
      availableBindings: [binding("slack", "s-1"), binding("gmail", "g-1")],
      names,
    });
    expect(plan.attachable).toEqual([{ id: "slack", name: "Slack" }]);
    expect(plan.selections).toEqual([
      { serverId: "slack", connectionId: "s-1" },
      { serverId: "gmail", connectionId: "g-1" },
    ]);
  });

  test("a legacy unfrozen task already binds every account, so nothing is attachable", () => {
    const plan = planScheduledTaskConnectionAccounts({
      priorSelections: [],
      selectionsFrozen: false,
      priorToolIds: new Set(["slack"]),
      connectionServerIds: ["slack"],
      availableBindings: [binding("slack", "s-1")],
      names,
    });
    expect(plan.attachable).toEqual([]);
    expect(plan.selections).toEqual([{ serverId: "slack", connectionId: "s-1" }]);
  });

  test("passes special surfaces through and drops choices for connectors the task no longer uses", () => {
    const plan = planScheduledTaskConnectionAccounts({
      priorSelections: [
        { serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID, connectionId: "drive" },
        { serverId: "retired-crm", connectionId: "crm" },
      ],
      selectionsFrozen: true,
      priorToolIds: new Set(["retired-crm"]),
      connectionServerIds: [],
      availableBindings: [],
      names,
    });
    expect(plan.selections).toEqual([
      { serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID, connectionId: "drive" },
    ]);
  });
});

describe("agent-created task OpenGeni tools (migration 0428 creator policy)", () => {
  const settings = testSettings({
    defaultFirstPartyMcpTools: ["sessions_list", "rig_list", "browser_read"],
  });
  // The API passes its MCP registration table; this mirrors those three rows.
  const requirements: Partial<Record<FirstPartyMcpToolName, Permission[]>> = {
    sessions_list: ["sessions:read"],
    rig_list: ["rigs:use"],
    browser_read: ["sessions:read"],
  };
  const permissionsRequiredByTools = (tools: readonly FirstPartyMcpToolName[]) =>
    tools.flatMap((tool) => requirements[tool] ?? []);

  test("a human-created task has no frozen policy and nothing to refresh", () => {
    expect(
      planScheduledTaskOpenGeniTools({
        creatorPolicy: { firstPartyMcpTools: null, firstPartyMcpPermissions: null },
        settings,
        grantPermissions: ["workspace:admin"],
        permissionsRequiredByTools,
      }),
    ).toEqual({ missing: [], policy: null });
  });

  test("names the newer default tools and adds only what they need, within the person's grant", () => {
    const frozenPermissions = ["sessions:read", "secrets:read"] as Permission[];
    const personHolds: Permission[] = ["sessions:read", "files:read", "rigs:use"];
    const plan = planScheduledTaskOpenGeniTools({
      creatorPolicy: {
        firstPartyMcpTools: ["sessions_list"] as FirstPartyMcpToolName[],
        firstPartyMcpPermissions: frozenPermissions,
      },
      settings,
      grantPermissions: personHolds,
      permissionsRequiredByTools,
    });
    expect(plan.missing).toEqual(["rig_list", "browser_read"]);
    expect(plan.policy?.firstPartyMcpTools).toEqual(["sessions_list", "rig_list", "browser_read"]);
    // A frozen permission the person lacks is dropped; rig_list's rigs:use is
    // added; files:read is held by the person but no added tool needs it.
    expect(plan.policy?.firstPartyMcpPermissions).toEqual(["sessions:read", "rigs:use"]);
  });

  test("a tool's permission the person does not hold is not added", () => {
    const plan = planScheduledTaskOpenGeniTools({
      creatorPolicy: {
        firstPartyMcpTools: ["sessions_list"] as FirstPartyMcpToolName[],
        firstPartyMcpPermissions: ["sessions:read"],
      },
      settings,
      grantPermissions: ["sessions:read"],
      permissionsRequiredByTools,
    });
    expect(plan.missing).toEqual(["rig_list", "browser_read"]);
    expect(plan.policy?.firstPartyMcpPermissions).toEqual(["sessions:read"]);
  });

  test("a narrowed permission boundary is never lifted when no tool is added", () => {
    // An operator-narrowed session (read-only here) created the task. The
    // refreshing person holds everything, but the refresh adds no tool, so it
    // must not hand the schedule the rest of the default worker set.
    expect(
      planScheduledTaskOpenGeniTools({
        creatorPolicy: {
          firstPartyMcpTools: ["sessions_list", "rig_list", "browser_read"],
          firstPartyMcpPermissions: ["sessions:read"],
        },
        settings,
        grantPermissions: ["workspace:admin"],
        permissionsRequiredByTools,
      }),
    ).toEqual({ missing: [], policy: null });
  });

  test("an up-to-date policy the person fully holds is left alone", () => {
    const tools = ["sessions_list", "rig_list", "browser_read"] as FirstPartyMcpToolName[];
    const permissions = [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS] as Permission[];
    expect(
      planScheduledTaskOpenGeniTools({
        creatorPolicy: { firstPartyMcpTools: tools, firstPartyMcpPermissions: permissions },
        settings,
        grantPermissions: ["workspace:admin"],
        permissionsRequiredByTools,
      }),
    ).toEqual({ missing: [], policy: null });
  });
});

describe("scheduled run access failures", () => {
  test("folds a run's auth-needed facts per connector and reason, leaving setup suggestions out", () => {
    const failures = scheduledTaskRunAccessFailures(
      [
        {
          occurredAt: "2026-09-17T08:00:10.000Z",
          payload: {
            serverId: "slack__acct",
            canonicalServerId: "slack",
            providerDomain: "slack.com",
            reason: "personal_authority_unavailable",
            toolName: "slack_send_message",
          },
        },
        {
          occurredAt: "2026-09-17T08:00:05.000Z",
          payload: {
            serverId: "slack",
            providerDomain: "slack.com",
            reason: "personal_authority_unavailable",
          },
        },
        {
          occurredAt: "2026-09-17T08:00:20.000Z",
          payload: { serverId: "crm", providerDomain: "crm.example.com", reason: "expired" },
        },
        {
          occurredAt: "2026-09-17T08:00:30.000Z",
          payload: {
            serverId: "linear",
            providerDomain: "linear.app",
            reason: "missing_connection",
            capability: { id: "linear", action: "connect" },
          },
        },
        { occurredAt: "2026-09-17T08:00:40.000Z", payload: { malformed: true } },
      ],
      names,
    );
    expect(failures).toEqual([
      {
        serverId: "slack",
        name: "Slack",
        providerDomain: "slack.com",
        reason: "personal_authority_unavailable",
        count: 2,
        firstOccurredAt: "2026-09-17T08:00:05.000Z",
      },
      {
        serverId: "crm",
        name: "crm.example.com",
        providerDomain: "crm.example.com",
        reason: "expired",
        count: 1,
        firstOccurredAt: "2026-09-17T08:00:20.000Z",
      },
    ]);
  });
});

describe("who sees and refreshes scheduled task access", () => {
  const workspaceId = crypto.randomUUID();
  const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
    accountId: crypto.randomUUID(),
    workspaceId,
    subjectId: "user:owner",
    principalKind: "human_session",
    permissions: ["scheduled_tasks:manage", "scheduled_tasks:run"],
    ...overrides,
  });
  const authorization = (
    overrides: Partial<AccessGrantAuthorization> = {},
    grantOverrides: Partial<AccessGrant> = {},
  ): AccessGrantAuthorization => ({
    grant: grant(grantOverrides),
    accountGrant: null,
    authenticatedSubjectId: grantOverrides.subjectId ?? "user:owner",
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
    canonicalLocalHumanSession: false,
    ...overrides,
  });

  test("the owner sees its own task; another member, an agent or a delegated bearer does not", () => {
    const task = { ownerSubjectId: "user:owner" };
    expect(scheduledTaskAccessSource(task, grant())).toEqual({
      kind: "subject",
      subjectId: "user:owner",
      accountId: expect.any(String),
    });
    expect(scheduledTaskAccessSource(task, grant({ subjectId: "user:other" }))).toBeNull();
    expect(scheduledTaskAccessSource(task, grant({ principalKind: "agent_attempt" }))).toBeNull();
    expect(scheduledTaskAccessSource(task, grant({ metadata: { delegated: true } }))).toBeNull();
  });

  test("a task without an owner is visible to people who manage schedules", () => {
    const task = { ownerSubjectId: null };
    expect(scheduledTaskAccessSource(task, grant())).toEqual({ kind: "none" });
    expect(
      scheduledTaskAccessSource(task, grant({ permissions: ["scheduled_tasks:run"] })),
    ).toBeNull();
  });

  test("only a signed-in person may refresh, by provenance rather than grant shape", () => {
    expect(isScheduledTaskAccessRefreshHuman(authorization(), workspaceId)).toBe(true);
    expect(
      isScheduledTaskAccessRefreshHuman(
        authorization({ canonicalManagedHumanSession: false }),
        workspaceId,
      ),
    ).toBe(false);
    expect(
      isScheduledTaskAccessRefreshHuman(
        authorization({ canonicalManagedHumanSession: false }, { principalKind: "api_key" }),
        workspaceId,
      ),
    ).toBe(false);
    expect(
      isScheduledTaskAccessRefreshHuman(
        authorization({}, { metadata: { delegated: true } }),
        workspaceId,
      ),
    ).toBe(false);
    expect(
      isScheduledTaskAccessRefreshHuman(
        authorization({ authenticatedSubjectId: "user:someone-else" }),
        workspaceId,
      ),
    ).toBe(false);
    expect(isScheduledTaskAccessRefreshHuman(authorization(), crypto.randomUUID())).toBe(false);
    expect(
      isScheduledTaskAccessRefreshHuman(
        authorization(
          { canonicalManagedHumanSession: false, canonicalLocalHumanSession: true },
          { subjectId: "dev" },
        ),
        workspaceId,
      ),
    ).toBe(true);
  });

  test("a person is told about their own schedules, never every service schedule", () => {
    expect(scheduledTaskAttentionScope(grant())).toEqual({
      ownerSubjectId: "user:owner",
      includeOwnerless: false,
    });
    expect(
      scheduledTaskAttentionScope(grant({ principalKind: "api_key", subjectId: "api-key:1" })),
    ).toEqual({ ownerSubjectId: "api-key:1", includeOwnerless: true });
    expect(
      scheduledTaskAttentionScope(
        grant({ principalKind: "api_key", permissions: ["scheduled_tasks:run"] }),
      ),
    ).toEqual({ ownerSubjectId: "user:owner", includeOwnerless: false });
    expect(scheduledTaskAttentionScope(grant({ principalKind: "agent_attempt" }))).toBeNull();
    expect(scheduledTaskAttentionScope(grant({ metadata: { delegated: true } }))).toBeNull();
  });

  test("an empty report is not drift", () => {
    expect(
      scheduledTaskPolicyDriftHasChanges({
        missingConnectors: [],
        unavailableConnectors: [],
        missingOpenGeniTools: [],
        unavailableAccounts: [],
        attachableAccounts: [],
      }),
    ).toBe(false);
  });
});
