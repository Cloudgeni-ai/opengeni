/**
 * Nango connections against real PostgreSQL with FORCE RLS: completion stores
 * a verified connection with the scopes Nango reports; reconnecting the same
 * account reuses its row and deletes the replaced Nango connection, while a
 * different account is a new row; the signed webhook marks a connection as
 * needing reconnection only when Nango still reports the failure, and revokes
 * it on deletion; disconnecting deletes the Nango connection; and the usage
 * API refuses another organization.
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  effectiveNangoIntegrations,
  nangoAttemptTags,
  signDelegatedAccessToken,
  type IntegrationBackendSetting,
  type Permission,
} from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, getConnectionMetadata, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import {
  completeNangoConnect,
  deleteNangoConnectionFor,
  handleNangoWebhook,
  readNangoConnectState,
} from "../src/integrations/nango-connect";

const SIGNING_KEY = "nango-webhook-signing-key";
const delegationSecret = randomBytes(32).toString("hex");
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret,
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
  integrationsEnabled: true,
  integrationsStateSecret: "nango-postgres-state-secret",
  publicBaseUrl: "https://api.opengeni.test",
  webBaseUrl: "https://app.opengeni.test",
  nangoSecretKey: "nango-secret-test",
  nangoApiBaseUrl: "https://nango.test",
  nangoWebhookSigningKey: SIGNING_KEY,
}) as Settings;

const gmailSetting: IntegrationBackendSetting = {
  integrationKey: "gmail",
  backend: "nango",
  providerConfigKey: "google-mail",
  enabled: true,
  definition: null,
  revision: 1,
  changedAt: "2026-11-13T00:00:00.000Z",
};
const backends = effectiveNangoIntegrations([gmailSetting], true);

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-nango");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Owner = { accountId: string; workspaceId: string; subjectId: string };

async function owner(name: string): Promise<Owner> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: name,
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: `${name} workspace`,
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  // A member of the organization, as every person connecting an account is.
  await shared!.admin`insert into organization_memberships
      (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'active', ${grant.workspaceId!})
    on conflict do nothing`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

/** A fake Nango: connections by attempt, each with its account email and reported scopes. */
function fakeNango() {
  type Remote = {
    connectionId: string;
    tags: Record<string, string>;
    email: string;
    scope: string;
    authErrors: number;
    /** GET /connections/{id} refreshes the token; Nango answers 424 when that fails. */
    refreshFails?: boolean;
  };
  const remote: Remote[] = [];
  const requests: Array<{ method: string; url: URL }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    const headers = new Headers(init?.headers);
    if (url.pathname === "/connections" && method === "GET") {
      const connectionId = url.searchParams.get("connectionId");
      const wantedTags = [...url.searchParams.entries()]
        .filter(([key]) => key.startsWith("tags["))
        .map(([key, value]) => [key.slice(5, -1), value] as const);
      return Response.json({
        connections: remote
          .filter(
            (entry) =>
              (!connectionId || entry.connectionId === connectionId) &&
              wantedTags.every(([key, value]) => entry.tags[key] === value),
          )
          .map((entry) => ({
            connection_id: entry.connectionId,
            provider_config_key: "google-mail",
            provider: "google-mail",
            created: "2026-11-13T00:00:00.000Z",
            tags: entry.tags,
            errors: Array.from({ length: entry.authErrors }, () => ({ type: "auth" })),
          })),
      });
    }
    const single = /^\/connections\/([^/]+)$/u.exec(url.pathname);
    if (single && method === "GET") {
      const entry = remote.find((candidate) => candidate.connectionId === single[1]);
      if (entry?.refreshFails)
        return Response.json(
          { error: { code: "refresh_exhausted", message: "Connection refresh exhausted" } },
          { status: 424 },
        );
      return entry
        ? Response.json({
            connection_id: entry.connectionId,
            provider_config_key: url.searchParams.get("provider_config_key"),
            provider: "google-mail",
            created_at: "2026-11-13T00:00:00.000Z",
            tags: entry.tags,
            errors: Array.from({ length: entry.authErrors }, () => ({ type: "auth" })),
            credentials: { type: "OAUTH2", raw: { scope: entry.scope } },
          })
        : new Response("", { status: 404 });
    }
    if (single && method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/proxy/gmail/v1/users/me/profile") {
      const entry = remote.find(
        (candidate) => candidate.connectionId === headers.get("connection-id"),
      );
      return entry
        ? Response.json({ emailAddress: entry.email })
        : new Response("", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { remote, requests, fetchImpl };
}

async function signedState(target: Owner): Promise<string> {
  const { createSignedState } = await import("@opengeni/github");
  return createSignedState(settings.integrationsStateSecret!, {
    kind: "nango_connect",
    ...target,
    personalOwnerVerified: true,
    ownership: "personal",
    integrationKey: "gmail",
    providerConfigKey: "google-mail",
    providerDomain: "nango:gmail",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    returnPath: `/workspaces/${target.workspaceId}/integrations`,
    browserProof: "none",
  });
}

async function connect(
  target: Owner,
  nango: ReturnType<typeof fakeNango>,
  connectionId: string,
  email: string,
  scope = "https://www.googleapis.com/auth/gmail.readonly",
) {
  const token = await signedState(target);
  const state = readNangoConnectState(settings, token);
  nango.remote.push({
    connectionId,
    tags: nangoAttemptTags({ ...target, attemptId: state.nonce, integrationKey: "gmail" }),
    email,
    scope,
    authErrors: 0,
  });
  return await completeNangoConnect(
    { db: client.db, settings, fetchImpl: nango.fetchImpl, nangoBackends: async () => backends },
    { state: token, browser: { bindingDigests: [], signedInSubjectId: null } },
  );
}

async function nangoRows(target: Owner) {
  return (
    await shared!.admin<
      Array<{
        id: string;
        status: string;
        granted_scopes: string[];
        nango_connection_id: string;
        email: string;
      }>
    >`select id, status, granted_scopes, metadata->>'nangoConnectionId' as nango_connection_id,
        metadata->>'accountEmail' as email
      from connections
      where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'
      order by created_at, id`
  ).map((row) => ({ ...row }));
}

function webhook(target: Owner, connectionId: string, body: Record<string, unknown>) {
  const rawBody = JSON.stringify({
    type: "auth",
    connectionId,
    providerConfigKey: "google-mail",
    tags: nangoAttemptTags({ ...target, attemptId: "attempt", integrationKey: "gmail" }),
    ...body,
  });
  return {
    rawBody,
    signature: createHmac("sha256", SIGNING_KEY).update(rawBody).digest("hex"),
  };
}

describe("Nango connections in PostgreSQL", () => {
  test("completion stores reported scopes; same account reuses, another account adds", async () => {
    if (!shared) return;
    const target = await owner("nango completion");
    const nango = fakeNango();
    expect((await connect(target, nango, "nc-1", "person@example.com")).status).toBe("complete");
    let rows = await nangoRows(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "active",
      nango_connection_id: "nc-1",
      email: "person@example.com",
      granted_scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    // The page and the webhook may both finish one attempt: idempotent.
    const firstId = rows[0]!.id;

    // Reconnecting the same account keeps its row and deletes the old Nango connection.
    await connect(target, nango, "nc-2", "person@example.com", "https://mail.google.com/");
    rows = await nangoRows(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: firstId,
      nango_connection_id: "nc-2",
      granted_scopes: ["https://mail.google.com/"],
    });
    expect(
      nango.requests.some(
        (request) => request.method === "DELETE" && request.url.pathname === "/connections/nc-1",
      ),
    ).toBe(true);

    // A different account is a second connection.
    await connect(target, nango, "nc-3", "other@example.com");
    rows = await nangoRows(target);
    expect(rows.map((row) => row.nango_connection_id)).toEqual(["nc-2", "nc-3"]);
  });

  test("the webhook acts on what Nango reports now, and revokes on deletion", async () => {
    if (!shared) return;
    const target = await owner("nango webhook");
    const nango = fakeNango();
    await connect(target, nango, "nw-1", "hook@example.com");
    const deps = {
      db: client.db,
      settings,
      fetchImpl: nango.fetchImpl,
      nangoBackends: async () => backends,
    };
    // A replayed failure while Nango reports the connection healthy changes nothing.
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nw-1", { operation: "refresh", success: false }),
      ),
    ).toBe("ignored");
    expect((await nangoRows(target))[0]!.status).toBe("active");
    nango.remote[0]!.authErrors = 1;
    nango.remote[0]!.refreshFails = true;
    const singleReadsBefore = nango.requests.filter(
      (request) => request.method === "GET" && request.url.pathname === "/connections/nw-1",
    ).length;
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nw-1", { operation: "refresh", success: false }),
      ),
    ).toBe("needs_reauth");
    expect((await nangoRows(target))[0]!.status).toBe("needs_reauth");
    // The re-check reads the list (errors, no refresh), never the refreshing single read.
    expect(
      nango.requests.filter(
        (request) => request.method === "GET" && request.url.pathname === "/connections/nw-1",
      ).length,
    ).toBe(singleReadsBefore);
    nango.remote[0]!.authErrors = 0;
    nango.remote[0]!.refreshFails = false;
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nw-1", { operation: "refresh", success: true }),
      ),
    ).toBe("recovered");
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nw-1", { operation: "deletion", success: true }),
      ),
    ).toBe("deleted");
    expect((await nangoRows(target))[0]!.status).toBe("revoked");
  });

  test("the creation webhook finalizes an attempt the page did not finish", async () => {
    if (!shared) return;
    const target = await owner("nango finalizer");
    const nango = fakeNango();
    const tags = nangoAttemptTags({ ...target, attemptId: "closed-page", integrationKey: "gmail" });
    nango.remote.push({
      connectionId: "nf-1",
      tags,
      email: "late@example.com",
      scope: "https://mail.google.com/",
      authErrors: 0,
    });
    const deps = {
      db: client.db,
      settings,
      fetchImpl: nango.fetchImpl,
      nangoBackends: async () => backends,
    };
    // Tags Nango reports for the connection must match the signed webhook's.
    const forged = nangoAttemptTags({ ...target, attemptId: "other", integrationKey: "gmail" });
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nf-1", { operation: "creation", success: true, tags: forged }),
      ),
    ).toBe("unknown_connection");
    expect(await nangoRows(target)).toHaveLength(0);
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nf-1", { operation: "creation", success: true, tags }),
      ),
    ).toBe("finalized");
    expect(await nangoRows(target)).toMatchObject([
      { status: "active", nango_connection_id: "nf-1", email: "late@example.com" },
    ]);
    // It reads the one connection with the documented endpoint, never list filters.
    expect(
      nango.requests.some(
        (request) =>
          request.method === "GET" &&
          request.url.pathname === "/connections/nf-1" &&
          request.url.searchParams.get("provider_config_key") === "google-mail",
      ),
    ).toBe(true);
    expect(
      nango.requests.some(
        (request) =>
          request.url.pathname === "/connections" && request.url.searchParams.has("connectionId"),
      ),
    ).toBe(false);
  });

  test("a connection Nango cannot refresh (424) is never stored", async () => {
    if (!shared) return;
    const target = await owner("nango refresh exhausted");
    const nango = fakeNango();
    const token = await signedState(target);
    const state = readNangoConnectState(settings, token);
    const tags = nangoAttemptTags({ ...target, attemptId: state.nonce, integrationKey: "gmail" });
    nango.remote.push({
      connectionId: "nx-1",
      tags,
      email: "stale@example.com",
      scope: "https://mail.google.com/",
      authErrors: 1,
      refreshFails: true,
    });
    const deps = {
      db: client.db,
      settings,
      fetchImpl: nango.fetchImpl,
      nangoBackends: async () => backends,
    };
    // The backup finalizer ignores it.
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nx-1", { operation: "creation", success: true, tags }),
      ),
    ).toBe("unknown_connection");
    // The page's completion refuses it and stops its Nango billing.
    await expect(
      completeNangoConnect(deps, {
        state: token,
        browser: { bindingDigests: [], signedInSubjectId: null },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await nangoRows(target)).toHaveLength(0);
    expect(
      nango.requests.some(
        (request) => request.method === "DELETE" && request.url.pathname === "/connections/nx-1",
      ),
    ).toBe(true);
  });

  test("disconnecting deletes the connection in Nango", async () => {
    if (!shared) return;
    const target = await owner("nango disconnect");
    const nango = fakeNango();
    await connect(target, nango, "nd-1", "bye@example.com");
    const [row] = await nangoRows(target);
    const connection = await getConnectionMetadata(
      client.db,
      target.workspaceId,
      row!.id,
      target.subjectId,
    );
    expect(connection).not.toBeNull();
    await deleteNangoConnectionFor(
      { db: client.db, settings, fetchImpl: nango.fetchImpl },
      connection!,
    );
    expect(
      nango.requests.some(
        (request) => request.method === "DELETE" && request.url.pathname === "/connections/nd-1",
      ),
    ).toBe(true);
  });

  test("the usage API reads one's own organization and refuses another", async () => {
    if (!shared) return;
    const mine = await owner("nango usage mine");
    const theirs = await owner("nango usage theirs");
    const app = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    } as never);
    const permissions: Permission[] = ["billing:read", "connections:read"];
    const token = await signDelegatedAccessToken(delegationSecret, {
      ...mine,
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const read = (accountId: string) =>
      app.request(`/v1/billing/integration-usage?accountId=${accountId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const own = await read(mine.accountId);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ rows: [], totals: { proxyRequests: 0 } });
    expect((await read(theirs.accountId)).status).toBe(403);
  });
});
