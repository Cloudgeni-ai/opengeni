import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Hono } from "hono";
import {
  testSettings,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { MemoryEventBus } from "@opengeni/testing";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  createSession,
  getStreamAcknowledgment,
  readLease,
  recordStreamAcknowledgment,
  revokeViewer,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { createSessionForRequest } from "@opengeni/core";
import { attachViewer } from "../src/sandbox/viewer";
import { registerSessionRoutes } from "../src/routes/sessions";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

// P3.2 — the un-redacted/shared CONSENT GATE + viewer REVOCATION (Phase 3 close).
// Design-of-record 08-implementation-plan.md P3.2 + modules/07-channel-b.md §6 +
// 05-addendum-shared-sandboxes.md E.1 (shared-exposure) + stress (g).
//
//   CONSENT GATE (the desktop-stream / viewer-attach path):
//   - 409 stream_acknowledgment_required until the principal acks the un-redacted
//     pixel plane; then the attach is allowed.
//   - shared box (group >1 session) → 409 shared_acknowledgment_required until the
//     shared-exposure disclosure is acknowledged; then allowed.
//   - sharedSessionIds exposes IDS ONLY: a viewer of A (stream:view, NO
//     sessions:read) is DENIED a cross-session-events probe against B (403).
//   REVOCATION (OD-6 v1):
//   - revokeViewer drops the holder; refcount recomputes; the box drains iff it
//     was the last holder; a turn-held box survives.
//   AUTH:
//   - stream:view gates the desktop-stream (viewer) routes; stream:acknowledge
//     gates the acknowledge route. A principal missing the permission → 403.
//
// Real packages/db lease fns + the REAL route handlers against a THROWAWAY
// postgres (pgvector/pgvector:pg16). Package fns connect as the non-superuser
// opengeni_app (FORCE RLS applies); accounts/workspaces seeded as superuser.

const DELEGATION_SECRET = "p32-delegation-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let app: Hono;

// productAccessMode:"managed" + delegationSecret so a signed delegated token's
// permissions are the grant (the access path builds the grant from the token
// payload — no DB grant lookup, full control over the permission set). backend
// "modal" is desktop-capable so the negotiation read surfaces a real desktop
// cell (shared/acknowledged); sandboxDesktopEnabled + a stream-token secret keep
// it un-degraded. No real provider is touched: warm boxes are PRE-SEEDED so the
// viewer attach takes the ATTACHED path (no establish).
const BACKEND = "modal" as const;
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  sandboxBackend: BACKEND,
  sandboxDesktopEnabled: true,
  // This suite proves desktop consent and holder semantics. Its warm lease is
  // deliberately provider-free, so an unrelated terminal capability probe must
  // not retire that fake descriptor and turn the attach into a Modal cold-create.
  sandboxTerminalEnabled: false,
  streamTokenSecret: "p32-stream-token-secret",
  sandboxOwnershipEnabled: true,
  sandboxLeaseTtlMs: 5_000,
  sandboxViewerHolderTtlMs: 5_000,
  sandboxIdleGraceMs: 500,
});

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

function stubWorkflowClient(): SessionWorkflowClient {
  const noop = async () => {};
  return {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
}

function deps(): ApiRouteDeps {
  return {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: stubWorkflowClient(),
    githubStateSecret: "x",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}) as never,
    resumeBoxById: async () => {
      throw new Error("resumeBoxById should not be called in these tests (backend=none)");
    },
  } as unknown as ApiRouteDeps;
}

// A signed delegated token: the workspace grant IS the token's permission set.
// subjectId scopes the per-principal acknowledgment.
async function bearer(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  permissions: Permission[];
}): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    permissions: input.permissions,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

function url(workspaceId: string, sessionId: string, suffix: string): string {
  return `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}${suffix}`;
}

// Seed a WARM lease row for a session's group (cold->warming CAS then commit
// warm), dropping the seed turn holder so the box is warm with NO holder — the
// viewer attaches via the ATTACHED path (no provider establish needed).
async function seedWarmBox(
  accountId: string,
  workspaceId: string,
  sessionId: string,
  sandboxGroupId: string,
): Promise<void> {
  const acquired = await acquireLease(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    kind: "turn",
    holderId: "seed-turn",
    subjectId: sessionId,
    backend: "none",
    leaseTtlMs: 5_000,
  });
  expect(acquired.role).toBe("spawner");
  const committed = await commitWarmingToWarm(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    expectedEpoch: acquired.lease.leaseEpoch,
    instanceId: "inst-warm",
    dataPlaneUrl: null,
    resumeBackendId: "none",
    resumeState: { backendId: "none" },
    leaseTtlMs: 5_000,
  });
  expect(committed.committed).toBe(true);
  await admin`delete from sandbox_lease_holders where lease_id = (
    select id from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId})
    and kind = 'turn' and holder_id = 'seed-turn'`;
  await admin`update sandbox_leases set refcount = 0, turn_holders = 0
    where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}`;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-consent-gate");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[sandbox-consent-gate] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;

  app = new Hono();
  registerSessionRoutes(app, deps());
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

