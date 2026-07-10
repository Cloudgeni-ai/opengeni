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
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
  MemoryEventBus,
} from "@opengeni/testing";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import {
  createEnrollment,
  createSandbox,
  createSession,
  createDb,
  getSandbox,
  readActiveSandbox,
  setActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { buildManifest, subjectFor, type EstablishedSandboxSession } from "@opengeni/runtime";
import { swapActiveSandbox, type FleetContext } from "@opengeni/core";
import {
  wrapLazyTurnBoxWithRouting,
  wrapTurnBoxWithRouting,
  routingEnabled,
} from "../src/sandbox-routing";
import { reconcileActiveSandboxPointer } from "../src/activities/agent-turn";

let available = true;
let shared: SharedTestDatabase | null = null;
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
      res = {
        requestId: req.requestId,
        result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
      };
    } else if (op?.$case === "exec") {
      res = {
        requestId: req.requestId,
        result: {
          $case: "exec",
          exec: {
            exitCode: 0,
            stdout: enc.encode(`${hostname}\n`),
            stderr: new Uint8Array(0),
            timedOut: false,
            durationMs: "1",
          },
        },
      };
    } else {
      res = {
        requestId: req.requestId,
        result: {
          $case: "exec",
          exec: {
            exitCode: 1,
            stdout: new Uint8Array(0),
            stderr: enc.encode("unsupported"),
            timedOut: false,
            durationMs: "0",
          },
        },
      };
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
  shared = await acquireSharedTestDatabase("worker-sandbox-routing");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[worker-sandbox-routing] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
});

