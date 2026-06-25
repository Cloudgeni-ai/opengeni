import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { testSettings, MemoryEventBus } from "@opengeni/testing";
import {
  signDelegatedAccessToken,
  verifyEnrollmentBearer,
  type Permission,
} from "@opengeni/contracts";
import { createDb, type Database, type DbClient } from "@opengeni/db";
import { migrate } from "../../../packages/db/src/migrate";
import { createApp } from "../src/app";
import type { AppDependencies, SessionWorkflowClient } from "../src/dependencies";

// M5 — the enrollment device-flow ROUTES, driven end-to-end through createApp + the
// REAL packages/db against a THROWAWAY postgres (mirrors sandbox-shared-and-viewer).
// The user-authenticated routes are exercised via an `ogd_` delegated bearer (the
// same path the worker uses), so per-workspace authz + cross-workspace rejection are
// real. Covers: start -> approve -> poll -> EnrollmentCredentials (the signed `oge_`
// bearer); consent capture; unauthenticated-approve REJECTED; cross-workspace
// approve REJECTED; idempotent re-enroll; revoke; flag-OFF -> routes 404.

const CONTAINER = "ogtest-pg-m5-routes";
const PORT = 55460;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL = `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg16";

const DELEGATION_SECRET = "m5-delegation-secret";
const SIGNING_SECRET = "m5-enrollment-signing-secret";

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

// The selfhosted feature ON + a signing secret present + managed mode so the
// delegated bearer path authenticates the user routes.
const settings = testSettings({
  productAccessMode: "managed",
  authRequired: false,
  delegationSecret: DELEGATION_SECRET,
  sandboxSelfhostedEnabled: true,
  enrollmentSigningSecret: SIGNING_SECRET,
  selfhostedNatsUrl: "nats://control.example:4222",
  selfhostedRelayUrl: "wss://relay.example",
  agentUpdatePublicKey: "minisign-pub-key",
});

function appFor(overrides: Partial<AppDependencies> = {}) {
  const noop = async () => {};
  const workflowClient = {
    signalUserMessage: noop, wakeSessionWorkflow: noop, signalApprovalDecision: noop,
    signalInterrupt: noop, syncScheduledTask: noop, deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  const deps: AppDependencies = {
    settings,
    db,
    bus: new MemoryEventBus() as never,
    workflowClient,
    managedAuth: null,
    ...overrides,
  };
  return createApp(deps);
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function bearer(accountId: string, workspaceId: string, permissions: Permission[]): Promise<string> {
  return await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId, workspaceId, subjectId: "user-m5", subjectLabel: "M5 User",
    permissions, exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn(`[enrollment-routes] docker unavailable, skipping: ${String(err)}`);
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

describe("M5 device-flow happy path: start -> approve -> poll -> EnrollmentCredentials", () => {
  test("the full flow lands an enrollment + sandbox and returns a signed bearer", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();

    // 1. START (agent-side, user-unauthenticated).
    const startRes = await app.request("/v1/enrollments/device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: "ed25519:HAPPY", os: "linux", arch: "x86_64",
        machineName: "build-box", canOfferDisplay: true, requestsScreenControl: true,
        workspaceId,
      }),
    });
    expect(startRes.status).toBe(201);
    const start = await startRes.json() as {
      deviceCode: string; userCode: string; verificationUri: string;
      verificationUriComplete: string; intervalSeconds: number; expiresInSeconds: number;
    };
    expect(start.deviceCode).toBeTruthy();
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(start.verificationUri).toContain("/device");
    expect(start.intervalSeconds).toBeGreaterThan(0);

    // 2. POLL before approve → pending.
    const pollPending = await app.request("/v1/enrollments/device/poll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    expect(pollPending.status).toBe(200);
    expect((await pollPending.json() as { state: string }).state).toBe("pending");

    // 3. APPROVE (user-authenticated, workspace-gated) WITH screen control.
    const approveRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}` },
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: true }),
    });
    expect(approveRes.status).toBe(201);
    const approve = await approveRes.json() as { approved: boolean; enrollmentId: string; sandboxId: string; allowScreenControl: boolean };
    expect(approve.approved).toBe(true);
    expect(approve.enrollmentId).toBeTruthy();
    expect(approve.sandboxId).toBeTruthy();
    expect(approve.allowScreenControl).toBe(true);

    // 4. POLL after approve → authorized + EnrollmentCredentials (signed bearer).
    const pollAuth = await app.request("/v1/enrollments/device/poll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    expect(pollAuth.status).toBe(200);
    const poll = await pollAuth.json() as {
      state: string;
      credentials?: {
        agentId: string; workspaceId: string; bearer: string; subjectPrefix: string;
        natsUrls: string[]; relayUrl: string; natsAccountCreds: string; updatePublicKey: string;
        consentedWholeMachine: boolean; consentedScreenControl: boolean;
      };
    };
    expect(poll.state).toBe("authorized");
    expect(poll.credentials).toBeDefined();
    const creds = poll.credentials!;
    expect(creds.agentId).toBe(approve.enrollmentId);
    expect(creds.workspaceId).toBe(workspaceId);
    expect(creds.subjectPrefix).toBe(`agent.${workspaceId}.${approve.enrollmentId}`);
    expect(creds.natsUrls).toEqual(["nats://control.example:4222"]);
    expect(creds.relayUrl).toBe("wss://relay.example");
    expect(creds.natsAccountCreds).toBe(""); // infra-deferred placeholder
    expect(creds.consentedWholeMachine).toBe(true);
    expect(creds.consentedScreenControl).toBe(true);
    // The signed bearer verifies against the signing secret + binds the identity.
    const verified = await verifyEnrollmentBearer(SIGNING_SECRET, creds.bearer);
    expect(verified).not.toBeNull();
    expect(verified!.workspaceId).toBe(workspaceId);
    expect(verified!.agentId).toBe(approve.enrollmentId);
    expect(verified!.subjectPrefix).toBe(creds.subjectPrefix);
  }, 90_000);

  test("screen-control OFF approve → consentedScreenControl false in the credentials", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const start = await (await app.request("/v1/enrollments/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:NOSCREEN", canOfferDisplay: true, requestsScreenControl: true, workspaceId }),
    })).json() as { deviceCode: string; userCode: string };
    await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}` },
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
    });
    const poll = await (await app.request("/v1/enrollments/device/poll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    })).json() as { state: string; credentials?: { consentedScreenControl: boolean; consentedWholeMachine: boolean } };
    expect(poll.state).toBe("authorized");
    expect(poll.credentials!.consentedWholeMachine).toBe(true);
    expect(poll.credentials!.consentedScreenControl).toBe(false);
  }, 90_000);
});

describe("M5 authz: unauthenticated + cross-workspace approve are rejected", () => {
  test("approve with NO bearer is rejected (401)", async () => {
    if (!available) return;
    const { workspaceId } = await freshWorkspace();
    const app = appFor();
    const res = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: "AAAA-BBBB", allowScreenControl: false }),
    });
    expect(res.status).toBe(401);
  }, 60_000);

  test("approve with a bearer lacking enrollments:manage is rejected (403)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const res = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await bearer(accountId, workspaceId, ["sessions:read"])}` },
      body: JSON.stringify({ userCode: "AAAA-BBBB", allowScreenControl: false }),
    });
    expect(res.status).toBe(403);
  }, 60_000);

  test("a workspace-B bearer cannot approve a flow started for workspace A (rejected)", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const app = appFor();
    // Start a flow for workspace A.
    const start = await (await app.request("/v1/enrollments/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:XWS", workspaceId: a.workspaceId }),
    })).json() as { userCode: string };
    // A user authenticated to workspace B tries to approve A's user_code IN B.
    const resInB = await app.request(`/v1/workspaces/${b.workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await bearer(b.accountId, b.workspaceId, ["enrollments:manage"])}` },
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
    });
    // The user_code lookup is workspace-scoped → no pending request in B → 404.
    expect(resInB.status).toBe(404);
    // And a B-bearer cannot reach the A route at all (no grant in A → 403).
    const resCrossRoute = await app.request(`/v1/workspaces/${a.workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await bearer(b.accountId, b.workspaceId, ["enrollments:manage"])}` },
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
    });
    expect(resCrossRoute.status).toBe(403);
  }, 90_000);
});

