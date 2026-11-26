import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { AiProcessingConsentResponse, AI_PROCESSING_CONSENT_REQUIRED } from "@opengeni/contracts";
import type { TranscriptionService } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  setSubjectRlsContext,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";

const ORIGIN = "http://opengeni.test";
const PATH = "/v1/me/ai-processing-consent";
let shared: SharedTestDatabase;
let db: DbClient;

beforeAll(async () => {
  const fixture = await acquireSharedTestDatabase("ai-processing-consent");
  if (!fixture) throw new Error("AI processing consent integration requires PostgreSQL");
  shared = fixture;
  db = createDb(shared.appUrl, { max: 6, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await db?.close();
  await shared?.release();
});

function runtime(providers = ["Example AI", "Example Voice"]) {
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: ORIGIN,
    betterAuthSecret: "native-ai-consent-test-secret-at-least-32-bytes",
    aiProcessingConsentProviders: providers,
    aiProcessingConsentPrivacyUrl: "https://example.test/privacy",
  });
  const auth = createManagedAuth(settings, db.db, {
    sender: "auth@example.test",
    idempotency: { scope: "test:native-ai-consent", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  })!;
  const adapter = createBetterAuthSessionAdapter(auth, db.db);
  const transcribe = mock<TranscriptionService["transcribe"]>().mockResolvedValue({
    text: "offline result",
    languages: ["en"],
    providerId: "test",
    audioSeconds: 1,
    latencyMs: 1,
  });
  const app = createApp({
    settings,
    db: db.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    transcription: {
      limits: () => ({
        maxDurationSeconds: 60,
        maxSizeBytes: 10,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      transcribe,
    },
  });
  return { app, adapter, transcribe };
}

type Runtime = ReturnType<typeof runtime>;

async function person(rt: Runtime) {
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  await shared.admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Test Human',${email},true)`;
  await shared.admin`insert into auth_identities(id,user_id,provider_id,account_id,created_at,updated_at) values(${crypto.randomUUID()},${userId},'credential',${userId},now(),now())`;
  const { accessContext } = await ensureManagedAccessForUserWithOrganizationMemberships(db.db, {
    userId,
    email,
    name: "Test Human",
    emailVerified: true,
  });
  await synchronizeCanonicalHumanLoginBindings(db.db, userId);
  const { activeIdentity, loginBindings } = await getCanonicalHumanIdentityProjection(
    db.db,
    userId,
  );
  const binding = loginBindings.find((item) => item.providerId === "credential")!;
  const token = randomBytes(24).toString("hex");
  await shared.admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${crypto.randomUUID()},${userId},${token},now()+interval '1 hour',${activeIdentity.id},${activeIdentity.identityRevision},${activeIdentity.authRevision},${binding.id},${binding.revision})`;
  const cookie = (await rt.adapter.createLegacySelectedSessionCookies({ token } as never))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return {
    userId,
    cookie,
    workspaceId: accessContext.defaultWorkspaceId!,
    accountId: accessContext.defaultAccountId!,
  };
}

async function nativeSignIn(rt: Runtime, cookie: string, platform: "ios" | "android") {
  const codeVerifier = randomBytes(48).toString("base64url");
  const redirectUri = "opengeni://auth/callback";
  const authorize = await rt.app.request("/v1/native-app/authorize", {
    method: "POST",
    headers: {
      cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      redirectUri,
      codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      codeChallengeMethod: "S256",
      platform,
    }),
  });
  expect(authorize.status).toBe(200);
  const { redirectUrl } = await authorize.json();
  const redeemed = await rt.app.request("/v1/native-app/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: new URL(redirectUrl).searchParams.get("code"),
      codeVerifier,
      redirectUri,
    }),
  });
  expect(redeemed.status).toBe(200);
  const { accessToken } = await redeemed.json();
  return {
    authorization: `Bearer ${accessToken}`,
    token: accessToken.slice("ogapp_".length) as string,
  };
}

async function consent(
  rt: Runtime,
  headers: Record<string, string>,
  method = "GET",
  version?: string,
) {
  return rt.app.request(PATH, {
    method,
    headers,
    ...(version === undefined ? {} : { body: JSON.stringify({ version }) }),
  });
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: {
      code: "forbidden",
      retryable: false,
      details: { code: AI_PROCESSING_CONSENT_REQUIRED },
    },
  });
}

test("a human grants, replaces and withdraws current consent; accepted disclosure and subject isolation are durable", async () => {
  const rt = runtime();
  const p = await person(rt);
  const other = await person(rt);
  const device = await nativeSignIn(rt, p.cookie, "ios");
  const headers = { authorization: device.authorization, "content-type": "application/json" };
  const initial = await consent(rt, headers);
  expect(initial.status).toBe(200);
  expect(initial.headers.get("cache-control")).toBe("private, no-store");
  const state = AiProcessingConsentResponse.parse(await initial.json());
  expect(state).toMatchObject({
    required: true,
    consent: null,
    disclosure: {
      providers: ["Example AI", "Example Voice"],
      privacyUrl: "https://example.test/privacy",
    },
  });
  expect(state.disclosure.body).toContain("Example AI, Example Voice");
  const [marker] =
    await shared.admin`select native_app_platform from auth_sessions where token = ${device.token}`;
  expect(marker?.native_app_platform).toBe("ios");

  const grants = await Promise.all(
    Array.from({ length: 3 }, () => consent(rt, headers, "POST", state.disclosure.version)),
  );
  const granted = AiProcessingConsentResponse.parse(await grants[0]!.json());
  expect(granted).toMatchObject({
    required: false,
    consent: { platform: "ios", version: state.disclosure.version },
  });
  for (const same of grants.slice(1)) expect(await same.json()).toEqual(granted);
  expect(await (await consent(rt, { cookie: p.cookie })).json()).toEqual(granted);
  expect(await (await consent(rt, { cookie: other.cookie })).json()).toMatchObject({
    required: true,
    consent: null,
  });
  expect((await consent(rt, { cookie: p.cookie }, "DELETE")).status).toBe(403);
  await db.db.transaction(async (tx) => {
    await setSubjectRlsContext(tx as unknown as Database, `user:${other.userId}`);
    expect(
      await tx.execute(sql`select id from ai_processing_consents where auth_user_id = ${p.userId}`),
    ).toHaveLength(0);
  });

  const next = runtime(["New Provider"]);
  const nextState = AiProcessingConsentResponse.parse(await (await consent(next, headers)).json());
  expect(nextState.disclosure.version).not.toBe(state.disclosure.version);
  expect(nextState).toMatchObject({ required: true, consent: null });
  const stale = await consent(next, headers, "POST", state.disclosure.version);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: { code: "conflict", details: { code: "ai_processing_consent_version_mismatch" } },
  });
  const web = {
    cookie: p.cookie,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const replacement = await consent(next, web, "POST", nextState.disclosure.version);
  expect(replacement.status).toBe(200);
  expect(await replacement.json()).toMatchObject({ required: false, consent: { platform: "web" } });
  expect(await (await consent(rt, headers)).json()).toMatchObject({
    required: true,
    consent: null,
  });
  for (const actor of [headers, web]) {
    const withdrawn = await consent(next, actor, "DELETE");
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({ required: true, consent: null });
  }
  const history =
    await shared.admin`select disclosure, withdrawn_at from ai_processing_consents where auth_user_id = ${p.userId} order by granted_at`;
  expect(history.map((row) => row.disclosure)).toEqual([state.disclosure, nextState.disclosure]);
  expect(history.every((row) => row.withdrawn_at != null)).toBe(true);
});

test("native text and voice admissions fail closed while web and API key dictation still works", async () => {
  const rt = runtime();
  const p = await person(rt);
  const device = await nativeSignIn(rt, p.cookie, "android");
  // The old auth flow stored only the device label. An incoming User-Agent
  // doesn't change the persisted provenance of that credential.
  await shared.admin`update auth_sessions set native_app_platform = null where token = ${device.token}`;
  const headers = {
    authorization: device.authorization,
    "content-type": "application/json",
    "user-agent": "Regular Browser",
  };
  const base = `/v1/workspaces/${p.workspaceId}`;
  const session = await withSessionRlsActorContext({ subjectId: `user:${p.userId}` }, () =>
    createSession(db.db, {
      accountId: p.accountId,
      workspaceId: p.workspaceId,
      initialMessage: "Existing session",
      memoryScope: "workspace",
      resources: [],
      metadata: {},
      model: "gpt-6-luna",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: `user:${p.userId}` },
      createdByContext: {},
    }),
  );
  for (const [path, body] of [
    [`${base}/sessions`, { initialMessage: "Hello" }],
    [`${base}/sessions/${session.id}/events`, { type: "user.message", payload: { text: "Hello" } }],
    [`${base}/sessions/${session.id}/steer`, { text: "Hello" }],
    [`${base}/sessions/${session.id}/realtime`, {}],
    [`${base}/sessions/${session.id}/realtime/webrtc`, {}],
    [`${base}/sessions/${session.id}/realtime/websocket`, {}],
    [`${base}/recordings/${crypto.randomUUID()}/live-session`, {}],
    [`${base}/chat/completions`, { messages: [{ role: "user", content: "Hello" }] }],
  ] as const) {
    await expectRefused(
      await rt.app.request(path, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }
  expect((await rt.app.request(`${base}/sessions/${session.id}`, { headers })).status).toBe(200);
  const transcribe = (actor: Record<string, string>) =>
    rt.app.request(`${base}/transcriptions`, {
      method: "POST",
      headers: { ...actor, "content-type": "audio/webm" },
      body: new Uint8Array([1]),
    });
  await expectRefused(await transcribe(headers));
  expect(rt.transcribe).not.toHaveBeenCalled();

  const key = `ogk_consent_${crypto.randomUUID().replaceAll("-", "")}`;
  await createApiKey(db.db, {
    accountId: p.accountId,
    workspaceId: p.workspaceId,
    name: "Consent fixture",
    prefix: key.slice(0, 12),
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["sessions:create"],
  });
  const api = { authorization: `Bearer ${key}` };
  expect((await transcribe({ cookie: p.cookie })).status).toBe(200);
  expect((await transcribe(api)).status).toBe(200);
  for (const method of ["GET", "POST", "DELETE"]) {
    expect((await consent(rt, api, method)).status).toBe(403);
  }
  const { disclosure } = AiProcessingConsentResponse.parse(
    await (await consent(rt, headers)).json(),
  );
  const granted = await consent(rt, headers, "POST", disclosure.version);
  expect(granted.status).toBe(200);
  expect(await granted.json()).toMatchObject({ consent: { platform: "android" } });
  expect((await transcribe(headers)).status).toBe(200);
  expect(rt.transcribe).toHaveBeenCalledTimes(3);
  expect((await consent(rt, headers, "DELETE")).status).toBe(200);
  await expectRefused(await transcribe(headers));
  expect(rt.transcribe).toHaveBeenCalledTimes(3);
});
