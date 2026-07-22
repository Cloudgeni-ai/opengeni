import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createRig,
  createRigVersion,
  getSession,
  type Database,
  type DbClient,
} from "@opengeni/db";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { createSessionForRequest, createValidatedScheduledTask } from "@opengeni/core";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

// M3 rig session binding, driven through the REAL createSessionForRequest
// resolution + real @opengeni/db rig fns against a THROWAWAY postgres (same
// harness shape as sandbox-shared-and-viewer). backend:"none" keeps the create
// path box-free. Covers: freeze-at-create (a later promote never moves an
// existing session), workspace-default fallback, unknown-rig 422, and the
// rig-aware shared-sandbox gate (mirror of the env-aware gate).

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  sandboxBackend: "none",
  sandboxOwnershipEnabled: true,
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});

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

// A rig with an active v1 (createRig seeds version 1 active). Returns rig id +
// the active version id so tests can assert the frozen version.
async function seedRig(
  accountId: string,
  workspaceId: string,
  name: string,
  defaultVariableSetIds: string[] = [],
): Promise<{ rigId: string; activeVersionId: string }> {
  const rig = await createRig(db, {
    accountId,
    workspaceId,
    name,
    createdBy: "user:test",
    initialVersion: { changelog: "v1", defaultVariableSetIds },
  });
  return { rigId: rig.id, activeVersionId: rig.activeVersion!.id };
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
      throw new Error("resumeBoxById should not be called (backend=none)");
    },
  } as unknown as ApiRouteDeps;
}

function grant(
  accountId: string,
  workspaceId: string,
  fromSessionId?: string,
  extraPermissions: Permission[] = [],
): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "subject",
    permissions: ["sessions:create", "sessions:read", ...extraPermissions],
    ...(fromSessionId ? { metadata: { sessionId: fromSessionId } } : {}),
  } as AccessGrant;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("rig-session-binding");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[rig-session-binding] docker unavailable, skipping");
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
}, 180_000);

