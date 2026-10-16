import type Stripe from "stripe";

export interface StripeCustomerTransaction {
  read(): Promise<string | null>;
  account(): Promise<{ name: string } | null>;
  save(customer: Stripe.Customer): Promise<void>;
}

/** The adapter must hold the account advisory lock for this whole callback,
 * including provider I/O and persistence. The stable provider key also recovers
 * creation when Stripe succeeds but the database transaction rolls back. */
export async function serializedStripeCustomer(input: {
  stripe: Stripe;
  accountId: string;
  provider: string;
  email?: string;
  locked: (run: (tx: StripeCustomerTransaction) => Promise<string>) => Promise<string>;
}): Promise<string> {
  return await input.locked(async (tx) => {
    const existing = await tx.read();
    if (existing) return existing;
    const account = await tx.account();
    if (!account) throw new Error("account not found");
    const created = await input.stripe.customers.create(
      {
        metadata: { opengeni_account_id: input.accountId },
      },
      { idempotencyKey: `billing-customer:${input.provider}:${input.accountId}` },
    );
    // Creation parameters must stay identical even if a different administrator
    // retries after a rollback, or the organization is renamed in between.
    // Profile updates are idempotent sets and do not create another customer.
    const customer = await input.stripe.customers.update(created.id, {
      name: account.name,
      ...(input.email ? { email: input.email } : {}),
    });
    await tx.save(customer);
    return customer.id;
  });
}
