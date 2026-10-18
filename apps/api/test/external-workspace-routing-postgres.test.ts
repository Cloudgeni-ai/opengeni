import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  createOrganizationApiKey,
  createWorkspace,
  nestedPostgresSqlState,
  registerDbBinding,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { ApiRouteDeps } from "@opengeni/core";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../../../packages/db/src/lossless-json";
import { createApp } from "../src/app";

let shared: SharedTestDatabase | null;
let driver: postgres.Sql;
let db: Database;
const invalidLookups: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("external-workspace-routing");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  driver = postgres(shared.appUrl, {
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_connection, query, parameters) => {
      // Observe attempted SQL, not just HTTP status: a guard used to swallow 22P02.
      if (parameters.includes("external") || parameters.includes("not-a-uuid"))
        invalidLookups.push(query);
    },
  });
  db = drizzle(driver, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await shared?.release();
}, 60_000);

async function fixture() {
  if (!shared) throw new Error("PostgreSQL unavailable");
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Routing fixture') returning id`;
  const accountId = String(account!.id);
  const externalId = crypto.randomUUID();
  const workspace = await createWorkspace(db, {
    accountId,
    name: "Tenant",
    externalSource: "host",
    externalId,
  });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db, {
    accountId,
    name: "Integration",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin", "workspace:create", "members:manage", "api_keys:manage"],
  });
  const settings = testSettings({
    productAccessMode: "managed",
    sandboxBackend: "none",
    usageAllowancesEnabled: true,
  });
  const errors: unknown[][] = [];
  const diagnosticStates: Array<string | null> = [];
  const observability = createObservability(settings, { component: "api" });
  observability.error = (...args) => {
    errors.push(args);
  };
  observability.info = () => {};
  observability.recordFailureDiagnostic = (input) => {
    diagnosticStates.push(nestedPostgresSqlState(input.error));
  };
  const app = createApp({
    db,
    bus: new MemoryEventBus(),
    managedAuth: null,
    settings,
    observability,
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const externalBase = `/v1/workspaces/external/host/${externalId}`;
  invalidLookups.length = 0;
  return { app, headers, accountId, workspace, externalId, externalBase, errors, diagnosticStates };
}

test("valid external provisioning and asUser imports never query a workspace named external", async () => {
  if (!shared) return;
  const f = await fixture();
  const provisioned = await f.app.request("/v1/workspaces/external", {
    method: "PUT",
    headers: f.headers,
    body: JSON.stringify({
      accountId: f.accountId,
      externalSource: "host",
      externalId: f.externalId,
      name: "Tenant",
    }),
  });
  expect(provisioned.status, await provisioned.clone().text()).toBe(200);
  const headers = {
    ...f.headers,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source: "host", externalId: "alice" } }),
    ),
  };
  const imported = await f.app.request(`${f.externalBase}/session-imports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      importId: "thread",
      title: "Past conversation",
      createdAt: "2021-06-15T12:34:56.000Z",
    }),
  });
  expect(imported.status, await imported.clone().text()).toBe(201);
  const appended = await f.app.request(`${f.externalBase}/session-imports/thread/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      batchId: "one",
      offset: 0,
      events: [
        {
          type: "user.message",
          createdAt: "2021-06-15T12:34:56.000Z",
          payload: { text: "Archived" },
        },
      ],
    }),
  });
  expect(appended.status, await appended.clone().text()).toBe(200);
  expect(f.errors).toEqual([]);
  expect(invalidLookups).toEqual([]);
}, 60_000);

test("every registered external route stays outside native middleware, including denied requests", async () => {
  if (!shared) return;
  const f = await fixture();
  const routes = f.app.routes.filter(
    (route) => route.path.startsWith("/v1/workspaces/external") && route.handler.length < 2,
  );
  expect(routes.length).toBeGreaterThan(10);
  for (const route of routes) {
    const path = route.path
      .replace(/:workspaceSource|:source/g, "host")
      .replace(/:workspaceExternalId|:externalId/g, f.externalId)
      .replace(/:[A-Za-z]+/g, "missing");
    for (const headers of [f.headers, { "content-type": "application/json" }]) {
      const response = await f.app.request(path, {
        method: route.method,
        headers,
        ...(["GET", "HEAD"].includes(route.method) ? {} : { body: "{}" }),
      });
      expect(
        response.status,
        `${route.method} ${path}: ${await response.clone().text()}`,
      ).toBeLessThan(500);
      if (!("authorization" in headers)) expect([401, 403]).toContain(response.status);
    }
  }
  expect(invalidLookups).toEqual([]);
}, 60_000);

