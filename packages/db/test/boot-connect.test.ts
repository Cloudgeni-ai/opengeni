import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createBootGraceDatabaseSocket,
  createDb,
  databaseBootConnectOptions,
  type DatabaseConnectEndpoint,
} from "../src";

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
}

function fakeClock() {
  let current = 0;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    sleeps,
  };
}

const target = { host: ["db.internal"], port: [5432], path: false as const, connect_timeout: 30 };

describe("database boot connect grace", () => {
  test("retries a refused first connection until the server accepts it", async () => {
    const clock = fakeClock();
    const seen: DatabaseConnectEndpoint[] = [];
    let failures = 2;
    const socket = new net.Socket();
    const factory = createBootGraceDatabaseSocket({
      now: clock.now,
      sleep: clock.sleep,
      connect: async (endpoint, timeoutMs) => {
        seen.push(endpoint);
        expect(timeoutMs).toBe(30_000);
        if (failures-- > 0) throw refused();
        return socket;
      },
    });
    const connected = await factory(target);
    expect(connected).toBe(socket);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ kind: "tcp", host: "db.internal", port: 5432 });
    expect(clock.sleeps).toHaveLength(2);
    // postgres.js uses these for TLS SNI.
    expect((connected as unknown as { host: string }).host).toBe("db.internal");
    expect((connected as unknown as { port: number }).port).toBe(5432);
    socket.destroy();
  });

  test("after reaching the server once, connections take postgres.js's own path", async () => {
    const clock = fakeClock();
    let calls = 0;
    const opened: DatabaseConnectEndpoint[] = [];
    const pending = new net.Socket();
    const factory = createBootGraceDatabaseSocket({
      now: clock.now,
      sleep: clock.sleep,
      connect: async () => {
        calls += 1;
        if (calls === 1) return new net.Socket();
        throw refused();
      },
      open: (endpoint) => {
        opened.push(endpoint);
        return pending;
      },
    });
    (await factory(target)).destroy();
    // A later connection is handed back still connecting, so a refusal reaches
    // postgres.js as a socket error it recovers from, never as a rejection.
    expect(await factory(target)).toBe(pending);
    expect(calls).toBe(1);
    expect(opened).toEqual([{ kind: "tcp", host: "db.internal", port: 5432 }]);
    expect((pending as unknown as { host: string }).host).toBe("db.internal");
    expect(clock.sleeps).toEqual([]);
    pending.destroy();
  });

  test("other connect errors and an expired window are not retried, and never reject", async () => {
    const clock = fakeClock();
    let openedNotFound = 0;
    const notFound = createBootGraceDatabaseSocket({
      now: clock.now,
      sleep: clock.sleep,
      connect: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND db"), { code: "ENOTFOUND" });
      },
      open: () => {
        openedNotFound += 1;
        return new net.Socket();
      },
    });
    (await notFound(target)).destroy();
    expect(openedNotFound).toBe(1);
    expect(clock.sleeps).toEqual([]);

    const late = fakeClock();
    let calls = 0;
    let openedLate = 0;
    const expired = createBootGraceDatabaseSocket({
      graceMs: 1_000,
      now: late.now,
      sleep: late.sleep,
      connect: async () => {
        calls += 1;
        throw refused();
      },
      open: () => {
        openedLate += 1;
        return new net.Socket();
      },
    });
    (await expired(target)).destroy();
    // Sleeps never overshoot the window, and the last attempt happens at its
    // end through postgres.js's own path.
    expect(late.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(1_000);
    expect(calls).toBe(late.sleeps.length);
    expect(openedLate).toBe(1);
  });

  test("a multi-host URL keeps postgres.js host failover", () => {
    expect(databaseBootConnectOptions("postgres://u:p@a:5432,b:5432/db").socket).toBeUndefined();
    expect(databaseBootConnectOptions("postgres://u:p@a:5432/db").socket).toBeFunction();
    expect(databaseBootConnectOptions("postgres://u:p@a:5432/db", 0).socket).toBeUndefined();
  });
});

