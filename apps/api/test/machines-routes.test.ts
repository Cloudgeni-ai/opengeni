import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  AgentEvent,
  ControlRequest,
  ControlResponse,
  GoingOfflineReason,
  Hello,
} from "@opengeni/agent-proto";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  listSandboxes,
  revokeEnrollment,
  setActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import { createApp } from "../src/app";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";
import {
  handleAgentEventPayload,
  handleHelloPayload,
  startMetricsIngestion,
} from "../src/sandbox/metrics-ingestion";

// Track started ingestion consumers so afterEach can unsubscribe them (each test
// uses its own bus, but cleaning up keeps subscriptions from leaking).
const ingestionStoppers: Array<() => void> = [];

// M10 — the Machines DASHBOARD + per-machine metrics-series ROUTES, driven
// end-to-end through createApp + the REAL packages/db on a THROWAWAY postgres
// (mirrors enrollment-routes / fleet-tools). The selfhosted control plane is an
// in-memory MemoryEventBus responder (ping → online) + the same bus drives the
// metrics-INGESTION consumer via emitAgentEvent (a heartbeat AgentEvent), so the
// machines endpoint returns the contract shape across states with REAL metrics.
//
// Proves:
//   - GET /machines: the workspace's enrolled selfhosted machine (online, with
//     latest metrics + sharedSessionCount) and, with ?sessionId, the synthetic
//     Modal group entry (isSessionGroup:true) + the active pointer.
//   - state matrix: online (consent + display) vs consent_required vs offline.
//   - metrics ingestion → the latest row surfaces in the response.
//   - GET /metrics/series: the downsampled series.
//   - flag OFF → 404; cross-workspace bearer → 403; unknown machine series → 404.

const DELEGATION_SECRET = "m10-delegation-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  productAccessMode: "managed",
  authRequired: false,
  delegationSecret: DELEGATION_SECRET,
  sandboxSelfhostedEnabled: true,
  selfhostedRelayUrl: "wss://relay.example",
});

/** A MemoryEventBus whose responder answers ping → online for the agent subject
 *  (online=false registers no responder → offline). */
function busWithAgent(opts: {
  workspaceId: string;
  agentId: string;
  online: boolean;
}): MemoryEventBus {
  const bus = new MemoryEventBus();
  if (!opts.online) {
    return bus;
  }
  bus.subscribeRequests(subjectFor(opts.workspaceId, opts.agentId), (payload) => {
    const req = ControlRequest.decode(payload);
    const op = req.op;
    const res: ControlResponse =
      op?.$case === "ping"
        ? {
            requestId: req.requestId,
            result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
          }
        : {
            requestId: req.requestId,
            error: { code: 0, message: "unsupported", retryable: false, detail: {} },
          };
    return ControlResponse.encode(res).finish();
  });
  return bus;
}

class SlowProbeBus extends MemoryEventBus {
  startedSubjects: string[] = [];
  completed = 0;
  maxInFlight = 0;
  private inFlight = 0;

  constructor(private readonly delayMs: number) {
    super();
  }

  getRequestConnection(): ReturnType<MemoryEventBus["getRequestConnection"]> {
    return {
      request: async (subject, payload) => {
        this.startedSubjects.push(subject);
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        const { requestId } = ControlRequest.decode(payload);
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
        this.inFlight -= 1;
        this.completed += 1;
        return {
          data: ControlResponse.encode({
            requestId,
            error: {
              code: 4,
              message: "probe timed out",
              retryable: true,
              detail: {},
            },
          }).finish(),
        };
      },
    };
  }
}

/** Build + emit a heartbeat AgentEvent carrying a metrics sample, driving the
 *  in-process ingestion consumer (started by createApp). */
