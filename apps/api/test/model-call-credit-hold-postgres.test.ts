import { expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  getBillingBalance,
  reserveModelCallCredits,
} from "@opengeni/db";
import * as provider from "@opengeni/runtime/model-call";
import { acquireRestrictedRuntimeTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createModelCallService } from "../src/model-calls/service";

const CALLS = 8;
const BALANCE_MICROS = 1_000_000;
const OUTPUT_TOKENS = 500_000;
const MODEL = "gpt-6-luna";

test("concurrent credit-billed model calls are admitted only while their holds fit the balance", async () => {
  const shared = await acquireRestrictedRuntimeTestDatabase("model-call-credit-hold");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  const client = createDb(shared.appUrl, { max: 12, searchPath: shared.schema });
  const restores: Array<{ mockRestore(): void }> = [];
  try {
    const user = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test:model-call-credit-hold",
      accountExternalId: user,
      accountName: "Model call credit hold",
      workspaceExternalSource: "test:model-call-credit-hold",
      workspaceExternalId: user,
      workspaceName: "Model call credit hold",
      subjectId: `user:${user}`,
    });
    const grant = access.workspaceGrants[0]!;
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      type: "credit_topup",
      amountMicros: BALANCE_MICROS,
      idempotencyKey: crypto.randomUUID(),
    });
    const settings = testSettings({ billingMode: "stripe", usageLimitsMode: "managed" });
    const selection = {
      model: {
        id: MODEL,
        credentialSource: { kind: "deployment" },
        billing: { metering: "opengeni_credits", upstreamPayer: "deployment" },
        capabilities: { inputModalities: ["text"], structuredOutput: { runnable: true } },
      },
    } as never;
    // Catalog and provider stay offline; admission, holds, settlement and the
    // credit ledger use their real implementations.
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
    const messages = [{ role: "user" as const, content: "fixture" }];
    const holdMicros = core.modelCallMaxCreditCostMicros(settings, MODEL, {
      messages,
      maxOutputTokens: OUTPUT_TOKENS,
    });
    const fitting = Math.floor(BALANCE_MICROS / holdMicros);
    expect(fitting).toBeGreaterThan(0);
    expect(fitting).toBeLessThan(CALLS);

    // No provider call returns until every call has been admitted or refused,
    // so all admissions overlap and none sees a settled debit.
    let dispatched = 0;
    let refused = 0;
    let heldWhileInFlight = -1;
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => (releaseAll = resolve));
    const heldMicros = async () => {
      const [row] = await shared.admin<{ micros: string }[]>`
        select coalesce(sum(amount_micros), 0)::text as micros
        from ${shared.admin(shared.schema)}.model_call_credit_holds
        where account_id = ${grant.accountId}::uuid`;
      return Number(row?.micros ?? 0);
    };
    const maybeRelease = () => {
      if (dispatched + refused !== CALLS) return;
      // Every call is now admitted or refused and none has settled.
      void heldMicros().then((micros) => {
        heldWhileInFlight = micros;
        releaseAll();
      }, releaseAll);
    };
    const seenRequests: unknown[] = [];
    const dispatch = spyOn(provider, "runSingleModelCall").mockImplementation((async (
      _target: unknown,
      request: unknown,
    ) => {
      seenRequests.push(request);
      dispatched += 1;
      maybeRelease();
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 60_000))]);
      // Each admitted call uses its whole output limit.
      return {
        text: "offline fixture",
        finishReason: "length",
        usage: {
          usage: { inputTokens: 0, outputTokens: OUTPUT_TOKENS, totalTokens: OUTPUT_TOKENS },
        },
      };
    }) as never);
    restores.push(dispatch);
    const service = createModelCallService({ db: client.db, settings });
    const call = (request: Record<string, unknown>) =>
      service.call({
        grant: { ...grant, principalKind: "api_key" },
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        model: MODEL,
        requestId: crypto.randomUUID(),
        request: { messages, ...request } as never,
      });

    const results = await Promise.allSettled(
      Array.from({ length: CALLS }, () =>
        call({ maxOutputTokens: OUTPUT_TOKENS }).catch((error: unknown) => {
          refused += 1;
          maybeRelease();
          throw error;
        }),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    // Only as many calls as the balance covers reach the provider, and their
    // holds never exceed the balance while they are in flight.
    expect(fulfilled).toHaveLength(fitting);
    expect(dispatch).toHaveBeenCalledTimes(fitting);
    expect(heldWhileInFlight).toBe(fitting * holdMicros);
    expect(heldWhileInFlight).toBeLessThanOrEqual(BALANCE_MICROS);
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({ status: 402, code: "api_credits_required" });
    }
    // Every admitted call is charged in full: nothing priced goes unpaid.
    const ledger = await shared.admin<{ amount: string; requested: string }[]>`
      select amount_micros::text as amount, metadata->>'requestedAmountMicros' as requested
      from ${shared.admin(shared.schema)}.credit_ledger_entries
      where account_id = ${grant.accountId}::uuid and type = 'model_usage_debit'`;
    expect(ledger).toHaveLength(fitting);
    const debited = ledger.reduce((sum, row) => sum - Number(row.amount), 0);
    const requested = ledger.reduce((sum, row) => sum + Number(row.requested), 0);
    expect(debited).toBe(requested);
    expect(debited).toBeLessThanOrEqual(BALANCE_MICROS);
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(
      BALANCE_MICROS - debited,
    );
    // Settled calls give their holds back.
    const remaining = async () =>
      Number(
        (
          await shared.admin<{ count: string }[]>`
            select count(*)::text as count
            from ${shared.admin(shared.schema)}.model_call_credit_holds
            where account_id = ${grant.accountId}::uuid`
        )[0]?.count,
      );
    expect(await remaining()).toBe(0);

    // A request without an output limit is sent with the default one its
    // hold was sized from.
    dispatch.mockClear();
    seenRequests.length = 0;
    dispatch.mockImplementation((async (_target: unknown, request: unknown) => {
      seenRequests.push(request);
      return { text: "offline fixture", finishReason: "stop", usage: null };
    }) as never);
    await call({});
    expect(seenRequests[0]).toMatchObject({
      maxOutputTokens: core.MODEL_CALL_DEFAULT_MAX_OUTPUT_TOKENS,
    });
    // A failed provider request releases its hold too.
    dispatch.mockImplementation((async () => {
      throw new Error("offline provider failure");
    }) as never);
    await expect(call({ maxOutputTokens: 1_000 })).rejects.toMatchObject({ status: 502 });
    expect(await remaining()).toBe(0);

    // A hold left behind by a process that stopped mid-call counts until it
    // expires, and then no longer does.
    const balance = (await getBillingBalance(client.db, grant.accountId)).balanceMicros;
    const reserve = (amountMicros: number) =>
      reserveModelCallCredits(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        requestId: crypto.randomUUID(),
        usage: MODEL,
        origin: "api",
        amountMicros,
      });
    expect((await reserve(balance)).reserved).toBe(true);
    expect((await reserve(1)).reserved).toBe(false);
    await shared.admin`
      update ${shared.admin(shared.schema)}.model_call_credit_holds
      set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      where account_id = ${grant.accountId}::uuid`;
    expect((await reserve(balance)).reserved).toBe(true);
    expect(await remaining()).toBe(1);
  } finally {
    for (const mocked of restores.reverse()) mocked.mockRestore();
    await client.close();
    await shared.release();
  }
}, 180_000);
