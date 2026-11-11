// Run inside a disposable network namespace to measure controlled network RTT:
// unshare --user --map-root-user --net sh -c 'ip link set lo up &&
//   tc qdisc add dev lo root netem delay 5ms && bun <this-file>'
// A control round trip traverses loopback four times (caller/broker/agent),
// giving 20ms nominal RTT at 5ms per leg; use 20ms per leg for 80ms RTT.
// OPENGENI_NATS_SERVER_BIN and OPENGENI_ROTATION_PROBE_BINARY point at the
// broker and native unit-test executable. This never changes host networking.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freePort } from "@opengeni/testing/compose";

const output = join(import.meta.dir, "../../../../target");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "latency-"));
const port = await freePort();
const bearer = crypto.randomUUID();
const url = `nats://127.0.0.1:${port}`;
await writeFile(
  join(root, "nats.conf"),
  `host: 127.0.0.1\nport: ${port}\nauthorization { token: "${bearer}" }\n`,
);
const broker = Bun.spawn([process.env.OPENGENI_NATS_SERVER_BIN!, "-c", join(root, "nats.conf")], {
  stdout: "ignore",
  stderr: Bun.file(join(root, "broker.log")),
});
let agent: ReturnType<typeof Bun.spawn> | undefined;
try {
  agent = Bun.spawn(
    [
      process.env.OPENGENI_ROTATION_PROBE_BINARY!,
      "--exact",
      "supervisor::tests::control_rotation_probe_agent",
      "--nocapture",
    ],
    {
      env: {
        ...process.env,
        OPENGENI_ROTATION_PROBE_NATS: url,
        OPENGENI_ROTATION_PROBE_ROOT: root,
        OPENGENI_ROTATION_PROBE_BEARER: bearer,
      },
      stdout: Bun.file(join(root, "agent.log")),
      stderr: Bun.file(join(root, "agent-stderr.log")),
    },
  );
  const client = Bun.spawn([process.execPath, join(import.meta.dir, "control-replay-remote.ts")], {
    env: {
      ...process.env,
      OPENGENI_REPLAY_BENCH_URL: url,
      OPENGENI_REPLAY_BENCH_BEARER: bearer,
      OPENGENI_REPLAY_BENCH_ROOT: root,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await client.exited;
  await writeFile(join(root, "stop"), "stop");
  if (exitCode !== 0) throw new Error(`latency client exited ${exitCode}; logs in ${root}`);
  await agent.exited;
  await rm(root, { recursive: true });
} finally {
  agent?.kill();
  broker.kill();
  await Promise.all([agent?.exited, broker.exited]);
}
