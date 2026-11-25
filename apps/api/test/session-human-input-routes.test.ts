import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createSecretResolver,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  applySessionTurnSettlement,
  appendSessionEvents,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationApiKey,
  createSession,
  encryptEnvironmentValue,
  ensureExternalIdentity,
  ensureDefaultVault,
  ensureTaskVault,
  getSession,
  getVaultItem,
  grantWorkspaceAccess,
  listHumanInputSecretSaveTargets,
  submitHumanPromptInTransaction,
  updateWorkspaceSettings,
  upsertVaultItem,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  OPEN_SUFFIX_RUN_STATE_BLOB,
  formatSecretReference,
  parseSecretReference,
  signDelegatedAccessToken,
  skillReviewHumanInput,
  type HumanInputQuestion,
  type Permission,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerVaultRoutes } from "../src/routes/vaults";

const DELEGATION_SECRET = "session-human-input-route-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 44);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: ENCRYPTION_KEY.toString("base64"),
});

const SECRET_QUESTION: HumanInputQuestion = {
  id: "sample-password",
  kind: "secret",
  prompt: "Enter your example password.",
  options: [],
  required: true,
  allowOther: false,
  secret: {
    item: "Example login",
    field: "password",
    fieldKind: "concealed",
    itemType: "login",
    saveTo: "workspace",
    allowGenerate: false,
    autocomplete: "current-password",
  },
};

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let approvalSignals = 0;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-session-human-input");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const noop = async () => undefined;
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: async () => {
      approvalSignals += 1;
    },
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  app = new Hono();
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
  registerSessionRoutes(app, deps);
  registerVaultRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function frozenFixture(
  options: {
    optionalText?: boolean;
    skillReview?: boolean;
    secretQuestion?: "saved-logins-on" | "saved-logins-off";
    externalAsker?: boolean;
    asChild?: boolean;
    allowSkip?: boolean;
    expiresAt?: Date | null;
  } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `human-input-api-account-${suffix}`,
    accountName: "Human input API",
    workspaceExternalSource: "test",
    workspaceExternalId: `human-input-api-workspace-${suffix}`,
    workspaceName: "Human input API",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const external = options.externalAsker ? await externalVaultActor(grant) : undefined;
  const subjectId = external?.identity.subjectId ?? grant.subjectId;
  if (options.secretQuestion && !external) {
    const [personal] = await shared.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name) values (${grant.accountId}::uuid, 'Personal')
      returning id::text as id`;
    await shared.admin`
      insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
      values (${grant.accountId}::uuid, ${subjectId}, 'active', 'member', ${personal!.id}::uuid)
      on conflict do nothing`;
  }
  const sessionInput = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "Ask first",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const parent = options.asChild ? await createSession(client.db, sessionInput) : null;
  const session = await createSession(client.db, {
    ...sessionInput,
    ...(parent ? { parentSessionId: parent.id } : {}),
    ...(options.secretQuestion === "saved-logins-off"
      ? { firstPartyMcpPermissions: ["sessions:read", "sessions:control"] }
      : {}),
  });
  await withWorkspaceSubjectSessionActivityRls(client.db, grant.workspaceId!, subjectId, (db) =>
    submitHumanPromptInTransaction(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      subjectId,
      actor: { type: "human", subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Proceed with my choice",
      resources: [],
      tools: [],
      reasoningEffortFallback: "low",
      source: "user",
    }),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`fixture claim failed: ${claimed.reason}`);
  const requestId = crypto.randomUUID();
  const questions = options.secretQuestion
    ? [
        external
          ? { ...SECRET_QUESTION, secret: { ...SECRET_QUESTION.secret!, saveTo: "user" } }
          : SECRET_QUESTION,
      ]
    : options.skillReview
      ? skillReviewHumanInput({
          sourceOperationId: crypto.randomUUID(),
          skillId: crypto.randomUUID(),
          revisionId: crypto.randomUUID(),
          expectedRevisionId: null,
          expectedScopeVersion: 1,
        }).questions
      : options.optionalText
        ? [
            {
              id: "note",
              kind: "text" as const,
              prompt: "Anything else?",
              options: [],
              required: false,
              allowOther: false,
            },
          ]
        : [
            {
              id: "environment",
              kind: "single_select" as const,
              prompt: "Which environment?",
              options: [{ id: "staging", label: "Staging" }],
              required: true,
              allowOther: false,
            },
          ];
  const allowSkip = options.allowSkip ?? false;
  const expiresAt = options.expiresAt ?? null;
  await applySessionTurnSettlement(client.db, grant.workspaceId!, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: claimed.turn.id,
    runState: {
      serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
      pendingApprovals: [],
      humanInputRequests: [
        {
          id: requestId,
          toolCallId: "human-call-api",
          questions,
          allowSkip,
          expiresAt,
        },
      ],
    },
    events: [
      {
        type: "session.humanInput.requested",
        payload: {
          request: {
            id: requestId,
            questions,
            allowSkip,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
      },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId,
    permissions: [
      "sessions:read",
      "sessions:control",
      ...(options.secretQuestion ? ["secrets:write" as const] : []),
    ],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return {
    accountId: grant.accountId,
    subjectId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    rootSessionId: parent?.id ?? session.id,
    requestId,
    turnId: claimed.turn.id,
    authorization: `Bearer ${token}`,
    external,
    questions,
  };
}

const externalVaultPermissions: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "secrets:list",
  "secrets:use",
  "secrets:write",
];

async function externalVaultActor(scope: { accountId: string; workspaceId?: string | null }) {
  const source = "example-embedding-host";
  const externalId = crypto.randomUUID();
  const identity = await ensureExternalIdentity(client.db, {
    accountId: scope.accountId,
    source,
    externalId,
  });
  await grantWorkspaceAccess(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId!,
    subjectId: identity.subjectId,
    permissions: externalVaultPermissions,
  });
  return {
    identity,
    header: encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source, externalId } }),
    ),
  };
}

async function vaultHostToken(accountId: string, permissions: Permission[]) {
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Embedding host",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
  });
  return `Bearer ${token}`;
}

describe("structured human-input HTTP surface (real PostgreSQL)", () => {
  test("a verified embedded person can save to their own vault without sharing it", async () => {
    const fixture = await frozenFixture({ secretQuestion: "saved-logins-on", externalAsker: true });
    const { accountId, workspaceId, sessionId, subjectId, turnId, requestId } = fixture;
    const owner = fixture.external!;
    const other = await externalVaultActor(fixture);
    const organizationKey = await vaultHostToken(accountId, externalVaultPermissions);
    const limitedKey = await vaultHostToken(
      accountId,
      externalVaultPermissions.filter((permission) => permission !== "secrets:write"),
    );
    const headers = (externalHeader?: string, authorization = organizationKey) => ({
      authorization,
      ...(externalHeader ? { "x-opengeni-external-actor": externalHeader } : {}),
      "content-type": "application/json",
    });
    const workspace = `http://x/v1/workspaces/${workspaceId}`;
    const session = `${workspace}/sessions/${sessionId}`;
    const card = `${session}/human-input-requests/${requestId}`;
    const value = "synthetic-embedded-secret";
    const answer = (externalHeader?: string, authorization?: string) =>
      app.request(`${session}/events`, {
        method: "POST",
        headers: headers(externalHeader, authorization),
        body: JSON.stringify({
          type: "user.humanInputResponse",
          payload: {
            requestId,
            response: { outcome: "answered", answers: [] },
            secretAnswers: [{ questionId: SECRET_QUESTION.id, saveTo: "user", value }],
          },
        }),
      });

    // A default vault does not have to exist yet. The database already admits the owner.
    const writer = { kind: "subject" as const, accountId, workspaceId, subjectId };
    const existing =
      await shared.admin`select id from vaults where account_id = ${accountId} and owner_kind = 'user'`;
    expect(existing).toHaveLength(0);
    expect(await listHumanInputSecretSaveTargets(client.db, writer, { sessionId, turnId })).toEqual(
      ["user", "task", "workspace"],
    );

    const ownCard = await app.request(card, { headers: headers(owner.header) });
    expect(ownCard.status).toBe(200);
    expect(await ownCard.json()).toMatchObject({
      secretSaveTargets: ["user", "task", "workspace"],
    });
    const ownList = await app.request(`${session}/human-input-requests?status=pending`, {
      headers: headers(owner.header),
    });
    expect(await ownList.json()).toMatchObject({
      requests: [{ id: requestId, secretSaveTargets: ["user", "task", "workspace"] }],
    });

    // The same key by itself, a different person, an ordinary delegated bearer naming
    // the owner, and an asUser request without the write permission must all fail.
    for (const [actor, credential] of [
      [undefined, organizationKey],
      [other.header, organizationKey],
      [undefined, fixture.authorization],
      [owner.header, limitedKey],
    ] as const) {
      const projection = await app.request(card, { headers: headers(actor, credential) });
      expect(projection.status).toBe(200);
      expect(await projection.json()).toMatchObject({ secretSaveTargets: ["task", "workspace"] });
      expect((await answer(actor, credential)).status).toBe(403);
    }

    const accepted = await answer(owner.header);
    expect(accepted.status).toBe(202);
    const event = await accepted.json();
    const reference = formatSecretReference({
      vault: "Private",
      item: "Example login",
      field: "password",
    });
    expect(event.payload.response.answers).toMatchObject([
      { secret: { saveTo: "user", reference }, values: [reference] },
    ]);
    expect(JSON.stringify(event)).not.toContain(value);
    const [vault] = await shared.admin`
      select id, workspace_id, owner_organization_membership_id from vaults
      where account_id = ${accountId} and owner_kind = 'user'`;
    expect(vault).toMatchObject({
      workspace_id: owner.identity.personalWorkspaceId,
      owner_organization_membership_id: owner.identity.organizationMembershipId,
    });
    const ownVault = await app.request(`${workspace}/vaults/${vault!.id}`, {
      headers: headers(owner.header),
    });
    expect(ownVault.status).toBe(200);
    const otherVault = await app.request(`${workspace}/vaults/${vault!.id}`, {
      headers: headers(other.header),
    });
    expect(otherVault.status).toBe(404);

    // A later chat for the same person can use it; a chat in the same
    // workspace for another person cannot, even with the exact reference.
    async function resolveInNewChat(initiatingSubject: string) {
      const next = await createSession(client.db, {
        accountId,
        workspaceId,
        initialMessage: "Use a saved login",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      await withWorkspaceSubjectSessionActivityRls(
        client.db,
        workspaceId,
        initiatingSubject,
        (db) =>
          submitHumanPromptInTransaction(db, {
            accountId,
            workspaceId,
            sessionId: next.id,
            subjectId: initiatingSubject,
            actor: { type: "human", subjectId: initiatingSubject },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "Continue",
            resources: [],
            tools: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
      );
      const attemptId = crypto.randomUUID();
      const work = await claimSessionWorkForAttempt(client.db, workspaceId, {
        sessionId: next.id,
        workflowId: `session-${next.id}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "next" },
      });
      if (work.action !== "claimed") throw new Error(`new chat did not claim: ${work.reason}`);
      return createSecretResolver(
        { db: client.db, encryptionKey: ENCRYPTION_KEY },
        {
          kind: "attempt",
          accountId,
          workspaceId,
          sessionId: next.id,
          turnId: work.turn.id,
          executionGeneration: work.turn.executionGeneration,
          attemptId,
        },
        { capabilityEnabled: true },
      ).resolve([parseSecretReference(reference)], { surface: "mcp", toolName: "example_login" });
    }

    const resolved = await resolveInNewChat(subjectId);
    expect([...resolved.values()].map((entry) => entry.material)).toEqual([
      { type: "text", value },
    ]);
    await expect(resolveInNewChat(other.identity.subjectId)).rejects.toMatchObject({
      failures: [{ code: "not_found" }],
    });
  });

  test.each([false, true])(
    "a restricted chat (child: %s) can use its secure answer, not other Task or workspace items",
    async (asChild) => {
      const fixture = await frozenFixture({ secretQuestion: "saved-logins-off", asChild });
      const { accountId, workspaceId, sessionId, subjectId, requestId } = fixture;
      const writer = { kind: "subject" as const, accountId, workspaceId, subjectId };
      const sharedVault = await ensureDefaultVault(client.db, writer, {
        workspaceId,
        ownerKind: "workspace",
      });
      const savedValue = "example-existing-saved-login";
      const sharedItem = {
        name: "Example login",
        type: "login",
        fields: [
          {
            name: "password",
            kind: "concealed" as const,
            valueSize: savedValue.length,
            valueEncrypted: encryptEnvironmentValue(ENCRYPTION_KEY, savedValue),
          },
        ],
      } as const;
      await upsertVaultItem(client.db, writer, {
        ...sharedItem,
        fields: [...sharedItem.fields],
        vaultId: sharedVault.id,
      });
      const taskVault = await ensureTaskVault(client.db, writer, {
        workspaceId,
        sessionId: fixture.rootSessionId,
      });
      const existingTask = await upsertVaultItem(client.db, writer, {
        ...sharedItem,
        fields: [...sharedItem.fields],
        vaultId: taskVault.id,
      });
      const base = `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}`;
      const headers = { authorization: fixture.authorization, "content-type": "application/json" };
      const list = await app.request(`${base}/human-input-requests?status=pending`, { headers });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        requests: [
          {
            id: requestId,
            questions: [{ secret: { saveTo: "workspace" } }],
            secretSaveTargets: ["task"],
          },
        ],
      });
      const detail = await app.request(`${base}/human-input-requests/${requestId}`, { headers });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: requestId, secretSaveTargets: ["task"] });

      const value = "test-value-only-for-this-task";
      const answer = (saveTo: "workspace" | "user" | "task", vaultId?: string) =>
        app.request(`${base}/events`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "user.humanInputResponse",
            clientEventId: crypto.randomUUID(),
            payload: {
              requestId,
              response: {
                outcome: "answered",
                answers: [],
                secretAnswers: [{ questionId: SECRET_QUESTION.id, value, saveTo, vaultId }],
              },
            },
          }),
        });
      expect((await answer("workspace")).status).toBe(403);
      expect((await answer("user")).status).toBe(403);
      expect((await answer("task", sharedVault.id)).status).toBe(403);
      const accepted = await answer("task");
      expect(accepted.status).toBe(202);
      const event = await accepted.json();
      const itemName = event.payload.response.answers[0].secret.itemName as string;
      expect(itemName).not.toBe(existingTask.name);
      const reference = formatSecretReference({
        vault: "Task",
        item: itemName,
        field: "password",
      });
      expect(event.payload.response.answers).toMatchObject([
        { secret: { reference, saveTo: "task" }, values: [reference] },
      ]);
      expect(JSON.stringify(event)).not.toContain(value);

      const attemptId = crypto.randomUUID();
      const resumed = await claimSessionWorkForAttempt(client.db, workspaceId, {
        sessionId,
        workflowId: `session-${sessionId}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "approval", triggerEventId: event.id },
      });
      if (resumed.action !== "claimed")
        throw new Error(`question did not resume: ${resumed.reason}`);
      const resolver = createSecretResolver(
        { db: client.db, encryptionKey: ENCRYPTION_KEY },
        {
          kind: "attempt",
          accountId,
          workspaceId,
          sessionId,
          attemptId,
          turnId: resumed.turn.id,
          executionGeneration: resumed.turn.executionGeneration,
        },
        { capabilityEnabled: true },
      );
      const use = { surface: "mcp", toolName: "example_login" } as const;
      const resolved = await resolver.resolve([parseSecretReference(reference)], use);
      expect([...resolved.values()].map((entry) => entry.material)).toEqual([
        { type: "text", value },
      ]);
      expect((await getVaultItem(client.db, writer, { itemId: existingTask.id })).generation).toBe(
        existingTask.generation,
      );
      for (const inaccessible of [
        formatSecretReference({ vault: "Shared", item: existingTask.name, field: "password" }),
        formatSecretReference({ vault: "Task", item: existingTask.name, field: "password" }),
        formatSecretReference({ itemId: existingTask.id, field: "password" }),
        formatSecretReference({ vault: "Task", item: itemName, field: "password", previous: true }),
      ]) {
        await expect(
          resolver.resolve([parseSecretReference(inaccessible)], use),
        ).rejects.toMatchObject({
          failures: [{ code: "denied" }],
        });
      }
      const [written] = await shared.admin<Array<{ id: string }>>`
      select id::text from vault_items where vault_id = ${taskVault.id}::uuid and name = ${itemName}`;
      expect(
        (await getVaultItem(client.db, writer, { itemId: written!.id })).lastUsedAt,
      ).not.toBeNull();
      if (asChild) {
        const sibling = await createSession(client.db, {
          accountId,
          workspaceId,
          parentSessionId: fixture.rootSessionId,
          initialMessage: "Continue with the task",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          firstPartyMcpPermissions: ["sessions:read", "sessions:control"],
        });
        await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId,
            workspaceId,
            sessionId: sibling.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "Continue",
            resources: [],
            tools: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        );
        const siblingAttemptId = crypto.randomUUID();
        const siblingWork = await claimSessionWorkForAttempt(client.db, workspaceId, {
          sessionId: sibling.id,
          workflowId: `session-${sibling.id}`,
          workflowRunId: crypto.randomUUID(),
          dispatchId: crypto.randomUUID(),
          attemptId: siblingAttemptId,
          trigger: { kind: "next" },
        });
        if (siblingWork.action !== "claimed") throw new Error("sibling did not claim the turn");
        const siblingResolver = createSecretResolver(
          { db: client.db, encryptionKey: ENCRYPTION_KEY },
          {
            kind: "attempt",
            accountId,
            workspaceId,
            sessionId: sibling.id,
            attemptId: siblingAttemptId,
            turnId: siblingWork.turn.id,
            executionGeneration: siblingWork.turn.executionGeneration,
          },
          { capabilityEnabled: true },
        );
        await expect(
          siblingResolver.resolve([parseSecretReference(reference)], use),
        ).rejects.toMatchObject({
          failures: [{ code: "denied" }],
        });
      }
      await upsertVaultItem(client.db, writer, {
        itemId: written!.id,
        fields: [...sharedItem.fields],
      });
      await expect(resolver.resolve([parseSecretReference(reference)], use)).rejects.toMatchObject({
        failures: [{ code: "denied" }],
      });
    },
  );

  test("a chat with saved-logins access still offers its workspace vault", async () => {
    const fixture = await frozenFixture({ secretQuestion: "saved-logins-on" });
    const base = `http://x/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
    const response = await app.request(`${base}/human-input-requests/${fixture.requestId}`, {
      headers: { authorization: fixture.authorization },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ secretSaveTargets: ["task", "workspace"] });
  });
  test("conversation projections name the session sequence they reflect", async () => {
    const fixture = await frozenFixture();
    const base = `/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
    const headers = { authorization: fixture.authorization };
    const session = await getSession(client.db, fixture.workspaceId, fixture.sessionId);
    expect(session!.lastSequence).toBeGreaterThan(0);
    for (const path of ["human-input-requests?status=pending", "queue", "goal?absent=null"]) {
      const response = await app.request(`http://x${base}/${path}`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("X-OpenGeni-Session-Sequence")).toBe(
        String(session!.lastSequence),
      );
    }
    const missing = await app.request(
      `http://x/v1/workspaces/${fixture.workspaceId}/sessions/${crypto.randomUUID()}/queue`,
      { headers },
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("X-OpenGeni-Session-Sequence")).toBeNull();
  });

  test("accepts annotation-only messages and returns server-numbered structured payloads", async () => {
    const suffix = crypto.randomUUID();
    const subjectId = `user:${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `annotation-account-${suffix}`,
      accountName: "Annotation route",
      workspaceExternalSource: "test",
      workspaceExternalId: `annotation-workspace-${suffix}`,
      workspaceName: "Annotation route",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Initial message",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const [source] = await appendSessionEvents(client.db, grant.workspaceId!, session.id, [
      { type: "agent.message.completed", payload: { text: "alpha beta omega" } },
    ]);
    const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId,
      permissions: ["sessions:read", "sessions:control"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    const annotation = {
      id: crypto.randomUUID(),
      source: {
        kind: "assistant_message" as const,
        eventId: source!.id,
        eventType: "agent.message.completed" as const,
        sequence: source!.sequence,
        turnId: null,
        startOffset: 6,
        endOffset: 10,
        contextBefore: "alpha ",
        contextAfter: " omega",
      },
      quote: "beta",
      note: "Use this exact source.",
    };

    const response = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: {
            text: "",
            annotations: [annotation],
          },
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      type: "user.message",
      payload: {
        text: "",
        annotations: [
          {
            ordinal: 1,
            quote: "beta",
            note: "Use this exact source.",
            source: { eventId: source!.id, startOffset: 6, endOffset: 10 },
          },
        ],
      },
    });

    const steerClientEventId = crypto.randomUUID();
    const steerBody = {
      text: "",
      clientEventId: steerClientEventId,
      annotations: [{ ...annotation, id: crypto.randomUUID() }],
    };
    const steerResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/steer`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(steerBody),
      },
    );
    expect(steerResponse.status).toBe(202);
    const steerResult = await steerResponse.json();
    expect(steerResult).toMatchObject({
      interruptionCount: 0,
      replay: false,
      accepted: {
        payload: {
          text: "",
          annotations: [{ ordinal: 1, quote: "beta", source: { eventId: source!.id } }],
        },
      },
      turn: {
        prompt: "",
        annotations: [{ ordinal: 1, quote: "beta", source: { eventId: source!.id } }],
      },
    });

    const replayResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/steer`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(steerBody),
      },
    );
    expect(replayResponse.status).toBe(202);
    expect(await replayResponse.json()).toMatchObject({
      interruptionCount: 0,
      replay: true,
      accepted: { id: steerResult.accepted.id },
      turn: { id: steerResult.turn.id },
    });
  });

  test("normal user messages remain accepted when agent human input is disabled", async () => {
    const suffix = crypto.randomUUID();
    const subjectId = `user:${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `human-input-disabled-account-${suffix}`,
      accountName: "Human input disabled",
      workspaceExternalSource: "test",
      workspaceExternalId: `human-input-disabled-workspace-${suffix}`,
      workspaceName: "Human input disabled",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    await updateWorkspaceSettings(client.db, grant.workspaceId!, {
      agentHumanInputEnabled: false,
    });
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Initial message",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId,
      permissions: ["sessions:read", "sessions:control"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });

    const response = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: { text: "Ordinary user message" },
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      type: "user.message",
      payload: { text: "Ordinary user message" },
    });
  });

  test("reads pending requests, rejects invalid responses, and signals one accepted settlement", async () => {
    const fixture = await frozenFixture();
    const base = `/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
    const headers = { authorization: fixture.authorization };

    const list = await app.request(`http://x${base}/human-input-requests?status=pending`, {
      headers,
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      requests: [{ id: fixture.requestId, status: "pending", toolCallId: "human-call-api" }],
    });
    const get = await app.request(`http://x${base}/human-input-requests/${fixture.requestId}`, {
      headers,
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id: fixture.requestId, status: "pending" });

    const invalid = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: fixture.requestId,
          response: { outcome: "answered", answers: [] },
        },
      }),
    });
    expect(invalid.status).toBe(422);

    const disallowedSkip = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: fixture.requestId,
          response: { outcome: "skipped" },
        },
      }),
    });
    expect(disallowedSkip.status).toBe(409);

    const beforeSignals = approvalSignals;
    const responseClientEventId = crypto.randomUUID();
    const accepted = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: responseClientEventId,
        payload: {
          requestId: fixture.requestId,
          response: {
            outcome: "answered",
            answers: [{ questionId: "environment", values: ["staging"] }],
          },
        },
      }),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({
      type: "user.humanInputResponse",
      payload: {
        requestId: fixture.requestId,
        response: { outcome: "answered" },
      },
    });
    expect(approvalSignals).toBe(beforeSignals + 1);

    const signalsAfterAcceptance = approvalSignals;
    const duplicate = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: responseClientEventId,
        payload: {
          requestId: fixture.requestId,
          response: {
            outcome: "answered",
            answers: [{ questionId: "environment", values: ["staging"] }],
          },
        },
      }),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      id: acceptedBody.id,
      payload: { response: { outcome: "answered" } },
    });
    expect(approvalSignals).toBe(signalsAfterAcceptance);
  });

  test("accepts empty optional text, Skip, and deadline expiry as terminal outcomes", async () => {
    const optional = await frozenFixture({ optionalText: true });
    const optionalBase = `/v1/workspaces/${optional.workspaceId}/sessions/${optional.sessionId}`;
    const optionalResponse = await app.request(`http://x${optionalBase}/events`, {
      method: "POST",
      headers: { authorization: optional.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: optional.requestId,
          response: { outcome: "answered", answers: [] },
        },
      }),
    });
    expect(optionalResponse.status).toBe(202);
    expect(await optionalResponse.json()).toMatchObject({
      payload: {
        requestId: optional.requestId,
        response: { outcome: "answered", answers: [] },
      },
    });

    const skippable = await frozenFixture({ allowSkip: true });
    const skipResponse = await app.request(
      `http://x/v1/workspaces/${skippable.workspaceId}/sessions/${skippable.sessionId}/events`,
      {
        method: "POST",
        headers: { authorization: skippable.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          type: "user.humanInputResponse",
          clientEventId: crypto.randomUUID(),
          payload: {
            requestId: skippable.requestId,
            response: { outcome: "skipped" },
          },
        }),
      },
    );
    expect(skipResponse.status).toBe(202);
    expect(await skipResponse.json()).toMatchObject({
      payload: { requestId: skippable.requestId, response: { outcome: "skipped" } },
    });

    const expired = await frozenFixture({ expiresAt: new Date(Date.now() - 1_000) });
    const expiredBase = `/v1/workspaces/${expired.workspaceId}/sessions/${expired.sessionId}`;
    const pending = await app.request(
      `http://x${expiredBase}/human-input-requests?status=pending`,
      {
        headers: { authorization: expired.authorization },
      },
    );
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ requests: [] });

    const expiryResponse = await app.request(`http://x${expiredBase}/events`, {
      method: "POST",
      headers: { authorization: expired.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: expired.requestId,
          response: { outcome: "answered", answers: [] },
        },
      }),
    });
    expect(expiryResponse.status).toBe(202);
    expect(await expiryResponse.json()).toMatchObject({
      payload: { requestId: expired.requestId, response: { outcome: "expired" } },
    });

    const repeatedExpiry = await app.request(`http://x${expiredBase}/events`, {
      method: "POST",
      headers: { authorization: expired.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: expired.requestId,
          response: { outcome: "skipped" },
        },
      }),
    });
    expect(repeatedExpiry.status).toBe(200);
    expect(await repeatedExpiry.json()).toMatchObject({
      payload: { requestId: expired.requestId, response: { outcome: "expired" } },
    });
  });
});

test("a bearer naming the initiating human cannot answer a Skill review or stamp human authority", async () => {
  const fixture = await frozenFixture({ skillReview: true });
  const base = `/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
  const beforeSignals = approvalSignals;
  const response = await app.request(`http://x${base}/events`, {
    method: "POST",
    headers: { authorization: fixture.authorization, "content-type": "application/json" },
    body: JSON.stringify({
      type: "user.humanInputResponse",
      clientEventId: crypto.randomUUID(),
      payload: {
        requestId: fixture.requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: fixture.questions[0]!.id, values: ["save"] }],
        },
      },
    }),
  });
  expect(response.status).toBe(403);
  expect(approvalSignals).toBe(beforeSignals);
  const pending = await app.request(`http://x${base}/human-input-requests/${fixture.requestId}`, {
    headers: { authorization: fixture.authorization },
  });
  expect(await pending.json()).toMatchObject({ status: "pending", response: null });
  const [stored] = await shared.admin`
    SELECT skill_review_human_authorized AS authorized
    FROM session_human_input_requests WHERE id=${fixture.requestId}::uuid`;
  expect(stored?.authorized).toBe(false);
});
