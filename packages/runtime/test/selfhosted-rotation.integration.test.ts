// Explicit native verification: build the opengeni-agent unit-test binary and
// pass OPENGENI_ROTATION_PROBE_BINARY plus OPENGENI_NATS_SERVER_BIN. The broker
// issues real short-lived JWTs; no production agent or enrollment is touched.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentEvent,
  ControlRequest,
  ControlResponse,
  ErrorCode,
  ExecRequest,
  type InventoryOperation,
} from "@opengeni/agent-proto";
import {
  connect,
  createNatsEventBus,
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  nkeys,
} from "@opengeni/events";
import { freePort } from "@opengeni/testing/compose";
import { NatsControlRpc } from "../src/sandbox/selfhosted/control-rpc";
import { OpStreamExecClient } from "../src/sandbox/selfhosted/op-stream";
import { NatsOpStreamTransport } from "../src/sandbox/selfhosted/op-transport";
import { defaultSelfhostedRetryClock } from "../src/sandbox/selfhosted/retry-policy";

const agentBinary = process.env.OPENGENI_ROTATION_PROBE_BINARY;
const brokerBinary = process.env.OPENGENI_NATS_SERVER_BIN;
// Optional Linux preload built from fixtures/realtime-offset.c. Only the test
// agent sees it; the broker, caller and host retain their real clocks.
const clockShim = process.env.OPENGENI_TEST_CLOCK_SHIM;

