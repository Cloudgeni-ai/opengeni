import { sql } from "drizzle-orm";
import type { UpdateBillingAutoTopUpRequest } from "@opengeni/contracts";
import { isTransactionHandle, rawRows, withAccountRls, type Database } from "./database";
import { applyCreditLedgerEntryOnce } from "./credit-ledger";
import { getBillingBalance } from "./credit-balances";
import { getBillingCustomer } from "./billing-customer";
import { listSelfOrganizationMemberships } from "./organization-membership-lifecycle";

export type AutoTopUpSettingsRow = {
  account_id: string;
  enabled: boolean;
  threshold_micros: number;
  amount_micros: number;
  monthly_cap_micros: number;
  consent_subject: string | null;
  consent_version: string | null;
  consent_at: string | null;
  provider: "stripe:test" | "stripe:live" | null;
  customer_id: string | null;
  payment_method_id: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
  setup_key: string | null;
  setup_subject: string | null;
  failure_reason: string | null;
  cap_required_micros: number | null;
  revision: string;
};
export type AutoTopUpIntent = {
  provider: "stripe:test" | "stripe:live";
  customerId: string;
  paymentMethodId: string;
  consentSubject: string;
  settingsRevision: string;
  taxCalculationId: string;
  taxExpiresAt: number;
  receiptEmail: string | null;
};
export type AutoTopUpOperation = {
  account_id: string;
  operation_key: string;
  state: "pending" | "succeeded" | "failed";
  reservation_month: string;
  credit_micros: number;
  charge_micros: number;
  intent: AutoTopUpIntent;
  payment_intent_id: string | null;
  confirmation_started_at: string | null;
  charged_at: string | null;
  failure_reason: string | null;
  notification_delivered_at: string | null;
  created_at: string;
  completed_at: string | null;
};
export type AutoTopUpNotification = {
  accountId: string;
  kind: "topup_success" | "topup_failed" | "cap_reached";
  operationKey: string;
  amountMicros: number;
  chargeMicros: number;
  failureReason?: string;
};
/** The notification worker owns delivery/outbox. Enqueue with this transaction and
 * stable operationKey; never send network email from this callback. */
export type AutoTopUpNotificationPort = (
  tx: Database,
  event: AutoTopUpNotification,
) => Promise<void>;

