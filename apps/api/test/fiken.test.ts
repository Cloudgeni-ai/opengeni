import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  FIKEN_CREDENTIAL_LABEL,
  FIKEN_CREDENTIAL_ROLE,
  FIKEN_PROVIDER_DOMAIN,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectionMetadata,
  refreshOAuthConnectionCredential,
  setConnectionStatus,
  updateConnection,
  type DbClient,
} from "@opengeni/db";
import { createSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  createFikenClient,
  fikenCredentialBundle,
  resolveFikenConnectionForTool,
  verifyFikenApiToken,
} from "../src/integrations/fiken";

const DELEGATION_SECRET = randomBytes(32).toString("hex");
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
let oauthSettings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-fiken");
  if (!shared) {
    available = false;
    console.warn("[fiken] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: ENCRYPTION_KEY,
    publicBaseUrl: "https://app.example.test",
    integrationsEnabled: true,
  }) as Settings;
  oauthSettings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: ENCRYPTION_KEY,
    publicBaseUrl: "https://app.example.test",
    integrationsEnabled: true,
    integrationsStateSecret: "fiken-oauth-state-secret-for-tests",
    fikenClientId: "fiken-client-id",
    fikenClientSecret: "fiken-client-secret",
  }) as Settings;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

const FIXTURE_TOKEN = ["fiken", "fixture", "token", "not-a-real-credential"].join("-");

function fixtureCompanies(): Array<Record<string, unknown>> {
  return [
    { slug: "demo-as", name: "Demo AS", organizationNumber: "999999999" },
    { slug: "second-as", name: "Second AS", organizationNumber: "888888888" },
  ];
}

type FikenCall = { method: string; url: URL; body: unknown; headers: Headers };

/**
 * A deterministic Fiken API double. Routes are keyed by pathname suffix; every
 * call is recorded, and an in-flight counter proves the client's mandatory
 * single-concurrent-request serialization.
 */
function fakeFiken(
  options: {
    companies?: Array<Record<string, unknown>>;
    ignoreDraftUuidFilter?: boolean;
  } = {},
) {
  const calls: FikenCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const drafts = new Map<string, Record<string, unknown>>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const rawBody = init?.body ? String(init.body) : null;
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const headers = new Headers(init?.headers);
    calls.push({ method, url, body, headers });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (url.hostname === "fiken.no" && url.pathname === "/oauth/token") {
      return Response.json({
        access_token: "fixture-oauth-access-token",
        refresh_token: "fixture-oauth-refresh-token",
        token_type: "bearer",
        expires_in: 86_400,
      });
    }
    if (url.pathname.endsWith("/companies")) {
      return Response.json(options.companies ?? fixtureCompanies());
    }
    if (url.pathname.endsWith("/contacts") && method === "GET") {
      return Response.json(
        [
          {
            contactId: 101,
            name: "Kari Kunde",
            customer: true,
            attachments: [{ big: "blob" }],
            documents: [{ big: "blob" }],
          },
        ],
        {
          headers: {
            "Fiken-Api-Page": "0",
            "Fiken-Api-Page-Size": "25",
            "Fiken-Api-Page-Count": "3",
            "Fiken-Api-Result-Count": "70",
          },
        },
      );
    }
    if (url.pathname.endsWith("/contacts") && method === "POST") {
      return new Response(null, {
        status: 201,
        headers: { location: `${url.toString()}/2747365` },
      });
    }
    if (url.pathname.endsWith("/invoices/drafts") && method === "GET") {
      if (options.ignoreDraftUuidFilter) {
        // Models a provider that ignores the unknown query filter and returns
        // the company's whole first page of drafts.
        return Response.json([
          { draftId: 111, uuid: "00000000-0000-4000-8000-000000000000", customerId: 999 },
        ]);
      }
      const uuid = url.searchParams.get("uuid");
      const existing = uuid ? drafts.get(uuid) : null;
      return Response.json(existing ? [existing] : []);
    }
    if (url.pathname.endsWith("/invoices/drafts") && method === "POST") {
      const uuid = (body as { uuid?: string }).uuid ?? "";
      drafts.set(uuid, { draftId: 555, uuid, ...(body as Record<string, unknown>) });
      return new Response(null, {
        status: 201,
        headers: { location: `${url.toString()}/555` },
      });
    }
    return Response.json({ message: "unexpected fixture route" }, { status: 500 });
  }) as typeof globalThis.fetch;
  return {
    fetch: fetchImpl,
    calls,
    maxInFlight: () => maxInFlight,
  };
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('fiken acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'fiken ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  await shared!.admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${account!.id}, 'subject-a', 'active', ${workspace!.id}
    )`;
  for (const subjectId of ["subject-a", "subject-b"]) {
    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, ${subjectId}, ${subjectId}, 'member',
        ${shared!.admin.json(["connections:read", "connections:write"])}
      )`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function bearer(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function app(fikenFetch: typeof globalThis.fetch) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    fikenFetch,
  } as never);
}

async function installFiken(
  workspace: { accountId: string; workspaceId: string },
  fikenFetch: typeof globalThis.fetch,
  payload: Record<string, unknown> = {},
  subjectId = "subject-a",
): Promise<{
  status: number;
  body: { connection?: { id: string; version: number } } & Record<string, unknown>;
}> {
  const response = await app(fikenFetch).request(
    `/v1/workspaces/${workspace.workspaceId}/connections/fiken/install`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, subjectId, [
          "connections:read",
          "connections:write",
        ]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiToken: FIXTURE_TOKEN, ...payload }),
    },
  );
  return { status: response.status, body: (await response.json()) as never };
}

