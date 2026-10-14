import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SITE_GATEWAY_BODY_SHA256_HEADER,
  SITE_GATEWAY_CALLBACK_PATH,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  appendSessionEvents,
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
import { sha256Hex, signSiteGatewayRequest } from "../src/site-publishing/gateway-signature";
import type { SiteContentScanner } from "../src/site-publishing/content-scanner";
import { moderateSiteAsPlatform } from "../src/site-publishing/platform";
import {
  configureSitePublishingEffects,
  scheduleSiteEdgeSync,
  SITE_EFFECT_CONCURRENCY,
  sitePublishingEffects,
} from "../src/site-publishing/service";

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
  type GatewayOptions = {
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
  };
  /** A request signed as the gateway signs it; the raw response. */
  const gatewayRaw = async (
    host: string,
    method: string,
    path: string,
    options: GatewayOptions = {},
  ): Promise<Response> => {
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
    return await (options.on ?? app).request(pathWithQuery, {
      method,
      headers: {
        ...signed,
        ...(sent ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(sent ? { body: sent } : {}),
    });
  };
  const gateway = async (
    host: string,
    method: string,
    path: string,
    options: GatewayOptions = {},
  ) => await read(await gatewayRaw(host, method, path, options));
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
    gatewayRaw,
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
  // The console learns publishing is off from its client config.
  const config = await read(await f.app.request("/v1/config/client"));
  expect(config.status).toBe(200);
  expect(config.json.sites).toBeNull();
});

