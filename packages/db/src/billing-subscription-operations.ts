import { sql } from "drizzle-orm";
import { isTransactionHandle, rawRows, withAccountRls, type Database } from "./database";

export type BillingSubscriptionOperationKind = "upgrade" | "change" | "cancel";
export type BillingSubscriptionOperation = {
  account_id: string;
  operation_key: string;
  kind: BillingSubscriptionOperationKind;
  request: Record<string, unknown>;
  intent: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
};

/** Intent must commit before provider I/O; a caller-owned transaction/savepoint
 * cannot supply that guarantee. The API runs two independent org-fenced phases. */
export function assertBillingSubscriptionOperationRoot(db: Database): void {
  if (isTransactionHandle(db))
    throw new Error("Subscription operation store requires a root database handle");
}

export async function getBillingSubscriptionOperation(
  db: Database,
  accountId: string,
  operationKey: string,
) {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{ receipt: BillingSubscriptionOperation }>(
      tx,
      sql`select to_jsonb(receipt) as receipt from billing_subscription_operations receipt
        where account_id = ${accountId}::uuid and operation_key = ${operationKey}::uuid`,
    );
    return row?.receipt ?? null;
  });
}

export async function beginBillingSubscriptionOperation(
  db: Database,
  input: {
    accountId: string;
    operationKey: string;
    kind: BillingSubscriptionOperationKind;
    request: Record<string, unknown>;
    intent: Record<string, unknown>;
  },
) {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<{ receipt: BillingSubscriptionOperation }>(
      tx,
      sql`select begin_billing_subscription_operation(${input.accountId}::uuid, ${input.operationKey}::uuid,
        ${input.kind}, ${JSON.stringify(input.request)}::jsonb, ${JSON.stringify(input.intent)}::jsonb) as receipt`,
    );
    return row!.receipt;
  });
}

export async function completeBillingSubscriptionOperation(
  db: Database,
  input: {
    accountId: string;
    operationKey: string;
    result: Record<string, unknown>;
  },
) {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<{ receipt: BillingSubscriptionOperation }>(
      tx,
      sql`select complete_billing_subscription_operation(${input.accountId}::uuid, ${input.operationKey}::uuid,
        ${JSON.stringify(input.result)}::jsonb) as receipt`,
    );
    return row!.receipt;
  });
}
