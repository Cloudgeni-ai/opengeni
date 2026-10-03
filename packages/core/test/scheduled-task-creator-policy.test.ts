import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  DEVELOPER_SETUP_API_KEY_PRESET,
  metadataWithTurnExecutionPolicyV1,
  signDelegatedAccessToken,
  type AccessGrant,
  type ApiKey,
} from "@opengeni/contracts";
import * as db from "@opengeni/db";
import type { SessionCommandActor } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { requireAccessGrantAuthorization, type AccessGrantAuthorization } from "../src/access";
import {
  frozenScheduledTaskCreatorPolicy,
  triggerScheduledTaskForGrant,
} from "../src/domain/scheduled-tasks";
import type { SessionWorkflowClient } from "../src/dependencies";
import { planScheduledTaskOpenGeniTools } from "../src/domain/scheduled-task-access";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const delegationSecret = "scheduled-setup-policy-fixture-secret";
const settings = testSettings({ productAccessMode: "managed", delegationSecret });
const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length) restores.pop()!();
});

function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

const grant: AccessGrant = {
  accountId,
  workspaceId,
  subjectId: "worker:first-party-mcp",
  permissions: ["sessions:read", "scheduled_tasks:manage"],
  principalKind: "agent_attempt",
  metadata: {},
};
const actor: Extract<SessionCommandActor, { type: "agent_attempt" }> = {
  type: "agent_attempt",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

async function authenticate(
  bearer: string,
  headers: Record<string, string> = {},
): Promise<AccessGrantAuthorization> {
  let authorization: AccessGrantAuthorization | undefined;
  const app = new Hono().get("/", async (context) => {
    authorization = await requireAccessGrantAuthorization(
      context,
      { db: {} as never, settings, managedAuth: null },
      workspaceId,
      "scheduled_tasks:manage",
    );
    return context.text("ok");
  });
  const response = await app.request("/", {
    headers: { authorization: `Bearer ${bearer}`, ...headers },
  });
  expect(response.status).toBe(200);
  if (!authorization) throw new Error("Missing fixture authorization");
  return authorization;
}

function frozen(
  authorization?: AccessGrantAuthorization,
  callingActor: typeof actor | null = null,
) {
  return frozenScheduledTaskCreatorPolicy({
    db: {} as never,
    settings,
    grant: authorization?.grant ?? grant,
    authorization,
    actor: callingActor,
  });
}

async function manuallyTrigger(callingGrant: AccessGrant, suppliedRestriction = false) {
  track(spyOn(db, "scheduledTaskMutationOwnerMatches").mockResolvedValue(true));
  const database = { transaction: async (run: (tx: never) => Promise<void>) => run({} as never) };
  let accepted: Parameters<SessionWorkflowClient["triggerScheduledTask"]>[0] | undefined;
  await triggerScheduledTaskForGrant(
    database as never,
    callingGrant,
    {
      triggerScheduledTask: async (input) => {
        accepted = input;
      },
    } as SessionWorkflowClient,
    {
      task: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never,
      agentRunUsageIdempotencyKey: "manual-fixture",
      triggerWorkflowId: "manual-fixture",
      initiator: { kind: "subject", subjectId: callingGrant.subjectId },
      ...(suppliedRestriction ? { credentialRestriction: "developer_setup" as const } : {}),
    },
  );
  return accepted;
}

function origin(restricted: "turn" | "session" | "neither") {
  const policy = resolveTurnExecutionPolicyV1(settings, {
    modelId: "scripted-model",
    requestedModelId: null,
    modelSource: "session",
    reasoningEffort: "high",
    reasoningSource: "session",
  });
  const metadata = (includeRestriction: boolean) =>
    metadataWithTurnExecutionPolicyV1(
      {},
      {
        ...policy,
        ...(includeRestriction ? { credentialRestriction: "developer_setup" as const } : {}),
      },
    );
  const session = {
    id: actor.sessionId,
    firstPartyMcpTools: ["set_session_title"],
    firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage", "connections:read"],
    agentAccess: "session",
    scopeSubjectId: "user:fixture",
    memoryScope: "user",
    metadata: metadata(restricted === "session"),
  };
  track(spyOn(db, "getSession").mockResolvedValue(session as never));
  const turn = track(
    spyOn(db, "getSessionTurnForAttempt").mockResolvedValue({
      id: actor.turnId,
      metadata: metadata(restricted === "turn"),
    } as never),
  );
  return { session, turn };
}

describe("scheduled task frozen setup restriction", () => {
  test.each(["raw", "service", "asUser"] as const)(
    "%s setup creates capture restriction without agent defaults",
    async (lane) => {
      track(
        spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
          id: "66666666-6666-4666-8666-666666666666",
          accountId,
          workspaceId: null,
          name: "Fixture setup",
          permissions: [...DEVELOPER_SETUP_API_KEY_PRESET.permissions],
          credentialKind: "organization",
        } as ApiKey & { credentialKind: "organization" }),
      );
      track(
        spyOn(db, "requireWorkspace").mockResolvedValue({
          id: workspaceId,
          accountId,
          kind: "shared",
        } as never),
      );
      track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
      const headers: Record<string, string> = {};
      if (lane === "service") headers["x-opengeni-service-initiator"] = "fixture.setup";
      if (lane === "asUser") {
        track(
          spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
            callback({} as never),
          ),
        );
        track(spyOn(db, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
        track(
          spyOn(db, "ensureExternalIdentity").mockResolvedValue({
            id: "77777777-7777-4777-8777-777777777777",
            accountId,
            subjectId: "external_user:77777777-7777-4777-8777-777777777777",
            source: "fixture",
            externalId: "person",
            personalWorkspaceId: "88888888-8888-4888-8888-888888888888",
            organizationMembershipId: "99999999-9999-4999-8999-999999999999",
            authorizationRevision: 1,
          } as never),
        );
        track(
          spyOn(db, "withWorkspaceSubjectRls").mockImplementation(
            async (_database, _workspace, _subject, run) => run({} as never),
          ),
        );
        track(
          spyOn(db, "getWorkspaceGrant").mockResolvedValue({
            ...grant,
            subjectId: "external_user:77777777-7777-4777-8777-777777777777",
            principalKind: "human_session",
          }),
        );
        headers["x-opengeni-external-actor"] = encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source: "fixture", externalId: "person" },
          }),
        );
      }
      const authorization = await authenticate("ogk_fixture_setup", headers);
      const expected = {
        firstPartyMcpTools: null,
        firstPartyMcpPermissions: null,
        sessionPolicy: null,
        credentialRestriction: "developer_setup" as const,
      };
      expect(await frozen(authorization)).toEqual(expected);
      // First-party callers can carry the canonical grant without the wrapper.
      expect(
        await frozenScheduledTaskCreatorPolicy({
          db: {} as never,
          settings,
          grant: authorization.grant,
          actor: null,
        }),
      ).toEqual(expected);
      // Ownerless and same-human native tasks need the caller ceiling on the
      // accepted manual run even when their durable creator policy is absent.
      expect((await manuallyTrigger(authorization.grant))?.credentialRestriction).toBe(
        "developer_setup",
      );
    },
  );

  test("a verified restricted delegation captures provenance; ordinary delegation stays legacy", async () => {
    for (const restricted of [true, false]) {
      const token = await signDelegatedAccessToken(delegationSecret, {
        accountId,
        workspaceId,
        subjectId: "service:fixture",
        principalKind: "service",
        permissions: ["scheduled_tasks:manage"],
        ...(restricted ? { credentialRestriction: "developer_setup" as const } : {}),
        exp: Math.floor(Date.now() / 1_000) + 60,
      });
      const policy = await frozen(await authenticate(token));
      expect(policy?.credentialRestriction).toBe(restricted ? "developer_setup" : undefined);
      if (!restricted) expect(policy).toBeNull();
    }
  });

  test("a restriction-only task does not gain a refreshable tool or permission policy", () => {
    const policy: db.ScheduledTaskCreatorPolicy = {
      firstPartyMcpTools: null,
      firstPartyMcpPermissions: null,
      sessionPolicy: null,
      credentialRestriction: "developer_setup",
    };
    expect(
      planScheduledTaskOpenGeniTools({
        creatorPolicy: policy,
        settings,
        grantPermissions: ["workspace:admin"],
        permissionsRequiredByTools: () => {
          throw new Error("restriction must not select tools");
        },
      }),
    ).toEqual({ missing: [], policy: null });
  });

  test.each(["turn", "session"] as const)(
    "inherits the server-frozen %s restriction without widening tools or permissions",
    async (source) => {
      const { turn } = origin(source);
      expect(await frozen(undefined, actor)).toEqual({
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage"],
        sessionPolicy: {
          agentAccess: "session",
          scopeSubjectId: "user:fixture",
          memoryScope: "user",
        },
        credentialRestriction: "developer_setup",
      });
      expect(turn).toHaveBeenCalledWith({}, workspaceId, actor.sessionId, actor.attemptId);
    },
  );

  test("ordinary agent policy stays unchanged and bare grant metadata cannot forge restriction", async () => {
    origin("neither");
    const forgedGrant = { ...grant, metadata: { credentialRestriction: "developer_setup" } };
    expect(
      await frozenScheduledTaskCreatorPolicy({
        db: {} as never,
        settings,
        grant: forgedGrant,
        actor,
      }),
    ).toEqual({
      firstPartyMcpTools: ["set_session_title"],
      firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage"],
      sessionPolicy: {
        agentAccess: "session",
        scopeSubjectId: "user:fixture",
        memoryScope: "user",
      },
    });
    expect(
      await frozenScheduledTaskCreatorPolicy({
        db: {} as never,
        settings,
        grant: forgedGrant,
        actor: null,
        authorization: {
          grant: forgedGrant,
          accountGrant: null,
          authenticatedSubjectId: forgedGrant.subjectId,
          contextIntegrity: true,
          canonicalManagedHumanSession: false,
          canonicalLocalHumanSession: false,
        },
      }),
    ).toBeNull();
  });

  test("an unavailable or mismatched originating attempt cannot supply a restriction", async () => {
    const { turn } = origin("turn");
    turn.mockResolvedValue(null);
    await expect(frozen(undefined, actor)).rejects.toMatchObject({ status: 403 });
    turn.mockResolvedValue({ id: crypto.randomUUID(), metadata: {} } as never);
    await expect(frozen(undefined, actor)).rejects.toMatchObject({ status: 403 });
  });

  test.each(["turn", "session", "neither"] as const)(
    "manual runs inherit exact %s source provenance without trusting caller fields",
    async (source) => {
      origin(source);
      const caller: AccessGrant = {
        ...grant,
        metadata: {
          sessionId: actor.sessionId,
          turnId: actor.turnId,
          attemptId: actor.attemptId,
          executionGeneration: actor.executionGeneration,
        },
      };
      expect((await manuallyTrigger(caller, true))?.credentialRestriction).toBe(
        source === "neither" ? undefined : "developer_setup",
      );
    },
  );

  test("ordinary manual service remains unrestricted and cannot forge a caller ceiling", async () => {
    expect(
      (await manuallyTrigger({ ...grant, principalKind: "service" }, true))?.credentialRestriction,
    ).toBeUndefined();
  });
});