test("managers publish workspace Sites under globally unique, held hostnames", async () => {
  const f = await fixture();
  const other = await fixture();
  const site = await f.publish("Team CRM");
  // The console's client config describes the deployment's publishing.
  expect((await read(await f.app.request("/v1/config/client"))).json.sites).toEqual({
    domain: DOMAIN,
    publicEnabled: true,
    publicAgentsEnabled: true,
    loginOnly: false,
    forceNoindex: false,
  });
  const loginOnly = await read(
    await f
      .appWith(sitesSettings({ sitesLoginOnly: true, sitesPublicAgentsEnabled: false }))
      .request("/v1/config/client"),
  );
  expect(loginOnly.json.sites).toMatchObject({ loginOnly: true, publicAgentsEnabled: false });

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
  // An unsigned body with a declared length is refused before it is read
  // (chunked bodies are buffered by the API-wide body limit for every route).
  const unread = await read(
    await f.app.request("/v1/site-runtime/site/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1048576" },
      // highWaterMark 0: the stream is pulled only when something reads it.
      body: new ReadableStream(
        {
          pull() {
            throw new Error("the body must not be read before the signature headers are checked");
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: "half",
    } as RequestInit),
  );
  expect(unread.status, JSON.stringify(unread.json)).toBe(401);
  expect(reason(unread)).toBe("missing_headers");

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
  // The signature is checked from the headers before the body is read: the
  // gateway signs the body hash and sends it as a header.
  const reportPath = "/v1/site-runtime/site/reports";
  const reportBody = JSON.stringify({ category: "spam" });
  const unreadable = () =>
    new ReadableStream(
      {
        pull() {
          throw new Error("the body must not be read before the signature is checked");
        },
      },
      { highWaterMark: 0 },
    );
  const signedReport = (secret: string) =>
    signSiteGatewayRequest({
      secret,
      method: "POST",
      pathWithQuery: reportPath,
      host: site.host,
      body: reportBody,
      visitor,
    });
  const sendUnread = async (headers: Record<string, string>) =>
    await read(
      await f.app.request(reportPath, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(reportBody.length),
        },
        body: unreadable(),
        duplex: "half",
      } as RequestInit),
    );
  const unreadSigned = await sendUnread(signedReport("f".repeat(40)));
  expect(unreadSigned.status, JSON.stringify(unreadSigned.json)).toBe(401);
  expect(reason(unreadSigned)).toBe("bad_signature");
  // The body hash header is required: a correctly signed request without it
  // is refused, still without reading the body.
  const withoutHash = signedReport(SECRET);
  delete withoutHash[SITE_GATEWAY_BODY_SHA256_HEADER];
  const unhashed = await sendUnread(withoutHash);
  expect(unhashed.status, JSON.stringify(unhashed.json)).toBe(401);
  expect(reason(unhashed)).toBe("missing_headers");
  for (const value of ["not-a-hash", sha256Hex(new Uint8Array()).toUpperCase(), "0".repeat(63)]) {
    const malformed = await sendUnread({
      ...signedReport(SECRET),
      [SITE_GATEWAY_BODY_SHA256_HEADER]: value,
    });
    expect(malformed.status).toBe(401);
    expect(reason(malformed)).toBe("bad_body_hash");
  }
  // A body other than the signed one fails after it is read; re-hashing the
  // swapped body does not help, because the hash is signed.
  const phishing = JSON.stringify({ category: "phishing" });
  const tampered = await f.gateway(site.host, "POST", "/site/reports", {
    body: { category: "spam" },
    sendBody: phishing,
    visitor,
  });
  expect(tampered.status).toBe(401);
  expect(reason(tampered)).toBe("body_mismatch");
  const rehashed = await f.gateway(site.host, "POST", "/site/reports", {
    body: { category: "spam" },
    sendBody: phishing,
    visitor,
    headers: { [SITE_GATEWAY_BODY_SHA256_HEADER]: sha256Hex(new TextEncoder().encode(phishing)) },
  });
  expect(rehashed.status).toBe(401);
  expect(reason(rehashed)).toBe("bad_signature");
  // GET requests carry the hash of the empty body.
  const hashed = await f.gateway(site.host, "GET", "/site/config", { visitor });
  expect(hashed.status, JSON.stringify(hashed.json)).toBe(200);
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

  // The host lookup answers only for the signed host. The gateway sends no
  // query (the signed host header names it); a query must agree with it.
  const lookup = await f.gateway(site.host, "GET", "/host");
  expect(lookup.status, JSON.stringify(lookup.json)).toBe(200);
  expect(lookup.json).toMatchObject({
    v: 1,
    hostname: site.host,
    siteId: site.id,
    status: "active",
    access: "public",
    versionId: site.versionId,
  });
  expect((await f.gateway(site.host, "GET", `/host?host=${site.host}`)).json).toEqual(lookup.json);
  expect((await f.gateway(site.host, "GET", `/host?host=other.${DOMAIN}`)).status).toBe(400);
  const unknown = await f.gateway(`no-such-site.${DOMAIN}`, "GET", "/host");
  expect(unknown.status).toBe(404);
  expect(code(unknown)).toBe("site_not_found");
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
  // Signing out of a Site that no longer exists still succeeds for the gateway.
  const gone = await f.gateway(`no-such-site.${DOMAIN}`, "POST", "/auth/logout", {
    session,
    body: {},
  });
  expect(gone.status).toBe(200);
  expect(gone.json).toEqual({ revoked: false });
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
  // Narrowing access revokes the Site's viewer sessions at once.
  const uninvited = await f.gateway(invited.host, "GET", "/site/config", { session: token });
  expect(uninvited.status).toBe(401);
  expect(code(uninvited)).toBe("site_sign_in_required");

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
  // OPE-801 provenance: the Site, its title and the served version, on the
  // session and on every turn the viewer starts.
  const siteOrigin = { siteId: site.id, title: "Helpdesk", versionId: site.versionId };
  expect(row!.metadata._opengeniSiteOrigin).toEqual(siteOrigin);
  const turns = async () =>
    await shared.admin<{ surface: string | null; metadata: Record<string, unknown> }[]>`
      select surface, metadata from session_turns where session_id = ${sessionId}
      order by created_at`;
  expect((await turns()).map((turn) => turn.surface)).toEqual(["site"]);
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
  const followUp = (await turns()).at(-1)!;
  expect(followUp.surface).toBe("site");
  expect(followUp.metadata._opengeniSiteOrigin).toEqual(siteOrigin);
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
  const site = await f.live("Reported", { access: "public", agent: { enabled: true } });
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
  // A signed-in member is talking to the Site's assistant when it is taken down.
  const memberToken = await f.signIn(f.member, site.host);
  const conversation = await f.gateway(site.host, "POST", "/sessions", {
    session: memberToken,
    body: { initialMessage: "Hello" },
  });
  expect(conversation.status, JSON.stringify(conversation.json)).toBe(202);
  const conversationId = String(conversation.json.id);
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
  // The takedown revoked every viewer session and cancelled the running conversation.
  const [revoked] = await shared.admin`select count(*)::int as n from site_viewer_sessions
    where site_id = ${site.id} and revoked_at is null`;
  expect(revoked!.n).toBe(0);
  const [cancelled] = await shared.admin`select status from sessions where id = ${conversationId}`;
  expect(cancelled!.status).toBe("cancelled");
  // A label cannot move away from a takedown.
  const relabel = await f.publication(f.owner, site.id, "PUT", {
    label: `moved-${randomBytes(4).toString("hex")}`,
  });
  expect(relabel.status).toBe(409);
  expect(code(relabel)).toBe("site_suspended");

  // Only a workspace admin restores an admin takedown.
  const ownerRestoreOfAdmin = await f.publication(f.owner, site.id, "POST", {}, "/restore");
  expect(ownerRestoreOfAdmin.status).toBe(403);
  expect(code(ownerRestoreOfAdmin)).toBe("site_forbidden");
  const restored = await f.publication(f.admin, site.id, "POST", {}, "/restore");
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
  // The owner restores their own takedown.
  const ownerTakedown = await f.publication(
    f.owner,
    site.id,
    "POST",
    { reason: "Pausing it" },
    "/takedown",
  );
  expect(ownerTakedown.json.moderation.suspendedBy).toBe("owner");
  expect((await f.publication(f.owner, site.id, "POST", {}, "/restore")).status).toBe(200);

  // A platform takedown (operator script) holds against the owner and admins.
  // It places a hostname hold, which only the schema owner (the operator's
  // migrations credential; a superuser in these tests) may write.
  await expect(
    moderateSiteAsPlatform(f.deps, {
      host: `${site.host}.`,
      operator: "trust-and-safety",
      action: "takedown",
      reason: "Confirmed phishing",
    }),
  ).rejects.toBeDefined();
  const operatorDb = createDb(shared.adminUrl);
  const operatorDeps = { ...f.deps, db: operatorDb.db };
  let platform: Awaited<ReturnType<typeof moderateSiteAsPlatform>>;
  try {
    platform = await moderateSiteAsPlatform(operatorDeps, {
      host: `${site.host}.`,
      operator: "trust-and-safety",
      action: "takedown",
      reason: "Confirmed phishing",
    });
  } finally {
    await operatorDb.close();
  }
  expect(platform).toMatchObject({ status: "suspended", suspendedBy: "platform" });
  const ownerRestore = await f.publication(f.owner, site.id, "POST", {}, "/restore");
  expect(ownerRestore.status).toBe(403);
  expect((await f.publication(f.admin, site.id, "POST", {}, "/restore")).status).toBe(403);
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
  // The operator finds a Site by id too; that lookup reads across workspaces
  // and so needs the schema owner (or a superuser), never the app role.
  await expect(
    moderateSiteAsPlatform(f.deps, {
      host: site.id,
      operator: "trust-and-safety",
      action: "restore",
    }),
  ).rejects.toBeDefined();
  const adminDb = createDb(shared.adminUrl);
  try {
    const lifted = await moderateSiteAsPlatform(
      { ...f.deps, db: adminDb.db },
      { host: site.id, operator: "trust-and-safety", action: "restore" },
    );
    expect(lifted.status).toBe("active");
  } finally {
    await adminDb.close();
  }
  expect((await f.gateway(site.host, "GET", "/site/config", { visitor: reporter })).status).toBe(
    200,
  );
}, 60_000);