async function emitHeartbeat(
  bus: MemoryEventBus,
  workspaceId: string,
  agentId: string,
  cpuPct: number,
): Promise<void> {
  const event = AgentEvent.encode({
    agentId,
    event: {
      $case: "heartbeat",
      heartbeat: {
        seq: "1",
        uptimeMs: "1000",
        activeSessions: 0,
        draining: false,
        metrics: {
          sampledAtMs: String(Date.now()),
          cpuPercent: cpuPct,
          load1: 0.5,
          load5: 0.4,
          load15: 0.3,
          memUsedBytes: "1024",
          memTotalBytes: "4096",
          diskUsedBytes: "2048",
          diskTotalBytes: "8192",
          runQueue: 1,
          gpus: [],
        },
      },
    },
  }).finish();
  await bus.emitAgentEvent(`agent.${workspaceId}.${agentId}.events`, event);
}

/** Emit a clean GoingOffline AgentEvent, driving the ingestion consumer to stamp
 *  the enrollment's clean going-offline marker. */
async function emitGoingOffline(
  bus: MemoryEventBus,
  workspaceId: string,
  agentId: string,
  reason: GoingOfflineReason,
): Promise<void> {
  const event = AgentEvent.encode({
    agentId,
    event: { $case: "goingOffline", goingOffline: { reason } },
  }).finish();
  await bus.emitAgentEvent(`agent.${workspaceId}.${agentId}.events`, event);
}

function appFor(bus: MemoryEventBus, overrides: Partial<AppDependencies> = {}) {
  const noop = async () => {};
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  const deps: AppDependencies = {
    settings,
    db,
    bus: bus as never,
    workflowClient,
    managedAuth: null,
    ...overrides,
  };
  // Mirror startApi: start the metrics-ingestion consumer when the flag is on, so
  // emitHeartbeat actually lands rows (the route test exercises ingestion + read).
  const effectiveSettings = overrides.settings ?? settings;
  if (effectiveSettings.sandboxSelfhostedEnabled) {
    ingestionStoppers.push(startMetricsIngestion({ db, bus, observability: undefined }));
  }
  return createApp(deps);
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function bearer(
  accountId: string,
  workspaceId: string,
  permissions: Permission[],
): Promise<string> {
  return await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: "user-m10",
    subjectLabel: "M10 User",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("machines-routes");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[machines-routes] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterEach(() => {
  while (ingestionStoppers.length > 0) {
    ingestionStoppers.pop()?.();
  }
});

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

type SeedOpts = { online?: boolean; hasDisplay?: boolean; allowScreenControl?: boolean };
async function seed(opts: SeedOpts = {}) {
  const { accountId, workspaceId } = await freshWorkspace();
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
    hasDisplay: opts.hasDisplay ?? true,
    allowScreenControl: opts.allowScreenControl ?? true,
    os: "linux",
    arch: "x86_64",
  });
  await admin`update enrollments set last_seen_at = now() where id = ${enrollment.id}`;
  const sandbox = await createSandbox(db, {
    accountId,
    workspaceId,
    kind: "selfhosted",
    name: "my-laptop",
    enrollmentId: enrollment.id,
  });
  const bus = busWithAgent({ workspaceId, agentId: enrollment.id, online: opts.online ?? true });
  return { accountId, workspaceId, session, enrollment, sandbox, bus };
}

