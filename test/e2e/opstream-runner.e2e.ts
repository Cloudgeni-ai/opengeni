// The op-stream exec client against the REAL Rust runner binary over a REAL
// local nats-server — the end-to-end proof for the streaming transport
// (op-stream protocol v1.1, server half):
//
//   1. LONG STREAM — an exec whose output far exceeds the legacy 1 MiB reply
//      wall streams live and reassembles byte-exact (blake3-verified by the
//      client on every path).
//   2. BLIP MID-EXEC — the NATS server is SIGKILLed and restarted mid-command;
//      the child keeps running (op ⊥ connection), the runner retains its
//      output, and the client's silence probe re-attaches and collects the
//      complete result byte-exact.
//   3. WORKER-DEATH / ATTACH-NOT-RERUN — a completed op is NEVER final-acked
//      (the kill-between-persist-and-ack window); a "re-dispatched" consumer
//      (fresh generation, SAME durable op id) re-issues OpStart, ATTACHES, and
//      collects the identical result — the marker file proves the command ran
//      exactly once. Then the successor final-acks (journal persist first).
//
// Opt-in: it needs the runner binary (cargo build -p opengeni-agent) and a
// nats-server binary, so it SKIPS unless both resolve. Run it directly:
//
//   OPENGENI_OPSTREAM_E2E=1 bun test ./test/e2e/opstream-runner.e2e.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import {
  NatsControlRpc,
  NatsOpStreamTransport,
  runWithToolCallCorrelation,
  SelfhostedSession,
  type OpStreamJournal,
} from "@opengeni/runtime/sandbox";

const ENABLED = process.env.OPENGENI_OPSTREAM_E2E === "1";
const WORKSPACE_ID = "hx-ws";
const AGENT_ID = "e2e-opstream-agent";

function resolveNatsServer(): string | null {
  if (process.env.OPENGENI_NATS_SERVER_BIN) {
    return process.env.OPENGENI_NATS_SERVER_BIN;
  }
  const onPath = Bun.which("nats-server");
  if (onPath) {
    return onPath;
  }
  return null;
}

