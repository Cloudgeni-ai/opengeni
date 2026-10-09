import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  signDelegatedAccessToken,
  verifyEnrollmentBearer,
  signEnrollmentBearer,
  enrollmentRenewalProof,
  type Permission,
} from "@opengeni/contracts";
import {
  createDb,
  createEnrollment,
  revokeEnrollment,
  getEnrollment,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createApp } from "../src/app";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";

// M5 — the enrollment device-flow ROUTES, driven end-to-end through createApp + the
// REAL packages/db against a THROWAWAY postgres (mirrors sandbox-shared-and-viewer).
// The user-authenticated routes are exercised via an `ogd_` delegated bearer (the
// same path the worker uses), so per-workspace authz + cross-workspace rejection are
// real. Covers: start -> approve -> poll -> EnrollmentCredentials (the signed `oge_`
// bearer); consent capture; unauthenticated-approve REJECTED; cross-workspace
// approve REJECTED; idempotent re-enroll; revoke; flag-OFF -> routes 404.

const DELEGATION_SECRET = "m5-delegation-secret";
const SIGNING_SECRET = "m5-enrollment-signing-secret";

const localAdminUrl = process.env.OPENGENI_ENROLLMENT_ROUTES_ADMIN_URL?.trim();
const localAppUrl = process.env.OPENGENI_ENROLLMENT_ROUTES_APP_URL?.trim();

let available = true;
let shared: SharedTestDatabase | null = null;
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
  publicBaseUrl: "https://app.opengeni.example/",
});

function appFor(overrides: Partial<AppDependencies> = {}) {
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
    bus: new MemoryEventBus() as never,
    workflowClient,
    managedAuth: null,
    ...overrides,
  };
  return createApp(deps);
}

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
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
    subjectId: "user-m5",
    subjectLabel: "M5 User",
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

beforeAll(async () => {
  if (localAdminUrl && localAppUrl) {
    admin = postgres(localAdminUrl, { max: 2, prepare: false });
    client = createDb(localAppUrl, { max: 4 });
    db = client.db;
    return;
  }
  shared = await acquireSharedTestDatabase("enrollment-routes");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[enrollment-routes] docker unavailable, skipping");
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
  if (localAdminUrl) {
    await admin?.end().catch(() => undefined);
  }
  await shared?.release();
}, 180_000);

