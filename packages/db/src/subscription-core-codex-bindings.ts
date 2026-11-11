import type { PlacementInput } from "@opengeni/subscriptions";
import type { Database } from "./database";
import {
  subscriptionAuthorityV2ForAcceptanceInTransaction,
  subscriptionAuthorityV2ForScheduledTaskInTransaction,
} from "./subscription-core-acceptance-authority";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";
import { SUBSCRIPTION_CORE_CODEX_PROVIDER } from "./subscription-core-codex-provider";
import {
  withSubscriptionCoreProviderPlacementWorld,
  withSubscriptionCoreRefreshLock,
  type SubscriptionCorePlacementWorldRequest,
  type SubscriptionCorePlacementWorldResult,
  type SubscriptionCoreRefreshResult,
} from "./subscription-core-placement-world";
import {
  persistSubscriptionCoreRefresh,
  persistSubscriptionCoreRefreshWithPlan,
} from "./subscription-core-repository";

export type SubscriptionCoreCodexRefreshResult<T> = SubscriptionCoreRefreshResult<T>;

/** The Codex placement world of one exact accepted turn. */
export function withSubscriptionCorePlacementWorld<T>(
  db: Database,
  request: SubscriptionCorePlacementWorldRequest,
  operation: (tx: Database, input: PlacementInput) => Promise<T>,
): Promise<SubscriptionCorePlacementWorldResult<T>> {
  return withSubscriptionCoreProviderPlacementWorld(
    db,
    SUBSCRIPTION_CORE_CODEX,
    request,
    operation,
  );
}

/** The single per-connection refresh lock, for a Codex connection. */
export function withSubscriptionCoreCodexRefreshLock<T>(
  db: Database,
  request: Parameters<typeof withSubscriptionCoreRefreshLock<T>>[2],
  operation: Parameters<typeof withSubscriptionCoreRefreshLock<T>>[3],
): Promise<SubscriptionCoreRefreshResult<T>> {
  return withSubscriptionCoreRefreshLock(db, SUBSCRIPTION_CORE_CODEX, request, operation);
}

type CodexRefreshInput = Omit<Parameters<typeof persistSubscriptionCoreRefresh>[1], "provider">;

export function persistSubscriptionCodexRefresh(
  tx: Database,
  input: CodexRefreshInput,
): ReturnType<typeof persistSubscriptionCoreRefresh> {
  return persistSubscriptionCoreRefresh(tx, {
    ...input,
    provider: SUBSCRIPTION_CORE_CODEX_PROVIDER,
  });
}

export function persistSubscriptionCodexRefreshWithPlan(
  tx: Database,
  input: CodexRefreshInput & { planType: string | null },
): ReturnType<typeof persistSubscriptionCoreRefreshWithPlan> {
  return persistSubscriptionCoreRefreshWithPlan(tx, {
    ...input,
    provider: SUBSCRIPTION_CORE_CODEX_PROVIDER,
  });
}

export function codexSubscriptionAuthorityV2ForAcceptanceInTransaction(
  tx: Database,
  input: Parameters<typeof subscriptionAuthorityV2ForAcceptanceInTransaction>[2],
): ReturnType<typeof subscriptionAuthorityV2ForAcceptanceInTransaction> {
  return subscriptionAuthorityV2ForAcceptanceInTransaction(
    tx,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    input,
  );
}

export function codexSubscriptionAuthorityV2ForScheduledTaskInTransaction(
  tx: Database,
  input: Parameters<typeof subscriptionAuthorityV2ForScheduledTaskInTransaction>[2],
): ReturnType<typeof subscriptionAuthorityV2ForScheduledTaskInTransaction> {
  return subscriptionAuthorityV2ForScheduledTaskInTransaction(
    tx,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    input,
  );
}
