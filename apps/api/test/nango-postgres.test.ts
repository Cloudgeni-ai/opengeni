/**
 * Nango connections against real PostgreSQL with FORCE RLS: completion stores
 * a verified connection with the scopes Nango reports; reconnecting the same
 * account reuses its row and deletes the replaced Nango connection, while a
 * different account is a new row; the signed webhook marks a connection as
 * needing reconnection only when Nango still reports the failure, and revokes
 * it on deletion; disconnecting deletes the Nango connection; the same
 * account in several organizations shares one Nango connection, deleted only
 * with its last row; the sweep deletes what no row stands for, duplicates and
 * connections Nango can no longer refresh; and the usage API refuses another
 * organization.
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  effectiveNangoIntegrations,
  NANGO_DEPLOYMENT_TAG,
  nangoAttemptTags,
  signDelegatedAccessToken,
  type IntegrationBackendSetting,
  type Permission,
} from "@opengeni/contracts";
import { sweepNangoConnections } from "@opengeni/core";
import {
  bootstrapWorkspace,
  connectionAccountIdentityKey,
  createDb,
  getConnectionMetadata,
  loadConnectionCredentialForBroker,
  revokeConnection,
  type DbClient,
} from "@opengeni/db";
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

/** The tags Nango copies from this deployment's connect session onto a connection. */
function attemptTags(target: Owner, attemptId: string): Record<string, string> {
  return {
    ...nangoAttemptTags({ ...target, attemptId, integrationKey: "gmail" }),
    [NANGO_DEPLOYMENT_TAG]: "https://api.opengeni.test",
  };
}

