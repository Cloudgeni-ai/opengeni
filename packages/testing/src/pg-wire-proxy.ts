import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * A loopback TCP proxy in front of PostgreSQL for tests that count what a code
 * path sends to the database, or that add a fixed delay to every message the
 * client sends (a stand-in for network latency between an application and its
 * database).
 *
 * It reads only frontend message framing. A round trip is one `Sync` (the end
 * of an extended-protocol batch) or one simple `Query`; a statement is one
 * `Execute` or simple `Query`. Statement texts are kept only while `trace` is
 * on, so ordinary counting holds no SQL.
 */
export type PgWireCounts = { roundTrips: number; statements: number };

export type PgWireProxy = {
  /** `databaseUrl` with its host and port replaced by this proxy. */
  url: string;
  /** Totals since the last `reset`. */
  counts(): PgWireCounts;
  /** Statement texts since the last `reset`, in order (only while tracing). */
  statements(): string[];
  reset(): void;
  setDelayMs(delayMs: number): void;
  setTrace(trace: boolean): void;
  close(): Promise<void>;
};

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;

export async function startPgWireProxy(
  databaseUrl: string,
  options: { delayMs?: number; trace?: boolean } = {},
): Promise<PgWireProxy> {
  const target = new URL(databaseUrl);
  const targetHost = target.hostname;
  const targetPort = Number(target.port || 5432);
  let delayMs = options.delayMs ?? 0;
  let trace = options.trace ?? false;
  let counts: PgWireCounts = { roundTrips: 0, statements: 0 };
  let texts: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    sockets.add(client);
    const upstream = createConnection({ host: targetHost, port: targetPort });
    sockets.add(upstream);
    let buffered = Buffer.alloc(0);
    let started = false;
    const prepared = new Map<string, string>();
    // Messages leave in order: each chunk waits for the one before it.
    let sendChain = Promise.resolve();
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    const observe = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (!started) {
          if (buffered.length < 8) return;
          const length = buffered.readInt32BE(0);
          if (buffered.length < length) return;
          const code = buffered.readInt32BE(4);
          buffered = buffered.subarray(length);
          if (code !== SSL_REQUEST_CODE && code !== GSSENC_REQUEST_CODE) started = true;
          continue;
        }
        if (buffered.length < 5) return;
        const type = String.fromCharCode(buffered[0]!);
        const length = buffered.readInt32BE(1);
        if (buffered.length < length + 1) return;
        const body = buffered.subarray(5, length + 1);
        buffered = buffered.subarray(length + 1);
        if (type === "S") counts.roundTrips += 1;
        if (type === "Q") {
          counts.roundTrips += 1;
          counts.statements += 1;
          if (trace) texts.push(body.toString("utf8", 0, Math.max(0, body.length - 1)));
        }
        if (type === "E") counts.statements += 1;
        if (trace && type === "P") {
          const nameEnd = body.indexOf(0);
          const queryEnd = body.indexOf(0, nameEnd + 1);
          const name = body.toString("utf8", 0, nameEnd);
          const text = body.toString("utf8", nameEnd + 1, queryEnd);
          prepared.set(name, text);
        }
        if (trace && type === "B") {
          const portalEnd = body.indexOf(0);
          const statementEnd = body.indexOf(0, portalEnd + 1);
          const name = body.toString("utf8", portalEnd + 1, statementEnd);
          texts.push(prepared.get(name) ?? `<prepared ${name}>`);
        }
      }
    };
    client.on("data", (chunk: Buffer) => {
      observe(chunk);
      const wait = delayMs;
      sendChain = sendChain.then(async () => {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (!upstream.destroyed) upstream.write(chunk);
      });
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!client.destroyed) client.write(chunk);
    });
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    counts: () => ({ ...counts }),
    statements: () => [...texts],
    reset: () => {
      counts = { roundTrips: 0, statements: 0 };
      texts = [];
    },
    setDelayMs: (value) => {
      delayMs = value;
    },
    setTrace: (value) => {
      trace = value;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
