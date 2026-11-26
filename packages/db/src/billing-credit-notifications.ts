import {
  BillingAlertSettings,
  BillingCreditNotificationDetails,
  BillingCreditNotificationKind,
  DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
  type BillingCreditNotification,
} from "@opengeni/contracts/billing-credit-notifications";
import { sql } from "drizzle-orm";
import { rawRows, withAccountRls, type Database } from "./database";
import { getBillingBalance, generalAvailableCreditMicros } from "./credit-balances";

/** Exclude accounting movements, not only positive grants/refunds. */
const NON_SPEND_TYPES = [
  "credit_topup",
  "grant",
  "manual_credit_grant",
  "plan_credit_grant",
  "plan_credit_expiry",
  "credit_refund",
  "credit_dispute_hold",
  "credit_dispute_release",
  "video_generation_refund",
];
const HOUR_MS = 3_600_000;
const notSpend = () =>
  sql.join(
    NON_SPEND_TYPES.map((t) => sql`${t}`),
    sql`,`,
  );

/** Spend window shown with a notice: the detector's hour for unusual spend, a
 * day for balance notices. Other kinds show no breakdown. */
export const BILLING_CREDIT_SPEND_WINDOW_HOURS: Partial<
  Record<BillingCreditNotificationKind, number>
> = { unusual_spend: 1, low_balance: 24, exhausted: 24 };

export type BillingCreditSpendWorkspace = {
  /** A shared organization workspace, all members' personal workspaces, or
   * usage without a (still existing) workspace. */
  kind: "workspace" | "personal" | "other";
  workspaceId: string | null;
  name: string | null;
  spendMicros: number;
};
export type BillingCreditSpend = { windowHours: number; workspaces: BillingCreditSpendWorkspace[] };

/** Top three spend groups in the window ending at `end`. Read once per delivery,
 * when its message is first built; the frozen message keeps it on retries.
 * Recipients are organization owners and admins, who already see spend by
 * workspace in Billing and Insights. Personal workspaces are grouped without
 * names, and per-person attribution is left out: it would need session rows,
 * which row security keeps out of this organization-level context. */
export async function billingCreditSpendBreakdown(
  tx: Database,
  input: { accountId: string; end: string; windowHours: number },
): Promise<BillingCreditSpend | null> {
  const rows = await rawRows<{
    kind: BillingCreditSpendWorkspace["kind"];
    workspace_id: string | null;
    name: string | null;
    spend: string;
  }>(
    tx,
    sql`
    with spend as (
      select l.workspace_id,sum(-l.amount_micros) as micros from credit_ledger_entries l
      where l.account_id=${input.accountId}::uuid and l.amount_micros<0 and l.type not in (${notSpend()})
        and l.created_at>=${input.end}::timestamptz-${input.windowHours}*interval '1 hour'
        and l.created_at<=${input.end}::timestamptz
      group by l.workspace_id
    ), shared as (
      -- The organization's own inventory: every workspace except members' personal ones.
      select workspace_id from list_organization_workspace_ids(${input.accountId}::uuid)
    ), grouped as (
      select case when sh.workspace_id is not null then 'workspace' when w.id is not null then 'personal' else 'other' end as kind,
        sh.workspace_id,case when sh.workspace_id is not null then left(w.name,80) end as name,sum(s.micros) as micros
      from spend s left join workspaces w on w.account_id=${input.accountId}::uuid and w.id=s.workspace_id
      left join shared sh on sh.workspace_id=w.id
      group by 1,2,3
    )
    select kind,workspace_id::text,name,micros::text as spend from grouped
    order by micros desc,workspace_id nulls last limit 3`,
  );
  return rows.length
    ? {
        windowHours: input.windowHours,
        workspaces: rows.map((row) => ({
          kind: row.kind,
          workspaceId: row.workspace_id,
          name: row.name,
          spendMicros: Number(row.spend),
        })),
      }
    : null;
}

export function unusualCreditSpend(input: {
  historyHours: number;
  baselineSpendMicros: number;
  lastHourSpendMicros: number;
}): boolean {
  return (
    input.historyHours >= 24 &&
    input.lastHourSpendMicros >= 10_000_000 &&
    input.lastHourSpendMicros >= 5 * (input.baselineSpendMicros / Math.min(168, input.historyHours))
  );
}

