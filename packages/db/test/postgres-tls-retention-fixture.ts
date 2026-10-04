import { createHash } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export const payload = "database TLS retention regression 🧪 café ".repeat(16_384);
export const payloadBytes = Buffer.byteLength(payload);
export const payloadDigest = createHash("sha256").update(payload).digest("hex");
export const rawQueueLimit = 64 * 1024;
export type Transport = "sslrequest" | "direct" | "plain";

export async function bounded<T>(
  operation: PromiseLike<T>,
  label: string,
  milliseconds = 3_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function message(kind: string, body: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0);
  header.writeInt32BE(body.byteLength + 4, 1);
  return Buffer.concat([header, body]);
}

const field = Buffer.alloc(18);
field.writeInt32BE(25, 6); // PostgreSQL text OID.
field.writeInt16BE(-1, 10);
field.writeInt32BE(-1, 12);
const rowDescription = message(
  "T",
  Buffer.concat([Buffer.from([0, 1]), Buffer.from("payload\0"), field]),
);
const value = Buffer.from(payload);
const rowHeader = Buffer.alloc(6);
rowHeader.writeInt16BE(1, 0);
rowHeader.writeInt32BE(value.length, 2);
const dataRow = message("D", Buffer.concat([rowHeader, value]));
const ready = message("Z", Buffer.from("I"));
const queryResult = Buffer.concat([
  rowDescription,
  dataRow,
  message("C", Buffer.from("SELECT 1\0")),
  ready,
]);

/** Real postgres-js talks to this minimal loopback PostgreSQL wire server. */
export async function startPostgresFixture(
  credentials: { key: Buffer; cert: Buffer },
  transport: Transport = "sslrequest",
  dropQuery = 0,
) {
  const secureContext = tls.createSecureContext(credentials);
  const peers = new Set<net.Socket>();
  const protocolErrors: string[] = [];
  let queryCount = 0;
  let connectionCount = 0;
  let sslRequests = 0;
  let tlsHandshakes = 0;
  let terminations = 0;

  function track(peer: net.Socket) {
    peers.add(peer);
    // A peer may legitimately fail during certificate rejection or an injected
    // transport loss. Protocol/parser errors are separately asserted below.
    peer.on("error", () => {});
    peer.once("close", () => peers.delete(peer));
  }

  function protocolError(peer: net.Socket, text: string) {
    protocolErrors.push(text);
    peer.destroy(new Error(text));
  }

  function serve(stream: net.Socket) {
    let pending = Buffer.alloc(0);
    let started = false;
    stream.on("data", (incoming: Buffer) => {
      pending = Buffer.concat([pending, incoming]);
      for (;;) {
        if (!started) {
          if (pending.length < 4) return;
          const length = pending.readInt32BE(0);
          if (length < 8 || length > 64 * 1024)
            return protocolError(stream, "Invalid startup length");
          if (pending.length < length) return;
          if (pending.readInt32BE(4) !== 196608)
            return protocolError(stream, "Expected protocol 3 startup");
          pending = pending.subarray(length);
          started = true;
          stream.write(Buffer.concat([message("R", Buffer.alloc(4)), ready]));
          continue;
        }
        if (pending.length < 5) return;
        const length = pending.readInt32BE(1) + 1;
        if (length < 5 || length > 64 * 1024) return protocolError(stream, "Invalid query length");
        if (pending.length < length) return;
        const kind = pending[0];
        pending = pending.subarray(length);
        if (kind === 81) {
          queryCount += 1;
          if (queryCount === dropQuery) {
            // Interrupt an incomplete DataRow, not just an idle connection, so
            // the driver's parser and queued query must both recover cleanly.
            stream.write(queryResult.subarray(0, 32 * 1024), () => stream.destroy());
          } else {
            stream.write(queryResult);
          }
        } else if (kind === 88) {
          terminations += 1;
          stream.end();
        } else {
          return protocolError(stream, `Unexpected PostgreSQL message ${kind}`);
        }
      }
    });
  }

  const server =
    transport === "direct"
      ? tls.createServer({ ...credentials, ALPNProtocols: ["postgresql"] }, (secure) => {
          tlsHandshakes += 1;
          if (secure.alpnProtocol !== "postgresql") {
            return protocolError(secure, "Expected PostgreSQL direct-TLS ALPN");
          }
          serve(secure);
        })
      : net.createServer((raw) => {
          if (transport === "plain") return serve(raw);
          let request = Buffer.alloc(0);
          const negotiate = (chunk: Buffer) => {
            request = Buffer.concat([request, chunk]);
            if (request.length < 8) return;
            if (
              request.length !== 8 ||
              request.readInt32BE(0) !== 8 ||
              request.readInt32BE(4) !== 80877103
            ) {
              return protocolError(raw, "Expected PostgreSQL SSLRequest");
            }
            sslRequests += 1;
            raw.removeListener("data", negotiate);
            raw.write("S");
            const secure = new tls.TLSSocket(raw, { isServer: true, secureContext });
            track(secure);
            secure.once("secure", () => {
              tlsHandshakes += 1;
            });
            serve(secure);
          };
          raw.on("data", negotiate);
        });
  server.on("connection", (raw) => {
    connectionCount += 1;
    track(raw);
  });
  if (server instanceof tls.Server) {
    server.on("secureConnection", track);
    server.on("tlsClientError", () => {});
  }
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    }),
    "fixture listen",
  );
  return {
    port: (server.address() as net.AddressInfo).port,
    transport,
    protocolErrors,
    get queryCount() {
      return queryCount;
    },
    get connectionCount() {
      return connectionCount;
    },
    get sslRequests() {
      return sslRequests;
    },
    get tlsHandshakes() {
      return tlsHandshakes;
    },
    get terminations() {
      return terminations;
    },
    get peerCount() {
      return peers.size;
    },
    async close() {
      // Close rejected handshakes before sql.end(): Bun can otherwise leave the
      // upgraded socket half-open even after emitting the certificate error.
      for (const peer of peers) peer.destroy();
      await bounded(
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        "fixture close",
      );
    },
  };
}
