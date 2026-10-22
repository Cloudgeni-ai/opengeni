/**
 * SuperGrok chat turns on the shared subscription core: the bearer resolver
 * for the SuperGrok transport. Everything else the worker uses (placement,
 * request custody, health) is the provider-neutral runtime bound to
 * `SUBSCRIPTION_CORE_XAI`, which stays unregistered until the SuperGrok
 * cutover (design 5.3, X3): every entry point fails closed before then.
 *
 * The snapshot's `userId` is the connection's `provider_account_id` (the
 * token identity subject the transport sends as `x-userid`); a connection
 * without one cannot be used and needs a new sign-in, as on the legacy path.
 */
import type { Settings } from "@opengeni/config";
import { XaiSubscriptionReloginRequired } from "@opengeni/xai-subscription";
import type { Database } from "./database";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";
import { buildSubscriptionCoreTurnTokenResolver } from "./subscription-core/turn-token-resolver";
import type {
  SubscriptionCoreLeaseRef,
  SubscriptionCoreRefreshDeps,
  SubscriptionCoreTurnIdentity,
} from "./subscription-core/turns";
import {
  SUBSCRIPTION_CORE_XAI,
  type SubscriptionCoreXaiTokens,
} from "./subscription-core-xai-adapter";

/** The SuperGrok transport's token snapshot, plus the credential version it came from. */
export type SubscriptionCoreXaiTokenSnapshot = {
  accessToken: string;
  userId: string;
  /** The connection's refresh generation. */
  credentialVersion: number;
};

const MISSING_IDENTITY_TEXT =
  "The SuperGrok connection is missing a verified token identity. Reconnect the account.";

/** A SuperGrok core turn lease's TTL (the legacy SuperGrok lease's, which it replaced). */
export const XAI_CREDENTIAL_LEASE_TTL_MS = 5 * 60_000;

export function buildSubscriptionCoreXaiTokenResolver(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreLeaseRef,
  deps: SubscriptionCoreRefreshDeps & { provider?: SubscriptionCoreProvider } = {},
): {
  getToken: () => Promise<SubscriptionCoreXaiTokenSnapshot>;
  refresh: () => Promise<SubscriptionCoreXaiTokenSnapshot>;
} {
  const { provider = SUBSCRIPTION_CORE_XAI as SubscriptionCoreProvider, ...refreshDeps } = deps;
  return buildSubscriptionCoreTurnTokenResolver(
    db,
    settings,
    provider,
    identity,
    lease,
    {
      snapshot: (credential) => {
        const tokens = credential.credential as SubscriptionCoreXaiTokens;
        if (!credential.providerAccountId) {
          throw new XaiSubscriptionReloginRequired(MISSING_IDENTITY_TEXT);
        }
        return {
          accessToken: tokens.accessToken,
          userId: credential.providerAccountId,
          credentialVersion: credential.refreshGeneration,
        };
      },
      relogin: (message) => new XaiSubscriptionReloginRequired(message ?? undefined),
    },
    refreshDeps,
  );
}
