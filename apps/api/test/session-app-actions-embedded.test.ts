import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AccessGrant } from "@opengeni/contracts";
import { appActionChangesState, findAppAction } from "@opengeni/contracts/app-actions";
import { stampWorkspacePersonAuthorization } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationApiKey,
  createSession,
  ensureExternalIdentity,
  externalPersonPersonalWorkspaceId,
  grantSessionAdminAccess,
  recordTurnAppActionGrant,
  submitHumanPromptInTransaction,
  withAccountRls,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
  type Database,
  type TurnAppActionGrant,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import {
  createSessionAdminReach,
  registerSessionAdminAccessTools,
} from "../src/mcp/session-admin-access-tools";
import { reachSessionInOtherWorkspace } from "../src/mcp/session-other-workspace";

/* A person using a product that embeds the chat is an external user of the
   organization, not a native Opengeni account. Their app actions run as them
   in this chat's workspace only, so "how much have I used" answers at once,
   and anything beyond that workspace says plainly it isn't available here. */

setDefaultTimeout(120_000);
const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-app-actions-embedded");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function textOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

/** Claim the session's next turn and register the app-action tools for it, as a turn does. */
async function appActionTools(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  input: { accountId: string; workspaceId: string; sessionId: string },
) {
  const db = client.db;
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, input.workspaceId, {
    sessionId: input.sessionId,
    workflowId: `session-${input.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
  const handlers = new Map<string, Handler>();
  const grant = { accountId: input.accountId, workspaceId: input.workspaceId } as AccessGrant;
  const reach = createSessionAdminReach({
    db,
    grant,
    sessionId: input.sessionId,
    turnId: claim.turn.id,
    access: { origin, dispatch: async (request) => await app.fetch(request) },
    authorize: async () => undefined,
  });
  registerSessionAdminAccessTools({
    server: {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as never,
    db,
    grant,
    sessionId: input.sessionId,
    attempt: { turnId: claim.turn.id, attemptId },
    reach,
  });
  return {
    sessionId: input.sessionId,
    reach,
    turnId: claim.turn.id,
    call: handlers.get("admin_action_call")!,
    search: handlers.get("admin_actions_search")!,
  };
}

describe("an embedded chat's message, through the real embed request path", () => {
  test("freezes the person's read-only grant, and their usage answers in one call", async () => {
    const noop = async () => undefined;
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "session-app-actions-embedded-secret-32",
        publicBaseUrl: origin,
        sandboxBackend: "none",
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {
        signalUserMessage: noop,
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalApprovalDecision: noop,
        signalSessionControl: noop,
      } as never,
    });
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Host Product",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Shared",
      subjectId: `user:${crypto.randomUUID()}`,
    });
    const organizationId = access.workspaceGrants[0]!.accountId;
    const person = await ensureExternalIdentity(client.db, {
      accountId: organizationId,
      externalId: `end-user-${crypto.randomUUID()}`,
    });
    // The host's server proxy: an organization key acting as one end user.
    const token = randomBytes(24).toString("hex");
    await createOrganizationApiKey(client.db, {
      accountId: organizationId,
      name: "Embed host",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:read", "sessions:read", "sessions:create"],
    });
    const created = await app.request(`/v1/workspaces/${person.personalWorkspaceId}/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { externalId: person.externalId } }),
        ),
      },
      body: JSON.stringify({
        initialMessage: "how much have I used so far?",
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(created.status, await created.clone().text()).toBe(202);
    const { id: sessionId } = (await created.json()) as { id: string };
    const tools = await appActionTools(app, {
      accountId: organizationId,
      workspaceId: person.personalWorkspaceId,
      sessionId,
    });
    const [frozen] = await shared.admin<{ subject_id: string; changes: string }[]>`
      select subject_id, changes from session_turn_app_action_grants where turn_id = ${tools.turnId}`;
    expect(frozen).toEqual({ subject_id: person.subjectId, changes: "none" });

    const usage = await tools.call({
      id: "getMyUsage",
      pathParameters: { workspaceId: person.personalWorkspaceId },
      query: {},
    });
    expect(usage.isError, textOf(usage)).toBeUndefined();
    expect(JSON.parse(textOf(usage))).toMatchObject({ status: 200 });
  });
});