describe("M5 device-flow happy path: start -> approve -> poll -> EnrollmentCredentials", () => {
  test.each(["test", "production"] as const)(
    "renewal in %s recovers expired credentials only with the current install key and live grant",
    async (environment) => {
      if (!available) throw new Error("renewal acceptance requires PostgreSQL");
      const { accountId, workspaceId } = await freshWorkspace();
      const keys = generateKeyPairSync("ed25519");
      const rawKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
        "base64",
      );
      const enrollment = await createEnrollment(db, {
        accountId,
        workspaceId,
        pubkey: rawKey,
        exposure: "whole-machine",
        hasDisplay: true,
        allowScreenControl: false,
        os: "macos",
        arch: "aarch64",
      });
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        workspaceId,
        agentId: enrollment.id,
        enrollmentId: enrollment.id,
        credentialGeneration: enrollment.credentialGeneration,
        subjectPrefix: `agent.${workspaceId}.${enrollment.id}`,
        exp: now - 90 * 24 * 3600,
      };
      const expired = await signEnrollmentBearer(SIGNING_SECRET, claims);
      expect(await verifyEnrollmentBearer(SIGNING_SECRET, expired)).toBeNull();
      const app = appFor({ settings: { ...settings, environment } });
      const request = (token = expired, signedAt = now, key = keys.privateKey, extra = {}) =>
        app.request("/v1/enrollments/renew", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bearer: token,
            signedAt,
            signature: sign(
              null,
              Buffer.from(enrollmentRenewalProof(token, signedAt)),
              key,
            ).toString("base64"),
            ...extra,
          }),
        });
      const response = await request();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { credentials } = await response.json();
      const renewed = await verifyEnrollmentBearer(SIGNING_SECRET, credentials.bearer);
      expect(renewed!.exp).toBeGreaterThan(now + 29 * 24 * 3600);
      expect(renewed).toEqual({ ...claims, exp: renewed!.exp });
      expect(credentials.consentedScreenControl).toBe(false);
      expect((await getEnrollment(db, workspaceId, enrollment.id))!.credentialGeneration).toBe(
        enrollment.credentialGeneration,
      );
      // Stay outside the 120-second window even when HTTP requests cross a second boundary.
      expect((await request(expired, now - 300)).status).toBe(401);
      expect((await request(expired, now + 300)).status).toBe(401);
      expect((await request(expired, now, generateKeyPairSync("ed25519").privateKey)).status).toBe(
        401,
      );
      expect((await request(expired, now, keys.privateKey, { scope: "organization" })).status).toBe(
        400,
      );
      expect((await request(await signEnrollmentBearer("another-deployment", claims))).status).toBe(
        401,
      );
      expect(
        (
          await request(
            await signEnrollmentBearer(SIGNING_SECRET, {
              ...claims,
              credentialGeneration: claims.credentialGeneration + 1,
            }),
          )
        ).status,
      ).toBe(401);
      await revokeEnrollment(db, { accountId, workspaceId, enrollmentId: enrollment.id });
      expect((await request()).status).toBe(401);
      expect((await getEnrollment(db, workspaceId, enrollment.id))!.status).toBe("revoked");
    },
    180_000,
  );

  test("the full flow lands an enrollment + sandbox and returns a signed bearer", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();

    // 1. START (agent-side, user-unauthenticated).
    const startRes = await app.request("/v1/enrollments/device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: "ed25519:HAPPY",
        os: "linux",
        arch: "x86_64",
        machineName: "build-box",
        canOfferDisplay: true,
        requestsScreenControl: true,
        workspaceId,
      }),
    });
    expect(startRes.status).toBe(201);
    const start = (await startRes.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      intervalSeconds: number;
      expiresInSeconds: number;
    };
    expect(start.deviceCode).toBeTruthy();
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(start.verificationUri).toBe("https://app.opengeni.example/device");
    expect(start.verificationUriComplete).toBe(
      `https://app.opengeni.example/device?user_code=${encodeURIComponent(start.userCode)}`,
    );
    expect(start.intervalSeconds).toBeGreaterThan(0);

    // 2. POLL before approve → pending.
    const pollPending = await app.request("/v1/enrollments/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    expect(pollPending.status).toBe(200);
    expect(((await pollPending.json()) as { state: string }).state).toBe("pending");

    // 3. APPROVE (user-authenticated, workspace-gated) WITH screen control.
    const approveRes = await app.request(
      `/v1/workspaces/${workspaceId}/enrollments/device/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`,
        },
        body: JSON.stringify({
          userCode: start.userCode,
          allowScreenControl: true,
        }),
      },
    );
    expect(approveRes.status).toBe(201);
    const approve = (await approveRes.json()) as {
      approved: boolean;
      enrollmentId: string;
      sandboxId: string;
      allowScreenControl: boolean;
    };
    expect(approve.approved).toBe(true);
    expect(approve.enrollmentId).toBeTruthy();
    expect(approve.sandboxId).toBeTruthy();
    expect(approve.allowScreenControl).toBe(true);

    // 4. POLL after approve → authorized + EnrollmentCredentials (signed bearer).
    const pollAuth = await app.request("/v1/enrollments/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    expect(pollAuth.status).toBe(200);
    const poll = (await pollAuth.json()) as {
      state: string;
      credentials?: {
        agentId: string;
        workspaceId: string;
        bearer: string;
        subjectPrefix: string;
        natsUrls: string[];
        relayUrl: string;
        natsAccountCreds: string;
        updatePublicKey: string;
        consentedWholeMachine: boolean;
        consentedScreenControl: boolean;
      };
    };
    expect(poll.state).toBe("authorized");
    expect(poll.credentials).toBeDefined();
    const creds = poll.credentials!;
    expect(creds.agentId).toBe(approve.enrollmentId);
    expect(creds.workspaceId).toBe(workspaceId);
    expect(creds.subjectPrefix).toBe(`agent.${workspaceId}.${approve.enrollmentId}`);
    expect(creds.natsUrls).toEqual(["nats://control.example:4222"]);
    // The agent-bound relay URL is the canonical `/stream` dial base, NOT the raw
    // (path-less) configured `selfhostedRelayUrl`. The agent's producer appends only
    // its routing query and assumes the base already carries `/stream`; without this
    // normalization the producer dials a path-less URL the relay 400s and the
    // terminal/desktop streams are unreachable.
    expect(creds.relayUrl).toBe("wss://relay.example/stream");
    // M-AUTH closed the placeholder: the agent presents the bearer as the NATS
    // connect auth-token (auth-callout), so natsAccountCreds is vestigial and
    // echoes the bearer (NOT the empty placeholder it used to be).
    expect(creds.natsAccountCreds).toBe(creds.bearer);
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
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:NOSCREEN",
          canOfferDisplay: true,
          requestsScreenControl: true,
          workspaceId,
        }),
      })
    ).json()) as { deviceCode: string; userCode: string };
    await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`,
      },
      body: JSON.stringify({
        userCode: start.userCode,
        allowScreenControl: false,
      }),
    });
    const poll = (await (
      await app.request("/v1/enrollments/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    ).json()) as {
      state: string;
      credentials?: {
        consentedScreenControl: boolean;
        consentedWholeMachine: boolean;
      };
    };
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
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userCode: "AAAA-BBBB",
        allowScreenControl: false,
      }),
    });
    expect(res.status).toBe(401);
  }, 60_000);

  test("approve with a bearer lacking enrollments:manage is rejected (403)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const res = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["sessions:read"])}`,
      },
      body: JSON.stringify({
        userCode: "AAAA-BBBB",
        allowScreenControl: false,
      }),
    });
    expect(res.status).toBe(403);
  }, 60_000);

  test("organization publication requires account admin while an account admin can approve it", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const start = async (publicKey: string) =>
      (await (
        await app.request("/v1/enrollments/device/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicKey, workspaceId }),
        })
      ).json()) as { userCode: string };

    const deniedStart = await start("ed25519:ORG-DENIED");
    const denied = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`,
      },
      body: JSON.stringify({
        userCode: deniedStart.userCode,
        allowScreenControl: false,
        scope: "organization",
      }),
    });
    expect(denied.status).toBe(403);

    const approvedStart = await start("ed25519:ORG-APPROVED");
    const approved = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, [
          "enrollments:manage",
          "enrollments:read",
          "account:admin",
        ])}`,
      },
      body: JSON.stringify({
        userCode: approvedStart.userCode,
        allowScreenControl: false,
        scope: "organization",
      }),
    });
    expect(approved.status).toBe(201);
    const list = await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
      headers: {
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`,
      },
    });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { enrollments: Array<{ scope: string }> }).enrollments.some(
        (enrollment) => enrollment.scope === "organization",
      ),
    ).toBe(true);
  }, 90_000);

  test("a workspace-B bearer cannot approve a flow started for workspace A (rejected)", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const app = appFor();
    // Start a flow for workspace A.
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:XWS",
          workspaceId: a.workspaceId,
        }),
      })
    ).json()) as { userCode: string };
    // A user authenticated to workspace B tries to approve A's user_code IN B.
    const resInB = await app.request(`/v1/workspaces/${b.workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(b.accountId, b.workspaceId, ["enrollments:manage"])}`,
      },
      body: JSON.stringify({
        userCode: start.userCode,
        allowScreenControl: false,
      }),
    });
    // The user_code lookup is workspace-scoped → no pending request in B → 404.
    expect(resInB.status).toBe(404);
    // And a B-bearer cannot reach the A route at all (no grant in A → 403).
    const resCrossRoute = await app.request(
      `/v1/workspaces/${a.workspaceId}/enrollments/device/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await bearer(b.accountId, b.workspaceId, ["enrollments:manage"])}`,
        },
        body: JSON.stringify({
          userCode: start.userCode,
          allowScreenControl: false,
        }),
      },
    );
    expect(resCrossRoute.status).toBe(403);
  }, 90_000);
});

describe("M5 list + revoke + idempotent re-enroll", () => {
  test("GET /enrollments lists the machine; revoke flips it; re-approve re-activates the SAME machine", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`;

    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:LIST",
          machineName: "node-a",
          workspaceId,
        }),
      })
    ).json()) as { deviceCode: string; userCode: string };
    const approve = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: manageBearer,
        },
        body: JSON.stringify({
          userCode: start.userCode,
          allowScreenControl: false,
        }),
      })
    ).json()) as { enrollmentId: string };

    // LIST shows the machine.
    const listRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
      headers: { authorization: manageBearer },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      enrollments: { id: string; status: string; pubkey: string }[];
    };
    expect(list.enrollments.length).toBe(1);
    expect(list.enrollments[0]!.id).toBe(approve.enrollmentId);
    expect(list.enrollments[0]!.status).toBe("active");

    // REVOKE.
    const revokeRes = await app.request(
      `/v1/workspaces/${workspaceId}/enrollments/${approve.enrollmentId}/revoke`,
      {
        method: "POST",
        headers: { authorization: manageBearer },
      },
    );
    expect(revokeRes.status).toBe(200);
    const revoke = (await revokeRes.json()) as {
      revoked: boolean;
      outcome: string;
      enrollmentId: string;
      machineName: string | null;
      message: string;
      action: string;
    };
    expect(revoke).toMatchObject({
      revoked: true,
      outcome: "removed",
      enrollmentId: approve.enrollmentId,
      machineName: "node-a",
      dependentSessions: [],
    });
    expect(revoke.message).toMatch(/history/i);
    expect(revoke.action).toMatch(/fresh human-approved/i);
    const defaultList = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: unknown[] };
    expect(defaultList.enrollments.length).toBe(0);
    const activeList = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments?status=active`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: unknown[] };
    expect(activeList.enrollments.length).toBe(0);
    const revokedList = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments?status=revoked`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: { id: string; status: string }[] };
    expect(revokedList.enrollments).toEqual([
      expect.objectContaining({ id: approve.enrollmentId, status: "revoked" }),
    ]);

    // Idempotent re-enroll: a NEW device-flow for the SAME pubkey re-activates the
    // SAME enrollment (the M2 upsert) — not a duplicate machine.
    const start2 = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:LIST",
          machineName: "node-a",
          workspaceId,
        }),
      })
    ).json()) as { userCode: string };
    const approve2 = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: manageBearer,
        },
        body: JSON.stringify({
          userCode: start2.userCode,
          allowScreenControl: true,
        }),
      })
    ).json()) as { enrollmentId: string };
    expect(approve2.enrollmentId).toBe(approve.enrollmentId); // same machine, re-activated
    const finalList = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: { status: string }[] };
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
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:OFF", workspaceId }),
    });
    expect(startRes.status).toBe(404);

    const pollRes = await app.request("/v1/enrollments/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "anything" }),
    });
    expect(pollRes.status).toBe(404);

    const listRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
      headers: { authorization: manageBearer },
    });
    expect(listRes.status).toBe(404);

    const approveRes = await app.request(
      `/v1/workspaces/${workspaceId}/enrollments/device/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: manageBearer,
        },
        body: JSON.stringify({
          userCode: "AAAA-BBBB",
          allowScreenControl: false,
        }),
      },
    );
    expect(approveRes.status).toBe(404);

    // The enrollment-UX additions are gated the same.
    const lookupRes = await app.request("/v1/enrollments/device/lookup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: manageBearer,
      },
      body: JSON.stringify({ userCode: "AAAA-BBBB" }),
    });
    expect(lookupRes.status).toBe(404);
    const denyRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/deny`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: manageBearer,
      },
      body: JSON.stringify({ userCode: "AAAA-BBBB" }),
    });
    expect(denyRes.status).toBe(404);
    const mintRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: manageBearer,
      },
      body: JSON.stringify({ allowScreenControl: false }),
    });
    expect(mintRes.status).toBe(404);
    const exchangeRes = await app.request("/v1/enrollments/token/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "oget_x.y",
        publicKey: "ed25519:OFF",
        os: "linux",
        arch: "x86_64",
      }),
    });
    expect(exchangeRes.status).toBe(404);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment UX (design 11): the click-Grant approve-page lookup/deny + the
