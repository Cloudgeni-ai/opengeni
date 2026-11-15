import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { Hono } from "hono";
import { createApp } from "../src/app";

// An organization's Anthropic API connection with several API keys, over real
// PostgreSQL as the application role, through the full application (managed
// browser sign-in, the organization administrator check, the origin check and
// the error envelope). Each added key is checked with Anthropic's free model
// listing first; that request goes through the injected fetch here.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "http://opengeni.test";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  sandboxBackend: "none",
  betterAuthSecret: "anthropic-api-key-route-secret-at-least-32-bytes",
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;

/** The keys the API checked with Anthropic's model listing. */
const checked: { url: string; apiKey: string | null; method: string }[] = [];

const signedIn = new Map<string, { authSessionId: string; userId: string; email: string }>();

function fullApp(): Hono {
  const noop = async () => undefined;
  return createApp({
    db: client!.db,
    bus: new MemoryEventBus(),
    settings,
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
    githubStateSecret: "anthropic-api-key-state-secret",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    claudeFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const apiKey = new Headers(init?.headers).get("x-api-key");
      checked.push({ url: String(input), apiKey, method: init?.method ?? "GET" });
      if (apiKey?.includes("refused")) return new Response("{}", { status: 401 });
      return new Response('{"data":[]}', {
        status: 200,
        headers: { "anthropic-organization-id": `org-${apiKey?.split("-").at(-1)}` },
      });
    }) as unknown as typeof fetch,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = signedIn.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "Managed human" },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps) as unknown as Hono;
}

type Human = { subjectId: string; email: string; cookie: string; accountId: string };

async function signIn(label: string, bootstrap: boolean): Promise<Human> {
  const userId = `anthropic-api-keys-${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  await shared!.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  let accountId = "";
  if (bootstrap) {
    const access = await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
      userId,
      email,
      name: label,
      emailVerified: true,
    });
    accountId = access.accessContext.workspaceGrants[0]!.accountId;
  }
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const cookie = `session=${authSessionId}`;
  signedIn.set(cookie, { authSessionId, userId, email });
  return { subjectId: `user:${userId}`, email, cookie, accountId };
}

/** A plain member of `owner`'s organization, through the real invitation lifecycle. */
async function memberOf(owner: Human): Promise<Human> {
  const signed = await signIn("member", false);
  const invitation = await createOrganizationInvitation(client!.db, {
    organizationId: owner.accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: signed.subjectId,
    targetEmail: signed.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client!.db, {
    organizationId: owner.accountId,
    actorSubjectId: signed.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return { ...signed, accountId: owner.accountId };
}

async function call(
  who: Human,
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  origin: string = ORIGIN,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await app!.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: who.cookie,
      "content-type": "application/json",
      origin,
      "sec-fetch-site": origin === ORIGIN ? "same-origin" : "cross-site",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const keysPath = (organizationId: string) =>
  `/v1/organizations/${organizationId}/model-providers/anthropic/api-keys`;

let owner: Human;
let member: Human;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-anthropic-api-keys");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
  app = fullApp();
  owner = await signIn("owner", true);
  member = await memberOf(owner);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe.skipIf(!realDb)("organization Anthropic API key routes", () => {
  test("MP-KEYS-09: keys are added beside the connection's own key, checked first, never shown", async () => {
    // Without an Anthropic API connection there is nothing to add a key to.
    expect((await call(owner, "GET", keysPath(owner.accountId))).status).toBe(404);
    expect(
      (
        await call(owner, "POST", keysPath(owner.accountId), {
          apiKey: "sk-ant-api03-early",
          label: "Early",
        })
      ).status,
    ).toBe(404);
    const connected = await call(
      owner,
      "PUT",
      `/v1/organizations/${owner.accountId}/model-providers/anthropic`,
      { operationId: crypto.randomUUID(), apiKey: "sk-ant-api03-first" },
    );
    expect(connected.status).toBe(200);
    const single = await call(owner, "GET", keysPath(owner.accountId));
    expect(single.json).toMatchObject({
      connectionVersion: 1,
      keys: [{ id: "primary-v1", label: null, connectionKey: true, creditRefusedAt: null }],
    });

    checked.length = 0;
    const added = await call(owner, "POST", keysPath(owner.accountId), {
      apiKey: "sk-ant-api03-second",
      label: "Second account",
    });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({
      label: "Second account",
      connectionKey: false,
      anthropicOrganizationId: "org-second",
      creditRefusedAt: null,
    });
    expect(JSON.stringify(added.json)).not.toContain("sk-ant");
    // One free model listing, with the key being added.
    expect(checked).toEqual([
      {
        url: "https://api.anthropic.com/v1/models?limit=1",
        apiKey: "sk-ant-api03-second",
        method: "GET",
      },
    ]);
    // The same key again is the same member.
    const again = await call(owner, "POST", keysPath(owner.accountId), {
      apiKey: "sk-ant-api03-second",
      label: "Again",
    });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(added.json.id);
    // The connection's own key, a key Anthropic refuses and a subscription token are refused.
    expect(
      (
        await call(owner, "POST", keysPath(owner.accountId), {
          apiKey: "sk-ant-api03-first",
          label: "Own",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(owner, "POST", keysPath(owner.accountId), {
          apiKey: "sk-ant-api03-refused",
          label: "Refused",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(owner, "POST", keysPath(owner.accountId), {
          apiKey: "sk-ant-oat01-subscription",
          label: "Subscription",
        })
      ).status,
    ).toBe(422);

    const listed = await call(owner, "GET", keysPath(owner.accountId));
    expect((listed.json.keys as { id: string }[]).map((key) => key.id)).toEqual([
      "primary-v1",
      added.json.id,
    ]);
    expect(JSON.stringify(listed.json)).not.toContain("sk-ant");
  });

  test("MP-KEYS-10: keys are renamed, let serve again and removed; the connection's own key stays", async () => {
    const listed = await call(owner, "GET", keysPath(owner.accountId));
    const second = (listed.json.keys as { id: string }[])[1]!.id;
    const renamed = await call(owner, "PATCH", `${keysPath(owner.accountId)}/${second}`, {
      label: "Renamed",
    });
    expect(renamed).toMatchObject({ status: 200, json: { id: second, label: "Renamed" } });
    const again = await call(owner, "POST", `${keysPath(owner.accountId)}/${second}/serve-again`);
    expect(again).toMatchObject({ status: 200, json: { id: second, creditRefusedAt: null } });
    expect(
      (await call(owner, "POST", `${keysPath(owner.accountId)}/missing/serve-again`)).status,
    ).toBe(404);
    expect((await call(owner, "DELETE", `${keysPath(owner.accountId)}/primary-v1`)).status).toBe(
      409,
    );
    expect((await call(owner, "DELETE", `${keysPath(owner.accountId)}/${second}`)).status).toBe(
      204,
    );
    const after = await call(owner, "GET", keysPath(owner.accountId));
    expect((after.json.keys as { id: string }[]).map((key) => key.id)).toEqual(["primary-v1"]);
  });

  test("MP-KEYS-11: members can't read or add keys; cross-site writes are refused", async () => {
    expect((await call(member, "GET", keysPath(owner.accountId))).status).toBe(403);
    expect(
      (
        await call(member, "POST", keysPath(owner.accountId), {
          apiKey: "sk-ant-api03-member",
          label: "Member",
        })
      ).status,
    ).toBe(403);
    const crossSite = await call(
      owner,
      "POST",
      keysPath(owner.accountId),
      { apiKey: "sk-ant-api03-cross", label: "Cross" },
      "https://attacker.example",
    );
    expect(crossSite.status).toBe(403);
  });
});
