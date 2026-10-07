import { sql } from "drizzle-orm";
import type { ProviderId, SubscriptionSettingValues } from "@opengeni/subscriptions";
import { rawRows, type Database } from "./database";

export type EffectiveSubscriptionSettingsRow = {
  values: SubscriptionSettingValues;
  sources: {
    rotation: Record<string, "organization" | "workspace">;
    providers: Record<string, "organization" | "workspace">;
    fallbackOrder: Record<string, "organization" | "workspace">;
    crossProviderFailover: "organization" | "workspace";
    personalConnectionsAllowed: "organization" | "workspace";
    personalFallbackAllowed: "organization" | "workspace";
  };
};

/** Typed M2 persistence seam; no production selector calls this repository yet. */
export async function readSubscriptionEffectiveSettings(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<EffectiveSubscriptionSettingsRow> {
  const [row] = await rawRows<{ effective: EffectiveSubscriptionSettingsRow }>(
    db,
    sql`select subscription_effective_settings(${accountId}::uuid, ${workspaceId}::uuid) as effective`,
  );
  if (!row) throw new Error("Subscription settings were not found");
  return row.effective;
}

export async function createSubscriptionConnection(
  db: Database,
  input: {
    accountId: string;
    provider: ProviderId;
    kind: "subscription" | "api_key";
    credentialEncrypted: string;
    providerAccountId?: string | null;
  },
): Promise<string> {
  const [row] = await rawRows<{ id: string }>(
    db,
    sql`insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, provider_account_id
    ) values (
      ${input.accountId}::uuid, ${input.provider}, ${input.kind},
      ${input.credentialEncrypted}, ${input.providerAccountId ?? null}
    ) returning id::text as id`,
  );
  if (!row) throw new Error("Subscription connection insert returned no row");
  return row.id;
}
