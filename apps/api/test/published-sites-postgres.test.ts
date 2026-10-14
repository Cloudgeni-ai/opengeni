import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SITE_GATEWAY_CALLBACK_PATH, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createSiteViewerSession,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { signSiteGatewayRequest } from "../src/site-publishing/gateway-signature";
import type { SiteContentScanner } from "../src/site-publishing/content-scanner";
import { moderateSiteAsPlatform } from "../src/site-publishing/platform";
import { configureSitePublishingEffects } from "../src/site-publishing/service";

// Published Sites run the real management, sign-in and site-runtime routes
// against PostgreSQL as the restricted application role. The gateway is played
// by signing requests with the shared secret, exactly as it signs them.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("published-sites");
  if (!acquired) throw new Error("Published Sites tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const DOMAIN = "sites.example.test";
const SECRET = "c".repeat(40);
const PREVIOUS_SECRET = "p".repeat(40);
const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "artifacts:read",
  "artifacts:publish",
] as const;

function memoryObjectStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
    },
    getObjectRange: async (input: { key: string; start: number; endInclusive: number }) => {
      const bytes = objects.get(input.key);
      return bytes
        ? { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v" }
        : null;
    },
    putObject: async (input: { key: string; body: Uint8Array }) => {
      objects.set(input.key, input.body.slice());
    },
    putObjectStreamIfAbsent: async (input: { key: string; chunks: AsyncIterable<Uint8Array> }) => {
      if (objects.has(input.key)) return false;
      const parts: Uint8Array[] = [];
      for await (const part of input.chunks) parts.push(part);
      objects.set(input.key, Buffer.concat(parts));
      return true;
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/html" } : null;
    },
    createGetUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createPutUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
      requiredHeaders: {},
    }),
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  };
  return storage as unknown as ObjectStorageDependency;
}

type Who = { subjectId: string; headers: Record<string, string> };
type Result = { status: number; json: any; headers: Headers };

async function read(response: Response): Promise<Result> {
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, headers: response.headers };
}

const code = (result: Result) => result.json?.error?.details?.code;
const visitorId = () => randomBytes(18).toString("base64url");
const sitesSettings = (overrides: Partial<Settings> = {}) =>
  testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    delegationSecret: randomBytes(32).toString("hex"),
    sitesDomain: DOMAIN,
    sitesGatewaySecret: SECRET,
    sitesGatewaySecretPrevious: PREVIOUS_SECRET,
    sessionUsageLimitsEnabled: true,
    ...overrides,
  });