describe("M3 rig binding: freeze at create", () => {
  test("binds the rig's active version and freezes it — a later promote never moves an existing session", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const { rigId, activeVersionId: v1 } = await seedRig(accountId, workspaceId, "dev");

    const s1 = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "hi",
        rigId,
      },
    );
    expect(s1.rigId).toBe(rigId);
    expect(s1.rigVersionId).toBe(v1);

    // Promote a new active version, then bind a NEW session: it gets v2.
    const v2 = await createRigVersion(
      db,
      workspaceId,
      rigId,
      { changelog: "v2" },
      { activate: true },
    );
    const s2 = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "hi again",
        rigId,
      },
    );
    expect(s2.rigVersionId).toBe(v2.id);

    // The FIRST session is unchanged — it still rides v1.
    const s1Reloaded = await getSession(db, workspaceId, s1.id);
    expect(s1Reloaded?.rigVersionId).toBe(v1);
  }, 60_000);

  test("falls back to the workspace default rig when no rigId is given; explicit rigId overrides the default", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const def = await seedRig(accountId, workspaceId, "default-rig");
    const other = await seedRig(accountId, workspaceId, "other-rig");
    await admin`update workspaces set default_rig_id = ${def.rigId} where id = ${workspaceId}`;

    const defaulted = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "hi",
      },
    );
    expect(defaulted.rigId).toBe(def.rigId);
    expect(defaulted.rigVersionId).toBe(def.activeVersionId);

    const overridden = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "hi",
        rigId: other.rigId,
      },
    );
    expect(overridden.rigId).toBe(other.rigId);
  }, 60_000);

  test("a session with no rig and no workspace default is rig-less (both null)", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const s = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "hi",
    });
    expect(s.rigId).toBeNull();
    expect(s.rigVersionId).toBeNull();
  }, 60_000);

  test("an explicit unknown rigId is a 422", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "hi",
        rigId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toThrow(/unknown rigId/);
  }, 60_000);

  test("an explicit rig with no active version is a 422", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    // Seed a bare rig row with NO versions (bypasses createRig's v1 seeding).
    const [r] = await admin<{ id: string }[]>`
      insert into rigs (account_id, workspace_id, name, created_by)
      values (${accountId}, ${workspaceId}, 'empty', 'user:test') returning id`;
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "hi",
        rigId: r!.id,
      }),
    ).rejects.toThrow(/no active version/);
  }, 60_000);

  test("explicit and workspace-default rig secrets require variable-sets:use", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const [variableSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (account_id, workspace_id, name)
      values (${accountId}, ${workspaceId}, 'rig-secrets') returning id`;
    const rig = await seedRig(accountId, workspaceId, "secret-rig", [variableSet!.id]);

    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "explicit",
        rigId: rig.rigId,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await admin`update workspaces set default_rig_id = ${rig.rigId} where id = ${workspaceId}`;
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "default",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const authorized = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, undefined, ["variable-sets:use"]),
      workspaceId,
      { initialMessage: "authorized", rigId: rig.rigId },
    );
    expect(authorized.rigDefaultVariableSetsAuthorized).toBe(true);
  }, 60_000);

  test("scheduled rig bindings persist variable-set authorization provenance", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const [variableSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (account_id, workspace_id, name)
      values (${accountId}, ${workspaceId}, 'scheduled-rig-secrets') returning id`;
    const rig = await seedRig(accountId, workspaceId, "scheduled-secret-rig", [variableSet!.id]);
    const payload = {
      name: "secret task",
      status: "paused" as const,
      schedule: { type: "interval" as const, everySeconds: 3600 },
      runMode: "new_session_per_run" as const,
      overlapPolicy: "skip" as const,
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      rigId: rig.rigId,
      metadata: {},
    };
    await expect(
      createValidatedScheduledTask({
        settings,
        db,
        objectStorage: null,
        grant: grant(accountId, workspaceId),
        payload,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const authorized = await createValidatedScheduledTask({
      settings,
      db,
      objectStorage: null,
      grant: grant(accountId, workspaceId, undefined, ["variable-sets:use"]),
      payload,
    });
    expect(authorized.rigDefaultVariableSetsAuthorized).toBe(true);
  }, 60_000);
});

describe("M3 rig binding: rig-aware shared-sandbox gate", () => {
  test("shared join with the SAME rig fans into one group", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const { rigId } = await seedRig(accountId, workspaceId, "shared-rig");
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      rigId,
      sandboxBackend: "modal",
    });
    const b = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, a.id),
      workspaceId,
      {
        initialMessage: "b",
        rigId,
        sandbox: "shared",
      },
    );
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
  }, 60_000);

  test("EXPLICIT shared join with a DIFFERENT rig is a 422 at create", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const rigA = await seedRig(accountId, workspaceId, "rig-a");
    const rigB = await seedRig(accountId, workspaceId, "rig-b");
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      rigId: rigA.rigId,
      sandboxBackend: "modal",
    });
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId, a.id), workspaceId, {
        initialMessage: "b",
        rigId: rigB.rigId,
        sandbox: "shared",
      }),
    ).rejects.toThrow(/same rig/);
  }, 60_000);

  test("INHERITED default with a different rig falls back to an own box (different group)", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const rigA = await seedRig(accountId, workspaceId, "rig-a2");
    const rigB = await seedRig(accountId, workspaceId, "rig-b2");
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      rigId: rigA.rigId,
      sandboxBackend: "modal",
    });
    // No explicit `sandbox` → inherited default "shared"; the rig mismatch
    // deterministically separates into the worker's own box.
    const b = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, a.id),
      workspaceId,
      {
        initialMessage: "b",
        rigId: rigB.rigId,
      },
    );
    expect(b.sandboxGroupId).not.toBe(a.sandboxGroupId);
  }, 60_000);

  test("{groupId} join with a different rig than the group is a 422", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const rigA = await seedRig(accountId, workspaceId, "rig-a3");
    const rigB = await seedRig(accountId, workspaceId, "rig-b3");
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      rigId: rigA.rigId,
      sandboxBackend: "modal",
    });
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
        initialMessage: "b",
        rigId: rigB.rigId,
        sandbox: { groupId: a.sandboxGroupId },
      }),
    ).rejects.toThrow(/different rig/);
  }, 60_000);

  test("EXPLICIT shared join rejects a legacy MIXED-rig group deterministically", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const rigA = await seedRig(accountId, workspaceId, "rig-a-mixed");
    const rigB = await seedRig(accountId, workspaceId, "rig-b-mixed");
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      rigId: rigA.rigId,
      sandboxBackend: "modal",
    });
    // Simulate a legacy/corrupt rig-blind share: force a B-rig member row into
    // A's group directly. Today the create gate must compare the joiner against
    // ALL members, not just parent A.
    await admin`
      insert into sessions (account_id, workspace_id, initial_message, rig_id, rig_version_id, sandbox_group_id, model, sandbox_backend)
      values (${accountId}, ${workspaceId}, 'legacy mixed-rig member', ${rigB.rigId}, ${rigB.activeVersionId}, ${a.sandboxGroupId}, 'gpt-test', 'modal')`;
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId, a.id), workspaceId, {
        initialMessage: "joiner matching parent only",
        rigId: rigA.rigId,
        sandbox: "shared",
      }),
    ).rejects.toThrow(/same rig/);
  }, 60_000);

  test("rig-less sessions still share (null rig on both sides is compatible)", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { accountId, workspaceId } = await freshWorkspace();
    const a = await createSessionForRequest(deps(bus), grant(accountId, workspaceId), workspaceId, {
      initialMessage: "a",
      sandboxBackend: "modal",
    });
    const b = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, a.id),
      workspaceId,
      {
        initialMessage: "b",
        sandbox: "shared",
      },
    );
    expect(b.sandboxGroupId).toBe(a.sandboxGroupId);
  }, 60_000);
});
