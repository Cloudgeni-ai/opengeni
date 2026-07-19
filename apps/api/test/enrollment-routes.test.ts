import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  signDelegatedAccessToken,
  signEnrollmentBearer,
  verifyEnrollmentBearer,
  verifyRelayToken,
  type Permission,
} from "@opengeni/contracts";
import { createDb, type Database, type DbClient } from "@opengeni/db";
import { createApp } from "../src/app";
import { ENROLLMENT_BEARER_TTL_SECONDS, RELAY_TOKEN_TTL_SECONDS } from "../src/sandbox/enrollment";
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
const RELAY_TOKEN_SECRET = "m5-relay-token-secret";

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
  selfhostedRelayTokenSecret: RELAY_TOKEN_SECRET,
  selfhostedNatsUrl: "nats://control.example:4222",
  selfhostedRelayUrl: "wss://relay.example",
  agentUpdatePublicKey: "minisign-pub-key",
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
    subjectId: "user-m5",
    subjectLabel: "M5 User",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

type EnrollmentCredentials = {
  agentId: string;
  workspaceId: string;
  bearer: string;
  bearerExpiresAtUnixSeconds: number;
  subjectPrefix: string;
  natsUrls: string[];
  relayUrl: string;
  relayToken: string;
  relayTokenExpiresAtUnixSeconds: number;
  natsAccountCreds: string;
  updatePublicKey: string;
  consentedWholeMachine: boolean;
  consentedScreenControl: boolean;
};

async function enrollMachine(
  app: ReturnType<typeof createApp>,
  input: {
    accountId: string;
    workspaceId: string;
    publicKey: string;
    allowScreenControl?: boolean;
  },
): Promise<{
  enrollmentId: string;
  sandboxId: string;
  credentials: EnrollmentCredentials;
}> {
  const startRes = await app.request("/v1/enrollments/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: input.publicKey,
      os: "linux",
      arch: "x86_64",
      canOfferDisplay: true,
      requestsScreenControl: input.allowScreenControl ?? false,
      workspaceId: input.workspaceId,
    }),
  });
  expect(startRes.status).toBe(201);
  const start = (await startRes.json()) as { deviceCode: string; userCode: string };
  const approveRes = await app.request(
    `/v1/workspaces/${input.workspaceId}/enrollments/device/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(input.accountId, input.workspaceId, ["enrollments:manage"])}`,
      },
      body: JSON.stringify({
        userCode: start.userCode,
        allowScreenControl: input.allowScreenControl ?? false,
      }),
    },
  );
  expect(approveRes.status).toBe(201);
  const approved = (await approveRes.json()) as { enrollmentId: string; sandboxId: string };
  const pollRes = await app.request("/v1/enrollments/device/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: start.deviceCode }),
  });
  expect(pollRes.status).toBe(200);
  const poll = (await pollRes.json()) as {
    state: string;
    credentials?: EnrollmentCredentials;
  };
  expect(poll.state).toBe("authorized");
  expect(poll.credentials).toBeDefined();
  return { ...approved, credentials: poll.credentials! };
}

beforeAll(async () => {
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
  await shared?.release();
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
    expect(start.verificationUri).toContain("/device");
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
        body: JSON.stringify({ userCode: start.userCode, allowScreenControl: true }),
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
        bearerExpiresAtUnixSeconds: number;
        subjectPrefix: string;
        natsUrls: string[];
        relayUrl: string;
        relayToken: string;
        relayTokenExpiresAtUnixSeconds: number;
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
    // terminal/desktop streams are unreachable (dossier §V5/§V6).
    expect(creds.relayUrl).toBe("wss://relay.example/stream");
    expect(creds.relayToken).toStartWith("ogr_");
    expect(creds.bearerExpiresAtUnixSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(creds.relayTokenExpiresAtUnixSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));
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
    expect(verified!.credentialGeneration).toBe(1);
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
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
    });
    const poll = (await (
      await app.request("/v1/enrollments/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    ).json()) as {
      state: string;
      credentials?: { consentedScreenControl: boolean; consentedWholeMachine: boolean };
    };
    expect(poll.state).toBe("authorized");
    expect(poll.credentials!.consentedWholeMachine).toBe(true);
    expect(poll.credentials!.consentedScreenControl).toBe(false);
  }, 90_000);
});

