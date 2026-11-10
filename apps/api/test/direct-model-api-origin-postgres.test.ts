import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS } from "@opengeni/config";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import {
  applyCreditLedgerEntry,
  getBillingBalance,
  createApiKey,
  createDb,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  grantPlanCreditPeriod,
  upsertOrganizationPlan,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import * as provider from "@opengeni/runtime/model-call";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createManagedAuth } from "../src/auth/managed-auth";
import { createApp } from "../src/app";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";

/*
 * The direct model API (the OpenAI-compatible endpoint) is API use whatever
 * credential signs it, so Free plan credit never pays for it: a person's own
 * browser session and native app credential are refused like an API key
 * until the account has purchased credit, which then pays. An agent's call
 * keeps its chat's origin, a trusted dispatcher's stamp is kept, chats still
 * run on plan credit, and internal (legacy) accounts stay app use. End to end
 * through the HTTP app, real sign-in and PostgreSQL; only the model provider
 * and catalog are offline.
 */

const ORIGIN = "http://opengeni.test";
const SECRET = "direct-model-api-origin-secret-at-least-32-bytes";
const MODEL = "gpt-6-luna";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const restores: Array<{ mockRestore(): void }> = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("direct-model-api-origin");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Direct model API origin tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 180_000);

afterEach(() => {
  for (const mocked of restores.splice(0).reverse()) mocked.mockRestore();
  core.configureBillingLegacyAccounts([...DEFAULT_BILLING_LEGACY_ACCOUNT_IDS]);
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const noop = async () => undefined;

function runtime() {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
    publicBaseUrl: ORIGIN,
    betterAuthSecret: SECRET,
    delegationSecret: SECRET,
    sandboxBackend: "none",
    billingMode: "stripe",
    usageLimitsMode: "managed",
    openrouterApiKey: "test-key",
    openaiAllowedModels: `scripted-model,${MODEL}`,
  });
  const auth = createManagedAuth(settings, client!.db, {
    sender: "auth@example.test",
    idempotency: { scope: "test:direct-model-api-origin", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  })!;
  const adapter = createBetterAuthSessionAdapter(auth, client!.db);
  const app = createApp({
    settings,
    db: client!.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
    } as never,
  });
  // Keep the catalog and provider offline. Sign-in, origin, admission, RLS,
  // balances and settlement all use their real implementations.
  const selection = {
    model: {
      id: MODEL,
      credentialSource: { kind: "deployment" },
      billing: { metering: "opengeni_credits", upstreamPayer: "deployment" },
      capabilities: { inputModalities: ["text"], structuredOutput: { runnable: true } },
    },
  } as never;
  restores.push(
    spyOn(core, "resolveWorkspaceCatalogSettings").mockResolvedValue({ settings } as never),
    spyOn(core, "resolveCallerWorkspaceModelSelections").mockResolvedValue([selection]),
    spyOn(core, "admissibleWorkspaceModel").mockReturnValue(selection),
    spyOn(core, "settingsWithModelProviderCredentials").mockResolvedValue(settings),
    spyOn(provider.MultiProviderModelProvider.prototype, "resolveBinding").mockReturnValue({
      client: {},
      provider: { id: "offline" },
      modelId: MODEL,
    } as never),
  );
  const dispatch = spyOn(provider, "runSingleModelCall").mockResolvedValue({
    text: "offline answer",
    finishReason: "stop",
    usage: { usage: { inputTokens: 100_000, outputTokens: 10_000, totalTokens: 110_000 } },
  } as never);
  restores.push(dispatch);
  return { app, adapter, dispatch };
}

type Runtime = ReturnType<typeof runtime>;

