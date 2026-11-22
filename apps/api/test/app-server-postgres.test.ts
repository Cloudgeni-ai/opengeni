import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  APP_SERVER_RUN_TOKEN_HEADER,
  appServerHostSuffix,
  type AppServerGatewayRunRequest,
  type AppServerGatewayRunResult,
} from "@opengeni/contracts";
import type { ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import type { AppServerDeps } from "../src/app-server/service";
import { signSiteGatewayRequest } from "../src/site-publishing/gateway-signature";
import type { SiteToolAccountInventory } from "../src/site-tool-routing";

// App server code against PostgreSQL as the restricted application role:
// publish with a server upload, run from a member's page through a fake
// gateway that calls back over the signed host route, tool calls routed to
// the workspace's shared account only, runs and status for managers.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("app-server");
  if (!acquired) throw new Error("App server code tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const SECRET = "app-server-gateway-secret-0123456789abcdef";
const ORIGIN = "https://internal.sites.test";
const DOMAIN = "sites.example.test";
const VAULT_REFERENCE = ["{", "{", "secret", ":Shared/Linear/token}}"].join("");
const noop = async () => undefined;
const managerPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "artifacts:read",
  "artifacts:publish",
] as const;
const viewerPermissions = ["workspace:read", "sessions:read", "artifacts:read"] as const;

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
      return bytes ? { bytes, contentType: "application/octet-stream" } : null;
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
  return {
    storage: storage as unknown as ObjectStorageDependency,
    put: (url: string, body: string) =>
      objects.set(new URL(url).pathname.slice(1), new TextEncoder().encode(body)),
  };
}

type Who = { subjectId: string; headers: Record<string, string> };
type ToolCall = { serverId: string; toolName: string; subjectId: string; args: unknown };
type HostReply = { status: number; json: any };