describe("app actions for a person in an embedded chat", () => {
  test("run as that person in the chat's workspace, and say plainly what isn't available", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "session-app-actions-embedded-secret-32",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const db = client.db;
    const ownerSubjectId = `user:${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Host Product",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Shared",
      subjectId: ownerSubjectId,
    });
    const organizationId = access.workspaceGrants[0]!.accountId;
    const sharedWorkspaceId = access.workspaceGrants[0]!.workspaceId;
    // One end user of the host product, with their own workspace.
    const person = await ensureExternalIdentity(db, {
      accountId: organizationId,
      externalId: `end-user-${crypto.randomUUID()}`,
    });
    const subjectId = person.subjectId;
    const workspaceId = person.personalWorkspaceId;
    expect(subjectId).toStartWith("external_user:");

    // A chat the sender started and the turn of the message they sent, with
    // what the API froze when it accepted that message.
    const chatTurn = async (
      frozen: TurnAppActionGrant,
      sender: { subjectId: string; workspaceId: string } = {
        subjectId: person.subjectId,
        workspaceId: person.personalWorkspaceId,
      },
    ) => {
      const { subjectId: senderId, workspaceId: senderWorkspace } = sender;
      const session = await createSession(db, {
        accountId: organizationId,
        workspaceId: senderWorkspace,
        initialMessage: "hi",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: senderId },
      });
      await withWorkspaceSubjectSessionActivityRls(db, senderWorkspace, senderId, (scoped) =>
        scoped.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
            accountId: organizationId,
            workspaceId: senderWorkspace,
            sessionId: session.id,
            subjectId: senderId,
            actor: { type: "human", subjectId: senderId },
            operationKey: `send-${crypto.randomUUID()}`,
            delivery: "send",
            text: "how much have I used so far?",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
            captureTurnAuthority: async (captureTx: Database, turnId: string) =>
              await recordTurnAppActionGrant(captureTx, {
                accountId: organizationId,
                workspaceId: senderWorkspace,
                turnId,
                grant: frozen,
              }),
          }),
        ),
      );
      return await appActionTools(app, {
        accountId: organizationId,
        workspaceId: senderWorkspace,
        sessionId: session.id,
      });
    };

    // What the API froze for this person's message from the embed: reads
    // only, within the embed token's access.
    const embedded = await chatTurn({
      subjectId,
      changes: "none",
      permissions: ["workspace:read", "sessions:create", "sessions:read"],
    });

    // Their own usage, the same data the embed's usage display reads.
    const usage = await embedded.call({
      id: "getMyUsage",
      pathParameters: { workspaceId },
      query: {},
    });
    expect(usage.isError, textOf(usage)).toBeUndefined();
    const usageBody = JSON.parse(textOf(usage));
    expect(usageBody.status).toBe(200);
    for (const member of usageBody.body.members) expect(member.subjectId).toBe(subjectId);

    // Search offers only what can succeed for them: this workspace's actions.
    const searched = JSON.parse(
      textOf(await embedded.search({ query: "usage", limit: 50, offset: 0 })),
    ) as { total: number; actions: { id: string; path: string }[] };
    expect(searched.actions.map((action) => action.id)).toContain("getMyUsage");
    for (const action of searched.actions)
      expect(action.path).toMatch(/^\/v1\/workspaces\/:workspaceId(\/|$)/u);
    const everything = JSON.parse(
      textOf(await embedded.search({ query: "", limit: 50, offset: 0 })),
    ) as { total: number };

    // ...and only what this message's access can run: reads, and only those
    // whose route's first check their access passes. Changes that need
    // organization-level authority for some inputs (createRig, addDocument,
    // updateMachineAgent) and reads needing a permission the embed didn't
    // give (listRigs, listDocumentBases) aren't offered.
    const offered: string[] = [];
    for (let offset = 0; offset < everything.total; offset += 50) {
      const page = JSON.parse(textOf(await embedded.search({ query: "", limit: 50, offset }))) as {
        actions: { id: string }[];
      };
      offered.push(...page.actions.map((action) => action.id));
    }
    expect(offered).toHaveLength(everything.total);
    expect(offered).toEqual(
      expect.arrayContaining(["getMyUsage", "getWorkspace", "listSessionPage"]),
    );
    for (const id of [
      "createRig",
      "addDocument",
      "updateMachineAgent",
      "listRigs",
      "listDocumentBases",
    ])
      expect(offered).not.toContain(id);
    for (const id of offered) {
      const entry = findAppAction(id)!;
      expect(appActionChangesState(entry), id).toBe(false);
      expect([undefined, "workspace:read", "sessions:create", "sessions:read"], id).toContain(
        entry.permission,
      );
    }

    // Organization-wide actions and other workspaces are refused in one step,
    // before anything runs, naming the one workspace they can use and no page.
    const reach = `Nothing was run: this person uses Opengeni through another product, so app actions reach only this chat's workspace (workspaceId ${workspaceId}). Organization-wide settings, billing and other workspaces aren't available here. Tell them plainly, without pointing them to a page.`;
    for (const outside of [
      { id: "listOrganizationAdministrationMembers", pathParameters: { organizationId } },
      { id: "listWorkspaces", pathParameters: {} },
      { id: "getMyUsage", pathParameters: { workspaceId: sharedWorkspaceId } },
    ]) {
      const refused = await embedded.call({ ...outside, query: {} });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(reach);
    }

    // The workspace itself is in reach.
    const own = await embedded.call({
      id: "getWorkspace",
      pathParameters: { workspaceId },
      query: {},
    });
    expect(JSON.parse(textOf(own)).status, textOf(own)).toBe(200);

    // Inside it, anything beyond the embed's access gets the route's own
    // refusal with a plain hint, never a pointer to an app page.
    const keys = JSON.parse(
      textOf(
        await embedded.call({ id: "listApiKeys", pathParameters: { workspaceId }, query: {} }),
      ),
    );
    expect(keys).toMatchObject({
      status: 403,
      hint: "This isn't available to this person here. Tell them plainly, without pointing them to a page.",
    });

    // Changes stay off from an embed, said without naming a page.
    const change = await embedded.call({
      id: "updateWorkspace",
      pathParameters: { workspaceId },
      query: {},
      body: { name: "Renamed" },
    });
    expect(textOf(change)).toBe(
      "Nothing was run: this person uses Opengeni through another product, and app actions here can only read, not change anything. Tell them plainly, without pointing them to a page.",
    );

    // A person signed in to Opengeni itself is offered everything, as before.
    const native = await chatTurn(
      { subjectId: ownerSubjectId, changes: "confirm", permissions: ["workspace:admin"] },
      { subjectId: ownerSubjectId, workspaceId: sharedWorkspaceId },
    );
    const nativeEverything = JSON.parse(
      textOf(await native.search({ query: "", limit: 50, offset: 0 })),
    ) as { total: number };
    expect(nativeEverything.total).toBeGreaterThan(everything.total);

    // With full access the person can do everything they can in this
    // workspace, and every path gives the same answer: search, a call, and a
    // session tool reaching another workspace.
    const trusted = await chatTurn({
      subjectId,
      changes: "none",
      permissions: ["workspace:read", "sessions:create", "sessions:read"],
    });
    // An owner allowed full access for the organization's sessions.
    await shared.admin`
      insert into organization_agent_admin_access (account_id, session_admin_access_allowed)
      values (${organizationId}::uuid, true)
      on conflict (account_id) do update set session_admin_access_allowed = true`;
    await grantSessionAdminAccess(db, {
      organizationId,
      workspaceId,
      sessionId: trusted.sessionId,
      actorSubjectId: subjectId,
      durationHours: 1,
    });
    const trustedSearch = JSON.parse(
      textOf(await trusted.search({ query: "", limit: 50, offset: 0 })),
    ) as { total: number; actions: { path: string }[] };
    expect(trustedSearch.total).toBeGreaterThan(everything.total);
    expect(trustedSearch.total).toBeLessThan(nativeEverything.total);
    for (const action of trustedSearch.actions)
      expect(action.path).toMatch(/^\/v1\/workspaces\/:workspaceId(\/|$)/u);
    const trustedUsage = await trusted.call({
      id: "getMyUsage",
      pathParameters: { workspaceId },
      query: {},
    });
    expect(JSON.parse(textOf(trustedUsage)).status, textOf(trustedUsage)).toBe(200);
    const trustedElsewhere = await trusted.call({
      id: "getMyUsage",
      pathParameters: { workspaceId: sharedWorkspaceId },
      query: {},
    });
    expect(textOf(trustedElsewhere)).toBe(reach);
    const otherWorkspaceChat = await reachSessionInOtherWorkspace({
      reach: trusted.reach,
      db,
      here: { accountId: organizationId, workspaceId },
      workspaceId: sharedWorkspaceId,
      toolName: "session_get",
      arguments: { sessionId: crypto.randomUUID() },
    });
    expect(otherWorkspaceChat.isError).toBe(true);
    expect(textOf(otherWorkspaceChat)).toBe(reach);
  });

  test("reach the person's own workspace only as their organization membership names it", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "session-app-actions-embedded-secret-32",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const db = client.db;
    const ownerSubjectId = `user:${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Host Product",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Shared",
      subjectId: ownerSubjectId,
    });
    const organizationId = access.workspaceGrants[0]!.accountId;
    const sharedWorkspaceId = access.workspaceGrants[0]!.workspaceId;
    const [person, someoneElse] = await Promise.all(
      [1, 2].map(() =>
        ensureExternalIdentity(db, {
          accountId: organizationId,
          externalId: `end-user-${crypto.randomUUID()}`,
        }),
      ),
    );

    // The explicit pointer: an external person's own workspace, and nothing
    // for anyone else.
    const pointer = (subject: string) =>
      withAccountRls(db, organizationId, (tx) =>
        externalPersonPersonalWorkspaceId(tx, { accountId: organizationId, subjectId: subject }),
      );
    expect(await pointer(person!.subjectId)).toBe(person!.personalWorkspaceId);
    expect(await pointer(someoneElse!.subjectId)).toBe(someoneElse!.personalWorkspaceId);
    expect(await pointer(ownerSubjectId)).toBeNull();

    // A request as this person in one workspace, as an app action makes it.
    const ask = async (workspaceId: string) => {
      const request = new Request(`${origin}/v1/workspaces/${workspaceId}`);
      stampWorkspacePersonAuthorization(request, {
        organizationId,
        workspaceId,
        subjectId: person!.subjectId,
        permissions: ["workspace:read"],
      });
      const response = await app.fetch(request);
      return { status: response.status, body: await response.text() };
    };
    expect((await ask(person!.personalWorkspaceId)).status).toBe(200);
    // A shared workspace they aren't a member of, and someone else's own
    // workspace, are refused.
    for (const elsewhere of [sharedWorkspaceId, someoneElse!.personalWorkspaceId]) {
      const refused = await ask(elsewhere);
      expect(refused.status).toBe(403);
      expect(refused.body).toContain("this person can no longer use this workspace");
    }
  });
});
