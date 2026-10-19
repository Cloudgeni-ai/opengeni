// Explicit native verification: build the opengeni-agent unit-test binary and
// pass OPENGENI_ROTATION_PROBE_BINARY plus OPENGENI_NATS_SERVER_BIN. The broker
// issues real short-lived JWTs; no production agent or enrollment is touched.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlRequest } from "@opengeni/agent-proto";
import {
  connect,
  createNatsEventBus,
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  nkeys,
} from "@opengeni/events";
import { freePort } from "@opengeni/testing";
import { NatsControlRpc } from "../src/sandbox/selfhosted/control-rpc";

const agentBinary = process.env.OPENGENI_ROTATION_PROBE_BINARY;
const brokerBinary = process.env.OPENGENI_NATS_SERVER_BIN;

test.skipIf(!agentBinary || !brokerBinary)(
  "native control requests survive repeated JWT expiry without duplicate execution",
  async () => {
    const output = join(import.meta.dir, "../../../target");
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(output, "rotation-"));
    const port = await freePort();
    const account = nkeys.createAccount();
    const accountSeed = new TextDecoder().decode(account.getSeed());
    const config = join(root, "nats.conf");
    await writeFile(
      config,
      `host: 127.0.0.1
port: ${port}
accounts { APP: { users: [ {user: auth, password: auth} ] }, SYS: {} }
system_account: SYS
authorization { auth_callout { issuer: ${account.getPublicKey()}, auth_users: [auth], account: APP } }
`,
    );
    const broker = Bun.spawn([brokerBinary!, "-c", config], {
      stdout: "ignore",
      stderr: Bun.file(join(root, "broker.log")),
    });
    const url = `nats://127.0.0.1:${port}`;
    let auth: Awaited<ReturnType<typeof connect>> | undefined;
    let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          auth = await connect({ servers: url, user: "auth", pass: "auth" });
          break;
        } catch (error) {
          if (attempt === 50) throw error;
          await Bun.sleep(20);
        }
      }
      let authorizations = 0;
      auth.subscribe("$SYS.REQ.USER.AUTH", {
        callback(error, message) {
          if (error) throw error;
          const request = decodeAuthRequest(new TextDecoder().decode(message.data))!;
          authorizations++;
          const userJwt = mintUserJwt({
            userPublicKey: request.userNkey,
            accountSeed,
            name: "rotation-probe",
            audienceAccount: "APP",
            permissions: {
              pub: { allow: ["agent.hx-test-ws.hx-test-agent.connection.>", "_INBOX.>"] },
              sub: { allow: ["agent.hx-test-ws.hx-test-agent.connection.>", "_INBOX.>"] },
            },
            expiresAtSeconds: Math.floor(Date.now() / 1000) + 2,
          });
          message.respond(
            new TextEncoder().encode(
              mintAuthResponse({
                userPublicKey: request.userNkey,
                serverId: request.serverId,
                accountSeed,
                userJwt,
              }),
            ),
          );
        },
      });
      await auth.flush();
      bus = await createNatsEventBus(url, undefined, {
        connect: (options) => connect({ ...options, user: "auth", pass: "auth" }),
      });
      const connection = bus.getRequestConnection();
      const subject =
        "agent.hx-test-ws.hx-test-agent.connection.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.rpc";
      let hellos = 0;
      let firstHelloAuthorizations = 0;
      auth.subscribe(subject.replace(/\.rpc$/, ".hello"), {
        callback: () => {
          if (hellos === 0) firstHelloAuthorizations = authorizations;
          hellos++;
        },
      });
      await auth.flush();
      child = Bun.spawn(
        [agentBinary!, "--exact", "supervisor::tests::control_rotation_probe_agent", "--nocapture"],
        {
          env: {
            ...process.env,
            OPENGENI_ROTATION_PROBE_NATS: url,
            OPENGENI_ROTATION_PROBE_ROOT: root,
          },
          stdout: Bun.file(join(root, "agent.log")),
          stderr: Bun.file(join(root, "agent-stderr.log")),
        },
      );
      const readyBy = Date.now() + 10_000;
      // eslint-disable-next-line no-unmodified-loop-condition -- broker callback updates hellos
      while (hellos === 0 && Date.now() < readyBy) await Bun.sleep(20);
      expect(hellos).toBeGreaterThan(0);
      expect(firstHelloAuthorizations).toBeGreaterThanOrEqual(2);
      // Compare the pre-fix caller with the same native agent and real deadline.
      const baseline = process.env.OPENGENI_ROTATION_PROBE_BASELINE === "1";
      const rpc = new NatsControlRpc(async () =>
        baseline
          ? {
              supportsHeaders: true,
              request: (target, data, options) =>
                connection.request(target, data, { timeout: options.timeout }),
            }
          : connection,
      );
      let sequence = 0;
      let inputs = 0;
      const latencies: number[] = [];
      const invoke = async (input: boolean) => {
        if (input) inputs++;
        const start = performance.now();
        const response = await rpc.request(
          subject,
          ControlRequest.fromPartial({
            requestId: `probe-${sequence++}`,
            op: input
              ? { $case: "desktopInput", desktopInput: {} }
              : { $case: "ping", ping: { nonce: "1" } },
          }),
          { timeoutMs: 60_000 },
        );
        expect(response.error).toBeUndefined();
        latencies.push(performance.now() - start);
      };
      const end = Date.now() + 12_000;
      await Promise.all([
        ...Array.from({ length: 3 }, async () => {
          while (Date.now() < end) {
            await invoke(true);
            await Bun.sleep(50);
          }
        }),
        ...Array.from({ length: 3 }, async () => {
          while (Date.now() < end) {
            await invoke(false);
            await Bun.sleep(10);
          }
        }),
      ]);
      expect(hellos).toBeGreaterThan(3);
      expect(authorizations).toBeGreaterThan(6);
      expect((await readdir(root)).filter((name) => name.startsWith("execution-"))).toHaveLength(
        inputs,
      );
      if (baseline) expect(Math.max(...latencies)).toBeGreaterThan(55_000);
      else expect(Math.max(...latencies)).toBeLessThan(5_000);
      console.info(
        JSON.stringify({
          calls: latencies.length,
          hellos,
          authorizations,
          maxMs: Math.round(Math.max(...latencies)),
          meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        }),
      );
      // The recovering transport must keep the native request API's immediate
      // authorization errors instead of turning a denied publish into a timeout.
      const restricted = await createNatsEventBus(url, undefined, {
        connect: (options) => connect({ ...options, token: "test-bearer" }),
      });
      try {
        await expect(
          restricted.getRequestConnection().request("forbidden.rpc", new Uint8Array(), {
            timeout: 3_000,
            resendOn: subject.replace(/\.rpc$/, ".hello"),
          }),
        ).rejects.toMatchObject({ code: "PERMISSIONS_VIOLATION" });
      } finally {
        await restricted.close();
      }
    } finally {
      await writeFile(join(root, "stop"), "stop");
      if (child) {
        await Promise.race([child.exited, Bun.sleep(12_000)]);
        child.kill();
        await child.exited;
      }
      await bus?.close();
      await auth?.close();
      broker.kill();
      await broker.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  140_000,
);
