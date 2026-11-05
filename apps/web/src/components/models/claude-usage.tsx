import type { ClaudeSubscriptionUsage, ClaudeUsageWindow } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useId, useRef } from "react";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { RelativeTime, useMinuteNow } from "@opengeni/react/ui/relative-time";
import { UsageMeterGroup, type UsageWindowReading } from "@opengeni/react/ui/usage-meter";
import {
  SubscriptionUsageCell,
  subscriptionUsageReadings,
} from "@opengeni/react/app/components/models/subscription-usage";
import {
  subscriptionListWindows,
  subscriptionPlanWindows,
  subscriptionWindows,
  type SubscriptionWindow,
  type SubscriptionWindowInput,
} from "@opengeni/react/app/lib/subscription-accounts";
import {
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
  type SharedQueryKey,
} from "@opengeni/react/app/lib/shared-query";

export type ClaudeUsageState = {
  value: ClaudeSubscriptionUsage | null;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  canRefresh: boolean;
  refresh(): Promise<void>;
};

// The last successful reading per exact scope + reading kind + credential +
// version, retained per client so a revisit within five minutes needs no read.
// Only a reading whose credential id and version are both known is
// retained: without them (people who can't manage the connection) a replaced
// credential could not be told apart, so those readers always start cold.
function claudeUsageQueryKey(input: {
  scope: "workspace" | "organization";
  scopeId: string;
  accountPool: boolean;
  credentialId?: string | null | undefined;
  credentialVersion?: number | null | undefined;
  canManage: boolean;
}): SharedQueryKey | null {
  if (!input.credentialId || input.credentialVersion === undefined) return null;
  if (input.credentialVersion === null) return null;
  return [
    "model-settings",
    "claude-usage",
    input.scope,
    input.scopeId,
    input.accountPool ? "pool-account" : "connection",
    input.credentialId,
    input.credentialVersion,
    input.canManage ? "live" : "stored",
  ];
}
export function useClaudeUsage({
  client,
  scope,
  scopeId,
  enabled,
  connected,
  credentialId,
  credentialVersion,
  canManage,
  onCredentialChanged,
  accountPool = false,
}: {
  client: OpenGeniBrowserClient;
  scope: "workspace" | "organization";
  scopeId: string;
  enabled: boolean;
  connected: boolean;
  credentialId?: string | null;
  credentialVersion?: number | null;
  canManage: boolean;
  accountPool?: boolean;
  onCredentialChanged?: () => Promise<unknown>;
}): ClaudeUsageState {
  const readerId = useId();
  const retainedKey = claudeUsageQueryKey({
    scope,
    scopeId,
    accountPool,
    credentialId,
    credentialVersion,
    canManage,
  });
  // Unknown credentials still use the shared read machinery, but never reuse
  // another mount's reading: a replacement cannot be identified reliably.
  const queryKey = retainedKey ?? [
    "model-settings",
    "claude-usage",
    scope,
    scopeId,
    accountPool ? "pool-account" : "connection",
    credentialId ?? null,
    credentialVersion ?? null,
    canManage ? "live" : "stored",
    "reader",
    readerId,
  ];
  const key = JSON.stringify(queryKey);
  const readable = enabled && connected;
  const epochRef = useRef({ client, key, readable, active: true });
  if (
    epochRef.current.client !== client ||
    epochRef.current.key !== key ||
    epochRef.current.readable !== readable
  ) {
    epochRef.current.active = false;
    epochRef.current = { client, key, readable, active: true };
  }
  const epoch = epochRef.current;
  const credentialChanged = useRef(onCredentialChanged);
  credentialChanged.current = onCredentialChanged;
  const load = useCallback(
    async (refresh: boolean) =>
      accountPool && credentialId
        ? scope === "workspace"
          ? await (refresh
              ? client.refreshClaudeSubscriptionAccountUsage(scopeId, credentialId)
              : client.getClaudeSubscriptionAccountUsage(scopeId, credentialId))
          : await (refresh
              ? client.refreshOrganizationClaudeSubscriptionAccountUsage(scopeId, credentialId)
              : client.getOrganizationClaudeSubscriptionAccountUsage(scopeId, credentialId))
        : scope === "workspace"
          ? await (refresh
              ? client.refreshWorkspaceClaudeSubscriptionUsage(scopeId)
              : client.getWorkspaceClaudeSubscriptionUsage(scopeId))
          : await (refresh
              ? client.refreshOrganizationClaudeSubscriptionUsage(scopeId)
              : client.getOrganizationClaudeSubscriptionUsage(scopeId)),
    [client, scope, scopeId, credentialId, accountPool],
  );
  // GET only projects saved quota. Manageable accounts use the live POST for
  // cold/stale reads and invalidation (including the global Models Refresh).
  // All paths share the cache's in-flight and generation fencing; a fresh
  // remount does not contact Claude again. Read-only viewers keep using GET.
  const query = useSharedQuery(client, queryKey, () => load(canManage), {
    enabled: readable,
    staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS,
    pollIntervalMs: MODEL_SETTINGS_STALE_TIME_MS,
    ...(retainedKey ? {} : { retainMs: 0 }),
  });
  useEffect(() => {
    epoch.active = true;
    return () => {
      epoch.active = false;
    };
  }, [epoch]);
  const mismatch = Boolean(
    query.data &&
    (!query.data.connected ||
      (credentialVersion != null && query.data.credentialVersion !== credentialVersion)),
  );
  const needsMetadata = mismatch || query.data?.refreshStatus === "reconnect";
  useEffect(() => {
    if (epoch.active && needsMetadata) void credentialChanged.current?.();
  }, [epoch, needsMetadata]);
  const { refresh: refreshQuery } = query;
  const refresh = useCallback(async () => {
    if (!epoch.active || !readable || !canManage) return;
    await refreshQuery();
  }, [epoch, readable, canManage, refreshQuery]);
  return {
    value: mismatch ? null : query.data,
    error: Boolean(query.error || mismatch),
    loading: query.loading,
    refreshing: query.fetching && !query.loading,
    canRefresh: canManage && readable,
    refresh,
  };
}