/** A person who signed up: their own organization, on the Free plan only. */
async function freePerson(rt: Runtime) {
  const admin = shared!.admin;
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  await admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Free Human',${email},true)`;
  await admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at) values(${crypto.randomUUID()},${userId},'credential',${userId},null,now(),now())`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId,
    email,
    name: "Free Human",
    emailVerified: true,
  });
  await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client!.db, userId);
  const binding = projection.loginBindings.find((b) => b.providerId === "credential")!;
  const token = randomBytes(24).toString("hex");
  await admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${crypto.randomUUID()},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  const cookie = (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const [membership] = await admin<{ accountId: string; workspaceId: string }[]>`
    select account_id as "accountId", personal_workspace_id as "workspaceId"
    from organization_memberships where subject_id = ${`user:${userId}`} and status = 'active'`;
  const { accountId, workspaceId } = membership!;
  // A verified signup is what makes an organization eligible for Free credit.
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    type: "grant",
    amountMicros: 0,
    sourceType: "verified_signup_trial",
    sourceId: userId,
    idempotencyKey: `verified-signup-trial:v1:${userId}`,
    eligibleModelIds: [MODEL],
  });
  const period = {
    accountId,
    planKey: "free",
    periodStart: new Date(Date.now() - 1000),
    periodEnd: new Date(Date.now() + 3_600_000),
  };
  await upsertOrganizationPlan(client!.db, {
    ...period,
    status: "active",
    currentPeriodStart: period.periodStart,
    currentPeriodEnd: period.periodEnd,
  });
  await grantPlanCreditPeriod(client!.db, period);
  return { userId, subjectId: `user:${userId}`, accountId, workspaceId, cookie };
}

type Person = Awaited<ReturnType<typeof freePerson>>;

/** The person's own native app credential, from the real desktop sign-in. */
async function nativeAppCredential(rt: Runtime, person: Person): Promise<string> {
  const verifier = randomBytes(48).toString("base64url");
  const authorize = await rt.app.request("/v1/native-app/authorize", {
    method: "POST",
    headers: {
      cookie: person.cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      redirectUri: "opengeni://auth/callback",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      platform: "macos",
      deviceName: "Studio Mac",
    }),
  });
  expect(authorize.status).toBe(200);
  const { redirectUrl } = (await authorize.json()) as { redirectUrl: string };
  const redeemed = await rt.app.request("/v1/native-app/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: new URL(redirectUrl).searchParams.get("code"),
      codeVerifier: verifier,
      redirectUri: "opengeni://auth/callback",
    }),
  });
  expect(redeemed.status).toBe(200);
  const { accessToken } = (await redeemed.json()) as { accessToken: string };
  expect(accessToken.startsWith("ogapp_")).toBe(true);
  return accessToken;
}

async function apiKey(person: Person): Promise<string> {
  const key = `ogk_direct_${crypto.randomUUID().replaceAll("-", "")}`;
  await createApiKey(client!.db, {
    accountId: person.accountId,
    workspaceId: person.workspaceId,
    name: "Direct model API",
    prefix: key.slice(0, 12),
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["sessions:create"],
  });
  return key;
}

function completionRequest(person: Person, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/v1/workspaces/${person.workspaceId}/chat/completions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Hello" }] }),
  });
}

async function complete(rt: Runtime, person: Person, headers: Record<string, string>) {
  const response = await rt.app.fetch(completionRequest(person, headers));
  return { status: response.status, body: (await response.json()) as any };
}

/** Usage debits on the account: amount and the origin each was charged under. */
async function usageDebits(person: Person) {
  return await shared!.admin<{ amountMicros: string; usageOrigin: string | null }[]>`
    select amount_micros::text as "amountMicros", usage_origin as "usageOrigin"
    from credit_ledger_entries
    where account_id = ${person.accountId}::uuid and amount_micros < 0
    order by created_at`;
}

async function topUp(person: Person, amountMicros: number) {
  await applyCreditLedgerEntry(client!.db, {
    accountId: person.accountId,
    type: "credit_topup",
    amountMicros,
    idempotencyKey: crypto.randomUUID(),
  });
}

function expectAddCreditsRefusal(result: { status: number; body: any }) {
  expect(result.status).toBe(402);
  expect(result.body.error).toMatchObject({
    code: "api_credits_required",
    message: "API usage uses credits, not your plan credit. Add credits to use the API.",
  });
}

async function balances(person: Person) {
  const balance = await getBillingBalance(client!.db, person.accountId);
  return { credits: balance.creditsMicros, plan: balance.plan?.creditRemainingMicros };
}

/** A running agent attempt in a chat the person started in the app. */
async function agentAttemptToken(person: Person): Promise<string> {
  const session = await withSessionRlsActorContext({ subjectId: person.subjectId }, () =>
    createSession(client!.db, {
      accountId: person.accountId,
      workspaceId: person.workspaceId,
      initialMessage: "Ask the model",
      memoryScope: "workspace",
      resources: [],
      metadata: {},
      model: MODEL,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: person.subjectId },
      createdByContext: {},
    }),
  );
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const { accountId, workspaceId, subjectId } = person;
  await shared!.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.session_inference_claim','1',true)`;
    await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,
      status,source,position,prompt,model,reasoning_effort,sandbox_backend,execution_generation,
      initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id,billing_origin)
      VALUES(${turnId},${accountId},${workspaceId},${session.id},${crypto.randomUUID()},${`direct-${turnId}`},
        'running','user',1,'Ask the model',${MODEL},'medium','none',1,'subject',${subjectId},'{}',${subjectId},'app')`;
    await tx`UPDATE sessions SET active_turn_id=${turnId},status='running' WHERE id=${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id=${attemptId} WHERE id=${turnId}`;
    await tx`INSERT INTO session_turn_attempts(id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
      temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      VALUES(${attemptId},${accountId},${workspaceId},${session.id},${turnId},1,'running',${`direct-${turnId}`},
        ${`run-${attemptId}`},${`activity-${attemptId}`},0,'{}')`;
  });
  return await signDelegatedAccessToken(SECRET, {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["sessions:create"],
    principalKind: "agent_attempt",
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
}

test("a Free-only person's own sign-in is refused on the direct model API until they buy credit, which then pays", async () => {
  if (!client || !shared) return;
  const rt = runtime();
  const person = await freePerson(rt);
  const credential = await nativeAppCredential(rt, person);
  const asCookie = { cookie: person.cookie };
  const asApp = { authorization: `Bearer ${credential}` };

  // Neither the browser session nor the native app credential spends the
  // Free plan credit; nothing reaches the model.
  expectAddCreditsRefusal(await complete(rt, person, asCookie));
  expectAddCreditsRefusal(await complete(rt, person, asApp));
  expect(rt.dispatch).not.toHaveBeenCalled();
  expect(await usageDebits(person)).toEqual([]);
  expect(await balances(person)).toEqual({ credits: 0, plan: 10_000_000 });

  // Once the account has bought credit, the same calls run and that credit
  // pays; the Free plan credit is untouched.
  await topUp(person, 3_000_000);
  const viaCookie = await complete(rt, person, asCookie);
  const viaApp = await complete(rt, person, asApp);
  expect(viaCookie.status).toBe(200);
  expect(viaApp.status).toBe(200);
  expect(viaCookie.body.choices[0].message.content).toBe("offline answer");
  expect(rt.dispatch).toHaveBeenCalledTimes(2);
  const debits = await usageDebits(person);
  expect(debits.map((debit) => debit.usageOrigin)).toEqual(["api", "api"]);
  const spent = debits.reduce((sum, debit) => sum - Number(debit.amountMicros), 0);
  expect(spent).toBeGreaterThan(0);
  expect(await balances(person)).toEqual({ credits: 3_000_000 - spent, plan: 10_000_000 });
}, 180_000);

test("an API key is refused without purchased credit and paid from it afterwards, as before", async () => {
  if (!client || !shared) return;
  const rt = runtime();
  const person = await freePerson(rt);
  const asKey = { authorization: `Bearer ${await apiKey(person)}` };
  expectAddCreditsRefusal(await complete(rt, person, asKey));
  expect(rt.dispatch).not.toHaveBeenCalled();
  await topUp(person, 3_000_000);
  expect((await complete(rt, person, asKey)).status).toBe(200);
  expect((await usageDebits(person)).map((debit) => debit.usageOrigin)).toEqual(["api"]);
  expect((await balances(person)).plan).toBe(10_000_000);
}, 180_000);

test("chats, agents in them and trusted in-app dispatch keep running on Free plan credit", async () => {
  if (!client || !shared) return;
  const rt = runtime();
  const person = await freePerson(rt);

  // A chat the person starts in the app is still app use.
  const started = await rt.app.request(`/v1/workspaces/${person.workspaceId}/sessions`, {
    method: "POST",
    headers: {
      cookie: person.cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      initialMessage: "Hello",
      model: MODEL,
      tools: [],
      visibility: "workspace",
    }),
  });
  expect(started.status).toBe(202);
  const { id: sessionId } = (await started.json()) as { id: string };
  const [turn] = await shared.admin<{ billingOrigin: string | null }[]>`
    select billing_origin as "billingOrigin" from session_turns
    where workspace_id = ${person.workspaceId}::uuid and session_id = ${sessionId}::uuid`;
  expect(turn?.billingOrigin).toBe("app");

  // An agent in that app chat calling the endpoint keeps its chat's origin.
  const agent = await complete(rt, person, {
    authorization: `Bearer ${await agentAttemptToken(person)}`,
  });
  expect(agent.status).toBe(200);

  // So does a call an in-process dispatcher stamped as app use (an agent's
  // app action in an app chat), even though it carries the person's sign-in.
  const stamped = completionRequest(person, { cookie: person.cookie });
  core.stampRequestBillingOrigin(stamped, "app");
  expect((await rt.app.fetch(stamped)).status).toBe(200);

  const debits = await usageDebits(person);
  expect(debits.map((debit) => debit.usageOrigin)).toEqual(["app", "app"]);
  const spent = debits.reduce((sum, debit) => sum - Number(debit.amountMicros), 0);
  expect(await balances(person)).toEqual({ credits: 0, plan: 10_000_000 - spent });
}, 180_000);

test("an internal (legacy) account's own sign-in stays app use on the direct model API", async () => {
  if (!client || !shared) return;
  const rt = runtime();
  const person = await freePerson(rt);
  core.configureBillingLegacyAccounts([...DEFAULT_BILLING_LEGACY_ACCOUNT_IDS, person.accountId]);
  const result = await complete(rt, person, { cookie: person.cookie });
  expect(result.status).toBe(200);
  expect((await usageDebits(person)).map((debit) => debit.usageOrigin)).toEqual(["app"]);
  expect((await balances(person)).credits).toBe(0);
}, 180_000);
