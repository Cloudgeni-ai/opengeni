import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { ScheduledTaskAccessAttention } from "@/types";

const ATTENTION_UPDATED = "opengeni:scheduled-task-attention-updated";
const ATTENTION_SEEN = "opengeni:scheduled-task-attention-seen";
const SEEN_STORAGE_KEY = "opengeni.schedules.attention-seen";
/** Per workspace; old entries fall off first. Durable truth stays on the server. */
const SEEN_LIMIT = 200;
const POLL_MS = 60_000;

export function notifyScheduledTaskAttentionUpdated() {
  window.dispatchEvent(new Event(ATTENTION_UPDATED));
}

type AttentionIdentity = Pick<
  ScheduledTaskAccessAttention,
  "taskId" | "runId" | "executionDigest" | "unavailableAccounts"
>;

/**
 * A new failing run of the same schedule is a new notice. So is a chosen
 * account becoming unusable: that notice has no run, so it is identified by
 * the task head and the connectors, and breaking again after a refresh or an
 * edit (a new head) notifies again.
 */
export function scheduledTaskAttentionKey(item: AttentionIdentity) {
  const run = `${item.taskId}:${item.runId ?? "no-run"}`;
  const accounts = [...new Set(item.unavailableAccounts.map((connector) => connector.id))].sort();
  return accounts.length === 0
    ? run
    : `${run}:accounts:${item.executionDigest}:${accounts.join(",")}`;
}

function readSeenStore(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string[]>)
      : {};
  } catch {
    return {};
  }
}

function seenFor(workspaceId: string): Set<string> {
  const value = readSeenStore()[workspaceId];
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
}

/**
 * Record that the owner has seen these notices (the Schedules page rendered
 * them). Only the navigation dot uses this per-browser marker; each card keeps
 * its notice until a later run succeeds.
 */
export function markScheduledTaskAttentionSeen(
  workspaceId: string,
  items: readonly AttentionIdentity[],
) {
  if (items.length === 0) return;
  const seen = seenFor(workspaceId);
  const before = seen.size;
  for (const item of items) seen.add(scheduledTaskAttentionKey(item));
  if (seen.size === before) return;
  try {
    const store = readSeenStore();
    store[workspaceId] = [...seen].slice(-SEEN_LIMIT);
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Without storage the dot stays until the failure is resolved.
  }
  window.dispatchEvent(new Event(ATTENTION_SEEN));
}

/**
 * The Schedules navigation dot: a schedule this person can act on has a run
 * that failed closed on connector access, or cannot start because a chosen
 * account is gone, and they have not looked at it yet.
 */
export function useScheduledTaskAttentionIndicator(workspaceId: string, enabled = true) {
  const { client, accessContext } = useAppContext();
  const permitted = hasWorkspacePermission(accessContext, workspaceId, "scheduled_tasks:run");
  const [result, setResult] = useState<{
    workspaceId: string;
    items: ScheduledTaskAccessAttention[];
  } | null>(null);
  const [seenVersion, setSeenVersion] = useState(0);
  useEffect(() => {
    const bump = () => setSeenVersion((value) => value + 1);
    window.addEventListener(ATTENTION_SEEN, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(ATTENTION_SEEN, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  useEffect(() => {
    if (!enabled || !permitted) return;
    let current = true;
    let generation = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const request = ++generation;
      void client
        .listScheduledTaskAccessAttention(workspaceId)
        .then((items) => {
          // The dot renders on every workspace page, so an unexpected answer
          // is a failed read here, never a crash of the navigation.
          if (!Array.isArray(items)) throw new TypeError("Schedule attention is not a list");
          if (current && request === generation) setResult({ workspaceId, items });
        })
        .catch(() => {
          // Keep the last known state on a transient failure; retry on focus/poll.
        });
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener(ATTENTION_UPDATED, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(ATTENTION_UPDATED, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, workspaceId, enabled, permitted]);
  return useMemo(() => {
    if (!permitted || result?.workspaceId !== workspaceId) return false;
    const seen = seenFor(workspaceId);
    return result.items.some((item) => !seen.has(scheduledTaskAttentionKey(item)));
    // seenVersion re-reads the per-browser seen marker after it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permitted, result, workspaceId, seenVersion]);
}
