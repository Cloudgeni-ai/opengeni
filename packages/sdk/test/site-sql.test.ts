import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_VERSION,
  OpenGeniSiteSqlError,
  createOpenGeniSiteClient,
  createSiteToolBridge,
  isSiteHttpRequest,
  serveSiteHttp,
} from "../src/site";

const SITE_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const VERSION_ID = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

type Seen = { path: string; method: string; body: unknown };

/** The console host (createSiteToolBridge) behind a MessagePort, as in site-data.test.ts. */
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
      const entry: Seen = { path, method: String(init.method), body: init.body };
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

describe("site.sql", () => {
  test("runs a named query on the host's pinned Site", async () => {
    const result = {
      columns: ["choice", "n"],
      rows: [{ choice: "blue", n: 3 }],
      truncated: false,
      rowsRead: 4,
      rowsWritten: 0,
    };
    const { client, seen, close } = host({
      advertise: true,
      respond: () => ({ status: 200, body: result }),
    });
    try {
      expect(await client.sql.run("top_votes", { limit: 5, open: true })).toEqual(result);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe("POST");
      expect(seen[0]!.path).toBe(
        `/v1/workspaces/ws-1/published-artifacts/${SITE_ID}/sql/queries/top_votes`,
      );
      expect(JSON.parse(String(seen[0]!.body))).toEqual({ params: { limit: 5, open: true } });
    } finally {
      close();
    }
  });

  test("decodes API errors and refuses viewer parameters before any request", async () => {
    const { client, seen, close } = host({
      advertise: true,
      respond: () => ({
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: "Site SQL is turned off for this Site",
            details: { code: "disabled" },
          },
        },
      }),
    });
    try {
      const error = await client.sql.run("top_votes").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenGeniSiteSqlError);
      expect(error).toMatchObject({ code: "disabled", status: 409 });
      const spoof = await client.sql
        .run("top_votes", { viewer: "user:someone-else" })
        .catch((caught: unknown) => caught);
      expect(spoof).toMatchObject({ code: "validation" });
      const badName = await client.sql.run("../x").catch((caught: unknown) => caught);
      expect(badName).toMatchObject({ code: "validation" });
      expect(seen).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("hosts without a published Site do not serve Site SQL", async () => {
    const { client, seen, close } = host({
      advertise: false,
      respond: () => ({ status: 200, body: {} }),
    });
    try {
      const error = await client.sql.run("top_votes").catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "site_sql_unsupported" });
      expect(seen).toHaveLength(0);
    } finally {
      close();
    }
  });
});