describe("M5 list + revoke + idempotent re-enroll", () => {
  test("GET /enrollments lists the machine; revoke flips it; re-approve re-activates the SAME machine", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`;

    const start = await (await app.request("/v1/enrollments/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:LIST", machineName: "node-a", workspaceId }),
    })).json() as { deviceCode: string; userCode: string };
    const approve = await (await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST", headers: { "content-type": "application/json", authorization: manageBearer },
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
    })).json() as { enrollmentId: string };

    // LIST shows the machine.
    const listRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments`, { headers: { authorization: manageBearer } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { enrollments: { id: string; status: string; pubkey: string }[] };
    expect(list.enrollments.length).toBe(1);
    expect(list.enrollments[0]!.id).toBe(approve.enrollmentId);
    expect(list.enrollments[0]!.status).toBe("active");

    // REVOKE.
    const revokeRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/${approve.enrollmentId}/revoke`, {
      method: "POST", headers: { authorization: manageBearer },
    });
    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json() as { revoked: boolean }).revoked).toBe(true);
    const activeList = await (await app.request(`/v1/workspaces/${workspaceId}/enrollments?status=active`, { headers: { authorization: manageBearer } })).json() as { enrollments: unknown[] };
    expect(activeList.enrollments.length).toBe(0);

    // Idempotent re-enroll: a NEW device-flow for the SAME pubkey re-activates the
    // SAME enrollment (the M2 upsert) — not a duplicate machine.
    const start2 = await (await app.request("/v1/enrollments/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:LIST", machineName: "node-a", workspaceId }),
    })).json() as { userCode: string };
    const approve2 = await (await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST", headers: { "content-type": "application/json", authorization: manageBearer },
      body: JSON.stringify({ userCode: start2.userCode, allowScreenControl: true }),
    })).json() as { enrollmentId: string };
    expect(approve2.enrollmentId).toBe(approve.enrollmentId); // same machine, re-activated
    const finalList = await (await app.request(`/v1/workspaces/${workspaceId}/enrollments`, { headers: { authorization: manageBearer } })).json() as { enrollments: { status: string }[] };
    expect(finalList.enrollments.length).toBe(1);
    expect(finalList.enrollments[0]!.status).toBe("active");
  }, 120_000);
});

describe("M5 flag gate: selfhosted OFF -> routes 404", () => {
  test("every enrollment route 404s when sandboxSelfhostedEnabled is false", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const offSettings = { ...settings, sandboxSelfhostedEnabled: false };
    const app = appFor({ settings: offSettings });
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`;

    const startRes = await app.request("/v1/enrollments/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:OFF", workspaceId }),
    });
    expect(startRes.status).toBe(404);

    const pollRes = await app.request("/v1/enrollments/device/poll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "anything" }),
    });
    expect(pollRes.status).toBe(404);

    const listRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments`, { headers: { authorization: manageBearer } });
    expect(listRes.status).toBe(404);

    const approveRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST", headers: { "content-type": "application/json", authorization: manageBearer },
      body: JSON.stringify({ userCode: "AAAA-BBBB", allowScreenControl: false }),
    });
    expect(approveRes.status).toBe(404);
  }, 60_000);
});
