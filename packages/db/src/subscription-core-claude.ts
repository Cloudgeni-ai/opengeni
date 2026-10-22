/**
 * Claude chat turns on the shared subscription core: the bearer resolver
 * for the Anthropic transport. Everything else the worker uses (placement,
 * request custody, health) is the provider-neutral runtime bound to
 * `SUBSCRIPTION_CORE_CLAUDE`, which stays unregistered until the Claude
 * cutover (design 5.3, C3): every entry point fails closed before then.
 *
 * The snapshot carries the whole decoded credential (the transport needs
 * the bearer and the account identity it sends with each request) and the
 * refresh generation it came from, which fences every quota observation
 * and refusal made with it.
 */
import type { Settings } from "@opengeni/config";
import { ClaudeSubscriptionReconnectRequired } from "./subscription-core-claude-oauth";
import type { Database } from "./database";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";
import { buildSubscriptionCoreTurnTokenResolver } from "./subscription-core/turn-token-resolver";
import type {
  SubscriptionCoreLeaseRef,
  SubscriptionCoreRefreshDeps,
  SubscriptionCoreTurnIdentity,
} from "./subscription-core/turns";
import {
  SUBSCRIPTION_CORE_CLAUDE,
  type SubscriptionCoreClaudeCredential,
} from "./subscription-core-claude-adapter";

/**
 * A Claude turn's core lease TTL: the five minutes the legacy Claude lease
 * used (C1a kept it; owned here since the legacy pool's deletion, C4).
 */
export const SUBSCRIPTION_CORE_CLAUDE_LEASE_TTL_MS = 5 * 60_000;

/** The Anthropic transport's credential snapshot, plus the credential version it came from. */
export type SubscriptionCoreClaudeTokenSnapshot = {
  credential: SubscriptionCoreClaudeCredential;
  /** The connection's refresh generation. */
  credentialVersion: number;
};

export function buildSubscriptionCoreClaudeTokenResolver(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreLeaseRef,
  deps: SubscriptionCoreRefreshDeps & { provider?: SubscriptionCoreProvider } = {},
): {
  getToken: () => Promise<SubscriptionCoreClaudeTokenSnapshot>;
  refresh: () => Promise<SubscriptionCoreClaudeTokenSnapshot>;
} {
  const { provider = SUBSCRIPTION_CORE_CLAUDE as SubscriptionCoreProvider, ...refreshDeps } = deps;
  return buildSubscriptionCoreTurnTokenResolver(
    db,
    settings,
    provider,
    identity,
    lease,
    {
      snapshot: (credential) => ({
        credential: credential.credential as SubscriptionCoreClaudeCredential,
        credentialVersion: credential.refreshGeneration,
      }),
      // Claude has one fixed sign-in text (the stored status reason is not echoed).
      relogin: () => new ClaudeSubscriptionReconnectRequired(),
    },
    refreshDeps,
  );
}
