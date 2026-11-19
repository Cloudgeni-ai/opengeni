import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SiteLive,
  verifySiteLiveTicket,
  visibleCollections,
  type LiveSocket,
  type SiteLiveState,
} from "../src/site-live";
import { flushTimings, recordTiming, timingOp } from "../src/timing";
import { TEST_SECRET, verifyGatewaySignature } from "./helpers";

const SITE = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** A ticket as the API makes it (apps/api/src/site-live/service.ts). */
function apiTicket(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(`OGLIVE1\n${body}`).digest("base64url");
  return `v1.${body}.${mac}`;
}

describe("console live tickets", () => {
  const now = 1_800_000_000;
  const payload = { s: SITE, c: ["todos"], q: 4, e: now + 60, t: 900 };

  test("verify with the current or previous secret", async () => {
    const ticket = apiTicket(TEST_SECRET, payload);
    expect(await verifySiteLiveTicket([TEST_SECRET], ticket, now)).toEqual({
      siteId: SITE,
      seq: 4,
      collections: ["todos"],
      ttlSeconds: 900,
    });
    expect(await verifySiteLiveTicket(["other", TEST_SECRET], ticket, now)).not.toBeNull();
  });

  test("refuse a wrong secret, a changed payload, an expired ticket or a bad Site id", async () => {
    const ticket = apiTicket(TEST_SECRET, payload);
    expect(await verifySiteLiveTicket(["other"], ticket, now)).toBeNull();
    const [, , mac] = ticket.split(".");
    const forged = `v1.${Buffer.from(JSON.stringify({ ...payload, c: null })).toString("base64url")}.${mac}`;
    expect(await verifySiteLiveTicket([TEST_SECRET], forged, now)).toBeNull();
    expect(await verifySiteLiveTicket([TEST_SECRET], ticket, now + 61)).toBeNull();
    expect(
      await verifySiteLiveTicket(
        [TEST_SECRET],
        apiTicket(TEST_SECRET, { ...payload, s: "x" }),
        now,
      ),
    ).toBeNull();
    expect(await verifySiteLiveTicket([TEST_SECRET], "", now)).toBeNull();
  });
});

