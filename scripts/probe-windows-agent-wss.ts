import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  parseAgentConnectionName,
  workspaceAgentPermissions,
} from "../packages/events/src/nats-jwt";

const { connect, nkeys } = createRequire(
  new URL("../packages/events/package.json", import.meta.url),
)("nats") as typeof import("nats");

const binary = resolve(process.env.PROBE_AGENT_EXE!);
const root = await mkdtemp(join(tmpdir(), "agent-wss-probe-"));
const config = join(root, "agent");
const ca = join(root, "ca.pem");
const caKey = join(root, "ca.key");
const csr = join(root, "server.csr");
const cert = join(root, "server.pem");
const key = join(root, "server.key");
const extensions = join(root, "server.ext");
const brokerConfig = join(root, "nats.conf");
const workspaceId = crypto.randomUUID();
const agentId = crypto.randomUUID();
const bearer = `oge_${crypto.randomUUID()}`;
const enrollmentToken = crypto.randomUUID();
const account = nkeys.createAccount();
const accountSeed = Buffer.from(account.getSeed()).toString("utf8");
const platform = process.platform;
const gitWindows = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
const ssl = (await Bun.file(gitWindows).exists()) ? gitWindows : "openssl";

async function run(command: string[], env?: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${command[0]}: ${err}`);
  return out.trim();
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

let broker: ReturnType<typeof Bun.spawn> | undefined;
let agent: ReturnType<typeof Bun.spawn> | undefined;
let api: ReturnType<typeof Bun.serve> | undefined;
let nats: Awaited<ReturnType<typeof connect>> | undefined;
let thumbprint: string | undefined;
try {
  console.log(await run([binary, "--version"]));
  if (platform === "win32") {
    const pe = new DataView(await Bun.file(binary).slice(0, 4096).arrayBuffer());
    assert.equal(pe.getUint32(pe.getUint32(0x3c, true), true), 0x4550);
    assert.equal(
      pe.getUint16(pe.getUint32(0x3c, true) + 4, true),
      process.arch === "arm64" ? 0xaa64 : 0x8664,
    );
    assert.equal(
      process.env.PROCESSOR_ARCHITECTURE?.toLowerCase(),
      process.arch === "arm64" ? "arm64" : "amd64",
    );
  }
  await run([
    ssl,
    "req",
    "-new",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Agent WSS probe CA",
    "-keyout",
    caKey,
    "-out",
    ca,
  ]);
  await run([
    ssl,
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
    "-keyout",
    key,
    "-out",
    csr,
  ]);
  await Bun.write(extensions, "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  await run([
    ssl,
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    extensions,
    "-out",
    cert,
  ]);
  const agentEnv = {
    ...process.env,
    OPENGENI_CONFIG_DIR: config,
    OPENGENI_ENROLL_TOKEN: enrollmentToken,
    RUST_LOG:
      "info,async_nats::connector=debug,rustls::client=debug,opengeni_agent::supervisor=debug",
    ...(platform === "win32" ? {} : { SSL_CERT_FILE: ca }),
  };
  if (platform === "win32") {
    const der = join(root, "ca.cer");
    await run([ssl, "x509", "-in", ca, "-outform", "DER", "-out", der]);
    thumbprint = await run(
      [
        "pwsh",
        "-NoProfile",
        "-Command",
        "(Import-Certificate -FilePath $env:PROBE_CA -CertStoreLocation Cert:\\CurrentUser\\Root).Thumbprint",
      ],
      { ...process.env, PROBE_CA: der },
    );
    assert.match(thumbprint, /^[A-F0-9]{40}$/i);
  }
  const tcpPort = freePort();
  const wsPort = freePort();
  const natsUrl = `wss://127.0.0.1:${wsPort}`;
  // Forward slashes keep Windows file paths independent of config escapes.
  const quotedPath = (path: string) => JSON.stringify(path.replaceAll("\\", "/"));
  await Bun.write(
    brokerConfig,
    `
listen: "127.0.0.1:${tcpPort}"
websocket {
  listen: "127.0.0.1:${wsPort}"
  tls {
    cert_file: ${quotedPath(cert)}
    key_file: ${quotedPath(key)}
  }
}
accounts {
  APP: { users: [{ user: control, password: loopback }] }
  SYS: {}
}
system_account: SYS
authorization {
  auth_callout {
    issuer: ${account.getPublicKey()}
    auth_users: [control]
    account: APP
  }
}
`,
  );
  broker = Bun.spawn(["nats-server", "-c", brokerConfig], { stdout: "inherit", stderr: "inherit" });
  const deadline = Date.now() + 10_000;
  while (!nats) {
    try {
      nats = await connect({
        servers: `nats://127.0.0.1:${tcpPort}`,
        user: "control",
        pass: "loopback",
        timeout: 500,
        reconnect: false,
      });
    } catch (error) {
      if (Date.now() >= deadline || broker.exitCode !== null) throw error;
      await Bun.sleep(100);
    }
  }
  let grants = 0;
  nats.subscribe("$SYS.REQ.USER.AUTH", {
    callback(error, message) {
      if (error) throw error;
      const request = decodeAuthRequest(message.string());
      if (!request) return;
      const instance = parseAgentConnectionName(request.name);
      const allowed = request.authToken === bearer && instance !== null;
      const userJwt = allowed
        ? mintUserJwt({
            userPublicKey: request.userNkey,
            accountSeed,
            name: agentId,
            permissions: workspaceAgentPermissions(workspaceId, agentId, instance),
            audienceAccount: "APP",
          })
        : undefined;
      if (allowed) console.log(`Auth callout granted lane ${++grants}`);
      message.respond(
        Buffer.from(
          mintAuthResponse({
            userPublicKey: request.userNkey,
            serverId: request.serverId,
            accountSeed,
            userJwt,
            error: allowed ? undefined : "unexpected probe credentials",
          }),
        ),
      );
    },
  });
  const hellos = nats.subscribe(`agent.${workspaceId}.${agentId}.connection.*.hello`, {
    max: 1,
    timeout: 30_000,
  });
  await nats.flush();
  const credentials = {
    agentId,
    workspaceId,
    bearer,
    natsUrls: [natsUrl],
    consentedWholeMachine: true,
  };
  let exchanges = 0;
  let renewals = 0;
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (path === "/v1/enrollments/token/exchange") {
        const body = (await request.json()) as { token?: string; os?: string; arch?: string };
        assert.equal(body.token === enrollmentToken, true);
        assert.equal(body.os, platform === "win32" ? "windows" : "linux");
        assert.equal(body.arch, process.arch === "arm64" ? "aarch64" : "x86_64");
        exchanges++;
        return Response.json({ credentials }, { status: 201 });
      }
      if (path === "/v1/enrollments/renew") {
        const body = (await request.json()) as { bearer?: string; signature?: string };
        assert.equal(body.bearer === bearer && !!body.signature, true);
        renewals++;
        return Response.json({ credentials });
      }
      return new Response(null, { status: 404 });
    },
  });
  agent = Bun.spawn([binary, "--api-url", api.url.origin, "run"], {
    cwd: root,
    env: agentEnv,
    stdout: "inherit",
    stderr: "inherit",
  });
  const announcement = await Promise.race([
    hellos[Symbol.asyncIterator]().next(),
    agent.exited.then((code) => {
      throw new Error(`Agent exited before hello (${code})`);
    }),
  ]);
  assert.ok(!announcement.done && announcement.value.data.length > 0);
  assert.equal(exchanges, 1);
  assert.ok(renewals >= 1, "signed renewal should precede the WSS dial");
  assert.ok(grants >= 2, "expected real auth-callout grants for both lanes");
  console.log(
    "PASS: enrollment 201, renewal 200, authenticated WSS on both lanes, and hello received",
  );
} finally {
  if (agent?.exitCode === null) agent.kill();
  await agent?.exited;
  api?.stop(true);
  await nats?.close();
  if (broker?.exitCode === null) broker.kill();
  await broker?.exited;
  if (thumbprint)
    await run([
      "pwsh",
      "-NoProfile",
      "-Command",
      `Remove-Item Cert:\\CurrentUser\\Root\\${thumbprint}`,
    ]);
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