describe("M10 GET /machines — dashboard list + states + metrics", () => {
  test("an online machine returns the contract shape with latest metrics; ?sessionId adds the synthetic group + active pointer", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    // Drive a heartbeat → the ingestion consumer upserts the latest metrics row.
    await emitHeartbeat(bus, workspaceId, enrollment.id, 42.5);

    // Workspace dashboard (no session): just the enrolled machine, null active.
    const wsRes = await app.request(`/v1/workspaces/${workspaceId}/machines`, {
      headers: { authorization: auth },
    });
    expect(wsRes.status).toBe(200);
    const wsBody = (await wsRes.json()) as {
      activeSandboxId: string | null;
      activeEpoch: number;
      machines: Array<{
        sandboxId: string;
        isSessionGroup: boolean;
        kind: string;
        state: string;
        metrics: { cpuPct: number } | null;
        sharedSessionCount: number;
        hasDisplay: boolean;
        allowScreenControl: boolean;
      }>;
    };
    expect(wsBody.activeSandboxId).toBeNull();
    expect(wsBody.activeEpoch).toBe(0);
    expect(wsBody.machines.length).toBe(1);
    const machine = wsBody.machines[0]!;
    expect(machine.sandboxId).toBe(sandbox.id);
    expect(machine.isSessionGroup).toBe(false);
    expect(machine.kind).toBe("selfhosted");
    expect(machine.state).toBe("online"); // consent acked + display present
    expect(machine.hasDisplay).toBe(true);
    expect(machine.allowScreenControl).toBe(true);
    expect(machine.metrics).not.toBeNull();
    expect(machine.metrics!.cpuPct).toBe(42.5);

    // In-session view: the synthetic Modal group box is prepended.
    const sessRes = await app.request(
      `/v1/workspaces/${workspaceId}/machines?sessionId=${session.id}`,
      { headers: { authorization: auth } },
    );
    expect(sessRes.status).toBe(200);
    const sessBody = (await sessRes.json()) as {
      machines: Array<{
        isSessionGroup: boolean;
        kind: string;
        active: boolean;
        sandboxId: string;
      }>;
    };
    const group = sessBody.machines.find((m) => m.isSessionGroup);
    expect(group).toBeDefined();
    expect(group!.kind).toBe("modal");
    expect(group!.active).toBe(true); // null active pointer == the group box
    expect(group!.sandboxId).toBe(session.sandboxGroupId);
    // Both the group box + the enrolled machine are present.
    expect(sessBody.machines.length).toBe(2);

    // Revocation keeps the durable enrollment/sandbox rows for audit and later
    // re-enrollment, but removes the machine from both dashboard projections.
    expect(
      await revokeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: enrollment.id,
      }),
    ).toEqual({ revoked: true });
    const afterWorkspace = (await (
      await app.request(`/v1/workspaces/${workspaceId}/machines`, {
        headers: { authorization: auth },
      })
    ).json()) as { machines: unknown[] };
    expect(afterWorkspace.machines).toEqual([]);
    const afterSession = (await (
      await app.request(`/v1/workspaces/${workspaceId}/machines?sessionId=${session.id}`, {
        headers: { authorization: auth },
      })
    ).json()) as { machines: Array<{ isSessionGroup: boolean }> };
    expect(afterSession.machines).toEqual([expect.objectContaining({ isSessionGroup: true })]);
  }, 90_000);

  test("clean going-offline round-trip: online → GoingOffline reads OFFLINE immediately (probe still responds) → heartbeat reads ONLINE again", async () => {
    if (!available) return;
    // seed() registers a ping responder (online) + a fresh last_seen, so WITHOUT a
    // marker the machine reads online. This proves the marker takes precedence over
    // BOTH a still-responding probe and a still-fresh last_seen — the #348 fix —
    // end-to-end through the real ingestion consumer + derivation + endpoint.
    const { accountId, workspaceId, enrollment, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    const stateNow = async (): Promise<string> => {
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string }> };
      return body.machines[0]!.state;
    };

    // 1. Online: probe responds + last_seen fresh.
    await emitHeartbeat(bus, workspaceId, enrollment.id, 10);
    expect(await stateNow()).toBe("online");

    // 2. Clean GoingOffline → OFFLINE immediately, though the probe STILL responds
    //    and last_seen is still fresh (the marker wins).
    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_HOST_SHUTDOWN,
    );
    expect(await stateNow()).toBe("offline");

    // 3. A fresh heartbeat clears the marker → ONLINE again (round-trip complete).
    await emitHeartbeat(bus, workspaceId, enrollment.id, 12);
    expect(await stateNow()).toBe("online");
  }, 90_000);

  test("state matrix: displayed-but-unconsented is ONLINE (view/control decoupled); offline when no responder", async () => {
    if (!available) return;
    // A displayed machine whose SCREEN CONTROL isn't consented is still ONLINE:
    // compute + read-only viewing work; only INPUT is withheld (surfaced via the
    // separate allowScreenControl field, not by degrading the machine state).
    {
      const { accountId, workspaceId, bus } = await seed({
        allowScreenControl: false,
        hasDisplay: true,
      });
      const app = appFor(bus);
      const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string; allowScreenControl: boolean }> };
      expect(body.machines[0]!.state).toBe("online");
      expect(body.machines[0]!.allowScreenControl).toBe(false);
    }
    // offline: online=false → no responder → the probe misses; lastSeenAt is recent
    // BUT we clear it so it is hard-offline.
    {
      const { accountId, workspaceId, enrollment, bus } = await seed({ online: false });
      await admin`update enrollments set last_seen_at = null where id = ${enrollment.id}`;
      const app = appFor(bus);
      const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string; metrics: unknown }> };
      expect(body.machines[0]!.state).toBe("offline");
    }
    // display_unavailable: online + consented but headless (no display).
    {
      const { accountId, workspaceId, bus } = await seed({
        hasDisplay: false,
        allowScreenControl: true,
      });
      const app = appFor(bus);
      const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string }> };
      expect(body.machines[0]!.state).toBe("display_unavailable");
    }
  }, 120_000);

  test("probes active enrolled machines in parallel while preserving sandbox order", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollments = [];
    for (let i = 0; i < 4; i += 1) {
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
      enrollments.push(enrollment);
      await createSandbox(db, {
        accountId,
        workspaceId,
        kind: "selfhosted",
        name: `machine-${i}`,
        enrollmentId: enrollment.id,
      });
    }
    await revokeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollments[3]!.id,
    });

    const expectedOrder = (await listSandboxes(db, workspaceId))
      .filter((sandbox) => sandbox.enrollmentId !== enrollments[3]!.id)
      .map((sandbox) => sandbox.id);
    const bus = new SlowProbeBus(150);
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    const res = await app.request(`/v1/workspaces/${workspaceId}/machines`, {
      headers: { authorization: auth },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { machines: Array<{ sandboxId: string }> };
    expect(body.machines.map((machine) => machine.sandboxId)).toEqual(expectedOrder);
    expect(bus.startedSubjects.length).toBe(3);
    expect(bus.completed).toBe(3);
    // This is the deterministic concurrency proof: each request increments the
    // in-flight counter before its artificial delay. A serial implementation can
    // never observe all three outstanding together. Do not replace this with an
    // endpoint wall-clock budget, which also measures unrelated database
    // contention and turns host load into a false performance regression.
    expect(bus.maxInFlight).toBe(3);
  }, 30_000);
});

