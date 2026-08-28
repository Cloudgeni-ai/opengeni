// Stage-D honest label — a session TARGETED at a Connected Machine (a selfhosted
// sandbox) must carry a HOME sandbox_backend of "selfhosted", not the deployment
// cloud default, so the session row + its first turn honestly reflect where the
// agent runs (the Machines dashboard, warm-metering, and the file-download plane
// all key off it). Driven through the REAL createSessionForRequest resolution +
// the REAL seedTargetSandbox swap against a THROWAWAY postgres, with an in-memory
// MemoryEventBus responder answering the liveness ping so the target reads online.
//
// Proves:
//   - a machine-targeted top-level create ⇒ home + first turn sandbox_backend
//     "selfhosted" (the honest label), overriding the "modal" deployment default.
//   - a normal top-level create ⇒ unchanged (the "modal" deployment default).
//   - sandbox_os is derived from the targeted machine's enrollment OS on the SAME
//     guards: a macOS machine target ⇒ 'macos', a linux machine target ⇒ 'linux',
//     and a flags-off create leaves the "linux" default (worker ignores the pointer).
//   - a child of backend:'none' or a boxed (modal) parent, with only
//     targetSandboxId (sandbox + sandboxBackend omitted) ⇒ own selfhosted home,
//     own group, pointer seeded — honest-label, not caller sandboxBackend.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  createDb,
  createEnrollment,
  createSandbox,
  claimEnrollmentConnection,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import type { AccessGrant } from "@opengeni/contracts";
import { createSessionForRequest } from "@opengeni/core";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { withChannelA } from "../src/sandbox/channel-a";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const CONNECTION_INSTANCE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// The deployment default is a REAL cloud backend ("modal"), so the "normal create
// is unchanged" assertion is meaningful (the machine override is the ONLY thing
// that flips the home to "selfhosted"). selfhosted routing on + a relay url so the
// liveness probe path resolves.
const settings = testSettings({
  productAccessMode: "managed",
  sandboxBackend: "modal",
  sandboxOwnershipEnabled: true,
  sandboxSelfhostedEnabled: true,
  // This fixture deliberately has no op-stream connection. Terminal exec must
  // therefore fail before dispatch instead of downgrading to request/reply.
  agentOpStreamEnabled: false,
  sandboxSelfhostedExecTimeoutMs: 30_000,
  selfhostedRelayUrl: "wss://relay.example",
  publicBaseUrl: "https://app.example",
});

/** A MemoryEventBus whose responder answers ping → online for the agent subject
 *  (a stand-in for a real enrolled agent over NATS), so the seed swap's liveness
 *  gate passes without a broker. */
function busWithAgent(opts: { workspaceId: string; agentId: string }): MemoryEventBus {
  const bus = new MemoryEventBus();
  bus.subscribeRequests(
    subjectFor(opts.workspaceId, opts.agentId, CONNECTION_INSTANCE_ID),
    (payload) => {
      const req = ControlRequest.decode(payload);
      const op = req.op;
      const res: ControlResponse =
        op?.$case === "ping"
          ? {
              requestId: req.requestId,
              result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
            }
          : op?.$case === "exec"
            ? {
                requestId: req.requestId,
                result: {
                  $case: "exec",
                  exec: {
                    exitCode: 0,
                    stdout: new TextEncoder().encode("machine-home-ok\n"),
                    stderr: new Uint8Array(0),
                    timedOut: false,
                    durationMs: "1",
                  },
                },
              }
            : {
                requestId: req.requestId,
                error: {
                  code: ErrorCode.ERROR_CODE_UNSUPPORTED,
                  message: "unsupported",
                  retryable: false,
                  detail: {},
                },
              };
      return ControlResponse.encode(res).finish();
    },
  );
  return bus;
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

/** Seed an enrolled, online selfhosted machine (+ its sandbox record) in a fresh
 *  workspace, and return the id + a bus whose responder makes it probe online. */
async function seedMachine(
  os: "linux" | "macos" | "windows" = "linux",
): Promise<{ accountId: string; workspaceId: string; sandboxId: string; bus: MemoryEventBus }> {
  const { accountId, workspaceId } = await freshWorkspace();
  const enrollment = await createEnrollment(db, {
    accountId,
    workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine",
    hasDisplay: true,
    allowScreenControl: true,
    os,
    arch: "x86_64",
  });
  const connection = await claimEnrollmentConnection(db, {
    workspaceId,
    enrollmentId: enrollment.id,
    credentialGeneration: enrollment.credentialGeneration,
    connectionInstanceId: CONNECTION_INSTANCE_ID,
    leaseMs: 60_000,
  });
  expect(connection.claimed).toBe(true);
  // Recent lastSeenAt so a probe-miss would be "reconnecting"; the online responder
  // makes the probe succeed → "online" (the seed swap's attach gate).
  const workspaceRoot = os === "windows" ? "C:/work/project" : "/srv/project";
  await admin`
    update enrollments
    set last_seen_at = now(), workspace_root = ${workspaceRoot}
    where id = ${enrollment.id}
  `;
  const sandbox = await createSandbox(db, {
    accountId,
    workspaceId,
    kind: "selfhosted",
    name: "my-laptop",
    enrollmentId: enrollment.id,
  });
  return {
    accountId,
    workspaceId,
    sandboxId: sandbox.id,
    bus: busWithAgent({ workspaceId, agentId: enrollment.id }),
  };
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

function deps(bus: MemoryEventBus, settingsOverride?: typeof settings): ApiRouteDeps {
  return {
    settings: settingsOverride ?? settings,
    db,
    bus,
    workflowClient: stubWorkflowClient(),
    githubStateSecret: "x",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}) as never,
    resumeBoxById: async () => {
      throw new Error(
        "resumeBoxById should not be called in these tests (no box establish on the create path)",
      );
    },
  } as unknown as ApiRouteDeps;
}