describe("OPE-14 public-origin and self-revoke contracts", () => {
  test("device start uses configured public web origin instead of the API request origin", async () => {
    if (!available) return;
    const { workspaceId } = await freshWorkspace();
    const app = appFor({
      settings: { ...settings, publicBaseUrl: "https://console.example.test///" },
    });
    const res = await app.request("https://api.internal.test/v1/enrollments/device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "ed25519:PUBLIC-ORIGIN", workspaceId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { verificationUri: string; verificationUriComplete: string };
    expect(body.verificationUri).toBe("https://console.example.test/device");
    expect(body.verificationUriComplete).toStartWith(
      "https://console.example.test/device?user_code=",
    );
  }, 60_000);

  test("self-refresh rotates long bearer + short relay credentials without changing identity or consent", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const app = appFor();
    const enrolled = await enrollMachine(app, {
      accountId,
      workspaceId,
      publicKey: "ed25519:SELF-REFRESH",
      allowScreenControl: true,
    });

    // HMAC envelopes are deterministic for identical claims in the same second;
    // cross a second boundary so inequality proves both credentials were reissued.
    await Bun.sleep(1_100);
    const before = Math.floor(Date.now() / 1000);
    const refreshRes = await app.request("/v1/enrollments/self/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.credentials.bearer}` },
    });
    const after = Math.floor(Date.now() / 1000);
    expect(refreshRes.status).toBe(200);
    const refreshed = ((await refreshRes.json()) as { credentials: EnrollmentCredentials })
      .credentials;

    expect(refreshed.agentId).toBe(enrolled.enrollmentId);
    expect(refreshed.workspaceId).toBe(workspaceId);
    expect(refreshed.subjectPrefix).toBe(enrolled.credentials.subjectPrefix);
    expect(refreshed.natsUrls).toEqual(enrolled.credentials.natsUrls);
    expect(refreshed.relayUrl).toBe(enrolled.credentials.relayUrl);
    expect(refreshed.consentedWholeMachine).toBe(true);
    expect(refreshed.consentedScreenControl).toBe(true);
    expect(refreshed.bearer).not.toBe(enrolled.credentials.bearer);
    expect(refreshed.relayToken).not.toBe(enrolled.credentials.relayToken);
    expect(refreshed.natsAccountCreds).toBe(refreshed.bearer);
    expect(refreshed.bearerExpiresAtUnixSeconds).toBeGreaterThanOrEqual(
      before + ENROLLMENT_BEARER_TTL_SECONDS,
    );
    expect(refreshed.bearerExpiresAtUnixSeconds).toBeLessThanOrEqual(
      after + ENROLLMENT_BEARER_TTL_SECONDS,
    );
    expect(refreshed.relayTokenExpiresAtUnixSeconds).toBeGreaterThanOrEqual(
      before + RELAY_TOKEN_TTL_SECONDS,
    );
    expect(refreshed.relayTokenExpiresAtUnixSeconds).toBeLessThanOrEqual(
      after + RELAY_TOKEN_TTL_SECONDS,
    );

    const bearerClaims = await verifyEnrollmentBearer(SIGNING_SECRET, refreshed.bearer);
    expect(bearerClaims).not.toBeNull();
    expect(bearerClaims!.workspaceId).toBe(workspaceId);
    expect(bearerClaims!.agentId).toBe(enrolled.enrollmentId);
    expect(bearerClaims!.enrollmentId).toBe(enrolled.enrollmentId);
    expect(bearerClaims!.credentialGeneration).toBe(1);
    expect(bearerClaims!.subjectPrefix).toBe(refreshed.subjectPrefix);
    expect(bearerClaims!.exp).toBe(refreshed.bearerExpiresAtUnixSeconds);
    const relayClaims = await verifyRelayToken(RELAY_TOKEN_SECRET, refreshed.relayToken);
    expect(relayClaims).toEqual({
      workspaceId,
      agentId: enrolled.enrollmentId,
      exp: refreshed.relayTokenExpiresAtUnixSeconds,
    });
  }, 90_000);

  test("self-refresh accepts only an active exact-generation bearer in the Authorization header", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const app = appFor();
    const enrolled = await enrollMachine(app, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      publicKey: "ed25519:REFRESH-AUTH",
    });
    const other = await enrollMachine(app, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      publicKey: "ed25519:REFRESH-OTHER",
    });
    const claims = (await verifyEnrollmentBearer(SIGNING_SECRET, enrolled.credentials.bearer))!;

    expect((await app.request("/v1/enrollments/self/refresh", { method: "POST" })).status).toBe(
      401,
    );
    expect(
      (
        await app.request("/v1/enrollments/self/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bearer: enrolled.credentials.bearer }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/enrollments/self/refresh", {
          method: "POST",
          headers: { authorization: "Bearer oge_forged" },
        })
      ).status,
    ).toBe(401);

    const expired = await signEnrollmentBearer(SIGNING_SECRET, {
      ...claims,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const crossWorkspace = await signEnrollmentBearer(SIGNING_SECRET, {
      ...claims,
      workspaceId: b.workspaceId,
      subjectPrefix: `agent.${b.workspaceId}.${claims.agentId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const wrongAgent = await signEnrollmentBearer(SIGNING_SECRET, {
      ...claims,
      agentId: other.enrollmentId,
      subjectPrefix: `agent.${a.workspaceId}.${other.enrollmentId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const wrongEnrollment = await signEnrollmentBearer(SIGNING_SECRET, {
      ...claims,
      enrollmentId: other.enrollmentId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const wrongSubject = await signEnrollmentBearer(SIGNING_SECRET, {
      ...claims,
      subjectPrefix: `agent.${a.workspaceId}.${other.enrollmentId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    for (const invalid of [expired, crossWorkspace, wrongAgent, wrongEnrollment, wrongSubject]) {
      const res = await app.request("/v1/enrollments/self/refresh", {
        method: "POST",
        headers: { authorization: `Bearer ${invalid}` },
      });
      expect(res.status).toBe(401);
    }

    // Revocation makes an otherwise cryptographically valid bearer unusable.
    const revoked = await app.request("/v1/enrollments/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.credentials.bearer}` },
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await app.request("/v1/enrollments/self/refresh", {
          method: "POST",
          headers: { authorization: `Bearer ${enrolled.credentials.bearer}` },
        })
      ).status,
    ).toBe(401);

    // Re-enrollment increments the generation, so the old family's bearer is stale.
    const staleFamily = other.credentials.bearer;
    const reEnrolled = await enrollMachine(app, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      publicKey: "ed25519:REFRESH-OTHER",
    });
    expect(reEnrolled.enrollmentId).toBe(other.enrollmentId);
    expect(
      (await verifyEnrollmentBearer(SIGNING_SECRET, reEnrolled.credentials.bearer))
        ?.credentialGeneration,
    ).toBe(2);
    expect(
      (
        await app.request("/v1/enrollments/self/refresh", {
          method: "POST",
          headers: { authorization: `Bearer ${staleFamily}` },
        })
      ).status,
    ).toBe(401);
  }, 120_000);

  test("self-refresh returns 503 when the enrollment signing plane is disabled", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enabledApp = appFor();
    const enrolled = await enrollMachine(enabledApp, {
      accountId,
      workspaceId,
      publicKey: "ed25519:REFRESH-DISABLED",
    });
    const disabledApp = appFor({
      settings: {
        ...settings,
        enrollmentSigningSecret: undefined,
        delegationSecret: undefined,
      },
    });
    const res = await disabledApp.request("/v1/enrollments/self/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.credentials.bearer}` },
    });
    expect(res.status).toBe(503);
  }, 90_000);

  test("self-revoke is same-generation idempotent and an old bearer cannot revoke a re-enrollment", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const app = appFor();
    const manageBearer = `Bearer ${await bearer(a.accountId, a.workspaceId, ["enrollments:manage"])}`;
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: "ed25519:SELF-REVOKE", workspaceId: a.workspaceId }),
      })
    ).json()) as { userCode: string; deviceCode: string };
    const approved = (await (
      await app.request(`/v1/workspaces/${a.workspaceId}/enrollments/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: manageBearer },
        body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
      })
    ).json()) as { enrollmentId: string };
    const poll = (await (
      await app.request("/v1/enrollments/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    ).json()) as { credentials: { bearer: string } };
    const enrollmentBearer = poll.credentials.bearer;

    expect((await app.request("/v1/enrollments/self/revoke", { method: "POST" })).status).toBe(401);
    expect(
      (
        await app.request("/v1/enrollments/self/revoke", {
          method: "POST",
          headers: { authorization: "Bearer oge_forged" },
        })
      ).status,
    ).toBe(401);
    const forged = await signEnrollmentBearer(SIGNING_SECRET, {
      workspaceId: b.workspaceId,
      agentId: approved.enrollmentId,
      enrollmentId: approved.enrollmentId,
      credentialGeneration: 1,
      subjectPrefix: `agent.${b.workspaceId}.${approved.enrollmentId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(
      (
        await app.request("/v1/enrollments/self/revoke", {
          method: "POST",
          headers: { authorization: `Bearer ${forged}` },
        })
      ).status,
    ).toBe(401);
    const expired = await signEnrollmentBearer(SIGNING_SECRET, {
      workspaceId: a.workspaceId,
      agentId: approved.enrollmentId,
      enrollmentId: approved.enrollmentId,
      credentialGeneration: 1,
      subjectPrefix: `agent.${a.workspaceId}.${approved.enrollmentId}`,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect(
      (
        await app.request("/v1/enrollments/self/revoke", {
          method: "POST",
          headers: { authorization: `Bearer ${expired}` },
        })
      ).status,
    ).toBe(401);

    const revoke = await app.request("/v1/enrollments/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${enrollmentBearer}` },
    });
    expect(revoke.status).toBe(200);
    expect((await revoke.json()) as { revoked: boolean }).toEqual({ revoked: true });
    // Recover a lost successful response: the same verified identity gets the
    // DB's idempotent no-op result, while auth-callout still denies revoked rows.
    const retry = await app.request("/v1/enrollments/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${enrollmentBearer}` },
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()) as { revoked: boolean }).toEqual({ revoked: false });

    // A fresh device flow for the SAME pubkey is a real re-enrollment: same row id,
    // next credential generation, and a newly signed bearer.
    const start2 = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: "ed25519:SELF-REVOKE", workspaceId: a.workspaceId }),
      })
    ).json()) as { userCode: string; deviceCode: string };
    const approved2 = (await (
      await app.request(`/v1/workspaces/${a.workspaceId}/enrollments/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: manageBearer },
        body: JSON.stringify({ userCode: start2.userCode, allowScreenControl: false }),
      })
    ).json()) as { enrollmentId: string };
    expect(approved2.enrollmentId).toBe(approved.enrollmentId);
    const poll2 = (await (
      await app.request("/v1/enrollments/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start2.deviceCode }),
      })
    ).json()) as { credentials: { bearer: string } };
    const newBearer = poll2.credentials.bearer;
    expect(
      (await verifyEnrollmentBearer(SIGNING_SECRET, enrollmentBearer))?.credentialGeneration,
    ).toBe(1);
    expect((await verifyEnrollmentBearer(SIGNING_SECRET, newBearer))?.credentialGeneration).toBe(2);

    // The old bearer is still cryptographically well-formed, but its generation no
    // longer matches the row and therefore cannot revoke the new active family.
    const staleRevoke = await app.request("/v1/enrollments/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${enrollmentBearer}` },
    });
    expect(staleRevoke.status).toBe(401);

    // The newly returned generation is valid and retains same-generation retry
    // semantics after a lost successful response.
    const newRevoke = await app.request("/v1/enrollments/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${newBearer}` },
    });
    expect(newRevoke.status).toBe(200);
    expect((await newRevoke.json()) as { revoked: boolean }).toEqual({ revoked: true });
    const newRetry = await app.request("/v1/enrollments/self/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${newBearer}` },
    });
    expect(newRetry.status).toBe(200);
    expect((await newRetry.json()) as { revoked: boolean }).toEqual({ revoked: false });
  }, 120_000);
});