test("edge writes hold no database lock and catch up with changes made meanwhile", async () => {
  const kv = new Map<string, string>();
  let gate: Promise<void> | null = null;
  let openGate = () => {};
  let writeStarted = () => {};
  const writing = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const key = url.split("?")[0]!;
    if (!url.includes("/storage/kv/")) return new Response("{}", { status: 200 });
    if (method === "GET")
      return kv.has(key) ? new Response(kv.get(key)) : new Response("", { status: 404 });
    if (gate) {
      writeStarted();
      await gate;
    }
    kv.set(key, typeof init?.body === "string" ? init.body : "");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = await fixture({
    sitesCloudflareApiToken: "cf-token",
    sitesCloudflareAccountId: "cf-account",
    sitesCloudflareKvNamespaceId: "cf-namespace",
  });
  const effects = configureSitePublishingEffects(f.settings, { fetch: fakeFetch, backoffMs: 0 });
  const site = await f.live("Edge lock", { access: "public" });
  await effects.flush();
  const generations = async () => {
    const [row] = await shared.admin`select generation, edge_synced_generation
      from site_publications where site_id = ${site.id}`;
    return { generation: Number(row!.generation), synced: Number(row!.edge_synced_generation) };
  };
  expect((await generations()).synced).toBe((await generations()).generation);

  // The next edge write hangs on Cloudflare.
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  expect((await f.publication(f.owner, site.id, "PUT", { access: "members" })).status).toBe(200);
  await writing;
  // Another change to the same hostname commits while that write is in flight.
  const changed = await Promise.race([
    f.publication(f.owner, site.id, "PUT", { access: "public" }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("publication update waited on the edge write")), 10_000),
    ),
  ]);
  expect(changed.status).toBe(200);
  gate = null;
  openGate();
  await effects.flush();
  // The edge ends on the newest generation, and the database records it.
  const latest = await generations();
  expect(latest.synced).toBe(latest.generation);
  const [record] = [...kv.values()].map((value) => JSON.parse(value));
  expect(kv.size).toBe(1);
  expect(record).toMatchObject({
    siteId: site.id,
    generation: latest.generation,
    access: "public",
  });
}, 60_000);

test("an edge sync dropped by a full queue releases its hostname", async () => {
  const kv = new Map<string, string>();
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = url.split("?")[0]!;
    if (!url.includes("/storage/kv/")) return new Response("{}", { status: 200 });
    if ((init?.method ?? "GET") === "GET")
      return kv.has(key) ? new Response(kv.get(key)) : new Response("", { status: 404 });
    kv.set(key, typeof init?.body === "string" ? init.body : "");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = await fixture({
    sitesCloudflareApiToken: "cf-token",
    sitesCloudflareAccountId: "cf-account",
    sitesCloudflareKvNamespaceId: "cf-namespace",
  });
  const effects = configureSitePublishingEffects(f.settings, {
    fetch: fakeFetch,
    backoffMs: 0,
    queueLimit: 1,
  });
  const site = await f.live("Edge queue", { access: "public" });
  await effects.flush();
  const label = String(site.publication.label);
  kv.clear();

  // Every slot runs a blocked task and the one queue place is taken.
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (let index = 0; index <= SITE_EFFECT_CONCURRENCY; index += 1)
    expect(effects.schedule("blocked", () => blocked)).toBe(true);
  expect(effects.schedule("overflow", async () => undefined)).toBe(false);
  // The edge sync is dropped, and its hostname is not left marked as syncing.
  scheduleSiteEdgeSync(f.deps, [label]);
  expect(effects.edgeLabels.has(label)).toBe(false);
  release();
  await effects.flush();
  expect(kv.size).toBe(0);
  // The next sync for that hostname runs.
  scheduleSiteEdgeSync(f.deps, [label]);
  expect(effects.edgeLabels.has(label)).toBe(true);
  await effects.flush();
  expect(effects.edgeLabels.has(label)).toBe(false);
  expect(kv.size).toBe(1);
}, 60_000);