/** What the fake gateway's isolate does with a request: calls back through HOST. */
type Isolate = (
  request: AppServerGatewayRunRequest,
  host: (op: string, input: Record<string, unknown>) => Promise<HostReply>,
) => Promise<Partial<AppServerGatewayRunResult>>;

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('App server fixture') returning id`;
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
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    sitesServerCodeEnabled: true,
    sitesGatewayInternalOrigin: ORIGIN,
    sitesGatewaySecret: SECRET,
    sitesDomain: DOMAIN,
  });
  const memory = memoryObjectStorage();
  const toolCalls: ToolCall[] = [];
  let isolate: Isolate = async () => ({ status: 200 });
  let inventory: SiteToolAccountInventory = {
    canonical: new Map([["linear", { name: "Linear" } as never]]),
    plain: new Set(),
    accounts: [
      { serverId: "linear__owner", canonicalServerId: "linear", shared: false } as never,
      { serverId: "linear__team", canonicalServerId: "linear", shared: true } as never,
    ],
    capabilityServers: new Set(),
  };
  const holder: { app?: ReturnType<typeof createApp> } = {};
  const host = async (
    run: AppServerGatewayRunRequest,
    op: string,
    input: Record<string, unknown>,
    override: { siteId?: string; versionId?: string; token?: string } = {},
  ): Promise<HostReply> => {
    const path = `/v1/site-runtime${appServerHostSuffix(
      override.siteId ?? run.context.appId,
      override.versionId ?? run.context.versionId,
    )}`;
    const body = JSON.stringify({ op, input });
    const signed = signSiteGatewayRequest({
      secret: SECRET,
      method: "POST",
      pathWithQuery: path,
      host: DOMAIN,
      body,
    });
    const response = await holder.app!.request(path, {
      method: "POST",
      headers: {
        ...signed,
        "content-type": "application/json",
        [APP_SERVER_RUN_TOKEN_HEADER]: override.token ?? run.context.token,
      },
      body,
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as any };
  };
  const runs: AppServerGatewayRunRequest[] = [];
  const seams: Partial<AppServerDeps> = {
    appServerGatewayFetch: async (url, init) => {
      expect(url).toStartWith(`${ORIGIN}/_og/internal/app-server/`);
      const run = JSON.parse(String(init.body)) as AppServerGatewayRunRequest;
      runs.push(run);
      const result = await isolate(run, (op, input) => host(run, op, input));
      return Response.json({
        status: 200,
        headers: [["content-type", "application/json"]],
        bodyBase64: "",
        logs: "",
        error: null,
        ...result,
      } satisfies AppServerGatewayRunResult);
    },
    appServerToolInventory: async () => inventory,
    appServerToolCaller: async (input) => {
      toolCalls.push({
        serverId: input.identity.serverId,
        toolName: input.identity.toolName,
        subjectId: input.grant.subjectId,
        args: input.arguments,
      });
      return { issues: [{ identifier: "ENG-1", title: "Shared issue" }] };
    },
  };
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: memory.storage,
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
    ...seams,
  } as unknown as AppDependencies;
  const app = createApp(deps);
  holder.app = app;
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
    expect(added.status, await added.clone().text()).toBe(200);
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
  const owner = await person(managerPermissions);
  const member = await person(viewerPermissions);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'app-server-test')`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const request = async (who: Who, method: string, path: string, body?: unknown) => {
    const response = await app.request(`${base}${path}`, {
      method,
      headers: who.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: keep the text.
    }
    return { status: response.status, json };
  };
  const created = await request(owner, "POST", "", {
    title: "Issues",
    html: "<!doctype html><h1>Issues</h1>",
    idempotencyKey: crypto.randomUUID(),
    visibility: "workspace",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const siteId = String(created.json.artifact.id);
  let currentVersionId = String(created.json.version.id);
  /** Publish a new version through an upload, optionally with server code. */
  const publish = async (server?: unknown, who: Who = owner) => {
    const upload = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: who.headers,
    });
    const uploadJson = (await upload.json().catch(() => null)) as any;
    expect(upload.status, JSON.stringify(uploadJson)).toBe(200);
    memory.put(uploadJson.html.putUrl, `<!doctype html><h1>Issues ${crypto.randomUUID()}</h1>`);
    if (server !== undefined) memory.put(uploadJson.server.putUrl, JSON.stringify(server));
    const published = await request(who, "POST", `/${siteId}/versions`, {
      uploadId: uploadJson.uploadId,
      expectedCurrentVersionId: currentVersionId,
      idempotencyKey: crypto.randomUUID(),
      requestedTools: [{ serverId: "linear", toolName: "list_issues" }],
    });
    if (published.status < 300) currentVersionId = String(published.json.version.id);
    return published;
  };
  /** A request to the published app's host, signed as the gateway signs it. */
  const runtime = async (hostname: string, path: string, body: unknown, visitor: string) => {
    const pathWithQuery = `/v1/site-runtime${path}`;
    const text = JSON.stringify(body);
    const signed = signSiteGatewayRequest({
      secret: SECRET,
      method: "POST",
      pathWithQuery,
      host: hostname,
      body: text,
      visitor,
      clientIp: "198.51.100.7",
    });
    const response = await app.request(pathWithQuery, {
      method: "POST",
      headers: { ...signed, "content-type": "application/json" },
      body: text,
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as any };
  };
  return {
    app,
    base,
    runtime,
    owner,
    member,
    siteId,
    request,
    publish,
    runs,
    toolCalls,
    host,
    versionId: () => currentVersionId,
    setIsolate: (next: Isolate) => {
      isolate = next;
    },
    setInventory: (next: SiteToolAccountInventory) => {
      inventory = next;
    },
    removeMember: async (who: Who) => {
      const removed = await app.request(
        `/v1/workspaces/${workspace.id}/members/${encodeURIComponent(who.subjectId)}`,
        { method: "DELETE", headers: service },
      );
      expect(removed.status, await removed.clone().text()).toBeLessThan(300);
    },
  };
}

const SERVER_CODE = {
  main: "index.js",
  tools: ["linear/list_issues"],
  files: [
    {
      path: "index.js",
      content:
        'export default { async fetch(request, env) { return Response.json(await env.tools.call("linear/list_issues", {})); } };',
    },
  ],
};

test("a member without their own connection gets shared-account data from the app's server code", async () => {
  const f = await fixture();
  // Without code there is nothing to run.
  const none = await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/issues" });
  expect(none.status).toBe(404);

  const published = await f.publish(SERVER_CODE);
  expect(published.status, JSON.stringify(published.json)).toBe(200);

  f.setIsolate(async (run, host) => {
    const called = await host("tools.call", { tool: "linear/list_issues", arguments: {} });
    expect(called.status, JSON.stringify(called.json)).toBe(200);
    expect(Buffer.from(run.modules["index.js"]!, "base64").toString("utf8")).toBe(
      SERVER_CODE.files[0]!.content,
    );
    return {
      bodyBase64: Buffer.from(JSON.stringify(called.json.result)).toString("base64"),
      logs: "listed\n",
    };
  });
  const ran = await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/issues" });
  expect(ran.status, JSON.stringify(ran.json)).toBe(200);
  expect(JSON.parse(ran.json.body)).toEqual({
    issues: [{ identifier: "ENG-1", title: "Shared issue" }],
  });
  // The member's identity reaches the code; the call ran on the shared account
  // with the publisher's authority, never the member's or a personal account.
  const run = f.runs.at(-1)!;
  expect(run.context.viewer).toMatchObject({ id: `user:${f.member.subjectId}`, kind: "member" });
  expect(f.toolCalls).toEqual([
    { serverId: "linear__team", toolName: "list_issues", subjectId: f.owner.subjectId, args: {} },
  ]);

  // Managers see the run; the member can't.
  const runs = await f.request(f.owner, "GET", `/${f.siteId}/server/runs`);
  expect(runs.status, JSON.stringify(runs.json)).toBe(200);
  expect(runs.json.runs[0]).toMatchObject({
    status: "ok",
    target: "GET /issues",
    logs: "listed\n",
    viewerSubjectId: `user:${f.member.subjectId}`,
  });
  expect((await f.request(f.member, "GET", `/${f.siteId}/server/runs`)).status).toBe(403);

  // A publish without a server upload keeps the code.
  expect((await f.publish()).status).toBe(200);
  const status = await f.request(f.owner, "GET", `/${f.siteId}/server/status`);
  expect(status.json).toMatchObject({
    hasCode: true,
    available: true,
    runsToday: 1,
    lastRunFailed: false,
    paused: null,
    tools: ["linear/list_issues"],
  });
});

test("without a shared account the tool call fails instead of using anyone's own connection", async () => {
  const f = await fixture();
  expect((await f.publish(SERVER_CODE)).status).toBe(200);
  f.setInventory({
    canonical: new Map([["linear", { name: "Linear" } as never]]),
    plain: new Set(),
    accounts: [{ serverId: "linear__owner", canonicalServerId: "linear", shared: false } as never],
    capabilityServers: new Set(),
  });
  let refused: HostReply | undefined;
  f.setIsolate(async (_run, host) => {
    refused = await host("tools.call", { tool: "linear/list_issues", arguments: {} });
    return { status: 500, error: "no data" };
  });
  const ran = await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/issues" });
  expect(ran.status).toBe(200);
  expect(ran.json.status).toBe(500);
  expect(refused?.status).toBe(403);
  expect(refused?.json.error.details.reason).toBe("shared_account_required");
  expect(f.toolCalls).toEqual([]);
  const status = await f.request(f.owner, "GET", `/${f.siteId}/server/status`);
  expect(status.json).toMatchObject({
    errorsToday: 1,
    lastRunFailed: true,
    lastError: { message: "no data" },
  });
});

test("a run's token works only for its own app, its current version and while it runs", async () => {
  const f = await fixture();
  expect((await f.publish(SERVER_CODE)).status).toBe(200);
  const other = await fixture();
  expect((await other.publish(SERVER_CODE)).status).toBe(200);
  const defined = await f.request(f.owner, "PUT", `/${f.siteId}/data/collections/mine`, {
    accessMode: "per_viewer",
  });
  expect(defined.status, JSON.stringify(defined.json)).toBe(201);
  const call = { tool: "linear/list_issues", arguments: {} };
  const seen: Record<string, HostReply> = {};
  let captured: AppServerGatewayRunRequest | undefined;
  f.setIsolate(async (run) => {
    captured = run;
    // Another app's path with this run's token.
    seen.crossApp = await f.host(run, "tools.call", call, {
      siteId: other.siteId,
      versionId: other.versionId(),
    });
    // A forged token.
    seen.forged = await f.host(run, "tools.call", call, { token: "x.y" });
    // Vault references never ride in tool arguments.
    seen.secretArgs = await f.host(run, "tools.call", {
      tool: "linear/list_issues",
      arguments: { q: VAULT_REFERENCE },
    });
    // Per-viewer data isn't the app's.
    seen.perViewer = await f.host(run, "data.query", { collection: "mine" });
    return {};
  });
  expect((await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/" })).status).toBe(
    200,
  );
  expect(seen.crossApp!.status).toBe(403);
  expect(seen.forged!.status).toBe(403);
  expect(seen.secretArgs!.json.error.details?.reason).toBe("secret_in_arguments");
  expect(seen.perViewer!.json.error.details?.reason).toBe("collection_per_viewer");
  // Once the run has ended, its token is spent.
  const ended = await f.host(captured!, "tools.call", call);
  expect(ended.status).toBe(403);
  expect(ended.json.error.details?.reason).toBe("run_ended");
  expect(f.toolCalls).toEqual([]);
});

test("the API counts a run's calls back and stops them at the limit or a new version", async () => {
  const f = await fixture();
  expect((await f.publish(SERVER_CODE)).status).toBe(200);
  const statuses: number[] = [];
  let reason: unknown;
  f.setIsolate(async (_run, host) => {
    // Whatever the code does in its isolate, the API counts each call.
    for (let index = 0; index < 52; index += 1) {
      const reply = await host("data.query", { collection: "none" });
      statuses.push(reply.status);
      if (reply.status === 429) {
        reason = reply.json.error.details?.reason;
        break;
      }
    }
    return {};
  });
  expect((await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/" })).status).toBe(
    200,
  );
  expect(statuses.length).toBe(51);
  expect(reason).toBe("host_call_limit");

  let stale: HostReply | undefined;
  f.setIsolate(async (_run, host) => {
    // A new version is published while this run is live: its calls stop.
    expect((await f.publish()).status).toBe(200);
    stale = await host("tools.call", { tool: "linear/list_issues", arguments: {} });
    return {};
  });
  await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/" });
  expect(stale?.status).toBe(409);
  expect(f.toolCalls).toEqual([]);
});

test("the code pauses once the publisher can no longer manage the app", async () => {
  const f = await fixture();
  expect((await f.publish(SERVER_CODE)).status).toBe(200);
  await f.removeMember(f.owner);
  const before = f.runs.length;
  // The run stops before the code starts, and the failure is recorded.
  const refused = await f.request(f.member, "POST", `/${f.siteId}/server`, { path: "/" });
  expect(refused.status).toBe(403);
  expect(refused.json.error.details?.reason).toBe("deployer_cannot_manage");
  expect(f.runs.length).toBe(before);
  expect(f.toolCalls).toEqual([]);
});

test("an upload of no files removes the code", async () => {
  const f = await fixture();
  expect((await f.publish(SERVER_CODE)).status).toBe(200);
  expect((await f.publish({ files: [] })).status).toBe(200);
  const status = await f.request(f.owner, "GET", `/${f.siteId}/server/status`);
  expect(status.json.hasCode).toBe(false);
});

test("a public visitor reaches the code as a guest through the published app", async () => {
  const f = await fixture();
  expect((await f.publish(SERVER_CODE)).status).toBe(200);
  const published = await f.app.request(`${f.base}/${f.siteId}/publication`, {
    method: "PUT",
    headers: f.owner.headers,
    body: JSON.stringify({ access: "public" }),
  });
  expect(published.status, await published.clone().text()).toBe(201);
  const hostname = String(((await published.json()) as { hostname: string }).hostname);
  f.setIsolate(async () => ({ bodyBase64: Buffer.from("{}").toString("base64") }));
  const visitor = randomBytes(18).toString("base64url");
  const ran = await f.runtime(
    hostname,
    "/published-artifacts/current/server",
    { path: "/issues" },
    visitor,
  );
  expect(ran.status, JSON.stringify(ran.json)).toBe(200);
  expect(f.runs.at(-1)!.context.viewer).toMatchObject({ kind: "guest", email: null });
  expect(f.runs.at(-1)!.context.viewer!.id).toStartWith("guest:");
});
