import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  createAgentProfile,
  createDb,
  ensureManagedAccessForUser,
  getSession,
  setAgentProfileStatus,
  type DbClient,
} from "@opengeni/db";
import {
  applyAgentProfileToSession,
  createSessionForRequestWithOutcome,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

const owl = { kind: "emoji" as const, emoji: "🦉", hue: 235 };

function buildDeps(settings: Settings): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

async function managedHuman() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Agent profile owner",
  });
  const grant = {
    ...access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    )!,
    principalKind: "human_session" as const,
  };
  const context = {
    grant,
    accountGrant: access.accountGrants[0] ?? null,
    authenticatedSubjectId: grant.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
  };
  return { grant, context };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("agent-profile-session-create");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[agent-profile-session-create] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("sessions started from or switched to an agent profile (real PostgreSQL)", () => {
  test("a new chat takes the profile's fields, explicit fields win, and it wears the identity", async () => {
    if (!available) return;
    const { grant, context } = await managedHuman();
    const settings = testSettings({
      databaseUrl: shared!.appUrl,
      sandboxBackend: "none",
      agentProfilesEnabled: true,
    });
    const profile = await createAgentProfile(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Annie",
      role: "PR reviewer",
      avatar: owl,
      config: {
        agent: { instructions: "Review pull requests.", renderer: "markdown" },
        model: "scripted-model",
        reasoningEffort: "high",
      },
    });
    const create = (payload: Record<string, unknown>, deps = buildDeps(settings)) =>
      createSessionForRequestWithOutcome(
        deps,
        grant,
        grant.workspaceId,
        {
          sandboxBackend: "none",
          idempotencyKey: crypto.randomUUID(),
          ...payload,
        } as Parameters<typeof createSessionForRequestWithOutcome>[3],
        context,
      );

    const started = await create({ initialMessage: "Review #5247", agentProfileId: profile.id });
    const stored = (await getSession(client.db, grant.workspaceId, started.session.id))!;
    expect(stored.instructions).toBe("Review pull requests.");
    expect(stored.agent?.renderer).toBe("markdown");
    expect(stored.model).toBe("scripted-model");
    expect(stored.reasoningEffort).toBe("high");
    expect(stored.agentProfile).toEqual({
      profileId: profile.id,
      profileVersion: 1,
      name: "Annie",
      role: "PR reviewer",
      avatar: owl,
    });

    const overridden = await create({
      initialMessage: "Quick look",
      agentProfileId: profile.id,
      instructions: "Only check the tests.",
      reasoningEffort: "low",
      model: "scripted-model",
    });
    const overriddenStored = (await getSession(
      client.db,
      grant.workspaceId,
      overridden.session.id,
    ))!;
    expect(overriddenStored.instructions).toBe("Only check the tests.");
    expect(overriddenStored.reasoningEffort).toBe("low");
    expect(overriddenStored.agentProfile?.profileId).toBe(profile.id);

    await setAgentProfileStatus(client.db, {
      workspaceId: grant.workspaceId,
      profileId: profile.id,
      status: "archived",
    });
    await expect(
      create({ initialMessage: "Archived", agentProfileId: profile.id }),
    ).rejects.toMatchObject({ status: 422 });

    const off = buildDeps(
      testSettings({
        databaseUrl: shared!.appUrl,
        sandboxBackend: "none",
        agentProfilesEnabled: false,
      }),
    );
    await expect(
      create({ initialMessage: "Flag off", agentProfileId: profile.id }, off),
    ).rejects.toMatchObject({ status: 422 });
  }, 120_000);

  test("a running chat switches to a profile from its next message under the CAS", async () => {
    if (!available) return;
    const { grant, context } = await managedHuman();
    const settings = testSettings({
      databaseUrl: shared!.appUrl,
      sandboxBackend: "none",
      agentProfilesEnabled: true,
    });
    const deps = buildDeps(settings);
    const created = await createSessionForRequestWithOutcome(
      deps,
      grant,
      grant.workspaceId,
      {
        initialMessage: "Fix the flaky test",
        model: "scripted-model",
        sandboxBackend: "none",
        idempotencyKey: crypto.randomUUID(),
      } as Parameters<typeof createSessionForRequestWithOutcome>[3],
      context,
    );
    const before = (await getSession(client.db, grant.workspaceId, created.session.id))!;
    const profile = await createAgentProfile(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Bugfixer",
      avatar: { kind: "emoji", emoji: "🐞", hue: 20 },
      config: {
        agent: {
          capabilities: { from: "all", browser: false },
          instructions: "Reproduce first, then fix.",
        },
      },
    });

    await expect(
      applyAgentProfileToSession(deps, grant, before.id, {
        agentProfileId: profile.id,
        expectedVersion: (before.toolPolicyVersion ?? 1) + 5,
      }),
    ).rejects.toMatchObject({ currentVersion: before.toolPolicyVersion ?? 1 });

    const switched = await applyAgentProfileToSession(deps, grant, before.id, {
      agentProfileId: profile.id,
      expectedVersion: before.toolPolicyVersion ?? 1,
    });
    expect(switched.instructions).toBe("Reproduce first, then fix.");
    expect(switched.agent?.capabilities.browser).toBe(false);
    expect(switched.agentProfile).toMatchObject({ profileId: profile.id, name: "Bugfixer" });
    expect(switched.toolPolicyVersion).toBeGreaterThan(before.toolPolicyVersion ?? 1);
  }, 120_000);
});