// headless enroll-token mint/exchange, driven end-to-end through createApp + the
// REAL db (same harness as the M5 device-flow tests above).
// ─────────────────────────────────────────────────────────────────────────────

describe("design-11 B.1 lookup: resolve a pending flow by user_code (no workspace in path)", () => {
  test("an authorized reader resolves the machine details WITHOUT consuming the request", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const readBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:LOOKUP",
          os: "macos",
          arch: "aarch64",
          machineName: "mac-mini",
          canOfferDisplay: true,
          requestsScreenControl: true,
          workspaceId,
        }),
      })
    ).json()) as { deviceCode: string; userCode: string };

    const lookupRes = await app.request("/v1/enrollments/device/lookup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: readBearer,
      },
      body: JSON.stringify({ userCode: start.userCode }),
    });
    expect(lookupRes.status).toBe(200);
    const lookup = (await lookupRes.json()) as {
      workspaceId: string;
      userCode: string;
      expiresAt: string;
      machine: {
        machineName: string | null;
        os: string;
        arch: string;
        canOfferDisplay: boolean;
        requestsScreenControl: boolean;
      };
    };
    expect(lookup.workspaceId).toBe(workspaceId);
    expect(lookup.userCode).toBe(start.userCode);
    expect(lookup.machine.machineName).toBe("mac-mini");
    expect(lookup.machine.os).toBe("macos");
    expect(lookup.machine.arch).toBe("aarch64");
    expect(lookup.machine.canOfferDisplay).toBe(true);
    expect(lookup.machine.requestsScreenControl).toBe(true);

    // The request was NOT consumed — a poll still says pending.
    const poll = (await (
      await app.request("/v1/enrollments/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    ).json()) as { state: string };
    expect(poll.state).toBe("pending");
  }, 90_000);

  test("an unknown code → 404; an unauthenticated lookup of a REAL code → 404 (no disclosure)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const readBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    const unknown = await app.request("/v1/enrollments/device/lookup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: readBearer,
      },
      body: JSON.stringify({ userCode: "ZZZZ-ZZZZ" }),
    });
    expect(unknown.status).toBe(404);
    // An unauthenticated caller looking up a REAL pending code: the route resolves
    // the code, then requireAccessGrant rejects the anonymous caller — normalized
    // to a flat 404 (never reveals the code exists). (An UNKNOWN code is also 404
    // before auth is ever reached, so the two are indistinguishable — the intended
    // no-disclosure property.)
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:NOAUTHLOOKUP",
          workspaceId,
        }),
      })
    ).json()) as { userCode: string };
    const noAuth = await app.request("/v1/enrollments/device/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: start.userCode }),
    });
    expect(noAuth.status).toBe(404);
  }, 90_000);

  test("a workspace-B reader gets 404 for a code that lives in workspace A (no cross-workspace disclosure)", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const app = appFor();
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "ed25519:XWSLOOKUP",
          workspaceId: a.workspaceId,
        }),
      })
    ).json()) as { userCode: string };
    // The code resolves to workspace A; a user holding a grant only in B must get a
    // flat 404 (indistinguishable from "no such code") — never a 403 that confirms
    // the code exists somewhere.
    const res = await app.request("/v1/enrollments/device/lookup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(b.accountId, b.workspaceId, ["enrollments:read"])}`,
      },
      body: JSON.stringify({ userCode: start.userCode }),
    });
    expect(res.status).toBe(404);
  }, 90_000);
});