// A solo session (its own singleton group), warm-boxed and ready to attach.
async function soloSession(): Promise<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sandboxGroupId: string;
}> {
  const { accountId, workspaceId } = await freshWorkspace();
  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "solo",
    resources: [],
    metadata: {},
    model: "m",
    sandboxBackend: BACKEND,
  });
  await seedWarmBox(accountId, workspaceId, session.id, session.sandboxGroupId);
  return {
    accountId,
    workspaceId,
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId,
  };
}

describe("P3.2 consent gate — un-redacted acknowledgment (solo box)", () => {
  test("the desktop-stream path returns 409 stream_acknowledgment_required until acknowledged, then attaches", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId } = await soloSession();
    const auth = await bearer({
      accountId,
      workspaceId,
      subjectId: "viewer-1",
      permissions: ["stream:view", "stream:acknowledge"],
    });

    // (1) Un-acknowledged → 409 stream_acknowledgment_required. The consent gate
    // is scoped to the DESKTOP pixel plane, so the attach declares `desktop:true`
    // (a terminal-only attach is ungated by design).
    const blocked = await app.request(url(workspaceId, sessionId, "/viewers"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ desktop: true }),
    });
    expect(blocked.status).toBe(409);
    // The bare Hono renders HTTPException as plain text (no global JSON error
    // handler in this minimal harness); the status is the contract, the message
    // is the body.
    expect(await blocked.text()).toContain("stream_acknowledgment_required");

    // (2) Acknowledge the un-redacted plane (stream:acknowledge).
    const acked = await app.request(
      url(workspaceId, sessionId, "/stream-capabilities/acknowledge"),
      {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ acknowledgeUnredacted: true }),
      },
    );
    expect(acked.status).toBe(200);
    expect((await acked.json()).acknowledged).toBe(true);

    // (3) Now the desktop attach is allowed (201, a viewer holder on the warm box).
    const allowed = await app.request(url(workspaceId, sessionId, "/viewers"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ desktop: true }),
    });
    expect(allowed.status).toBe(201);
    const attached = await allowed.json();
    expect(attached.liveness).toBe("warm");
    expect(typeof attached.viewerId).toBe("string");
  }, 60_000);

  test("the negotiation read surfaces the principal's acknowledgment state (per-principal)", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId, sandboxGroupId } = await soloSession();
    // Principal X acknowledges; principal Y has not.
    await recordStreamAcknowledgment(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      subjectId: "ack-x",
      acknowledgeUnredacted: true,
      acknowledgeShared: false,
    });
    const x = await getStreamAcknowledgment(db, {
      workspaceId,
      sandboxGroupId,
      subjectId: "ack-x",
    });
    const y = await getStreamAcknowledgment(db, {
      workspaceId,
      sandboxGroupId,
      subjectId: "ack-y",
    });
    expect(x?.acknowledgedUnredacted).toBe(true);
    expect(y).toBeNull();

    const authX = await bearer({
      accountId,
      workspaceId,
      subjectId: "ack-x",
      permissions: ["sessions:read"],
    });
    const authY = await bearer({
      accountId,
      workspaceId,
      subjectId: "ack-y",
      permissions: ["sessions:read"],
    });
    const capsX = await (
      await app.request(url(workspaceId, sessionId, "/stream-capabilities"), {
        headers: { authorization: authX },
      })
    ).json();
    const capsY = await (
      await app.request(url(workspaceId, sessionId, "/stream-capabilities"), {
        headers: { authorization: authY },
      })
    ).json();
    expect(capsX.DesktopStream.acknowledged).toBe(true);
    expect(capsY.DesktopStream.acknowledged).toBe(false);
    // Solo box: not shared, no sibling ids disclosed.
    expect(capsX.DesktopStream.shared).toBe(false);
    expect(capsX.DesktopStream.sharedSessionIds).toEqual([]);
  }, 60_000);
});