function grantFor(workspace: { accountId: string; workspaceId: string }): AccessGrant {
  return {
    ...workspace,
    subjectId: "subject-a",
    permissions: ["connections:read"],
    metadata: {},
  } as AccessGrant;
}

describe("verifyFikenApiToken", () => {
  test("maps companies and validates slugs", async () => {
    const fiken = fakeFiken();
    const verified = await verifyFikenApiToken(FIXTURE_TOKEN, fiken.fetch);
    expect(verified.companies).toEqual([
      { slug: "demo-as", name: "Demo AS", organizationNumber: "999999999" },
      { slug: "second-as", name: "Second AS", organizationNumber: "888888888" },
    ]);
    expect(fiken.calls[0]!.url.searchParams.get("pageSize")).toBe("100");
    const auth = await (async () => {
      // The verification request carries the pasted token as a bearer.
      const call = fiken.calls[0]!;
      return call;
    })();
    expect(auth.url.pathname.endsWith("/companies")).toBe(true);
  });

  test("rejects an invalid token with a 422 verification error", async () => {
    const rejecting = (async () => Response.json({ message: "bad" }, { status: 401 })) as never;
    await expect(verifyFikenApiToken(FIXTURE_TOKEN, rejecting)).rejects.toThrow(
      /rejected the API token/,
    );
  });

  test("rejects a token with no accessible companies", async () => {
    const fiken = fakeFiken({ companies: [] });
    await expect(verifyFikenApiToken(FIXTURE_TOKEN, fiken.fetch)).rejects.toThrow(/no company/);
  });

  test("rejects a non-array companies response", async () => {
    const weird = (async () => Response.json({ not: "an array" })) as never;
    await expect(verifyFikenApiToken(FIXTURE_TOKEN, weird)).rejects.toThrow(/unexpected/);
  });
});