export async function getBillingAlertSettings(
  db: Database,
  accountId: string,
): Promise<BillingAlertSettings> {
  return withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{ threshold: string }>(
      tx,
      sql`
      select low_balance_threshold_micros::text as threshold from billing_credit_alert_settings where account_id=${accountId}::uuid`,
    );
    return {
      accountId,
      lowBalanceThresholdMicros: row ? Number(row.threshold) : DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
    };
  });
}

export async function updateBillingAlertSettings(
  db: Database,
  input: BillingAlertSettings,
): Promise<BillingAlertSettings> {
  const settings = BillingAlertSettings.parse(input);
  return withAccountRls(db, settings.accountId, async (tx) => {
    // Preserve crossing state; the next sample applies the newly configured threshold.
    await tx.execute(sql`insert into billing_credit_alert_settings(account_id,low_balance_threshold_micros)
      values (${settings.accountId}::uuid,${settings.lowBalanceThresholdMicros})
      on conflict(account_id) do update set low_balance_threshold_micros=excluded.low_balance_threshold_micros,updated_at=clock_timestamp()`);
    return settings;
  });
}

export type EnqueueBillingCreditNotificationInput = {
  accountId: string;
  /** Stable, caller-owned key, e.g. topup:<operation UUID>:failed. Never a timestamp on retry. */
  operationKey: string;
  kind: BillingCreditNotificationKind;
  details: BillingCreditNotificationDetails;
};

/** May use a caller's transaction: receipt, recipients and charge result can commit together. */
export async function enqueueBillingCreditNotification(
  db: Database,
  input: EnqueueBillingCreditNotificationInput,
): Promise<string> {
  const kind = BillingCreditNotificationKind.parse(input.kind);
  const details = BillingCreditNotificationDetails.parse(input.details);
  if (!input.operationKey || Buffer.byteLength(input.operationKey) > 512)
    throw new Error("billing notification operation key must contain 1..512 bytes");
  return withAccountRls(db, input.accountId, async (tx) => {
    const inserted = await rawRows<{ id: string }>(
      tx,
      sql`insert into billing_credit_notifications(account_id,operation_key,kind,details)
      values (${input.accountId}::uuid,${input.operationKey},${kind},${JSON.stringify(details)}::jsonb)
      on conflict(account_id,operation_key) do nothing returning id`,
    );
    const [receipt] = await rawRows<{ id: string; matches: boolean }>(
      tx,
      sql`
      select id,kind=${kind} and details=${JSON.stringify(details)}::jsonb as matches
      from billing_credit_notifications where account_id=${input.accountId}::uuid and operation_key=${input.operationKey}`,
    );
    if (!receipt?.matches)
      throw new Error("billing notification operation key already has different details");
    if (!inserted.length) return receipt.id;
    // Replay never adds newly promoted recipients to an old event.
    // Creation time equality is not used: the receipt row lock serializes all fanout.
    await tx.execute(
      sql`select id from billing_credit_notifications where id=${receipt.id}::uuid for update`,
    );
    await tx.execute(sql`insert into billing_credit_notification_deliveries(account_id,notification_id,subject_id,email)
      select r.account_id,${receipt.id}::uuid,r.subject_id,
        case when u.email_verified and lower(u.email) not like '%@passkey.invalid' then u.email end
      from billing_credit_notification_recipients r join auth_users u on r.subject_id='user:' || u.id
      where r.account_id=${input.accountId}::uuid
        and not exists(select 1 from billing_credit_notification_deliveries where notification_id=${receipt.id}::uuid)
      on conflict(notification_id,subject_id) do nothing`);
    return receipt.id;
  });
}

/** Bounded ID-only discovery from the existing runtime-readable organization
 * registry, also covering a first failed top-up with no ledger entry yet. */
export async function listBillingCreditAlertAccounts(
  db: Database,
  afterAccountId: string | null = null,
  limit = 50,
): Promise<string[]> {
  const rows = await rawRows<{ account_id: string }>(
    db,
    sql`
    select id as account_id from managed_accounts
    where (${afterAccountId}::uuid is null or id>${afterAccountId}::uuid)
    order by id limit ${Math.max(1, Math.min(100, limit))}`,
  );
  return rows.map((row) => row.account_id);
}