function resolveRunnerBin(): string | null {
  if (process.env.OPENGENI_RUNNER_BIN) {
    return process.env.OPENGENI_RUNNER_BIN;
  }
  const candidate = join(import.meta.dir, "../../agent/target/debug/opengeni-agent");
  return Bun.file(candidate).size > 0 ? candidate : null;
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const natsServerBin = ENABLED ? resolveNatsServer() : null;
const runnerBin = ENABLED ? resolveRunnerBin() : null;
const runnable = ENABLED && natsServerBin !== null && runnerBin !== null;

describe.skipIf(!runnable)("op-stream exec against the REAL runner (e2e)", () => {
  let natsPort: number;
  let natsProc: ReturnType<typeof Bun.spawn> | undefined;
  let runnerProc: ReturnType<typeof Bun.spawn> | undefined;
  let configDir: string;
  let workDir: string;
  let bus: EventBus;

  function startNats(): void {
    natsProc = Bun.spawn([natsServerBin as string, "-a", "127.0.0.1", "-p", String(natsPort)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  function startRunner(): void {
    runnerProc = Bun.spawn([runnerBin as string, "run"], {
      cwd: workDir,
      env: {
        ...process.env,
        OPENGENI_CONFIG_DIR: configDir,
        RUST_LOG: "info",
        SHELL: "/bin/sh",
      },
      stdout: Bun.file(join(configDir, "runner.log")),
      stderr: Bun.file(join(configDir, "runner.log")),
    });
  }

  /** A session bound to the live runner with the op-stream transport injected.
   *  `generation` emulates one Temporal dispatch (Δ1: scheduled-timestamp). */
  function buildSession(journal: OpStreamJournal): SelfhostedSession {
    return new SelfhostedSession({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
      relay: { host: "relay.test" },
      timeoutMs: 5_000,
      execTimeoutMs: 60_000,
      opStream: {
        transport: new NatsOpStreamTransport(async () => bus.getOpStreamConnection?.() ?? null),
        journal,
        // Fast heals so the blip scenario resolves in test time (the prod
        // defaults are 30s silence / 120s hold).
        silenceTimeoutMs: 3_000,
        reconnectHoldMs: 60_000,
      },
    });
  }

  function journalFor(generation: string, log: string[]): OpStreamJournal {
    return {
      attachGeneration: () => generation,
      persistSettled: (opId, exitSeq) => {
        log.push(`persist:${opId}@${exitSeq}`);
      },
    };
  }

  beforeAll(async () => {
    natsPort = await freePort();
    configDir = await mkdtemp(join(tmpdir(), "opstream-e2e-"));
    workDir = join(configDir, "work");
    await mkdir(workDir, { recursive: true });
    // The runner's StoredCredentials shape (mirrors the Rust harness's
    // disposable-agent recipe): a throwaway bearer a no-auth server accepts, a
    // dead relay that is never dialed.
    await writeFile(
      join(configDir, "credentials.json"),
      JSON.stringify(
        {
          agent_id: AGENT_ID,
          workspace_id: WORKSPACE_ID,
          nats_bearer: "hx-token",
          nats_urls: [`nats://127.0.0.1:${natsPort}`],
          relay_url: "http://127.0.0.1:9",
          relay_token: "",
          update_pubkey: "",
          consented_whole_machine: true,
          consented_screen_control: false,
          update_channel: "stable",
          resume_token: "",
          last_known_epoch: 0,
        },
        null,
        2,
      ),
    );
    startNats();
    startRunner();
    bus = await createNatsEventBus(`nats://127.0.0.1:${natsPort}`);
    // Readiness = the runner answers a real liveness probe on its subject.
    const probe = buildSession(journalFor("1", []));
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (await probe.ping()) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("runner did not become pingable within 30s");
      }
      await Bun.sleep(250);
    }
  }, 60_000);

  afterAll(async () => {
    // Close the bus while NATS is still up (a close against a dead server can
    // hang on the drain), then kill the processes.
    await Promise.race([bus?.close(), Bun.sleep(2_000)]).catch(() => {});
    runnerProc?.kill(9);
    natsProc?.kill(9);
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }, 15_000);

  test("long stream: >1MiB of output — past the legacy reply wall — byte-exact", async () => {
    const session = buildSession(journalFor("1000", []));
    const result = await runWithToolCallCorrelation("e2e_long", () =>
      session.exec({ cmd: "seq 1 300000" }),
    );
    expect(result.exitCode).toBe(0);
    const bytes = Buffer.byteLength(result.stdout);
    expect(bytes).toBeGreaterThan(1_048_576); // the old 1MiB ceiling is dead
    expect(result.stdout.endsWith("299999\n300000\n")).toBe(true);
    await session.finalizeOpStreamOps();
  }, 120_000);

  test("blip mid-exec: NATS dies and restarts; the child survives; collection is byte-exact", async () => {
    const session = buildSession(journalFor("1001", []));
    const execPromise = runWithToolCallCorrelation("e2e_blip", () =>
      session.exec({
        // ~8s of output, one line per 400ms — long enough to straddle the blip.
        cmd: 'for i in $(seq 1 20); do printf "line %s\\n" "$i"; sleep 0.4; done',
      }),
    );
    await Bun.sleep(2_000);
    natsProc?.kill(9);
    await Bun.sleep(1_500);
    startNats();
    const result = await execPromise;
    expect(result.exitCode).toBe(0);
    const expected = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join("");
    expect(result.stdout).toBe(expected);
    await session.finalizeOpStreamOps();
  }, 120_000);

  test("worker death: a successor generation attaches and collects — the command ran ONCE", async () => {
    const marker = join(configDir, "marker.txt");
    const cmd = `echo run >> ${marker}; cat ${marker}; echo done`;

    // Dispatch 1: completes but DIES before its final ack (the
    // kill-between-persist-and-ack window) — no finalize.
    const first = buildSession(journalFor("2000", []));
    const firstResult = await runWithToolCallCorrelation("e2e_once", () => first.exec({ cmd }));
    expect(firstResult.stdout).toBe("run\ndone\n");

    // Dispatch 2 (the workflow redispatch): a NEW consumer, HIGHER
    // generation, the SAME durable op id — OpStart dedups, attach replays,
    // the result is identical, and the marker proves single execution.
    const persistLog: string[] = [];
    const second = buildSession(journalFor("3000", persistLog));
    const secondResult = await runWithToolCallCorrelation("e2e_once", () => second.exec({ cmd }));
    expect(secondResult.stdout).toBe(firstResult.stdout);
    expect(secondResult.exitCode).toBe(firstResult.exitCode);

    const markerContent = await readFile(marker, "utf8");
    expect(markerContent).toBe("run\n"); // exactly ONE execution

    // The successor's turn end: journal persist precedes the wire final ack
    // (asserted in unit tests; here we prove the runner ACCEPTS the final
    // ack from the successor generation — no error, and the persist ran).
    await second.finalizeOpStreamOps();
    expect(persistLog.length).toBe(1);
    expect(persistLog[0]).toStartWith("persist:e2e_once:0@");
  }, 120_000);

  test("legacy parity: the same runner serves the same command over the legacy wire", async () => {
    const legacy = new SelfhostedSession({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
      relay: { host: "relay.test" },
      timeoutMs: 5_000,
      execTimeoutMs: 60_000,
      // no opStream: the permanent fallback wire form
    });
    const streaming = buildSession(journalFor("4000", []));
    const viaLegacy = await legacy.exec({ cmd: "printf 'out'; printf 'err' 1>&2; exit 3" });
    const viaStream = await runWithToolCallCorrelation("e2e_parity", () =>
      streaming.exec({ cmd: "printf 'out'; printf 'err' 1>&2; exit 3" }),
    );
    expect(viaStream.stdout).toBe(viaLegacy.stdout);
    expect(viaStream.stderr).toBe(viaLegacy.stderr);
    expect(viaStream.exitCode).toBe(viaLegacy.exitCode);
    await streaming.finalizeOpStreamOps();
  }, 60_000);
});