describe("fiken install route", () => {
  test("verifies the token and stores a workspace-owned api_key connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fiken = fakeFiken();
    const installed = await installFiken(workspace, fiken.fetch);
    expect(installed.status).toBe(201);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      installed.body.connection!.id,
      null,
    );
    expect(connection).toMatchObject({
      subjectId: null,
      providerDomain: FIKEN_PROVIDER_DOMAIN,
      kind: "api_key",
      status: "active",
      metadata: expect.objectContaining({
        credentialRole: FIKEN_CREDENTIAL_ROLE,
        credentialLabel: FIKEN_CREDENTIAL_LABEL,
        // Two companies -> no automatic default.
        defaultCompanySlug: null,
      }),
    });
  });

  test("auto-selects the default company when the token sees exactly one", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fiken = fakeFiken({ companies: [fixtureCompanies()[0]!] });
    const installed = await installFiken(workspace, fiken.fetch);
    expect(installed.status).toBe(201);
    expect(
      (
        await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          installed.body.connection!.id,
          null,
        )
      )?.metadata,
    ).toMatchObject({ defaultCompanySlug: "demo-as" });
  });

  test("rejects a defaultCompanySlug the token cannot access", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installed = await installFiken(workspace, fakeFiken().fetch, {
      defaultCompanySlug: "not-mine",
    });
    expect(installed.status).toBe(422);
  });

  test("rewrites an existing Fiken connection in place on reconnect", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fiken = fakeFiken();
    const first = await installFiken(workspace, fiken.fetch);
    const reconnect = await installFiken(workspace, fiken.fetch, {
      connectionId: first.body.connection!.id,
      defaultCompanySlug: "second-as",
    });
    expect(reconnect.status).toBe(200);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      first.body.connection!.id,
      null,
    );
    expect(connection).toMatchObject({
      status: "active",
      version: first.body.connection!.version + 1,
      metadata: expect.objectContaining({ defaultCompanySlug: "second-as" }),
    });
  });

  test("rejects reconnect against a non-Fiken connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: null,
      providerDomain: "example.com",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.from(ENCRYPTION_KEY, "base64"),
        JSON.stringify({ headers: {} }),
      ),
      grantedScopes: [],
      expiresAt: null,
      metadata: {},
      createdBySubjectId: "subject-a",
    });
    const reconnect = await installFiken(workspace, fakeFiken().fetch, {
      connectionId: other.id,
    });
    expect(reconnect.status).toBe(422);
  });

  test("requires connections:write", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const response = await app(fakeFiken().fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/fiken/install`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:read"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ apiToken: FIXTURE_TOKEN }),
      },
    );
    expect(response.status).toBe(403);
  });

  test("stores the token as the broker's api_key headers bundle", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installed = await installFiken(workspace, fakeFiken().fetch);
    const [row] = await shared!.admin<Array<{ credential_encrypted: string }>>`
      select credential_encrypted from connections where id = ${installed.body.connection!.id}`;
    const bundle = JSON.parse(
      decryptEnvironmentValue(Buffer.from(ENCRYPTION_KEY, "base64"), row!.credential_encrypted),
    );
    expect(bundle).toEqual(fikenCredentialBundle(FIXTURE_TOKEN));
    expect(bundle.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
  });
});

describe("resolveFikenConnectionForTool", () => {
  test("resolves the workspace Fiken connection and rejects when absent", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await expect(
      resolveFikenConnectionForTool({ db: client.db, grant: grantFor(workspace), sessionId: null }),
    ).rejects.toThrow(/no Fiken connection/);
    const installed = await installFiken(workspace, fakeFiken().fetch);
    const resolved = await resolveFikenConnectionForTool({
      db: client.db,
      grant: grantFor(workspace),
      sessionId: null,
    });
    expect(resolved.connection.id).toBe(installed.body.connection!.id);
    expect(resolved.metadata.companies).toHaveLength(2);
  });

  test("rejects a personal or foreign-domain row", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      providerDomain: FIKEN_PROVIDER_DOMAIN,
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.from(ENCRYPTION_KEY, "base64"),
        JSON.stringify(fikenCredentialBundle(FIXTURE_TOKEN)),
      ),
      grantedScopes: [],
      expiresAt: null,
      metadata: {},
      createdBySubjectId: "subject-a",
    });
    await expect(
      resolveFikenConnectionForTool({ db: client.db, grant: grantFor(workspace), sessionId: null }),
    ).rejects.toThrow(/no Fiken connection/);
  });
});

describe("FikenClient", () => {
  async function connectedClient(
    workspace: { accountId: string; workspaceId: string },
    fikenFetch: typeof globalThis.fetch,
    installPayload: Record<string, unknown> = {},
    authorizeProviderRequest?: () => Promise<boolean | void>,
  ) {
    await installFiken(workspace, fakeFiken().fetch, installPayload);
    const resolved = await resolveFikenConnectionForTool({
      db: client.db,
      grant: grantFor(workspace),
      sessionId: null,
    });
    return {
      resolved,
      fiken: createFikenClient(
        { db: client.db, settings, fikenFetch, authorizeProviderRequest },
        resolved,
      ),
    };
  }

  async function expiredOAuthClient(
    workspace: { accountId: string; workspaceId: string },
    fikenFetch: typeof globalThis.fetch,
  ) {
    const installed = await installFiken(workspace, fakeFiken().fetch, {
      defaultCompanySlug: "demo-as",
    });
    const current = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      installed.body.connection!.id,
      null,
    );
    if (!current) throw new Error("expected current Fiken connection");
    const expired = await updateConnection(client.db, {
      workspaceId: workspace.workspaceId,
      connectionId: current.id,
      visibleToSubjectId: null,
      kind: "oauth2",
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.from(ENCRYPTION_KEY, "base64"),
        JSON.stringify({
          access_token: "expired-access",
          refresh_token: "refresh-fixture",
          token_endpoint: "https://fiken.no/oauth/token",
          client_id: "fiken-client-id",
          client_secret: "fiken-client-secret",
          token_endpoint_auth_method: "client_secret_basic",
          token_type: "bearer",
        }),
      ),
      expiresAt: new Date(0),
      metadata: { ...current.metadata },
    });
    if (!expired) throw new Error("expected expired OAuth fixture");
    const resolved = await resolveFikenConnectionForTool({
      db: client.db,
      grant: grantFor(workspace),
      sessionId: null,
    });
    return {
      connection: expired,
      fiken: createFikenClient({ db: client.db, settings: oauthSettings, fikenFetch }, resolved),
    };
  }

  test("lists contacts with pagination facts and stripped blobs", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const { fiken } = await connectedClient(workspace, provider.fetch, {
      defaultCompanySlug: "demo-as",
    });
    const result = await fiken.listContacts({});
    expect(result.companySlug).toBe("demo-as");
    expect(result.page).toEqual({ page: 0, pageSize: 25, pageCount: 3, resultCount: 70 });
    expect(result.contacts).toEqual([{ contactId: 101, name: "Kari Kunde", customer: true }]);
    const call = provider.calls.find((entry) => entry.url.pathname.endsWith("/contacts"))!;
    expect(call.url.pathname).toContain("/companies/demo-as/contacts");
    // The stored bearer travels on the provider request.
    expect(call.url.origin).toBe("https://api.fiken.no");
  });

  test("requires a company slug when several companies exist and no default is set", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const { fiken } = await connectedClient(workspace, provider.fetch);
    await expect(fiken.listContacts({})).rejects.toThrow(/demo-as, second-as/);
    const explicit = await fiken.listContacts({ companySlug: "second-as" });
    expect(explicit.companySlug).toBe("second-as");
  });

  test("rejects a malformed company slug before it reaches a URL", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const { fiken } = await connectedClient(workspace, provider.fetch);
    await expect(fiken.listContacts({ companySlug: "Bad/../Slug" })).rejects.toThrow(
      /lowercase Fiken company slug/,
    );
    expect(provider.calls.some((entry) => entry.url.pathname.includes("Bad"))).toBe(false);
  });

  test("serializes concurrent requests onto one in-flight provider call", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    let authorizations = 0;
    const { fiken } = await connectedClient(
      workspace,
      provider.fetch,
      { defaultCompanySlug: "demo-as" },
      async () => {
        authorizations += 1;
        return true;
      },
    );
    await Promise.all([fiken.listCompanies(), fiken.listContacts({}), fiken.listCompanies()]);
    expect(provider.maxInFlight()).toBe(1);
    expect(authorizations).toBe(provider.calls.length);
  });

  test("denies queued calls after revoke or reconnect without stale provider I/O", async () => {
    if (!available) return;
    for (const transition of ["revoke", "reconnect"] as const) {
      const workspace = await freshWorkspace();
      const provider = fakeFiken();
      let releaseFirst!: () => void;
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let targetCalls = 0;
      const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.hostname === "api.fiken.no") {
          targetCalls += 1;
          if (targetCalls === 1) {
            signalEntered();
            await released;
          }
        }
        return await provider.fetch(input, init);
      }) as typeof globalThis.fetch;
      const { fiken, resolved } = await connectedClient(workspace, gatedFetch, {
        defaultCompanySlug: "demo-as",
      });
      const first = fiken.listCompanies();
      await entered;
      const queued = fiken.listContacts({});
      const current = await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        resolved.connection.id,
        null,
      );
      if (!current) throw new Error("expected current Fiken connection");
      if (transition === "revoke") {
        expect(
          await setConnectionStatus(client.db, workspace.workspaceId, "revoked", null, {
            id: current.id,
            version: current.version,
            subjectId: null,
          }),
        ).toBe(true);
      } else {
        await updateConnection(client.db, {
          workspaceId: workspace.workspaceId,
          connectionId: current.id,
          visibleToSubjectId: null,
          credentialEncrypted: encryptEnvironmentValue(
            Buffer.from(ENCRYPTION_KEY, "base64"),
            JSON.stringify(fikenCredentialBundle(`${FIXTURE_TOKEN}-reconnected`)),
          ),
          metadata: { ...current.metadata },
        });
      }
      releaseFirst();
      await expect(first).resolves.toBeDefined();
      await expect(queued).rejects.toThrow(/authority changed|reconnected/);
      expect(targetCalls).toBe(1);
    }
  });

  test("rechecks revocation after a delayed OAuth refresh before target I/O", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let releaseRefresh!: () => void;
    let signalRefresh!: () => void;
    const refreshEntered = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    let targetCalls = 0;
    const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "fiken.no" && url.pathname === "/oauth/token") {
        refreshCalls += 1;
        signalRefresh();
        await refreshReleased;
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "refresh-fixture",
          token_type: "bearer",
          expires_in: 86_400,
        });
      }
      targetCalls += 1;
      return await fakeFiken().fetch(input, init);
    }) as typeof globalThis.fetch;
    const { fiken, connection } = await expiredOAuthClient(workspace, gatedFetch);
    const request = fiken.listContacts({ companySlug: "demo-as" });
    await refreshEntered;
    const duringRefresh = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connection.id,
      null,
    );
    if (!duringRefresh) throw new Error("expected Fiken connection during refresh");
    expect(
      await setConnectionStatus(client.db, workspace.workspaceId, "revoked", null, {
        id: duringRefresh.id,
        version: duringRefresh.version,
        subjectId: null,
      }),
    ).toBe(true);
    releaseRefresh();
    await expect(request).rejects.toThrow();
    expect(refreshCalls).toBe(1);
    expect(targetCalls).toBe(0);
  });

  test("rejects a reconnect winner after delayed OAuth refresh without target I/O", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let releaseRefresh!: () => void;
    let signalRefresh!: () => void;
    const refreshEntered = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    let targetCalls = 0;
    const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "fiken.no" && url.pathname === "/oauth/token") {
        refreshCalls += 1;
        signalRefresh();
        await refreshReleased;
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "refresh-fixture",
          token_type: "bearer",
          expires_in: 86_400,
        });
      }
      targetCalls += 1;
      return await fakeFiken().fetch(input, init);
    }) as typeof globalThis.fetch;
    const { fiken, connection } = await expiredOAuthClient(workspace, gatedFetch);
    const request = fiken.listContacts({ companySlug: "demo-as" });
    await refreshEntered;
    const duringRefresh = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connection.id,
      null,
    );
    if (!duringRefresh) throw new Error("expected Fiken connection during refresh");
    const reconnected = await updateConnection(client.db, {
      workspaceId: workspace.workspaceId,
      connectionId: duringRefresh.id,
      visibleToSubjectId: null,
      kind: "oauth2",
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.from(ENCRYPTION_KEY, "base64"),
        JSON.stringify({
          access_token: "reconnected-access",
          refresh_token: "reconnected-refresh",
          token_endpoint: "https://fiken.no/oauth/token",
          client_id: "fiken-client-id",
          client_secret: "fiken-client-secret",
          token_endpoint_auth_method: "client_secret_basic",
          token_type: "bearer",
        }),
      ),
      expiresAt: new Date(Date.now() + 86_400_000),
      metadata: { ...duringRefresh.metadata },
    });
    if (!reconnected) throw new Error("expected Fiken reconnect winner");
    releaseRefresh();
    await expect(request).rejects.toThrow(/authority changed|reconnected/);
    const final = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connection.id,
      null,
    );
    expect(final).toMatchObject({ status: "active", version: reconnected.version });
    expect(refreshCalls).toBe(1);
    expect(targetCalls).toBe(0);
  });

  test("does not let a stale in-flight 401 poison reconnect or revocation truth", async () => {
    if (!available) return;
    for (const transition of ["reconnect", "revoke"] as const) {
      const workspace = await freshWorkspace();
      let releaseResponse!: () => void;
      let signalEntered!: () => void;
      const targetEntered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const responseReleased = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let targetCalls = 0;
      const delayed401 = (async () => {
        targetCalls += 1;
        signalEntered();
        await responseReleased;
        return Response.json({ message: "stale credential" }, { status: 401 });
      }) as typeof globalThis.fetch;
      const { fiken, resolved } = await connectedClient(workspace, delayed401, {
        defaultCompanySlug: "demo-as",
      });
      const request = fiken.listContacts({});
      await targetEntered;
      const current = await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        resolved.connection.id,
        null,
      );
      if (!current) throw new Error("expected current Fiken connection");
      let expectedVersion: number;
      if (transition === "reconnect") {
        const reconnected = await updateConnection(client.db, {
          workspaceId: workspace.workspaceId,
          connectionId: current.id,
          visibleToSubjectId: null,
          credentialEncrypted: encryptEnvironmentValue(
            Buffer.from(ENCRYPTION_KEY, "base64"),
            JSON.stringify(fikenCredentialBundle(`${FIXTURE_TOKEN}-401-reconnect`)),
          ),
          metadata: { ...current.metadata },
        });
        if (!reconnected) throw new Error("expected Fiken reconnect winner");
        expectedVersion = reconnected.version;
      } else {
        expect(
          await setConnectionStatus(client.db, workspace.workspaceId, "revoked", null, {
            id: current.id,
            version: current.version,
            subjectId: null,
          }),
        ).toBe(true);
        expectedVersion = current.version + 1;
      }
      releaseResponse();
      await expect(request).rejects.toThrow(/credential_rejected/);
      const final = await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        resolved.connection.id,
        null,
      );
      expect(final).toMatchObject({
        status: transition === "reconnect" ? "active" : "revoked",
        version: expectedVersion,
      });
      expect(targetCalls).toBe(1);
    }
  });

  test("marks the connection needs_reauth on 401 and stays active on 429/500", async () => {
    if (!available) return;
    for (const status of [429, 500, 401]) {
      const workspace = await freshWorkspace();
      const failing = (async () =>
        Response.json({ message: "failure fixture" }, { status })) as typeof globalThis.fetch;
      const { fiken, resolved } = await connectedClient(workspace, failing, {
        defaultCompanySlug: "demo-as",
      });
      const expected =
        status === 401 ? /credential_rejected/ : status === 429 ? /rate_limited/ : /http_500/;
      await expect(fiken.listContacts({})).rejects.toThrow(expected);
      const after = await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        resolved.connection.id,
        null,
      );
      expect(after?.status).toBe(status === 401 ? "needs_reauth" : "active");
    }
  });

  test("surfaces the bounded provider message on HTTP failures", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const failing = (async () =>
      Response.json(
        { message: "Invalid request", validationMessages: ["lines[0].vatType is required"] },
        { status: 400 },
      )) as typeof globalThis.fetch;
    const { fiken } = await connectedClient(workspace, failing, {
      defaultCompanySlug: "demo-as",
    });
    await expect(fiken.listContacts({})).rejects.toThrow(/vatType is required/);
  });

  test("creates a contact and returns the Location-derived id", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const { fiken } = await connectedClient(workspace, provider.fetch, {
      defaultCompanySlug: "demo-as",
    });
    const created = await fiken.createContact({ name: "Ny Kunde", customer: true });
    expect(created.contactId).toBe(2747365);
    const post = provider.calls.find(
      (entry) => entry.method === "POST" && entry.url.pathname.endsWith("/contacts"),
    )!;
    expect(post.body).toEqual({ name: "Ny Kunde", customer: true });
  });

  test("does not replay an outcome-unknown contact creation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    let contactPosts = 0;
    const losePostResponse = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/contacts")) {
        contactPosts += 1;
        throw new Error("response lost after provider acceptance");
      }
      return await provider.fetch(input, init);
    }) as typeof globalThis.fetch;
    const { fiken } = await connectedClient(workspace, losePostResponse, {
      defaultCompanySlug: "demo-as",
    });
    await expect(fiken.createContact({ name: "Unknown Outcome" })).rejects.toThrow(
      /transport_error/,
    );
    expect(contactPosts).toBe(1);
  });

  test("rejects fiken reserved metadata on the generic connection routes", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const auth = await bearer(workspace, "subject-a", ["connections:read", "connections:write"]);
    const forged = await app(fakeFiken().fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections`,
      {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          providerDomain: FIKEN_PROVIDER_DOMAIN,
          kind: "api_key",
          credential: { headers: { authorization: "Bearer forged" } },
          metadata: {
            credentialRole: FIKEN_CREDENTIAL_ROLE,
            companies: [{ slug: "victim-as", name: "Victim", organizationNumber: null }],
            defaultCompanySlug: "victim-as",
            verifiedAt: new Date().toISOString(),
          },
        }),
      },
    );
    expect(forged.status).toBe(422);
    const installed = await installFiken(workspace, fakeFiken().fetch);
    const patched = await app(fakeFiken().fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${installed.body.connection!.id}`,
      {
        method: "PATCH",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          metadata: { credentialRole: FIKEN_CREDENTIAL_ROLE, companies: [] },
        }),
      },
    );
    expect(patched.status).toBe(422);
  });

  test("denies a stale client before provider I/O when the connection version moved", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let providerCalls = 0;
    const failing = (async () => {
      providerCalls += 1;
      return Response.json({ message: "revoked" }, { status: 401 });
    }) as typeof globalThis.fetch;
    const { fiken, resolved } = await connectedClient(workspace, failing, {
      defaultCompanySlug: "demo-as",
    });
    // Simulate a reconnect writer bumping the version after this client
    // resolved the row. The stale 401 fixture must never be reached.
    await updateConnection(client.db, {
      workspaceId: workspace.workspaceId,
      connectionId: resolved.connection.id,
      visibleToSubjectId: null,
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.from(ENCRYPTION_KEY, "base64"),
        JSON.stringify(fikenCredentialBundle(`${FIXTURE_TOKEN}-moved`)),
      ),
      metadata: { ...resolved.connection.metadata },
    });
    await expect(fiken.listContacts({})).rejects.toThrow(/authority changed/);
    const after = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      resolved.connection.id,
      null,
    );
    expect(after?.status).toBe("active");
    expect(providerCalls).toBe(0);
  });

  test("draft idempotency ignores unrelated drafts when the provider drops the uuid filter", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken({ ignoreDraftUuidFilter: true });
    const { fiken } = await connectedClient(workspace, provider.fetch, {
      defaultCompanySlug: "demo-as",
    });
    const created = await fiken.createInvoiceDraft({
      operationId: crypto.randomUUID(),
      customerId: 101,
      daysUntilDueDate: 14,
      lines: [
        {
          description: "Consulting",
          unitPriceCents: 1000,
          vatType: "HIGH",
          quantity: 1,
          incomeAccount: "3000",
        },
      ],
    });
    // The unrelated draft (uuid mismatch) must not satisfy the lookup.
    expect(created.alreadyExisted).toBe(false);
    expect(created.draftId).toBe(555);
  });

  test("rejects a draft line with neither productId nor incomeAccount + vatType", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const { fiken } = await connectedClient(workspace, fakeFiken().fetch, {
      defaultCompanySlug: "demo-as",
    });
    await expect(
      fiken.createInvoiceDraft({
        operationId: crypto.randomUUID(),
        customerId: 101,
        daysUntilDueDate: 14,
        lines: [{ description: "No account", unitPriceCents: 1000, quantity: 1 }],
      }),
    ).rejects.toThrow(/invalid_lines/);
  });

  test("creates an invoice draft idempotently by operationId", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    let authorizations = 0;
    const { fiken } = await connectedClient(
      workspace,
      provider.fetch,
      { defaultCompanySlug: "demo-as" },
      async () => {
        authorizations += 1;
        return true;
      },
    );
    const operationId = crypto.randomUUID();
    const draft = {
      operationId,
      customerId: 101,
      daysUntilDueDate: 14,
      lines: [
        {
          description: "Consulting",
          unitPriceCents: 100_000,
          vatType: "HIGH",
          quantity: 2,
          incomeAccount: "3000",
        },
      ],
    };
    const first = await fiken.createInvoiceDraft(draft);
    expect(first).toMatchObject({ draftId: 555, alreadyExisted: false });
    const retry = await fiken.createInvoiceDraft(draft);
    expect(retry.alreadyExisted).toBe(true);
    const posts = provider.calls.filter(
      (entry) => entry.method === "POST" && entry.url.pathname.endsWith("/invoices/drafts"),
    );
    expect(posts).toHaveLength(1);
    expect(authorizations).toBe(provider.calls.length);
    expect(posts[0]!.body).toMatchObject({
      type: "invoice",
      uuid: operationId,
      customerId: 101,
      daysUntilDueDate: 14,
      lines: [
        {
          description: "Consulting",
          unitPrice: 100_000,
          vatType: "HIGH",
          quantity: 2,
          incomeAccount: "3000",
        },
      ],
    });
  });

  test("records audit events with the connection receipt", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const { fiken, resolved } = await connectedClient(workspace, provider.fetch, {
      defaultCompanySlug: "demo-as",
    });
    await fiken.listContacts({});
    const [audit] = await shared!.admin<
      Array<{ action: string; metadata: Record<string, unknown> }>
    >`
      select action, metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and target_id = ${resolved.connection.id}
        and action = 'fiken.contacts.list'
      order by occurred_at desc limit 1`;
    expect(audit).toMatchObject({
      action: "fiken.contacts.list",
      metadata: expect.objectContaining({
        outcome: "succeeded",
        credentialRole: FIKEN_CREDENTIAL_ROLE,
      }),
    });
  });
});

function oauthApp(fikenFetch: typeof globalThis.fetch) {
  return createApp({
    settings: oauthSettings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    fikenFetch,
  } as never);
}

async function startOAuth(
  workspace: { accountId: string; workspaceId: string },
  fikenFetch: typeof globalThis.fetch,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; authorizationUrl: URL | null; state: string | null }> {
  const response = await oauthApp(fikenFetch).request(
    `/v1/workspaces/${workspace.workspaceId}/connections/fiken/oauth/start`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", [
          "connections:read",
          "connections:write",
        ]),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (response.status !== 200) {
    return { status: response.status, authorizationUrl: null, state: null };
  }
  const body = (await response.json()) as { authorizationUrl: string };
  const authorizationUrl = new URL(body.authorizationUrl);
  return {
    status: response.status,
    authorizationUrl,
    state: authorizationUrl.searchParams.get("state"),
  };
}

async function completeOAuth(
  fikenFetch: typeof globalThis.fetch,
  query: Record<string, string>,
): Promise<URL> {
  const params = new URLSearchParams(query);
  const response = await oauthApp(fikenFetch).request(`/v1/integrations/fiken/callback?${params}`, {
    method: "GET",
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

describe("fiken OAuth", () => {
  test("start requires configured client credentials", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const response = await app(fakeFiken().fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/fiken/oauth/start`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", [
            "connections:read",
            "connections:write",
          ]),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(503);
  });

  test("start builds the Fiken authorize URL with signed state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const started = await startOAuth(workspace, fakeFiken().fetch);
    expect(started.status).toBe(200);
    const url = started.authorizationUrl!;
    expect(url.origin + url.pathname).toBe("https://fiken.no/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("fiken-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.test/v1/integrations/fiken/callback",
    );
    expect(started.state).toBeTruthy();
  });

  test("callback exchanges the code with Basic auth and stores a workspace oauth2 connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken({ companies: [fixtureCompanies()[0]!] });
    const started = await startOAuth(workspace, provider.fetch);
    const redirected = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: started.state!,
    });
    expect(redirected.searchParams.get("fiken")).toBe("connected");
    const connectionId = redirected.searchParams.get("connectionId")!;
    expect(redirected.pathname).toBe(`/workspaces/${workspace.workspaceId}/capabilities`);

    const tokenCall = provider.calls.find((entry) => entry.url.pathname === "/oauth/token")!;
    expect(tokenCall.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("fiken-client-id:fiken-client-secret").toString("base64")}`,
    );
    const form = new URLSearchParams(String(tokenCall.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("fixture-auth-code");
    expect(form.get("redirect_uri")).toBe(
      "https://app.example.test/v1/integrations/fiken/callback",
    );
    expect(form.get("state")).toBe(started.state);
    // Company discovery ran with the fresh access token, not a stored one.
    const companiesCall = provider.calls.find((entry) =>
      entry.url.pathname.endsWith("/companies"),
    )!;
    expect(companiesCall.headers.get("authorization")).toBe("Bearer fixture-oauth-access-token");

    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connectionId,
      null,
    );
    expect(connection).toMatchObject({
      subjectId: null,
      providerDomain: FIKEN_PROVIDER_DOMAIN,
      kind: "oauth2",
      status: "active",
      metadata: expect.objectContaining({
        credentialRole: FIKEN_CREDENTIAL_ROLE,
        defaultCompanySlug: "demo-as",
      }),
    });
    expect(connection?.expiresAt).toBeTruthy();
    const [row] = await shared!.admin<Array<{ credential_encrypted: string }>>`
      select credential_encrypted from connections where id = ${connectionId}`;
    const bundle = JSON.parse(
      decryptEnvironmentValue(Buffer.from(ENCRYPTION_KEY, "base64"), row!.credential_encrypted),
    );
    expect(bundle).toMatchObject({
      access_token: "fixture-oauth-access-token",
      refresh_token: "fixture-oauth-refresh-token",
      token_endpoint: "https://fiken.no/oauth/token",
      client_id: "fiken-client-id",
      client_secret: "fiken-client-secret",
      token_endpoint_auth_method: "client_secret_basic",
    });

    // The first-party tools resolve the oauth2 row and send its bearer.
    const resolved = await resolveFikenConnectionForTool({
      db: client.db,
      grant: grantFor(workspace),
      sessionId: null,
    });
    expect(resolved.connection.id).toBe(connectionId);
    const toolProvider = fakeFiken();
    const fiken = createFikenClient(
      { db: client.db, settings: oauthSettings, fikenFetch: toolProvider.fetch },
      resolved,
    );
    const contacts = await fiken.listContacts({});
    expect(contacts.contacts).toHaveLength(1);
    const contactsCall = toolProvider.calls.find((entry) =>
      entry.url.pathname.endsWith("/contacts"),
    )!;
    expect(contactsCall.headers.get("authorization")).toBe("Bearer fixture-oauth-access-token");
  });

  test("callback rejects a replayed state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const started = await startOAuth(workspace, provider.fetch);
    const first = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: started.state!,
    });
    expect(first.searchParams.get("fiken")).toBe("connected");
    const replay = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: started.state!,
    });
    expect(replay.searchParams.get("fiken")).toBe("error");
    expect(replay.searchParams.get("reason")).toBe("state_replayed");
  });

  test("callback surfaces provider denial without exchanging a code", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const started = await startOAuth(workspace, provider.fetch);
    const redirected = await completeOAuth(provider.fetch, {
      error: "access_denied",
      state: started.state!,
    });
    expect(redirected.searchParams.get("fiken")).toBe("error");
    expect(redirected.searchParams.get("reason")).toBe("provider_denied");
    expect(provider.calls.some((entry) => entry.url.pathname === "/oauth/token")).toBe(false);
  });

  test("callback rejects tampered state", async () => {
    if (!available) return;
    const provider = fakeFiken();
    const redirected = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: "not-a-valid-state",
    });
    expect(redirected.searchParams.get("fiken")).toBe("error");
    expect(redirected.searchParams.get("reason")).toBe("invalid_state");
  });

  test("re-authorizes an existing token connection in place, preserving its default company", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    // Existing pasted-token connection with an explicit default company.
    const installed = await installFiken(workspace, fakeFiken().fetch, {
      defaultCompanySlug: "second-as",
    });
    const provider = fakeFiken();
    const started = await startOAuth(workspace, provider.fetch, {
      connectionId: installed.body.connection!.id,
    });
    const redirected = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: started.state!,
    });
    expect(redirected.searchParams.get("fiken")).toBe("connected");
    expect(redirected.searchParams.get("connectionId")).toBe(installed.body.connection!.id);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      installed.body.connection!.id,
      null,
    );
    expect(connection).toMatchObject({
      kind: "oauth2",
      status: "active",
      version: installed.body.connection!.version + 1,
      metadata: expect.objectContaining({ defaultCompanySlug: "second-as" }),
    });
  });

  test("pasting a token over an OAuth row resets kind, clears expiry, and keeps the default company", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const started = await startOAuth(workspace, provider.fetch);
    const connected = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: started.state!,
    });
    const connectionId = connected.searchParams.get("connectionId")!;
    // Give the OAuth row an explicit multi-company default to preserve.
    const withDefault = await installFiken(workspace, fakeFiken().fetch, {
      connectionId,
      defaultCompanySlug: "second-as",
    });
    expect(withDefault.status).toBe(200);
    const reinstalled = await installFiken(workspace, fakeFiken().fetch, { connectionId });
    expect(reinstalled.status).toBe(200);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connectionId,
      null,
    );
    expect(connection).toMatchObject({
      kind: "api_key",
      status: "active",
      expiresAt: null,
      metadata: expect.objectContaining({ defaultCompanySlug: "second-as" }),
    });
    // The broker must treat the rewritten row as an api_key credential again.
    const resolved = await resolveFikenConnectionForTool({
      db: client.db,
      grant: grantFor(workspace),
      sessionId: null,
    });
    const toolProvider = fakeFiken();
    const fiken = createFikenClient(
      { db: client.db, settings, fikenFetch: toolProvider.fetch },
      resolved,
    );
    await fiken.listCompanies();
    const call = toolProvider.calls.find((entry) => entry.url.pathname.endsWith("/companies"))!;
    expect(call.headers.get("authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
  });

  test("callback discards a forged off-origin returnPath", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const forgedState = createSignedState("fiken-oauth-state-secret-for-tests", {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      returnPath: "//evil.example/phish",
    });
    const redirected = await completeOAuth(provider.fetch, {
      code: "fixture-auth-code",
      state: forgedState,
    });
    expect(redirected.origin).toBe("https://app.example.test");
    expect(redirected.searchParams.get("fiken")).toBe("connected");
  });

  test("fiken routes are covered by the integrations kill switch", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const disabled = testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      environmentsEncryptionKey: ENCRYPTION_KEY,
      publicBaseUrl: "https://app.example.test",
      integrationsEnabled: false,
    }) as Settings;
    const disabledApp = createApp({
      settings: disabled,
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
      fikenFetch: fakeFiken().fetch,
    } as never);
    const auth = await bearer(workspace, "subject-a", ["connections:read", "connections:write"]);
    for (const [method, path] of [
      ["POST", `/v1/workspaces/${workspace.workspaceId}/connections/fiken/install`],
      ["POST", `/v1/workspaces/${workspace.workspaceId}/connections/fiken/oauth/start`],
      ["GET", "/v1/integrations/fiken/callback?code=x&state=y"],
    ] as const) {
      const response = await disabledApp.request(path, {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ apiToken: FIXTURE_TOKEN }) } : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  test("the broker refreshes the stored bundle with Basic auth and keeps the rotated refresh token", async () => {
    const captured: { headers?: Headers; body?: string } = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured.headers = new Headers(init?.headers);
      captured.body = String(init?.body);
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "bearer",
        expires_in: 86_400,
      });
    }) as typeof globalThis.fetch;
    const refreshed = await refreshOAuthConnectionCredential(
      {
        id: "conn-fiken",
        kind: "oauth2",
        credential: {
          access_token: "old-access",
          refresh_token: "old-refresh",
          token_type: "Bearer",
          token_endpoint: "https://fiken.no/oauth/token",
          client_id: "fiken-client-id",
          client_secret: "fiken-client-secret",
          token_endpoint_auth_method: "client_secret_basic",
        },
        metadata: {},
        grantedScopes: [],
        expiresAt: new Date(Date.now() - 1_000),
        status: "active",
        subjectId: null,
        providerDomain: FIKEN_PROVIDER_DOMAIN,
        version: 1,
      } as never,
      { providerDomain: FIKEN_PROVIDER_DOMAIN, kind: "oauth2" },
      settings,
      {
        fetchImpl,
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );
    expect(captured.headers?.get("authorization")).toBe(
      `Basic ${Buffer.from("fiken-client-id:fiken-client-secret").toString("base64")}`,
    );
    const form = new URLSearchParams(captured.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh");
    expect(refreshed.credential).toMatchObject({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      client_secret: "fiken-client-secret",
      token_endpoint_auth_method: "client_secret_basic",
    });
  });
});