/** Sample once per minute, serializing canonical balance and the crossing receipt. */
export async function evaluateBillingCreditAlerts(
  db: Database,
  accountId: string,
): Promise<string[]> {
  return withAccountRls(db, accountId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`},0))`,
    );
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${accountId}))`);
    await tx.execute(
      sql`insert into billing_credit_alert_settings(account_id) values (${accountId}::uuid) on conflict do nothing`,
    );
    const [state] = await rawRows<{
      low_balance_threshold_micros: string;
      low_active: boolean;
      exhausted_active: boolean;
      unusual_active: boolean;
      last_unusual_at: string | null;
      now: string;
      due: boolean;
    }>(
      tx,
      sql`select *,clock_timestamp()::text as now,
      checked_at is null or checked_at <= clock_timestamp()-interval '1 minute' as due
      from billing_credit_alert_settings where account_id=${accountId}::uuid for update`,
    );
    if (!state?.due) return [];
    const [usage] = await rawRows<{
      funded: boolean;
      first_at: string | null;
      baseline: string;
      recent: string;
    }>(
      tx,
      sql`
      select coalesce(bool_or(amount_micros>0 and eligible_model_ids is null
        and type in ('credit_topup','grant','manual_credit_grant','plan_credit_grant')),false) as funded,
        min(created_at)::text as first_at,
        coalesce(sum(-amount_micros) filter(where amount_micros<0 and type not in (${notSpend()})
          and created_at>=${state.now}::timestamptz-interval '169 hours' and created_at<${state.now}::timestamptz-interval '1 hour'),0)::text as baseline,
        coalesce(sum(-amount_micros) filter(where amount_micros<0 and type not in (${notSpend()})
          and created_at>=${state.now}::timestamptz-interval '1 hour' and created_at<=${state.now}::timestamptz),0)::text as recent
      from credit_ledger_entries where account_id=${accountId}::uuid`,
    );
    // No usage selector: canonical app-general availability excludes all scoped
    // promotional funding, held legacy grants, pending expiry and applicable debt.
    const availableBalanceMicros = generalAvailableCreditMicros(
      await getBillingBalance(tx, accountId),
    );
    const threshold = Number(state.low_balance_threshold_micros);
    const low = Boolean(usage?.funded) && availableBalanceMicros <= threshold;
    const exhausted = Boolean(usage?.funded) && availableBalanceMicros === 0;
    const historyHours = usage?.first_at
      ? Math.max(0, (Date.parse(state.now) - Date.parse(usage.first_at)) / HOUR_MS - 1)
      : 0;
    const recent = Number(usage?.recent ?? 0);
    const baseline = Number(usage?.baseline ?? 0);
    const unusual = unusualCreditSpend({
      historyHours,
      baselineSpendMicros: baseline,
      lastHourSpendMicros: recent,
    });
    const ids: string[] = [];
    const enqueue = async (
      kind: BillingCreditNotificationKind,
      details: BillingCreditNotificationDetails,
    ) => {
      ids.push(
        await enqueueBillingCreditNotification(tx, {
          accountId,
          operationKey: `crossing:${crypto.randomUUID()}`,
          kind,
          details,
        }),
      );
    };
    // A jump directly to zero sends only the more useful exhausted notice.
    if (exhausted && !state.exhausted_active)
      await enqueue("exhausted", { availableBalanceMicros, lowBalanceThresholdMicros: threshold });
    else if (low && !state.low_active && !exhausted)
      await enqueue("low_balance", {
        availableBalanceMicros,
        lowBalanceThresholdMicros: threshold,
      });
    const unusualSent =
      unusual &&
      !state.unusual_active &&
      (!state.last_unusual_at ||
        Date.parse(state.now) - Date.parse(state.last_unusual_at) >= 24 * HOUR_MS);
    if (unusualSent)
      await enqueue("unusual_spend", {
        availableBalanceMicros,
        lastHourSpendMicros: recent,
        baselineHourlySpendMicros: baseline / Math.min(168, historyHours),
      });
    await tx.execute(sql`update billing_credit_alert_settings set low_active=${low},exhausted_active=${exhausted},
      unusual_active=${unusual && (state.unusual_active || unusualSent)},
      last_unusual_at=case when ${unusualSent} then ${state.now}::timestamptz else last_unusual_at end,
      checked_at=${state.now}::timestamptz where account_id=${accountId}::uuid`);
    return ids;
  });
}

export async function listBillingCreditNotifications(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<BillingCreditNotification[]> {
  return withAccountRls(db, input.accountId, async (tx) => {
    const rows = await rawRows<{
      id: string;
      kind: BillingCreditNotificationKind;
      details: BillingCreditNotificationDetails;
      created_at: string;
      read: boolean;
      personal_workspace_id: string | null;
    }>(
      tx,
      sql`
      select n.id,n.kind,n.details,n.created_at::text,d.read_at is not null as read,r.personal_workspace_id
      from billing_credit_notifications n join billing_credit_notification_deliveries d on d.notification_id=n.id
      join billing_credit_notification_recipients r on r.account_id=d.account_id and r.subject_id=d.subject_id
      where n.account_id=${input.accountId}::uuid and d.subject_id=${input.subjectId}
      order by n.created_at desc,n.id desc limit 100`,
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: input.accountId,
      kind: row.kind,
      eventType: `billing.credits.${row.kind}`,
      details: row.details,
      createdAt: new Date(row.created_at).toISOString(),
      read: row.read,
      action: { label: "Manage billing", path: billingCreditActionPath(row.personal_workspace_id) },
    }));
  });
}

export async function markBillingCreditNotificationRead(
  db: Database,
  input: { accountId: string; subjectId: string; notificationId: string },
): Promise<void> {
  await withAccountRls(db, input.accountId, async (tx) => {
    await tx.execute(sql`update billing_credit_notification_deliveries d set read_at=coalesce(read_at,clock_timestamp())
      where d.account_id=${input.accountId}::uuid and d.subject_id=${input.subjectId} and d.notification_id=${input.notificationId}::uuid
      and exists(select 1 from billing_credit_notification_recipients r where r.account_id=d.account_id and r.subject_id=d.subject_id)`);
  });
}

export type BillingCreditEmailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};
export function billingCreditActionPath(personalWorkspaceId: string | null): string {
  return personalWorkspaceId
    ? `/workspaces/${encodeURIComponent(personalWorkspaceId)}/organization?section=billing`
    : "/billing";
}
/** The organization billing page opened on one workspace's budget and usage,
 * when the recipient has a workspace to anchor the organization page. */
export function billingCreditWorkspacePath(
  personalWorkspaceId: string | null,
  workspaceId: string,
): string | null {
  return personalWorkspaceId
    ? `${billingCreditActionPath(personalWorkspaceId)}&workspace=${encodeURIComponent(workspaceId)}`
    : null;
}
export type BillingCreditMessageContext = {
  /** Display name of the organization, null when unavailable. */
  organizationName: string | null;
  workspacePath: (workspaceId: string) => string | null;
  /** Where the notice's window spend went, for kinds that show it. */
  spend: BillingCreditSpend | null;
};
export type BillingCreditDeliveryClaim = {
  id: string;
  accountId: string;
  claimId: string;
  subjectId: string;
  email: string;
  message: BillingCreditEmailMessage;
};

/** Claims commit before I/O. Stable key + immutable payload + provider scope and
 * retention deadline make crash recovery safe; expired ambiguity is never resent. */
export async function claimBillingCreditNotification(
  db: Database,
  input: {
    accountId: string;
    sender: string;
    providerScope: string;
    retentionSeconds: number;
    message: (
      kind: BillingCreditNotificationKind,
      details: BillingCreditNotificationDetails,
      email: string,
      actionPath: string,
      context: BillingCreditMessageContext,
    ) => BillingCreditEmailMessage;
  },
): Promise<BillingCreditDeliveryClaim | null> {
  return withAccountRls(db, input.accountId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${input.accountId}`},0))`,
    );
    const [row] = await rawRows<{
      id: string;
      subject_id: string;
      email: string | null;
      kind: BillingCreditNotificationKind;
      details: BillingCreditNotificationDetails;
      message: BillingCreditEmailMessage | null;
      provider_scope: string | null;
      live_email: string | null;
      personal_workspace_id: string | null;
      organization_name: string | null;
      notification_created_at: string;
    }>(
      tx,
      sql`
      select d.*,n.kind,n.details,r.personal_workspace_id,case when u.email_verified and lower(u.email) not like '%@passkey.invalid' then u.email end as live_email,
        (select a.name from managed_accounts a where a.id=d.account_id) as organization_name,
        n.created_at::text as notification_created_at
      from billing_credit_notification_deliveries d join billing_credit_notifications n on n.id=d.notification_id
      left join billing_credit_notification_recipients r on r.account_id=d.account_id and r.subject_id=d.subject_id
      left join auth_users u on r.subject_id='user:' || u.id
      where d.account_id=${input.accountId}::uuid and d.status in ('pending','failed','sending','outcome_unknown')
        and d.next_attempt_at<=clock_timestamp() and (d.lease_until is null or d.lease_until<=clock_timestamp())
        and (d.first_attempt_at is null or d.retry_before>clock_timestamp()+interval '30 seconds')
      order by d.next_attempt_at,d.id limit 1 for update of d skip locked`,
    );
    if (!row) return null;
    if (
      !row.live_email ||
      (row.message &&
        (row.live_email !== row.email ||
          row.provider_scope !== input.providerScope ||
          row.message.from !== input.sender))
    ) {
      await tx.execute(
        sql`update billing_credit_notification_deliveries set status='suppressed',error_class='recipient_or_transport_changed' where id=${row.id}::uuid`,
      );
      return null;
    }
    let message = row.message;
    if (!message) {
      const windowHours = BILLING_CREDIT_SPEND_WINDOW_HOURS[row.kind];
      message = input.message(
        row.kind,
        row.details,
        row.live_email,
        billingCreditActionPath(row.personal_workspace_id),
        {
          organizationName: row.organization_name,
          workspacePath: (workspaceId) =>
            billingCreditWorkspacePath(row.personal_workspace_id, workspaceId),
          spend: windowHours
            ? await billingCreditSpendBreakdown(tx, {
                accountId: input.accountId,
                end: row.notification_created_at,
                windowHours,
              })
            : null,
        },
      );
    }
    const claimId = crypto.randomUUID();
    await tx.execute(sql`update billing_credit_notification_deliveries set status='sending',claim_id=${claimId}::uuid,
      lease_until=clock_timestamp()+interval '1 minute',email=${row.live_email},message=${JSON.stringify(message)}::jsonb,
      provider_scope=coalesce(provider_scope,${input.providerScope}),
      retry_before=coalesce(retry_before,clock_timestamp()+${Math.max(0, Math.min(86400, input.retentionSeconds))}*interval '1 second'),
      first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),attempt_count=attempt_count+1 where id=${row.id}::uuid`);
    return {
      id: row.id,
      accountId: input.accountId,
      claimId,
      subjectId: row.subject_id,
      email: row.live_email,
      message,
    };
  });
}

/** Hold the canonical membership fence through dispatch admission and bounded
 * waiting. A revocation committed before this fence prevents I/O; an admitted
 * transport may still finish after the caller stops waiting. */
export async function withBillingCreditDeliveryAuthority<T>(
  db: Database,
  claim: BillingCreditDeliveryClaim,
  send: () => Promise<T>,
): Promise<T | null> {
  return withAccountRls(db, claim.accountId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${claim.accountId}`},0))`,
    );
    const [valid] = await rawRows<{ id: string; retry_allowed: boolean }>(
      tx,
      sql`select d.id,(d.attempt_count=1 or d.retry_before>clock_timestamp()+interval '30 seconds') as retry_allowed
      from billing_credit_notification_deliveries d
      join billing_credit_notification_recipients r on r.account_id=d.account_id and r.subject_id=d.subject_id
      join auth_users u on r.subject_id='user:' || u.id
      where d.id=${claim.id}::uuid and d.claim_id=${claim.claimId}::uuid and d.status='sending'
        and d.lease_until>clock_timestamp() and u.email=${claim.email} and u.email_verified`,
    );
    if (!valid) return null;
    if (!valid.retry_allowed) {
      // A claimed retry may wait behind a membership operation or a busy pool.
      // Preserve ambiguity rather than sending after the provider forgets its
      // key. The caller's later settlement cannot replace this terminal fence.
      await tx.execute(sql`update billing_credit_notification_deliveries set status='outcome_unknown',
        lease_until=null,error_class='idempotency_window_expired'
        where id=${claim.id}::uuid and claim_id=${claim.claimId}::uuid and status='sending'`);
      return null;
    }
    return send();
  });
}

export async function settleBillingCreditNotification(
  db: Database,
  claim: BillingCreditDeliveryClaim,
  result: {
    status: "sent" | "failed" | "outcome_unknown" | "suppressed";
    providerMessageId?: string | null;
    errorClass?: string;
  },
): Promise<void> {
  await withAccountRls(db, claim.accountId, async (tx) => {
    await tx.execute(sql`update billing_credit_notification_deliveries set status=${result.status},lease_until=null,
      next_attempt_at=clock_timestamp()+interval '5 minutes',provider_message_id=${result.providerMessageId ?? null},error_class=${result.errorClass ?? null}
      where account_id=${claim.accountId}::uuid and id=${claim.id}::uuid and claim_id=${claim.claimId}::uuid and status='sending'`);
  });
}