describe("the SiteLive object", () => {
  class FakeSocket implements LiveSocket {
    sent: unknown[] = [];
    closed: number | null = null;
    private value: unknown = null;
    send(message: string) {
      this.sent.push(JSON.parse(message));
    }
    close(code?: number) {
      this.closed = code ?? 1000;
    }
    serializeAttachment(value: unknown) {
      this.value = structuredClone(value);
    }
    deserializeAttachment() {
      return this.value;
    }
  }
  const globals = globalThis as { WebSocketPair?: unknown };
  const original = globals.WebSocketPair;
  let sockets: FakeSocket[] = [];
  let live: SiteLive;
  const RealResponse = globalThis.Response;

  beforeEach(() => {
    sockets = [];
    globals.WebSocketPair = class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    };
    // Bun's Response refuses status 101; the runtime's accepts it with a socket.
    globalThis.Response = class extends RealResponse {
      constructor(body: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      }
    } as typeof Response;
    const state: SiteLiveState = {
      acceptWebSocket: (socket) => void sockets.push(socket as FakeSocket),
      getWebSockets: () => sockets.filter((socket) => socket.closed === null),
    };
    live = new SiteLive(state, {});
  });
  afterEach(() => {
    globals.WebSocketPair = original;
    globalThis.Response = RealResponse;
  });

  const connect = (collections: string[] | null, ttlSeconds = 900) =>
    live.fetch(
      new Request("https://site-live.internal/connect", {
        headers: {
          upgrade: "websocket",
          "x-og-live-admitted": JSON.stringify({ siteId: SITE, seq: 2, collections, ttlSeconds }),
        },
      }),
    );
  const notify = async (notice: unknown) =>
    (await (
      await live.fetch(
        new Request("https://site-live.internal/notify", {
          method: "POST",
          body: JSON.stringify(notice),
        }),
      )
    ).json()) as { delivered: number };

  test("greets, then passes on only the collections each connection may read", async () => {
    await connect(["todos"]);
    await connect(null);
    const [reader, manager] = sockets;
    expect(reader!.sent).toEqual([
      { type: "hello", seq: 2, collections: ["todos"], ttlSeconds: 900 },
    ]);
    expect(await notify({ type: "data", seq: 3, collections: ["secrets"] })).toEqual({
      delivered: 1,
    });
    expect(await notify({ type: "data", seq: 4, collections: ["todos", "secrets"] })).toEqual({
      delivered: 2,
    });
    expect(reader!.sent.slice(1)).toEqual([{ type: "data", seq: 4, collections: ["todos"] }]);
    expect(manager!.sent.slice(1)).toEqual([
      { type: "data", seq: 3, collections: ["secrets"] },
      { type: "data", seq: 4, collections: ["todos", "secrets"] },
    ]);
    expect(await notify({ type: "version", versionId: "v2" })).toEqual({ delivered: 2 });
  });

  test("closes a connection whose admission ran out instead of telling it", async () => {
    await connect(null, 0);
    expect(await notify({ type: "version", versionId: null })).toEqual({ delivered: 0 });
    expect(sockets[0]!.closed).toBe(4001);
  });

  test("a connection admitted before a change it missed hears that something changed", async () => {
    await connect(null);
    await notify({ type: "data", seq: 5, collections: ["todos"] });
    // Admitted at change 2, connected after change 5 was passed on.
    await connect(["todos"]);
    expect(sockets[1]!.sent).toEqual([
      { type: "hello", seq: 2, collections: ["todos"], ttlSeconds: 900 },
      { type: "data", seq: 5, collections: null },
    ]);
  });

  test("expired connections give their place up when a new one arrives", async () => {
    await connect(null, 0);
    await connect(null);
    expect(sockets[0]!.closed).toBe(4001);
    expect(sockets[1]!.closed).toBeNull();
  });

  test("refuses an invalid notice", async () => {
    const response = await live.fetch(
      new Request("https://site-live.internal/notify", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(422);
  });

  test("visibleCollections intersects, and null reads everything", () => {
    expect(visibleCollections(["a", "b"], ["b"])).toEqual(["b"]);
    expect(visibleCollections(["a"], ["b"])).toBeNull();
    expect(visibleCollections(["a"], null)).toEqual(["a"]);
  });
});

describe("speed samples", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("labels stay in closed sets", () => {
    expect(timingOp("bridge", "data.read")).toBe("data.read");
    expect(timingOp("bridge", "call")).toBe("tools.call");
    expect(timingOp("bridge", "https://evil.example/x")).toBe("other");
    expect(timingOp("app_load", "anything")).toBe("page");
  });

  test("are reported in one signed batch per series", async () => {
    const config = {
      apiOrigin: "https://api.test",
      secret: TEST_SECRET,
      sitesDomain: "sites.test",
      platformReportIntervalMs: 60_000,
    };
    const sent: { body: unknown; verified: boolean; url: string }[] = [];
    globalThis.fetch = (async (input: Request) => {
      const body = new Uint8Array(await input.arrayBuffer());
      sent.push({
        url: input.url,
        body: JSON.parse(new TextDecoder().decode(body)),
        verified: verifyGatewaySignature(TEST_SECRET, input, body),
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const ctx = { waitUntil: () => undefined };
    for (let i = 0; i < 150; i++) recordTiming(config, ctx, "bridge", "data.read", "ok", 20);
    recordTiming(config, ctx, "bridge", "sql.run", "error", 2_000);
    await flushTimings(config);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.verified).toBe(true);
    expect(sent[0]!.url).toEndWith("/v1/site-runtime/platform/timings");
    const report = sent[0]!.body as {
      series: { kind: string; op: string; outcome: string; samples: number[] }[];
    };
    const read = report.series.find((series) => series.op === "data.read")!;
    expect(read.samples).toHaveLength(100);
    expect(read.samples.every((value) => value === 0.02)).toBe(true);
    expect(report.series.find((series) => series.op === "sql.run")).toMatchObject({
      outcome: "error",
      samples: [2],
    });
  });
});
