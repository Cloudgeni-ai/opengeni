import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Arch, ControlRequest, ControlResponse, Hello, Os } from "../packages/agent-proto/src";

// Use the workspace's pinned NATS client without loading the event bus or its database.
const { connect } = createRequire(new URL("../packages/events/package.json", import.meta.url))(
  "nats",
) as Pick<typeof import("../packages/events/src"), "connect">;

assert.equal(process.platform, "win32");
assert.equal(process.arch, "arm64");

const root = await mkdtemp(join(tmpdir(), "opengeni-agent-arm64-"));
const config = join(root, "config");
const binary = join(root, "opengeni-agent.exe");
const link = join(root, "link.json");
const timeoutMs = 60_000;

async function assertArm64(path: string): Promise<void> {
  const header = new DataView(await Bun.file(path).slice(0, 4096).arrayBuffer());
  assert.equal(header.getUint16(0, true), 0x5a4d, `${path}: DOS signature`);
  const pe = header.getUint32(0x3c, true);
  assert.equal(header.getUint32(pe, true), 0x4550, `${path}: PE signature`);
  assert.equal(header.getUint16(pe + 4, true), 0xaa64, `${path}: PE machine must be ARM64`);
  console.log(`${path}: native ARM64`);
}

async function run(...command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "inherit" });
  try {
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    assert.equal(code, 0, `${command[0]} failed`);
    return output;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

let broker: ReturnType<typeof Bun.spawn> | undefined;
let agent: ReturnType<typeof Bun.spawn> | undefined;
let nats: Awaited<ReturnType<typeof connect>> | undefined;
try {
  // No adjacent helpers or preexisting runtime, and no remote services or enrollment.
  await copyFile("opengeni-agent-aarch64-pc-windows-msvc.exe", binary);
  await assertArm64(binary);
  assert.deepEqual(await readdir(root), ["opengeni-agent.exe"]);
  await mkdir(config);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  const natsUrl = `nats://127.0.0.1:${port}`;
  broker = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const deadline = Date.now() + 10_000;
  while (!nats) {
    try {
      nats = await connect({ servers: natsUrl, timeout: 1_000, reconnect: false });
    } catch (error) {
      if (Date.now() >= deadline || broker.exitCode !== null) throw error;
      await Bun.sleep(100);
    }
  }

  const hellos = nats.subscribe("agent.smoke.windows-arm64.connection.*.hello", {
    max: 1,
    timeout: timeoutMs,
  });
  await nats.flush();
  await Bun.write(
    link,
    JSON.stringify({
      workspace_id: "smoke",
      agent_id: "windows-arm64",
      workspace_root: root,
      nats_url: natsUrl,
      activity_dir: join(root, "activity"),
    }),
  );
  agent = Bun.spawn([binary, "run", "--compute", link], {
    cwd: root,
    env: { ...process.env, OPENGENI_CONFIG_DIR: config },
    stdout: "inherit",
    stderr: "inherit",
  });

  const announcement = await Promise.race([
    hellos[Symbol.asyncIterator]().next(),
    agent.exited.then((code) => {
      throw new Error(`Standalone agent exited before announcing itself (${code})`);
    }),
  ]);
  assert.ok(!announcement.done, "standalone agent did not announce itself");
  const { subject, data } = announcement.value;
  const hello = Hello.decode(data);
  assert.equal(hello.os, Os.OS_WINDOWS);
  assert.equal(hello.arch, Arch.ARCH_AARCH64);

  const ensured = await nats.request(
    subject.replace(/\.hello$/, ".rpc"),
    ControlRequest.encode({
      requestId: crypto.randomUUID(),
      epoch: 0,
      resourcePolicy: undefined,
      op: {
        $case: "browserControlEnsure",
        browserControlEnsure: {
          scopeId: "release-smoke",
          scopeGeneration: "first",
          adminToken: `${crypto.randomUUID()}${crypto.randomUUID()}`,
          allowedOrigins: [],
        },
      },
    }).finish(),
    { timeout: timeoutMs },
  );
  const response = ControlResponse.decode(ensured.data);
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal(response.result?.$case, "browserControlEnsure");
  const health = await fetch(
    `http://127.0.0.1:${response.result.browserControlEnsure.port}/healthz`,
    { signal: AbortSignal.timeout(5_000) },
  );
  assert.ok(health.ok, `Embedded browserd health check returned ${health.status}`);

  const generations = join(config, "interaction-runtime");
  const [generation, ...unexpected] = await readdir(generations);
  assert.ok(generation && !unexpected.length, "expected exactly one embedded runtime generation");
  const runtime = join(generations, generation);
  const native = join(runtime, "computer-native.exe");
  const sdk = join(runtime, "node_modules", "@trycua", "cua-driver-win32-arm64-msvc");
  for (const file of [
    join(runtime, "browserd.exe"),
    native,
    join(runtime, "cua-driver.exe"),
    join(sdk, "cua_driver_sdk.dll"),
    join(sdk, "cua_driver_node_runtime.node"),
  ]) {
    await assertArm64(file);
  }
  assert.equal(typeof JSON.parse(await run(native, "desktop-session")), "object");

  // Reuse the CUA packaging fixture, but load only the SDK and worker written by the agent.
  const probe = join(runtime, "cua-probe.exe");
  await run(
    process.execPath,
    "build",
    "--compile",
    resolve("packages/browserd/test/fixtures/cua/PackagedProbe.ts"),
    "--outfile",
    probe,
  );
  assert.deepEqual(JSON.parse(await run(probe)), {
    permissionsRead: true,
    cursorAvailable: true,
    workerStopped: true,
  });
  console.log("Standalone Windows ARM64 agent started embedded browserd, computer-native, and CUA");
} finally {
  if (agent?.exitCode === null) agent.kill();
  await agent?.exited;
  await nats?.close();
  if (broker?.exitCode === null) broker.kill();
  await broker?.exited;
  await rm(root, { force: true, recursive: true, maxRetries: 10 });
}
