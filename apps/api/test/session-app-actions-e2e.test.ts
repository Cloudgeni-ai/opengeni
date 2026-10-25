import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AccessGrant } from "@opengeni/contracts";
import { turnAppActionGrant } from "@opengeni/core";
import {
  beginConnectorActionExecution,
  claimSessionWorkForAttempt,
  createDb,
  createManagedOrganization,
  createSession,
  prepareConnectorActionApproval,
  recordTurnAppActionGrant,
  setOrganizationAgentAdminAccess,
  submitHumanPromptInTransaction,
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

/* End to end through the real app and PostgreSQL, without full access: an
   ordinary chat a person started reads what they can see at once, and a change
   runs only after that same person confirmed exactly it in the chat. The API
   checks the confirmation itself; the chat's card is not the only guard. */

setDefaultTimeout(120_000);
const origin = "http://opengeni.test";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-app-actions-e2e");
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

describe("app actions in an ordinary chat end to end", () => {
  test("reads run, changes wait for the person's own confirmation of exactly them", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "session-app-actions-e2e-secret-32-bytes",
        publicBaseUrl: origin,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const db = client.db;
    const email = `app-actions-${crypto.randomUUID()}@example.test`;
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Maja Berg", email, password: "password1234" }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const [authUser] = await shared.admin<
      { id: string }[]
    >`select id from auth_users where email = ${email}`;
    const subjectId = `user:${authUser!.id}`;
    const created = await createManagedOrganization(db, {
      subjectId,
      subjectLabel: email,
      name: "Acme Robotics",
      operationId: crypto.randomUUID(),
    });
    const organizationId = created.organization.id;
    const workspaceId = created.workspaceId;

    // A chat the person started and the turn of the message they sent, with
    // what the API froze when it accepted that message.
    const chatTurn = async (frozen: TurnAppActionGrant | null) => {
      const session = await createSession(db, {
        accountId: organizationId,
        workspaceId,
        initialMessage: "invite my daughter",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
      });
      await withWorkspaceSubjectSessionActivityRls(db, workspaceId, subjectId, (scoped) =>
        scoped.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
            accountId: organizationId,
            workspaceId,
            sessionId: session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: `send-${crypto.randomUUID()}`,
            delivery: "send",
            text: "can my daughter see this too?",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
            ...(frozen
              ? {
                  captureTurnAuthority: async (captureTx: Database, turnId: string) =>
                    await recordTurnAppActionGrant(captureTx, {
                      accountId: organizationId,
                      workspaceId,
                      turnId,
                      grant: frozen,
                    }),
                }
              : {}),
          }),
        ),
      );
      const attemptId = crypto.randomUUID();
      const claim = await claimSessionWorkForAttempt(db, workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "next" },
      });
      if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
      const identity = {
        accountId: organizationId,
        workspaceId,
        sessionId: session.id,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
        initiator: claim.turn.initiator,
      };
      const handlers = new Map<string, Handler>();
      const grant = { accountId: organizationId, workspaceId } as AccessGrant;
      registerSessionAdminAccessTools({
        server: {
          registerTool: (name: string, _config: unknown, handler: Handler) => {
            handlers.set(name, handler);
          },
        } as never,
        db,
        grant,
        sessionId: session.id,
        attempt: { turnId: claim.turn.id, attemptId },
        reach: createSessionAdminReach({
          db,
          grant,
          sessionId: session.id,
          turnId: claim.turn.id,
          access: { origin, dispatch: async (request) => await app.fetch(request) },
          authorize: async () => undefined,
        }),
      });
      /** The person allows exactly `args` in the chat, and the attempt starts running it. */
      const allow = async (approvalId: string, args: unknown, signedIn = true) => {
        const ledgerCall = {
          approvalId,
          connectionId: `session-mcp:opengeni:${"0".repeat(64)}`,
          serverId: "opengeni",
          toolName: "admin_action_call",
          arguments: args,
          approvalMode: "session_mcp" as const,
          defaultDecision: "ask" as const,
          reviewContext: { kind: "generic" as const, title: "Make this change?" },
        };
        expect(await prepareConnectorActionApproval(db, identity, ledgerCall)).toMatchObject({
          decision: "ask",
        });
        const [event] = await shared.admin<{ id: string }[]>`
          select id from session_events where session_id = ${session.id}
          order by sequence desc limit 1`;
        await shared.admin`
          update connector_action_requests
          set status = 'approved', decision = 'approve', decision_by_subject_id = ${subjectId},
            decision_by_kind = 'human', decision_by_signed_in_person = ${signedIn},
            decision_event_id = ${event!.id}, decided_at = now(), updated_at = now()
          where turn_id = ${claim.turn.id} and approval_id = ${approvalId}`;
        expect(await beginConnectorActionExecution(db, identity, ledgerCall)).toMatchObject({
          allowed: true,
        });
      };
      return {
        call: handlers.get("admin_action_call")!,
        describeAction: handlers.get("admin_action_describe")!,
        allow,
      };
    };
    // Signed in to the app as the organization's owner: what the API freezes.
    const signedIn = turnAppActionGrant({
      grant: {
        accountId: organizationId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: ["workspace:admin"],
      } as AccessGrant,
      authorization: {
        grant: { accountId: organizationId, workspaceId, subjectId } as AccessGrant,
        accountGrant: {
          accountId: organizationId,
          subjectId,
          permissions: ["account:admin", "members:manage", "billing:read", "billing:manage"],
        },
        authenticatedSubjectId: subjectId,
        contextIntegrity: true,
        canonicalManagedHumanSession: true,
        canonicalLocalHumanSession: false,
      },
      delegatedSignInChangesEnabled: false,
    });
    expect(signedIn?.changes).toBe("confirm");
    const { call, describeAction, allow } = await chatTurn(signedIn);

    // A read runs at once and sees only what the person sees.
    const members = await call({
      id: "listWorkspaceMembers",
      pathParameters: { workspaceId },
      query: {},
    });
    expect(members.isError, textOf(members)).toBeUndefined();
    expect(JSON.parse(textOf(members))).toMatchObject({ status: 200 });
    const usage = await call({ id: "getMyUsage", pathParameters: { workspaceId }, query: {} });
    expect(JSON.parse(textOf(usage)), textOf(usage)).toMatchObject({ status: 200 });
    const described = JSON.parse(
      textOf(await describeAction({ id: "createOrganizationInvitation" })),
    );
    expect(described).toMatchObject({ changes: true });

    // A retired action runs nothing, so it needs no confirmation: describe and
    // call both name its replacement instead.
    const retiredId = "POST /v1/workspaces/:workspaceId/knowledge/search";
    const retiredDescribe = await describeAction({ id: retiredId });
    expect(retiredDescribe.isError).toBe(true);
    expect(textOf(retiredDescribe)).toContain("was removed. Use the ");
    const retiredCall = await call({
      id: retiredId,
      pathParameters: { workspaceId },
      query: {},
      body: { query: "x" },
    });
    expect(retiredCall.isError).toBe(true);
    expect(textOf(retiredCall)).toContain("was removed. Use the ");

    const invite = {
      id: "createOrganizationInvitation",
      pathParameters: { organizationId },
      query: {},
      body: {
        email: "anna@example.com",
        role: "member",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        operationId: crypto.randomUUID(),
      },
    };
    const invitations = async () =>
      await shared.admin`
        select id from organization_membership_invitations where account_id = ${organizationId}`;

    // A change nobody confirmed never runs, even when called directly.
    const unconfirmed = await call(invite);
    expect(unconfirmed.isError).toBe(true);
    expect(textOf(unconfirmed)).toStartWith("Nothing was run: this change needs a confirmation");
    // It names who must allow it, so an Allow from someone else ends the retries.
    expect(textOf(unconfirmed)).toContain("given in this chat where they are signed in");
    expect(await invitations()).toHaveLength(0);

    // The same identity allowing it through a key, chat integration or embed
    // token is not the person signed in to the app: nothing runs.
    const viaToken = { ...invite, body: { ...invite.body, email: "via-token@example.com" } };
    await allow("call-invite-via-token", viaToken, false);
    expect(textOf(await call(viaToken))).toStartWith(
      "Nothing was run: this change needs a confirmation",
    );
    expect(await invitations()).toHaveLength(0);

    // The person allows it in the chat; the attempt runs exactly that call.
    await allow("call-invite", invite);

    // Different arguments don't borrow that confirmation.
    const changed = await call({ ...invite, body: { ...invite.body, role: "owner" } });
    expect(textOf(changed)).toStartWith("Nothing was run: this change needs a confirmation");
    expect(await invitations()).toHaveLength(0);

    const confirmed = await call(invite);
    expect(confirmed.isError, textOf(confirmed)).toBeUndefined();
    expect(JSON.parse(textOf(confirmed)).status).toBeLessThan(300);
    expect(await invitations()).toHaveLength(1);

    // A secret never goes through the chat, even when the person allowed it.
    const apiKey = {
      id: "createApiKey",
      pathParameters: { workspaceId },
      query: {},
      body: { name: "chat key", permissions: ["workspace:read"] },
    };
    await allow("call-key", apiKey);
    const key = await call(apiKey);
    expect(key.isError).toBe(true);
    expect(textOf(key)).toStartWith("Nothing was run: this call creates, shows, copies");
    expect(
      await shared.admin`select id from api_keys where workspace_id = ${workspaceId}`,
    ).toHaveLength(0);

    // From an embed (a host-issued token naming this owner), changes never
    // run, confirmed or not, and reads stay within that token's access.
    const embedToken = {
      accountId: organizationId,
      workspaceId,
      subjectId,
      principalKind: "human_session",
      permissions: ["workspace:read", "sessions:create"],
      metadata: { delegated: true },
    } as AccessGrant;
    const embedAuthorization = {
      grant: embedToken,
      accountGrant: {
        accountId: organizationId,
        subjectId,
        permissions: ["workspace:read", "sessions:create"],
      },
      authenticatedSubjectId: subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: false,
      canonicalLocalHumanSession: false,
    } as const;
    const embedded = await chatTurn(
      turnAppActionGrant({
        grant: embedToken,
        authorization: embedAuthorization,
        delegatedSignInChangesEnabled: false,
      }),
    );
    const ownerInvite = {
      ...invite,
      body: {
        ...invite.body,
        email: "eve@example.com",
        role: "owner",
        operationId: crypto.randomUUID(),
      },
    };
    await embedded.allow("call-embed-invite", ownerInvite);
    const embeddedInvite = await embedded.call(ownerInvite);
    expect(textOf(embeddedInvite)).toStartWith("Nothing was run: this chat was opened through");
    expect(await invitations()).toHaveLength(1);

    // A deployment that opted its embeds in shows the card, but a confirmed
    // change still runs with the token's own access, never the person's full role.
    const optedIn = await chatTurn(
      turnAppActionGrant({
        grant: embedToken,
        authorization: embedAuthorization,
        delegatedSignInChangesEnabled: true,
      }),
    );
    await optedIn.allow("call-opted-in-invite", ownerInvite);
    const capped = await optedIn.call(ownerInvite);
    expect(capped.isError).toBe(true);
    expect(JSON.parse(textOf(capped)).status).toBe(403);
    expect(await invitations()).toHaveLength(1);

    // A message with nothing frozen (an API key or a service) acts as nobody.
    const unsigned = await chatTurn(null);
    const nobody = await unsigned.call({
      id: "listWorkspaceMembers",
      pathParameters: { workspaceId },
    });
    expect(textOf(nobody)).toStartWith("Nothing was run: this turn's message wasn't sent");

    // An owner can turn the in-chat route off; every call then says nothing ran.
    await setOrganizationAgentAdminAccess(db, {
      organizationId,
      actorSubjectId: subjectId,
      chatActionsAllowed: false,
    });
    const off = await call({ id: "listWorkspaceMembers", pathParameters: { workspaceId } });
    expect(off.isError).toBe(true);
    expect(textOf(off)).toStartWith("Nothing was run: this organization has turned off");
  });
});
