import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import {
  acceptAgentProfileProposal,
  AgentProfileHomeSessionError,
  AgentProfileProposalStateError,
  createAgentProfileProposal,
  dismissAgentProfileProposal,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  listAgentProfileProposals,
  listAgentProfileSessions,
  setAgentProfileHome,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  initializeSessionStartAtomically,
  AgentProfileArchivedError,
  AgentProfileNameConflictError,
  AgentProfileVersionConflictError,
  createAgentProfile,
  createDb,
  createSession,
  getAgentProfile,
  getSession,
  listAgentProfileVersions,
  listAgentProfiles,
  sessionAgentProfileFromProfile,
  setAgentProfileStatus,
  setSessionAgentProfile,
  updateAgentProfile,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const owl = { kind: "emoji" as const, emoji: "🦉", hue: 235 };

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('agent-profiles-account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${account!.id}, 'agent-profiles-workspace', ${admin.json({})}) returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("agent-profiles");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[agent-profiles] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[agent-profiles] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("agent profiles (real PostgreSQL + FORCE RLS)", () => {
  test("creates a profile with its first immutable version", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      role: "PR reviewer",
      avatar: owl,
      config: { model: "gpt-test", agent: { instructions: "Review pull requests." } },
      createdBy: "user:davlet",
    });
    expect(profile).toMatchObject({
      name: "Annie",
      role: "PR reviewer",
      avatar: owl,
      version: 1,
      status: "active",
      createdBy: "user:davlet",
      archivedAt: null,
    });
    const versions = await listAgentProfileVersions(db, workspace.workspaceId, profile.id);
    expect(versions.map((version) => [version.version, version.name])).toEqual([[1, "Annie"]]);
    expect(versions[0]!.config).toEqual(profile.config);
  });

  test("updates append a version, skip no-op edits, and enforce the expected version", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Bugfixer",
      avatar: owl,
      config: {},
    });

    const unchanged = await updateAgentProfile(db, {
      workspaceId: workspace.workspaceId,
      profileId: profile.id,
      expectedVersion: 1,
      name: "Bugfixer",
    });
    expect(unchanged?.version).toBe(1);

    const edited = await updateAgentProfile(db, {
      workspaceId: workspace.workspaceId,
      profileId: profile.id,
      expectedVersion: 1,
      role: "Fixes failing tests",
      config: { reasoningEffort: "high" },
      updatedBy: "user:iuliia",
    });
    expect(edited).toMatchObject({
      version: 2,
      role: "Fixes failing tests",
      updatedBy: "user:iuliia",
    });
    expect(edited?.config).toEqual({ reasoningEffort: "high" });

    await expect(
      updateAgentProfile(db, {
        workspaceId: workspace.workspaceId,
        profileId: profile.id,
        expectedVersion: 1,
        name: "Stale",
      }),
    ).rejects.toBeInstanceOf(AgentProfileVersionConflictError);

    const versions = await listAgentProfileVersions(db, workspace.workspaceId, profile.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[1]!.role).toBeNull();
  });

  test("active names are unique per workspace; archiving frees the name", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await freshWorkspace();
    const first = await createAgentProfile(db, {
      ...workspace,
      name: "Scout",
      avatar: owl,
      config: {},
    });
    await expect(
      createAgentProfile(db, { ...workspace, name: "scout", avatar: owl, config: {} }),
    ).rejects.toBeInstanceOf(AgentProfileNameConflictError);
    await createAgentProfile(db, { ...other, name: "Scout", avatar: owl, config: {} });

    const archived = await setAgentProfileStatus(db, {
      workspaceId: workspace.workspaceId,
      profileId: first.id,
      status: "archived",
    });
    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).not.toBeNull();
    await expect(
      updateAgentProfile(db, {
        workspaceId: workspace.workspaceId,
        profileId: first.id,
        expectedVersion: 1,
        name: "Scout 2",
      }),
    ).rejects.toBeInstanceOf(AgentProfileArchivedError);

    const replacement = await createAgentProfile(db, {
      ...workspace,
      name: "Scout",
      avatar: owl,
      config: {},
    });
    expect((await listAgentProfiles(db, workspace.workspaceId)).map((p) => p.id)).toEqual([
      replacement.id,
    ]);
    expect((await listAgentProfiles(db, workspace.workspaceId, { status: "all" })).length).toBe(2);
    await expect(
      setAgentProfileStatus(db, {
        workspaceId: workspace.workspaceId,
        profileId: first.id,
        status: "active",
      }),
    ).rejects.toBeInstanceOf(AgentProfileNameConflictError);
  });

  test("profiles are invisible across workspaces", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await freshWorkspace();
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: {},
    });
    expect(await getAgentProfile(db, other.workspaceId, profile.id)).toBeNull();
    expect(await listAgentProfiles(db, other.workspaceId)).toEqual([]);
  });

  test("a session wears and clears an agent identity without other changes", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const session = await createSession(db, {
      ...workspace,
      initialMessage: "review",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    expect(session.agentProfile).toBeUndefined();

    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: {},
    });
    const identity = sessionAgentProfileFromProfile(profile);
    expect(
      await setSessionAgentProfile(db, {
        workspaceId: workspace.workspaceId,
        sessionId: session.id,
        agentProfile: identity,
      }),
    ).toBe(true);
    const worn = await getSession(db, workspace.workspaceId, session.id);
    expect(worn?.agentProfile).toEqual({
      profileId: profile.id,
      profileVersion: 1,
      name: "Annie",
      role: null,
      avatar: owl,
    });
    expect(worn?.updatedAt).toBe(session.updatedAt);

    await setSessionAgentProfile(db, {
      workspaceId: workspace.workspaceId,
      sessionId: session.id,
      agentProfile: null,
    });
    expect((await getSession(db, workspace.workspaceId, session.id))?.agentProfile).toBeUndefined();
  });

  test("a session can be created already wearing an identity", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const session = await createSession(db, {
      ...workspace,
      initialMessage: "watch the rollout",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      agentProfile: {
        profileId: null,
        profileVersion: null,
        name: "Deploy watcher",
        role: null,
        avatar: { kind: "icon", icon: "rocket", hue: 260 },
      },
    });
    expect(session.agentProfile?.name).toBe("Deploy watcher");
  });

  test("an agent-created child chat is born wearing a saved agent's identity", async () => {
    if (!available) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "agent-profiles-child",
      accountExternalId: `account-${suffix}`,
      accountName: "Agent profile children",
      workspaceExternalSource: "agent-profiles-child",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Agent profile children",
      subjectId: `user:owner-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const common = {
      accountId: grant.accountId,
      workspaceId,
      resources: [],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
      subjectId: grant.subjectId,
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    };
    const parent = await createSession(db, { ...common, initialMessage: "Fix the flaky test" });
    await initializeSessionStartAtomically(db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: parent.id,
      clientEventId: `initial:${parent.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
      sessionId: parent.id,
      workflowId: `session-${parent.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("parent turn was not claimed");
    const profile = await createAgentProfile(db, {
      accountId: grant.accountId,
      workspaceId,
      name: "Bugfixer",
      avatar: { kind: "emoji", emoji: "🐞", hue: 20 },
      config: {},
    });
    const child = await createSession(db, {
      ...common,
      initialMessage: "Reproduce it",
      parentSessionId: parent.id,
      createdByActor: {
        type: "agent_attempt",
        attemptId,
        sessionId: parent.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
      },
      agentProfile: sessionAgentProfileFromProfile(profile),
    });
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.agentProfile).toMatchObject({ profileId: profile.id, name: "Bugfixer" });
    expect((await getSession(db, workspaceId, child.id))?.agentProfile?.name).toBe("Bugfixer");
  });

  async function wornSession(
    workspace: { accountId: string; workspaceId: string },
    profile: Awaited<ReturnType<typeof createAgentProfile>>,
    extra: Record<string, unknown> = {},
  ) {
    const session = await createSession(db, {
      ...workspace,
      initialMessage: "work",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      agentProfile: sessionAgentProfileFromProfile(profile),
      ...extra,
    });
    return session;
  }

  test("a home chat must wear the agent; it can be cleared", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: {},
    });
    const worn = await wornSession(workspace, profile);
    const plain = await createSession(db, {
      ...workspace,
      initialMessage: "other",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    });

    await expect(
      setAgentProfileHome(db, {
        workspaceId: workspace.workspaceId,
        profileId: profile.id,
        sessionId: plain.id,
      }),
    ).rejects.toBeInstanceOf(AgentProfileHomeSessionError);

    const homed = await setAgentProfileHome(db, {
      workspaceId: workspace.workspaceId,
      profileId: profile.id,
      sessionId: worn.id,
    });
    expect(homed?.homeSessionId).toBe(worn.id);
    // A home chat is a pointer, not a configuration change: no new version.
    expect(homed?.version).toBe(1);
    expect((await getAgentProfile(db, workspace.workspaceId, profile.id))?.homeSessionId).toBe(
      worn.id,
    );

    const cleared = await setAgentProfileHome(db, {
      workspaceId: workspace.workspaceId,
      profileId: profile.id,
      sessionId: null,
    });
    expect(cleared?.homeSessionId).toBeNull();
  });

  test("an agent's chats list only chats wearing it, newest first", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const annie = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: {},
    });
    const scout = await createAgentProfile(db, {
      ...workspace,
      name: "Scout",
      avatar: owl,
      config: {},
    });
    const first = await wornSession(workspace, annie);
    const second = await wornSession(workspace, annie);
    await wornSession(workspace, scout);
    await admin`update sessions set updated_at = now() + interval '1 minute' where id = ${first.id}`;

    const chats = await listAgentProfileSessions(db, {
      workspaceId: workspace.workspaceId,
      subjectId: "user:someone",
      profileId: annie.id,
    });
    expect(chats.map((chat) => chat.id)).toEqual([first.id, second.id]);
    expect(chats[0]).toMatchObject({ profileVersion: 1, parentSessionId: null });
  });

  test("an agent's chats and proposals respect private chats", async () => {
    if (!available) return;
    const userId = `agent-profiles-${crypto.randomUUID()}`;
    const owner = `user:${userId}`;
    const context = await ensureManagedAccessForUser(db, {
      userId,
      email: `${userId}@example.test`,
      name: "Agent profile owner",
    });
    const grant = context.workspaceGrants.find(
      (candidate) => candidate.workspaceId !== context.defaultWorkspaceId,
    );
    if (!grant?.workspaceId) throw new Error("managed human has no personal workspace");
    const settings = await getOrganizationPrivateSessionSettings(db, {
      organizationId: grant.accountId,
      actorSubjectId: owner,
    });
    if (!settings.enabled) {
      await updateOrganizationPrivateSessionSettings(db, {
        organizationId: grant.accountId,
        actorSubjectId: owner,
        enabled: true,
        expectedVersion: settings.version,
        operationId: crypto.randomUUID(),
      });
    }
    const workspace = { accountId: grant.accountId, workspaceId: grant.workspaceId };
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: { agent: { instructions: "Be brief." } },
    });
    const session = await wornSession(workspace, profile, {
      createdBy: { kind: "subject" as const, subjectId: owner },
    });
    await transitionSessionVisibility(db, {
      workspaceId: workspace.workspaceId,
      sessionId: session.id,
      actorSubjectId: owner,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `visibility-${crypto.randomUUID()}`,
    });
    await createAgentProfileProposal(db, {
      ...workspace,
      profileId: profile.id,
      baseVersion: 1,
      sessionId: session.id,
      proposedBy: owner,
      instructions: "Be brief. Cite the ticket.",
      reason: "The user asked for ticket links.",
    });

    const read = (subjectId: string) =>
      Promise.all([
        listAgentProfileSessions(db, { ...workspace, subjectId, profileId: profile.id }),
        listAgentProfileProposals(db, { ...workspace, subjectId, profileId: profile.id }),
      ]);
    const [ownerChats, ownerProposals] = await read(owner);
    expect(ownerChats.map((chat) => chat.id)).toEqual([session.id]);
    expect(ownerProposals).toHaveLength(1);
    const [otherChats, otherProposals] = await read("user:someone-else");
    expect(otherChats).toEqual([]);
    expect(otherProposals).toEqual([]);
  });

  test("a proposal is accepted as a new version, against the version reviewed", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:reviewer";
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: { model: "gpt-test", agent: { instructions: "Review pull requests." } },
    });
    const session = await wornSession(workspace, profile);
    const propose = (instructions: string) =>
      createAgentProfileProposal(db, {
        ...workspace,
        profileId: profile.id,
        baseVersion: 1,
        sessionId: session.id,
        proposedBy: "agent",
        instructions,
        reason: "The user corrected the review style.",
      });

    const older = await propose("Review pull requests. Be terse.");
    const newer = await propose("Review pull requests. Be terse. Link failing checks.");
    // The chat's newer proposal replaces its older pending one.
    const pending = await listAgentProfileProposals(db, {
      ...workspace,
      subjectId,
      profileId: profile.id,
    });
    expect(pending.map((proposal) => proposal.id)).toEqual([newer.id]);
    const all = await listAgentProfileProposals(db, {
      ...workspace,
      subjectId,
      profileId: profile.id,
      status: "all",
    });
    expect(all.find((proposal) => proposal.id === older.id)).toMatchObject({
      status: "dismissed",
      decidedBy: "superseded",
    });

    await expect(
      acceptAgentProfileProposal(db, {
        ...workspace,
        subjectId,
        profileId: profile.id,
        proposalId: newer.id,
        expectedVersion: 7,
      }),
    ).rejects.toBeInstanceOf(AgentProfileVersionConflictError);

    const accepted = await acceptAgentProfileProposal(db, {
      ...workspace,
      subjectId,
      profileId: profile.id,
      proposalId: newer.id,
      expectedVersion: 1,
      decidedBy: subjectId,
    });
    expect(accepted?.profile.version).toBe(2);
    expect(accepted?.profile.config).toEqual({
      model: "gpt-test",
      agent: { instructions: "Review pull requests. Be terse. Link failing checks." },
    });
    expect(accepted?.proposal).toMatchObject({
      status: "accepted",
      acceptedVersion: 2,
      decidedBy: subjectId,
    });
    const versions = await listAgentProfileVersions(db, workspace.workspaceId, profile.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);

    // A decided proposal cannot be decided again.
    await expect(
      dismissAgentProfileProposal(db, {
        ...workspace,
        subjectId,
        profileId: profile.id,
        proposalId: newer.id,
      }),
    ).rejects.toBeInstanceOf(AgentProfileProposalStateError);
  });

  test("a dismissed proposal leaves the agent unchanged", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const subjectId = "user:reviewer";
    const profile = await createAgentProfile(db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: { agent: { instructions: "Review pull requests." } },
    });
    const session = await wornSession(workspace, profile);
    const proposal = await createAgentProfileProposal(db, {
      ...workspace,
      profileId: profile.id,
      baseVersion: 1,
      sessionId: session.id,
      instructions: "Approve everything.",
      reason: "Faster reviews.",
    });
    const dismissed = await dismissAgentProfileProposal(db, {
      ...workspace,
      subjectId,
      profileId: profile.id,
      proposalId: proposal.id,
      decidedBy: subjectId,
    });
    expect(dismissed).toMatchObject({ status: "dismissed", decidedBy: subjectId });
    const unchanged = await getAgentProfile(db, workspace.workspaceId, profile.id);
    expect(unchanged?.version).toBe(1);
    expect(unchanged?.config.agent?.instructions).toBe("Review pull requests.");
  });
});
