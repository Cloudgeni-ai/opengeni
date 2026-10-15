/**
 * Fixture `bw serve` on a real Unix socket. Shapes and messages follow the
 * CLI source at bitwarden/clients 57e52fcc; this is not a live account.
 */
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeItem = Record<string, unknown> & { id: string; type: number };

export const USER_ID = "0b6d7a52-91a4-4f5e-8f7c-2e8f51b1c001";
export const ORG_ID = "1c7e8b63-a2b5-4a6f-9a8d-3f9a62c2d002";
export const COLLECTION_ID = "2d8f9c74-b3c6-4b70-8b9e-4a0b73d3e003";
export const OTHER_COLLECTION_ID = "3e90ad85-c4d7-4c81-9caf-5b1c84e4f004";

let counter = 0;
export function guid(): string {
  counter += 1;
  return `9a000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

export function login(overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    object: "item",
    id: guid(),
    organizationId: null,
    folderId: null,
    type: 1,
    reprompt: 0,
    name: "GitHub",
    notes: "recovery codes in drawer",
    favorite: false,
    fields: [
      { name: "api key", value: "ghp_secret", type: 1, linkedId: null },
      { name: "team", value: "platform", type: 0, linkedId: null },
      { name: "linked", value: null, type: 3, linkedId: 100 },
    ],
    login: {
      uris: [{ match: 3, uri: "https://github.com", uriChecksum: "abc" }],
      username: "octo",
      password: "hunter2",
      totp: "JBSWY3DPEHPK3PXP",
      passwordRevisionDate: null,
      fido2Credentials: [],
    },
    collectionIds: [],
    revisionDate: "2026-10-15T10:00:00.000Z",
    creationDate: "2026-10-01T10:00:00.000Z",
    deletedDate: null,
    archivedDate: null,
    passwordHistory: [{ lastUsedDate: "2026-09-01T00:00:00.000Z", password: "old" }],
    unknownFutureField: { keep: true },
    ...overrides,
  };
}

export interface FakeBwState {
  status: "unlocked" | "locked" | "unauthenticated";
  lastSync: string | null;
  offline: boolean;
  items: FakeItem[];
  collections: Array<{ id: string; organizationId: string; name: string; externalId: null }>;
  /** Item ids the user cannot edit. */
  readOnly: Set<string>;
  /** Commit the next mutation, then drop the connection without a response. */
  dropAfterCommit: boolean;
  /** Fail the next mutation with this CLI message. */
  failNext: string | null;
  requests: Array<{ method: string; path: string; host: string | undefined }>;
  syncs: number;
}

export async function startFakeBwServe(options: { items?: FakeItem[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fake-bw-"));
  const socketPath = join(directory, "bw.sock");
  let clock = Date.parse("2026-10-15T12:00:00.000Z");
  const state: FakeBwState = {
    status: "unlocked",
    lastSync: "2026-10-15T09:00:00.000Z",
    offline: false,
    items: options.items ?? [],
    collections: [
      { id: COLLECTION_ID, organizationId: ORG_ID, name: "Platform", externalId: null },
      { id: OTHER_COLLECTION_ID, organizationId: ORG_ID, name: "Finance", externalId: null },
    ],
    readOnly: new Set(),
    dropAfterCommit: false,
    failNext: null,
    requests: [],
    syncs: 0,
  };
  const tick = () => {
    clock += 1_000;
    return new Date(clock).toISOString();
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    state.requests.push({
      method: request.method ?? "",
      path: url.pathname + url.search,
      host: request.headers.host,
    });
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const ok = (data?: unknown) =>
      reply(200, data === undefined ? { success: true } : { success: true, data });
    const fail = (message: string) => reply(400, { success: false, message });
    // Origin protection from `bw serve` (plain text 403).
    if (request.headers.origin !== undefined || request.headers.host !== "localhost:8087") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /status") {
        return ok({
          object: "template",
          template: {
            serverUrl: "https://vault.bitwarden.eu",
            lastSync: state.lastSync,
            userEmail: state.status === "unauthenticated" ? null : "ops@example.com",
            userId: state.status === "unauthenticated" ? null : USER_ID,
            status: state.status,
          },
        });
      }
      if (state.status === "unauthenticated") return fail("You are not logged in.");
      if (state.status === "locked") return fail("Vault is locked.");
      if (route === "POST /sync") {
        if (state.offline) return fail("Failed to fetch");
        state.syncs += 1;
        state.lastSync = tick();
        return ok({ object: "message", title: "Syncing complete.", message: null });
      }
      const active = state.items.filter(
        (item) => item.deletedDate == null && item.archivedDate == null,
      );
      if (route === "GET /list/object/items") {
        const org = url.searchParams.get("organizationid");
        const collection = url.searchParams.get("collectionid");
        const list = active.filter((item) =>
          collection
            ? Array.isArray(item.collectionIds) && item.collectionIds.includes(collection)
            : org === "null"
              ? item.organizationId == null
              : true,
        );
        return ok({ object: "list", data: structuredClone(list) });
      }
      if (route === "GET /list/object/collections") {
        return ok({
          object: "list",
          data: state.collections.map((c) => ({ object: "collection", ...c })),
        });
      }
      const match = /^\/object\/item(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) return reply(404, { success: false, message: "Not found." });
      const id = match[1];
      const index = id ? state.items.findIndex((item) => item.id === id) : -1;
      if (request.method === "GET") {
        return index >= 0 ? ok(structuredClone(state.items[index])) : fail("Not found.");
      }
      if (state.failNext) {
        const message = state.failNext;
        state.failNext = null;
        return fail(message);
      }
      const finish = (data?: unknown) => {
        if (state.dropAfterCommit) {
          state.dropAfterCommit = false;
          request.socket.destroy();
          return;
        }
        ok(data);
      };
      if (request.method === "POST" && !id) {
        const created = {
          ...body,
          object: "item",
          id: guid(),
          revisionDate: tick(),
          deletedDate: null,
          archivedDate: null,
        } as FakeItem;
        state.items.push(created);
        return finish(structuredClone(created));
      }
      if (index < 0) return fail("Not found.");
      const current = state.items[index]!;
      if (request.method === "PUT") {
        if (current.deletedDate != null)
          return fail("You may not edit a deleted item. Use the restore command first.");
        if (state.readOnly.has(current.id))
          return fail("You do not have permission to edit this item");
        if (body.revisionDate !== current.revisionDate) {
          return fail(
            "The cipher you are updating is out of date. Please save your work, sync your vault, and try again.",
          );
        }
        const saved = { ...body, id: current.id, revisionDate: tick() } as FakeItem;
        state.items[index] = saved;
        return finish(structuredClone(saved));
      }
      if (request.method === "DELETE") {
        if (url.searchParams.get("permanent") === "true") {
          state.items.splice(index, 1);
          return finish();
        }
        current.deletedDate = tick();
        return finish();
      }
      return fail("Not found.");
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    state,
    directory,
    socketPath,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
