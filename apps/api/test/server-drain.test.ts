import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import type { Server } from "bun";
import { Hono } from "hono";

import {
  apiHttpDrainDeadlineMs,
  apiRequestBindingsForServerDrain,
  createHttpServerDrain,
  liveStreamSignal,
  type HttpServerDrain,
} from "../src/http/server-drain";

// The production shape: a keep-alive Bun listener whose fetch and WebSocket
// handlers go through the drain, with the drain signal bound for live streams.
type Fixture = { server: Server<undefined>; drain: HttpServerDrain; origin: string };

const servers: Server<undefined>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

function serve(app: Hono): Fixture {
  const drain = createHttpServerDrain();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    fetch: drain.fetch((request: Request, bunServer: Server<undefined>) => {
      if (new URL(request.url).pathname === "/ws") {
        return bunServer.upgrade(request, { data: undefined })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(request, apiRequestBindingsForServerDrain(drain.signal));
    }),
    websocket: drain.websocket<undefined>({ message() {} }),
  });
  servers.push(server);
  return { server, drain, origin: `http://127.0.0.1:${server.port}` };
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return { release, entered, released, reached };
}

/** A raw HTTP/1.1 client socket, to see exactly what the server writes and when it closes. */
async function rawConnection(port: number) {
  const socket: Socket = connect(port, "127.0.0.1");
  let received = "";
  const errors: string[] = [];
  socket.on("data", (chunk) => (received += chunk.toString("latin1")));
  socket.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? error.message));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    send: (text: string) => socket.write(text),
    received: () => received,
    errors,
    closed,
    responses: () => received.split("HTTP/1.1 ").length - 1,
  };
}

async function until(predicate: () => boolean, label: string) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

describe("graceful HTTP drain", () => {
  test("a pooled keep-alive client mid-request during shutdown gets the response its request produced", async () => {
    const slow = gate();
    const app = new Hono();
    app.get("/fast", (c) => c.text("fast"));
    app.post("/usage/refresh", async (c) => {
      slow.entered();
      await slow.released;
      return c.json({ refreshed: true });
    });
    const { server, drain, origin } = serve(app);

    // Pool a connection, then send the next request on it, as a client still
    // holding a socket to a pod that has already left the Service endpoints.
    expect(await (await fetch(`${origin}/fast`)).text()).toBe("fast");
    const inFlight = fetch(`${origin}/usage/refresh`, { method: "POST", body: "{}" });
    await slow.reached;

    // SIGTERM arrives while that request is still running.
    const stopped = drain.stop(server, 5_000);
    await Bun.sleep(20);
    slow.release();

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toEqual({ refreshed: true });
    await stopped;
  });

  test("the response is written whole on the reused socket, which then closes cleanly", async () => {
    const slow = gate();
    const app = new Hono();
    app.get("/fast", (c) => c.text("fast"));
    app.post("/slow", async (c) => {
      slow.entered();
      await slow.released;
      return c.text("slow-done");
    });
    const { server, drain } = serve(app);
    const busy = await rawConnection(server.port!);
    const idle = await rawConnection(server.port!);
    busy.send("GET /fast HTTP/1.1\r\nHost: api\r\n\r\n");
    idle.send("GET /fast HTTP/1.1\r\nHost: api\r\n\r\n");
    await until(() => busy.responses() === 1 && idle.responses() === 1, "first responses");
    busy.send("POST /slow HTTP/1.1\r\nHost: api\r\nContent-Length: 0\r\n\r\n");
    await slow.reached;

    const stopped = drain.stop(server, 5_000);
    // Idle keep-alive sockets close at once; new connections are refused.
    await idle.closed;
    expect(idle.errors).toEqual([]);
    expect(
      await rawConnection(server.port!).then(
        () => "connected",
        (e) => e.code,
      ),
    ).toBe("ECONNREFUSED");

    slow.release();
    await busy.closed;
    await stopped;
    expect(busy.errors).toEqual([]);
    const second = busy.received().slice(busy.received().lastIndexOf("HTTP/1.1 "));
    expect(second).toStartWith("HTTP/1.1 200");
    expect(second.toLowerCase()).toContain("\r\nconnection: close\r\n");
    expect(second).toEndWith("\r\n\r\nslow-done");
  });

  test("live event streams end and WebSockets go away when the drain begins", async () => {
    const app = new Hono();
    app.get("/events", (c) => {
      const signal = liveStreamSignal(c);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": open\n\n"));
          signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const { server, drain, origin } = serve(app);
    const events = await fetch(`${origin}/events`);
    const socket = new WebSocket(`${origin.replace("http", "ws")}/ws`);
    await new Promise((resolve) => (socket.onopen = resolve));
    const goneAway = new Promise<number>((resolve) => (socket.onclose = (e) => resolve(e.code)));

    const started = Date.now();
    await drain.stop(server, 10_000);
    // Neither held the drain open until its deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await events.text()).toBe(": open\n\n");
    expect(await goneAway).toBe(1001);
  });

  test("a request still running at the deadline is closed then", async () => {
    const app = new Hono();
    app.get("/forever", () => new Promise<Response>(() => {}));
    const { server, drain, origin } = serve(app);
    const stuck = fetch(`${origin}/forever`).then(
      () => "answered",
      () => "closed",
    );
    await Bun.sleep(20);
    const started = Date.now();
    await drain.stop(server, 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(await stuck).toBe("closed");
  });

  test("responses with immutable headers are still marked as the connection's last", async () => {
    const drain = createHttpServerDrain();
    const upstream = new Response("proxied", { status: 202, headers: { "x-upstream": "1" } });
    Object.defineProperty(upstream.headers, "set", {
      value: () => {
        throw new TypeError("immutable");
      },
    });
    const handler = drain.fetch(async () => upstream);
    const before = await handler(new Request("http://api/"));
    expect(before?.headers.get("connection")).toBeNull();
    drain.begin();
    const after = (await handler(new Request("http://api/")))!;
    expect(after.status).toBe(202);
    expect(after.headers.get("connection")).toBe("close");
    expect(after.headers.get("x-upstream")).toBe("1");
    expect(await after.text()).toBe("proxied");
  });

  test("without a standalone server a live stream follows only its client", async () => {
    const app = new Hono();
    let same = false;
    app.get("/", (c) => {
      same = liveStreamSignal(c) === c.req.raw.signal;
      return c.text("ok");
    });
    await app.request("http://api/");
    expect(same).toBe(true);
  });

  test("the drain deadline leaves the exit margin inside the shutdown grace", () => {
    // Chart defaults: 30 s pod grace less the 10 s preStop sleep.
    expect(apiHttpDrainDeadlineMs(20_000)).toBe(10_000);
    expect(apiHttpDrainDeadlineMs(30_000)).toBe(20_000);
    expect(apiHttpDrainDeadlineMs(5_000)).toBe(0);
  });

  test("the standalone API stops its listeners only through the drain", async () => {
    // The ECONNRESET came from close() calling server.stop(true) at SIGTERM.
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).not.toMatch(/\b(server|metricsServer\??)\.stop\(/u);
    expect(source).toContain("httpDrain.stop(server, httpDrainDeadline)");
    expect(source).toContain("httpDrain.stop(metricsServer, httpDrainDeadline)");
    expect(source).toContain("timeoutMs: settings.apiShutdownGraceMs");
  });
});