test.skipIf(!agentBinary || !brokerBinary)(
  "native JWT rotation keeps its exact runner and a running command across socket handoff",
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
    let controller: Awaited<ReturnType<typeof connect>> | undefined;
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
      const instances = new Set<string>();
      auth.subscribe("$SYS.REQ.USER.AUTH", {
        callback(error, message) {
          if (error) throw error;
          const request = decodeAuthRequest(new TextDecoder().decode(message.data))!;
          authorizations++;
          instances.add(request.name ?? "");
          const userJwt = mintUserJwt({
            userPublicKey: request.userNkey,
            accountSeed,
            name: "rotation-probe",
            audienceAccount: "APP",
            permissions: {
              pub: {
                allow: [
                  "agent.hx-test-ws.hx-test-agent.connection.>",
                  "_INBOX.>",
                  "$SYS.REQ.USER.INFO",
                ],
              },
              sub: { allow: ["agent.hx-test-ws.hx-test-agent.connection.>", "_INBOX.>"] },
            },
            expiresAtSeconds: Math.floor(Date.now() / 1000) + 5,
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
        connect: async (options) => {
          controller = await connect({ ...options, user: "auth", pass: "auth" });
          return controller;
        },
      });
      const connection = bus.getRequestConnection();
      const subject =
        "agent.hx-test-ws.hx-test-agent.connection.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.rpc";
      let hellos = 0;
      let firstHelloAuthorizations = 0;
      let goingOffline = 0;
      const inventory: Array<{ hello: number; op: InventoryOperation }> = [];
      auth.subscribe(subject.replace(/\.rpc$/, ".hello"), {
        callback: () => {
          if (hellos === 0) firstHelloAuthorizations = authorizations;
          hellos++;
        },
      });
      auth.subscribe(subject.replace(/\.rpc$/, ".events"), {
        callback(error, message) {
          if (error) throw error;
          const event = AgentEvent.decode(message.data).event;
          if (event?.$case === "goingOffline") goingOffline++;
          if (event?.$case === "operationInventory") {
            inventory.push(
              ...event.operationInventory.operations.map((op) => ({ hello: hellos, op })),
            );
          }
        },
      });
      await auth.flush();
      const clockOffsetFile = join(root, "clock-offset");
      const bootOffsetFile = join(root, "boot-offset");
      if (clockShim) await writeFile(clockOffsetFile, "25200");
      child = Bun.spawn(
        [agentBinary!, "--exact", "supervisor::tests::control_rotation_probe_agent", "--nocapture"],
        {
          env: {
            ...process.env,
            OPENGENI_ROTATION_PROBE_NATS: url,
            OPENGENI_ROTATION_PROBE_ROOT: root,
            ...(clockShim
              ? {
                  LD_PRELOAD: clockShim,
                  OPENGENI_TEST_CLOCK_OFFSET_FILE: clockOffsetFile,
                  OPENGENI_TEST_BOOT_OFFSET_FILE: bootOffsetFile,
                }
              : {}),
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
      let execs = 0;
      const checkExecDeadline = async () => {
        const opId = `clock-exec-${execs++}`;
        const started = await rpc.request(
          subject,
          ControlRequest.fromPartial({
            requestId: opId,
            op: {
              $case: "opStart",
              opStart: {
                op: {
                  $case: "exec",
                  exec: { command: ["/bin/sh", "-c", "sleep 0.05"], timeoutMs: 2000 },
                },
                deadlineMs: String(Date.now() + 2000),
              },
            },
          }),
          { timeoutMs: 5000 },
        );
        expect(started.error).toBeUndefined();
        const until = performance.now() + 4000;
        for (;;) {
          const queried = await rpc.request(
            subject,
            ControlRequest.fromPartial({
              requestId: crypto.randomUUID(),
              op: { $case: "opQuery", opQuery: { opId } },
            }),
            { timeoutMs: 5000 },
          );
          expect(queried.error).toBeUndefined();
          const status = queried.result?.$case === "opStatus" ? queried.result.opStatus : undefined;
          if (status?.exit) {
            expect(status.exit.timedOut).toBe(false);
            expect(status.exit.exitCode).toBe(0);
            break;
          }
          expect(performance.now()).toBeLessThan(until);
          await Bun.sleep(10);
        }
      };
      if (clockShim) await checkExecDeadline();
      const clockChanges = clockShim
        ? (async () => {
            for (const offset of ["0", "-25200", "0"]) {
              await Bun.sleep(3000);
              await writeFile(clockOffsetFile, offset);
              await checkExecDeadline();
            }
          })()
        : Promise.resolve();
      await Promise.all([
        clockChanges,
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
      expect(hellos).toBeGreaterThanOrEqual(3);
      expect(authorizations).toBeGreaterThan(6);
      const executions = (await readdir(root)).filter((name) => name.startsWith("execution-"));
      expect(executions).toHaveLength(inputs);
      if (clockShim) {
        const walls = await Promise.all(
          executions.map(async (name) => Number(await readFile(join(root, name), "utf8"))),
        );
        // Prove the shim affected the native process, not just the test inputs.
        expect(walls.some((wall) => wall - Date.now() > 25_000_000)).toBe(true);
        expect(walls.some((wall) => Date.now() - wall > 25_000_000)).toBe(true);
        expect(walls.some((wall) => Math.abs(wall - Date.now()) < 60_000)).toBe(true);
      }
      if (baseline) expect(Math.max(...latencies)).toBeGreaterThan(55_000);
      else expect(Math.max(...latencies)).toBeLessThan(5_000);
      const stream = new OpStreamExecClient({
        workspaceId: "hx-test-ws",
        agentId: "hx-test-agent",
        connectionInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        epoch: 0,
        connectionGeneration: "7",
        controlRpc: rpc,
        rpcSubject: subject,
        transport: new NatsOpStreamTransport(async () => bus!.getOpStreamConnection!()),
        controlTimeoutMs: 5_000,
        retryClock: defaultSelfhostedRetryClock,
      });
      const streamStarted = performance.now();
      const streamOpId = crypto.randomUUID();
      const streaming = stream.exec(
        streamOpId,
        ExecRequest.fromPartial({
          command: [
            "/bin/sh",
            "-c",
            "printf x >> stream-executions; printf before; while [ ! -f release-stream ]; do sleep 0.05; done; printf after",
          ],
          cwd: root,
          timeoutMs: 15_000,
        }),
        15_000,
        45_000,
      );
      // A plain NATS ping (no control-replay retries) keeps checking that the
      // exact runner is routable, while the real command is held across a
      // broker-authenticated replacement pair and reports itself still running.
      const commandStartedBy = performance.now() + 3_000;
      while (!(await Bun.file(join(root, "stream-executions")).exists())) {
        expect(performance.now()).toBeLessThan(commandStartedBy);
        await Bun.sleep(10);
      }
      const beforeRotation = hellos;
      const rotationBy = performance.now() + 7_000;
      while (!inventory.some(({ hello, op }) => hello > beforeRotation && op.opId === streamOpId)) {
        expect(performance.now()).toBeLessThan(rotationBy);
        const ping = await auth.request(
          subject,
          ControlRequest.encode(
            ControlRequest.fromPartial({
              requestId: "during-rotation",
              op: { $case: "ping", ping: {} },
            }),
          ).finish(),
          { timeout: 1_000 },
        );
        expect(ControlResponse.decode(ping.data).result?.$case).toBe("ping");
        await Bun.sleep(10);
      }
      expect(
        inventory.find(({ hello, op }) => hello > beforeRotation && op.opId === streamOpId)?.op,
      ).toMatchObject({ complete: false, connectionGeneration: "7" });
      expect([...instances]).toEqual([
        "opengeni-agent/connection/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ]);
      expect(goingOffline).toBe(0);
      const agentLog = await readFile(join(root, "agent.log"), "utf8");
      expect(agentLog).toContain("rotating NATS sockets before credential expiry");
      expect(agentLog).not.toMatch(/User Authentication Expired|nats event: disconnected/i);

      // Lose the controller's side too, still without starting another process.
      await controller!.reconnect();
      await writeFile(join(root, "release-stream"), "");
      const streamed = await streaming;
      const streamMs = Math.round(performance.now() - streamStarted);
      console.info(
        JSON.stringify({ streamMs, heals: streamed.heals, exitCode: streamed.response.exitCode }),
      );
      expect(streamed.response.exitCode).toBe(0);
      expect(new TextDecoder().decode(streamed.response.stdout)).toBe("beforeafter");
      expect(await readFile(join(root, "stream-executions"), "utf8")).toBe("x");
      expect(streamMs).toBeLessThan(10_000);
      const boundedStarted = performance.now();
      const bounded = stream.exec(
        crypto.randomUUID(),
        ExecRequest.fromPartial({
          command: ["/bin/sh", "-c", "printf x >> deadline-executions; sleep 10"],
          cwd: root,
          timeoutMs: 1_000,
        }),
        1_000,
        4_000,
      );
      await Bun.sleep(100);
      await controller!.reconnect();
      const timed = await bounded;
      expect(timed.response.timedOut).toBe(true);
      expect(performance.now() - boundedStarted).toBeLessThan(3_000);
      expect(await readFile(join(root, "deadline-executions"), "utf8")).toBe("x");
      if (clockShim) {
        const lease = await connection.request(
          subject,
          ControlRequest.encode(
            ControlRequest.fromPartial({
              requestId: "before-suspend",
              op: { $case: "ping", ping: { controlReplayWindowMs: "1000" } },
            }),
          ).finish(),
          { timeout: 1000 },
        );
        const issued = ControlResponse.decode(lease.data).result;
        expect(issued?.$case).toBe("ping");
        if (issued?.$case !== "ping") throw new Error("missing suspend probe lease");
        // Model elapsed sleep without suspending the host or advancing timers.
        await writeFile(bootOffsetFile, "3600");
        const refusal = await connection.request(
          `${subject}.replay.${issued.ping.controlReplayTokens[0]}`,
          ControlRequest.encode(
            ControlRequest.fromPartial({
              requestId: "delayed-after-suspend",
              op: { $case: "ping", ping: {} },
            }),
          ).finish(),
          { timeout: 1000 },
        );
        expect(ControlResponse.decode(refusal.data).error).toMatchObject({
          code: ErrorCode.ERROR_CODE_PROTOCOL,
          detail: { failure_code: "control_delivery_expired", outcome_unknown: "true" },
        });
        // Prefetched tokens also expired during sleep. Refuse promptly, without
        // replaying under a different identity, then refresh for the next call.
        const stale = await rpc.request(
          subject,
          ControlRequest.fromPartial({
            requestId: "pooled-after-suspend",
            op: { $case: "ping", ping: {} },
          }),
          { timeoutMs: 1000 },
        );
        expect(stale.error?.detail.failure_code).toBe("control_delivery_expired");
        await invoke(false);
      }
      console.info(
        JSON.stringify({
          calls: latencies.length,
          hellos,
          authorizations,
          maxMs: Math.round(Math.max(...latencies)),
          meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
          clockOffsetsSeconds: clockShim ? [25200, 0, -25200, 0] : [0],
          execs,
          simulatedSuspendSeconds: clockShim ? 3600 : 0,
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
