import { describe, expect, expectTypeOf, test } from "bun:test";
import * as historyImport from "@opengeni/sdk/session-history-import";
import {
  appendArchivedSessionEvents,
  appendExternalWorkspaceArchivedSessionEvents,
  importArchivedSession,
  importExternalWorkspaceArchivedSession,
  type ArchivedSessionImportEvent,
  type AppendArchivedSessionEventsRequest,
  type AppendArchivedSessionEventsResponse,
  type ImportArchivedSessionRequest,
  type ImportArchivedSessionResponse,
  type SessionImportedArchive,
} from "@opengeni/sdk/session-history-import";
import type { Session as ContractSession } from "@opengeni/contracts";
import { OpenGeniBrowserClient } from "../src/browser";
import { OpenGeniApiError } from "../src/errors";
import * as root from "../src/index";
import { createSessionProxyHandler, OpenGeniClient, type Session } from "../src/index";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const createdAt = "2025-04-01T09:30:00+02:00";
const importedAt = "2026-10-01T06:30:00.000Z";
const importId = "legacy/thread:one";
const events: ArchivedSessionImportEvent[] = [
  { type: "user.message", createdAt, turnId, payload: { text: "Keep this exact text: 😀" } },
  {
    type: "agent.message.completed",
    createdAt,
    turnId,
    payload: { text: "Historical answer", channel: "final", extra: { value: null } },
  },
];
const request: ImportArchivedSessionRequest = {
  importId,
  title: "Original conversation",
  createdAt,
  visibility: "user_private",
  events,
};
const batch: AppendArchivedSessionEventsRequest = {
  batchId: "thread:one/batch:1",
  offset: 2,
  events: [{ type: "goal.completed", createdAt, turnId: null, payload: { status: "completed" } }],
};
const archive: SessionImportedArchive = { importId, importedAt, readOnly: true };
// The transport fixture needs only the session fields whose exact bytes it tests.
const receipt: Omit<ImportArchivedSessionResponse, "session"> & {
  session: Pick<ContractSession, "id" | "workspaceId" | "createdAt" | "title" | "importedArchive">;
} = {
  session: {
    id: sessionId,
    workspaceId,
    createdAt,
    title: request.title,
    importedArchive: archive,
  },
  importId,
  created: true,
  nextOffset: 2,
};
const appendReceipt: AppendArchivedSessionEventsResponse = {
  sessionId,
  importId,
  nextOffset: 3,
  replayed: false,
};

type Recorded = { path: string; method: string; headers: Headers; body: unknown };

