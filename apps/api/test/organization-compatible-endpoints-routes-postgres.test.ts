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

// An organization's own OpenAI-compatible endpoints over real PostgreSQL as
// the application role, through the full application (managed browser
// sign-in, the organization administrator check, the origin check and the
// error envelope). Each endpoint is checked with one test request before it
// is saved; that request goes through the injected fetch here.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "http://opengeni.test";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  sandboxBackend: "none",
  betterAuthSecret: "compatible-endpoint-route-secret-at-least-32-bytes",
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;

/** Test requests the API sent to endpoints: URL and bearer key. */
const checks: { url: string; authorization: string | null; model: string }[] = [];
let endpointAnswers = 200;

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
    githubStateSecret: "compatible-endpoint-state-secret",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    directModelFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { model: string };
      checks.push({
        url: String(input),
        authorization: headers.get("authorization"),
        model: body.model,
      });
      return new Response(
        JSON.stringify(
          endpointAnswers === 200
            ? { choices: [{ message: { role: "assistant", content: "OK" } }] }
            : { error: { message: "invalid key" } },
        ),
        { status: endpointAnswers, headers: { "content-type": "application/json" } },
      );
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
  const userId = `compatible-endpoint-${label}-${crypto.randomUUID()}`;
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
  method: "GET" | "PUT" | "POST" | "DELETE",
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
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

const endpointsPath = (organizationId: string) =>
  `/v1/organizations/${organizationId}/model-providers/openai_compatible/endpoints`;

let owner: Human;
let member: Human;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-compatible-endpoints");
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

describe.skipIf(!realDb)("organization OpenAI-compatible endpoint routes", () => {
  test("an owner connects two endpoints; each is checked first and listed with its model", async () => {
    checks.length = 0;
    const first = await call(owner, "POST", endpointsPath(owner.accountId), {
      operationId: crypto.randomUUID(),
      baseUrl: "https://inference.example.com/v1",
      apiKey: "sk-first",
      model: "acme/fast-1",
      label: "Acme",
    });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      status: "active",
      baseUrl: "https://inference.example.com/v1",
      api: "chat",
      label: "Acme",
      models: [{ upstreamModelId: "acme/fast-1" }],
    });
    expect(JSON.stringify(first.json)).not.toContain("sk-first");
    const second = await call(owner, "POST", endpointsPath(owner.accountId), {
      operationId: crypto.randomUUID(),
      baseUrl: "https://models.example.org/v1",
      apiKey: "sk-second",
      model: "coder:7b",
    });
    expect(second.status).toBe(201);
    expect(checks).toEqual([
      {
        url: "https://inference.example.com/v1/chat/completions",
        authorization: "Bearer sk-first",
        model: "acme/fast-1",
      },
      {
        url: "https://models.example.org/v1/chat/completions",
        authorization: "Bearer sk-second",
        model: "coder:7b",
      },
    ]);

    const added = await call(
      owner,
      "POST",
      `${endpointsPath(owner.accountId)}/${first.json.id}/models`,
      { operationId: crypto.randomUUID(), upstreamModelId: "acme/large-2" },
    );
    expect(added.status).toBe(201);
    expect(checks.at(-1)).toMatchObject({
      authorization: "Bearer sk-first",
      model: "acme/large-2",
    });

    const listed = await call(owner, "GET", endpointsPath(owner.accountId));
    expect(listed.status).toBe(200);
    const byId = new Map(
      (listed.json.endpoints as { id: string; models: { upstreamModelId: string }[] }[]).map(
        (endpoint) => [endpoint.id, endpoint.models.map((model) => model.upstreamModelId).sort()],
      ),
    );
    expect(byId.get(first.json.id)).toEqual(["acme/fast-1", "acme/large-2"]);
    expect(byId.get(second.json.id)).toEqual(["coder:7b"]);
  });

  test("an endpoint that refuses the test request is not saved", async () => {
    const before = await call(owner, "GET", endpointsPath(owner.accountId));
    endpointAnswers = 401;
    try {
      const refused = await call(owner, "POST", endpointsPath(owner.accountId), {
        operationId: crypto.randomUUID(),
        baseUrl: "https://refuses.example.com/v1",
        apiKey: "sk-wrong",
        model: "any",
      });
      expect(refused.status).toBe(422);
    } finally {
      endpointAnswers = 200;
    }
    const after = await call(owner, "GET", endpointsPath(owner.accountId));
    expect(after.json.endpoints).toHaveLength(before.json.endpoints.length);
  });

  test("only public HTTPS base URLs are accepted, and nothing is sent to others", async () => {
    const sent = checks.length;
    for (const baseUrl of [
      "http://inference.example.com/v1",
      "https://127.0.0.1/v1",
      "https://user:pass@inference.example.com/v1",
    ]) {
      const response = await call(owner, "POST", endpointsPath(owner.accountId), {
        operationId: crypto.randomUUID(),
        baseUrl,
        apiKey: "sk-x",
        model: "any",
      });
      expect(response.status).toBe(422);
    }
    expect(checks).toHaveLength(sent);
  });

  test("members can't read or connect endpoints; cross-site writes are refused", async () => {
    expect((await call(member, "GET", endpointsPath(owner.accountId))).status).toBe(403);
    const memberCreate = await call(member, "POST", endpointsPath(owner.accountId), {
      operationId: crypto.randomUUID(),
      baseUrl: "https://inference.example.com/v1",
      apiKey: "sk-member",
      model: "any",
    });
    expect(memberCreate.status).toBe(403);
    const crossSite = await call(
      owner,
      "POST",
      endpointsPath(owner.accountId),
      {
        operationId: crypto.randomUUID(),
        baseUrl: "https://inference.example.com/v1",
        apiKey: "sk-x",
        model: "any",
      },
      "https://attacker.example",
    );
    expect(crossSite.status).toBe(403);
    const stranger = await signIn("stranger", true);
    expect((await call(stranger, "GET", endpointsPath(owner.accountId))).status).toBe(403);
  });

  test("disconnecting one endpoint leaves the other", async () => {
    const listed = await call(owner, "GET", endpointsPath(owner.accountId));
    const [gone, kept] = listed.json.endpoints as { id: string; version: number }[];
    const revoked = await call(owner, "DELETE", `${endpointsPath(owner.accountId)}/${gone!.id}`, {
      operationId: crypto.randomUUID(),
      expectedVersion: gone!.version,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json.status).toBe("revoked");
    const after = await call(owner, "GET", endpointsPath(owner.accountId));
    expect((after.json.endpoints as { id: string }[]).map((endpoint) => endpoint.id)).toEqual([
      kept!.id,
    ]);
  });
});
