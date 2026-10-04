import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type tls from "node:tls";
import postgres from "postgres";
import {
  bounded,
  payload,
  payloadBytes,
  payloadDigest,
  rawQueueLimit,
  startPostgresFixture,
  tick,
  type Transport,
} from "./postgres-tls-retention-fixture";

const require = createRequire(import.meta.url);
// Bun selects ESM even for require("postgres"); target the shipped CJS build.
// Optional local driver root makes an unpatched negative control reproducible
// without modifying the shared installed dependency or the parent's patch.
const driverRoot = process.env.OPENGENI_TEST_POSTGRES_DRIVER_ROOT;
const esmPath = driverRoot ? join(driverRoot, "src/index.js") : require.resolve("postgres");
const esmPostgres = driverRoot ? ((await import(esmPath)).default as typeof postgres) : postgres;
const cjsPath = join(dirname(esmPath), "../cjs/src/index.js");
const cjsPostgres = require(cjsPath) as typeof postgres;
let tlsDirectory: string;
let credentials: { key: Buffer; cert: Buffer };

beforeAll(async () => {
  tlsDirectory = await mkdtemp(join(tmpdir(), "opengeni-postgres-tls-retention-"));
  const keyPath = join(tlsDirectory, "key.pem");
  const certPath = join(tlsDirectory, "cert.pem");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (generated.exitCode !== 0) throw new Error("Could not generate test-only TLS certificate");
  credentials = { key: await readFile(keyPath), cert: await readFile(certPath) };
});

afterAll(async () => {
  if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
});

type Fixture = Awaited<ReturnType<typeof startPostgresFixture>>;

function connectDriver(
  driver: typeof postgres,
  fixture: Fixture,
  ssl: false | tls.ConnectionOptions = { rejectUnauthorized: false },
  customSocket = true,
) {
  const sockets: net.Socket[] = [];
  const base = {
    host: "127.0.0.1",
    port: fixture.port,
    user: "test",
    database: "test",
    max: 1,
    prepare: false,
    fetch_types: false,
    connect_timeout: 2,
    backoff: () => 0,
    max_lifetime: 0,
    idle_timeout: 0,
    ssl,
    sslnegotiation: fixture.transport === "direct" ? "direct" : undefined,
  };
  const options = customSocket
    ? {
        ...base,
        // This supported factory and sslnegotiation are missing from 3.4.9's types.
        socket: async () => {
          const raw = net.connect({ host: "127.0.0.1", port: fixture.port });
          sockets.push(raw);
          await bounded(
            new Promise<void>((resolve, reject) => {
              raw.once("error", reject);
              raw.once("connect", () => {
                raw.removeListener("error", reject);
                resolve();
              });
            }),
            "raw connect",
          );
          return raw;
        },
      }
    : base;
  const client = driver(options);
  return { client, sockets };
}

async function query(client: postgres.Sql) {
  return bounded(client.unsafe<{ payload: string }[]>("select fixture_payload").simple(), "query");
}

function assertResult(rows: Awaited<ReturnType<typeof query>>) {
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload.length).toBe(payload.length);
  expect(Buffer.byteLength(rows[0]!.payload)).toBe(payloadBytes);
  expect(createHash("sha256").update(rows[0]!.payload).digest("hex")).toBe(payloadDigest);
}

async function cleanup(fixture: Fixture, client: postgres.Sql, sockets: net.Socket[]) {
  try {
    await bounded(client.end({ timeout: 1 }), "driver cleanup");
    await tick();
    // Assert graceful driver cleanup before our fallback destroys any raw socket.
    expect(sockets.every((raw) => raw.destroyed)).toBe(true);
    expect(fixture.terminations).toBe(1);
  } finally {
    for (const raw of sockets) raw.destroy();
    await fixture.close();
  }
  expect(sockets.every((raw) => raw.destroyed)).toBe(true);
  expect(fixture.protocolErrors).toEqual([]);
}