test("Site budgets hold across rotated visitors and addresses; requests are capped", async () => {
  const f = await fixture();
  const site = await f.live("Rotated", { access: "public", agent: { enabled: true } });
  const setLimits = async (overrides: Record<string, unknown>) => {
    const changed = await f.publication(f.admin, site.id, "PUT", {
      limitProfile: { kind: "custom", overrides },
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  };
  let address = 0;
  /** A start from a fresh visitor id on a fresh client address: the rotating attacker. */
  const start = async () => {
    const who = { visitor: visitorId(), clientIp: `192.0.2.${(address += 1)}` };
    const result = await f.gateway(site.host, "POST", "/sessions", {
      ...who,
      body: { initialMessage: "Hi" },
    });
    return { ...result, ...who };
  };
  const reservation = async (sessionId: string) => {
    const [row] = await shared.admin`select limit_micros, reserved_micros
      from site_runtime_conversations where session_id = ${sessionId}`;
    return { limit: Number(row!.limit_micros), reserved: Number(row!.reserved_micros) };
  };

  // Each start reserves its whole cap against the Site's month in one
  // transaction: the third gets what is left, the fourth is refused.
  await setLimits({ agentMicrosPerSitePerMonth: 50_000 });
  const first = await start();
  expect(first.status, JSON.stringify(first.json)).toBe(202);
  expect(await reservation(first.json.id)).toEqual({ limit: 20_000, reserved: 20_000 });
  expect((await start()).status).toBe(202);
  const third = await start();
  expect(third.status).toBe(202);
  expect(await reservation(third.json.id)).toEqual({ limit: 10_000, reserved: 10_000 });
  // The session's own usage limit was set when it was created.
  const inspected = await f.api(
    f.owner,
    "GET",
    `/v1/workspaces/${f.workspace.id}/sessions/${third.json.id}`,
  );
  expect(inspected.json.usageLimit).toMatchObject({ limitMicros: 10_000 });
  const fourth = await start();
  expect(fourth.status).toBe(429);
  expect(fourth.json.error.details).toMatchObject({
    code: "site_budget_exhausted",
    budget: "agent_micros_per_site_per_month",
  });
  // Starts per Site per day hold whatever the money budget.
  await setLimits({ agentMicrosPerSitePerMonth: 10_000_000, conversationsPerSitePerDay: 3 });
  const perDay = await start();
  expect(perDay.status).toBe(429);
  expect(perDay.json.error.details.budget).toBe("conversations_per_site_per_day");
  const [counted] = await shared.admin`select count(*)::int as n from site_runtime_conversations
    where site_id = ${site.id}`;
  expect(counted!.n).toBe(3);

  // Guests see a Site-safe projection of their own conversation, and event
  // pages are monitoring reads whatever the query asks for.
  const own = { visitor: first.visitor, clientIp: first.clientIp };
  const got = await f.gateway(site.host, "GET", `/sessions/${first.json.id}`, own);
  expect(got.status, JSON.stringify(got.json)).toBe(200);
  expect(got.json.id).toBe(first.json.id);
  for (const key of [
    "accountId",
    "workspaceId",
    "instructions",
    "metadata",
    "createdBy",
    "tools",
    "sandboxId",
  ])
    expect({ key, present: key in got.json }).toEqual({ key, present: false });
  const listed = await f.gateway(site.host, "GET", "/sessions", own);
  expect(listed.json).toMatchObject({ pinned: [], nextCursor: null });
  expect(Object.keys(listed.json.sessions[0]).sort()).toEqual(Object.keys(got.json).sort());
  const events = await f.gateway(
    site.host,
    "GET",
    `/sessions/${first.json.id}/events?mode=forensic&payloadMode=full`,
    own,
  );
  expect(events.status, JSON.stringify(events.json)).toBe(200);
  expect(events.headers.get("x-opengeni-event-mode")).toBe("monitoring");
  expect(events.headers.get("x-opengeni-payload-mode")).toBe("summary");

  // Rate limits: per visitor, and per client address for guests so that
  // fresh visitor ids do not reset them (four visitors' worth per address).
  const rated = await f.live("Rated", { access: "public" });
  expect(
    (
      await f.publication(f.admin, rated.id, "PUT", {
        limitProfile: { kind: "custom", overrides: { requestsPerMinutePerVisitor: 2 } },
      })
    ).status,
  ).toBe(200);
  const view = (visitor: string, clientIp: string) =>
    f.gateway(rated.host, "GET", "/site/config", { visitor, clientIp });
  const repeat = visitorId();
  expect((await view(repeat, "203.0.113.1")).status).toBe(200);
  expect((await view(repeat, "203.0.113.2")).status).toBe(200);
  const limited = await view(repeat, "203.0.113.3");
  expect(limited.status).toBe(429);
  expect(code(limited)).toBe("site_rate_limited");
  const fromOneAddress: number[] = [];
  for (let index = 0; index < 9; index += 1)
    fromOneAddress.push((await view(visitorId(), "203.0.113.9")).status);
  expect(fromOneAddress).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429]);
  expect((await view(visitorId(), "203.0.113.10")).status).toBe(200);

  // Bodies are capped before they are read or verified.
  const huge = await f.gateway(rated.host, "POST", "/site/reports", {
    visitor: visitorId(),
    body: { category: "spam", message: "x".repeat(4 * 1024 * 1024) },
  });
  expect(huge.status).toBe(413);
  expect(code(huge)).toBe("site_request_too_large");

  // Workspace tools act with shared connections: only an admin gives them.
  const agentChange = (who: Who, agent: Record<string, unknown>) =>
    f.publication(who, site.id, "PUT", { agent });
  for (const agent of [{ tools: ["crm"] }, { guestTools: true }]) {
    const refused = await agentChange(f.owner, agent);
    expect({ agent, status: refused.status, code: code(refused) }).toEqual({
      agent,
      status: 403,
      code: "site_admin_required",
    });
  }
  for (const tool of ["bad id!", "opengeni"]) {
    const invalid = await agentChange(f.admin, { tools: [tool] });
    expect({ tool, status: invalid.status, code: code(invalid) }).toEqual({
      tool,
      status: 400,
      code: "site_tool_invalid",
    });
  }
  const given = await agentChange(f.admin, { tools: ["crm"] });
  expect(given.status, JSON.stringify(given.json)).toBe(200);
  expect(given.json.agent).toMatchObject({ tools: ["crm"], guestTools: false });
  // Tools are optional references: a connection the workspace does not have
  // (or no longer has) is skipped, never a failed conversation. Which viewers
  // get them is unit-tested with siteAgentToolRefs.
  await setLimits({ agentMicrosPerSitePerMonth: 10_000_000, conversationsPerSitePerDay: 10 });
  expect((await start()).status).toBe(202);
  const memberStart = await f.gateway(site.host, "POST", "/sessions", {
    session: await f.signIn(f.member, site.host),
    body: { initialMessage: "Hi" },
  });
  expect(memberStart.status, JSON.stringify(memberStart.json)).toBe(202);
  // The owner keeps or removes them, but cannot add more.
  expect((await agentChange(f.owner, { tools: ["crm"], instructions: "Be brief." })).status).toBe(
    200,
  );
  expect((await agentChange(f.owner, { tools: ["crm", "billing"] })).status).toBe(403);
  const removed = await agentChange(f.owner, { tools: null });
  expect(removed.status).toBe(200);
  expect(removed.json.agent.tools).toBeNull();

  // Opening a members Site whose tools an admin gave to everyone gives them
  // to people outside the workspace: only an admin may.
  const internal = await f.live("Internal tools", { access: "members", agent: { enabled: true } });
  const toEveryone = await f.publication(f.admin, internal.id, "PUT", {
    agent: { tools: ["crm"], guestTools: true },
  });
  expect(toEveryone.status, JSON.stringify(toEveryone.json)).toBe(200);
  const opened = await f.publication(f.owner, internal.id, "PUT", { access: "public" });
  expect({ status: opened.status, code: code(opened) }).toEqual({
    status: 403,
    code: "site_admin_required",
  });
  expect(opened.json.error.message).toBe(
    "Only a workspace admin can open a Site with tools to everyone",
  );
  // Without tools for everyone, the owner opens it.
  const openedWithout = await f.publication(f.owner, internal.id, "PUT", {
    access: "public",
    agent: { guestTools: false },
  });
  expect(openedWithout.status, JSON.stringify(openedWithout.json)).toBe(200);
  expect(openedWithout.json).toMatchObject({ access: "public", agent: { guestTools: false } });
  expect((await f.publication(f.owner, internal.id, "PUT", { access: "members" })).status).toBe(
    200,
  );
  expect(
    (await f.publication(f.admin, internal.id, "PUT", { agent: { guestTools: true } })).status,
  ).toBe(200);
  // An admin opens it with the tools.
  expect((await f.publication(f.admin, internal.id, "PUT", { access: "public" })).status).toBe(200);

  // Invitees get the Site's tools whenever access isn't members-only (public
  // Sites too), so while the agent has tools, giving them to more invitees
  // needs an admin. Removing invitees or narrowing does not.
  const team = await f.live("Team tools", { access: "members", agent: { enabled: true } });
  const teamChange = (who: Who, body: Record<string, unknown>) =>
    f.publication(who, team.id, "PUT", body);
  const refusedInvite = async (body: Record<string, unknown>) => {
    const refused = await teamChange(f.owner, body);
    expect({ body, status: refused.status, code: code(refused) }).toEqual({
      body,
      status: 403,
      code: "site_admin_required",
    });
    expect(refused.json.error.message).toBe(
      "Only a workspace admin can invite people while the Site's assistant has tools",
    );
  };
  expect((await teamChange(f.admin, { agent: { tools: ["crm"] } })).status).toBe(200);
  await refusedInvite({ access: "invited", invitedEmails: ["outside@example.com"] });
  // Switching to invited access with nobody new invited changes nobody's tools.
  expect((await teamChange(f.owner, { access: "invited" })).status).toBe(200);
  expect((await teamChange(f.owner, { access: "members" })).status).toBe(200);
  // Invitees listed on a members Site get nothing until it opens, to invited
  // or public access.
  const unopened = await teamChange(f.owner, { invitedEmails: ["outside@example.com"] });
  expect(unopened.status, JSON.stringify(unopened.json)).toBe(200);
  await refusedInvite({ access: "invited" });
  await refusedInvite({ access: "public" });
  const openedByAdmin = await teamChange(f.admin, { access: "public" });
  expect(openedByAdmin.status, JSON.stringify(openedByAdmin.json)).toBe(200);
  // On a public Site, adding invitees gives them the tools.
  await refusedInvite({ invitedEmails: ["outside@example.com", "ada@example.com"] });
  // Narrowing to invited access, the same people however written, or fewer
  // people: the owner may.
  expect((await teamChange(f.owner, { access: "invited" })).status).toBe(200);
  expect((await teamChange(f.owner, { invitedEmails: ["OUTSIDE@example.com"] })).status).toBe(200);
  expect((await teamChange(f.owner, { invitedEmails: [] })).status).toBe(200);
  // Once everyone on a public Site gets the tools, invitees gain nothing more.
  expect(
    (await teamChange(f.admin, { access: "public", agent: { guestTools: true } })).status,
  ).toBe(200);
  expect((await teamChange(f.owner, { invitedEmails: ["ada@example.com"] })).status).toBe(200);
  // Without tools, the owner invites people.
  expect(
    (await teamChange(f.owner, { access: "invited", agent: { tools: null, guestTools: false } }))
      .status,
  ).toBe(200);
  const withoutTools = await teamChange(f.owner, {
    invitedEmails: ["ada@example.com", "outside@example.com"],
  });
  expect(withoutTools.status, JSON.stringify(withoutTools.json)).toBe(200);
  expect(withoutTools.json.invitedEmails).toEqual(["ada@example.com", "outside@example.com"]);
}, 90_000);