describe("P3.2 consent gate — shared-exposure (group >1 session)", () => {
  // A + B share ONE box (B spawned from inside A). The shared-exposure disclosure
  // surfaces the OTHER session's id; attaching to A's desktop requires the SHARED
  // acknowledgment (409 shared_acknowledgment_required until consented).
  async function sharedPair(): Promise<{
    accountId: string;
    workspaceId: string;
    a: string;
    b: string;
    sandboxGroupId: string;
  }> {
    const { accountId, workspaceId } = await freshWorkspace();
    const grant = (fromSessionId?: string) => ({
      accountId,
      workspaceId,
      subjectId: "spawner",
      permissions: ["sessions:create", "sessions:read"] as Permission[],
      ...(fromSessionId ? { metadata: { sessionId: fromSessionId } } : {}),
    });
    const a = await createSessionForRequest(deps(), grant(), workspaceId, {
      initialMessage: "founder",
    });
    const b = await createSessionForRequest(deps(), grant(a.id), workspaceId, {
      initialMessage: "spawned",
    });
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
    await seedWarmBox(accountId, workspaceId, a.id, a.sandboxGroupId);
    return {
      accountId,
      workspaceId,
      a: a.id,
      b: b.id,
      sandboxGroupId: a.sandboxGroupId,
    };
  }

  test("a shared box → 409 shared_acknowledgment_required even after a bare un-redacted ack; shared ack unblocks", async () => {
    if (!available) return;
    const { accountId, workspaceId, a, b } = await sharedPair();
    const auth = await bearer({
      accountId,
      workspaceId,
      subjectId: "viewer-shared",
      permissions: ["stream:view", "stream:acknowledge", "sessions:read"],
    });

    // Negotiation read advertises shared + the OTHER session's id ONLY.
    const caps = await (
      await app.request(url(workspaceId, a, "/stream-capabilities"), {
        headers: { authorization: auth },
      })
    ).json();
    expect(caps.DesktopStream.shared).toBe(true);
    expect(caps.DesktopStream.sharedSessionIds).toEqual([b]);

    // A BARE un-redacted ack is NOT enough for a shared box.
    await app.request(url(workspaceId, a, "/stream-capabilities/acknowledge"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        acknowledgeUnredacted: true,
        acknowledgeShared: false,
      }),
    });
    const blockedShared = await app.request(url(workspaceId, a, "/viewers"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ desktop: true }),
    });
    expect(blockedShared.status).toBe(409);
    expect(await blockedShared.text()).toContain("shared_acknowledgment_required");

    // The SHARED ack unblocks the attach.
    await app.request(url(workspaceId, a, "/stream-capabilities/acknowledge"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        acknowledgeUnredacted: true,
        acknowledgeShared: true,
      }),
    });
    const allowed = await app.request(url(workspaceId, a, "/viewers"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ desktop: true }),
    });
    if (allowed.status !== 201) {
      throw new Error(
        `expected viewer attach 201, received ${allowed.status}: ${await allowed.text()}`,
      );
    }
    expect(allowed.status).toBe(201);
  }, 60_000);

  test("sharedSessionIds exposes IDS ONLY: a viewer of A (stream:view, NO sessions:read) is DENIED a cross-session-events probe on B", async () => {
    if (!available) return;
    const { accountId, workspaceId, b } = await sharedPair();
    // The viewer is authorized to WATCH A (stream:view + stream:acknowledge) but
    // has NO sessions:read — so even knowing B's id (from sharedSessionIds), it
    // cannot subscribe to B's conversation/events.
    const auth = await bearer({
      accountId,
      workspaceId,
      subjectId: "viewer-of-a",
      permissions: ["stream:view", "stream:acknowledge"],
    });

    // Cross-session-events probe against B → 403 (sessions:read missing).
    const probeEvents = await app.request(url(workspaceId, b, "/events"), {
      headers: { authorization: auth },
    });
    expect(probeEvents.status).toBe(403);
    const probeStream = await app.request(url(workspaceId, b, "/events/stream"), {
      headers: { authorization: auth },
    });
    expect(probeStream.status).toBe(403);
    // (Sanity) A holder WITH sessions:read can read B's events.
    const authRead = await bearer({
      accountId,
      workspaceId,
      subjectId: "reader",
      permissions: ["sessions:read"],
    });
    const okEvents = await app.request(url(workspaceId, b, "/events"), {
      headers: { authorization: authRead },
    });
    expect(okEvents.status).toBe(200);
  }, 60_000);
});