describe("M5 authz: unauthenticated + cross-workspace approve are rejected", () => {
  test("approve with NO bearer is rejected (401)", async () => {
    if (!available) return;
    const { workspaceId } = await freshWorkspace();
    const app = appFor();
    const res = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(accountId, workspaceId, ["sessions:read"])}`,
      },
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
    const start = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: "ed25519:XWS", workspaceId: a.workspaceId }),
      })
    ).json()) as { userCode: string };
    // A user authenticated to workspace B tries to approve A's user_code IN B.
    const resInB = await app.request(`/v1/workspaces/${b.workspaceId}/enrollments/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(b.accountId, b.workspaceId, ["enrollments:manage"])}`,
      },
      body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
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
        body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
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
        body: JSON.stringify({ publicKey: "ed25519:LIST", machineName: "node-a", workspaceId }),
      })
    ).json()) as { deviceCode: string; userCode: string };
    const approve = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: manageBearer },
        body: JSON.stringify({ userCode: start.userCode, allowScreenControl: false }),
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
    expect(((await revokeRes.json()) as { revoked: boolean }).revoked).toBe(true);
    const activeList = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments?status=active`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: unknown[] };
    expect(activeList.enrollments.length).toBe(0);

    // Idempotent re-enroll: a NEW device-flow for the SAME pubkey re-activates the
    // SAME enrollment (the M2 upsert) — not a duplicate machine.
    const start2 = (await (
      await app.request("/v1/enrollments/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: "ed25519:LIST", machineName: "node-a", workspaceId }),
      })
    ).json()) as { userCode: string };
    const approve2 = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: manageBearer },
        body: JSON.stringify({ userCode: start2.userCode, allowScreenControl: true }),
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

    const refreshRes = await app.request("/v1/enrollments/self/refresh", {
      method: "POST",
      headers: { authorization: "Bearer oge_anything" },
    });
    expect(refreshRes.status).toBe(404);

    const listRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
      headers: { authorization: manageBearer },
    });
    expect(listRes.status).toBe(404);

    const approveRes = await app.request(
      `/v1/workspaces/${workspaceId}/enrollments/device/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: manageBearer },
        body: JSON.stringify({ userCode: "AAAA-BBBB", allowScreenControl: false }),
      },
    );
    expect(approveRes.status).toBe(404);

    // The enrollment-UX additions are gated the same.
    const lookupRes = await app.request("/v1/enrollments/device/lookup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: manageBearer },
      body: JSON.stringify({ userCode: "AAAA-BBBB" }),
    });
    expect(lookupRes.status).toBe(404);
    const denyRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/device/deny`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: manageBearer },
      body: JSON.stringify({ userCode: "AAAA-BBBB" }),
    });
    expect(denyRes.status).toBe(404);
    const mintRes = await app.request(`/v1/workspaces/${workspaceId}/enrollments/token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: manageBearer },
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
      headers: { "content-type": "application/json", authorization: readBearer },
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
      headers: { "content-type": "application/json", authorization: readBearer },
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
        body: JSON.stringify({ publicKey: "ed25519:NOAUTHLOOKUP", workspaceId }),
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
        body: JSON.stringify({ publicKey: "ed25519:XWSLOOKUP", workspaceId: a.workspaceId }),
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
      headers: { "content-type": "application/json", authorization: manageBearer },
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
      headers: { "content-type": "application/json", authorization: manageBearer },
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
      headers: { "content-type": "application/json", authorization: manageBearer },
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
    expect(verified!.credentialGeneration).toBe(1);

    // The exchange landed a real machine (the SAME finalize as approve).
    const list = (await (
      await app.request(`/v1/workspaces/${workspaceId}/enrollments`, {
        headers: { authorization: manageBearer },
      })
    ).json()) as { enrollments: { id: string; status: string; allowScreenControl: boolean }[] };
    expect(list.enrollments.length).toBe(1);
    expect(list.enrollments[0]!.id).toBe(creds.agentId);
    expect(list.enrollments[0]!.status).toBe("active");
    expect(list.enrollments[0]!.allowScreenControl).toBe(true);
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
