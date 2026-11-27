import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type postgres from "postgres";
import {
  buildConnectionTokenResolver,
  createConnection,
  createDb,
  encryptEnvironmentValue,
  GOOGLE_OAUTH_GRANT_FAMILY,
  OAUTH_GRANT_REAUTH_SIBLINGS_ROUTINE,
  OAUTH_GRANT_SHARED_ROUTINE,
  oauthGrantReauthSiblings,
  oauthGrantSharedWithLiveConnection,
  SHARED_GRANT_REFUSED_ERROR,
  type ConnectionNeedsReauth,
  type Database,
  type DbClient,
  type OAuthGrantFamily,
} from "../src/index";

/* Migrations 1611 and 1680: deployment-wide checks for connections that
   share one provider OAuth grant (one account, one client), used before a
   disconnect revokes at the provider and when a refresh is refused with
   invalid_grant. 1680 pins the Google family in SQL and grants the runtime
   EXECUTE. Through the restricted runtime role, so FORCE RLS applies. */

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "opengeni-client.apps.googleusercontent.com";
const OTHER_CLIENT_ID = "other-client.apps.googleusercontent.com";
const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
const EXAMPLE_FAMILY: OAuthGrantFamily = {
  id: "example",
  tokenEndpointOrigins: ["https://auth.example.test"],
  providerDomainSuffixes: ["example.test"],
  providerFamily: "example",
  subjectMetadataKeys: ["exampleAccountId"],
  emailMetadataKeys: ["exampleEmail"],
};
// Google's endpoints, but matching accounts by a key the caller chose.
const CALLER_KEYED_FAMILY: OAuthGrantFamily = {
  ...GOOGLE_OAUTH_GRANT_FAMILY,
  subjectMetadataKeys: ["clientId"],
};

const rawKey = randomBytes(32);
const settings = testSettings({ environmentsEncryptionKey: rawKey.toString("base64") }) as Settings;
const key = environmentsEncryptionKeyBytes(settings)!;
let shared: SharedTestDatabase;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let appRole: string;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("oauth-grant-siblings");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 4 });
  db = client.db;
  appRole = decodeURIComponent(new URL(shared.appUrl).username);
}, 180_000);