describe("M10 GET /machines/:enrollmentId/metrics/series", () => {
  test("returns the downsampled series after heartbeats; unknown machine → 404", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    // Two heartbeats: the first seeds a series row; the dashboard reads it back.
    await emitHeartbeat(bus, workspaceId, enrollment.id, 11);

    const res = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/metrics/series?window=1h`,
      { headers: { authorization: auth } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { samples: Array<{ cpuPct: number; sampledAt: string }> };
    expect(body.samples.length).toBeGreaterThanOrEqual(1);
    expect(body.samples[0]!.cpuPct).toBe(11);

    // Unknown machine id → 404 (not an empty series).
    const unknown = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${crypto.randomUUID()}/metrics/series`,
      { headers: { authorization: auth } },
    );
    expect(unknown.status).toBe(404);
  }, 90_000);
});

describe("M10 flag gate + authz", () => {
  test("flag OFF → /machines + /metrics/series 404; cross-workspace bearer → 403", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment, bus } = await seed();

    // Flag OFF → 404 (invisible).
    const offApp = appFor(bus, { settings: { ...settings, sandboxSelfhostedEnabled: false } });
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    expect(
      (
        await offApp.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await offApp.request(
          `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/metrics/series`,
          { headers: { authorization: auth } },
        )
      ).status,
    ).toBe(404);

    // Cross-workspace: a bearer for a DIFFERENT workspace cannot read this one (403).
    const other = await freshWorkspace();
    const onApp = appFor(bus);
    const crossAuth = `Bearer ${await bearer(other.accountId, other.workspaceId, ["enrollments:read"])}`;
    expect(
      (
        await onApp.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: crossAuth },
        })
      ).status,
    ).toBe(403);

    // No bearer at all → 401.
    expect((await onApp.request(`/v1/workspaces/${workspaceId}/machines`)).status).toBe(401);
  }, 90_000);
});