/** A new organization and workspace; `subjectId` makes the same person a member of another one. */
async function owner(name: string, subjectId?: string): Promise<Owner> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: name,
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: `${name} workspace`,
    subjectId: subjectId ?? `user:${suffix}`,
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
    created?: string;
    /** The status the account-identity read answers with instead of the profile. */
    identityStatus?: number;
    /** The status GET /connections/{id} (the scope read) answers with instead. */
    scopeStatus?: number;
    /** Left out of every GET /connections listing, yet readable by id. */
    unlisted?: boolean;
  };
  const remote: Remote[] = [];
  /** Nango connection ids whose deletion fails. */
  const failDeletes = new Set<string>();
  /** Runs before each delete, for example to read what other sessions see then. */
  const beforeDelete: Array<(connectionId: string) => Promise<void>> = [];
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
              !entry.unlisted &&
              (!connectionId || entry.connectionId === connectionId) &&
              wantedTags.every(([key, value]) => entry.tags[key] === value),
          )
          .map((entry) => ({
            connection_id: entry.connectionId,
            provider_config_key: "google-mail",
            provider: "google-mail",
            created: entry.created ?? "2026-11-13T00:00:00.000Z",
            tags: entry.tags,
            errors: Array.from({ length: entry.authErrors }, () => ({ type: "auth" })),
          })),
      });
    }
    const single = /^\/connections\/([^/]+)$/u.exec(url.pathname);
    if (single && method === "GET") {
      const entry = remote.find((candidate) => candidate.connectionId === single[1]);
      if (entry?.scopeStatus) return new Response("", { status: entry.scopeStatus });
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
    if (single && method === "DELETE") {
      for (const hook of beforeDelete) await hook(single[1]!);
      if (failDeletes.has(single[1]!)) return new Response("unavailable", { status: 503 });
      const index = remote.findIndex((candidate) => candidate.connectionId === single[1]);
      if (index >= 0) remote.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/proxy/gmail/v1/users/me/profile") {
      const entry = remote.find(
        (candidate) => candidate.connectionId === headers.get("connection-id"),
      );
      if (entry?.identityStatus) return new Response("", { status: entry.identityStatus });
      return entry
        ? Response.json({ emailAddress: entry.email })
        : new Response("", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const deleted = (connectionId: string) =>
    requests.some(
      (request) =>
        request.method === "DELETE" && request.url.pathname === `/connections/${connectionId}`,
    );
  return { remote, requests, failDeletes, beforeDelete, deleted, fetchImpl };
}

/** What another session sees each row of `target` stand for when a delete starts. */
function committedAtDelete(nango: ReturnType<typeof fakeNango>, target: Owner) {
  const seen: Record<string, Array<string | null>> = {};
  nango.beforeDelete.push(async (connectionId) => {
    const rows = await shared!.admin<Array<{ id: string | null }>>`
      select metadata ->> 'nangoConnectionId' as id from connections
      where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'`;
    seen[connectionId] = rows.map((row) => row.id);
  });
  return seen;
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
    tags: attemptTags(target, state.nonce),
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
        account_identity_key: string | null;
      }>
    >`select id, status, granted_scopes, metadata->>'nangoConnectionId' as nango_connection_id,
        metadata->>'accountEmail' as email, account_identity_key
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

/** As the disconnect route: revoke the row, then delete its Nango connection. */
async function disconnect(
  target: Owner,
  connectionId: string,
  nango: ReturnType<typeof fakeNango>,
) {
  const connection = await getConnectionMetadata(
    client.db,
    target.workspaceId,
    connectionId,
    target.subjectId,
  );
  expect(connection).not.toBeNull();
  expect(
    await revokeConnection(
      client.db,
      target.workspaceId,
      connectionId,
      target.subjectId,
      connection!.version,
    ),
  ).not.toBeNull();
  await deleteNangoConnectionFor(
    { db: client.db, settings, fetchImpl: nango.fetchImpl },
    connection!,
  );
}

function sweepDeps(nango: ReturnType<typeof fakeNango>) {
  return { db: client.db, settings, fetchImpl: nango.fetchImpl };
}

/**
 * As an older release left it: `target`'s row of `email` on its own Nango
 * connection `id` (metadata and stored credential both), which Nango has.
 */
async function leaveRowOn(
  target: Owner,
  id: string,
  nango: ReturnType<typeof fakeNango>,
  email: string,
) {
  if (!nango.remote.some((entry) => entry.connectionId === id))
    nango.remote.push({
      connectionId: id,
      tags: attemptTags(target, "older"),
      email,
      scope: "",
      authErrors: 0,
      created: "2026-11-01T00:00:00.000Z",
    });
  const { decryptEnvironmentValue, encryptEnvironmentValue } = await import("@opengeni/db");
  const { environmentsEncryptionKeyBytes } = await import("@opengeni/config");
  const key = environmentsEncryptionKeyBytes(settings)!;
  const [stored] = await shared!.admin<Array<{ id: string; credential_encrypted: string }>>`
    select id, credential_encrypted from connections
    where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'
      and lower(metadata ->> 'accountEmail') = ${email}`;
  const credential = encryptEnvironmentValue(
    key,
    JSON.stringify({
      ...JSON.parse(decryptEnvironmentValue(key, stored!.credential_encrypted)),
      nangoConnectionId: id,
    }),
  );
  await shared!.admin`update connections
    set metadata = jsonb_set(metadata, '{nangoConnectionId}', to_jsonb(${id}::text)),
      credential_encrypted = ${credential}
    where id = ${stored!.id}`;
}

const HOUR = 60 * 60 * 1000;

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
    // Each carries its verified account's key, so the database itself refuses
    // a second live row of one account for this person.
    expect(rows.map((row) => row.account_identity_key)).toEqual([
      connectionAccountIdentityKey(["nango", "google-mail", "person@example.com"]),
      connectionAccountIdentityKey(["nango", "google-mail", "other@example.com"]),
    ]);
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
    // The page's completion refuses it and stops its Nango billing.
    await expect(
      completeNangoConnect(deps, {
        state: token,
        browser: { bindingDigests: [], signedInSubjectId: null },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await nangoRows(target)).toHaveLength(0);
    expect(nango.deleted("nx-1")).toBe(true);
    // The backup finalizer does not store it either, and stops its billing too.
    const closedTags = nangoAttemptTags({
      ...target,
      attemptId: "closed",
      integrationKey: "gmail",
    });
    nango.remote.push({
      connectionId: "nx-2",
      tags: closedTags,
      email: "stale@example.com",
      scope: "https://mail.google.com/",
      authErrors: 1,
      refreshFails: true,
    });
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nx-2", { operation: "creation", success: true, tags: closedTags }),
      ),
    ).toBe("unknown_connection");
    expect(await nangoRows(target)).toHaveLength(0);
    expect(nango.deleted("nx-2")).toBe(true);
  });

  test("disconnecting deletes the connection in Nango", async () => {
    if (!shared) return;
    const target = await owner("nango disconnect");
    const nango = fakeNango();
    await connect(target, nango, "nd-1", "bye@example.com");
    const [row] = await nangoRows(target);
    await disconnect(target, row!.id, nango);
    expect(nango.deleted("nd-1")).toBe(true);
  });

  test("a refused finalize stops the connection's billing", async () => {
    if (!shared) return;
    const target = await owner("nango refused");
    // Not a member of the workspace the tags name: never stored.
    const stranger = { ...target, subjectId: `user:${crypto.randomUUID()}` };
    const nango = fakeNango();
    const tags = nangoAttemptTags({ ...stranger, attemptId: "refused", integrationKey: "gmail" });
    nango.remote.push({
      connectionId: "nr-1",
      tags,
      email: "stranger@example.com",
      scope: "https://mail.google.com/",
      authErrors: 0,
    });
    await expect(
      handleNangoWebhook(
        {
          db: client.db,
          settings,
          fetchImpl: nango.fetchImpl,
          nangoBackends: async () => backends,
        },
        webhook(stranger, "nr-1", { operation: "creation", success: true, tags }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await nangoRows(target)).toHaveLength(0);
    expect(nango.deleted("nr-1")).toBe(true);
  });

  test("the same account in two organizations shares one Nango connection", async () => {
    if (!shared) return;
    const first = await owner("nango share first");
    const second = await owner("nango share second", first.subjectId);
    const nango = fakeNango();
    await connect(first, nango, "ns-1", "shared@example.com");
    const seen = committedAtDelete(nango, first);
    // The same person connects the same account in another organization: its
    // own row there, but the first organization's row now stands for the new
    // Nango connection too, and the old one is deleted.
    await connect(
      second,
      nango,
      "ns-2",
      "shared@example.com",
      "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/",
    );
    const [firstRow] = await nangoRows(first);
    const [secondRow] = await nangoRows(second);
    // Each organization keeps what was consented there.
    expect(firstRow).toMatchObject({
      status: "active",
      nango_connection_id: "ns-2",
      granted_scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    expect(secondRow).toMatchObject({ status: "active", nango_connection_id: "ns-2" });
    expect(nango.deleted("ns-1")).toBe(true);
    // Deleted only after the repoint was committed.
    expect(seen["ns-1"]).toEqual(["ns-2"]);
    expect(nango.remote.map((entry) => entry.connectionId)).toEqual(["ns-2"]);
    // The stored credential names the shared connection, not only the metadata.
    const [credential] = await shared!.admin<Array<{ credential_encrypted: string }>>`
      select credential_encrypted from connections where id = ${firstRow!.id}`;
    const { decryptEnvironmentValue } = await import("@opengeni/db");
    const { environmentsEncryptionKeyBytes } = await import("@opengeni/config");
    expect(
      JSON.parse(
        decryptEnvironmentValue(
          environmentsEncryptionKeyBytes(settings)!,
          credential!.credential_encrypted,
        ),
      ),
    ).toMatchObject({ type: "nango", nangoConnectionId: "ns-2" });

    // Another account of the same person is never merged.
    await connect(second, nango, "ns-3", "other@example.com");
    expect((await nangoRows(first)).map((row) => row.nango_connection_id)).toEqual(["ns-2"]);
    expect(nango.deleted("ns-3")).toBe(false);

    // A refresh failure reaches every organization's row.
    nango.remote.find((entry) => entry.connectionId === "ns-2")!.authErrors = 1;
    const deps = {
      db: client.db,
      settings,
      fetchImpl: nango.fetchImpl,
      nangoBackends: async () => backends,
    };
    expect(
      await handleNangoWebhook(
        deps,
        webhook(second, "ns-2", { operation: "refresh", success: false }),
      ),
    ).toBe("needs_reauth");
    expect((await nangoRows(first))[0]!.status).toBe("needs_reauth");
    expect((await nangoRows(second))[0]!.status).toBe("needs_reauth");
    nango.remote.find((entry) => entry.connectionId === "ns-2")!.authErrors = 0;
    expect(
      await handleNangoWebhook(
        deps,
        webhook(second, "ns-2", { operation: "refresh", success: true }),
      ),
    ).toBe("recovered");
    expect((await nangoRows(first))[0]!.status).toBe("active");

    // Disconnecting in one organization keeps the connection the other uses;
    // the last disconnect deletes it.
    await disconnect(first, firstRow!.id, nango);
    expect(nango.deleted("ns-2")).toBe(false);
    expect((await nangoRows(second))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "ns-2",
    });
    await disconnect(second, secondRow!.id, nango);
    expect(nango.deleted("ns-2")).toBe(true);
  });

  test("the sweep deletes what no row stands for, and nothing else", async () => {
    if (!shared) return;
    const target = await owner("nango sweep orphans");
    const nango = fakeNango();
    const now = Date.now();
    const old = new Date(now - 3 * HOUR).toISOString();
    const tags = (attemptId: string) => attemptTags(target, attemptId);
    await connect(target, nango, "nso-live", "live@example.com");
    // Abandoned connects: one past any connect attempt, one still in progress.
    nango.remote.push(
      {
        connectionId: "nso-abandoned",
        tags: tags("a"),
        email: "x@example.com",
        scope: "",
        authErrors: 0,
        created: old,
      },
      {
        connectionId: "nso-young",
        tags: tags("b"),
        email: "y@example.com",
        scope: "",
        authErrors: 0,
        created: new Date(now).toISOString(),
      },
      // Made outside Opengeni: left to the operator.
      {
        connectionId: "nso-untagged",
        tags: {},
        email: "z@example.com",
        scope: "",
        authErrors: 0,
        created: old,
      },
      // Another deployment sharing this Nango environment: never this sweep's.
      {
        connectionId: "nso-other-deployment",
        tags: { ...tags("c"), [NANGO_DEPLOYMENT_TAG]: "https://other.opengeni.test" },
        email: "w@example.com",
        scope: "",
        authErrors: 0,
        created: old,
      },
    );
    // A row removed by an SQL cascade (workspace, organization or member removal).
    await connect(target, nango, "nso-cascaded", "cascaded@example.com");
    await shared!.admin`delete from connections
      where workspace_id = ${target.workspaceId} and metadata->>'nangoConnectionId' = 'nso-cascaded'`;
    // A replaced connection whose deletion failed at reconnect time.
    await connect(target, nango, "nso-replaced", "again@example.com");
    nango.failDeletes.add("nso-replaced");
    await connect(target, nango, "nso-replacement", "again@example.com");
    expect(nango.remote.some((entry) => entry.connectionId === "nso-replaced")).toBe(true);
    nango.failDeletes.clear();

    const result = await sweepNangoConnections(sweepDeps(nango), { now });
    expect(result?.deletedOrphans.sort()).toEqual([
      "nso-abandoned",
      "nso-cascaded",
      "nso-replaced",
    ]);
    expect(result?.orphanBreakerTripped).toBe(false);
    expect(nango.remote.map((entry) => entry.connectionId).sort()).toEqual([
      "nso-live",
      "nso-other-deployment",
      "nso-replacement",
      "nso-untagged",
      "nso-young",
    ]);
    expect((await nangoRows(target)).map((row) => row.status)).toEqual(["active", "active"]);
  });

  test("the sweep stops billing for a connection Nango can no longer refresh", async () => {
    if (!shared) return;
    const target = await owner("nango sweep broken");
    const nango = fakeNango();
    await connect(target, nango, "nsb-1", "broken@example.com");
    nango.remote[0]!.authErrors = 1;
    const deps = {
      db: client.db,
      settings,
      fetchImpl: nango.fetchImpl,
      nangoBackends: async () => backends,
    };
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nsb-1", { operation: "refresh", success: false }),
      ),
    ).toBe("needs_reauth");
    // Within the grace period Nango may still recover it.
    expect((await sweepNangoConnections(sweepDeps(nango)))?.deletedBroken).toEqual([]);
    const later = Date.now() + 25 * HOUR;
    expect((await sweepNangoConnections(sweepDeps(nango), { now: later }))?.deletedBroken).toEqual([
      "nsb-1",
    ]);
    // The row keeps asking to reconnect, also when Nango reports the deletion.
    expect(
      await handleNangoWebhook(
        deps,
        webhook(target, "nsb-1", { operation: "deletion", success: true }),
      ),
    ).toBe("ignored");
    expect((await nangoRows(target))[0]).toMatchObject({ status: "needs_reauth" });
    // Reconnecting the account brings it back on a new Nango connection.
    await connect(target, nango, "nsb-2", "broken@example.com");
    expect((await nangoRows(target))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "nsb-2",
    });
  });

  test("the sweep's breaker keeps everything when most connections look unused", async () => {
    if (!shared) return;
    const nango = fakeNango();
    for (let index = 0; index < 12; index += 1) {
      const person = await owner(`nango sweep breaker ${index}`);
      nango.remote.push({
        connectionId: `nsk-${index}`,
        tags: attemptTags(person, "gone"),
        email: `breaker-${index}@example.com`,
        scope: "",
        authErrors: 0,
        created: "2026-11-01T00:00:00.000Z",
      });
    }
    const result = await sweepNangoConnections(sweepDeps(nango));
    expect(result).toMatchObject({ orphanBreakerTripped: true, deletedOrphans: [] });
    expect(nango.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("a connection whose scopes Nango did not report never replaces a confirmed one", async () => {
    if (!shared) return;
    const first = await owner("nango unconfirmed first");
    const second = await owner("nango unconfirmed second", first.subjectId);
    const nango = fakeNango();
    await connect(first, nango, "fb-1", "fallback@example.com", "https://mail.google.com/");
    // The same account in another organization, granted read-only there, but
    // Nango's scope read fails: that row records the app's defaults (full
    // mail), which are not a grant and must not replace the first's.
    const token = await signedState(second);
    const state = readNangoConnectState(settings, token);
    nango.remote.push({
      connectionId: "fb-2",
      tags: attemptTags(second, state.nonce),
      email: "fallback@example.com",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      authErrors: 0,
      scopeStatus: 503,
    });
    await completeNangoConnect(
      { db: client.db, settings, fetchImpl: nango.fetchImpl, nangoBackends: async () => backends },
      { state: token, browser: { bindingDigests: [], signedInSubjectId: null } },
    );
    // The first organization keeps the connection that really holds its grant.
    expect((await nangoRows(first))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "fb-1",
    });
    expect(nango.deleted("fb-1")).toBe(false);
    expect(nango.remote.some((entry) => entry.connectionId === "fb-1")).toBe(true);
  });

  test("an email that changed only in case is the same account", async () => {
    if (!shared) return;
    const target = await owner("nango email case");
    const nango = fakeNango();
    await connect(target, nango, "ec-1", "case@example.com");
    await connect(target, nango, "ec-2", "Case@Example.com");
    const rows = await nangoRows(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", nango_connection_id: "ec-2" });
    expect(nango.deleted("ec-1")).toBe(true);
  });

  test("legacy duplicate rows of one owner end on one Nango connection", async () => {
    if (!shared) return;
    const target = await owner("nango legacy duplicates");
    const nango = fakeNango();
    await connect(target, nango, "ld-1", "legacy@example.com");
    await connect(target, nango, "ld-2", "other@example.com");
    // As saved before keys: a second, unkeyed row of the same owner and account.
    await shared!.admin`update connections
      set metadata = jsonb_set(metadata, '{accountEmail}', '"legacy@example.com"'),
        account_identity_key = null
      where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'
        and metadata ->> 'nangoConnectionId' = 'ld-2'`;
    const generations = async () =>
      (
        await shared!.admin<Array<{ authority_generation: number }>>`
          select authority_generation from connections
          where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'
          order by created_at, id`
      ).map((row) => Number(row.authority_generation));
    // Turns accepted on either row hold it at these generations.
    const accepted = await generations();
    // Reconnecting that account succeeds and leaves one billed connection.
    await connect(target, nango, "ld-3", "legacy@example.com");
    const rows = await nangoRows(target);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.nango_connection_id)).toEqual(["ld-3", "ld-3"]);
    expect(rows.every((row) => row.status === "active")).toBe(true);
    expect(nango.remote.map((entry) => entry.connectionId)).toEqual(["ld-3"]);
    // The duplicate shares the connection without the key, but it is the
    // same account: its accepted turns keep working too.
    expect(rows[1]!.account_identity_key).toBeNull();
    expect(await generations()).toEqual(accepted);
  });

  test("a row saved before the scope marker is no grant for another organization", async () => {
    if (!shared) return;
    const legacy = await owner("nango unmarked legacy");
    const fresh = await owner("nango unmarked fresh", legacy.subjectId);
    const nango = fakeNango();
    const both = "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/";
    await connect(legacy, nango, "um-1", "unmarked@example.com", both);
    // As saved before the marker: its stored scopes are the app's defaults,
    // while Google only granted read-only.
    await shared!.admin`update connections
      set metadata = metadata - 'nangoScopesConfirmed'
      where workspace_id = ${legacy.workspaceId} and provider_domain = 'nango:gmail'`;
    nango.remote.find((entry) => entry.connectionId === "um-1")!.scope =
      "https://www.googleapis.com/auth/gmail.readonly";
    // The same account connected read-only elsewhere, as Nango reports it.
    await connect(fresh, nango, "um-2", "unmarked@example.com");
    // The fresh row keeps its own, confirmed connection; the unmarked one
    // stays where it was, since nothing confirmed covers its scopes.
    expect((await nangoRows(fresh))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "um-2",
    });
    expect((await nangoRows(legacy))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "um-1",
    });
    expect(nango.deleted("um-2")).toBe(false);
    expect(nango.deleted("um-1")).toBe(false);
  });

  test("the sweep deletes a broken connection only after its repoints commit", async () => {
    if (!shared) return;
    const first = await owner("nango sweep broken commit first");
    const second = await owner("nango sweep broken commit second", first.subjectId);
    const nango = fakeNango();
    await connect(first, nango, "bc-1", "dup-commit@example.com");
    await connect(second, nango, "bc-2", "dup-commit@example.com");
    await leaveRowOn(first, "bc-1", nango, "dup-commit@example.com");
    // Another account of the same person whose connection Nango cannot refresh.
    await connect(first, nango, "bc-broken", "broken-commit@example.com");
    nango.remote.find((entry) => entry.connectionId === "bc-broken")!.authErrors = 1;
    expect(
      await handleNangoWebhook(
        {
          db: client.db,
          settings,
          fetchImpl: nango.fetchImpl,
          nangoBackends: async () => backends,
        },
        webhook(first, "bc-broken", { operation: "refresh", success: false }),
      ),
    ).toBe("needs_reauth");
    const seen = committedAtDelete(nango, first);
    const result = await sweepNangoConnections(sweepDeps(nango), {
      now: Date.now() + 25 * HOUR,
    });
    expect(result).toMatchObject({
      repointed: 1,
      deletedDuplicates: ["bc-1"],
      deletedBroken: ["bc-broken"],
    });
    // When the broken connection was deleted, the repoint was already visible.
    expect(seen["bc-broken"]).toContain("bc-2");
    expect(seen["bc-broken"]).not.toContain("bc-1");
  });

  test("the sweep asks rows whose Nango connection is gone to reconnect", async () => {
    if (!shared) return;
    const first = await owner("nango sweep missing first");
    const second = await owner("nango sweep missing second", first.subjectId);
    const nango = fakeNango();
    // One account only in the first organization, one in both.
    await connect(first, nango, "nm-alone", "alone@example.com");
    await connect(first, nango, "nm-1", "shared-missing@example.com");
    await connect(second, nango, "nm-2", "shared-missing@example.com");
    await leaveRowOn(first, "nm-1", nango, "shared-missing@example.com");
    // Deleted outside reference counting (an older release), with no webhook.
    for (const gone of ["nm-alone", "nm-1"]) {
      const index = nango.remote.findIndex((entry) => entry.connectionId === gone);
      nango.remote.splice(index, 1);
    }
    const result = await sweepNangoConnections(sweepDeps(nango));
    expect(result).toMatchObject({ markedMissing: 1, repointed: 1 });
    const rows = await shared!.admin<
      Array<{ email: string; status: string; last_error: string | null; nango: string }>
    >`select metadata ->> 'accountEmail' as email, status, last_error,
        metadata ->> 'nangoConnectionId' as nango
      from connections
      where workspace_id = ${first.workspaceId} and provider_domain = 'nango:gmail'
      order by metadata ->> 'accountEmail'`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      // No other connection stands for this account: it asks to reconnect.
      {
        email: "alone@example.com",
        status: "needs_reauth",
        last_error: "nango_connection_missing",
        nango: "nm-alone",
      },
      // A healthy connection of the same account covers it: moved there.
      { email: "shared-missing@example.com", status: "active", last_error: null, nango: "nm-2" },
    ]);
    expect((await nangoRows(second))[0]).toMatchObject({ status: "active" });
    // A second pass changes nothing more.
    expect(await sweepNangoConnections(sweepDeps(nango))).toMatchObject({
      markedMissing: 0,
      repointed: 0,
    });
  });

  test("a connection Nango still has is never taken for gone, even if a listing misses it", async () => {
    if (!shared) return;
    const target = await owner("nango sweep unlisted");
    const nango = fakeNango();
    await connect(target, nango, "nh-listed", "listed@example.com");
    await connect(target, nango, "nh-hidden", "hidden@example.com");
    // Nango's listings leave it out, but the connection itself still answers.
    nango.remote.find((entry) => entry.connectionId === "nh-hidden")!.unlisted = true;
    expect(await sweepNangoConnections(sweepDeps(nango))).toMatchObject({ markedMissing: 0 });
    expect((await nangoRows(target)).map((row) => row.status)).toEqual(["active", "active"]);
  });

  test("once granted, the sweep finds a person whose only connection is gone", async () => {
    if (!shared) return;
    const target = await owner("nango sweep only connection gone");
    const nango = fakeNango();
    await connect(target, nango, "nl-only", "only-gone@example.com");
    // Deleted outside reference counting, with no webhook: Nango lists nothing for them.
    nango.remote.splice(
      nango.remote.findIndex((entry) => entry.connectionId === "nl-only"),
      1,
    );
    // Without the deployment-wide listing nobody leads the sweep to them.
    await sweepNangoConnections(sweepDeps(nango));
    expect((await nangoRows(target))[0]).toMatchObject({ status: "active" });
    await shared!.admin.unsafe(
      "GRANT EXECUTE ON FUNCTION opengeni_private.nango_live_connection_owners_v1(text, text, text, integer) TO opengeni_app",
    );
    // Earlier tests' rows stand for connections only their own fake Nango
    // had; retire them so this pass sees only this person.
    await shared!.admin`update connections set status = 'revoked'
      where metadata ->> 'integrationBackend' = 'nango' and status <> 'revoked'
        and workspace_id <> ${target.workspaceId}`;
    try {
      // Nango lists only another deployment's connections (possibly the wrong
      // environment): the listing is not used, so nothing is taken for missing.
      nango.remote.push({
        connectionId: "nl-other-deployment",
        tags: { ...attemptTags(target, "other"), [NANGO_DEPLOYMENT_TAG]: "https://other.test" },
        email: "other@example.com",
        scope: "",
        authErrors: 0,
      });
      await sweepNangoConnections(sweepDeps(nango));
      expect((await nangoRows(target))[0]).toMatchObject({ status: "active" });
      nango.remote.pop();
      await sweepNangoConnections(sweepDeps(nango));
    } finally {
      await shared!.admin.unsafe(
        "REVOKE EXECUTE ON FUNCTION opengeni_private.nango_live_connection_owners_v1(text, text, text, integer) FROM opengeni_app",
      );
    }
    const [row] = await shared!.admin<Array<{ status: string; last_error: string | null }>>`
      select status, last_error from connections
      where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'`;
    expect({ ...row }).toEqual({ status: "needs_reauth", last_error: "nango_connection_missing" });
  });

  test("too many rows on missing connections at once marks none", async () => {
    if (!shared) return;
    const target = await owner("nango sweep missing breaker");
    const nango = fakeNango();
    await connect(target, nango, "mb-listed", "mb-listed@example.com");
    const gone = Array.from({ length: 11 }, (_, index) => `mb-${index}`);
    for (const id of gone) await connect(target, nango, id, `${id}@example.com`);
    // As with a Nango key for the wrong environment: every one of them a 404.
    nango.remote.splice(
      0,
      nango.remote.length,
      ...nango.remote.filter((entry) => !gone.includes(entry.connectionId)),
    );
    expect(await sweepNangoConnections(sweepDeps(nango))).toMatchObject({
      markedMissing: 0,
      missingBreakerTripped: true,
    });
    expect((await nangoRows(target)).every((row) => row.status === "active")).toBe(true);
  });

  test("older duplicates without the scope marker merge on the scopes Nango reports", async () => {
    if (!shared) return;
    const first = await owner("nango sweep unmarked first");
    const second = await owner("nango sweep unmarked second", first.subjectId);
    const nango = fakeNango();
    await connect(first, nango, "nu-1", "dup-unmarked@example.com");
    await connect(second, nango, "nu-2", "dup-unmarked@example.com");
    await leaveRowOn(first, "nu-1", nango, "dup-unmarked@example.com");
    // Saved before the marker existed: neither row vouches for its scopes.
    for (const target of [first, second])
      await shared!.admin`update connections
        set metadata = metadata - 'nangoScopesConfirmed'
        where workspace_id = ${target.workspaceId} and provider_domain = 'nango:gmail'`;
    const result = await sweepNangoConnections(sweepDeps(nango));
    expect(result).toMatchObject({ repointed: 1, deletedDuplicates: ["nu-1"] });
    expect((await nangoRows(first))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "nu-2",
    });
    expect(nango.remote.map((entry) => entry.connectionId)).toEqual(["nu-2"]);
  });

  test("the sweep shares duplicates of one account an older release left", async () => {
    if (!shared) return;
    const first = await owner("nango sweep duplicates first");
    const second = await owner("nango sweep duplicates second", first.subjectId);
    const nango = fakeNango();
    await connect(first, nango, "nsd-1", "dup@example.com");
    await connect(second, nango, "nsd-2", "dup@example.com");
    // As an older release left it: each organization on its own connection.
    nango.remote.push({
      connectionId: "nsd-1",
      tags: attemptTags(first, "older"),
      email: "dup@example.com",
      scope: "",
      authErrors: 0,
      created: "2026-11-01T00:00:00.000Z",
    });
    nango.remote.find((entry) => entry.connectionId === "nsd-2")!.created =
      "2026-11-14T00:00:00.000Z";
    // Both the metadata and the stored credential name the older connection.
    const { decryptEnvironmentValue, encryptEnvironmentValue } = await import("@opengeni/db");
    const { environmentsEncryptionKeyBytes } = await import("@opengeni/config");
    const key = environmentsEncryptionKeyBytes(settings)!;
    const [stored] = await shared!.admin<Array<{ credential_encrypted: string }>>`
      select credential_encrypted from connections
      where workspace_id = ${first.workspaceId} and provider_domain = 'nango:gmail'`;
    const olderCredential = encryptEnvironmentValue(
      key,
      JSON.stringify({
        ...JSON.parse(decryptEnvironmentValue(key, stored!.credential_encrypted)),
        nangoConnectionId: "nsd-1",
      }),
    );
    await shared!.admin`update connections
      set metadata = jsonb_set(metadata, '{nangoConnectionId}', '"nsd-1"'),
        credential_encrypted = ${olderCredential}
      where workspace_id = ${first.workspaceId} and provider_domain = 'nango:gmail'`;
    const seen = committedAtDelete(nango, first);
    const result = await sweepNangoConnections(sweepDeps(nango));
    // Deleted only after the repoint was committed.
    expect(seen["nsd-1"]).toEqual(["nsd-2"]);
    expect(result).toMatchObject({
      repointed: 1,
      deletedDuplicates: ["nsd-1"],
      deletedOrphans: [],
    });
    expect((await nangoRows(first))[0]).toMatchObject({ nango_connection_id: "nsd-2" });
    const [repointed] = await shared!.admin<Array<{ credential_encrypted: string }>>`
      select credential_encrypted from connections
      where workspace_id = ${first.workspaceId} and provider_domain = 'nango:gmail'`;
    expect(JSON.parse(decryptEnvironmentValue(key, repointed!.credential_encrypted))).toMatchObject(
      {
        nangoConnectionId: "nsd-2",
      },
    );
    expect(nango.remote.map((entry) => entry.connectionId)).toEqual(["nsd-2"]);
  });

  test("reconnecting the same account keeps a running turn's authority", async () => {
    if (!shared) return;
    const target = await owner("nango same-account authority");
    const nango = fakeNango();
    const both = "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/";
    await connect(target, nango, "na-1", "turn@example.com");
    const [row] = await nangoRows(target);
    const generation = async () =>
      (
        await shared!.admin<Array<{ authority_generation: number }>>`
          select authority_generation from connections where id = ${row!.id}`
      ).map((entry) => Number(entry.authority_generation))[0]!;
    // A turn accepted now holds the connection at this generation.
    const accepted = await generation();
    const brokerLoad = () =>
      loadConnectionCredentialForBroker(client.db, settings, {
        workspaceId: target.workspaceId,
        subjectId: target.subjectId,
        connectionId: row!.id,
        providerDomain: "nango:gmail",
        allowSubjectOwned: true,
        expectedAuthorityGeneration: accepted,
      });
    expect(await brokerLoad()).not.toBeNull();
    // The same account again, then with more scopes: not an authority change,
    // so the accepted turn keeps working on the new Nango connection.
    await connect(target, nango, "na-2", "turn@example.com");
    await connect(target, nango, "na-3", "turn@example.com", both);
    expect(await generation()).toBe(accepted);
    expect(JSON.stringify((await brokerLoad())?.credential)).toContain("na-3");
    expect(nango.remote.map((entry) => entry.connectionId)).toEqual(["na-3"]);
    // Fewer scopes is a real authority change.
    await connect(target, nango, "na-4", "turn@example.com", "https://mail.google.com/");
    expect(await generation()).toBe(accepted + 1);
    expect(await brokerLoad()).toBeNull();
    // A row saved before account keys: its first reconnect keeps authority too.
    await shared!.admin`update connections set account_identity_key = null where id = ${row!.id}`;
    const legacy = await generation();
    await connect(target, nango, "na-5", "turn@example.com", "https://mail.google.com/");
    expect(await generation()).toBe(legacy);
  });

  test("a replayed completion whose identity read fails keeps the stored connection", async () => {
    if (!shared) return;
    const target = await owner("nango replay identity failure");
    const nango = fakeNango();
    const token = await signedState(target);
    const state = readNangoConnectState(settings, token);
    nango.remote.push({
      connectionId: "nri-1",
      tags: attemptTags(target, state.nonce),
      email: "replay@example.com",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      authErrors: 0,
    });
    const complete = () =>
      completeNangoConnect(
        {
          db: client.db,
          settings,
          fetchImpl: nango.fetchImpl,
          nangoBackends: async () => backends,
        },
        { state: token, browser: { bindingDigests: [], signedInSubjectId: null } },
      );
    expect((await complete()).status).toBe("complete");
    for (const status of [503, 403]) {
      nango.remote[0]!.identityStatus = status;
      await expect(complete()).rejects.toThrow();
    }
    expect(nango.deleted("nri-1")).toBe(false);
    expect((await nangoRows(target))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "nri-1",
    });
  });

  test("a narrower grant shares the broader connection; a disallowing organization is left", async () => {
    if (!shared) return;
    const broad = await owner("nango repoint broad");
    const narrow = await owner("nango repoint narrow", broad.subjectId);
    const nango = fakeNango();
    const both = "https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/";
    await connect(broad, nango, "nrp-1", "repoint@example.com", both);
    // A narrower grant elsewhere must not shrink the broad organization's
    // access, and is not billed twice: it uses the broader connection, with
    // only its own scopes.
    await connect(narrow, nango, "nrp-2", "repoint@example.com");
    expect((await nangoRows(broad))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "nrp-1",
      granted_scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://mail.google.com/",
      ],
    });
    expect((await nangoRows(narrow))[0]).toMatchObject({
      status: "active",
      nango_connection_id: "nrp-1",
      granted_scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    expect(nango.deleted("nrp-1")).toBe(false);
    expect(nango.deleted("nrp-2")).toBe(true);

    // A broader connection Nango reports failing never replaces a fresh one.
    const third = await owner("nango repoint third", broad.subjectId);
    nango.remote.find((entry) => entry.connectionId === "nrp-1")!.authErrors = 1;
    await connect(third, nango, "nrp-5", "repoint@example.com");
    expect((await nangoRows(third))[0]).toMatchObject({ nango_connection_id: "nrp-5" });
    expect(nango.deleted("nrp-5")).toBe(false);

    // An organization that has since disallowed Gmail keeps its own row as it is.
    const restricted = await owner("nango repoint restricted");
    const elsewhere = await owner("nango repoint elsewhere", restricted.subjectId);
    await connect(restricted, nango, "nrp-3", "policy@example.com");
    await shared!.admin`insert into organization_integration_policies
        (account_id, mode, allowed_integration_keys, revision)
      values (${restricted.accountId}, 'restricted', '[]'::jsonb, 1)`;
    await connect(elsewhere, nango, "nrp-4", "policy@example.com");
    expect((await nangoRows(restricted))[0]).toMatchObject({ nango_connection_id: "nrp-3" });
    expect(nango.deleted("nrp-3")).toBe(false);
  });

  test("a row in a suspended membership keeps its shared Nango connection", async () => {
    if (!shared) return;
    const first = await owner("nango suspended first");
    const second = await owner("nango suspended second", first.subjectId);
    const nango = fakeNango();
    await connect(first, nango, "nsu-1", "suspended@example.com");
    await connect(second, nango, "nsu-2", "suspended@example.com");
    const [firstRow] = await nangoRows(first);
    expect(firstRow).toMatchObject({ nango_connection_id: "nsu-2" });
    // Suspended in the second organization, where a live row still stands for nsu-2.
    await shared!.admin`update organization_memberships set status = 'suspended'
      where account_id = ${second.accountId} and subject_id = ${second.subjectId}`;
    await disconnect(first, firstRow!.id, nango);
    expect(nango.deleted("nsu-2")).toBe(false);
    // A fresh attempt that fails is still never left billed.
    const token = await signedState(first);
    nango.remote.push({
      connectionId: "nsu-attempt",
      tags: attemptTags(first, readNangoConnectState(settings, token).nonce),
      email: "suspended@example.com",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      authErrors: 0,
      created: new Date().toISOString(),
      identityStatus: 403,
    });
    await expect(
      completeNangoConnect(
        {
          db: client.db,
          settings,
          fetchImpl: nango.fetchImpl,
          nangoBackends: async () => backends,
        },
        { state: token, browser: { bindingDigests: [], signedInSubjectId: null } },
      ),
    ).rejects.toThrow();
    expect(nango.deleted("nsu-attempt")).toBe(true);
    expect(await sweepNangoConnections(sweepDeps(nango))).toMatchObject({ deletedOrphans: [] });
    expect(nango.deleted("nsu-2")).toBe(false);
    // Once granted, the deployment-wide check decides: still in use, then not.
    await shared!.admin.unsafe(
      "GRANT EXECUTE ON FUNCTION opengeni_private.nango_connections_in_use_v1(text[]) TO opengeni_app",
    );
    try {
      expect(await sweepNangoConnections(sweepDeps(nango))).toMatchObject({ deletedOrphans: [] });
      expect(nango.deleted("nsu-2")).toBe(false);
      await shared!.admin`update connections set status = 'revoked'
        where workspace_id = ${second.workspaceId} and provider_domain = 'nango:gmail'`;
      expect(await sweepNangoConnections(sweepDeps(nango))).toMatchObject({
        deletedOrphans: ["nsu-2"],
      });
    } finally {
      await shared!.admin.unsafe(
        "REVOKE EXECUTE ON FUNCTION opengeni_private.nango_connections_in_use_v1(text[]) FROM opengeni_app",
      );
    }
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