async function fixture(overrides: Partial<Settings> = {}) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Published Sites fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "artifacts:read",
      "artifacts:publish",
      "account:admin",
    ],
  });
  const storage = memoryObjectStorage();
  const depsWith = (settings: Settings) =>
    ({
      db: db.db,
      bus: new MemoryEventBus(),
      settings,
      objectStorage: storage,
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
      managedAuth: null,
    }) as unknown as AppDependencies;
  const appWith = (settings: Settings) => createApp(depsWith(settings));
  const settings = sitesSettings(overrides);
  const deps = depsWith(settings);
  const app = createApp(deps);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (permissions: readonly string[]): Promise<Who> => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person(memberPermissions);
  const member = await person(memberPermissions);
  const admin = await person([...memberPermissions, "workspace:admin"]);
  const api = async (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    await read(
      await app.request(path, {
        method,
        headers: who.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const sites = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const publish = async (title: string, visibility: "private" | "workspace" = "workspace") => {
    const created = await api(owner, "POST", sites, {
      title,
      html: `<!doctype html><h1>${title}</h1><a href="https://example.com/${encodeURIComponent(title)}">x</a>`,
      idempotencyKey: crypto.randomUUID(),
      visibility,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return { id: String(created.json.artifact.id), versionId: String(created.json.version.id) };
  };
  const publication = (who: Who, siteId: string, method: string, body?: unknown, suffix = "") =>
    api(who, method, `${sites}/${siteId}/publication${suffix}`, body);
  /** Publish a Site and its publication; returns the Site and its host. */
  const live = async (title: string, request: Record<string, unknown> = {}) => {
    const site = await publish(title);
    const published = await publication(owner, site.id, "PUT", request);
    expect(published.status, JSON.stringify(published.json)).toBe(201);
    return { ...site, host: String(published.json.hostname), publication: published.json };
  };
  /** A request as the gateway sends it: signed over method, host, path, body and viewer fields. */
  const gateway = async (
    host: string,
    method: string,
    path: string,
    options: {
      body?: unknown;
      session?: string;
      visitor?: string;
      human?: boolean;
      clientIp?: string;
      secret?: string;
      nowMs?: number;
      headers?: Record<string, string>;
      sendBody?: string;
      on?: ReturnType<typeof appWith>;
    } = {},
  ) => {
    const pathWithQuery = `/v1/site-runtime${path}`;
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const signed = signSiteGatewayRequest({
      secret: options.secret ?? SECRET,
      method,
      pathWithQuery,
      host,
      body,
      ...(options.session ? { session: options.session } : {}),
      ...(options.visitor ? { visitor: options.visitor } : {}),
      ...(options.human ? { human: true } : {}),
      clientIp: options.clientIp ?? "198.51.100.7",
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
    const sent = options.sendBody ?? body;
    return await read(
      await (options.on ?? app).request(pathWithQuery, {
        method,
        headers: {
          ...signed,
          ...(sent ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(sent ? { body: sent } : {}),
      }),
    );
  };
  /** Viewer sign-in: authorize as the person, then exchange as the gateway. */
  const authorize = async (
    who: Who,
    host: string,
    verifier = randomBytes(32).toString("base64url"),
  ) => {
    const result = await api(who, "POST", "/v1/site-auth/authorize", {
      host,
      state: randomBytes(16).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
    });
    const redirect = result.status === 200 ? new URL(result.json.redirectTo) : null;
    return { ...result, code: redirect?.searchParams.get("code") ?? "", verifier };
  };
  const exchange = (host: string, authCode: string, verifier: string, codeHost = host) =>
    gateway(host, "POST", "/auth/exchange", {
      body: {
        code: authCode,
        codeVerifier: verifier,
        redirectUri: `https://${codeHost}${SITE_GATEWAY_CALLBACK_PATH}`,
      },
    });
  const signIn = async (who: Who, host: string): Promise<string> => {
    const authorized = await authorize(who, host);
    expect(authorized.status, JSON.stringify(authorized.json)).toBe(200);
    const exchanged = await exchange(host, authorized.code, authorized.verifier);
    expect(exchanged.status, JSON.stringify(exchanged.json)).toBe(200);
    return String(exchanged.json.sessionToken);
  };
  return {
    app,
    deps,
    appWith,
    settings,
    accountId,
    workspace,
    owner,
    member,
    admin,
    person,
    api,
    sites,
    publish,
    publication,
    live,
    gateway,
    authorize,
    exchange,
    signIn,
  };
}

test("publishing is off without a Sites domain", async () => {
  const f = await fixture({ sitesDomain: undefined, sitesGatewaySecret: undefined });
  const site = await f.publish("Disabled");
  const disabled = await f.publication(f.owner, site.id, "GET");
  expect(disabled.status).toBe(404);
  expect(code(disabled)).toBe("sites_publishing_disabled");
  expect(code(await f.publication(f.owner, site.id, "PUT", {}))).toBe("sites_publishing_disabled");
  const runtime = await f.gateway("x.sites.example.test", "GET", "/site/config");
  expect(runtime.status).toBe(404);
  expect(code(runtime)).toBe("sites_publishing_disabled");
});

test("managers publish workspace Sites under globally unique, held hostnames", async () => {
  const f = await fixture();
  const other = await fixture();
  const site = await f.publish("Team CRM");

  // Viewers of the Site are not its managers; Only me Sites cannot be published.
  const denied = await f.publication(f.member, site.id, "PUT", {});
  expect(denied.status).toBe(403);
  expect(code(denied)).toBe("site_manager_required");
  const privateSite = await f.publish("Mine only", "private");
  const notShared = await f.publication(f.owner, privateSite.id, "PUT", {});
  expect(notShared.status).toBe(409);
  expect(code(notShared)).toBe("site_not_shared");
  expect((await f.publication(f.owner, site.id, "GET")).status).toBe(404);

  // A new publication takes a suggested label with a random suffix and strict defaults.
  const created = await f.publication(f.owner, site.id, "PUT", {});
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json).toMatchObject({
    siteId: site.id,
    status: "active",
    access: "members",
    noindex: true,
    limitProfile: { kind: "free" },
    effectiveLimits: { requestsPerMinutePerVisitor: 120, turnsPerConversation: 20 },
    moderation: { openReports: 0, suspendedAt: null },
  });
  expect(created.json.label).toMatch(/^team-crm-[a-z0-9]{4}$/u);
  expect(created.json.hostname).toBe(`${created.json.label}.${DOMAIN}`);
  expect((await f.publication(f.owner, site.id, "GET")).status).toBe(200);

  const renamed = await f.publication(f.owner, site.id, "PUT", { label: "team-crm" });
  expect(renamed.status).toBe(200);
  expect(renamed.json.hostname).toBe(`team-crm.${DOMAIN}`);

  // Availability: the label rules, then global uniqueness.
  const check = (who: Who, label: string, siteId?: string) =>
    f.api(
      who,
      "GET",
      `/v1/workspaces/${f.workspace.id}/site-hostnames/${label}${siteId ? `?siteId=${siteId}` : ""}`,
    );
  expect((await check(f.member, "team-crm")).json).toMatchObject({
    available: false,
    problem: "taken",
  });
  expect((await check(f.member, "team-crm", site.id)).json).toMatchObject({ available: true });
  expect((await check(f.member, "www")).json).toMatchObject({
    available: false,
    problem: "reserved",
  });
  expect((await check(f.member, "-bad")).json.available).toBe(false);

  // Another workspace cannot take it, nor take it back within the hold after it is released.
  const theirs = await other.publish("Their CRM");
  const taken = await other.publication(other.owner, theirs.id, "PUT", { label: "team-crm" });
  expect(taken.status).toBe(409);
  expect(code(taken)).toBe("site_taken");
  expect((await f.publication(f.owner, site.id, "PUT", { label: "team-crm-two" })).status).toBe(
    200,
  );
  const held = await other.publication(other.owner, theirs.id, "PUT", { label: "team-crm" });
  expect(held.status).toBe(409);
  expect(code(held)).toBe("site_held");
  // The releasing workspace may reuse its own released label.
  const sibling = await f.publish("Sibling");
  const reused = await f.publication(f.owner, sibling.id, "PUT", { label: "team-crm" });
  expect(reused.status, JSON.stringify(reused.json)).toBe(201);
  // The old host no longer names the Site; the new one does.
  expect(
    code(await f.gateway(`team-crm-two.${DOMAIN}`, "GET", `/host?host=team-crm-two.${DOMAIN}`)),
  ).toBe(undefined);

  // Limit profiles are a workspace admin's call.
  const ownerLimits = await f.publication(f.owner, site.id, "PUT", {
    limitProfile: { kind: "unlimited" },
  });
  expect(ownerLimits.status).toBe(403);
  expect(code(ownerLimits), JSON.stringify(ownerLimits.json)).toBe("site_admin_required");
  const adminLimits = await f.publication(f.admin, site.id, "PUT", {
    limitProfile: { kind: "custom", overrides: { turnsPerConversation: 3 } },
  });
  expect(adminLimits.status, JSON.stringify(adminLimits.json)).toBe(200);
  expect(adminLimits.json.effectiveLimits.turnsPerConversation).toBe(3);
  const workspaceProfile = `/v1/workspaces/${f.workspace.id}/site-limit-profile`;
  expect((await f.api(f.member, "PUT", workspaceProfile, { kind: "credits" })).status).toBe(403);
  const credits = await f.api(f.admin, "PUT", workspaceProfile, { kind: "credits" });
  expect(credits.status).toBe(200);
  expect(credits.json.effectiveLimits.conversationsPerVisitorPerDay).toBe(100);
  expect((await f.api(f.member, "GET", workspaceProfile)).json.profile.kind).toBe("credits");
  // The sibling inherits the workspace default; the first Site keeps its own.
  expect((await f.publication(f.owner, sibling.id, "GET")).json.limitProfile.kind).toBe("credits");
  expect((await f.publication(f.owner, site.id, "GET")).json.limitProfile.kind).toBe("custom");

  // Unpublishing stops serving and keeps the label.
  const unpublished = await f.publication(f.owner, site.id, "DELETE");
  expect(unpublished.json).toMatchObject({ status: "unpublished", label: "team-crm-two" });
  const gone = await f.gateway(`team-crm-two.${DOMAIN}`, "GET", "/site/config", {
    visitor: visitorId(),
  });
  expect(gone.status).toBe(410);
  expect(gone.json.error.details).toMatchObject({
    code: "site_unavailable",
    status: "unpublished",
  });
  // An unknown host is not a Site at all.
  const unknown = await f.gateway(`nobody-here.${DOMAIN}`, "GET", "/site/config");
  expect(unknown.status).toBe(404);
  expect(code(unknown)).toBe("site_not_found");
}, 60_000);

test("site-runtime checks the gateway signature before anything else", async () => {
  const f = await fixture();
  const site = await f.live("Signed", { access: "public" });
  const visitor = visitorId();
  const reason = (result: Result) => result.json?.error?.details?.reason;

  const unsigned = await read(await f.app.request("/v1/site-runtime/site/config"));
  expect(unsigned.status).toBe(401);
  expect(code(unsigned)).toBe("site_gateway_signature_invalid");
  expect(reason(unsigned)).toBe("missing_headers");

  const foreign = await f.gateway(site.host, "GET", "/site/config", {
    visitor,
    secret: "f".repeat(40),
  });
  expect(foreign.status).toBe(401);
  expect(reason(foreign)).toBe("bad_signature");
  const stale = await f.gateway(site.host, "GET", "/site/config", {
    visitor,
    nowMs: Date.now() - 60_000,
  });
  expect(stale.status).toBe(401);
  expect(reason(stale)).toBe("skew");
  const tampered = await f.gateway(site.host, "POST", "/site/reports", {
    body: { category: "spam" },
    sendBody: JSON.stringify({ category: "phishing" }),
    visitor,
  });
  expect(tampered.status).toBe(401);
  expect(reason(tampered)).toBe("bad_signature");
  // A signed request must not also carry app credentials.
  for (const headers of [
    { authorization: "Bearer anything" },
    { cookie: "session=1" },
    { "x-api-key": "k" },
  ]) {
    const carrying = await f.gateway(site.host, "GET", "/site/config", { visitor, headers });
    expect(carrying.status).toBe(401);
    expect(reason(carrying)).toBe("credentials");
  }

  // The current and the previous secret both pass.
  const config = await f.gateway(site.host, "GET", "/site/config", { visitor });
  expect(config.status, JSON.stringify(config.json)).toBe(200);
  expect(config.json).toMatchObject({
    siteId: site.id,
    hostname: site.host,
    versionId: site.versionId,
    access: "public",
    viewer: { kind: "guest", id: `guest:${visitor}`, signedIn: false, name: null },
    agent: { enabled: true },
    siteData: true,
    abuseEmail: `abuse@${DOMAIN}`,
  });
  expect(config.headers.get("cache-control")).toBe("no-store");
  expect(config.headers.get("set-cookie")).toBeNull();
  const rotated = await f.gateway(site.host, "GET", "/site/config", {
    visitor,
    secret: PREVIOUS_SECRET,
  });
  expect(rotated.status).toBe(200);

  // The host lookup answers only for the signed host.
  const lookup = await f.gateway(site.host, "GET", `/host?host=${site.host}`);
  expect(lookup.json).toMatchObject({
    v: 1,
    hostname: site.host,
    siteId: site.id,
    status: "active",
    access: "public",
    versionId: site.versionId,
  });
  expect((await f.gateway(site.host, "GET", `/host?host=other.${DOMAIN}`)).status).toBe(400);
  // Paths outside the allowlist are refused even when signed.
  const outside = await f.gateway(site.host, "GET", "/v1/workspaces", { visitor });
  expect(outside.status).toBe(404);
  expect(code(outside)).toBe("site_operation_unsupported");
  // The API verifies the path it received: a dot segment the URL parser removed no longer matches.
  const traversal = await f.gateway(site.host, "GET", "/sessions/../published-artifacts", {
    visitor,
  });
  expect(traversal.status).toBe(401);

  // Minimal workspace and model views; tools are not available to published Sites.
  const workspace = await f.gateway(site.host, "GET", "", { visitor });
  expect(workspace.json).toEqual({ id: f.workspace.id, name: "Signed" });
  expect((await f.gateway(site.host, "GET", "/model-catalog", { visitor })).json).toMatchObject({
    models: [],
    defaultModel: null,
  });
  const tools = await f.gateway(site.host, "POST", "/tools/catalog", { visitor, body: {} });
  expect(tools.status).toBe(403);
  expect(code(tools)).toBe("site_tools_unavailable");
}, 60_000);

test("viewer sign-in: one-time PKCE codes bound to their host, then revocable sessions", async () => {
  const f = await fixture();
  const outsiders = await fixture();
  const outsider = outsiders.owner;
  const site = await f.live("Members only");
  const elsewhere = await f.live("Another Site");

  // Only people sign in: an API key or service credential is refused.
  const service = await f.api(
    {
      headers: {
        authorization: f.owner.headers.authorization!,
        "content-type": "application/json",
      },
    },
    "POST",
    "/v1/site-auth/authorize",
    {
      host: site.host,
      state: randomBytes(16).toString("base64url"),
      codeChallenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
      codeChallengeMethod: "S256",
      redirectUri: `https://${site.host}${SITE_GATEWAY_CALLBACK_PATH}`,
    },
  );
  expect(service.status).toBe(403);
  expect(code(service)).toBe("site_person_required");
  // Non-members of a members Site, unknown hosts and foreign redirects are refused.
  const notMember = await f.authorize(outsider, site.host);
  expect(notMember.status).toBe(403);
  expect(code(notMember)).toBe("site_access_denied");
  expect((await f.authorize(f.member, `nobody-here.${DOMAIN}`)).status).toBe(404);
  const foreignRedirect = await f.api(f.member, "POST", "/v1/site-auth/authorize", {
    host: site.host,
    state: randomBytes(16).toString("base64url"),
    codeChallenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
    codeChallengeMethod: "S256",
    redirectUri: `https://evil.example/${SITE_GATEWAY_CALLBACK_PATH}`,
  });
  expect(foreignRedirect.status).toBe(400);

  // A wrong verifier burns the code; it cannot be replayed with the right one.
  const first = await f.authorize(f.member, site.host);
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(first.json.site).toEqual({ title: "Members only", hostname: site.host });
  expect(new URL(first.json.redirectTo).origin).toBe(`https://${site.host}`);
  const wrongVerifier = await f.exchange(
    site.host,
    first.code,
    randomBytes(32).toString("base64url"),
  );
  expect(wrongVerifier.status).toBe(400);
  expect(code(wrongVerifier)).toBe("site_auth_code_invalid");
  expect(code(await f.exchange(site.host, first.code, first.verifier))).toBe(
    "site_auth_code_invalid",
  );
  // A code is bound to its host: another Site's gateway cannot redeem it.
  const second = await f.authorize(f.member, site.host);
  expect(code(await f.exchange(elsewhere.host, second.code, second.verifier, site.host))).toBe(
    "site_auth_code_invalid",
  );
  expect(code(await f.exchange(elsewhere.host, second.code, second.verifier))).toBe(
    "site_auth_code_invalid",
  );
  // Expired codes are refused.
  const third = await f.authorize(f.member, site.host);
  await shared.admin`update site_auth_codes set expires_at = now() - interval '1 second'
    where site_id = ${site.id} and consumed_at is null`;
  expect(code(await f.exchange(site.host, third.code, third.verifier))).toBe(
    "site_auth_code_invalid",
  );

  // The happy path, single use.
  const fourth = await f.authorize(f.member, site.host);
  const exchanged = await f.exchange(site.host, fourth.code, fourth.verifier);
  expect(exchanged.status, JSON.stringify(exchanged.json)).toBe(200);
  expect(exchanged.json.viewer).toMatchObject({
    kind: "member",
    id: `user:${f.member.subjectId}`,
    signedIn: true,
  });
  expect(exchanged.json.sessionToken.length).toBeGreaterThanOrEqual(32);
  expect(code(await f.exchange(site.host, fourth.code, fourth.verifier))).toBe(
    "site_auth_code_invalid",
  );
  const [stored] = await shared.admin`select count(*)::int as n from site_viewer_sessions
    where site_id = ${site.id} and token_hash = ${createHash("sha256").update(exchanged.json.sessionToken).digest("hex")}`;
  expect(stored!.n).toBe(1);
  const [metered] = await shared.admin`select count(*)::int as n from usage_events
    where workspace_id = ${f.workspace.id} and event_type = 'site_runtime.sign_in'`;
  expect(metered!.n).toBe(1);

  const session = String(exchanged.json.sessionToken);
  const config = await f.gateway(site.host, "GET", "/site/config", { session });
  expect(config.json.viewer).toMatchObject({ kind: "member", signedIn: true });
  // A session is valid only on its own Site.
  expect(code(await f.gateway(elsewhere.host, "GET", "/site/config", { session }))).toBe(
    "site_sign_in_required",
  );
  const logout = await f.gateway(site.host, "POST", "/auth/logout", { session, body: {} });
  expect(logout.json).toEqual({ revoked: true });
  const after = await f.gateway(site.host, "GET", "/site/config", { session });
  expect(after.status).toBe(401);
  expect(code(after)).toBe("site_sign_in_required");
}, 60_000);

test("access modes: members, invited, public guests, login-only and public off", async () => {
  const f = await fixture();
  const outsiders = await fixture();
  const outsider = outsiders.owner;
  const members = await f.live("Members");
  const invited = await f.live("Invited", {
    access: "invited",
    invitedEmails: ["Guest@Example.com"],
  });
  const open = await f.live("Open", { access: "public" });

  // Members Sites: no guests; signed-in members only.
  const anonymous = await f.gateway(members.host, "GET", "/site/config", { visitor: visitorId() });
  expect(anonymous.status).toBe(401);
  expect(code(anonymous)).toBe("site_sign_in_required");

  // Invited Sites admit verified invited emails; access is re-read on every call.
  const token = randomBytes(32).toString("base64url");
  await createSiteViewerSession(
    db.db,
    { accountId: f.accountId, workspaceId: f.workspace.id },
    {
      siteId: invited.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      subjectId: outsider.subjectId,
      kind: "invited",
      email: "guest@example.com",
      displayName: "Invited Guest",
      absoluteSeconds: 3_600,
    },
  );
  const asInvited = await f.gateway(invited.host, "GET", "/site/config", { session: token });
  expect(asInvited.json.viewer).toMatchObject({
    kind: "invited",
    email: "guest@example.com",
    name: "Invited Guest",
  });
  expect((await f.authorize(outsider, invited.host)).status).toBe(403);
  expect((await f.publication(f.owner, invited.id, "PUT", { invitedEmails: [] })).status).toBe(200);
  const uninvited = await f.gateway(invited.host, "GET", "/site/config", { session: token });
  expect(uninvited.status).toBe(403);
  expect(code(uninvited)).toBe("site_access_denied");

  // Public Sites: guests by visitor id, and any signed-in person.
  const visitor = visitorId();
  expect((await f.gateway(open.host, "GET", "/site/config", { visitor })).json.viewer.kind).toBe(
    "guest",
  );
  expect((await f.gateway(open.host, "GET", "/site/config", { visitor: "short" })).status).toBe(
    401,
  );
  const asUser = await f.signIn(outsider, open.host);
  expect(
    (await f.gateway(open.host, "GET", "/site/config", { session: asUser })).json.viewer,
  ).toMatchObject({
    kind: "user",
    id: `user:${outsider.subjectId}`,
  });

  // Login-only deployments: public means any signed-in person, never a guest.
  const loginOnly = f.appWith(sitesSettings({ sitesLoginOnly: true }));
  const noGuests = await f.gateway(open.host, "GET", "/site/config", { visitor, on: loginOnly });
  expect(noGuests.status).toBe(401);
  expect(code(noGuests)).toBe("site_sign_in_required");
  expect(
    (await f.gateway(open.host, "GET", "/site/config", { session: asUser, on: loginOnly })).status,
  ).toBe(200);

  // With public Sites off, public ones fall back to members only and cannot be chosen.
  const publicOffSettings = sitesSettings({ sitesPublicEnabled: false });
  const publicOff = f.appWith(publicOffSettings);
  expect(
    (await f.gateway(open.host, "GET", "/site/config", { visitor, on: publicOff })).status,
  ).toBe(401);
  const outsiderOff = await f.gateway(open.host, "GET", "/site/config", {
    session: asUser,
    on: publicOff,
  });
  expect(outsiderOff.status).toBe(403);
  const refused = await read(
    await publicOff.request(`${f.sites}/${members.id}/publication`, {
      method: "PUT",
      headers: f.owner.headers,
      body: JSON.stringify({ access: "public" }),
    }),
  );
  expect(refused.status).toBe(403);
  expect(code(refused)).toBe("site_public_disabled");
}, 60_000);

test("guests reach Site Data only through each collection's guest rule", async () => {
  const f = await fixture();
  const site = await f.live("Guestbook", { access: "public" });
  const define = (name: string, definition: Record<string, unknown>) =>
    f.api(f.owner, "PUT", `${f.sites}/${site.id}/data/collections/${name}`, definition);
  for (const [name, definition] of [
    ["notes", { accessMode: "shared" }],
    ["board", { accessMode: "shared_read", guestAccess: "read" }],
    ["guestbook", { accessMode: "append_only", guestAccess: "append" }],
    ["todo", { accessMode: "per_viewer", guestAccess: "own" }],
  ] as const) {
    const defined = await define(name, definition);
    expect({ name, status: defined.status }).toEqual({ name, status: 201 });
  }
  expect(
    (await define("board", { accessMode: "shared_read", guestAccess: "read" })).json,
  ).toMatchObject({
    guestAccess: "read",
  });
  await f.api(f.owner, "POST", `${f.sites}/${site.id}/data/write`, {
    operations: [
      { op: "insert", collection: "board", data: { title: "Welcome" } },
      { op: "insert", collection: "notes", data: { secret: true } },
    ],
  });

  const visitor = visitorId();
  const data = (
    method: string,
    path: string,
    body?: unknown,
    who: { visitor?: string; session?: string } = { visitor },
  ) =>
    f.gateway(site.host, method, `/published-artifacts/current${path}`, {
      ...who,
      ...(body === undefined ? {} : { body }),
    });
  const hidden = await data("POST", "/data/query", { collection: "notes" });
  expect(hidden.status).toBe(403);
  expect(hidden.json.error.details).toMatchObject({ reason: "guest_access" });
  const board = await data("POST", "/data/query", { collection: "board" });
  expect(board.status, JSON.stringify(board.json)).toBe(200);
  expect(board.json.records.map((record: any) => record.data.title)).toEqual(["Welcome"]);
  expect(
    (
      await data("POST", "/data/write", {
        operations: [{ op: "insert", collection: "board", data: {} }],
      })
    ).status,
  ).toBe(403);
  const signed = await data("POST", "/data/write", {
    operations: [{ op: "insert", collection: "guestbook", data: { text: "hi" } }],
  });
  expect(signed.status, JSON.stringify(signed.json)).toBe(200);
  expect(signed.json.results[0].record.owner).toBe(`guest:${visitor}`);
  // Own records: a guest sees and changes only its own.
  const mine = await data("POST", "/data/write", {
    operations: [{ op: "insert", collection: "todo", data: { task: "mine" } }],
  });
  const theirs = await data(
    "POST",
    "/data/write",
    { operations: [{ op: "insert", collection: "todo", data: { task: "theirs" } }] },
    { visitor: visitorId() },
  );
  expect(mine.status).toBe(200);
  expect(theirs.status).toBe(200);
  const own = await data("POST", "/data/query", { collection: "todo" });
  expect(own.json.records.map((record: any) => record.data.task)).toEqual(["mine"]);
  const foreign = await data("POST", "/data/write", {
    operations: [{ op: "delete", collection: "todo", id: theirs.json.results[0].record.id }],
  });
  expect(foreign.status).not.toBe(200);
  // Files are for signed-in viewers only.
  const files = await data("GET", "/files");
  expect(files.status).toBe(403);
  // A signed-in member reads collections closed to guests.
  const session = await f.signIn(f.member, site.host);
  expect((await data("POST", "/data/query", { collection: "notes" }, { session })).status).toBe(
    200,
  );

  // Guest writes are rate limited per visitor.
  expect(
    (
      await f.publication(f.admin, site.id, "PUT", {
        limitProfile: { kind: "custom", overrides: { guestWritesPerMinute: 2 } },
      })
    ).status,
  ).toBe(200);
  const writer = visitorId();
  const write = () =>
    data(
      "POST",
      "/data/write",
      { operations: [{ op: "insert", collection: "guestbook", data: { text: "again" } }] },
      { visitor: writer },
    );
  expect((await write()).status).toBe(200);
  expect((await write()).status).toBe(200);
  const limited = await write();
  expect(limited.status).toBe(429);
  expect(limited.json.error.details).toMatchObject({
    code: "site_rate_limited",
    bucket: "guest_writes",
  });
}, 60_000);

test("agent conversations run as the Site, belong to one viewer and stay within budgets", async () => {
  const f = await fixture({ sitesGuestAgentHumanCheck: true });
  const site = await f.live("Helpdesk", {
    access: "public",
    agent: { enabled: true, instructions: "Answer questions about the helpdesk." },
  });
  const sibling = await f.live("Sibling desk", { access: "public" });
  const visitor = visitorId();
  const start = (
    host: string,
    who: { visitor?: string; session?: string; human?: boolean },
    text = "Hello",
  ) => f.gateway(host, "POST", "/sessions", { ...who, body: { initialMessage: text } });

  // Guests prove they are human first when the deployment asks for it.
  const unchecked = await start(site.host, { visitor });
  expect(unchecked.status).toBe(403);
  expect(code(unchecked)).toBe("site_human_check_required");
  const created = await start(site.host, { visitor, human: true });
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  const sessionId = String(created.json.id);
  expect(created.headers.get("set-cookie")).toBeNull();

  // The session runs as the Site's service principal with a session-scoped agent.
  const [row] = await shared.admin`select created_by_kind, created_by_subject_id, metadata
    from sessions where id = ${sessionId}`;
  expect(row!.created_by_subject_id).toBe(`site:${site.id}`);
  const [ownership] = await shared.admin`select viewer_principal, version_id, turns
    from site_runtime_conversations where session_id = ${sessionId}`;
  expect(ownership).toMatchObject({
    viewer_principal: `guest:${visitor}`,
    version_id: site.versionId,
    turns: 1,
  });
  const inspected = await f.api(
    f.owner,
    "GET",
    `/v1/workspaces/${f.workspace.id}/sessions/${sessionId}`,
  );
  expect(inspected.status, JSON.stringify(inspected.json)).toBe(200);
  expect(JSON.stringify(inspected.json)).toContain('"agentAccess":"session"');
  // Capped by its own task usage limit: the free per-conversation budget.
  expect(inspected.json.usageLimit).toMatchObject({ limitMicros: 20_000 });

  // Only the viewer who started it sees it, and only on its own Site.
  const own = await f.gateway(site.host, "GET", `/sessions/${sessionId}`, { visitor });
  expect(own.status).toBe(200);
  expect((await f.gateway(site.host, "GET", "/sessions", { visitor })).json.sessions).toHaveLength(
    1,
  );
  const stranger = visitorId();
  for (const path of [
    `/sessions/${sessionId}`,
    `/sessions/${sessionId}/events`,
    `/sessions/${sessionId}/queue`,
  ]) {
    const refused = await f.gateway(site.host, "GET", path, { visitor: stranger });
    expect({ path, status: refused.status, code: code(refused) }).toEqual({
      path,
      status: 404,
      code: "site_conversation_not_found",
    });
  }
  expect(
    (await f.gateway(site.host, "GET", "/sessions", { visitor: stranger })).json.sessions,
  ).toEqual([]);
  const send = (who: { visitor?: string }, host = site.host, id = sessionId) =>
    f.gateway(host, "POST", `/sessions/${id}/events`, {
      ...who,
      body: { type: "user.message", payload: { text: "More" } },
    });
  expect((await send({ visitor: stranger })).status).toBe(404);
  expect((await f.gateway(sibling.host, "GET", `/sessions/${sessionId}`, { visitor })).status).toBe(
    404,
  );
  expect((await send({ visitor }, sibling.host)).status).toBe(404);

  // Turns per conversation.
  expect(
    (
      await f.publication(f.admin, site.id, "PUT", {
        limitProfile: {
          kind: "custom",
          overrides: { turnsPerConversation: 2, conversationsPerVisitorPerDay: 2 },
        },
      })
    ).status,
  ).toBe(200);
  const second = await send({ visitor });
  expect(second.status, JSON.stringify(second.json)).toBeLessThan(300);
  const third = await send({ visitor });
  expect(third.status).toBe(429);
  expect(third.json.error.details).toMatchObject({
    code: "site_budget_exhausted",
    budget: "turns_per_conversation",
  });

  // Conversations per visitor per day.
  expect((await start(site.host, { visitor, human: true }, "Second")).status).toBe(202);
  const tooMany = await start(site.host, { visitor, human: true }, "Third");
  expect(tooMany.status).toBe(429);
  expect(tooMany.json.error.details.budget).toBe("conversations_per_visitor_per_day");
  // Another visitor still may, until the Site's month budget is spent.
  expect((await start(site.host, { visitor: stranger, human: true })).status).toBe(202);
  await f.publication(f.admin, site.id, "PUT", {
    limitProfile: { kind: "custom", overrides: { agentMicrosPerSitePerMonth: 0 } },
  });
  const spent = await start(site.host, { visitor: visitorId(), human: true });
  expect(spent.status).toBe(429);
  expect(spent.json.error.details.budget).toBe("agent_micros_per_site_per_month");

  // Agents can be switched off per Site, and guest agents per deployment.
  await f.publication(f.owner, sibling.id, "PUT", { agent: { enabled: false } });
  const off = await start(sibling.host, { visitor, human: true });
  expect(off.status).toBe(403);
  expect(off.json.error.details).toMatchObject({
    code: "site_agents_unavailable",
    reason: "agent_disabled",
  });
  await f.publication(f.owner, sibling.id, "PUT", { agent: { enabled: true } });
  const noPublicAgents = f.appWith(sitesSettings({ sitesPublicAgentsEnabled: false }));
  // Without task usage limits a conversation cannot be capped, so Site agents are off.
  const uncapped = await f.gateway(sibling.host, "POST", "/sessions", {
    visitor,
    human: true,
    body: { initialMessage: "Hi" },
    on: f.appWith(sitesSettings({ sessionUsageLimitsEnabled: false })),
  });
  expect(uncapped.status).toBe(403);
  expect(uncapped.json.error.details.reason).toBe("usage_limits_disabled");
  const guestOff = await f.gateway(sibling.host, "POST", "/sessions", {
    visitor,
    human: true,
    body: { initialMessage: "Hi" },
    on: noPublicAgents,
  });
  expect(guestOff.status).toBe(403);
  expect(guestOff.json.error.details.reason).toBe("guest_agents_disabled");
  const config = await f.gateway(sibling.host, "GET", "/site/config", {
    visitor,
    on: noPublicAgents,
  });
  expect(config.json.agent.enabled).toBe(false);
  // Members still reach the agent of their own workspace's Site.
  const memberSession = await f.signIn(f.member, sibling.host);
  const memberStart = await f.gateway(sibling.host, "POST", "/sessions", {
    session: memberSession,
    body: { initialMessage: "Hi" },
    on: noPublicAgents,
  });
  expect(memberStart.status, JSON.stringify(memberStart.json)).toBe(202);

  const [conversations] = await shared.admin`select count(*)::int as n from usage_events
    where workspace_id = ${f.workspace.id} and event_type = 'site_runtime.conversation'`;
  expect(conversations!.n).toBe(4);
}, 90_000);

test("takedown suspends at once, syncs the edge, actions reports and is audited", async () => {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  const kv = new Map<string, string>();
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, body });
    const key = url.split("?")[0]!;
    if (url.includes("/storage/kv/")) {
      if (method === "GET")
        return kv.has(key) ? new Response(kv.get(key)) : new Response("", { status: 404 });
      kv.set(key, body ?? "");
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = await fixture({
    sitesCloudflareApiToken: "cf-token",
    sitesCloudflareAccountId: "cf-account",
    sitesCloudflareKvNamespaceId: "cf-namespace",
    sitesCloudflareZoneId: "cf-zone",
  });
  const scanned: string[] = [];
  const scanner: SiteContentScanner = {
    name: "web_risk",
    scanHtml: async (html) => {
      scanned.push(html);
      return {
        status: "flagged",
        findings: [{ url: "https://example.com/Reported", threatTypes: ["SOCIAL_ENGINEERING"] }],
      };
    },
  };
  const effects = configureSitePublishingEffects(f.settings, {
    fetch: fakeFetch,
    backoffMs: 0,
    scanner,
  });
  const site = await f.live("Reported", { access: "public" });
  await effects.flush();
  const hostRecord = () =>
    [...kv.entries()].find(
      ([key]) => key.endsWith(encodeURIComponent(`host:${site.host}`)) || key.includes(site.host),
    )?.[1];
  expect(JSON.parse(hostRecord() ?? "null")).toMatchObject({ siteId: site.id, status: "active" });
  expect(calls.every((call) => call.url.startsWith("https://api.cloudflare.com/client/v4/"))).toBe(
    true,
  );
  // The publish scan ran on the published HTML and recorded its findings.
  expect(scanned).toHaveLength(1);
  const [scan] = await shared.admin`select scan_status, scan_findings, scanned_version_id
    from site_publications where site_id = ${site.id}`;
  expect(scan).toMatchObject({ scan_status: "flagged", scanned_version_id: site.versionId });
  const [edge] = await shared.admin`select generation, edge_synced_generation from site_publications
    where site_id = ${site.id}`;
  expect(Number(edge!.edge_synced_generation)).toBe(Number(edge!.generation));

  // Anyone reaching the Site may report it, within a per-reporter limit.
  const reporter = visitorId();
  const reported = await f.gateway(site.host, "POST", "/site/reports", {
    visitor: reporter,
    body: { category: "phishing", message: "Asks for passwords", contactEmail: "a@example.com" },
  });
  expect(reported.status, JSON.stringify(reported.json)).toBe(201);
  expect(reported.json.received).toBe(true);
  for (let index = 0; index < 4; index += 1)
    await f.gateway(site.host, "POST", "/site/reports", {
      visitor: reporter,
      body: { category: "spam" },
    });
  const flood = await f.gateway(site.host, "POST", "/site/reports", {
    visitor: reporter,
    body: { category: "spam" },
  });
  expect(flood.status).toBe(429);
  const reports = await f.publication(f.owner, site.id, "GET", undefined, "/reports?status=open");
  expect(reports.status).toBe(200);
  expect(reports.json.reports).toHaveLength(5);
  expect(reports.json.reports.find((report: any) => report.category === "phishing")).toMatchObject({
    hostname: site.host,
    contactEmail: "a@example.com",
    status: "open",
  });
  expect((await f.publication(f.member, site.id, "GET", undefined, "/reports")).status).toBe(403);
  const spam = reports.json.reports.find((report: any) => report.category === "spam");
  const dismissed = await f.publication(
    f.owner,
    site.id,
    "PATCH",
    { status: "dismissed" },
    `/reports/${spam.id}`,
  );
  expect(dismissed.json.status).toBe("dismissed");

  // Only the owner or a workspace admin takes a Site down.
  const memberTakedown = await f.publication(
    f.member,
    site.id,
    "POST",
    { reason: "Looks bad" },
    "/takedown",
  );
  expect(memberTakedown.status).toBe(403);
  expect(code(memberTakedown)).toBe("site_owner_or_admin_required");
  // Taking down and restoring change what viewers see: a read-only credential
  // fails the artifacts:publish check before the owner-or-admin rule.
  const readOnly = await f.person(["workspace:read", "artifacts:read"]);
  const readOnlyTakedown = await f.publication(
    readOnly,
    site.id,
    "POST",
    { reason: "Read-only attempt" },
    "/takedown",
  );
  expect(readOnlyTakedown.status).toBe(403);
  expect(code(readOnlyTakedown)).toBeUndefined();
  expect(JSON.stringify(readOnlyTakedown.json)).toContain("artifacts:publish");
  calls.length = 0;
  const takedown = await f.publication(
    f.admin,
    site.id,
    "POST",
    { reason: "Phishing report" },
    "/takedown",
  );
  expect(takedown.status, JSON.stringify(takedown.json)).toBe(200);
  expect(takedown.json).toMatchObject({
    status: "suspended",
    moderation: { suspendedBy: "admin", suspendedReason: "Phishing report", openReports: 0 },
  });
  // Served nowhere at once, whatever the edge still holds.
  const suspended = await f.gateway(site.host, "GET", "/site/config", { visitor: reporter });
  expect(suspended.status).toBe(410);
  expect(suspended.json.error.details).toMatchObject({
    code: "site_unavailable",
    status: "suspended",
  });
  expect(
    (await f.gateway(site.host, "GET", `/versions/${site.versionId}/html`, { visitor: reporter }))
      .status,
  ).toBe(410);
  await effects.flush();
  expect(JSON.parse(hostRecord() ?? "null")).toMatchObject({ status: "suspended" });
  expect(
    calls.some((call) => call.method === "POST" && call.url.endsWith("/zones/cf-zone/purge_cache")),
  ).toBe(true);
  expect(
    (await f.publication(f.owner, site.id, "GET", undefined, "/reports?status=actioned")).json
      .reports,
  ).toHaveLength(4);
  const [audit] = await shared.admin`select subject_id, metadata from audit_events
    where workspace_id = ${f.workspace.id} and action = 'site.publication.takedown'`;
  expect(audit).toMatchObject({ subject_id: f.admin.subjectId });
  // A suspended Site cannot be republished or unpublished around the takedown.
  const republish = await f.publication(f.owner, site.id, "PUT", { status: "active" });
  expect(republish.status).toBe(409);
  expect(code(republish)).toBe("site_suspended");
  expect((await f.publication(f.owner, site.id, "DELETE")).status).toBe(409);

  const readOnlyRestore = await f.publication(readOnly, site.id, "POST", {}, "/restore");
  expect(readOnlyRestore.status).toBe(403);
  expect(code(readOnlyRestore)).toBeUndefined();
  const restored = await f.publication(f.owner, site.id, "POST", {}, "/restore");
  expect(restored.status, JSON.stringify(restored.json)).toBe(200);
  expect(restored.json).toMatchObject({ status: "active", moderation: { suspendedAt: null } });
  expect((await f.gateway(site.host, "GET", "/site/config", { visitor: reporter })).status).toBe(
    200,
  );
  await effects.flush();
  expect(JSON.parse(hostRecord() ?? "null")).toMatchObject({ status: "active" });
  const [restoreAudit] = await shared.admin`select count(*)::int as n from audit_events
    where workspace_id = ${f.workspace.id} and action = 'site.publication.restore'`;
  expect(restoreAudit!.n).toBe(1);

  // A platform takedown (operator script) holds against the owner and admins.
  const platform = await moderateSiteAsPlatform(f.deps, {
    host: site.host,
    operator: "trust-and-safety",
    action: "takedown",
    reason: "Confirmed phishing",
  });
  expect(platform).toMatchObject({ status: "suspended", suspendedBy: "platform" });
  const ownerRestore = await f.publication(f.owner, site.id, "POST", {}, "/restore");
  expect(ownerRestore.status).toBe(403);
  const adminTakedown = await f.publication(
    f.admin,
    site.id,
    "POST",
    { reason: "Again" },
    "/takedown",
  );
  expect(adminTakedown.json.moderation.suspendedBy).toBe("platform");
  expect((await f.gateway(site.host, "GET", "/site/config", { visitor: reporter })).status).toBe(
    410,
  );
  const [platformAudit] = await shared.admin`select subject_id, metadata from audit_events
    where workspace_id = ${f.workspace.id} and action = 'site.publication.takedown'
      and subject_id = 'platform:trust-and-safety'`;
  expect(platformAudit!.metadata).toMatchObject({ by: "platform", reason: "Confirmed phishing" });
  expect(JSON.parse(hostRecord() ?? "null")).toMatchObject({ status: "suspended" });
  const lifted = await moderateSiteAsPlatform(f.deps, {
    host: site.host.split(".")[0]!,
    operator: "trust-and-safety",
    action: "restore",
  });
  expect(lifted.status).toBe("active");
}, 60_000);

test("version HTML is this Site's immutable bytes, without cookies; scanning is off by default", async () => {
  const f = await fixture();
  const site = await f.live("Versions", { access: "public" });
  const other = await f.live("Other versions", { access: "public" });
  const visitor = visitorId();
  const html = await f.gateway(site.host, "GET", `/versions/${site.versionId}/html`, { visitor });
  expect(html.status).toBe(200);
  expect(String(html.json)).toContain("<h1>Versions</h1>");
  expect(html.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(html.headers.get("set-cookie")).toBeNull();
  const foreign = await f.gateway(site.host, "GET", `/versions/${other.versionId}/html`, {
    visitor,
  });
  expect(foreign.status).toBe(404);
  expect(code(foreign)).toBe("site_version_not_found");
  expect((await f.gateway(site.host, "GET", "/versions/not-a-uuid/html", { visitor })).status).toBe(
    404,
  );

  // A new version moves the host map to it and advances the generation.
  const before = (await f.gateway(site.host, "GET", `/host?host=${site.host}`)).json;
  const next = await f.api(f.owner, "POST", `${f.sites}/${site.id}/versions`, {
    html: "<!doctype html><h1>Second</h1>",
    expectedCurrentVersionId: site.versionId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(next.status, JSON.stringify(next.json)).toBe(200);
  const after = (await f.gateway(site.host, "GET", `/host?host=${site.host}`)).json;
  expect(after.versionId).not.toBe(site.versionId);
  expect(after.generation).toBeGreaterThan(before.generation);
  // Old versions of this Site stay readable by id (immutable).
  expect(
    (await f.gateway(site.host, "GET", `/versions/${site.versionId}/html`, { visitor })).status,
  ).toBe(200);

  // Without a scanner configured nothing is scanned or recorded.
  const [scan] = await shared.admin`select scan_status, scan_findings from site_publications
    where site_id = ${site.id}`;
  expect(scan).toMatchObject({ scan_status: "none", scan_findings: null });
}, 60_000);

const SITE_PUBLICATION_TOOLS = [
  "site_publication_get",
  "site_publication_update",
  "site_hostname_check",
];

test("agent tools read and change a Site's publication with the person's authority", async () => {
  const f = await fixture();
  const site = await f.publish("Agent published");
  const session = await createSession(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Publish my Site",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context
    ) VALUES (
      ${f.accountId}, ${f.workspace.id}, ${session.id}, gen_random_uuid(),
      ${`site-publication-wf-${crypto.randomUUID()}`}, 'running', 0, 'Publish my Site',
      'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${f.owner.subjectId}, '{"accepted":true}'::jsonb
    ) RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${f.accountId}, ${f.workspace.id}, ${session.id}, ${turn!.id}, 1,
        'running', 'site-publication-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker:first-party-mcp",
    permissions: ["artifacts:read", "artifacts:publish"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: SITE_PUBLICATION_TOOLS,
    },
  };
  const server = buildOpenGeniMcpServer(f.deps as unknown as ApiRouteDeps, grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "site-publication-test", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )?.text;
    let value: any = text ?? null;
    try {
      value = JSON.parse(text ?? "null");
    } catch {
      // Argument errors are plain text.
    }
    return { isError: result.isError === true, value };
  };
  try {
    expect((await mcp.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [...SITE_PUBLICATION_TOOLS].sort(),
    );
    expect((await callTool("site_publication_get", { siteId: site.id })).value).toEqual({
      published: false,
      siteId: site.id,
    });
    expect((await callTool("site_hostname_check", { label: "www" })).value).toMatchObject({
      available: false,
      problem: "reserved",
    });
    expect((await callTool("site_hostname_check", { label: "agent-site" })).value.available).toBe(
      true,
    );
    const published = await callTool("site_publication_update", {
      siteId: site.id,
      label: "agent-site",
      access: "invited",
      invitedEmails: ["Friend@Example.com"],
    });
    expect(published.isError, JSON.stringify(published.value)).toBe(false);
    expect(published.value).toMatchObject({
      hostname: `agent-site.${DOMAIN}`,
      access: "invited",
      status: "active",
      invitedEmails: ["friend@example.com"],
    });
    // Limits stay with workspace admins.
    const limits = await callTool("site_publication_update", {
      siteId: site.id,
      limitProfile: { kind: "unlimited" },
    });
    expect(limits.isError).toBe(true);
    expect(limits.value.error.details.code).toBe("site_admin_required");
    const got = await callTool("site_publication_get", { siteId: site.id });
    expect(got.value).toMatchObject({ published: true, publication: { label: "agent-site" } });
    // A workspace member's own view agrees.
    expect((await f.publication(f.owner, site.id, "GET")).json.hostname).toBe(
      `agent-site.${DOMAIN}`,
    );
  } finally {
    await mcp.close();
  }
}, 60_000);
