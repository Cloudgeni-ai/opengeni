import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
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
  getSession,
  reapStaleLeaseHolders,
  readLease,
  type Database,
  type DbClient,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { createSessionForRequest } from "@opengeni/core";
import {
  establishSandboxSessionFromEnvelope,
  SandboxResumeStateUnavailableError,
  serializeEstablishedSandboxEnvelope,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import {
  attachViewer,
  detachViewer,
  ensureSessionGroupReady,
  heartbeatViewer,
} from "../src/sandbox/viewer";
import { withChannelA } from "../src/sandbox/channel-a";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

// P1.4 — the shared-sandbox MCP surface (create-session resolution) + the
// API-direct viewer-holder lifecycle, driven through the REAL packages/db lease
// fns + the REAL createSessionForRequest resolution against a THROWAWAY postgres
// (pgvector/pgvector:pg16, the 0000_initial CREATE EXTENSION vector). Mirrors the
// sandbox-leases harness: package fns connect as the NON-superuser opengeni_app
// (so FORCE RLS applies); accounts/workspaces are seeded as the superuser.
//
//   SHARED:
//   - A("new") then B("shared"/{groupId:A's group}) fan into ONE lease row.
//   - the default rule: MCP-from-session ⇒ shared, top-level ⇒ new.
//   - cross-workspace {groupId} → 404 (the mandatory-workspaceId assertion).
//   - "shared" from top-level ⇒ 422.
//   VIEWER:
//   - a viewer holder keeps a warm box alive with NO turn running; the reaper
//     does NOT terminate it.
//   - release the viewer → the reaper drains/terminates.
//   - heartbeat refreshes the holder; a stale-epoch heartbeat is rejected.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const seededLocalBoxes: EstablishedSandboxSession[] = [];

// The settings the create path + the viewer path read. sandboxBackend:"none"
// keeps the resolution tests box-free (no real provider); the warm-box viewer
// tests pre-seed a WARM lease so the holder attaches without an establish.
const settings = testSettings({
  sandboxBackend: "none",
  sandboxOwnershipEnabled: true,
  // Tight cadence so the reaper drains a released box quickly in-test.
  sandboxLeaseTtlMs: 1_000,
  sandboxViewerHolderTtlMs: 1_000,
  sandboxIdleGraceMs: 500,
  // env-aware grouping tests attach a workspace Environment/Variable Set at create.
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});

/** A workspace Variable Set row (no variables needed — grouping compares ids). */
async function freshEnvironment(accountId: string, workspaceId: string): Promise<string> {
  const [e] = await admin<{ id: string }[]>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${accountId}, ${workspaceId}, 'env') returning id`;
  return e!.id;
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

// A stub workflowClient — the create path only calls wakeSessionWorkflow.
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

function deps(bus: MemoryEventBus): ApiRouteDeps {
  return {
    settings,
    db,
    bus,
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

// A grant. `fromSessionId` simulates the worker-signed sessionId claim that
// createSessionForRequest reads as the parent (the from-inside-a-session case).
function grant(accountId: string, workspaceId: string, fromSessionId?: string): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "subject",
    permissions: ["sessions:create", "sessions:read"],
    ...(fromSessionId ? { metadata: { sessionId: fromSessionId } } : {}),
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-shared-and-viewer");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[sandbox-shared-and-viewer] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  for (const established of seededLocalBoxes.splice(0)) {
    await closeSeedBox(established);
  }
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
});

describe("P1.4 shared-sandbox create resolution (real createSessionForRequest + RLS)", () => {
  test("top-level create (no parent claim) ⇒ 'new' (its own singleton group; group ≡ id)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    const session = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "hello",
      },
    );
    // Singleton group: sandbox_group_id == the new session's own id.
    expect(session.sandboxGroupId).toBe(session.id);
    expect(session.parentSessionId).toBeNull();
  }, 60_000);

  test("from-inside-a-session (parent claim) ⇒ default 'shared' (joins the creator's group)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    // A: the creator/founder (top-level).
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "founder",
    });
    // B: spawned FROM INSIDE A (the worker-signed sessionId claim == A.id),
    // sandbox OMITTED ⇒ default 'shared' (I10/OD-S1 default rule).
    const b = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, a.id),
      workspaceId,
      {
        initialMessage: "spawned",
      },
    );
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
    expect(b.parentSessionId).toBe(a.id);
    // Distinct sessions, same group (one box, two conversations).
    expect(b.id).not.toBe(a.id);
  }, 60_000);

  test("explicit 'new' from inside a session opts OUT of sharing", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "founder",
    });
    const b = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, a.id),
      workspaceId,
      {
        initialMessage: "private",
        sandbox: "new",
      },
    );
    expect(b.sandboxGroupId).toBe(b.id);
    expect(b.sandboxGroupId).not.toBe(a.sandboxGroupId);
  }, 60_000);

  test("'shared' from a top-level grant (no parent) ⇒ 422", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "x",
        sandbox: "shared",
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 60_000);

  test("targetSandboxId is consumed (seedTargetSandbox path) — rejects on a backend:'none' session", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    // Create-time machine targeting (A-2a): a named targetSandboxId seeds the
    // active-sandbox pointer inside createAndStartSession. The harness settings
    // pin sandboxBackend:"none", so the seed guard fires — proving the payload
    // field actually reaches finishStartSession's seedTargetSandbox (not parsed
    // away). The ownership/liveness validation for a real target is covered by
    // the swapActiveSandbox / setActiveSandbox enrollment tests.
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "pin to a machine",
        targetSandboxId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 60_000);

  test("ENV-AWARE: inherited default with a DIFFERENT environment falls back to an OWN box (break mode 1 dissolved)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const environmentId = await freshEnvironment(accountId, workspaceId);
    const bus = new MemoryEventBus();
    // A: credential-less manager (top-level, no environment) on a REAL backend
    // (the boxless backend:"none" is exempt from the env-aware check).
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "manager",
      sandboxBackend: "modal",
    });
    // B: credentialed worker spawned FROM INSIDE A, sandbox OMITTED. The old
    // env-blind default joined A's box and the first turn died on the SDK's
    // manifest-env guard; env-aware grouping gives B its own box instead.
    const g = {
      ...grant(accountId, workspaceId, a.id),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    const b = await createSessionForRequest(deps(bus), g, workspaceId, {
      initialMessage: "worker",
      environmentId,
    });
    expect(b.parentSessionId).toBe(a.id);
    expect(b.sandboxGroupId).toBe(b.id); // own singleton box, NOT a's group
    expect(b.sandboxGroupId).not.toBe(a.sandboxGroupId);
  }, 60_000);

  test("ENV-AWARE: inherited default with the SAME environment still shares", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const environmentId = await freshEnvironment(accountId, workspaceId);
    const bus = new MemoryEventBus();
    const g0 = {
      ...grant(accountId, workspaceId),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    const a = await createSessionForRequest(deps(bus), g0, workspaceId, {
      initialMessage: "credentialed founder",
      environmentId,
      sandboxBackend: "modal",
    });
    const g1 = {
      ...grant(accountId, workspaceId, a.id),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    const b = await createSessionForRequest(deps(bus), g1, workspaceId, {
      initialMessage: "same-env sibling",
      environmentId,
    });
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
  }, 60_000);

  test("ENV-AWARE: EXPLICIT 'shared' with a different environment ⇒ 422 at create (not a dead first turn)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const environmentId = await freshEnvironment(accountId, workspaceId);
    const bus = new MemoryEventBus();
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "manager",
      sandboxBackend: "modal",
    });
    const g = {
      ...grant(accountId, workspaceId, a.id),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    await expect(
      createSessionForRequest(deps(bus), g, workspaceId, {
        initialMessage: "worker",
        environmentId,
        sandbox: "shared",
      }),
    ).rejects.toThrow(/same environment/);
  }, 60_000);

  test("ENV-AWARE: {groupId} join with a different environment ⇒ 422 at create", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const environmentId = await freshEnvironment(accountId, workspaceId);
    const bus = new MemoryEventBus();
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "founder",
      sandboxBackend: "modal",
    });
    const g = {
      ...grant(accountId, workspaceId),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    await expect(
      createSessionForRequest(deps(bus), g, workspaceId, {
        initialMessage: "joiner",
        environmentId,
        sandbox: { groupId: a.sandboxGroupId! },
      }),
    ).rejects.toThrow(/different environment/);
  }, 60_000);

  test("ENV-AWARE: a legacy MIXED-env group rejects a {groupId} join DETERMINISTICALLY (all members compared)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const environmentId = await freshEnvironment(accountId, workspaceId);
    const bus = new MemoryEventBus();
    // Founder: credential-less.
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "founder",
      sandboxBackend: "modal",
    });
    // Simulate a LEGACY env-blind share: force an env-carrying member row into
    // A's group directly (the env-aware check would refuse this today).
    await admin`
      insert into sessions (account_id, workspace_id, initial_message, variable_set_id, sandbox_group_id, model, sandbox_backend)
      values (${accountId}, ${workspaceId}, 'legacy env-blind member', ${environmentId}, ${a.sandboxGroupId}, 'gpt-test', 'modal')`;
    const g = {
      ...grant(accountId, workspaceId),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    // A joiner matching EITHER member must reject: the group is mixed, so no
    // environment matches ALL members — the verdict cannot depend on which
    // member an arbitrary single-row read happens to return.
    await expect(
      createSessionForRequest(deps(bus), g, workspaceId, {
        initialMessage: "joiner with the env",
        environmentId,
        sandbox: { groupId: a.sandboxGroupId! },
      }),
    ).rejects.toThrow(/different environment/);
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "joiner without an env",
        sandbox: { groupId: a.sandboxGroupId! },
      }),
    ).rejects.toThrow(/different environment/);
  }, 60_000);

  test("ENV-AWARE EXEMPTION: a boxless backend:'none' parent SHARES with an env-differing child (no box ⇒ no conflict)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const environmentId = await freshEnvironment(accountId, workspaceId);
    const bus = new MemoryEventBus();
    // Boxless parent (the harness default backend is "none").
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "boxless manager",
    });
    expect(a.sandboxBackend).toBe("none");
    const g = {
      ...grant(accountId, workspaceId, a.id),
      permissions: [
        "sessions:create",
        "sessions:read",
        "environments:use",
      ] as AccessGrant["permissions"],
    };
    // Env-carrying child, sandbox OMITTED: with no box there is no shared box
    // state — the pre-env-aware sharing behavior (and the inherited "none"
    // backend) must be preserved, NOT a silent fallback onto a billable cloud box.
    const b = await createSessionForRequest(deps(bus), g, workspaceId, {
      initialMessage: "env child of boxless parent",
      environmentId,
    });
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
    expect(b.sandboxBackend).toBe("none");
    // The explicit form shares too (nothing to conflict with).
    const c = await createSessionForRequest(deps(bus), g, workspaceId, {
      initialMessage: "explicit shared env child",
      environmentId,
      sandbox: "shared",
    });
    expect(c.sandboxGroupId).toBe(a.sandboxGroupId);
  }, 60_000);

  test("{groupId} explicit join (I13/OD-S5) ⇒ same group as the sibling", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    // Manager spawns A (top-level, its own group), reads A.sandboxGroupId, then
    // fans B into A's group via the explicit {groupId} join.
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      sandbox: "new",
    });
    const b = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "b",
      sandbox: { groupId: a.sandboxGroupId },
    });
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
  }, 60_000);

  test("cross-workspace {groupId} join ⇒ 404 (the mandatory-workspaceId boundary, stress e)", async () => {
    if (!available) return;
    const ws1 = await freshWorkspace();
    const ws2 = await freshWorkspace();
    const bus = new MemoryEventBus();
    // A lives in ws1.
    const a = await createSessionForRequest(
      deps(bus),
      grant(ws1.accountId, ws1.workspaceId),
      ws1.workspaceId,
      {
        initialMessage: "a",
      },
    );
    // A caller in ws2 tries to join A's group by uuid → the RLS-scoped
    // getAnySessionInGroup returns null → 404. The group uuid is NOT an access
    // boundary; the workspace filter is.
    await expect(
      createSessionForRequest(deps(bus), grant(ws2.accountId, ws2.workspaceId), ws2.workspaceId, {
        initialMessage: "b",
        sandbox: { groupId: a.sandboxGroupId },
      }),
    ).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  test("a shared spawn fans into ONE lease row (refcount across sessions)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const bus = new MemoryEventBus();
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "founder",
    });
    const b = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, a.id),
      workspaceId,
      {
        initialMessage: "spawned",
      },
    );
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);

    // Both sessions acquire a holder on the GROUP lease (kind 'viewer' here just
    // to exercise the fan-in without an establish). Refcount counts BOTH.
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: a.sandboxGroupId,
      kind: "viewer",
      holderId: "h-a",
      subjectId: a.id,
      backend: "none",
      leaseTtlMs: 5_000,
    });
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: b.sandboxGroupId,
      kind: "viewer",
      holderId: "h-b",
      subjectId: b.id,
      backend: "none",
      leaseTtlMs: 5_000,
    });
    const [rowCount] = await admin<{ n: number }[]>`
      select count(*)::int as n from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${a.sandboxGroupId}`;
    expect(rowCount!.n).toBe(1);
    const lease = await readLease(db, workspaceId, a.sandboxGroupId);
    expect(lease?.refcount).toBe(2);
  }, 60_000);
});

// Seed a real local WARM lease (cold->warming, provider establish, serialized
// resume state, then commit), then remove only its modern recovery projection to
// model a legacy warm row. The viewer ATTACHED path must prove provider existence
// and command readiness rather than trusting either `warm` or a provider id.
async function seedWarmBox(
  accountId: string,
  workspaceId: string,
): Promise<{
  sandboxGroupId: string;
  leaseEpoch: number;
  sessionId: string;
  established: EstablishedSandboxSession;
}> {
  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "warm",
    resources: [],
    metadata: {},
    model: "m",
    sandboxBackend: "local",
  });
  const sandboxGroupId = session.sandboxGroupId;
  // Spawner acquires (cold->warming), then commit warm with a (null) envelope.
  const acquired = await acquireLease(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    kind: "turn",
    holderId: "seed-turn",
    subjectId: session.id,
    backend: "local",
    leaseTtlMs: 5_000,
  });
  expect(acquired.role).toBe("spawner");
  const established = await establishSandboxSessionFromEnvelope(settings, null, {
    sessionId: session.id,
    recovery: "create-or-restore",
    backendOverride: "local",
  });
  seededLocalBoxes.push(established);
  const resumeState = await serializeEstablishedSandboxEnvelope(established);
  const committed = await commitWarmingToWarm(db, {
    accountId,
    workspaceId,
    sandboxGroupId,
    expectedEpoch: acquired.lease.leaseEpoch,
    instanceId: established.instanceId,
    dataPlaneUrl: null,
    resumeBackendId: established.backendId,
    resumeState,
    leaseTtlMs: 5_000,
  });
  expect(committed.committed).toBe(true);
  await admin`update sandbox_leases
    set resume_state = resume_state - 'opengeniRecovery'
    where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}`;
  // Drop the seed turn holder so the box is warm with NO turn — a viewer-only
  // candidate for draining once no viewer holds it.
  // (Use release via a fresh acquire/release would re-warm; instead delete the
  // holder directly so refcount goes to 0 but we keep it warm for the attach.)
  await admin`delete from sandbox_lease_holders where lease_id = (
    select id from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId})
    and kind = 'turn' and holder_id = 'seed-turn'`;
  await admin`update sandbox_leases set refcount = 0, turn_holders = 0
    where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}`;
  return {
    sandboxGroupId,
    leaseEpoch: committed.lease!.leaseEpoch,
    sessionId: session.id,
    established,
  };
}

async function closeSeedBox(established: EstablishedSandboxSession): Promise<void> {
  const session = established.session as { close?: () => Promise<void>; closed?: boolean };
  if (session.close && !session.closed) await session.close().catch(() => undefined);
}

describe("P1.4 API-direct viewer-holder lifecycle (real lease + reaper)", () => {
  test("attached Channel-A path with instance_id but null resume_state fails closed and preserves the keeper", async () => {
    if (!available) return;
    const localSettings = testSettings({
      sandboxBackend: "local",
      sandboxOwnershipEnabled: true,
      sandboxLeaseTtlMs: 5_000,
      sandboxIdleGraceMs: 500,
    });
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "channel-a null resume",
      resources: [],
      metadata: {},
      model: "m",
      sandboxBackend: "local",
    });
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: "channel-a-keeper",
      subjectId: session.id,
      backend: "local",
      leaseTtlMs: localSettings.sandboxLeaseTtlMs,
    });
    expect(acquired.role).toBe("spawner");
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "channel-a-box-null-resume",
      resumeBackendId: "unix_local",
      resumeState: null,
      leaseTtlMs: localSettings.sandboxLeaseTtlMs,
    });
    expect(committed.committed).toBe(true);

    let caught: unknown;
    try {
      await withChannelA(
        { db, settings: localSettings, bus: new MemoryEventBus() },
        {
          accountId,
          workspaceId,
          session: session as never,
          subjectId: "channel-a-test",
        },
        async () => "unreachable",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxResumeStateUnavailableError);
    const after = await readLease(db, workspaceId, session.sandboxGroupId);
    expect(after).toMatchObject({
      liveness: "warm",
      refcount: 1,
      turnHolders: 1,
      viewerHolders: 0,
      leaseEpoch: committed.lease!.leaseEpoch,
      instanceId: "channel-a-box-null-resume",
    });
    const [keeper] = await admin<{ holder_id: string }[]>`
      select holder_id from sandbox_lease_holders
      where lease_id = ${committed.lease!.id}`;
    expect(keeper?.holder_id).toBe("channel-a-keeper");
  }, 60_000);

  test("a viewer holder keeps a WARM box alive with NO turn running; the reaper does NOT terminate it", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { sandboxGroupId, sessionId } = await seedWarmBox(accountId, workspaceId);
    const session = await getSession(db, workspaceId, sessionId);
    expect(session).toBeTruthy();
    const legacy = await readLease(db, workspaceId, sandboxGroupId);
    expect(legacy?.liveness).toBe("warm");
    expect(legacy?.recovery.provider.status).toBe("unknown");
    expect(legacy?.recovery.workspace.status).toBe("unknown");

    const attached = await attachViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        session: session!,
      },
    );
    expect(attached.liveness).toBe("warm");
    const lease0 = await readLease(db, workspaceId, sandboxGroupId);
    expect(lease0?.viewerHolders).toBe(1);
    expect(lease0?.turnHolders).toBe(0);
    expect(lease0?.leaseEpoch).toBe(legacy?.leaseEpoch);
    expect(lease0?.recovery).toMatchObject({
      provider: { status: "exists", instanceId: legacy?.instanceId },
      restore: { status: "not_required" },
      workspace: { status: "ready", verifiedRevision: null },
    });

    // Refresh the viewer holder so its heartbeat stays fresh across the sweep,
    // then run the reaper. With a live viewer holder the box must NOT drain.
    await heartbeatViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        sandboxGroupId,
        viewerId: attached.viewerId,
        expectedEpoch: attached.leaseEpoch,
      },
    );
    const swept = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: settings.sandboxViewerHolderTtlMs,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
    expect(swept.drained.length).toBe(0);
    const lease1 = await readLease(db, workspaceId, sandboxGroupId);
    expect(lease1?.liveness).toBe("warm");
    expect(lease1?.viewerHolders).toBe(1);
  }, 60_000);

  test("fleet readiness returns a live viewer hold until its route owner releases it", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { sandboxGroupId, sessionId } = await seedWarmBox(accountId, workspaceId);
    const session = await getSession(db, workspaceId, sessionId);
    const hold = await ensureSessionGroupReady(
      { db, settings },
      { accountId, workspaceId, session: session! },
    );

    expect(hold.lease.liveness).toBe("warm");
    const held = await readLease(db, workspaceId, sandboxGroupId);
    expect(held).toMatchObject({
      liveness: "warm",
      viewerHolders: 1,
      refcount: 1,
      recovery: { provider: { status: "exists" }, workspace: { status: "ready" } },
    });

    await hold.release();
    await hold.release();
    const released = await readLease(db, workspaceId, sandboxGroupId);
    expect(released).toMatchObject({ liveness: "draining", viewerHolders: 0, refcount: 0 });
  }, 60_000);

  test("releasing the viewer → the reaper drains the box (liveness = turn OR viewer)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { sandboxGroupId, sessionId } = await seedWarmBox(accountId, workspaceId);
    const session = await getSession(db, workspaceId, sessionId);
    const attached = await attachViewer(
      { db, settings },
      { accountId, workspaceId, session: session! },
    );

    // Detach the viewer → refcount 0, warm->draining (guarded turn_holders=0).
    const released = await detachViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        sandboxGroupId,
        viewerId: attached.viewerId,
      },
    );
    expect(released?.liveness).toBe("draining");
    expect(released?.refcount).toBe(0);

    // Wait out the drain grace, then sweep: the box is surfaced as drainable.
    await new Promise((r) => setTimeout(r, settings.sandboxIdleGraceMs + 200));
    const swept = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: settings.sandboxViewerHolderTtlMs,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
    expect(swept.drained.map((d) => d.sandboxGroupId)).toContain(sandboxGroupId);
  }, 60_000);

  test("a stale viewer holder (no heartbeat) is TTL-reaped → the box drains", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { sandboxGroupId, sessionId } = await seedWarmBox(accountId, workspaceId);
    const session = await getSession(db, workspaceId, sessionId);
    const attached = await attachViewer(
      { db, settings },
      { accountId, workspaceId, session: session! },
    );
    expect(attached.liveness).toBe("warm");

    // Do NOT heartbeat. Wait past the viewer-holder TTL, then sweep: the stale
    // viewer holder is reaped, refcount → 0, the box enters draining.
    await new Promise((r) => setTimeout(r, settings.sandboxViewerHolderTtlMs + 200));
    const swept = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: settings.sandboxViewerHolderTtlMs,
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
    expect(swept.reapedViewers).toBeGreaterThanOrEqual(1);
    const lease = await readLease(db, workspaceId, sandboxGroupId);
    expect(lease?.viewerHolders).toBe(0);
  }, 60_000);

  test("a stale-epoch viewer heartbeat is rejected (the split-brain fence)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const { sandboxGroupId, leaseEpoch, sessionId } = await seedWarmBox(accountId, workspaceId);
    const session = await getSession(db, workspaceId, sessionId);
    const attached = await attachViewer(
      { db, settings },
      { accountId, workspaceId, session: session! },
    );
    // A heartbeat on the WRONG (superseded) epoch is rejected.
    const stale = await heartbeatViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        sandboxGroupId,
        viewerId: attached.viewerId,
        expectedEpoch: leaseEpoch + 99,
      },
    );
    expect(stale).toBe(false);
    // A heartbeat on the CURRENT epoch succeeds.
    const fresh = await heartbeatViewer(
      { db, settings },
      {
        accountId,
        workspaceId,
        sandboxGroupId,
        viewerId: attached.viewerId,
        expectedEpoch: attached.leaseEpoch,
      },
    );
    expect(fresh).toBe(true);
  }, 60_000);
});

// ── GATED live-Modal viewer-keep-warm (opt-in) ──────────────────────────────
// A viewer holder keeps a REAL Modal box alive with no turn, then release → the
// reaper drains it. Skips without Modal creds. The box is terminated in finally.

function hasModalCredentials(): boolean {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) return true;
  const tomlPath = join(homedir(), ".modal.toml");
  if (!existsSync(tomlPath)) return false;
  let toml: string;
  try {
    toml = readFileSync(tomlPath, "utf8");
  } catch {
    return false;
  }
  const wantedProfile = process.env.MODAL_PROFILE;
  for (const section of toml.split(/\n(?=\[)/)) {
    const nameMatch = /^\[([^\]]+)\]/.exec(section.trimStart());
    if (!nameMatch) continue;
    const hasTokenId = /\btoken_id\s*=/.test(section);
    const isActive = /\bactive\s*=\s*true\b/.test(section);
    if (!hasTokenId) continue;
    if (wantedProfile ? nameMatch[1] === wantedProfile : isActive) return true;
  }
  return false;
}

const liveGate = process.env.OPENGENI_P14_LIVE_MODAL === "1" && hasModalCredentials();

describe("P1.4 GATED live-Modal viewer-keep-warm (opt-in)", () => {
  test.skipIf(!liveGate)(
    "a viewer holder keeps a real Modal box warm with no turn, then release → reaper drains",
    async () => {
      if (!available) return;
      const { createApiSandboxClient } = await import("../src/sandbox/access");
      const liveSettings = testSettings({
        sandboxBackend: "modal",
        sandboxOwnershipEnabled: true,
        modalAppName: process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-p14-viewer-keepwarm",
        modalImageRef: process.env.OPENGENI_MODAL_SMOKE_IMAGE ?? "python:3.12-slim",
        modalTimeoutSeconds: 600,
        modalIdleTimeoutSeconds: 300,
        sandboxLeaseTtlMs: 60_000,
        sandboxViewerHolderTtlMs: 60_000,
        sandboxIdleGraceMs: 1_000,
      });
      const { accountId, workspaceId } = await freshWorkspace();
      const modalClient = createApiSandboxClient(liveSettings) as unknown as {
        backendId: string;
        create(args?: unknown): Promise<{
          state?: unknown;
          delete?: () => Promise<void>;
          running?: () => Promise<boolean>;
        }>;
        serializeSessionState(state: unknown): Promise<Record<string, unknown>>;
      };
      const session = await createSession(db, {
        accountId,
        workspaceId,
        initialMessage: "live",
        resources: [],
        metadata: {},
        model: "m",
        sandboxBackend: "modal",
      });

      let box: Awaited<ReturnType<typeof modalClient.create>> | null = null;
      try {
        // Create a real box + fold its envelope onto the group lease (a warm box).
        box = await modalClient.create();
        const resumeState = await modalClient.serializeSessionState(box.state);
        const acquired = await acquireLease(db, {
          accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          kind: "turn",
          holderId: "live-seed",
          subjectId: session.id,
          backend: "modal",
          leaseTtlMs: 60_000,
        });
        await commitWarmingToWarm(db, {
          accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          expectedEpoch: acquired.lease.leaseEpoch,
          instanceId: "live",
          dataPlaneUrl: null,
          resumeBackendId: "modal",
          resumeState,
          leaseTtlMs: 60_000,
        });
        await admin`delete from sandbox_lease_holders where holder_id = 'live-seed'`;
        await admin`update sandbox_leases set refcount=0, turn_holders=0
          where workspace_id=${workspaceId} and sandbox_group_id=${session.sandboxGroupId}`;

        // A viewer attaches (ATTACHED path, box already warm) and keeps it alive.
        const attached = await attachViewer(
          { db, settings: liveSettings },
          { accountId, workspaceId, session },
        );
        expect(attached.liveness).toBe("warm");
        expect(await box.running?.()).toBe(true);

        // Detach → drain → the box is surfaced drainable after the grace.
        await detachViewer(
          { db, settings: liveSettings },
          {
            accountId,
            workspaceId,
            sandboxGroupId: session.sandboxGroupId,
            viewerId: attached.viewerId,
          },
        );
        await new Promise((r) => setTimeout(r, liveSettings.sandboxIdleGraceMs + 500));
        const swept = await reapStaleLeaseHolders(db, {
          workspaceId,
          viewerHolderTtlMs: liveSettings.sandboxViewerHolderTtlMs,
          idleGraceMs: liveSettings.sandboxIdleGraceMs,
        });
        expect(swept.drained.map((d) => d.sandboxGroupId)).toContain(session.sandboxGroupId);
      } finally {
        try {
          await box?.delete?.();
        } catch (error) {
          console.error(
            `[p14 live teardown] ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
    300_000,
  );

  test.skipIf(liveGate)(
    "live-Modal viewer-keep-warm is skipped without OPENGENI_P14_LIVE_MODAL=1 + creds",
    () => {
      expect(liveGate).toBe(false);
    },
  );
});