describe("database boot connect grace against real Postgres", () => {
  let database: SharedTestDatabase | null = null;

  beforeAll(async () => {
    database = await acquireSharedTestDatabase("boot-connect");
  }, 180_000);

  afterAll(async () => {
    await database?.release();
  });

  async function unusedPort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  /** A TCP forwarder to the real database that starts listening after `delayMs`. */
  function lateForwarder(port: number, upstream: URL, delayMs: number) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const backend = net.connect(Number(upstream.port || 5432), upstream.hostname);
      sockets.add(client).add(backend);
      client.pipe(backend).pipe(client);
      client.on("error", () => backend.destroy());
      backend.on("error", () => client.destroy());
    });
    const listening = new Promise<void>((resolve) =>
      setTimeout(() => server.listen(port, "127.0.0.1", resolve), delayMs),
    );
    return {
      listening,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
  }

  /** A TCP forwarder to the real database that can go down and come back on the same port. */
  function restartableForwarder(port: number, upstream: URL) {
    const sockets = new Set<net.Socket>();
    let server: net.Server | null = null;
    return {
      start: async () => {
        server = net.createServer((client) => {
          const backend = net.connect(Number(upstream.port || 5432), upstream.hostname);
          sockets.add(client).add(backend);
          client.pipe(backend).pipe(client);
          client.on("error", () => backend.destroy());
          backend.on("error", () => client.destroy());
        });
        await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
      },
      /** Drops every open connection and refuses new ones, like a stopped database. */
      stop: async () => {
        const closing = server;
        server = null;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
      },
    };
  }

  async function settleWithin<T>(promise: PromiseLike<T>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    });
    try {
      return await Promise.race([
        Promise.resolve(promise).then(
          (value) => ({ kind: "ok" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  test("a running client recovers on its own after the database restarts", async () => {
    if (!database) return;
    const upstream = new URL(database.appUrl);
    const port = await unusedPort();
    const url = new URL(upstream);
    url.hostname = "127.0.0.1";
    url.port = String(port);
    const forwarder = restartableForwarder(port, upstream);
    await forwarder.start();
    const max = 3;
    const client = createDb(url.toString(), { max });
    try {
      await client.db.execute("select 1");

      // The database goes away: open connections drop and new ones are refused.
      await forwarder.stop();
      // More failed queries than the pool has connections, so every pooled
      // connection tries, and fails, to reconnect while the server is down.
      for (let attempt = 0; attempt < max * 3; attempt += 1) {
        const outcome = await settleWithin(client.db.execute("select 1"), 5_000);
        expect(outcome.kind).toBe("error");
      }

      // The database is back. The same client must serve queries again
      // without a process restart.
      await forwarder.start();
      const recovered = await settleWithin(client.db.execute("select 1 as ok"), 10_000);
      expect(recovered.kind).toBe("ok");
    } finally {
      await forwarder.stop();
      await settleWithin(client.close(), 5_000);
    }
  }, 60_000);

  test("a client created while the database is still refusing connects once it accepts", async () => {
    if (!database) return;
    const upstream = new URL(database.appUrl);

    // Control: without the grace, the first query of a fresh process fails.
    const controlPort = await unusedPort();
    const controlUrl = new URL(upstream);
    controlUrl.hostname = "127.0.0.1";
    controlUrl.port = String(controlPort);
    const plain = postgres(controlUrl.toString(), { max: 1 });
    // postgres.js queries run when awaited; settle it explicitly.
    const controlFailure = await plain`select 1`.then(
      () => null,
      (error: unknown) => error,
    );
    expect(controlFailure).toMatchObject({ code: "ECONNREFUSED" });
    await plain.end();

    const port = await unusedPort();
    const url = new URL(controlUrl);
    url.port = String(port);
    const forwarder = lateForwarder(port, upstream, 400);
    const startedAt = performance.now();
    const client = createDb(url.toString(), { max: 1 });
    try {
      const rows = await client.db.execute("select 1 as ok");
      expect(Array.from(rows as Iterable<{ ok: number }>)[0]?.ok).toBe(1);
      // It waited for the listener rather than succeeding by accident.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(350);
    } finally {
      await client.close();
      await forwarder.listening;
      await forwarder.close();
    }
  }, 60_000);
});