describe("machine.link.* fan-out — link-plane session events on going-offline / reconnect", () => {
  // Read the machine-link events a session accumulated (ordered), each with the
  // turn they were stamped on.
  async function machineLinkEvents(
    sessionId: string,
  ): Promise<Array<{ type: string; turn_id: string | null }>> {
    return await admin<{ type: string; turn_id: string | null }[]>`
      select type, turn_id from session_events
      where session_id = ${sessionId}
        and (type like 'machine.link.%' or type = 'machine.runner.restarted')
      order by sequence`;
  }

  // Point a seeded session at its machine's sandbox with a running turn, so the
  // fan-out query counts it as "a session with an active op on the machine".
  async function makeActiveOp(
    accountId: string,
    workspaceId: string,
    sessionId: string,
    sandboxId: string,
    turnId: string,
  ): Promise<void> {
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId,
      targetSandboxId: sandboxId,
      expectedEpoch: 0,
    });
    await admin`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;
  }

  function helloBytes(agentId: string, workspaceId: string): Uint8Array {
    return Hello.encode(
      Hello.fromPartial({ agentId, workspaceId, capabilities: { desktop: true } }),
    ).finish();
  }

  test("a self-update GoingOffline fans out link.lost + runner.restarted to the active-op session, on its running turn", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const turnId = "dddddddd-0000-4000-8000-000000000001";
    await makeActiveOp(accountId, workspaceId, session.id, sandbox.id, turnId);
    appFor(bus); // starts the metrics-ingestion consumer

    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE,
    );

    const events = await machineLinkEvents(session.id);
    expect(events.map((e) => e.type)).toEqual(["machine.link.lost", "machine.runner.restarted"]);
    // Both are stamped on the session's OWN running turn.
    expect(events.every((e) => e.turn_id === turnId)).toBe(true);
  }, 90_000);

  test("a plain (non-update) GoingOffline fans out link.lost ONLY (no runner.restarted)", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const turnId = "dddddddd-0000-4000-8000-000000000002";
    await makeActiveOp(accountId, workspaceId, session.id, sandbox.id, turnId);
    appFor(bus);

    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_HOST_SHUTDOWN,
    );

    expect((await machineLinkEvents(session.id)).map((e) => e.type)).toEqual(["machine.link.lost"]);
  }, 90_000);

  test("a reconnect Hello after a lost fans out link.restored; a second Hello (marker already cleared) emits nothing more", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const turnId = "dddddddd-0000-4000-8000-000000000003";
    await makeActiveOp(accountId, workspaceId, session.id, sandbox.id, turnId);
    appFor(bus);

    // Lose the link first (sets the marker + emits link.lost).
    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_USER_STOP,
    );

    // Reconnect: the Hello clears the marker → emits link.restored on the turn.
    await handleHelloPayload(
      db,
      undefined,
      helloBytes(enrollment.id, workspaceId),
      `agent.${workspaceId}.${enrollment.id}.hello`,
      bus,
    );
    const afterFirst = await machineLinkEvents(session.id);
    const restored = afterFirst.filter((e) => e.type === "machine.link.restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.turn_id).toBe(turnId);

    // A second Hello finds no marker to clear → no further restored (a restored only
    // ever pairs a prior lost).
    await handleHelloPayload(
      db,
      undefined,
      helloBytes(enrollment.id, workspaceId),
      `agent.${workspaceId}.${enrollment.id}.hello`,
      bus,
    );
    const afterSecond = await machineLinkEvents(session.id);
    expect(afterSecond.filter((e) => e.type === "machine.link.restored")).toHaveLength(1);
  }, 90_000);

  test("no session with an active op on the machine ⇒ a GoingOffline emits NO session events (idle blip stays silent)", async () => {
    if (!available) return;
    // seed() creates a session but does NOT point it at the machine / give it a
    // running turn, so the fan-out query matches nothing.
    const { workspaceId, session, enrollment, bus } = await seed();
    appFor(bus);

    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE,
    );

    expect(await machineLinkEvents(session.id)).toEqual([]);
    // And nothing leaked onto any other session in the workspace either.
    const [{ count }] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where workspace_id = ${workspaceId}
        and (type like 'machine.link.%' or type = 'machine.runner.restarted')`;
    expect(count).toBe(0);
  }, 90_000);

  test("a per-session emission failure is ISOLATED: the first session's append rejecting still delivers to the rest + logs the failure", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment, sandbox, bus } = await seed();

    // Two sessions with an active op on the machine. sessionA is created first, so
    // the fan-out's stable order (oldest first) processes it FIRST.
    const mk = async (msg: string) =>
      await createSession(db, {
        accountId,
        workspaceId,
        initialMessage: msg,
        resources: [],
        metadata: {},
        model: "gpt-test",
        sandboxBackend: "modal",
      });
    const sessionA = await mk("a");
    const sessionB = await mk("b");
    await makeActiveOp(
      accountId,
      workspaceId,
      sessionA.id,
      sandbox.id,
      "eeeeeeee-0000-4000-8000-000000000001",
    );
    await makeActiveOp(
      accountId,
      workspaceId,
      sessionB.id,
      sandbox.id,
      "eeeeeeee-0000-4000-8000-000000000002",
    );

    // Rig sessionA's NEXT append to REJECT: pre-occupy its next sequence slot so the
    // unique (workspace, session, sequence) index throws on sessionA's fan-out
    // append — a faithful stand-in for the session-specific / racing-writer failure
    // the isolation must survive. sessionB is untouched.
    const [{ last_sequence: lastSeqA }] = await admin<{ last_sequence: number }[]>`
      select last_sequence from sessions where id = ${sessionA.id}`;
    await admin`
      insert into session_events (account_id, workspace_id, session_id, sequence, type)
      values (${accountId}, ${workspaceId}, ${sessionA.id}, ${lastSeqA + 1}, 'user.message')`;

    // Capture warns; call the handler directly so the per-session log is observable.
    const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const observability = {
      incrementCounter: () => {},
      warn: (message: string, meta?: Record<string, unknown>) => warns.push({ message, meta }),
    } as unknown as Parameters<typeof handleAgentEventPayload>[1];
    const payload = AgentEvent.encode({
      agentId: enrollment.id,
      event: {
        $case: "goingOffline",
        goingOffline: { reason: GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE },
      },
    }).finish();
    await handleAgentEventPayload(
      db,
      observability,
      payload,
      `agent.${workspaceId}.${enrollment.id}.events`,
      bus,
    );

    // sessionA's append rejected → it got NO machine-link events...
    expect(await machineLinkEvents(sessionA.id)).toEqual([]);
    // ...but sessionB, processed AFTER the failure, still received its full set.
    expect((await machineLinkEvents(sessionB.id)).map((e) => e.type)).toEqual([
      "machine.link.lost",
      "machine.runner.restarted",
    ]);
    // ...and the failure is visible in the logs, naming the failed sessionId.
    expect(warns.some((w) => w.meta?.sessionId === sessionA.id)).toBe(true);
  }, 90_000);
});
