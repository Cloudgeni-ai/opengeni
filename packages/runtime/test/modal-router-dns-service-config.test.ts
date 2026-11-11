import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  Client,
  Server,
  ServerCredentials,
  credentials,
  status,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { Sandbox } from "modal";
import {
  MODAL_ROUTER_CHANNEL_DNS_OPTIONS,
  ModalCommandRouterWire,
  modalRouterWire,
} from "../src/sandbox/providers/modal-command-router-wire";

// Modal's authoritative DNS answers a TXT query for a task router name with
// NXDOMAIN instead of NODATA. A caching resolver then denies the whole name,
// so the next address lookup for the same box fails for seconds. This fake
// resolver models exactly that: one TXT query poisons the name.
const dns = createRequire(import.meta.url)("node:dns") as typeof import("node:dns");
const originalLookup = dns.promises.lookup;
const originalResolveTxt = dns.promises.resolveTxt;
const routerHosts = new Set<string>();
const poisoned = new Set<string>();
const txtQueries: string[] = [];
const notFound = (hostname: string) =>
  Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: "ENOTFOUND",
    hostname,
  });

const service = "modal.task_command_router.TaskCommandRouter";
const startDefinition = {
  path: `/${service}/TaskExecStart`,
  requestStream: false,
  responseStream: false,
  requestSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType("Start").encode(value).finish()),
  requestDeserialize: (bytes: Buffer) => modalRouterWire.lookupType("Start").decode(bytes),
  responseSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType("Empty").encode(value).finish()),
  responseDeserialize: (bytes: Buffer) => modalRouterWire.lookupType("Empty").decode(bytes),
};

let directory: string;
let certificate: Buffer;
let tlsServer: Server;
let tlsPort: number;
let sdkServer: Server;
let sdkPort: number;
let sdkStarts = 0;

async function serve(server: Server, serverCredentials: ServerCredentials): Promise<number> {
  return await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", serverCredentials, (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
}

beforeAll(async () => {
  (dns.promises as { lookup: unknown }).lookup = async (hostname: string, options?: unknown) => {
    if (!routerHosts.has(hostname))
      return await (originalLookup as (...args: unknown[]) => Promise<unknown>)(hostname, options);
    if (poisoned.has(hostname)) throw notFound(hostname);
    return [{ address: "127.0.0.1", family: 4 }];
  };
  (dns.promises as { resolveTxt: unknown }).resolveTxt = async (hostname: string) => {
    if (!routerHosts.has(hostname)) return await originalResolveTxt(hostname);
    txtQueries.push(hostname);
    poisoned.add(hostname);
    throw notFound(hostname);
  };

  directory = mkdtempSync(join(tmpdir(), "opengeni-modal-router-dns-"));
  const keyPath = join(directory, "server.key"),
    certPath = join(directory, "server.pem");
  const result = spawnSync(
    "openssl",
    [
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
      "/CN=task-router.w.modal.host",
      "-addext",
      "subjectAltName=DNS:*.w.modal.host",
    ],
    { stdio: "pipe" },
  );
  if (result.status !== 0) throw new Error("Test TLS certificate generation failed");
  certificate = readFileSync(certPath);

  tlsServer = new Server();
  tlsServer.addService({ start: startDefinition } as ServiceDefinition, {
    start(_call: unknown, callback: (error: null, value: object) => void) {
      callback(null, {});
    },
  });
  tlsPort = await serve(
    tlsServer,
    ServerCredentials.createSsl(null, [
      { private_key: readFileSync(keyPath), cert_chain: certificate },
    ]),
  );

  sdkServer = new Server();
  sdkServer.addService({ start: startDefinition } as ServiceDefinition, {
    start(_call: unknown, callback: (error: object) => void) {
      sdkStarts++;
      // Any post-dispatch answer proves the SDK channel resolved the name.
      callback({ code: status.NOT_FOUND, details: "test router" });
    },
  });
  sdkPort = await serve(sdkServer, ServerCredentials.createInsecure());
});

afterAll(() => {
  (dns.promises as { lookup: unknown }).lookup = originalLookup;
  (dns.promises as { resolveTxt: unknown }).resolveTxt = originalResolveTxt;
  tlsServer?.forceShutdown();
  sdkServer?.forceShutdown();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function routerHost(name: string): string {
  const host = `task-${name}.w.modal.host`;
  routerHosts.add(host);
  return host;
}

test("the fake resolver reproduces the poisoning a default gRPC channel causes", async () => {
  const host = routerHost("default-channel");
  const raw = new Client(`${host}:${tlsPort}`, credentials.createSsl(certificate));
  try {
    await new Promise<void>((resolve, reject) =>
      raw.waitForReady(Date.now() + 5_000, (error) => (error ? reject(error) : resolve())),
    );
  } finally {
    raw.close();
  }
  expect(txtQueries).toContain(host);
  await expect(dns.promises.lookup(host, { all: true })).rejects.toMatchObject({
    code: "ENOTFOUND",
  });
});

test("router channels never send the service-config TXT query", () => {
  expect(MODAL_ROUTER_CHANNEL_DNS_OPTIONS).toEqual({
    "grpc.service_config_disable_resolution": 1,
  });
  expect(Object.isFrozen(MODAL_ROUTER_CHANNEL_DNS_OPTIONS)).toBe(true);
});

test("a fresh box's readiness probe leaves the router name resolvable for the first SDK command", async () => {
  const host = routerHost("fresh-box");
  const url = `https://${host}`;

  // The native readiness probe opens the first router channel of the box.
  const wire = new ModalCommandRouterWire(
    { url: `${url}:${tlsPort}`, jwt: "test-token" },
    certificate,
  );
  try {
    const prepared = await wire.prepareStart({
      taskId: "task-fresh-box",
      execId: "readiness",
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      env: {},
    });
    await wire.dispatchPreparedStart(prepared);
  } finally {
    wire.close();
  }
  expect(txtQueries.filter((query) => query === host)).toEqual([]);

  // The SDK's first command then opens a second channel to the same name. With
  // a poisoned name it would wait out its whole readiness budget and fail
  // before dispatch instead of reaching the router.
  const cjs = createRequire(import.meta.url)("modal") as { Sandbox: typeof Sandbox };
  for (const SandboxClass of [Sandbox, cjs.Sandbox]) {
    const sdk = new SandboxClass(
      {
        profile: { serverUrl: "http://localhost" },
        logger: { debug: () => {}, warn: () => {} },
        cpClient: {
          taskGetCommandRouterAccess: async () => ({
            url: `${url}:${sdkPort}`,
            jwt: "test-token",
          }),
        },
      } as never,
      "sb-fresh-box",
      { taskId: "task-fresh-box" },
    );
    const before = sdkStarts;
    const startedAt = performance.now();
    try {
      await sdk.exec(["true"]).catch(() => undefined);
    } finally {
      sdk.detach();
    }
    expect(sdkStarts - before).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  }
  expect(txtQueries.filter((query) => query === host)).toEqual([]);
  expect(poisoned.has(host)).toBe(false);
}, 20_000);