export class AutoTopUpStoreError extends Error {
  constructor(
    public readonly status: 403 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export class AutoTopUpAccountStore {
  constructor(
    readonly tx: Database,
    readonly accountId: string,
    readonly notify?: AutoTopUpNotificationPort,
  ) {}

  async settings(): Promise<AutoTopUpSettingsRow | null> {
    const [row] = await rawRows<{ value: AutoTopUpSettingsRow }>(
      this.tx,
      sql`select to_jsonb(s) as value from billing_auto_top_up_settings s where account_id = ${this.accountId}::uuid`,
    );
    return row?.value ?? null;
  }
  async clock(): Promise<{ now: string; month: string }> {
    const [row] = await rawRows<{ now: string; month: string }>(
      this.tx,
      sql`select clock_timestamp()::text as now, to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-01') as month`,
    );
    return row!;
  }
  async spent(): Promise<number> {
    const [row] = await rawRows<{ spent: string }>(
      this.tx,
      sql`select coalesce(sum(charge_micros), 0)::text as spent
      from billing_auto_top_up_operations where account_id = ${this.accountId}::uuid and state <> 'failed'
      and (state = 'pending' or reservation_month = date_trunc('month', clock_timestamp() at time zone 'UTC')::date
        or date_trunc('month', charged_at at time zone 'UTC') = date_trunc('month', clock_timestamp() at time zone 'UTC'))`,
    );
    return Number(row!.spent);
  }
  async operation(key: string): Promise<AutoTopUpOperation | null> {
    const [row] = await rawRows<{ value: AutoTopUpOperation }>(
      this.tx,
      sql`select to_jsonb(o) as value from billing_auto_top_up_operations o where account_id = ${this.accountId}::uuid and operation_key = ${key}::uuid`,
    );
    return row?.value ?? null;
  }
  async pending(): Promise<AutoTopUpOperation | null> {
    const [row] = await rawRows<{ value: AutoTopUpOperation }>(
      this.tx,
      sql`select to_jsonb(o) as value from billing_auto_top_up_operations o where account_id = ${this.accountId}::uuid and state = 'pending'`,
    );
    return row?.value ?? null;
  }
  async assertOwner(subject: string): Promise<void> {
    const memberships = await listSelfOrganizationMemberships(this.tx, subject);
    if (
      !memberships.some(
        (m) => m.organizationId === this.accountId && m.role === "owner" && m.status === "active",
      )
    ) {
      throw new AutoTopUpStoreError(
        403,
        "Only the organization owner can authorize automatic top-ups.",
      );
    }
  }
  async update(subject: string, request: UpdateBillingAutoTopUpRequest): Promise<void> {
    await this.assertOwner(subject);
    const { accountId: _accountId, idempotencyKey, ...terms } = request;
    const [previous] = await rawRows<{ request: unknown; actor_subject: string }>(
      this.tx,
      sql`select request, actor_subject from billing_auto_top_up_mutations where account_id = ${this.accountId}::uuid and operation_key = ${idempotencyKey}::uuid`,
    );
    if (previous) {
      const [match] = await rawRows<{ same: boolean }>(
        this.tx,
        sql`select ${JSON.stringify(previous.request)}::jsonb = ${JSON.stringify(terms)}::jsonb as same`,
      );
      if (!match?.same || previous.actor_subject !== subject)
        throw new AutoTopUpStoreError(
          409,
          "This request key already belongs to different top-up settings.",
        );
      return;
    }
    if (terms.monthlyCapMicros < (await this.spent()))
      throw new AutoTopUpStoreError(
        422,
        "The cap cannot be lower than this month's charges and pending top-ups.",
      );
    await this.tx
      .execute(sql`insert into billing_auto_top_up_mutations(account_id, operation_key, actor_subject, request)
      values (${this.accountId}::uuid, ${idempotencyKey}::uuid, ${subject}, ${JSON.stringify(terms)}::jsonb)`);
    await this.tx
      .execute(sql`insert into billing_auto_top_up_settings(account_id, enabled, threshold_micros, amount_micros, monthly_cap_micros, consent_subject, consent_version, consent_at, revision)
      values (${this.accountId}::uuid, ${terms.enabled}, ${terms.thresholdMicros}, ${terms.amountMicros}, ${terms.monthlyCapMicros}, ${subject}, 'off_session_threshold_v1', clock_timestamp(), ${idempotencyKey}::uuid)
      on conflict (account_id) do update set enabled = excluded.enabled, threshold_micros = excluded.threshold_micros,
        amount_micros = excluded.amount_micros, monthly_cap_micros = excluded.monthly_cap_micros,
        consent_subject = excluded.consent_subject, consent_version = excluded.consent_version, consent_at = excluded.consent_at,
        revision = excluded.revision, failure_reason = null, cap_required_micros = null, updated_at = clock_timestamp()`);
  }
  async startSetup(
    subject: string,
    key: string,
    provider: AutoTopUpIntent["provider"],
    customerId: string,
  ): Promise<void> {
    await this.assertOwner(subject);
    const request = { kind: "setup", provider, customerId };
    const [previous] = await rawRows<{ same: boolean }>(
      this.tx,
      sql`select actor_subject = ${subject}
      and request = ${JSON.stringify(request)}::jsonb as same from billing_auto_top_up_mutations
      where account_id = ${this.accountId}::uuid and operation_key = ${key}::uuid`,
    );
    if (previous) {
      if (!previous.same)
        throw new AutoTopUpStoreError(
          409,
          "This request key already belongs to another billing action.",
        );
      return; // Never re-arm a consumed or superseded setup on HTTP replay.
    }
    await this.tx
      .execute(sql`insert into billing_auto_top_up_mutations(account_id, operation_key, actor_subject, request)
      values (${this.accountId}::uuid, ${key}::uuid, ${subject}, ${JSON.stringify(request)}::jsonb)`);
    const existing = await this.settings();
    if (!existing) {
      await this.tx.execute(
        sql`insert into billing_auto_top_up_settings(account_id, revision) values (${this.accountId}::uuid, ${crypto.randomUUID()}::uuid)`,
      );
    }
    await this.tx
      .execute(sql`update billing_auto_top_up_settings set setup_key = ${key}::uuid, setup_subject = ${subject},
      payment_method_id = case when provider = ${provider} and customer_id = ${customerId} then payment_method_id else null end,
      provider = ${provider}, customer_id = ${customerId}, updated_at = clock_timestamp() where account_id = ${this.accountId}::uuid`);
  }
  async finishSetup(input: {
    key: string;
    subject: string;
    provider: AutoTopUpIntent["provider"];
    customerId: string;
    methodId: string;
    brand: string;
    last4: string;
  }): Promise<boolean> {
    const settings = await this.settings();
    if (
      !settings ||
      settings.setup_key !== input.key ||
      settings.setup_subject !== input.subject ||
      settings.provider !== input.provider ||
      settings.customer_id !== input.customerId
    )
      return false;
    await this.assertOwner(input.subject);
    await this.tx
      .execute(sql`update billing_auto_top_up_settings set payment_method_id = ${input.methodId},
      payment_method_brand = ${input.brand}, payment_method_last4 = ${input.last4}, failure_reason = null,
      setup_key = null, updated_at = clock_timestamp() where account_id = ${this.accountId}::uuid`);
    return true;
  }
  async customer(provider: string): Promise<string | null> {
    return (
      (await getBillingCustomer(this.tx, this.accountId, provider))?.providerCustomerId ?? null
    );
  }
  async balance(): Promise<number> {
    const balance = await getBillingBalance(this.tx, this.accountId);
    // Monthly plan/promotional funding is not the purchased-credit wallet.
    return balance.creditsMicros ?? balance.generalBalanceMicros ?? balance.balanceMicros;
  }
  async reserve(input: {
    key: string;
    creditMicros: number;
    chargeMicros: number;
    intent: AutoTopUpIntent;
  }): Promise<AutoTopUpOperation> {
    await this.tx
      .execute(sql`insert into billing_auto_top_up_operations(account_id, operation_key, reservation_month, credit_micros, charge_micros, intent)
      values (${this.accountId}::uuid, ${input.key}::uuid, date_trunc('month', clock_timestamp() at time zone 'UTC')::date,
        ${input.creditMicros}, ${input.chargeMicros}, ${JSON.stringify(input.intent)}::jsonb)`);
    return (await this.operation(input.key))!;
  }
  async bind(key: string, paymentIntentId: string): Promise<void> {
    await this.tx
      .execute(sql`update billing_auto_top_up_operations set payment_intent_id = ${paymentIntentId}
      where account_id = ${this.accountId}::uuid and operation_key = ${key}::uuid and state = 'pending'`);
  }
  async markConfirmation(key: string): Promise<void> {
    await this.tx
      .execute(sql`update billing_auto_top_up_operations set confirmation_started_at = coalesce(confirmation_started_at, clock_timestamp())
      where account_id = ${this.accountId}::uuid and operation_key = ${key}::uuid and state = 'pending'`);
  }
  async succeeded(operation: AutoTopUpOperation, chargedAt: string): Promise<void> {
    await applyCreditLedgerEntryOnce(this.tx, {
      accountId: this.accountId,
      type: "credit_topup",
      amountMicros: operation.credit_micros,
      sourceType: "stripe_auto_top_up",
      sourceId: operation.payment_intent_id!,
      idempotencyKey: autoTopUpCreditKey(operation.operation_key),
      metadata: {
        stripePaymentIntentId: operation.payment_intent_id,
        stripeAmountTotalCents: operation.charge_micros / 10_000,
        autoTopUpOperationKey: operation.operation_key,
        stripeTaxCalculationId: operation.intent.taxCalculationId,
      },
    });
    await this.tx
      .execute(sql`update billing_auto_top_up_operations set state = 'succeeded', charged_at = ${chargedAt}::timestamptz,
      completed_at = clock_timestamp() where account_id = ${this.accountId}::uuid and operation_key = ${operation.operation_key}::uuid and state = 'pending'`);
    await this.deliver(operation.operation_key);
  }
  async failed(operation: AutoTopUpOperation, reason: string): Promise<void> {
    await this.tx
      .execute(sql`update billing_auto_top_up_operations set state = 'failed', failure_reason = ${reason}, completed_at = clock_timestamp()
      where account_id = ${this.accountId}::uuid and operation_key = ${operation.operation_key}::uuid and state = 'pending'`);
    await this.disable(reason);
    await this.deliver(operation.operation_key);
  }
  async disable(reason: string): Promise<void> {
    await this.tx.execute(
      sql`update billing_auto_top_up_settings set enabled = false, failure_reason = ${reason}, updated_at = clock_timestamp() where account_id = ${this.accountId}::uuid`,
    );
  }
  async failBeforePayment(settings: AutoTopUpSettingsRow, reason: string): Promise<void> {
    await this.disable(reason);
    if (this.notify)
      await this.notify(this.tx, {
        accountId: this.accountId,
        kind: "topup_failed",
        operationKey: `auto-top-up:settings:${this.accountId}:${settings.revision}`,
        amountMicros: settings.amount_micros,
        chargeMicros: 0,
        failureReason: reason,
      });
  }
  async deliverOutstanding(): Promise<void> {
    if (!this.notify) return;
    const rows = await rawRows<{ operation_key: string }>(
      this.tx,
      sql`select operation_key from billing_auto_top_up_operations
      where account_id = ${this.accountId}::uuid and state <> 'pending' and notification_delivered_at is null order by created_at limit 10`,
    );
    for (const row of rows) await this.deliver(row.operation_key);
  }
  async capReached(
    settings: AutoTopUpSettingsRow,
    requiredMicros = settings.cap_required_micros ?? settings.amount_micros,
  ): Promise<void> {
    await this.tx.execute(
      sql`update billing_auto_top_up_settings set cap_required_micros = ${requiredMicros} where account_id = ${this.accountId}::uuid`,
    );
    if (this.notify)
      await this.notify(this.tx, {
        accountId: this.accountId,
        kind: "cap_reached",
        operationKey: `auto-top-up:cap:${this.accountId}:${(await this.clock()).month}:${settings.revision}`,
        amountMicros: settings.amount_micros,
        chargeMicros: await this.spent(),
      });
  }
  async deliver(key: string): Promise<void> {
    const operation = await this.operation(key);
    if (
      !this.notify ||
      !operation ||
      operation.state === "pending" ||
      operation.notification_delivered_at
    )
      return;
    await this.notify(this.tx, {
      accountId: this.accountId,
      operationKey: `auto-top-up:${key}`,
      kind: operation.state === "succeeded" ? "topup_success" : "topup_failed",
      amountMicros: operation.credit_micros,
      chargeMicros: operation.charge_micros,
      ...(operation.failure_reason ? { failureReason: operation.failure_reason } : {}),
    });
    await this.tx
      .execute(sql`update billing_auto_top_up_operations set notification_delivered_at = clock_timestamp()
      where account_id = ${this.accountId}::uuid and operation_key = ${key}::uuid`);
  }
}

export function autoTopUpCreditKey(operationKey: string): string {
  return `stripe:auto-top-up:${operationKey}`;
}

export interface AutoTopUpStore {
  locked<T>(accountId: string, run: (account: AutoTopUpAccountStore) => Promise<T>): Promise<T>;
}
/** Root handle only: every call is an independent committed recovery checkpoint. */
export function billingAutoTopUpStore(
  db: Database,
  notify?: AutoTopUpNotificationPort,
): AutoTopUpStore {
  if (isTransactionHandle(db))
    throw new Error("Automatic top-up store requires a root database handle");
  return {
    locked: (accountId, run) =>
      withAccountRls(db, accountId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
        );
        return await run(new AutoTopUpAccountStore(tx, accountId, notify));
      }),
  };
}
