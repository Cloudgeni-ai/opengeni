import type { ClaudeSubscriptionUsage, ClaudeUsageWindow } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useId, useRef } from "react";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { RelativeTime, formatAbsoluteTime, useMinuteNow } from "@opengeni/react/ui/relative-time";
import {
  UsageMeterGroup,
  UsageReadout,
  usageResets,
  type UsageWindowReading,
} from "@opengeni/react/ui/usage-meter";
import {
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
  type SharedQueryKey,
} from "@/lib/shared-query";

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

const labels: Record<ClaudeUsageWindow["id"], string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · included extra usage",
  overage: "Extra usage",
};

export function claudeUsageReadings(
  value: ClaudeSubscriptionUsage | null,
  now: number,
): UsageWindowReading[] {
  const windows = new Map(value?.windows.map((window) => [window.id, window]));
  const ids: ClaudeUsageWindow["id"][] = [
    "seven_day",
    "five_hour",
    ...[...windows.keys()].filter((id) => id !== "seven_day" && id !== "five_hour"),
  ];
  return ids.map((id) => {
    const window = windows.get(id);
    const reset = window?.resetsAt ? Date.parse(window.resetsAt) : null;
    const expired = reset !== null && reset <= now;
    return {
      label: labels[id],
      percent:
        !expired && window?.usedPercent != null
          ? Math.min(100, Math.max(0, 100 - window.usedPercent))
          : null,
      ...(!expired && window?.status === "rejected" && id !== "overage"
        ? { limitReached: true }
        : {}),
      ...(!expired &&
      window?.status === "rejected" &&
      id === "overage" &&
      window.usedPercent === null
        ? { valueLabel: "Unavailable" }
        : {}),
      ...(reset !== null && !expired
        ? { resetsLabel: formatAbsoluteTime(reset, { now }), resetsAt: reset }
        : {}),
    };
  });
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

export function ClaudeUsageReadout({ state }: { state: ClaudeUsageState }) {
  const now = useMinuteNow();
  const unavailable =
    state.error ||
    state.value?.refreshStatus === "unavailable" ||
    state.value?.refreshStatus === "reconnect";
  // A failed live check is not evidence of no usage (or a fresh old reading).
  const readings = claudeUsageReadings(unavailable ? null : state.value, now);
  const planReadings = readings.filter(
    (item) => item.label !== labels.overage && item.label !== labels.seven_day_overage_included,
  );
  const reading =
    planReadings.find((item) => item.limitReached || item.percent === 0) ??
    planReadings.find((item) => item.percent !== null) ??
    readings[0]!;
  // The shown window's reset, then the plan's other main limit.
  const resetWindows = [
    reading,
    ...readings.filter(
      (item) =>
        item !== reading && (item.label === labels.five_hour || item.label === labels.seven_day),
    ),
  ];
  return (
    <UsageReadout
      window={reading.label.replace(/^Weekly/, "this week").replace(/^5-hour$/, "this period")}
      percent={reading.percent}
      limitReached={reading.limitReached}
      resets={usageResets(resetWindows, reading.label)}
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
  onReconnect,
}: {
  state: ClaudeUsageState;
  onReconnect?: (() => void) | undefined;
}) {
  const now = useMinuteNow();
  const value = state.value;
  const readings = claudeUsageReadings(value, now);
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