function fixture(
  respond: (call: Recorded) => Response = (call) =>
    Response.json(call.path.endsWith("/events") ? appendReceipt : receipt),
) {
  const calls: Recorded[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic-organization-key",
    fetch: async (url, init) => {
      const call = {
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

describe("server-only archived session history import SDK", () => {
  test("preserves request and response shapes through the normal JSON transport", async () => {
    const { client, calls } = fixture();
    const imported = await importArchivedSession(client, "workspace/one", request);
    expect(receipt).toEqual(imported);
    expect(await appendArchivedSessionEvents(client, "workspace/one", importId, batch)).toEqual(
      appendReceipt,
    );
    expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/v1/workspaces/workspace%2Fone/session-imports", body: request },
      {
        method: "POST",
        path: "/v1/workspaces/workspace%2Fone/session-imports/legacy%2Fthread%3Aone/events",
        body: batch,
      },
    ]);
    expect(calls.every(({ headers }) => headers.get("content-type") === "application/json")).toBe(
      true,
    );
    expect(calls.every(({ headers }) => headers.get("x-opengeni-external-actor") === null)).toBe(
      true,
    );
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer synthetic-organization-key");
    expectTypeOf(imported).toEqualTypeOf<ImportArchivedSessionResponse>();
    expectTypeOf<Session["importedArchive"]>().toEqualTypeOf<ContractSession["importedArchive"]>();
  });

  test("leaves optional initial events and visibility to server defaults", async () => {
    const { client, calls } = fixture();
    const minimal = { importId, title: request.title, createdAt };
    await importArchivedSession(client, workspaceId, minimal);
    expect(calls[0]!.body).toEqual(minimal);
  });

  test("retains asUser creator/owner provenance on every helper without changing the service", async () => {
    const { client, calls } = fixture();
    const actor = client.asUser("User/CaseSensitive:😀", { source: "host-product" });
    await importArchivedSession(actor, workspaceId, request);
    await appendArchivedSessionEvents(actor, workspaceId, importId, batch);
    await importExternalWorkspaceArchivedSession(actor, "host-product", "tenant-one", request);
    await appendExternalWorkspaceArchivedSessionEvents(
      actor,
      "host-product",
      "tenant-one",
      importId,
      batch,
    );
    await importArchivedSession(client, workspaceId, {
      ...request,
      visibility: "workspace_shared",
    });
    expect(
      calls
        .slice(0, 4)
        .map(({ headers }) =>
          JSON.parse(decodeURIComponent(headers.get("x-opengeni-external-actor")!)),
        ),
    ).toEqual(
      Array.from({ length: 4 }, () => ({
        mode: "external",
        identity: { externalId: "User/CaseSensitive:😀", source: "host-product" },
      })),
    );
    expect(calls[4]!.headers.get("x-opengeni-external-actor")).toBeNull();
    expect(calls[0]!.body).toEqual(request);
  });

  test("encodes external mapping and import IDs as separate opaque path segments", async () => {
    const { client, calls } = fixture();
    const source = "host/product:prod";
    const externalId = "Tenant/Case?x=#😀";
    const opaqueImportId = "thread/one?batch=#😀";
    expect(receipt).toEqual(
      await importExternalWorkspaceArchivedSession(client, source, externalId, request),
    );
    expect(
      await appendExternalWorkspaceArchivedSessionEvents(
        client,
        source,
        externalId,
        opaqueImportId,
        batch,
      ),
    ).toEqual(appendReceipt);
    const base = `/v1/workspaces/external/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}/session-imports`;
    expect(calls.map(({ path }) => path)).toEqual([
      base,
      `${base}/${encodeURIComponent(opaqueImportId)}/events`,
    ]);
    expect(calls.map(({ body }) => body)).toEqual([request, batch]);
  });

  test("returns replay receipts and retains exact idempotency bodies on deliberate retries", async () => {
    let imports = 0;
    let appends = 0;
    const { client, calls } = fixture((call) =>
      Response.json(
        call.path.endsWith("/events")
          ? { ...appendReceipt, replayed: appends++ > 0 }
          : { ...receipt, created: imports++ === 0 },
      ),
    );
    expect((await importArchivedSession(client, workspaceId, request)).created).toBe(true);
    expect((await importArchivedSession(client, workspaceId, request)).created).toBe(false);
    expect((await appendArchivedSessionEvents(client, workspaceId, importId, batch)).replayed).toBe(
      false,
    );
    expect((await appendArchivedSessionEvents(client, workspaceId, importId, batch)).replayed).toBe(
      true,
    );
    expect(calls.map(({ body }) => body)).toEqual([request, request, batch, batch]);
  });

  test("propagates API refusals and offset conflicts without automatic retries", async () => {
    for (const status of [400, 403, 404, 409, 413]) {
      const errorBody = {
        error: {
          code: status === 409 ? "import_conflict" : "import_refused",
          message: "Import refused",
          retryable: false,
          details: { nextOffset: 3 },
        },
      };
      const { client, calls } = fixture(() => Response.json(errorBody, { status }));
      const operations = [
        () => importArchivedSession(client, workspaceId, request),
        () => appendArchivedSessionEvents(client, workspaceId, importId, batch),
        () => importExternalWorkspaceArchivedSession(client, "host", "tenant", request),
        () =>
          appendExternalWorkspaceArchivedSessionEvents(client, "host", "tenant", importId, batch),
      ];
      for (const operation of operations) {
        const error = await operation().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OpenGeniApiError);
        expect(error).toMatchObject({
          status,
          code: errorBody.error.code,
          retryable: false,
          outcomeUnknown: false,
          details: { nextOffset: 3 },
        });
      }
      expect(calls).toHaveLength(4);
    }
  });

  test("preserves outcome-unknown transport errors for exact-request reconciliation", async () => {
    let calls = 0;
    const client = new OpenGeniClient({
      baseUrl: "https://fixture.invalid",
      fetch: async () => {
        calls++;
        throw new TypeError("connection lost");
      },
    });
    const error = await appendArchivedSessionEvents(client, workspaceId, importId, batch).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect(error).toMatchObject({ code: "network_error", outcomeUnknown: true, retryable: true });
    expect(calls).toBe(1);
  });

  test("publishes exactly four opt-in helpers with no root or eager client additions", async () => {
    const names = [
      "importArchivedSession",
      "appendArchivedSessionEvents",
      "importExternalWorkspaceArchivedSession",
      "appendExternalWorkspaceArchivedSessionEvents",
    ];
    expect(Object.keys(historyImport).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(name in root).toBe(false);
      expect(name in OpenGeniClient.prototype).toBe(false);
      expect(name in OpenGeniBrowserClient.prototype).toBe(false);
    }
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(packageJson.exports["./session-history-import"]).toEqual({
      types: "./src/session-history-import.ts",
      default: "./src/session-history-import.ts",
    });
    const { default: tsup } = await import("../tsup.config");
    expect(tsup).toMatchObject({
      entry: expect.arrayContaining(["src/session-history-import.ts"]),
    });
  });

  test("keeps import code and contracts runtime out of ordinary browser bundles", async () => {
    for (const entry of ["browser", "core", "index"]) {
      const build = await Bun.build({
        entrypoints: [new URL(`../src/${entry}.ts`, import.meta.url).pathname],
        target: "browser",
        minify: false,
      });
      expect(build.success).toBe(true);
      const output = await build.outputs[0]!.text();
      expect(output).not.toContain("session-imports");
      expect(output).not.toContain("importArchivedSession");
      expect(output).not.toContain("Import request exceeds its byte limit");
    }
    const build = await Bun.build({
      entrypoints: [new URL("../src/session-history-import.ts", import.meta.url).pathname],
      target: "node",
      minify: false,
    });
    expect(build.success).toBe(true);
    const output = await build.outputs[0]!.text();
    expect(output).toContain("session-imports");
    expect(output).not.toContain("Payload must be bounded JSON");
    expect(output).not.toContain("class OpenGeniClient");
  });

  test("refuses both import route forms at the packaged browser proxy without forwarding", async () => {
    const { client, calls } = fixture();
    const handler = createSessionProxyHandler(client, {
      resolve: () => ({ workspaceId, user: "host-user", source: "host" }),
    });
    for (const [path, status] of [
      [`/v1/workspaces/${workspaceId}/session-imports`, 404],
      [`/v1/workspaces/${workspaceId}/session-imports/thread-one/events`, 404],
      ["/v1/workspaces/external/host/tenant/session-imports", 403],
      ["/v1/workspaces/external/host/tenant/session-imports/thread-one/events", 403],
    ] as const) {
      const response = await handler(
        new Request(`https://product.invalid/api/opengeni${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(path.endsWith("/events") ? batch : request),
        }),
      );
      expect(response.status).toBe(status);
    }
    expect(calls).toHaveLength(0);
  });
});
