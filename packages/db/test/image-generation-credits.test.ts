import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  applyCreditLedgerEntry,
  beginImageGenerationOperation,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeImageGenerationOperation,
  createDb,
  createSession,
  getBillingBalance,
  getImageGenerationOperation,
  ImageGenerationCreditError,
  initializeSessionStartAtomically,
  markImageGenerationOperationOutcomeUnknown,
  prepareGeneratedImageArtifact,
  prepareImageGenerationOperation,
  resetImageGenerationOperationBeforeProviderDispatch,
  setWorkspaceAllowance,
  settleGeneratedImageArtifactReady,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("image-generation-credits");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required for image credit tests");
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const PRICE = 250_000;
const PROVIDER_ID = "vercel-ai-gateway";
const BINDING = "a".repeat(64);
const CHAT_MODEL = "scripted-model";

async function fixture(creditMicros: number, scopedCreditMicros = 0) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `image-credit-account-${suffix}`,
    accountName: "Image credit test account",
    workspaceExternalSource: "test",
    workspaceExternalId: `image-credit-workspace-${suffix}`,
    workspaceName: "Image credit test workspace",
    subjectId: `image-credit-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  if (creditMicros > 0) {
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "test_credit",
      amountMicros: creditMicros,
      sourceType: "test",
      sourceId: grant.workspaceId,
      idempotencyKey: `test:image-credit:${grant.workspaceId}`,
    });
  }
  if (scopedCreditMicros > 0) {
    // A trial-style grant that only pays for the chat model the turn runs on.
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "grant",
      amountMicros: scopedCreditMicros,
      eligibleModelIds: [CHAT_MODEL],
      idempotencyKey: `test:image-credit-scoped:${grant.workspaceId}`,
    });
  }
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Make a picture of a cat wearing a birthday hat",
    resources: [],
    metadata: {},
    model: CHAT_MODEL,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `image-credit-${suffix}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Could not claim fixture: ${claim.reason}`);
  return { grant, session, turnId: claim.turn.id, attemptId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function preparePriced(
  value: Fixture,
  toolCallId: string,
  pricedCostMicros = PRICE,
  creditUsageModelId?: string,
) {
  const operation = {
    id: crypto.randomUUID(),
    operationKey: crypto.randomUUID().replaceAll("-", "").repeat(2),
    expectedArtifactId: crypto.randomUUID(),
  };
  const prepared = await prepareImageGenerationOperation(client.db, {
    ...operation,
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    turnId: value.turnId,
    attemptId: value.attemptId,
    toolCallId,
    providerId: PROVIDER_ID,
    providerBindingHash: BINDING,
    modelId: "openai/gpt-image-2",
    requestDigest: "e".repeat(64),
    pricedCostMicros,
    ...(creditUsageModelId ? { creditUsageModelId } : {}),
  });
  return { ...operation, prepared: prepared.operation };
}

function scope(value: Fixture, operation: { id: string; operationKey: string }) {
  return {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    operationId: operation.id,
    operationKey: operation.operationKey,
  };
}

async function begin(
  value: Fixture,
  operation: { id: string; operationKey: string; expectedArtifactId: string },
) {
  return await beginImageGenerationOperation(client.db, {
    ...scope(value, operation),
    providerBindingHash: BINDING,
    expectedArtifactId: operation.expectedArtifactId,
  });
}

async function retainReadyArtifact(
  value: Fixture,
  operation: { id: string; operationKey: string; expectedArtifactId: string },
  toolCallId: string,
  options: { completeOperation?: boolean } = {},
) {
  const uploadId = crypto.randomUUID();
  const artifactId = operation.expectedArtifactId;
  const filename = `generated-image-${artifactId}.png`;
  await prepareGeneratedImageArtifact(client.db, {
    artifactId,
    uploadId,
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    turnId: value.turnId,
    attemptId: value.attemptId,
    settlementKey: operation.operationKey,
    toolCallId,
    sourceStrategy: "provider_adapter",
    providerId: PROVIDER_ID,
    providerBindingHash: BINDING,
    providerItemId: null,
    mediaType: "image/png",
    sizeBytes: 1,
    sha256: "f".repeat(64),
    width: 1,
    height: 1,
    sandboxPath: `/workspace/generated-images/${filename}`,
    filename,
    safeFilename: filename,
    bucket: "test",
    objectKey: `generated-images/${artifactId}`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
  });
  await shared!.admin`update files set status = 'ready' where id = ${artifactId}`;
  await shared!.admin`
    update file_uploads set status = 'completed', completed_at = now() where id = ${uploadId}`;
  await settleGeneratedImageArtifactReady(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    artifactId,
    settlementKey: operation.operationKey,
    ...(options.completeOperation
      ? { operation: { operationId: operation.id, operationKey: operation.operationKey } }
      : {}),
  });
}

async function imageLedger(value: Fixture) {
  const rows = await shared!.admin<{ type: string; amount: string; sourceId: string }[]>`
    select type, amount_micros::text as amount, source_id as "sourceId"
    from credit_ledger_entries
    where account_id = ${value.grant.accountId} and type like 'image_generation%'`;
  return [...rows];
}

async function imageUsage(value: Fixture) {
  const rows = await shared!.admin<{ eventType: string; quantity: string; turnId: string }[]>`
    select event_type as "eventType", quantity::text as quantity, turn_id::text as "turnId"
    from usage_events
    where workspace_id = ${value.grant.workspaceId} and event_type like 'image_generation%'`;
  return [...rows];
}

async function workspaceAllowanceUsed(workspaceId: string): Promise<number> {
  const [row] = await shared!.admin`
    select coalesce(sum(used),0)::bigint as used from opengeni_private.workspace_allowance_counters
    where workspace_id=${workspaceId} and subject_id=''`;
  return Number(row?.used ?? 0);
}

describe("Opengeni-credit funded image generation", () => {
  test("admits before dispatch and debits the frozen price once when the image is delivered", async () => {
    if (!available) return;
    const value = await fixture(1_000_000);
    const operation = await preparePriced(value, "call-credit-image");
    expect(operation.prepared).toMatchObject({ pricedCostMicros: PRICE, creditState: "pending" });

    const begun = await begin(value, operation);
    expect(begun.started).toBe(true);
    // Admission charges nothing; only a delivered image is debited.
    expect((await getBillingBalance(client.db, value.grant.accountId)).balanceMicros).toBe(
      1_000_000,
    );
    expect(await imageLedger(value)).toEqual([]);

    await retainReadyArtifact(value, operation, "call-credit-image");
    const completed = await completeImageGenerationOperation(client.db, scope(value, operation));
    expect(completed).toMatchObject({ status: "completed", creditState: "debited" });
    // Recovery and retries converge on the same completed operation.
    await completeImageGenerationOperation(client.db, scope(value, operation));

    expect((await getBillingBalance(client.db, value.grant.accountId)).balanceMicros).toBe(
      1_000_000 - PRICE,
    );
    expect(await imageLedger(value)).toEqual([
      { type: "image_generation_debit", amount: String(-PRICE), sourceId: operation.id },
    ]);
    expect(await imageUsage(value)).toEqual([
      { eventType: "image_generation.cost", quantity: String(PRICE), turnId: value.turnId },
    ]);
    expect(await workspaceAllowanceUsed(value.grant.workspaceId)).toBe(PRICE);
  }, 60_000);

  test("refuses an image the spendable balance cannot cover before any provider request", async () => {
    if (!available) return;
    const value = await fixture(100_000);
    const operation = await preparePriced(value, "call-insufficient-image");
    const refused = begin(value, operation);
    await expect(refused).rejects.toBeInstanceOf(ImageGenerationCreditError);
    await expect(refused).rejects.toMatchObject({ code: "insufficient_credits" });
    await expect(refused).rejects.toThrow("doesn't have enough Opengeni credits left");
    const stored = await getImageGenerationOperation(
      client.db,
      value.grant.workspaceId,
      operation.id,
    );
    expect(stored).toMatchObject({
      status: "prepared",
      providerStartedAt: null,
      creditState: "pending",
    });
    expect((await getBillingBalance(client.db, value.grant.accountId)).balanceMicros).toBe(100_000);
    expect(await imageLedger(value)).toEqual([]);
  }, 60_000);

  test("refuses an image when the workspace usage allowance is exhausted", async () => {
    if (!available) return;
    const value = await fixture(1_000_000);
    // Allowances are organization-administrator settings.
    const personalId = crypto.randomUUID();
    await shared!.admin`
      insert into workspaces(id,account_id,name) values(${personalId},${value.grant.accountId},'Personal')`;
    await shared!.admin`
      insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
      values(${value.grant.accountId},${value.grant.subjectId},'owner','active',${personalId})`;
    await setWorkspaceAllowance(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      actorSubjectId: value.grant.subjectId,
      includedCredits: 0,
      period: "monthly",
      expectedVersion: 0,
    });
    const operation = await preparePriced(value, "call-allowance-image");
    await expect(begin(value, operation)).rejects.toMatchObject({
      name: "ImageGenerationCreditError",
      code: "allowance_exhausted",
      message: "this workspace's usage allowance is used up",
    });
    expect(
      (await getImageGenerationOperation(client.db, value.grant.workspaceId, operation.id))?.status,
    ).toBe("prepared");
    expect(await imageLedger(value)).toEqual([]);
  }, 60_000);

  test("never charges a failed or ambiguous provider request", async () => {
    if (!available) return;
    const value = await fixture(1_000_000);
    const operation = await preparePriced(value, "call-failed-image");
    expect((await begin(value, operation)).started).toBe(true);
    const unknown = await markImageGenerationOperationOutcomeUnknown(client.db, {
      ...scope(value, operation),
      error: "AI Gateway image generation failed (400)",
    });
    expect(unknown).toMatchObject({ status: "outcome_unknown", creditState: "pending" });
    expect((await getBillingBalance(client.db, value.grant.accountId)).balanceMicros).toBe(
      1_000_000,
    );
    expect(await imageLedger(value)).toEqual([]);
    expect(await imageUsage(value)).toEqual([]);
  }, 60_000);

  test("an unpriced operation keeps today's behavior and the database rejects a debit-free completion", async () => {
    if (!available) return;
    const value = await fixture(0);
    const unpriced = await preparePriced(value, "call-unpriced-image", 0);
    expect(unpriced.prepared).toMatchObject({ pricedCostMicros: 0, creditState: "not_applicable" });
    expect((await begin(value, unpriced)).started).toBe(true);
    await retainReadyArtifact(value, unpriced, "call-unpriced-image");
    expect(await completeImageGenerationOperation(client.db, scope(value, unpriced))).toMatchObject(
      { status: "completed", creditState: "not_applicable" },
    );
    expect(await imageLedger(value)).toEqual([]);

    // A binary without credit funding cannot deliver a priced image for free.
    const priced = await preparePriced(value, "call-old-binary-image");
    await expect(
      shared!.admin`
        update image_generation_operations
        set status = 'completed', provider_started_at = now(), completed_at = now()
        where id = ${priced.id}`,
    ).rejects.toThrow("image_generation_operations_credit_chk");
  }, 60_000);

  test("the image turning ready and its charge commit in one transaction", async () => {
    if (!available) return;
    const value = await fixture(1_000_000);
    const operation = await preparePriced(value, "call-atomic-image");
    expect((await begin(value, operation)).started).toBe(true);
    await retainReadyArtifact(value, operation, "call-atomic-image", { completeOperation: true });
    // No separate completion call: settlement already completed and charged it.
    expect(
      await getImageGenerationOperation(client.db, value.grant.workspaceId, operation.id),
    ).toMatchObject({ status: "completed", creditState: "debited" });
    expect(await imageLedger(value)).toEqual([
      { type: "image_generation_debit", amount: String(-PRICE), sourceId: operation.id },
    ]);
    // The worker's follow-up completion is an idempotent no-op.
    await completeImageGenerationOperation(client.db, scope(value, operation));
    expect(await imageLedger(value)).toHaveLength(1);
  }, 60_000);

  test("plan and trial grants covering the turn's chat model pay for the image", async () => {
    if (!available) return;
    const value = await fixture(0, 1_000_000);
    // Without the turn's model, only general credit counts, and there is none.
    const general = await preparePriced(value, "call-general-only-image");
    await expect(begin(value, general)).rejects.toMatchObject({ code: "insufficient_credits" });

    const operation = await preparePriced(value, "call-trial-image", PRICE, CHAT_MODEL);
    expect(operation.prepared).toMatchObject({ creditUsageModelId: CHAT_MODEL });
    expect((await begin(value, operation)).started).toBe(true);
    await retainReadyArtifact(value, operation, "call-trial-image", { completeOperation: true });

    const balance = await getBillingBalance(client.db, value.grant.accountId);
    expect(balance.balanceMicros).toBe(1_000_000 - PRICE);
    expect(balance.promotionalCredits?.[0]?.remainingMicros).toBe(1_000_000 - PRICE);
    const [allocation] = await shared!.admin<{ amount: string }[]>`
      select a.amount_micros::text as amount
      from credit_debit_allocations a
      join credit_ledger_entries d on d.id = a.debit_entry_id
      where d.source_id = ${operation.id}`;
    expect(allocation?.amount).toBe(String(PRICE));
  }, 60_000);

  test("an image still in its provider request holds its price against parallel images", async () => {
    if (!available) return;
    const value = await fixture(400_000);
    const first = await preparePriced(value, "call-parallel-image-1");
    const second = await preparePriced(value, "call-parallel-image-2");
    expect((await begin(value, first)).started).toBe(true);
    // 400,000 covers one 250,000 image, not two in flight.
    await expect(begin(value, second)).rejects.toMatchObject({ code: "insufficient_credits" });

    // Once the first has failed ambiguously it is never charged and stops holding.
    await markImageGenerationOperationOutcomeUnknown(client.db, {
      ...scope(value, first),
      error: "provider timed out",
    });
    expect((await begin(value, second)).started).toBe(true);
  }, 60_000);

  test("an image the provider refused outright is never charged and stops holding at once", async () => {
    if (!available) return;
    const value = await fixture(400_000);
    const refused = await preparePriced(value, "call-refused-image");
    const next = await preparePriced(value, "call-after-refusal");
    expect((await begin(value, refused)).started).toBe(true);
    await expect(begin(value, next)).rejects.toMatchObject({ code: "insufficient_credits" });

    // The image provider answered 402 (its own account is out of credit).
    const reset = await resetImageGenerationOperationBeforeProviderDispatch(client.db, {
      ...scope(value, refused),
      error: "AI Gateway image generation failed (402): Insufficient funds.",
    });
    expect(reset).toMatchObject({ status: "prepared", creditState: "pending" });
    expect((await getBillingBalance(client.db, value.grant.accountId)).balanceMicros).toBe(400_000);
    expect(await imageLedger(value)).toEqual([]);
    expect(await imageUsage(value)).toEqual([]);
    expect((await begin(value, next)).started).toBe(true);
  }, 60_000);
});
