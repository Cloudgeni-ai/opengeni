import { describe, expect, test } from "bun:test";
import { siteSessionPath } from "@opengeni/contracts/site-session-http";
import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_VERSION,
  OpenGeniSiteDataError,
  createOpenGeniSiteClient,
  createSiteToolBridge,
  isSiteHttpRequest,
  serveSiteHttp,
} from "../src/site";

const SITE_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const VERSION_ID = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

type Seen = { path: string; method: string; headers: Record<string, string>; body: unknown };

function host(options: {
  advertise: boolean;
  respond: (seen: Seen) => { status: number; body: unknown };
}) {
  const seen: Seen[] = [];
  const bridge = createSiteToolBridge({
    workspaceId: "ws-1",
    workspaceTools: { $catalog: async () => ({}) as never },
    callTool: async () => ({}) as never,
    artifactId: SITE_ID,
    siteVersionId: VERSION_ID,
    requestedTools: [],
    fetchResponse: async (path, init) => {
      const entry: Seen = {
        path,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body,
      };
      seen.push(entry);
      const result = options.respond(entry);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const bootstrap = new MessageChannel();
  const ports: MessagePort[] = [];
  bootstrap.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
    const port = event.ports[0] as MessagePort;
    ports.push(port);
    port.addEventListener("message", (portEvent: MessageEvent<unknown>) => {
      if (!isSiteHttpRequest(portEvent.data) || portEvent.ports.length !== 1) return;
      void serveSiteHttp(
        portEvent.data,
        portEvent.ports[0]!,
        (request, signal) => bridge.fetch!(request, signal),
        new AbortController().signal,
      );
    });
    port.start();
    port.postMessage({
      type: OPENGENI_SITE_BRIDGE_READY,
      version: OPENGENI_SITE_BRIDGE_VERSION,
      ...(options.advertise && bridge.siteData ? { siteData: 1 } : {}),
    });
  });
  bootstrap.port1.start();
  const client = createOpenGeniSiteClient({ bootstrapPort: bootstrap.port2 });
  return {
    client,
    seen,
    close: () => {
      client.close();
      bootstrap.port1.close();
      for (const port of ports) port.close();
    },
  };
}

const record = (data: Record<string, unknown>, version = 1) => ({
  id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  key: null,
  data,
  owner: "user:viewer",
  createdBy: "user:viewer",
  updatedBy: "user:viewer",
  version,
  sizeBytes: 10,
  createdAt: "2026-10-13T12:00:00.000Z",
  updatedAt: "2026-10-13T12:00:00.000Z",
});

describe("Site Data client", () => {
  test("routes typed calls to the host's pinned Site with the viewer's transport", async () => {
    const h = host({
      advertise: true,
      respond: (seen) => {
        if (seen.path.endsWith("/data/query"))
          return { status: 200, body: { records: [record({ name: "Acme" })], nextCursor: null, count: 1 } };
        if (seen.path.endsWith("/data/get"))
          return {
            status: 404,
            body: { error: { code: "not_found", message: "Record not found", details: { code: "not_found" } } },
          };
        if (seen.path.endsWith("/data/write")) {
          const operations = (JSON.parse(String(seen.body)) as { operations: Array<{ op: string; data?: object }> }).operations;
          if (operations[0]!.op === "patch")
            return {
              status: 409,
              body: {
                error: {
                  code: "conflict",
                  message: "The record changed",
                  details: { code: "conflict", currentVersion: 3 },
                },
              },
            };
          return { status: 200, body: { results: [{ op: "insert", record: record({ ...operations[0]!.data }) }] } };
        }
        if (seen.path.includes("/files"))
          return { status: 201, body: { id: "f1", name: "logo.png", scope: "private" } };
        return { status: 500, body: null };
      },
    });
    try {
      const companies = h.client.data.collection<{ name: string }>("companies");
      const page = await companies.list({ where: [{ field: "name", op: "eq", value: "Acme" }], count: true });
      expect(page.records[0]!.data.name).toBe("Acme");
      expect(page.count).toBe(1);
      expect(h.seen[0]!.path).toBe(`/v1/workspaces/ws-1/published-artifacts/${SITE_ID}/data/query`);
      expect(h.seen[0]!.headers["x-opengeni-site-id"]).toBe(SITE_ID);
      expect(h.seen[0]!.headers["x-opengeni-site-version"]).toBe(VERSION_ID);
      expect(JSON.parse(String(h.seen[0]!.body))).toMatchObject({ collection: "companies", count: true });

      expect(await companies.get("missing")).toBeNull();
      expect(JSON.parse(String(h.seen[1]!.body))).toEqual({ collection: "companies", key: "missing" });

      const inserted = await companies.insert({ name: "Globex" }, { key: "globex" });
      expect(inserted.data.name).toBe("Globex");
      expect(JSON.parse(String(h.seen[2]!.body))).toEqual({
        operations: [{ op: "insert", collection: "companies", data: { name: "Globex" }, key: "globex" }],
      });

      const conflict = await companies
        .patch({ id: inserted.id }, { name: "Globex Corp" }, { expectedVersion: 1 })
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(OpenGeniSiteDataError);
      expect(conflict).toMatchObject({ code: "conflict", status: 409, details: { currentVersion: 3 } });

      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      await h.client.files.upload(bytes, { name: "logo.png", contentType: "image/png", scope: "private" });
      const upload = h.seen.at(-1)!;
      expect(upload.path).toBe(
        `/v1/workspaces/ws-1/published-artifacts/${SITE_ID}/files?name=logo.png&scope=private`,
      );
      expect(upload.headers["content-type"]).toBe("image/png");
      expect(upload.body).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(upload.body as ArrayBuffer)]).toEqual([...bytes]);
    } finally {
      h.close();
    }
  });

  test("a host that does not advertise Site Data fails clearly without sending", async () => {
    const h = host({ advertise: false, respond: () => ({ status: 200, body: {} }) });
    try {
      await expect(h.client.data.collection("notes").list()).rejects.toMatchObject({
        code: "site_data_unsupported",
      });
      await expect(h.client.files.list()).rejects.toBeInstanceOf(OpenGeniSiteDataError);
      expect(h.seen).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  test("only a host bound to a published Site resolves the current Site", () => {
    expect(
      siteSessionPath("/v1/workspaces/site-host/published-artifacts/current/data/query", "ws", "POST", SITE_ID),
    ).toBe(`/v1/workspaces/ws/published-artifacts/${SITE_ID}/data/query`);
    expect(() =>
      siteSessionPath("/v1/workspaces/site-host/published-artifacts/current/data/query", "ws", "POST"),
    ).toThrow();
    // Inside the Site the alias stays unresolved.
    expect(
      siteSessionPath(
        "/v1/workspaces/site-host/published-artifacts/current/files",
        "site-host",
        "GET",
      ),
    ).toBe("/v1/workspaces/site-host/published-artifacts/current/files");
  });
});