function grant(accountId: string, workspaceId: string, fromSessionId?: string): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "subject",
    permissions: ["sessions:create", "sessions:read"],
    ...(fromSessionId
      ? { metadata: { sessionId: fromSessionId, firstPartyMcpTools: ["session_create"] } }
      : {}),
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("machine-home-backend");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[machine-home-backend] docker unavailable, skipping");
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

describe("Stage-D honest label: machine-targeted home sandbox_backend", () => {
  test("a machine-targeted top-level create ⇒ home + first turn 'selfhosted'", async () => {
    if (!available) return;
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine();
    const session = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "run this on my laptop",
        targetSandboxId: sandboxId,
      },
    );
    // The home is labeled honestly — the machine, not the "modal" deployment default.
    expect(session.sandboxBackend).toBe("selfhosted");
    // A linux machine ⇒ sandbox_os 'linux' (matches the schema default here, but
    // it is now DERIVED from the enrollment, not the column default).
    expect(session.sandboxOs).toBe("linux");
    expect(session.workingDir).toBe("/srv/project");
    // The first turn inherits the same home backend (label is consistent end-to-end).
    const [turnRow] = await admin<{ sandbox_backend: string }[]>`
      select sandbox_backend from session_turns where session_id = ${session.id} limit 1`;
    expect(turnRow?.sandbox_backend).toBe("selfhosted");
  }, 60_000);

  test("a direct terminal command without op-stream fails closed without a phantom lease", async () => {
    if (!available) return;
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine();
    const session = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "run direct commands on my laptop",
        targetSandboxId: sandboxId,
      },
    );

    await expect(
      withChannelA(
        { db, settings, bus },
        {
          accountId,
          workspaceId,
          session,
          subjectId: "subject",
        },
        async ({ service, lease }) => {
          expect(lease).toBeNull();
          return await service.terminalExec({
            command: "echo machine-home-ok",
            cwd: "",
            timeoutMs: 1_000,
            emitStream: false,
          });
        },
      ),
    ).rejects.toThrow(/streaming command protocol required for exec/iu);
    const [leaseCount] = await admin<{ count: string }[]>`
      select count(*)::text as count
      from sandbox_leases
      where workspace_id = ${workspaceId}
        and sandbox_group_id = ${session.sandboxGroupId}`;
    expect(leaseCount?.count).toBe("0");
  }, 60_000);

  test("a macOS machine target ⇒ home sandbox_os 'macos' (derived from the enrollment)", async () => {
    if (!available) return;
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine("macos");
    const session = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "run this on my mac",
        targetSandboxId: sandboxId,
      },
    );
    // The OS axis reflects the targeted machine — NOT the 'linux' schema default.
    expect(session.sandboxBackend).toBe("selfhosted");
    expect(session.sandboxOs).toBe("macos");
    const [row] = await admin<{ sandbox_os: string }[]>`
      select sandbox_os from sessions where id = ${session.id} limit 1`;
    expect(row?.sandbox_os).toBe("macos");
  }, 60_000);

  test("flags off ⇒ machine target leaves the default sandbox_os 'linux' + backend", async () => {
    if (!available) return;
    // A macOS machine target, but ownership/selfhosted routing OFF: the worker
    // ignores the pointer, so the honest-label derivation must NOT fire — the row
    // keeps the deployment backend and the 'linux' default (mirrors the backend guard).
    const flagsOff = testSettings({
      productAccessMode: "managed",
      sandboxBackend: "modal",
      sandboxOwnershipEnabled: false,
      sandboxSelfhostedEnabled: false,
      selfhostedRelayUrl: "wss://relay.example",
      publicBaseUrl: "https://app.example",
    });
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine("macos");
    const session = await createSessionForRequest(
      deps(bus, flagsOff),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "run this on my mac (flags off)",
        targetSandboxId: sandboxId,
      },
    );
    expect(session.sandboxBackend).toBe("modal");
    expect(session.sandboxOs).toBe("linux");
  }, 60_000);

  test("a normal top-level create (no machine target) ⇒ unchanged deployment default", async () => {
    if (!available) return;
    const { accountId, workspaceId, bus } = await seedMachine();
    const session = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "just a normal session",
      },
    );
    // No target ⇒ the "modal" deployment default is untouched (only a machine
    // target flips the home to "selfhosted").
    expect(session.sandboxBackend).toBe("modal");
    const [turnRow] = await admin<{ sandbox_backend: string }[]>`
      select sandbox_backend from session_turns where session_id = ${session.id} limit 1`;
    expect(turnRow?.sandbox_backend).toBe("modal");
  }, 60_000);

  test("a selfhosted-primary own create without a machine target is rejected before persistence", async () => {
    if (!available) return;
    const { accountId, workspaceId, bus } = await seedMachine();
    const selfhostedPrimary = testSettings({
      productAccessMode: "managed",
      sandboxBackend: "selfhosted",
      sandboxOwnershipEnabled: true,
      sandboxSelfhostedEnabled: true,
      selfhostedRelayUrl: "wss://relay.example",
      publicBaseUrl: "https://app.example",
    });
    const [before] = await admin<{ count: string }[]>`
      select count(*)::text as count from sessions where workspace_id = ${workspaceId}`;
    await expect(
      createSessionForRequest(
        deps(bus, selfhostedPrimary),
        grant(accountId, workspaceId),
        workspaceId,
        { initialMessage: "do not create a targetless machine session" },
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: "selfhosted sessions require targetSandboxId; select an online Connected Machine",
    });
    const [after] = await admin<{ count: string }[]>`
      select count(*)::text as count from sessions where workspace_id = ${workspaceId}`;
    expect(after?.count).toBe(before?.count);
  }, 60_000);

  test("a child of a backend:'none' manager with a machine target (sandbox and sandboxBackend omitted) ⇒ own selfhosted home", async () => {
    if (!available) return;
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine();
    const parent = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "manager with no sandbox",
        sandboxBackend: "none",
      },
    );
    expect(parent.sandboxBackend).toBe("none");

    // Documented client path: omit sandbox and sandboxBackend; only name the
    // machine. Honest-label must still win over the "modal" deployment default.
    const child = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, parent.id),
      workspaceId,
      {
        initialMessage: "run the worker on the connected machine",
        targetSandboxId: sandboxId,
      },
    );
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.sandboxBackend).toBe("selfhosted");
    expect(child.sandboxGroupId).toBe(child.id);
    expect(child.sandboxGroupId).not.toBe(parent.sandboxGroupId);
    expect(child.activeSandboxId).toBe(sandboxId);
    const [turnRow] = await admin<{ sandbox_backend: string }[]>`
      select sandbox_backend from session_turns where session_id = ${child.id} limit 1`;
    expect(turnRow?.sandbox_backend).toBe("selfhosted");
  }, 60_000);

  test("a child of a boxed (modal) manager with a machine target (sandbox omitted) ⇒ own selfhosted home, not the parent's group", async () => {
    if (!available) return;
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine();
    const parent = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "manager on the cloud box",
      },
    );
    expect(parent.sandboxBackend).toBe("modal");

    const child = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId, parent.id),
      workspaceId,
      {
        initialMessage: "run the worker on the connected machine",
        targetSandboxId: sandboxId,
      },
    );
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.sandboxBackend).toBe("selfhosted");
    expect(child.sandboxGroupId).toBe(child.id);
    expect(child.sandboxGroupId).not.toBe(parent.sandboxGroupId);
    expect(child.activeSandboxId).toBe(sandboxId);
    const [turnRow] = await admin<{ sandbox_backend: string }[]>`
      select sandbox_backend from session_turns where session_id = ${child.id} limit 1`;
    expect(turnRow?.sandbox_backend).toBe("selfhosted");
  }, 60_000);

  test("explicit sandbox:'shared' plus a machine target ⇒ 422", async () => {
    if (!available) return;
    const { accountId, workspaceId, sandboxId, bus } = await seedMachine();
    const parent = await createSessionForRequest(
      deps(bus),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "manager with no sandbox",
        sandboxBackend: "none",
      },
    );
    await expect(
      createSessionForRequest(deps(bus), grant(accountId, workspaceId, parent.id), workspaceId, {
        initialMessage: "cannot share none and pin a machine",
        sandbox: "shared",
        targetSandboxId: sandboxId,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message:
        "targetSandboxId requires an own sandbox (omit sandbox or pass 'new'); it cannot join a shared group",
    });
  }, 60_000);
});