// The checks read the whole deployment: start each test from no live rows.
beforeEach(async () => {
  await admin`update connections set status = 'revoked' where status <> 'revoked'`;
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function grantChecks(granted: boolean): Promise<void> {
  for (const routine of [OAUTH_GRANT_SHARED_ROUTINE, OAUTH_GRANT_REAUTH_SIBLINGS_ROUTINE]) {
    await admin.unsafe(
      `${granted ? "grant" : "revoke"} execute on function ${routine} ${granted ? "to" : "from"} "${appRole}"`,
    );
  }
}

async function organizationWorkspace(accountId?: string) {
  const account =
    accountId ??
    (
      await admin<{ id: string }[]>`insert into managed_accounts (name) values ('org') returning id`
    )[0]!.id;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account})`;
  return { accountId: account, workspaceId: workspace!.id };
}

type Scope = Awaited<ReturnType<typeof organizationWorkspace>>;

async function oauthConnection(
  scope: Scope,
  input: {
    providerDomain?: string;
    tokenEndpoint?: string;
    clientId?: string;
    identity?: Record<string, unknown>;
    /** Save the endpoint and client only in the credential (older rows). */
    credentialOnly?: boolean;
    /** A refresh token the test provider keeps accepting. */
    alive?: boolean;
  } = {},
) {
  const tokenEndpoint = input.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
  const clientId = input.clientId ?? CLIENT_ID;
  return await createConnection(db, {
    ...scope,
    subjectId: null,
    providerDomain: input.providerDomain ?? "gmailmcp.googleapis.com",
    kind: "oauth2",
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: "access-secret",
        refresh_token: `${input.alive ? "alive" : "dead"}-refresh-secret-${randomUUID()}`,
        token_type: "Bearer",
        token_endpoint: tokenEndpoint,
        client_id: clientId,
        client_secret: "client-secret",
        token_endpoint_auth_method: "client_secret_post",
      }),
    ),
    expiresAt: new Date(Date.now() - 60_000),
    metadata: {
      mcpUrl: GMAIL_MCP_URL,
      ...(input.credentialOnly ? {} : { tokenEndpoint, clientId }),
      ...(input.identity ?? {}),
    },
    createdBySubjectId: "user:owner",
  });
}

async function row(connectionId: string) {
  const [found] = await admin<{ status: string; last_error: string | null; version: number }[]>`
    select status, last_error, version from connections where id = ${connectionId}`;
  return found!;
}

async function revoke(connectionId: string): Promise<void> {
  await admin`update connections set status = 'revoked' where id = ${connectionId}`;
}

const ada = { googleSubject: "google-sub-ada", gmailEmail: "ada@example.test" };

describe("shared OAuth grant checks (migrations 1611 and 1680)", () => {
  test("the runtime may execute them, only for the family pinned in SQL", async () => {
    const [posture] = await admin<
      { execute: boolean; definer: boolean; public_execute: boolean; config: string[] }[]
    >`select has_function_privilege(${appRole}, p.oid, 'EXECUTE') as execute,
        p.prosecdef as definer,
        exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as public_execute,
        p.proconfig as config
      from pg_proc p where p.oid = ${OAUTH_GRANT_SHARED_ROUTINE}::regprocedure`;
    expect(posture).toMatchObject({ execute: true, definer: true, public_execute: false });
    expect(String(posture!.config)).toContain("search_path=pg_catalog");

    const scope = await organizationWorkspace();
    const source = await oauthConnection(scope, { identity: ada });
    const lookup = {
      connectionId: source.id,
      clientId: CLIENT_ID,
      family: GOOGLE_OAUTH_GRANT_FAMILY,
    };
    expect(await oauthGrantSharedWithLiveConnection(db, lookup)).toBe(false);
    expect(await oauthGrantReauthSiblings(db, lookup)).toEqual([]);

    // Any other family, including Google's endpoints with keys the caller
    // chose, is refused before anything is read.
    const refusal = async (attempt: Promise<unknown>) => {
      const error = await attempt.then(
        () => null,
        (failure: unknown) => failure as Error & { cause?: { message?: string; code?: string } },
      );
      return { message: error?.cause?.message, code: error?.cause?.code };
    };
    const notPinned = { message: "OAuth grant family is not pinned", code: "22023" };
    for (const family of [CALLER_KEYED_FAMILY, EXAMPLE_FAMILY]) {
      const refused = { ...lookup, family };
      expect(await refusal(oauthGrantSharedWithLiveConnection(db, refused))).toEqual(notPinned);
      expect(await refusal(oauthGrantReauthSiblings(db, refused))).toEqual(notPinned);
    }
  });

  test("a disconnect sees a possible sibling in any workspace or organization", async () => {
    const home = await organizationWorkspace();
    const source = await oauthConnection(home, { identity: ada });
    const shares = async (
      family: OAuthGrantFamily = GOOGLE_OAUTH_GRANT_FAMILY,
      id = source.id,
      clientId = CLIENT_ID,
    ) => await oauthGrantSharedWithLiveConnection(db, { connectionId: id, clientId, family });

    // The last connection of the grant: revoke.
    expect(await shares()).toBe(false);

    // Provably other accounts, other clients and other providers never
    // hold this grant.
    await oauthConnection(home, { identity: { googleSubject: "google-sub-bob" } });
    await oauthConnection(home, { identity: { gmailEmail: "bob@example.test" } });
    await oauthConnection(home, { identity: ada, clientId: OTHER_CLIENT_ID });
    await oauthConnection(home, {
      identity: ada,
      tokenEndpoint: "https://auth.example.test/token",
      providerDomain: "gmailmcp.googleapis.com",
    });
    expect(await shares()).toBe(false);

    // The same workspace: Drive of the same Google account.
    const sameWorkspace = await oauthConnection(home, {
      providerDomain: "drivemcp.googleapis.com",
      identity: { googleSubject: "google-sub-ada", googleDriveEmail: "ada@example.test" },
    });
    expect(await shares()).toBe(true);
    await revoke(sameWorkspace.id);
    expect(await shares()).toBe(false);

    // Another workspace of the same organization.
    const otherWorkspace = await organizationWorkspace(home.accountId);
    const crossWorkspace = await oauthConnection(otherWorkspace, {
      providerDomain: "calendarmcp.googleapis.com",
      identity: { googleSubject: "google-sub-ada" },
    });
    expect(await shares()).toBe(true);
    await revoke(crossWorkspace.id);
    expect(await shares()).toBe(false);

    // Another organization entirely, matched by email alone.
    const otherOrganization = await organizationWorkspace();
    const crossOrganization = await oauthConnection(otherOrganization, {
      identity: { googleDriveEmail: " ADA@example.test " },
    });
    expect(await shares()).toBe(true);
    await revoke(crossOrganization.id);
    expect(await shares()).toBe(false);

    // A Google Drive sync row without a saved endpoint or client, or a
    // Google Integration (providerFamily), may hold it; so may a row
    // whose account is unknown. Needs-reauth rows are still live.
    for (const candidate of [
      { providerDomain: "googleapis.com", credentialOnly: true, identity: ada },
      {
        providerDomain: "www.googleapis.com",
        credentialOnly: true,
        identity: { providerFamily: "google", providerPrincipalId: "google-sub-ada" },
      },
      { identity: {} },
    ]) {
      const possible = await oauthConnection(otherOrganization, candidate);
      expect(await shares()).toBe(true);
      await admin`update connections set status = 'needs_reauth' where id = ${possible.id}`;
      expect(await shares()).toBe(true);
      await revoke(possible.id);
      expect(await shares()).toBe(false);
    }

    // A connection without verified identity may share with anyone.
    const anonymous = await oauthConnection(home, { identity: {} });
    const ownGrant = await oauthConnection(otherOrganization, {
      identity: { googleSubject: "google-sub-carol" },
    });
    expect(await shares(GOOGLE_OAUTH_GRANT_FAMILY, anonymous.id)).toBe(true);
    await revoke(ownGrant.id);
  });

  // Google, refusing every refresh token except the ones still alive.
  function google(calls: { tokens: string[] }) {
    return {
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const token = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
        calls.tokens.push(token);
        if (token.startsWith("alive-")) {
          return Response.json({
            access_token: "fresh-access-secret",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        return Response.json(
          { error: "invalid_grant", error_description: "Token has been expired or revoked." },
          { status: 400 },
        );
      }) as unknown as typeof fetch,
      dnsLookup: async () => [{ address: "142.250.74.10", family: 4 as const }],
    };
  }

  async function refuse(
    scope: Scope,
    connectionId: string,
    events: ConnectionNeedsReauth[],
    calls: { tokens: string[] } = { tokens: [] },
    checks: Promise<void>[] = [],
  ) {
    return await buildConnectionTokenResolver(db, settings, undefined, {
      refreshTransport: google(calls),
      onConnectionNeedsReauth: (event) => {
        events.push(event);
      },
      scheduleGrantSiblingCheck: (check) => {
        checks.push(check);
      },
    })({
      workspaceId: scope.workspaceId,
      serverId: "gmail",
      destinationUrl: GMAIL_MCP_URL,
      connectionRef: {
        connectionId,
        providerDomain: "gmailmcp.googleapis.com",
        kind: "oauth2",
      },
      forceRefresh: true,
    });
  }

  test("invalid_grant marks every sibling the provider refuses too, deployment-wide", async () => {
    const home = await organizationWorkspace();
    const otherWorkspace = await organizationWorkspace(home.accountId);
    const otherOrganization = await organizationWorkspace();
    // Dead siblings: same account and client, their own tokens refused.
    const sameWorkspace = await oauthConnection(home, {
      providerDomain: "drivemcp.googleapis.com",
      identity: { googleSubject: "google-sub-ada" },
    });
    const crossWorkspace = await oauthConnection(otherWorkspace, {
      providerDomain: "calendarmcp.googleapis.com",
      identity: { googleSubject: "google-sub-ada", googleCalendarEmail: "x@example.test" },
    });
    const crossOrganization = await oauthConnection(otherOrganization, {
      identity: { gmailEmail: "ADA@example.test" },
    });
    // Never touched: another account, another client, unknown identity or
    // client, another provider, or a row that is not active.
    const otherAccount = await oauthConnection(otherOrganization, {
      identity: { googleSubject: "google-sub-bob", gmailEmail: "ada@example.test" },
    });
    const otherClient = await oauthConnection(otherOrganization, {
      identity: ada,
      clientId: OTHER_CLIENT_ID,
    });
    const unknownIdentity = await oauthConnection(otherOrganization, { identity: {} });
    const unknownClient = await oauthConnection(otherOrganization, {
      identity: ada,
      providerDomain: "googleapis.com",
      credentialOnly: true,
    });
    const otherProvider = await oauthConnection(otherOrganization, {
      identity: ada,
      tokenEndpoint: "https://auth.example.test/token",
    });
    const alreadyRevoked = await oauthConnection(otherOrganization, { identity: ada });
    await revoke(alreadyRevoked.id);
    const source = await oauthConnection(home, { identity: ada });
    // Same account and client, but its own token still works (only the
    // source's token ended, as after a password change or the token cap):
    // it stays connected.
    const stillWorking = await oauthConnection(otherOrganization, {
      identity: ada,
      alive: true,
    });
    // Used after the source last refreshed: still checked.
    await admin`update connections set updated_at = now() + interval '1 minute'
      where id = ${crossOrganization.id}`;

    const events: ConnectionNeedsReauth[] = [];
    const calls = { tokens: [] as string[] };
    const checks: Promise<void>[] = [];
    // Two resolves at once mark each sibling exactly once.
    const results = await Promise.all([
      refuse(home, source.id, events, calls, checks),
      refuse(home, source.id, events, calls, checks),
    ]);
    // The later one may already find the connection needs reconnecting.
    expect(results.map((result) => result.status)).toEqual(["auth_needed", "auth_needed"]);
    expect(results.some((result) => "reason" in result && result.reason === "refresh_failed")).toBe(
      true,
    );
    // Only the resolve that moved the connection checks its siblings.
    expect(checks).toHaveLength(1);
    await Promise.all(checks);
    expect((await row(source.id)).status).toBe("needs_reauth");

    for (const sibling of [sameWorkspace, crossWorkspace, crossOrganization]) {
      expect(await row(sibling.id)).toMatchObject({
        status: "needs_reauth",
        last_error: SHARED_GRANT_REFUSED_ERROR,
      });
    }
    for (const untouched of [
      otherAccount,
      otherClient,
      unknownIdentity,
      unknownClient,
      otherProvider,
      stillWorking,
    ]) {
      expect((await row(untouched.id)).status).toBe("active");
    }
    expect((await row(alreadyRevoked.id)).status).toBe("revoked");
    // Only the source and its candidates reached the provider, each with
    // its own token; the working one was refreshed, not marked.
    expect(calls.tokens.some((token) => token.startsWith("alive-"))).toBe(true);
    expect(new Set(calls.tokens).size).toBe(5);

    // The owner of each moved connection hears once, without another
    // chat's turn (that chat may belong to someone else).
    const siblingEvents = events.filter((event) => event.connectionId !== source.id);
    expect(siblingEvents.map((event) => event.connectionId).sort()).toEqual(
      [sameWorkspace.id, crossWorkspace.id, crossOrganization.id].sort(),
    );
    for (const event of siblingEvents) expect(event.use).toBeUndefined();
    expect(siblingEvents.find((event) => event.connectionId === crossOrganization.id)).toEqual({
      workspaceId: otherOrganization.workspaceId,
      connectionId: crossOrganization.id,
      subjectId: null,
      providerDomain: "gmailmcp.googleapis.com",
      httpStatus: 400,
    });

    // Idempotent: only the working one is left, and checking it again
    // still leaves it connected.
    expect(
      (
        await oauthGrantReauthSiblings(db, {
          connectionId: source.id,
          clientId: CLIENT_ID,
          family: GOOGLE_OAUTH_GRANT_FAMILY,
        })
      )?.map((sibling) => sibling.connectionId),
    ).toEqual([stillWorking.id]);
    // The client must be the one the refused row records.
    expect(
      await oauthGrantReauthSiblings(db, {
        connectionId: source.id,
        clientId: OTHER_CLIENT_ID,
        family: GOOGLE_OAUTH_GRANT_FAMILY,
      }),
    ).toEqual([]);
    // Only a connection whose own refresh was refused names siblings.
    expect(
      await oauthGrantReauthSiblings(db, {
        connectionId: stillWorking.id,
        clientId: CLIENT_ID,
        family: GOOGLE_OAUTH_GRANT_FAMILY,
      }),
    ).toEqual([]);
  });

  test("without the grant, a refused refresh marks only its own connection", async () => {
    await grantChecks(false);
    try {
      const home = await organizationWorkspace();
      const sibling = await oauthConnection(home, { identity: ada });
      const source = await oauthConnection(home, { identity: ada });
      const events: ConnectionNeedsReauth[] = [];
      const calls = { tokens: [] as string[] };
      const checks: Promise<void>[] = [];
      await refuse(home, source.id, events, calls, checks);
      await Promise.all(checks);
      expect(calls.tokens).toHaveLength(1);
      expect((await row(source.id)).status).toBe("needs_reauth");
      expect((await row(sibling.id)).status).toBe("active");
      expect(events.map((event) => event.connectionId)).toEqual([source.id]);
    } finally {
      await grantChecks(true);
    }
  });
});
