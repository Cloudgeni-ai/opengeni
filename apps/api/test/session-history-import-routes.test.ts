import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  SESSION_HISTORY_IMPORT_MAX_BODY_BYTES,
  SESSION_HISTORY_IMPORT_MAX_EVENT_BYTES,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import * as accessGrantRls from "../src/access-grant-rls";
import { createApp, routeLabel, workspaceActorContextExempt } from "../src/app";
import {
  archivedSessionImportErrorResponse,
  isSessionHistoryImportRequest,
  readSessionHistoryImportJson,
  registerSessionHistoryImportRoutes,
} from "../src/routes/session-history-imports";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const externalId = "55555555-5555-4555-8555-555555555555";
const externalSubject = `external_user:${externalId}`;
const secret = "session-history-import-route-secret";
const base = `/v1/workspaces/${workspaceId}/session-imports`;
const externalBase = "/v1/workspaces/external/product/Tenant%2FCase/session-imports";
const createdAt = "2024-03-02T01:02:03.000Z";
const event = { type: "user.message" as const, createdAt, payload: { text: "Original text 🐾" } };
const payload = { importId: "history/Case", title: "Imported history", createdAt };
const appended = { sessionId, importId: payload.importId, nextOffset: 2, replayed: false };
const imported = {
  session: {
    id: sessionId,
    importedArchive: { importId: payload.importId, importedAt: createdAt, readOnly: true },
  },
  importId: payload.importId,
  created: true,
  nextOffset: 0,
};
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function deps(): core.ApiRouteDeps {
  return {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("Unexpected direct database access");
        },
      },
    ),
    managedAuth: null,
    bus: new MemoryEventBus(),
    workflowClient: new Proxy(
      {},
      {
        get() {
          throw new Error("Imports must not start workflows");
        },
      },
    ),
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as core.ApiRouteDeps;
}
function api(full = false) {
  if (full) return createApp(deps());
  const app = new Hono();
  registerSessionHistoryImportRoutes(app, deps());
  return app;
}
function services() {
  return {
    create: track(
      spyOn(core, "importArchivedSessionForRequest").mockResolvedValue(imported as never),
    ),
    append: track(spyOn(core, "appendArchivedSessionEventsForRequest").mockResolvedValue(appended)),
  };
}
function key(permissions: Permission[] = ["workspace:admin"], workspaceKey = false) {
  track(
    spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
      id: keyId,
      accountId,
      workspaceId: workspaceKey ? workspaceId : null,
      credentialKind: workspaceKey ? "workspace" : "organization",
      permissions,
      name: "Import fixture",
    } as never),
  );
  track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
  track(
    spyOn(db, "requireWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
  return { authorization: "Bearer import-fixture" };
}
function externalMapping(found = true) {
  track(
    spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
      callback({} as never),
    ),
  );
  return track(
    spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue(
      found ? ({ id: workspaceId, accountId, kind: "shared" } as never) : null,
    ),
  );
}
function asUser(permissions: Permission[] = ["sessions:create", "workspace:read"]) {
  const headers = key();
  track(
    spyOn(db, "ensureExternalIdentity").mockResolvedValue({
      id: externalId,
      accountId,
      subjectId: externalSubject,
      source: "product",
      externalId: "Person/Case",
      personalWorkspaceId: "66666666-6666-4666-8666-666666666666",
      organizationMembershipId: "77777777-7777-4777-8777-777777777777",
      authorizationRevision: 1,
    } as never),
  );
  track(
    spyOn(db, "withWorkspaceSubjectRls").mockImplementation(
      async (_db, _workspace, _subject, callback) => callback({} as never),
    ),
  );
  track(
    spyOn(db, "getWorkspaceGrant").mockResolvedValue({
      accountId,
      workspaceId,
      subjectId: externalSubject,
      principalKind: "human_session",
      permissions,
    }),
  );
  return {
    ...headers,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({
        mode: "external",
        identity: { source: "product", externalId: "Person/Case" },
      }),
    ),
  };
}
function post(app: Hono, path: string, headers: Record<string, string>, body: unknown = payload) {
  return app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("archived session import HTTP adapters", () => {
  test("org-key creation and replay preserve the canonical authorization and empty-events default", async () => {
    const calls = services();
    const headers = key();
    const app = api();
    const created = await post(app, base, headers);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(imported);
    const [, authorization, resolvedWorkspace, request] = calls.create.mock.calls[0]!;
    expect(resolvedWorkspace).toBe(workspaceId);
    expect(request).toEqual({ ...payload, events: [] });
    expect(core.requireResolvedAccessGrantAuthorization(authorization, workspaceId).subjectId).toBe(
      `api_key:${keyId}`,
    );
    expect(core.isVerifiedOrganizationServiceAuthorization(authorization)).toBe(true);
    expect(core.externalAttributionForAuthorization(authorization, authorization.grant)).toBeNull();
    calls.create.mockResolvedValue({ ...imported, created: false } as never);
    const replay = await post(app, base, headers);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false, nextOffset: 0 });
  });

  test("native and external append mirrors forward decoded import ids and exact receipt responses", async () => {
    const calls = services();
    const headers = key();
    const mapping = externalMapping();
    const app = api();
    const batch = { batchId: "batch/One", offset: 1, events: [event] };
    for (const prefix of [base, externalBase]) {
      const response = await post(app, `${prefix}/history%2FCase/events`, headers, batch);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(appended);
      expect(calls.append.mock.calls.at(-1)!.slice(2)).toEqual([
        workspaceId,
        "history/Case",
        batch,
      ]);
    }
    expect(mapping.mock.calls[0]![1]).toEqual({
      accountId,
      externalSource: "product",
      externalId: "Tenant/Case",
    });
    calls.append.mockResolvedValue({ ...appended, replayed: true });
    const replay = await post(app, `${base}/history%2FCase/events`, headers, batch);
    expect(await replay.json()).toMatchObject({ replayed: true, nextOffset: 2 });
  });

  test("asUser private imports forward verified user identity, never backing key or display labels", async () => {
    const calls = services();
    const headers = asUser();
    externalMapping();
    for (const prefix of [base, externalBase]) {
      const response = await post(api(), prefix, headers, {
        ...payload,
        visibility: "user_private",
        events: [event],
      });
      expect(response.status).toBe(201);
      const authorization = calls.create.mock.calls.at(-1)![1];
      expect(authorization.authenticatedSubjectId).toBe(externalSubject);
      expect(core.hasVerifiedOwningUserAuthorization(authorization)).toBe(true);
      expect(core.isVerifiedOrganizationServiceAuthorization(authorization)).toBe(false);
      expect(
        core.externalAttributionForAuthorization(authorization, authorization.grant),
      ).toMatchObject({
        effectiveSubjectId: externalSubject,
        accountId,
      });
    }
  });

  test("workspace integration keys may use native ids but cannot resolve external tenant mappings", async () => {
    const calls = services();
    const headers = key(["sessions:create"], true);
    const mapping = externalMapping();
    expect((await post(api(), base, headers)).status).toBe(201);
    expect((await post(api(), externalBase, headers)).status).toBe(404);
    expect(mapping).not.toHaveBeenCalled();
    expect(calls.create).toHaveBeenCalledTimes(1);
  });

  test("delegated browser-shaped, service, API-key-shaped and agent principals cannot import", async () => {
    const calls = services();
    for (const [principalKind, subjectId] of [
      ["human_session", "user:delegated"],
      ["service", "user:delegated"],
      ["human_session", `api_key:${keyId}`],
      ["agent_attempt", "user:delegated"],
    ] as const) {
      const token = await signDelegatedAccessToken(secret, {
        accountId,
        workspaceId,
        subjectId,
        principalKind,
        permissions: ["workspace:admin"],
        ...(principalKind === "agent_attempt"
          ? {
              sessionId,
              turnId: crypto.randomUUID(),
              attemptId: crypto.randomUUID(),
              executionGeneration: 1,
            }
          : {}),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const response = await post(api(), base, { authorization: `Bearer ${token}` });
      expect(response.status).toBe(403);
    }
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("authentication and the operation's permission are required on both import operations", async () => {
    const calls = services();
    const headers = key(["workspace:read"]);
    for (const suffix of ["", "/history/events"]) {
      expect((await post(api(), `${base}${suffix}`, {})).status).toBe(401);
      expect((await post(api(), `${base}${suffix}`, headers)).status).toBe(403);
    }
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.append).not.toHaveBeenCalled();
  });

  test("asUser cannot borrow the org key's permissions or enumerate an unavailable import", async () => {
    const calls = services();
    const headers = asUser(["workspace:read"]);
    for (const suffix of ["", "/known/events", "/unknown/events"]) {
      expect((await post(api(), `${base}${suffix}`, headers)).status).toBe(403);
    }
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.append).not.toHaveBeenCalled();
  });

  test("unknown or inaccessible external mappings are not created", async () => {
    const calls = services();
    const headers = key();
    const mapping = externalMapping(false);
    expect((await post(api(), externalBase, headers)).status).toBe(404);
    expect(mapping).toHaveBeenCalledTimes(1);
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("a forged external-actor header on a delegated token cannot query tenant mappings", async () => {
    const calls = services();
    const mapping = externalMapping();
    track(spyOn(db, "findActiveApiKeyByHash").mockResolvedValue(null));
    const token = await signDelegatedAccessToken(secret, {
      accountId,
      workspaceId,
      subjectId: "user:delegated",
      principalKind: "human_session",
      permissions: ["workspace:admin"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const response = await post(api(), externalBase, {
      authorization: `Bearer ${token}`,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({
          mode: "external",
          identity: { source: "product", externalId: "forged" },
        }),
      ),
    });
    expect(response.status).toBe(401);
    expect(mapping).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("schema failures are stable value-free 422s before core mutation", async () => {
    const calls = services();
    const headers = key();
    const privateText = "private-invalid-request-do-not-reflect";
    const app = api();
    for (const body of [
      { ...payload, title: { privateText } },
      { ...payload, importId: "x".repeat(201) },
      { ...payload, createdAt: "not-a-date" },
      { ...payload, createdAt: "2024-03-02T01:02:03.123456Z" },
      { ...payload, events: [{ ...event, createdAt: "2024-03-02T01:02:03.123456Z" }] },
      { ...payload, creatorSubjectId: privateText },
      { ...payload, events: [{ ...event, type: "user.approvalDecision" }] },
      { ...payload, events: Array.from({ length: 101 }, () => event) },
      {
        ...payload,
        events: [
          { ...event, payload: { text: "🐾".repeat(SESSION_HISTORY_IMPORT_MAX_EVENT_BYTES / 4) } },
        ],
      },
    ]) {
      const response = await post(app, base, headers, body);
      expect(response.status).toBe(422);
      const text = await response.text();
      expect(text).not.toContain(privateText);
      expect(JSON.parse(text)).toEqual({
        code: "INVALID_SESSION_IMPORT_REQUEST",
        message: "Invalid archived session import request.",
      });
    }
    for (const body of [
      { batchId: "batch", offset: -1, events: [event] },
      { batchId: "batch", offset: 0, events: [] },
      { batchId: "x".repeat(201), offset: 0, events: [event] },
    ]) {
      expect((await post(app, `${base}/history/events`, headers, body)).status).toBe(422);
    }
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.append).not.toHaveBeenCalled();
  });

  test("malformed JSON and invalid UTF-8 use the import 422 contract", async () => {
    const calls = services();
    const headers = key();
    const app = api();
    for (const body of ['{"title":', new Uint8Array([0xff, 0xfe]), ""]) {
      const response = await app.request(base, { method: "POST", headers, body });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "INVALID_SESSION_IMPORT_REQUEST" });
    }
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("raw negative-zero payloads and offsets reject before reaching the lossless storage codec", async () => {
    const calls = services();
    const headers = { ...key(), "content-type": "application/json" };
    const app = api();
    // JSON.stringify normalizes -0 to 0, so send literal raw JSON to exercise
    // the real ingress representation rather than an already rewritten value.
    for (const [path, body] of [
      [
        base,
        '{"importId":"negative-zero","title":"History","createdAt":"2024-03-02T01:02:03.000Z","events":[{"type":"user.message","createdAt":"2024-03-02T01:02:03.000Z","payload":{"value":-0}}]}',
      ],
      [
        `${base}/history/events`,
        '{"batchId":"negative-zero","offset":-0,"events":[{"type":"user.message","createdAt":"2024-03-02T01:02:03.000Z","payload":{"text":"History"}}]}',
      ],
    ] as const) {
      const response = await app.request(path, { method: "POST", headers, body });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        code: "INVALID_SESSION_IMPORT_REQUEST",
        message: "Invalid archived session import request.",
      });
    }
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.append).not.toHaveBeenCalled();
  });

  test("core identity and offset conflicts return typed 409s without changing their receipt codes", async () => {
    const calls = services();
    const headers = key();
    calls.create.mockRejectedValue(new core.ArchivedSessionImportError("SESSION_IMPORT_CONFLICT"));
    const conflict = await post(api(), base, headers);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      code: "SESSION_IMPORT_CONFLICT",
      message: "Import identity was reused with different input",
    });
    calls.append.mockRejectedValue(
      new core.ArchivedSessionImportError("SESSION_IMPORT_OFFSET_CONFLICT"),
    );
    const offset = await post(api(), `${base}/history/events`, headers, {
      batchId: "once",
      offset: 0,
      events: [event],
    });
    expect(offset.status).toBe(409);
    expect(await offset.json()).toMatchObject({ code: "SESSION_IMPORT_OFFSET_CONFLICT" });
  });

  test("domain denials do not enumerate imports, and invalid file refs use the stable 422 contract", async () => {
    const calls = services();
    const headers = key();
    const batch = { batchId: "once", offset: 0, events: [event] };
    calls.append.mockRejectedValue(new core.ArchivedSessionImportError("SESSION_IMPORT_NOT_FOUND"));
    const known = await post(api(), `${base}/known/events`, headers, batch);
    const missing = await post(api(), `${base}/missing/events`, headers, batch);
    expect(known.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await known.json()).toEqual(await missing.json());
    calls.create.mockRejectedValue(
      new core.ArchivedSessionImportError("SESSION_IMPORT_INVALID_FILE"),
    );
    const invalidFile = await post(api(), base, headers);
    expect(invalidFile.status).toBe(422);
    expect(await invalidFile.json()).toMatchObject({ code: "INVALID_SESSION_IMPORT_REQUEST" });
  });

  test("the composed API preserves the read-only conflict on existing Send and Steer routes", async () => {
    const headers = key();
    track(spyOn(core, "requireSessionAuthorization").mockResolvedValue(null));
    track(spyOn(db, "getSession").mockResolvedValue(imported.session as never));
    const admission = track(
      spyOn(core, "acceptSessionUserMessage").mockRejectedValue(
        new core.ArchivedSessionImportError("SESSION_IMPORTED_READ_ONLY"),
      ),
    );
    const app = api(true);
    for (const error of [
      new core.ArchivedSessionImportError("SESSION_IMPORTED_READ_ONLY"),
      new Error("Private SQL and parameters must not be exposed", {
        cause: Object.assign(new Error("SESSION_IMPORTED_READ_ONLY"), { code: "OG002" }),
      }),
    ]) {
      admission.mockRejectedValue(error);
      for (const [suffix, body] of [
        ["events", { type: "user.message", payload: { text: "must not execute" } }],
        ["steer", { text: "must not execute" }],
      ] as const) {
        const response = await post(
          app,
          `/v1/workspaces/${workspaceId}/sessions/${sessionId}/${suffix}`,
          headers,
          body,
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          code: "SESSION_IMPORTED_READ_ONLY",
          message: "Imported session history is read-only",
        });
        expect(response.headers.get("x-opengeni-correlation-id")).toBeTruthy();
      }
    }
    expect(admission).toHaveBeenCalledTimes(4);
  });

  test("unrelated OG002 admission errors and cyclic causes are not mistaken for read-only archives", async () => {
    const cycle = Object.assign(new Error("unrelated"), { cause: null as unknown });
    cycle.cause = cycle;
    for (const [path, error] of [
      ["/admission", Object.assign(new Error("grant authority was revoked"), { code: "OG002" })],
      ["/cycle", cycle],
    ] as const) {
      const app = new Hono();
      app.get(
        path,
        (c) => archivedSessionImportErrorResponse(c, error) ?? c.json({ unmapped: true }),
      );
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ unmapped: true });
    }
  });

  test("integration authorization is checked before reading an untrusted body", async () => {
    const calls = services();
    const token = await signDelegatedAccessToken(secret, {
      accountId,
      workspaceId,
      subjectId: "user:delegated",
      principalKind: "human_session",
      permissions: ["workspace:admin"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(SESSION_HISTORY_IMPORT_MAX_BODY_BYTES + 1));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await api(true).request(
      new Request(`http://x${base}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
    );
    expect(response.status).toBe(403);
    expect(reads).toBe(0);
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("the full app registers all four paths and excludes only exact import POST paths", async () => {
    const calls = services();
    const headers = key();
    externalMapping();
    track(
      spyOn(accessGrantRls, "withAccessGrantSessionRlsContext").mockImplementation(
        async (_deps, _grant, callback) => callback(),
      ),
    );
    const app = api(true);
    for (const prefix of [base, externalBase]) {
      expect((await post(app, prefix, headers)).status).toBe(201);
      expect(
        (
          await post(app, `${prefix}/history/events`, headers, {
            batchId: "once",
            offset: 0,
            events: [event],
          })
        ).status,
      ).toBe(200);
    }
    expect(calls.create).toHaveBeenCalledTimes(2);
    expect(calls.append).toHaveBeenCalledTimes(2);
    for (const path of [
      base,
      `${base}/history/events`,
      externalBase,
      `${externalBase}/history/events`,
    ]) {
      expect(workspaceActorContextExempt("POST", path)).toBe(true);
      expect(workspaceActorContextExempt("GET", path)).toBe(false);
      expect(isSessionHistoryImportRequest("POST", path)).toBe(true);
    }
    expect(workspaceActorContextExempt("POST", `${externalBase}/history`)).toBe(false);
    expect(isSessionHistoryImportRequest("POST", `${base}/history/events/extra`)).toBe(false);
    expect(routeLabel(base)).toBe("/v1/workspaces/:workspaceId/session-imports");
    expect(routeLabel(`${base}/history/events`)).toBe(
      "/v1/workspaces/:workspaceId/session-imports/:importId/events",
    );
    expect(routeLabel(externalBase)).toBe(
      "/v1/workspaces/external/:source/:externalId/session-imports",
    );
    expect(routeLabel(`${externalBase}/history/events`)).toBe(
      "/v1/workspaces/external/:source/:externalId/session-imports/:importId/events",
    );
  });

  test("create-only organization keys import without a generic read gate but cannot append", async () => {
    const calls = services();
    const headers = key(["sessions:create"]);
    externalMapping();
    const app = api(true);
    for (const prefix of [base, externalBase]) {
      expect((await post(app, prefix, headers)).status).toBe(201);
      expect(
        (
          await post(app, `${prefix}/history/events`, headers, {
            batchId: "once",
            offset: 0,
            events: [event],
          })
        ).status,
      ).toBe(403);
    }
    expect(calls.create).toHaveBeenCalledTimes(2);
    expect(calls.append).not.toHaveBeenCalled();
  });

  test("control-only organization keys reach append without a generic read or create gate", async () => {
    const calls = services();
    const headers = key(["sessions:control"]);
    externalMapping();
    const app = api(true);
    for (const prefix of [base, externalBase]) {
      expect((await post(app, prefix, headers)).status).toBe(403);
      expect(
        (
          await post(app, `${prefix}/history/events`, headers, {
            batchId: "once",
            offset: 0,
            events: [event],
          })
        ).status,
      ).toBe(200);
    }
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.append).toHaveBeenCalledTimes(2);
  });

  test("append control permission is checked before reading the batch body", async () => {
    const calls = services();
    const headers = key(["sessions:create"]);
    externalMapping();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(SESSION_HISTORY_IMPORT_MAX_BODY_BYTES + 1));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await api(true).request(
      new Request(`http://x${externalBase}/history/events`, {
        method: "POST",
        headers,
        body,
      }),
    );
    expect(response.status).toBe(403);
    expect(reads).toBe(0);
    expect(calls.append).not.toHaveBeenCalled();
  });

  test("full-app chunked ingress stops at the raw-byte bound and cancels unread bytes", async () => {
    const calls = services();
    const headers = key();
    externalMapping();
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        // Whitespace counts toward the raw limit even though JSON.parse would
        // discard it and the normalized schema payload is tiny.
        if (pulls === 1) controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        else if (pulls <= 4) controller.enqueue(new Uint8Array(400_000).fill(32));
        else controller.enqueue(new Uint8Array(400_000).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await api(true).request(
      new Request(`http://x${externalBase}`, {
        method: "POST",
        headers,
        body,
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "INVALID_SESSION_IMPORT_REQUEST" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(5);
    expect(calls.create).not.toHaveBeenCalled();
  });
});

describe("bounded archived-import JSON reader", () => {
  test("accepts the exact raw limit and refuses one additional byte", async () => {
    const text = JSON.stringify(payload);
    const atLimit = text.padEnd(SESSION_HISTORY_IMPORT_MAX_BODY_BYTES, " ");
    expect(
      await readSessionHistoryImportJson(
        new Request("http://x", { method: "POST", body: atLimit }),
      ),
    ).toEqual(payload);
    await expect(
      readSessionHistoryImportJson(
        new Request("http://x", { method: "POST", body: `${atLimit} ` }),
      ),
    ).rejects.toThrow("Invalid archived session import request.");
  });

  test("a declared length cannot bypass actual-byte enforcement", async () => {
    await expect(
      readSessionHistoryImportJson(
        new Request("http://x", {
          method: "POST",
          headers: { "content-length": "1" },
          body: " ".repeat(SESSION_HISTORY_IMPORT_MAX_BODY_BYTES + 1),
        }),
      ),
    ).rejects.toThrow("Invalid archived session import request.");
    for (const length of ["-1", "unknown", String(SESSION_HISTORY_IMPORT_MAX_BODY_BYTES + 1)]) {
      await expect(
        readSessionHistoryImportJson(
          new Request("http://x", {
            method: "POST",
            headers: { "content-length": length },
            body: JSON.stringify(payload),
          }),
        ),
      ).rejects.toThrow("Invalid archived session import request.");
    }
  });
});