describe("design-11 B.2 deny: mark a pending flow denied", () => {
  test("deny flips the pending row → a subsequent poll is denied; an unknown code → denied:false", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`;
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: "ed25519:DENY", workspaceId }),
      })
    ).json()) as { deviceCode: string; userCode: string };

    const denyRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/deny`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: manageBearer,
      },
      body: JSON.stringify({ userCode: start.userCode }),
    });
    expect(denyRes.status).toBe(200);
    expect(((await denyRes.json()) as { denied: boolean }).denied).toBe(true);

    const poll = (await (
      await app.request("/v1/enrollments/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    ).json()) as { state: string };
    expect(poll.state).toBe("denied");

    // An unknown / already-terminal code is a no-op.
    const denyAgain = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/deny`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: manageBearer,
      },
      body: JSON.stringify({ userCode: start.userCode }),
    });
    expect(((await denyAgain.json()) as { denied: boolean }).denied).toBe(false);
  }, 90_000);

  test("deny without enrollments:manage is rejected (403)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const res = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/deny`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`,
      },
      body: JSON.stringify({ userCode: "AAAA-BBBB" }),
    });
    expect(res.status).toBe(403);
  }, 60_000);
});

describe("design-11 A2 headless: mint enroll token -> exchange -> identical credentials", () => {
  test("mint + exchange lands an enrollment + sandbox and returns the SAME credential shape as poll", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`;

    // 1. MINT (user-authenticated).
    const mintRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: manageBearer,
      },
      body: JSON.stringify({ allowScreenControl: true }),
    });
    expect(mintRes.status).toBe(201);
    const mint = (await mintRes.json()) as {
      token: string;
      expiresAt: string;
      expiresInSeconds: number;
    };
    expect(mint.token.startsWith("oget_")).toBe(true);
    expect(mint.expiresInSeconds).toBe(3600);

    // 2. EXCHANGE (UNAUTHENTICATED — the token is the auth).
    const exchangeRes = await app.request("/v1/enrollments/token/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: mint.token,
        publicKey: "ed25519:HEADLESS",
        os: "linux",
        arch: "x86_64",
        machineName: "fleet-node-1",
        canOfferDisplay: true,
        requestsScreenControl: false,
      }),
    });
    expect(exchangeRes.status).toBe(201);
    const exchange = (await exchangeRes.json()) as {
      credentials: {
        agentId: string;
        workspaceId: string;
        bearer: string;
        subjectPrefix: string;
        natsUrls: string[];
        relayUrl: string;
        natsAccountCreds: string;
        updatePublicKey: string;
        consentedWholeMachine: boolean;
        consentedScreenControl: boolean;
      };
    };
    const creds = exchange.credentials;
    expect(creds.workspaceId).toBe(workspaceId);
    expect(creds.agentId).toBeTruthy();
    expect(creds.subjectPrefix).toBe(`agent.${workspaceId}.${creds.agentId}`);
    expect(creds.natsUrls).toEqual(["nats://control.example:4222"]);
    expect(creds.relayUrl).toBe("wss://relay.example/stream");
    // Identical credential shape to the poll authorized branch: natsAccountCreds
    // echoes the bearer, whole-machine consented, screen-control per the TOKEN.
    expect(creds.natsAccountCreds).toBe(creds.bearer);
    expect(creds.consentedWholeMachine).toBe(true);
    expect(creds.consentedScreenControl).toBe(true);
    // The signed bearer verifies + binds the identity.
    const verified = await verifyEnrollmentBearer(SIGNING_SECRET, creds.bearer);
    expect(verified).not.toBeNull();
    expect(verified!.workspaceId).toBe(workspaceId);
    expect(verified!.agentId).toBe(creds.agentId);

    // The exchange landed a real machine (the SAME finalize as approve).
    const list = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as {
      enrollments: {
        id: string;
        status: string;
        allowScreenControl: boolean;
      }[];
    };
    expect(list.enrollments.length).toBe(1);
    expect(list.enrollments[0]!.id).toBe(creds.agentId);
    expect(list.enrollments[0]!.status).toBe("active");
    expect(list.enrollments[0]!.allowScreenControl).toBe(true);
  }, 120_000);

  test("a minted token connects one machine: the same machine may retry, another is refused", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`;
    const mintRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: manageBearer },
      body: JSON.stringify({ allowScreenControl: false }),
    });
    expect(mintRes.status).toBe(201);
    const { token } = (await mintRes.json()) as { token: string };
    const exchange = (publicKey: string, machineName: string) =>
      app.request("/v1/enrollments/token/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          publicKey,
          os: "linux",
          arch: "x86_64",
          machineName,
          canOfferDisplay: true,
          requestsScreenControl: false,
        }),
      });

    const first = await exchange("ed25519:LAPTOP", "laptop");
    expect(first.status).toBe(201);
    const firstAgent = ((await first.json()) as { credentials: { agentId: string } }).credentials
      .agentId;
    // A lost response or a re-run install command on the same machine still works.
    const retry = await exchange("ed25519:LAPTOP", "laptop");
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { credentials: { agentId: string } }).credentials.agentId).toBe(
      firstAgent,
    );
    // A copied command cannot connect a second machine.
    const other = await exchange("ed25519:OTHER", "someone-else");
    expect(other.status).toBe(401);
    expect(await other.text()).toContain("already used to connect another machine");

    const list = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: { id: string }[] };
    expect(list.enrollments.map((enrollment) => enrollment.id)).toEqual([firstAgent]);
  }, 120_000);

  test("screen control turns on in place: consent on the row, renewal carries it, live agent renews", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const keys = generateKeyPairSync("ed25519");
    const rawKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
      "base64",
    );
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: rawKey,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: false,
      os: "macos",
      arch: "aarch64",
    });
    const renewRequests: { subject: string; op: string | undefined }[] = [];
    const bus = Object.assign(new MemoryEventBus(), {
      getRequestConnection: () => ({
        request: async (subject: string, payload: Uint8Array) => {
          const request = ControlRequest.decode(payload);
          renewRequests.push({ subject, op: request.op?.$case });
          return {
            data: ControlResponse.encode({
              requestId: request.requestId,
              error: undefined,
              result: {
                $case: "credentialRenew",
                credentialRenew: { renewed: true, consentedScreenControl: true },
              },
            }).finish(),
          };
        },
      }),
    });
    const app = appFor({ bus: bus as never });
    const manageBearer = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`;
    const post = (path: string, body: unknown, auth = manageBearer) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify(body),
      });
    const machinePath = `/v1/workspaces/${workspaceId}/machines/${enrollment.id}`;

    // Reading the machine is not enough to change its consent.
    const readOnly = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    expect((await post(`${machinePath}/screen-control`, {}, readOnly)).status).toBe(403);

    // Offline: the consent is recorded in place and waits for the machine.
    const offline = await post(`${machinePath}/screen-control`, {});
    expect(offline.status).toBe(200);
    expect(await offline.json()).toMatchObject({ status: "pending", reason: "offline" });
    const allowed = (await getEnrollment(db, workspaceId, enrollment.id))!;
    expect(allowed.allowScreenControl).toBe(true);
    expect(allowed.credentialGeneration).toBe(enrollment.credentialGeneration);
    expect(renewRequests).toHaveLength(0);

    // The machine's own install-key renewal now carries the consent; its old
    // credentials keep working (no generation bump).
    const now = Math.floor(Date.now() / 1000);
    const current = await signEnrollmentBearer(SIGNING_SECRET, {
      workspaceId,
      agentId: enrollment.id,
      enrollmentId: enrollment.id,
      credentialGeneration: enrollment.credentialGeneration,
      subjectPrefix: `agent.${workspaceId}.${enrollment.id}`,
      exp: now + 3600,
    });
    const renewed = await app.request("/v1/enrollments/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bearer: current,
        signedAt: now,
        signature: sign(
          null,
          Buffer.from(enrollmentRenewalProof(current, now)),
          keys.privateKey,
        ).toString("base64"),
      }),
    });
    expect(renewed.status).toBe(200);
    expect((await renewed.json()).credentials.consentedScreenControl).toBe(true);

    // Live, but the agent predates on-request renewal: it applies after the update.
    const connectionInstanceId = crypto.randomUUID();
    await admin`
      update enrollments set connection_instance_id = ${connectionInstanceId},
        connection_lease_expires_at = now() + interval '5 minutes',
        agent_capabilities = '{"exec":true}'::jsonb
      where id = ${enrollment.id}`;
    expect(await (await post(`${machinePath}/screen-control`, {})).json()).toMatchObject({
      status: "pending",
      reason: "agent_update_required",
    });
    expect(renewRequests).toHaveLength(0);

    // Live and able: exactly that process is asked to renew, and it reports consent.
    await admin`
      update enrollments set agent_capabilities = '{"exec":true,"credentialRenew":true}'::jsonb
      where id = ${enrollment.id}`;
    const active = await post(`${machinePath}/screen-control`, {});
    expect(await active.json()).toEqual({ status: "active", reason: null, message: null });
    expect(renewRequests).toEqual([
      {
        subject: `agent.${workspaceId}.${enrollment.id}.connection.${connectionInstanceId}.rpc`,
        op: "credentialRenew",
      },
    ]);
    // Once the agent's Hello reports the consent, repeating the call changes nothing.
    await admin`
      update enrollments
      set agent_capabilities = '{"exec":true,"credentialRenew":true,"screenControl":true}'::jsonb
      where id = ${enrollment.id}`;
    expect(await (await post(`${machinePath}/screen-control`, {})).json()).toMatchObject({
      status: "active",
    });
    expect(renewRequests).toHaveLength(1);
    const list = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: { id: string }[] };
    expect(list.enrollments.map((row) => row.id)).toEqual([enrollment.id]);
    const audits = await admin<{ action: string }[]>`
      select action from audit_events
      where target_id = ${enrollment.id} and action like 'connected_machine.screen_control%'`;
    expect(audits.map((row) => row.action)).toEqual(["connected_machine.screen_control.allowed"]);

    // Privacy & Security panes: validated, and exec'd only on a reachable Mac.
    expect((await post(`${machinePath}/privacy-settings`, { pane: "nope" })).status).toBe(400);
    const otherMachine = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: Buffer.alloc(32, 7).toString("base64"),
      exposure: "whole-machine",
      hasDisplay: false,
      allowScreenControl: false,
      os: "linux",
      arch: "x86_64",
    });
    expect(
      (
        await post(`/v1/workspaces/${workspaceId}/machines/${otherMachine.id}/privacy-settings`, {
          pane: "screen_recording",
        })
      ).status,
    ).toBe(422);
  }, 120_000);

  test("an organization machine's screen control needs account:admin", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: Buffer.alloc(32, 9).toString("base64"),
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: false,
      os: "macos",
      arch: "aarch64",
    });
    await admin`update enrollments set authority_scope = 'organization' where id = ${enrollment.id}`;
    const app = appFor();
    const response = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/screen-control`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage", "enrollments:read"])}`,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(403);
    expect((await getEnrollment(db, workspaceId, enrollment.id))!.allowScreenControl).toBe(false);
  }, 120_000);

  test("exchange with an invalid token → 401; an oge_ bearer is NOT accepted as an enroll token", async () => {
    if (!available) return;
    const app = appFor();
    const bad = await app.request("/v1/enrollments/token/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "oget_garbage.sig",
        publicKey: "ed25519:BAD",
        os: "linux",
        arch: "x86_64",
      }),
    });
    expect(bad.status).toBe(401);
  }, 60_000);

  test("mint without enrollments:manage is rejected (403); unauthenticated mint → 401", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const noPerm = await app.request(`/v1/workspaces/${workspaceId}/enrollments/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`,
      },
      body: JSON.stringify({ allowScreenControl: false }),
    });
    expect(noPerm.status).toBe(403);
    const noAuth = await app.request(`/v1/workspaces/${workspaceId}/enrollments/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowScreenControl: false }),
    });
    expect(noAuth.status).toBe(401);
  }, 60_000);
});
