import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import Stripe from "stripe";

export function stripeProviderForSecretKey(
  secret: string | undefined,
): "stripe:live" | "stripe:test" {
  return secret?.startsWith("sk_live_") || secret?.startsWith("rk_live_")
    ? "stripe:live"
    : "stripe:test";
}

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

export class StripeCustomerDeletionBlocked extends Error {
  constructor(
    readonly reason: string,
    readonly terminal = false,
  ) {
    super(reason);
  }
}

export async function deleteClosedOrganizationStripeCustomers(
  settings: Pick<Settings, "stripeSecretKey" | "stripeAccountDeletionOtherModeSecretKey">,
  organizationId: string,
  mappings: readonly { provider: "stripe" | "stripe:live" | "stripe:test"; id: string }[],
  prior: Record<string, true>,
  record: (key: string) => Promise<null>,
) {
  const clients = new Map<ReturnType<typeof stripeProviderForSecretKey>, Stripe>();
  for (const key of [settings.stripeSecretKey, settings.stripeAccountDeletionOtherModeSecretKey]) {
    if (!key) continue;
    const mode = stripeProviderForSecretKey(key);
    if (clients.has(mode))
      throw new StripeCustomerDeletionBlocked("stripe_keys_do_not_cover_both_modes", true);
    clients.set(mode, new Stripe(key, { timeout: 10_000, maxNetworkRetries: 1 }));
  }
  for (const mapping of mappings) {
    if (mapping.provider !== "stripe" && !clients.has(mapping.provider)) {
      throw new StripeCustomerDeletionBlocked("stripe_mode_credentials_missing", true);
    }
  }
  if (!clients.size && mappings.length)
    throw new StripeCustomerDeletionBlocked("stripe_credentials_missing", true);
  const missing = (error: unknown) =>
    error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing";
  const rejectProviderError = (error: unknown): never => {
    if (
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError
    ) {
      throw new StripeCustomerDeletionBlocked("stripe_credentials_rejected", true);
    }
    throw error;
  };
  async function alreadyDeleted(client: Stripe, customerId: string) {
    try {
      return (await client.customers.retrieve(customerId)).deleted === true;
    } catch (error) {
      if (missing(error)) return false;
      rejectProviderError(error);
    }
  }
  async function remove(client: Stripe, customerId: string) {
    try {
      await client.customers.del(customerId);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      rejectProviderError(error);
    }
  }
  for (const mapping of mappings) {
    if (mapping.provider !== "stripe") {
      await remove(clients.get(mapping.provider)!, mapping.id);
    } else {
      // An unqualified historical mapping may belong to the other mode.
      const milestone = `stripe_legacy:${organizationId}:${createHash("sha256").update(mapping.id).digest("hex")}`;
      if (prior[milestone]) continue;
      let found = false;
      for (const client of clients.values()) {
        if ((await remove(client, mapping.id)) || (await alreadyDeleted(client, mapping.id)))
          found = true;
      }
      if (!found && clients.size < 2) {
        throw new StripeCustomerDeletionBlocked("stripe_legacy_customer_mode_unverified", true);
      }
      await record(milestone);
    }
  }
  // Always search as well: creation can have succeeded before a failed DB save.
  for (const client of clients.values()) {
    const page = await client.customers
      .search({ query: `metadata['opengeni_account_id']:'${organizationId}'`, limit: 5 })
      .catch(rejectProviderError);
    await Promise.all(page.data.map((customer) => remove(client, customer.id)));
    // Deleting the first page each time bounds activity work. If Stripe never
    // advances its search index, this becomes a visible, retryable block.
    if (page.has_more) throw new StripeCustomerDeletionBlocked("stripe_search_index_pending");
  }
}