describe("M7 worker routing — wrapTurnBoxWithRouting + a real DB pointer + setActiveSandbox", () => {
  test("the proxy routes to the GROUP box by default, then to the MACHINE after a swap, then back", async () => {
    if (!available) return;
    expect(routingEnabled(settings)).toBe(true);

    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
    const accountId = a!.id;
    const workspaceId = w!.id;

    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os: "linux",
      arch: "x86_64",
    });
    const sandbox = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
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
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sandbox.id,
      expectedEpoch: 0,
    });
    expect(swap.swapped).toBe(true);

    // The NEXT op re-reads the pointer and lands on the MACHINE (the agent echoes
    // its hostname) — the SDK-binds-the-proxy-once contract: same object, new box.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");

    // Swap BACK to the group box (target null) → the op routes there again.
    const back = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: swap.pointer!.activeEpoch,
    });
    expect(back.swapped).toBe(true);
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");
  }, 60_000);

  test("routingEnabled is false when the selfhosted flag is off (the proxy is not wrapped)", () => {
    const off = testSettings({ sandboxSelfhostedEnabled: false });
    expect(routingEnabled(off)).toBe(false);
  });

  test("lazy wrapper seeds synthetic manifest and default-pointer ops single-flight through the provisioner", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-lazy') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-lazy') returning id`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const manifest = buildManifest(settings, [], { HOME: "/workspace", LAZY: "1" });
    let provisions = 0;
    const real = fakeGroupBox("lazy-real");
    const lazy = wrapLazyTurnBoxWithRouting(
      { db, settings, bus: new MemoryEventBus() as never },
      { workspaceId, sessionId: session.id, environment: { HOME: "/workspace", LAZY: "1" } },
      {
        client: { backendId: "modal" },
        backendId: "modal",
        agentDefaultManifest: manifest,
        provisioner: {
          get: async () => {
            provisions += 1;
            return { established: real };
          },
        },
      },
    );
    const proxy = lazy.session as {
      state: { manifest: unknown };
      exec: (a: unknown) => Promise<{ stdout: string }>;
    };

    expect(proxy.state.manifest).toBe(manifest);
    expect((await proxy.exec({ cmd: "echo hi" })).stdout).toBe("lazy-real");
    expect(provisions).toBe(1);
    expect((await proxy.exec({ cmd: "echo again" })).stdout).toBe("lazy-real");
    expect(provisions).toBe(1);
  });
});

describe("M7 worker routing — turn-start reconcile (issue #341 invariant B)", () => {
  async function seedAcctWs(tag: string): Promise<{ accountId: string; workspaceId: string }> {
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values (${`acct-${tag}`}) returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, ${`ws-${tag}`}) returning id`;
    return { accountId: a!.id, workspaceId: w!.id };
  }

  test("a stranded Modal-sibling pointer resets to HOME (null) + emits session.route.reconciled (Shapes 1/2)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("recon");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    // A first-class Modal sibling row (no group/lease/box) — the categorical strand.
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    // Persist a stranded pointer directly (a legacy pre-gate pointer / FK orphan):
    // the session points at the unestablishable sibling at epoch 1.
    const stranded = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    expect(stranded.swapped).toBe(true);
    const pointer = (await readActiveSandbox(db, workspaceId, session.id))!;
    const record = await getSandbox(db, workspaceId, pointer.activeSandboxId!);

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      { pointer, record },
      async (evs) => {
        events.push(...evs);
      },
    );

    // Reset to HOME under the fence: pointer null, epoch bumped, record cleared.
    expect(result.pointer?.activeSandboxId ?? null).toBeNull();
    expect(result.pointer!.activeEpoch).toBe(pointer.activeEpoch + 1);
    expect(result.record).toBeNull();
    // The DB reflects the reset (not just the in-memory return).
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBeNull();
    expect(persisted.activeEpoch).toBe(pointer.activeEpoch + 1);
    // A VISIBLE typed event was emitted (never a silent downgrade), carrying the
    // reason + epochs but NO target id.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.route.reconciled");
    expect(events[0]!.payload).toMatchObject({
      reason: "unsupported_backend_context",
      fromEpoch: pointer.activeEpoch,
      toEpoch: pointer.activeEpoch + 1,
    });
    expect(JSON.stringify(events[0]!.payload)).not.toContain(sibling.id);
  }, 60_000);

  test("reconcile is epoch-fenced: a concurrent higher-epoch swap is NOT clobbered", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("fence");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os: "linux",
      arch: "x86_64",
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });

    // The turn LOADS a stranded modal-sibling pointer at epoch 1...
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    const stalePointer = (await readActiveSandbox(db, workspaceId, session.id))!;
    const staleRecord = await getSandbox(db, workspaceId, stalePointer.activeSandboxId!);
    expect(stalePointer.activeEpoch).toBe(1);

    // ...but a CONCURRENT user swap moves the real pointer to the enrolled machine at a
    // HIGHER epoch (2) before the reconcile CAS runs.
    const concurrent = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: stalePointer.activeEpoch,
    });
    expect(concurrent.swapped).toBe(true);
    expect(concurrent.pointer!.activeEpoch).toBe(2);

    const events: Array<{ type: string }> = [];
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      { pointer: stalePointer, record: staleRecord },
      async (evs) => {
        events.push(...evs);
      },
    );

    // The stale reset LOST the fence: the user's machine swap survives untouched.
    expect(result.pointer?.activeSandboxId).toBe(machine.id);
    expect(result.pointer!.activeEpoch).toBe(2);
    expect(result.record?.id).toBe(machine.id);
    // No reconcile event (nothing was reset); the DB still points at the machine.
    expect(events).toHaveLength(0);
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBe(machine.id);
    expect(persisted.activeEpoch).toBe(2);
  }, 60_000);

  // BEHAVIORAL "pointer untouched" (issue #341 invariant A / Shape 1): a rejected
  // Modal-sibling swap must not move the pointer, proven by ROUTING — the next op
  // still lands on the pre-swap backend, not by DB inspection alone.
  test("a rejected sibling swap leaves the pointer untouched: the next op still routes to the pre-swap backend", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("reject-untouched");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os: "linux",
      arch: "x86_64",
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    const bus = busWithAgent(workspaceId, enrollment.id, "the-laptop") as never;

    // Pre-swap: pin the session to the machine (the pre-swap backend the ops route to).
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: 0,
    });
    const before = (await readActiveSandbox(db, workspaceId, session.id))!;

    const established = wrapTurnBoxWithRouting(
      { db, settings, bus },
      { workspaceId, sessionId: session.id },
      fakeGroupBox("group-box-marker"),
    );
    const proxy = established.session as { exec: (a: unknown) => Promise<{ stdout: string }> };
    // The op currently routes to the machine (the pre-swap backend).
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");

    // Attempt to swap onto the Modal sibling → REJECTED before the CAS.
    const ctx: FleetContext = {
      accountId,
      workspaceId,
      sessionId: session.id,
      sessionBackend: "modal",
      sessionGroupId: session.sandboxGroupId,
    };
    const rejected = await swapActiveSandbox({ db, settings, bus }, ctx, sibling.id);
    expect(rejected.swapped).toBe(false);
    expect(rejected.code).toBe("unsupported_backend_context");

    // The pointer never moved: the next op STILL routes to the pre-swap machine, and
    // the persisted pointer/epoch are unchanged.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");
    const after = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(after.activeSandboxId).toBe(machine.id);
    expect(after.activeEpoch).toBe(before.activeEpoch);
  }, 60_000);
});
