import type { ClaudeSubscriptionUsage, ClaudeUsageWindow } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailSection } from "@/components/ui/detail-sheet";
import { RelativeTime, formatAbsoluteTime, useMinuteNow } from "@/components/ui/relative-time";
import {
  UsageMeterGroup,
  UsageReadout,
  type UsageWindowReading,
} from "@/components/ui/usage-meter";

export type ClaudeUsageState = {
  value: ClaudeSubscriptionUsage | null;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  canRefresh: boolean;
  refresh(): Promise<void>;
};

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
}: {
  client: OpenGeniBrowserClient;
  scope: "workspace" | "organization";
  scopeId: string;
  enabled: boolean;
  connected: boolean;
  credentialId?: string | null;
  credentialVersion?: number | null;
  canManage: boolean;
  onCredentialChanged?: () => Promise<unknown>;
}): ClaudeUsageState {
  const key = `${scope}:${scopeId}:${credentialId ?? "unknown"}:${credentialVersion ?? "unknown"}:${enabled}:${connected}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const credentialChanged = useRef(onCredentialChanged);
  credentialChanged.current = onCredentialChanged;
  const generation = useRef(0);
  const refreshingKey = useRef<{ key: string; request: number } | null>(null);
  const [state, setState] = useState<{
    key: string;
    value: ClaudeSubscriptionUsage | null;
    error: boolean;
    loading: boolean;
    refreshing: boolean;
  }>({ key, value: null, error: false, loading: enabled && connected, refreshing: false });
  const load = useCallback(
    async (refresh: boolean) => {
      if (!enabled || !connected || (refresh && !canManage)) return;
      if (refreshingKey.current?.key === key) return;
      const request = ++generation.current;
      if (refresh) {
        refreshingKey.current = { key, request };
        setState((previous) => ({ ...previous, key, refreshing: true }));
      }
      try {
        const result =
          scope === "workspace"
            ? await (refresh
                ? client.refreshWorkspaceClaudeSubscriptionUsage(scopeId)
                : client.getWorkspaceClaudeSubscriptionUsage(scopeId))
            : await (refresh
                ? client.refreshOrganizationClaudeSubscriptionUsage(scopeId)
                : client.getOrganizationClaudeSubscriptionUsage(scopeId));
        if (currentKey.current !== key || generation.current !== request) return;
        if (
          !result.connected ||
          (credentialVersion !== undefined &&
            credentialVersion !== null &&
            result.credentialVersion !== credentialVersion)
        ) {
          setState({ key, value: null, error: true, loading: false, refreshing: false });
          await credentialChanged.current?.();
          return;
        }
        setState({ key, value: result, error: false, loading: false, refreshing: false });
      } catch {
        if (currentKey.current !== key || generation.current !== request) return;
        setState((previous) => ({
          key,
          value: previous.key === key ? previous.value : null,
          error: true,
          loading: false,
          refreshing: false,
        }));
      } finally {
        if (refresh && refreshingKey.current?.request === request) refreshingKey.current = null;
      }
    },
    [client, scope, scopeId, key, enabled, connected, canManage, credentialVersion],
  );
  useEffect(() => {
    setState({ key, value: null, error: false, loading: enabled && connected, refreshing: false });
    void load(false);
    const poll = () => {
      if (document.visibilityState !== "hidden") void load(false);
    };
    const timer = enabled && connected ? setInterval(poll, 30_000) : null;
    if (enabled && connected) document.addEventListener("visibilitychange", poll);
    return () => {
      generation.current += 1;
      if (refreshingKey.current?.key === key) refreshingKey.current = null;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [key, load, enabled, connected]);
  return {
    value: state.key === key ? state.value : null,
    error: state.key === key && state.error,
    loading: state.key !== key ? enabled && connected : state.loading,
    refreshing: state.key === key && state.refreshing,
    canRefresh: canManage && enabled && connected,
    refresh: () => load(true),
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
      ...(reset !== null && !expired ? { resetsLabel: formatAbsoluteTime(reset, { now }) } : {}),
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
  const readings = claudeUsageReadings(state.value, now);
  const planReadings = readings.filter(
    (item) => item.label !== labels.overage && item.label !== labels.seven_day_overage_included,
  );
  const reading =
    planReadings.find((item) => item.limitReached || item.percent === 0) ??
    planReadings.find((item) => item.percent !== null) ??
    readings[0]!;
  return (
    <UsageReadout
      window={reading.label.replace(/^Weekly/, "this week").replace(/^5-hour$/, "this period")}
      percent={reading.percent}
      limitReached={reading.limitReached}
      resetsLabel={reading.resetsLabel}
      loading={state.loading}
    />
  );
}

export function ClaudeUsage({ state }: { state: ClaudeUsageState }) {
  const now = useMinuteNow();
  const value = state.value;
  const readings = claudeUsageReadings(value, now);
  const reportedAt = claudeUsageReportedAt(value, now);
  const stale = Boolean(reportedAt && now - Date.parse(reportedAt) > 5 * 60_000);
  const disabled =
    value?.refreshStatus === "scope_required"
      ? "This setup token reports usage with model responses. Readings update when Claude is used."
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
      description="Limits apply to the connected Claude plan, including usage outside OpenGeni."
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
      {value?.source === "response_headers" || value?.refreshStatus === "scope_required" ? (
        <p className="mt-3 text-xs leading-4.5 text-fg-muted">
          Setup tokens report usage and reset times with model responses. Readings update when
          Claude is used.
        </p>
      ) : null}
    </DetailSection>
  );
}