test("allowance writes and reads use the resolved tenant and preserve organization isolation", async () => {
  if (!shared) return;
  const f = await fixture();
  const other = await fixture();
  const response = await f.app.request(`${f.externalBase}/allowance`, {
    method: "PUT",
    headers: f.headers,
    body: JSON.stringify({ includedCredits: 100, period: "none", expectedVersion: 0 }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  for (const suffix of ["/allowance", "/allowance/state", "/usage"]) {
    const result = await f.app.request(`${f.externalBase}${suffix}`, { headers: f.headers });
    expect(result.status, await result.clone().text()).toBe(200);
    const denied = await f.app.request(`${f.externalBase}${suffix}`, { headers: other.headers });
    expect(denied.status, await denied.clone().text()).toBe(404);
    const nativeDenied = await f.app.request(`/v1/workspaces/${f.workspace.id}${suffix}`, {
      headers: other.headers,
    });
    expect(nativeDenied.status, await nativeDenied.clone().text()).toBe(403);
  }
  expect(invalidLookups).toEqual([]);
}, 60_000);

test("first-use membership refuses an incomplete workspace without creating membership", async () => {
  if (!shared) return;
  const f = await fixture();
  const [incomplete] = await shared.admin`
    insert into workspaces (account_id, name) values (${f.accountId}, 'Incomplete tenant') returning id`;
  const response = await f.app.request(`/v1/workspaces/${incomplete!.id}/sessions`, {
    headers: {
      ...f.headers,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({ mode: "external", identity: { source: "host", externalId: "alice" } }),
      ),
    },
  });
  expect(response.status, await response.clone().text()).toBe(403);
  const [members] = await shared.admin`
    select count(*)::int as count from workspace_memberships where workspace_id = ${incomplete!.id}`;
  expect(members!.count).toBe(0);
  expect(f.diagnosticStates.filter(Boolean)).toEqual([]);
  expect(invalidLookups).toEqual([]);
}, 60_000);

test("unregistered external paths and malformed native workspace IDs never reach SQL", async () => {
  if (!shared) return;
  const f = await fixture();
  for (const path of [
    "/v1/workspaces/external",
    `${f.externalBase}/sessions`,
    "/v1/workspaces/external/allowance",
    "/v1/workspaces/not-a-uuid/sessions",
  ]) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const response = await f.app.request(path, { method, headers: f.headers });
      expect([404, 405], `${method} ${path}: ${await response.clone().text()}`).toContain(
        response.status,
      );
    }
  }
  expect(invalidLookups).toEqual([]);
}, 60_000);

test("no registered native workspace handler accepts the external segment as its workspace ID", async () => {
  if (!shared) return;
  const f = await fixture();
  const routes = f.app.routes.filter(
    (route) => route.path.startsWith("/v1/workspaces/:workspaceId") && route.handler.length < 2,
  );
  expect(routes.length).toBeGreaterThan(200);
  for (const route of routes) {
    const path = route.path
      .replace(":workspaceId", "external")
      .replace(/:[A-Za-z0-9_]+/g, f.workspace.id)
      .replace(/\*$/, "missing");
    const method = route.method === "ALL" ? "POST" : route.method;
    const response = await f.app.request(path, {
      method,
      headers: f.headers,
      ...(["GET", "HEAD"].includes(method) ? {} : { body: "{}" }),
    });
    expect([404, 405], `${method} ${path}: ${await response.clone().text()}`).toContain(
      response.status,
    );
  }
  expect(invalidLookups).toEqual([]);
}, 60_000);

test("workspace lookup database failures are 500s with diagnostics, never missing rows or successful writes", async () => {
  if (!shared) return;
  const f = await fixture();
  // This test owns its cloned database. A missing relation produces real 42P01
  // at the workspace lookup without disrupting key authentication.
  await shared.admin`alter table workspaces rename to unavailable_workspaces`;
  try {
    for (const [method, suffix] of [
      ["GET", ""],
      ["PUT", "/allowance"],
    ]) {
      const response = await f.app.request(`/v1/workspaces/${f.workspace.id}${suffix}`, {
        method,
        headers: f.headers,
        ...(method === "PUT"
          ? { body: JSON.stringify({ includedCredits: 100, period: "none", expectedVersion: 0 }) }
          : {}),
      });
      expect(response.status, await response.clone().text()).toBe(500);
    }
    expect(f.errors.filter(([message]) => message === "HTTP request failed")).toHaveLength(2);
    expect(f.diagnosticStates).toEqual(["42P01", "42P01"]);
  } finally {
    await shared.admin`alter table unavailable_workspaces rename to workspaces`;
  }
}, 60_000);
