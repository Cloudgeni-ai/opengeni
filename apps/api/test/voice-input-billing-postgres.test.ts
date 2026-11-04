import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  setWorkspaceAllowance,
  getWorkspaceUsage,
  ensureManagedAccessForUser,
  applyCreditLedgerEntry,
  getBillingBalance,
  listUsageEvents,
  type DbClient,
} from "@opengeni/db";
import { createVoiceInputBilling } from "@opengeni/core";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("voice-input-billing");
  if (!shared) throw Error("PostgreSQL required for credit settlement tests");
  client = createDb(shared.appUrl, { max: 8 });
}, 180000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180000);

test("one segment replay settles once; unfunded admission refuses under application-role RLS", async () => {
  const id = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId: id,
    email: `${id}@example.test`,
    name: "Voice fixture",
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId,
    workspaceId = grant.workspaceId!;
  await setWorkspaceAllowance(client!.db, {
    accountId,
    workspaceId,
    actorSubjectId: grant.subjectId,
    expectedVersion: 0,
    includedCredits: 10000,
    period: "monthly",
    memberDefault: { credits: 500 },
  });
  const attribution = { kind: "human" as const, initiatingHumanSubjectId: grant.subjectId };
  const billing = createVoiceInputBilling({
    db: client!.db,
    settings: testSettings({ billingMode: "stripe" }),
  });
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "insufficient_credits",
  });
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 10000,
    type: "grant",
    idempotencyKey: crypto.randomUUID(),
  });
  await billing.admit({ accountId, workspaceId, attribution });
  const input = {
    accountId,
    workspaceId,
    providerId: "azure-mai",
    model: "MAI-Transcribe-2",
    pricing: { microsPerMinute: 6000, marginBps: 500 },
    usage: { kind: "duration" as const, seconds: 5 },
    billing: {
      sourceId: `${id}:0`,
      attribution,
    },
  };
  const results = await Promise.all([billing.settle(input), billing.settle(input)]);
  expect(results).toEqual([{ creditCostMicros: 525 }, { creditCostMicros: 525 }]);
  expect((await getBillingBalance(client!.db, accountId)).balanceMicros).toBe(9475);
  const usage = await listUsageEvents(client!.db, { accountId, workspaceId, limit: 100 });
  expect(usage.filter((row) => row.eventType === "model.cost")).toHaveLength(1);
  const memberUsage = await getWorkspaceUsage(client!.db, {
    accountId,
    workspaceId,
    subjectId: grant.subjectId,
  });
  expect(memberUsage.members.find((member) => member.subjectId === grant.subjectId)?.used).toBe(
    525,
  );
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "allowance_exhausted",
  });
  expect(usage.find((row) => row.eventType === "model.cost")?.quantity).toBe(525);
}, 30000);

test("signup trial credits pay for dictation like general credits; chat-scoped credits and zero credits refuse", async () => {
  const id = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId: id,
    email: `${id}@example.test`,
    name: "Trial voice fixture",
  });
  const { accountId, workspaceId, subjectId } = access.workspaceGrants[0]!;
  if (!workspaceId) throw Error("fixture workspace missing");
  const attribution = { kind: "human" as const, initiatingHumanSubjectId: subjectId };
  const billing = createVoiceInputBilling({
    db: client!.db,
    settings: testSettings({ billingMode: "stripe" }),
  });
  // Zero credits: the honest out-of-credits path.
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "insufficient_credits",
    message: "Voice input needs credits. Add credits to continue.",
  });
  // A meeting's live transcript is refused in its own words.
  await expect(
    billing.admit({ accountId, workspaceId, attribution, feature: "live_transcript" }),
  ).rejects.toMatchObject({
    code: "insufficient_credits",
    message: "Live transcript needs credits. Add credits to continue.",
  });
  // A chat-model-scoped coupon does not pay for voice.
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 5000,
    type: "grant",
    eligibleModelIds: ["gpt-chat-only"],
    sourceType: "coupon",
    idempotencyKey: `coupon:${id}`,
    metadata: { creditOfferLabel: "Coupon credits" },
  });
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "insufficient_credits",
    message: "Promotional credits don't cover voice input. Add credits to use it.",
  });
  // Signup credits keep their chat-model scope yet also pay for voice.
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 1000,
    type: "grant",
    eligibleModelIds: ["gpt-chat-only"],
    sourceType: "verified_signup_trial",
    sourceId: id,
    idempotencyKey: `verified-signup-trial:v1:${id}`,
    metadata: { campaign: "verified_signup_trial_v1", creditOfferLabel: "Signup credits" },
  });
  const before = await getBillingBalance(client!.db, accountId);
  const trial = before.promotionalCredits!.find((grant) => grant.label === "Signup credits")!;
  expect(trial).toMatchObject({ remainingMicros: 1000, coversVoice: true });
  expect(
    before.promotionalCredits!.find((grant) => grant.label === "Coupon credits"),
  ).toMatchObject({ coversVoice: false });
  await billing.admit({ accountId, workspaceId, attribution });
  const settle = (index: number) =>
    billing.settle({
      accountId,
      workspaceId,
      providerId: "azure-mai",
      model: "MAI-Transcribe-2",
      pricing: { microsPerMinute: 6000, marginBps: 500 },
      usage: { kind: "duration", seconds: 5 },
      billing: { sourceId: `${id}:${index}`, attribution },
    });
  // Concurrent charges never allocate the same trial remainder twice.
  expect(await Promise.all([settle(0), settle(0), settle(1)])).toEqual([
    { creditCostMicros: 525 },
    { creditCostMicros: 525 },
    { creditCostMicros: 525 },
  ]);
  const after = await getBillingBalance(client!.db, accountId);
  // 1,050 used: the trial's 1,000 first, then 50 from general credit.
  expect(
    after.promotionalCredits!.find((grant) => grant.grantId === trial.grantId),
  ).toBeUndefined();
  expect(after.generalBalanceMicros).toBe(-50);
  expect(after.balanceMicros).toBe(before.balanceMicros - 1050);
  expect(
    after.promotionalCredits!.find((grant) => grant.label === "Coupon credits")?.remainingMicros,
  ).toBe(5000);
  // Trial exhausted and general negative: voice refuses again.
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "insufficient_credits",
  });
}, 30000);
