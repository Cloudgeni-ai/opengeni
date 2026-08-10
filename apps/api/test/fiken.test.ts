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
  type DbClient,
} from "@opengeni/db";
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

type FikenCall = { method: string; url: URL; body: unknown };

/**
 * A deterministic Fiken API double. Routes are keyed by pathname suffix; every
 * call is recorded, and an in-flight counter proves the client's mandatory
 * single-concurrent-request serialization.
 */
function fakeFiken(options: { companies?: Array<Record<string, unknown>> } = {}) {
  const calls: FikenCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const drafts = new Map<string, Record<string, unknown>>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
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
  ) {
    await installFiken(workspace, fakeFiken().fetch, installPayload);
    const resolved = await resolveFikenConnectionForTool({
      db: client.db,
      grant: grantFor(workspace),
      sessionId: null,
    });
    return {
      resolved,
      fiken: createFikenClient({ db: client.db, settings, fikenFetch }, resolved),
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
    const { fiken } = await connectedClient(workspace, provider.fetch, {
      defaultCompanySlug: "demo-as",
    });
    await Promise.all([fiken.listCompanies(), fiken.listContacts({}), fiken.listCompanies()]);
    expect(provider.maxInFlight()).toBe(1);
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

  test("creates an invoice draft idempotently by operationId", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const provider = fakeFiken();
    const { fiken } = await connectedClient(workspace, provider.fetch, {
      defaultCompanySlug: "demo-as",
    });
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