test("finished conversations free the Site budget; a lowered cap lowers running conversations", async () => {
  const f = await fixture();
  const site = await f.live("Sweep", { access: "public", agent: { enabled: true } });
  const setLimits = async (overrides: Record<string, unknown>) => {
    const changed = await f.publication(f.admin, site.id, "PUT", {
      limitProfile: { kind: "custom", overrides },
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  };
  let address = 0;
  const visit = () => ({ visitor: visitorId(), clientIp: `198.51.100.${(address += 1)}` });
  const start = async (who: { visitor: string; clientIp: string }) =>
    await f.gateway(site.host, "POST", "/sessions", { ...who, body: { initialMessage: "Hi" } });
  const reserved = async (sessionId: string) => {
    const [row] = await shared.admin`select reserved_micros, limit_micros
      from site_runtime_conversations where session_id = ${sessionId}`;
    return { reserved: Number(row!.reserved_micros), limit: Number(row!.limit_micros) };
  };
  // Room for two conversations of 20_000 in the Site's month.
  await setLimits({ agentMicrosPerSitePerMonth: 40_000 });
  const [alice, bob, carol] = [visit(), visit(), visit()];
  const first = await start(alice);
  expect(first.status, JSON.stringify(first.json)).toBe(202);
  const second = await start(bob);
  expect(second.status, JSON.stringify(second.json)).toBe(202);

  // A lowered per-conversation limit lowers the session's own limit before
  // the next message runs.
  await setLimits({ agentMicrosPerSitePerMonth: 40_000, agentMicrosPerConversation: 5_000 });
  const sent = await f.gateway(site.host, "POST", `/sessions/${second.json.id}/events`, {
    ...bob,
    body: { type: "user.message", payload: { text: "More" } },
  });
  expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300);
  expect(await reserved(second.json.id)).toEqual({ reserved: 5_000, limit: 5_000 });
  const usage = await f.api(
    f.owner,
    "GET",
    `/v1/workspaces/${f.workspace.id}/sessions/${second.json.id}`,
  );
  expect(usage.json.usageLimit).toMatchObject({ limitMicros: 5_000 });
  await setLimits({ agentMicrosPerSitePerMonth: 25_000 });

  // The first conversation finished (its session went idle) without anyone
  // settling it: a refused start sweeps it and then succeeds.
  await shared.admin`update sessions set status = 'idle' where id = ${first.json.id}`;
  const third = await start(carol);
  expect(third.status, JSON.stringify(third.json)).toBe(202);
  expect((await reserved(first.json.id)).reserved).toBe(0);
  // Cancelling releases a conversation's reservation at once.
  const cancelled = await f.gateway(site.host, "POST", `/sessions/${second.json.id}/control`, {
    ...bob,
    body: { action: "cancel", clientEventId: `cancel-${randomBytes(4).toString("hex")}` },
  });
  expect(cancelled.status, JSON.stringify(cancelled.json)).toBeLessThan(300);
  expect((await reserved(second.json.id)).reserved).toBe(0);
}, 60_000);

test("narrowing a Site's tools stops the conversations that hold tools they would not get now", async () => {
  const f = await fixture();
  const effects = configureSitePublishingEffects(f.settings, {});
  const site = await f.live("Tools", { access: "public", agent: { enabled: true } });
  const change = async (agent: Record<string, unknown>) => {
    const changed = await f.publication(f.admin, site.id, "PUT", { agent });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    await effects.flush();
  };
  const conversation = async (sessionId: string) => {
    const [row] = await shared.admin`select c.viewer_kind, c.tool_ids, s.status
      from site_runtime_conversations c join sessions s on s.id = c.session_id
      where c.session_id = ${sessionId}`;
    return { kind: row!.viewer_kind, tools: row!.tool_ids, cancelled: row!.status === "cancelled" };
  };
  await change({ tools: ["crm", "billing"], guestTools: true });
  const guest = { visitor: visitorId(), clientIp: "198.51.100.40" };
  const member = { session: await f.signIn(f.member, site.host) };
  const start = async (who: Record<string, string>) => {
    const started = await f.gateway(site.host, "POST", "/sessions", {
      ...who,
      body: { initialMessage: "Hi" },
    });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    return String(started.json.id);
  };
  const send = async (who: Record<string, string>, sessionId: string) =>
    await f.gateway(site.host, "POST", `/sessions/${sessionId}/events`, {
      ...who,
      body: { type: "user.message", payload: { text: "More" } },
    });
  const guestChat = await start(guest);
  const memberChat = await start(member);
  expect(await conversation(guestChat)).toEqual({
    kind: "guest",
    tools: ["crm", "billing"],
    cancelled: false,
  });
  expect(await conversation(memberChat)).toMatchObject({ kind: "member", cancelled: false });

  // Tools no longer for everyone: the guest's conversation stops and takes no
  // more messages; the member's goes on. Nobody is signed out.
  await change({ guestTools: false });
  expect((await conversation(guestChat)).cancelled).toBe(true);
  expect((await conversation(memberChat)).cancelled).toBe(false);
  const outdated = await send(guest, guestChat);
  expect(outdated.status, JSON.stringify(outdated.json)).toBe(409);
  expect(code(outdated)).toBe("site_conversation_outdated");
  expect((await send(member, memberChat)).status).toBeLessThan(300);
  // A new guest conversation starts without tools.
  expect((await conversation(await start(guest))).tools).toEqual([]);

  // A removed tool stops the member's conversation too; a new one gets what is left.
  await change({ tools: ["crm"] });
  expect((await conversation(memberChat)).cancelled).toBe(true);
  expect(code(await send(member, memberChat))).toBe("site_conversation_outdated");
  expect((await conversation(await start(member))).tools).toEqual(["crm"]);
  const [signedIn] = await shared.admin`select count(*)::int as n from site_viewer_sessions
    where site_id = ${site.id} and revoked_at is null`;
  expect(signedIn!.n).toBe(1);
}, 60_000);

test("abuse reports and flagged scans reach the platform, at most once an hour per Site", async () => {
  const sent: Array<{ kind: string; to: string; subject: string }> = [];
  const transport = {
    sender: "sites@example.test",
    idempotency: { scope: "test", retentionSeconds: 86_400 },
    send: async (message: { kind: string; to: string; subject: string }) => {
      sent.push({ kind: message.kind, to: message.to, subject: message.subject });
      return { status: "sent" as const, providerMessageId: null };
    },
  };
  const f = await fixture({ sitesAbuseEmail: "abuse@example.test" });
  const on = createApp({ ...f.deps, managedEmailTransport: transport } as AppDependencies);
  const site = await f.live("Abused", { access: "public" });
  for (let index = 0; index < 5; index += 1) {
    const reported = await f.gateway(site.host, "POST", "/site/reports", {
      visitor: visitorId(),
      body: { category: "spam" },
      on,
    });
    expect(reported.status).toBe(201);
  }
  await sitePublishingEffects(f.settings).flush();
  expect(sent).toEqual([
    {
      kind: "site_abuse_notice",
      to: "abuse@example.test",
      subject: `[Opengeni Sites] An abuse report: ${site.host}`,
    },
  ]);
}, 60_000);

test("a viewer's own conversation serves the composer draft, queue and human-input operations", async () => {
  const f = await fixture();
  const site = await f.live("Drafts", {
    access: "public",
    agent: { enabled: true, instructions: "Help with drafts." },
  });
  const visitor = visitorId();
  const stranger = visitorId();
  const created = await f.gateway(site.host, "POST", "/sessions", {
    visitor,
    body: { initialMessage: "Hello" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  const sessionId = String(created.json.id);
  const conversation = `/sessions/${sessionId}`;

  // The draft starts empty, on the conversation's own model.
  const draft = await f.gateway(site.host, "GET", `${conversation}/composer-draft`, { visitor });
  expect(draft.status, JSON.stringify(draft.json)).toBe(200);
  const { model, reasoningEffort, latencyMode, revision } = draft.json;
  expect(typeof model).toBe("string");
  const save = (body: Record<string, unknown>, who = visitor) =>
    f.gateway(site.host, "PUT", `${conversation}/composer-draft`, {
      visitor: who,
      body: {
        text: "A draft",
        annotations: [],
        resources: [],
        model,
        reasoningEffort,
        latencyMode,
        expectedRevision: revision,
        ...body,
      },
    });
  // Text only, on an allowed model, and only the viewer's own conversation.
  const withResource = await save({
    resources: [{ kind: "artifact", id: crypto.randomUUID() }],
  });
  expect(withResource.status).toBe(400);
  const otherModel = await save({ model: "not-a-site-model" });
  expect(otherModel.status).toBe(400);
  expect(code(otherModel)).toBe("site_model_not_allowed");
  const foreign = await save({}, stranger);
  expect(foreign.status).toBe(404);
  expect(code(foreign)).toBe("site_conversation_not_found");
  const saved = await save({});
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect(saved.json).toMatchObject({ text: "A draft", resources: [] });

  // Submitting the draft is a message: it counts as a turn and records the Site.
  const submitted = await f.gateway(site.host, "POST", `${conversation}/composer-draft/submit`, {
    visitor,
    body: {
      text: "A draft",
      annotations: [],
      resources: [],
      model,
      reasoningEffort,
      latencyMode,
      expectedDraftRevision: saved.json.revision,
      clientEventId: crypto.randomUUID(),
      delivery: "send",
    },
  });
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(202);
  // Every answer is a Site-safe view: nothing names the workspace behind it.
  const [turnRow] = await shared.admin`select temporal_workflow_id from session_turns
    where session_id = ${sessionId} limit 1`;
  const internal = [f.workspace.id, String(turnRow!.temporal_workflow_id)];
  const siteSafe = (result: Result) => {
    const text = JSON.stringify(result.json);
    for (const value of internal) expect(text).not.toContain(value);
    expect(text).not.toContain('"metadata":{"');
  };
  for (const result of [draft, saved, submitted]) siteSafe(result);
  expect(submitted.json.turn).toMatchObject({ prompt: "A draft", tools: [], metadata: {} });
  const [ownership] = await shared.admin`select turns from site_runtime_conversations
    where session_id = ${sessionId}`;
  expect(ownership).toMatchObject({ turns: 2 });
  const [turn] = await shared.admin<
    { surface: string | null; metadata: Record<string, unknown> }[]
  >`
    select surface, metadata from session_turns where session_id = ${sessionId}
    order by created_at desc limit 1`;
  expect(turn!.surface).toBe("site");
  expect(turn!.metadata._opengeniSiteOrigin).toEqual({
    siteId: site.id,
    title: "Drafts",
    versionId: site.versionId,
  });

  // Queue item and human-input reads reach the API for the owner only.
  const queued = await f.gateway(site.host, "GET", `${conversation}/queue`, { visitor });
  expect(queued.status, JSON.stringify(queued.json)).toBe(200);
  siteSafe(queued);
  expect(queued.json.pendingInputs).toEqual([]);
  // The submitted message waits behind the first turn (no worker runs here).
  const item = (queued.json.items as Array<{ id: string; version: number }>).at(-1);
  expect(item, JSON.stringify(queued.json.items)).toBeDefined();
  {
    const strangerDelete = await f.gateway(
      site.host,
      "POST",
      `${conversation}/queue/${item!.id}/delete`,
      { visitor: stranger, body: { clientEventId: crypto.randomUUID(), expectedTurnVersion: 1 } },
    );
    expect(code(strangerDelete)).toBe("site_conversation_not_found");
    const deleted = await f.gateway(site.host, "POST", `${conversation}/queue/${item!.id}/delete`, {
      visitor,
      body: { clientEventId: crypto.randomUUID(), expectedTurnVersion: item!.version },
    });
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    siteSafe(deleted);
    expect(deleted.json.snapshot.version).toBeGreaterThan(queued.json.version);
  }
  const missingRequest = await f.gateway(
    site.host,
    "GET",
    `${conversation}/human-input-requests/${crypto.randomUUID()}`,
    { visitor },
  );
  expect(missingRequest.status).toBe(404);
  expect(code(missingRequest)).not.toBe("site_operation_unsupported");

  // A reconnecting stream resumes after the gateway-forwarded Last-Event-ID.
  const firstEventId = async (headers: Record<string, string> = {}) => {
    const response = await f.gatewayRaw(site.host, "GET", `${conversation}/events/stream`, {
      visitor,
      headers,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const id = /^id: ?(\d+)$/mu.exec(text)?.[1];
        if (id) return Number(id);
      }
      return null;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
  const fromStart = await firstEventId();
  expect(fromStart).not.toBeNull();
  expect(await firstEventId({ "last-event-id": String(fromStart) })).toBeGreaterThan(fromStart!);
}, 60_000);

test("a viewer's event stream and pages carry only the Site-safe projection", async () => {
  const f = await fixture();
  const site = await f.live("Projected", { access: "public", agent: { enabled: true } });
  const visitor = visitorId();
  const created = await f.gateway(site.host, "POST", "/sessions", {
    visitor,
    body: { initialMessage: "Hello" },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  const sessionId = String(created.json.id);
  const conversation = `/sessions/${sessionId}`;
  // What a running agent writes: tool calls with arguments and output,
  // reasoning, sandbox and model telemetry, and a long answer.
  const HIDDEN = `site-secret-${randomBytes(6).toString("hex")}`;
  const answer = `${"A long answer. ".repeat(600)}The end.`;
  await appendSessionEvents(db.db, f.workspace.id, sessionId, [
    { type: "agent.reasoning.delta", payload: { text: `thinking about ${HIDDEN}` } },
    {
      type: "agent.toolCall.created",
      payload: { id: "call_1", name: "crm_lookup", arguments: { apiKey: HIDDEN } },
    },
    {
      type: "agent.toolCall.output",
      payload: { id: "call_1", output: { isError: true, content: [{ text: HIDDEN }] } },
    },
    { type: "sandbox.box.created", payload: { sandboxId: HIDDEN, hydrated: "none" } },
    { type: "agent.model.usage", payload: { provider: HIDDEN, inputTokens: 12 } },
    { type: "agent.message.delta", payload: { text: "A long", messageId: "msg_1" } },
    { type: "agent.message.completed", payload: { text: answer, messageId: "msg_1" } },
    { type: "turn.failed", payload: { code: "provider_error", error: `${HIDDEN} trace` } },
  ]);
  const [{ count }] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_events where session_id = ${sessionId}`;
  const internal = [HIDDEN, f.workspace.id, f.accountId, '"workspaceId"', '"turnAttemptId"'];
  /** Every sequence from 1 up, in order, each delivered event Site-safe. */
  const expectSiteSafe = (events: Array<Record<string, any>>, covered: number[]) => {
    const text = JSON.stringify(events);
    for (const value of internal)
      expect({ value, leaked: text.includes(value) }).toEqual({
        value,
        leaked: false,
      });
    let next = 1;
    events.forEach((event, index) => {
      expect(event.sequence).toBe(next);
      next = covered[index]! + 1;
    });
    expect(next - 1).toBe(count);
    const byType = (type: string) => events.filter((event) => event.type === type);
    expect(byType("agent.toolCall.created").map((event) => event.payload)).toEqual([
      { id: "call_1", name: "crm_lookup" },
    ]);
    expect(byType("agent.toolCall.output").map((event) => event.payload)).toEqual([
      { id: "call_1", error: true },
    ]);
    expect(byType("agent.message.completed").map((event) => event.payload)).toEqual([
      { text: answer, messageId: "msg_1" },
    ]);
    expect(byType("turn.failed").map((event) => event.payload)).toEqual([
      { code: "provider_error" },
    ]);
    // Reasoning, sandbox and model telemetry are placeholders.
    expect(byType("session.event.envelope_omitted").length).toBeGreaterThanOrEqual(3);
    for (const type of ["agent.reasoning.delta", "sandbox.box.created", "agent.model.usage"])
      expect(byType(type)).toEqual([]);
  };
  const sseFrames = (text: string) =>
    [...text.matchAll(/^id: (\d+)\nevent: (\S+)\ndata: (.+)$/gmu)].map(([, id, type, data]) => {
      const event = JSON.parse(data!);
      expect(event.type).toBe(type);
      return { covered: Number(id), event };
    });

  // The finite browser batch.
  const batch = await f.gatewayRaw(
    site.host,
    "GET",
    `${conversation}/events/stream?transport=http1-bounded`,
    { visitor },
  );
  expect(batch.status).toBe(200);
  expect(batch.headers.get("content-length")).toBeNull();
  const batched = sseFrames(await batch.text());
  expectSiteSafe(
    batched.map((frame) => frame.event),
    batched.map((frame) => frame.covered),
  );

  // The live stream replays the same projection before it reports connected.
  const live = await f.gatewayRaw(site.host, "GET", `${conversation}/events/stream`, { visitor });
  expect(live.status).toBe(200);
  const reader = live.body!.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline && !streamed.includes(": connected\n\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      streamed += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  expect(streamed).toContain(": connected\n\n");
  const replayed = sseFrames(streamed);
  expect(replayed).toEqual(batched);

  // Event pages: the same projection, whatever read mode the viewer asks for.
  const page = await f.gateway(
    site.host,
    "GET",
    `${conversation}/events?after=0&limit=500&mode=forensic&payloadMode=full`,
    { visitor },
  );
  expect(page.status, JSON.stringify(page.json)).toBe(200);
  expect(page.headers.get("x-opengeni-payload-mode")).toBe("summary");
  expect(page.headers.get("x-opengeni-forensic-exact")).toBe("false");
  const events = page.json as Array<Record<string, any>>;
  expectSiteSafe(
    events,
    events.map((event) => event.sequence),
  );
  const compact = await f.gateway(site.host, "GET", `${conversation}/events?after=0&compact=1`, {
    visitor,
  });
  expect(compact.json).toEqual(batched.map((frame) => frame.event));
  const newest = await f.gateway(site.host, "GET", `${conversation}/events?limit=2`, { visitor });
  expect((newest.json as Array<{ sequence: number }>).map((event) => event.sequence)).toEqual([
    count - 1,
    count,
  ]);
  const hiddenOnly = await f.gateway(
    site.host,
    "GET",
    `${conversation}/events?includeTypes=sandbox.box.created`,
    { visitor },
  );
  expect(hiddenOnly.json).toEqual([]);
  const toolsOnly = await f.gateway(
    site.host,
    "GET",
    `${conversation}/events?after=0&includeTypes=agent.toolCall.created,sandbox.box.created`,
    { visitor },
  );
  expect((toolsOnly.json as Array<{ type: string }>).map((event) => event.type)).toEqual([
    "agent.toolCall.created",
  ]);
  const bare = await f.gateway(
    site.host,
    "GET",
    `${conversation}/events?after=0&payloadMode=none`,
    {
      visitor,
    },
  );
  expect(bare.headers.get("x-opengeni-payload-mode")).toBe("none");
  for (const event of bare.json as Array<{ payload: unknown }>) expect(event.payload).toEqual({});
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
  // The replaced version stays readable for pages already open, for ten minutes.
  const oldVersion = () =>
    f.gateway(site.host, "GET", `/versions/${site.versionId}/html`, { visitor });
  expect((await oldVersion()).status).toBe(200);
  // Age the publish event (artifact events are immutable, so past their trigger).
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update workspace_artifact_events
      set created_at = created_at - interval '11 minutes'
      where artifact_id = ${site.id} and from_version_id = ${site.versionId}`;
  });
  const expired = await oldVersion();
  expect(expired.status).toBe(404);
  expect(code(expired)).toBe("site_version_not_found");
  expect(
    (await f.gateway(site.host, "GET", `/versions/${after.versionId}/html`, { visitor })).status,
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

const SITE_ARTIFACT_TOOLS = [
  "artifacts_publish",
  "artifacts_rollback",
  "artifacts_archive",
  "artifacts_restore",
];

test("agent tools read and change a Site's publication with the person's authority", async () => {
  const f = await fixture();
  const scanned: string[] = [];
  const effects = configureSitePublishingEffects(f.settings, {
    scanner: {
      name: "web_risk",
      scanHtml: async (html) => {
        scanned.push(html);
        return { status: "clean", findings: [] };
      },
    },
  });
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
      firstPartyMcpTools: [...SITE_PUBLICATION_TOOLS, ...SITE_ARTIFACT_TOOLS],
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
      [...SITE_PUBLICATION_TOOLS, ...SITE_ARTIFACT_TOOLS].sort(),
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

    // The artifact tools keep a published Site in step exactly as the API
    // routes do: each change advances the generation (and resyncs the edge),
    // and a version that becomes current is scanned.
    await effects.flush();
    expect(scanned).toHaveLength(1);
    const generation = async () =>
      Number(
        (
          await shared.admin`select generation from site_publications where site_id = ${site.id}`
        )[0]!.generation,
      );
    let seen = await generation();
    const advanced = async () => {
      const now = await generation();
      const moved = now > seen;
      seen = now;
      return moved;
    };
    const newVersion = await callTool("artifacts_publish", {
      artifactId: site.id,
      expectedCurrentVersionId: site.versionId,
      html: "<!doctype html><h1>By the agent</h1>",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(newVersion.isError, JSON.stringify(newVersion.value)).toBe(false);
    const secondVersion = String(newVersion.value.version.id);
    expect(await advanced()).toBe(true);
    await effects.flush();
    expect(scanned.at(-1)).toContain("By the agent");
    const rolledBack = await callTool("artifacts_rollback", {
      artifactId: site.id,
      versionId: site.versionId,
      expectedCurrentVersionId: secondVersion,
      reason: "Back to the first version",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(rolledBack.isError, JSON.stringify(rolledBack.value)).toBe(false);
    expect(await advanced()).toBe(true);
    await effects.flush();
    expect(scanned).toHaveLength(3);
    expect(scanned.at(-1)).toContain("<h1>Agent published</h1>");
    for (const tool of ["artifacts_archive", "artifacts_restore"]) {
      const changed = await callTool(tool, {
        artifactId: site.id,
        expectedCurrentVersionId: site.versionId,
        reason: "Status change by the agent",
        idempotencyKey: crypto.randomUUID(),
      });
      expect(changed.isError, JSON.stringify(changed.value)).toBe(false);
      expect({ tool, advanced: await advanced() }).toEqual({ tool, advanced: true });
    }
    await effects.flush();
    expect(scanned).toHaveLength(3);
  } finally {
    await mcp.close();
  }
}, 60_000);