describe("P3.2 viewer revocation (OD-6 v1) — holder-drop drains iff last holder", () => {
  test("revokeViewer drops the holder; refcount recomputes; the box drains (was the last holder)", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId, sandboxGroupId } = await soloSession();

    // One viewer attaches (refcount 1).
    const attached = await attachViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        session: {
          id: sessionId,
          sandboxGroupId,
          sandboxBackend: BACKEND,
          sandboxOs: "linux",
        } as never,
        viewerId: "v-only",
      },
    );
    expect(attached.liveness).toBe("warm");
    const before = await readLease(db, workspaceId, sandboxGroupId);
    expect(before?.viewerHolders).toBe(1);
    expect(before?.refcount).toBe(1);

    // Revoke the sole viewer → holder dropped, refcount 0, warm->draining.
    const revoked = await revokeViewer(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      viewerId: "v-only",
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
    expect(revoked?.refcount).toBe(0);
    expect(revoked?.liveness).toBe("draining");
    const after = await readLease(db, workspaceId, sandboxGroupId);
    expect(after?.viewerHolders).toBe(0);
  }, 60_000);

  test("a turn-held box SURVIVES a viewer revoke (refcount recomputes but a turn still holds it)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "turn",
      resources: [],
      metadata: {},
      model: "m",
      sandboxBackend: BACKEND,
    });
    const sandboxGroupId = session.sandboxGroupId;
    // A turn holds the box warm (the spawner path).
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      kind: "turn",
      holderId: "turn-1",
      subjectId: session.id,
      backend: "none",
      leaseTtlMs: 5_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "inst",
      dataPlaneUrl: null,
      resumeBackendId: "none",
      resumeState: { backendId: "none" },
      leaseTtlMs: 5_000,
    });
    // A viewer also attaches (refcount 2: 1 turn + 1 viewer).
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      kind: "viewer",
      holderId: "v-rev",
      subjectId: session.id,
      backend: "none",
      leaseTtlMs: 5_000,
    });
    const two = await readLease(db, workspaceId, sandboxGroupId);
    expect(two?.refcount).toBe(2);

    // Revoke the viewer → its holder drops, BUT the turn holder keeps the box
    // warm (the box is NOT drained — group-refcount liveness, guarded turn_holders).
    const revoked = await revokeViewer(db, {
      accountId,
      workspaceId,
      sandboxGroupId,
      viewerId: "v-rev",
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
    expect(revoked?.refcount).toBe(1);
    expect(revoked?.liveness).toBe("warm");
    const after = await readLease(db, workspaceId, sandboxGroupId);
    expect(after?.turnHolders).toBe(1);
    expect(after?.viewerHolders).toBe(0);
  }, 60_000);

  test("revoke via the route (stream:view) drops the holder", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId, sandboxGroupId } = await soloSession();
    await attachViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        session: {
          id: sessionId,
          sandboxGroupId,
          sandboxBackend: BACKEND,
          sandboxOs: "linux",
        } as never,
        viewerId: "route-viewer",
      },
    );
    const auth = await bearer({
      accountId,
      workspaceId,
      subjectId: "revoker",
      permissions: ["stream:view"],
    });
    const res = await app.request(url(workspaceId, sessionId, "/viewers/route-viewer/revoke"), {
      method: "POST",
      headers: { authorization: auth },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refcount).toBe(0);
    const after = await readLease(db, workspaceId, sandboxGroupId);
    expect(after?.viewerHolders).toBe(0);
  }, 60_000);
});

describe("P3.2 route auth (stream:view / stream:acknowledge)", () => {
  test("the viewer-attach (desktop-stream) path requires stream:view — sessions:read alone is 403", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId } = await soloSession();
    // sessions:read is NOT enough for the un-redacted pixel plane.
    const readOnly = await bearer({
      accountId,
      workspaceId,
      subjectId: "ro",
      permissions: ["sessions:read"],
    });
    const denied = await app.request(url(workspaceId, sessionId, "/viewers"), {
      method: "POST",
      headers: { authorization: readOnly, "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);
  }, 60_000);

  test("the acknowledge route requires stream:acknowledge — stream:view alone is 403", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId } = await soloSession();
    const viewOnly = await bearer({
      accountId,
      workspaceId,
      subjectId: "vo",
      permissions: ["stream:view"],
    });
    const denied = await app.request(
      url(workspaceId, sessionId, "/stream-capabilities/acknowledge"),
      {
        method: "POST",
        headers: {
          authorization: viewOnly,
          "content-type": "application/json",
        },
        body: JSON.stringify({ acknowledgeUnredacted: true }),
      },
    );
    expect(denied.status).toBe(403);
  }, 60_000);

  test("the revoke route requires stream:view — sessions:read alone is 403", async () => {
    if (!available) return;
    const { accountId, workspaceId, sessionId } = await soloSession();
    const readOnly = await bearer({
      accountId,
      workspaceId,
      subjectId: "ro2",
      permissions: ["sessions:read"],
    });
    const denied = await app.request(url(workspaceId, sessionId, "/viewers/whatever/revoke"), {
      method: "POST",
      headers: { authorization: readOnly },
    });
    expect(denied.status).toBe(403);
  }, 60_000);
});
