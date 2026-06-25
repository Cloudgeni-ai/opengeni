// M7 — the WORKER turn-path routing wiring (wrapTurnBoxWithRouting), driven
// against the REAL packages/db on a THROWAWAY postgres + an in-memory
// MemoryEventBus agent responder (the selfhosted control plane stand-in). This is
// the worker companion to packages/runtime/test/routing-proxy.test.ts (the pure
// proxy) and apps/api/test/fleet-tools.test.ts (the fleet service): it proves the
// proxy the worker injects NON-OWNED into the turn re-reads the DB pointer per op
// and dispatches to the currently-active backend after a real setActiveSandbox.
//
// Proves:
//   - default pointer (null): the proxy routes to the established GROUP box.
//   - after setActiveSandbox (swap to the enrolled machine): the NEXT op routes to
//     the MACHINE (the in-memory agent answers it) — the SDK-binds-once contract.
//   - swap back to the group box routes there again (heterogeneous, single-active).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { testSettings, MemoryEventBus } from "@opengeni/testing";
import {
  ControlRequest,
  ControlResponse,
} from "@opengeni/agent-proto";
import {
  createEnrollment,
  createSandbox,
  createSession,
  createDb,
  setActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor, type EstablishedSandboxSession } from "@opengeni/runtime";
import { migrate } from "@opengeni/db/migrate";
import { wrapTurnBoxWithRouting, routingEnabled } from "../src/sandbox-routing";

const CONTAINER = "ogtest-pg-m7-routing";
const PORT = 55472;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL = `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg16";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function removeContainer(): void {
  try { docker(["rm", "-f", CONTAINER]); } catch { /* gone */ }
}
async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try { await probe`SELECT 1`; return; } finally { await probe.end(); }
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`postgres not ready: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let available = true;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  productAccessMode: "managed",
  sandboxSelfhostedEnabled: true,
  selfhostedRelayUrl: "wss://relay.example",
});

/** A MemoryEventBus whose responder echoes a marker hostname for exec — the
 *  enrolled machine. */
function busWithAgent(workspaceId: string, agentId: string, hostname: string): MemoryEventBus {
  const bus = new MemoryEventBus();
  const enc = new TextEncoder();
  bus.subscribeRequests(subjectFor(workspaceId, agentId), (payload) => {
    const req = ControlRequest.decode(payload);
    const op = req.op;
    let res: ControlResponse;
    if (op?.$case === "ping") {
      res = { requestId: req.requestId, result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } } };
    } else if (op?.$case === "exec") {
      res = { requestId: req.requestId, result: { $case: "exec", exec: { exitCode: 0, stdout: enc.encode(`${hostname}\n`), stderr: new Uint8Array(0), timedOut: false, durationMs: "1" } } };
    } else {
      res = { requestId: req.requestId, result: { $case: "exec", exec: { exitCode: 1, stdout: new Uint8Array(0), stderr: enc.encode("unsupported"), timedOut: false, durationMs: "0" } } };
    }
    return ControlResponse.encode(res).finish();
  });
  return bus;
}

/** A fake established GROUP box whose exec returns a fixed marker — the default
 *  routing target (active_sandbox_id == null). */
function fakeGroupBox(marker: string): EstablishedSandboxSession {
  const session = {
    state: { instanceId: "group-box" },
    async exec(_args: unknown) {
      return { stdout: marker, exitCode: 0 };
    },
  };
  return { client: {}, session, sessionState: {}, instanceId: "group-box", backendId: "modal" };
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    console.warn(`[m7-routing] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
  await migrate(ADMIN_URL);
  admin = postgres(ADMIN_URL, { max: 4 });
  await admin.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
        CREATE ROLE opengeni_app LOGIN PASSWORD '${APP_PASSWORD}';
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO opengeni_app;
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
  `);
  client = createDb(APP_URL);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try { await client?.close(); } catch { /* noop */ }
  try { await admin?.end(); } catch { /* noop */ }
  removeContainer();
});

describe("M7 worker routing — wrapTurnBoxWithRouting + a real DB pointer + setActiveSandbox", () => {
  test("the proxy routes to the GROUP box by default, then to the MACHINE after a swap, then back", async () => {
    if (!available) return;
    expect(routingEnabled(settings)).toBe(true);

    const [a] = await admin<{ id: string }[]>`insert into managed_accounts (name) values ('acct') returning id`;
    const [w] = await admin<{ id: string }[]>`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
    const accountId = a!.id;
    const workspaceId = w!.id;

    const session = await createSession(db, {
      accountId, workspaceId, initialMessage: "hi", resources: [], metadata: {},
      model: "gpt-test", sandboxBackend: "modal",
    });
    const enrollment = await createEnrollment(db, {
      accountId, workspaceId, pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine", hasDisplay: true, allowScreenControl: true, os: "linux", arch: "x86_64",
    });
    const sandbox = await createSandbox(db, {
      accountId, workspaceId, kind: "selfhosted", name: "laptop", enrollmentId: enrollment.id,
    });

    const bus = busWithAgent(workspaceId, enrollment.id, "the-laptop") as never;

    // Wrap the established group box in the routing proxy (what the turn does).
    const established = wrapTurnBoxWithRouting(
      { db, settings, bus },
      { workspaceId, sessionId: session.id },
      fakeGroupBox("group-box-marker"),
    );
    const proxy = established.session as { exec: (a: unknown) => Promise<{ stdout: string }> };

    // Default pointer (null) → the op lands on the GROUP box.
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");

    // SWAP mid-turn: repoint the session to the enrolled machine (epoch-bumped CAS).
    const swap = await setActiveSandbox(db, {
      accountId, workspaceId, sessionId: session.id, targetSandboxId: sandbox.id, expectedEpoch: 0,
    });
    expect(swap.swapped).toBe(true);

    // The NEXT op re-reads the pointer and lands on the MACHINE (the agent echoes
    // its hostname) — the SDK-binds-the-proxy-once contract: same object, new box.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");

    // Swap BACK to the group box (target null) → the op routes there again.
    const back = await setActiveSandbox(db, {
      accountId, workspaceId, sessionId: session.id, targetSandboxId: null, expectedEpoch: swap.pointer!.activeEpoch,
    });
    expect(back.swapped).toBe(true);
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");
  }, 60_000);

  test("routingEnabled is false when the selfhosted flag is off (the proxy is not wrapped)", () => {
    const off = testSettings({ sandboxSelfhostedEnabled: false });
    expect(routingEnabled(off)).toBe(false);
  });
});