describe("postgres-js real-driver TLS socket retention", () => {
  for (const [entrypoint, driver] of [
    ["ESM", esmPostgres],
    ["CommonJS", cjsPostgres],
  ] as const) {
    for (const transport of ["sslrequest", "direct"] as const) {
      test(`${entrypoint} ${transport} drains raw TCP without losing large UTF-8 results`, async () => {
        const fixture = await startPostgresFixture(credentials, transport);
        const { client, sockets } = connectDriver(driver, fixture);
        try {
          for (let round = 0; round < 12; round++) {
            assertResult(await query(client));
            await tick();
            expect(sockets[0]!.readableLength).toBeLessThanOrEqual(rawQueueLimit);
          }
          expect(sockets).toHaveLength(1);
          expect(fixture.queryCount).toBe(12);
          expect(fixture.sslRequests).toBe(transport === "sslrequest" ? 1 : 0);
          expect(fixture.tlsHandshakes).toBe(1);
        } finally {
          await cleanup(fixture, client, sockets);
        }
      }, 10_000);

      test(`${entrypoint} ${transport} rejects an untrusted certificate, not a timeout`, async () => {
        const fixture = await startPostgresFixture(credentials, transport);
        const { client, sockets } = connectDriver(
          driver,
          fixture,
          {
            rejectUnauthorized: true,
            servername: "localhost",
          },
          false,
        );
        try {
          // Require the certificate error code: neither CONNECT_TIMEOUT nor our
          // own deadline can masquerade as successful verification rejection.
          const rejection = await bounded(
            Promise.resolve(query(client)).then(
              () => null,
              (error: unknown) => error,
            ),
            "certificate verification",
          );
          expect(rejection).toBeInstanceOf(Error);
          expect((rejection as NodeJS.ErrnoException).code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
          expect(fixture.queryCount).toBe(0);
        } finally {
          // Specifically drain rejected handshake peers before asking Bun's
          // upgraded socket to end; normal successful paths use driver-first cleanup.
          await fixture.close();
          await bounded(client.end({ timeout: 1 }), "rejected certificate cleanup");
        }
        expect(sockets).toHaveLength(0);
        expect(fixture.protocolErrors).toEqual([]);
      }, 10_000);

      test(`${entrypoint} ${transport} verifies a trusted certificate with the default socket`, async () => {
        const fixture = await startPostgresFixture(credentials, transport);
        const { client, sockets } = connectDriver(
          driver,
          fixture,
          {
            rejectUnauthorized: true,
            ca: credentials.cert,
            servername: "localhost",
          },
          false,
        );
        try {
          assertResult(await query(client));
          expect(fixture.queryCount).toBe(1);
        } finally {
          await cleanup(fixture, client, sockets);
        }
      }, 10_000);

      test(`${entrypoint} ${transport} rejects interrupted rows and reconnects on a fresh raw socket`, async () => {
        const fixture = await startPostgresFixture(credentials, transport, 2);
        const { client, sockets } = connectDriver(driver, fixture);
        try {
          assertResult(await query(client));
          const rejection = await bounded(
            Promise.resolve(query(client)).then(
              () => null,
              (error: unknown) => error,
            ),
            "transport rejection",
          );
          expect(rejection).toBeInstanceOf(Error);
          expect((rejection as NodeJS.ErrnoException).code).toMatch(
            /^CONNECTION_(CLOSED|ENDED|RESET)$/,
          );
          assertResult(await query(client));
          await tick();
          expect(sockets).toHaveLength(2);
          expect(sockets[0]!.destroyed).toBe(true);
          expect(sockets[1]!.readableLength).toBeLessThanOrEqual(rawQueueLimit);
          expect(fixture.connectionCount).toBe(2);
          expect(fixture.queryCount).toBe(3);
        } finally {
          await cleanup(fixture, client, sockets);
        }
      }, 10_000);
    }

    test(`${entrypoint} keeps non-TLS transport intact`, async () => {
      const fixture = await startPostgresFixture(credentials, "plain");
      const { client, sockets } = connectDriver(driver, fixture, false);
      try {
        for (let round = 0; round < 3; round++) {
          assertResult(await query(client));
          await tick();
          expect(sockets[0]!.readableLength).toBeLessThanOrEqual(rawQueueLimit);
        }
        expect(fixture.sslRequests).toBe(0);
        expect(fixture.tlsHandshakes).toBe(0);
      } finally {
        await cleanup(fixture, client, sockets);
      }
    }, 10_000);

    test.skipIf(!Bun.which("node"))(
      `${entrypoint} stays compatible with Node's TLS transport`,
      async () => {
        for (const transport of [
          "sslrequest",
          "direct",
          "plain",
        ] as const satisfies readonly Transport[]) {
          const fixture = await startPostgresFixture(credentials, transport);
          const child = Bun.spawn(
            [
              Bun.which("node")!,
              join(import.meta.dir, "postgres-tls-retention.node.mjs"),
              entrypoint === "ESM" ? esmPath : cjsPath,
              String(fixture.port),
              transport,
              payloadDigest,
            ],
            { stdout: "pipe", stderr: "pipe", env: {} },
          );
          try {
            const code = await bounded(child.exited, `Node ${transport}`, 8_000);
            const output = await new Response(child.stdout).text();
            const errors = await new Response(child.stderr).text();
            expect(errors).toBe("");
            expect(code).toBe(0);
            expect(JSON.parse(output)).toEqual({
              queries: 3,
              queueLimit: rawQueueLimit,
              bun: false,
            });
            expect(fixture.queryCount).toBe(3);
            expect(fixture.protocolErrors).toEqual([]);
          } finally {
            if (child.exitCode === null) {
              child.kill();
              await bounded(child.exited, "Node kill");
            }
            await fixture.close();
          }
        }
      },
      30_000,
    );
  }
});
