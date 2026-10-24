import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import {
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
});