/**
 * The windows Claude reported for this account, labelled the shared way.
 * Only reported windows the plan has: Ultra has no 5-hour limit, so it shows
 * none even when a reading still carries one.
 */
export function claudeUsageWindows(
  value: ClaudeSubscriptionUsage | null,
  now: number,
  plan?: string | null,
): SubscriptionWindow[] {
  return subscriptionPlanWindows(
    "claude",
    plan,
    subscriptionWindows("claude", claudeWindowInputs(value?.windows ?? []), now),
  );
}

/** An account row's windows: the week, and the 5h only while it holds the account back. */
export function claudeUsageListWindows(
  value: ClaudeSubscriptionUsage | null,
  now: number,
  plan?: string | null,
): SubscriptionWindow[] {
  return subscriptionListWindows(
    "claude",
    plan,
    subscriptionWindows("claude", claudeWindowInputs(value?.windows ?? []), now),
  );
}

/** Claude's per-window statuses in the shared shape. */
export function claudeWindowInputs(
  windows: readonly ClaudeUsageWindow[],
): SubscriptionWindowInput[] {
  return windows.map((window) => ({
    id: window.id,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    status:
      window.status === "rejected"
        ? "exhausted"
        : window.status === "allowed_warning"
          ? "warning"
          : null,
  }));
}

export function claudeUsageReadings(
  value: ClaudeSubscriptionUsage | null,
  now: number,
  plan?: string | null,
): UsageWindowReading[] {
  return subscriptionUsageReadings(claudeUsageWindows(value, now, plan), now);
}

/** Omitted windows retain their own observation time, not the latest response's. */
export function claudeUsageReportedAt(
  value: ClaudeSubscriptionUsage | null,
  now: number,
): string | null {
  const displayed =
    value?.windows.filter((window) => !window.resetsAt || Date.parse(window.resetsAt) > now) ?? [];
  return (
    displayed.reduce<string | null>(
      (oldest, window) => (!oldest || window.observedAt < oldest ? window.observedAt : oldest),
      null,
    ) ??
    value?.observedAt ??
    null
  );
}

/** The usage cell of an account row; `plan` hides windows the plan doesn't have. */
export function ClaudeUsageReadout({
  state,
  plan,
}: {
  state: ClaudeUsageState;
  plan?: string | null | undefined;
}) {
  const now = useMinuteNow();
  const unavailable =
    state.error ||
    state.value?.refreshStatus === "unavailable" ||
    state.value?.refreshStatus === "reconnect";
  // A failed live check is not evidence of no usage (or a fresh old reading).
  return (
    <SubscriptionUsageCell
      windows={claudeUsageListWindows(unavailable ? null : state.value, now, plan)}
      loading={state.loading}
      fallback={
        unavailable || state.value?.refreshStatus === "scope_required"
          ? "Usage unavailable"
          : "No usage yet"
      }
    />
  );
}

export function ClaudeUsage({
  state,
  plan,
  onReconnect,
}: {
  state: ClaudeUsageState;
  /** The account's plan: a window it doesn't have (Ultra's 5h) is not shown. */
  plan?: string | null | undefined;
  onReconnect?: (() => void) | undefined;
}) {
  const now = useMinuteNow();
  const value = state.value;
  const readings = claudeUsageReadings(value, now, plan);
  const reportedAt = claudeUsageReportedAt(value, now);
  const stale = Boolean(reportedAt && now - Date.parse(reportedAt) > 5 * 60_000);
  const disabled =
    value?.refreshStatus === "scope_required"
      ? "This setup token cannot check current usage. Sign in again to enable usage checks."
      : value?.refreshStatus === "reconnect"
        ? "Replace the token to reconnect Claude."
        : undefined;
  const error =
    state.error || value?.refreshStatus === "unavailable"
      ? value?.windows.length
        ? "Couldn't check usage. Last reported readings are shown."
        : "Couldn't check usage. Try again."
      : value?.refreshStatus === "reconnect"
        ? "Claude no longer accepts this token. Replace it to reconnect."
        : undefined;
  return (
    <DetailSection
      title="Usage"
      description="Limits apply to the connected Claude plan, including usage outside Opengeni."
    >
      <UsageMeterGroup
        windows={readings}
        loading={state.loading}
        refreshing={state.refreshing}
        checked={
          reportedAt ? (
            <span>
              <RelativeTime date={reportedAt} prefix="Reported" now={now} />
              {stale ? " · may be out of date" : null}
            </span>
          ) : (
            "Claude hasn't reported usage yet."
          )
        }
        error={error}
        refreshDisabledReason={disabled}
        onRefresh={state.canRefresh ? () => void state.refresh() : undefined}
      />
      {value?.refreshStatus === "scope_required" ? (
        <p className="mt-3 text-xs leading-4.5 text-fg-muted">
          This setup token allows model calls. Usage readings update after Claude is used. Sign in
          again to check current usage and reset times.
        </p>
      ) : null}
      {value?.refreshStatus === "scope_required" && onReconnect ? (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onReconnect}>
          Sign in again
        </Button>
      ) : null}
    </DetailSection>
  );
}
