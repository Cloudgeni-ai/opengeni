/**
 * Claude usage on the shared subscription core (design 5.3, Claude track
 * C2a): the adapter's usage members (`fetchUsage`, `decodeQuota`) and the
 * projection of one core connection's quota row onto the legacy
 * `ClaudeSubscriptionUsage` response.
 *
 * - `fetchSubscriptionCoreClaudeUsage` is the legacy `/api/oauth/usage` read
 *   (`requestClaudeUsage`) through the core's request custody: a ten-second
 *   deadline, a bounded body and `redirect: "error"`. A credential without
 *   the `user:profile` OAuth scope (every setup token) is never sent: it is
 *   `scope_required` with no network call. A 401 is `reconnect`, the 403
 *   naming the `user:profile` scope requirement is `scope_required`, and any
 *   other failure is `unavailable` (never an implied zero quota).
 * - `decodeSubscriptionCoreClaudeUsage` decodes an `available` reading
 *   through `decodeSubscriptionCoreClaudeQuota`, with every Claude model the
 *   caller's catalog lists (`modelIds`), so a model-family window becomes a
 *   cooldown of each listed model of the family.
 * - `projectSubscriptionCoreClaudeUsage` maps a stored core quota back to the
 *   legacy window shape, with the connection's row `version` as the
 *   credential version (the account listing's `version`). `scope_required`
 *   and `reconnect` are response values derived from the connection, never
 *   stored: `reconnect` while the connection needs a new sign-in,
 *   `scope_required` when the adapter-owned `provider_state.oauthScopes`
 *   (written by the connect writers; `[]` for a setup token, absent when
 *   unknown) lacks `user:profile`.
 */
import { parseClaudeUsageResponse, type ClaudeUsageObservation } from "@opengeni/config";
import {
  ClaudeUsageWindowId,
  type ClaudeSubscriptionUsage,
  type ClaudeUsageWindow,
} from "@opengeni/contracts";
import { readResponseJsonBounded } from "@opengeni/network";
import {
  quotaCapacity,
  type QuotaWindow,
  type SubscriptionCoreConnectionRead,
  type SubscriptionQuota,
} from "@opengeni/subscriptions";
import {
  decodeSubscriptionCoreClaudeQuota,
  SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES,
  type SubscriptionCoreClaudeCredential,
} from "./subscription-core-claude-adapter";
import { decodeSubscriptionQuota } from "./subscription-core-repository";

/** The Claude usage endpoint (the legacy `requestClaudeUsage` URL). */
export const SUBSCRIPTION_CORE_CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The OAuth scope the usage endpoint requires. */
export const SUBSCRIPTION_CORE_CLAUDE_USAGE_SCOPE = "user:profile";
const USAGE_DEADLINE_MS = 10_000;
const USAGE_BODY_LIMIT_BYTES = 64 * 1024;

/** One usage read: the legacy refresh outcome and, when available, its observation. */
export type SubscriptionCoreClaudeUsageReading = {
  status: "available" | "unavailable" | "scope_required" | "reconnect";
  observation: ClaudeUsageObservation | null;
  checkedAt: string;
};

/** The adapter's `fetchUsage`: one usage read with the connection's current bearer. */
export async function fetchSubscriptionCoreClaudeUsage(
  read: SubscriptionCoreConnectionRead<SubscriptionCoreClaudeCredential>,
): Promise<SubscriptionCoreClaudeUsageReading> {
  const { credential } = await read.getToken();
  const checkedAt = new Date().toISOString();
  // Setup tokens never carry the scope: no request is sent.
  if (!credential.oauth?.scopes.includes(SUBSCRIPTION_CORE_CLAUDE_USAGE_SCOPE))
    return { status: "scope_required", observation: null, checkedAt };
  let status: SubscriptionCoreClaudeUsageReading["status"] = "unavailable";
  let observation: ClaudeUsageObservation | null = null;
  try {
    const signal = AbortSignal.timeout(USAGE_DEADLINE_MS);
    const response = await read.fetch(SUBSCRIPTION_CORE_CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal,
    });
    if (response.ok || response.status === 403) {
      const body = await readResponseJsonBounded<unknown>(
        response,
        USAGE_BODY_LIMIT_BYTES,
        "Claude usage",
        { signal },
      );
      if (response.ok) {
        observation = parseClaudeUsageResponse(body, new Date(checkedAt));
        status = observation ? "available" : "unavailable";
      } else {
        const error = body && typeof body === "object" && "error" in body ? body.error : null;
        const message =
          error && typeof error === "object" && "message" in error ? error.message : null;
        status =
          typeof message === "string" &&
          message.includes("scope requirement") &&
          message.includes(SUBSCRIPTION_CORE_CLAUDE_USAGE_SCOPE)
            ? "scope_required"
            : "unavailable";
      }
    } else {
      status = response.status === 401 ? "reconnect" : "unavailable";
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Keep the stored observation; never imply an unavailable quota is zero.
    status = "unavailable";
    observation = null;
  }
  return { status, observation, checkedAt };
}

function isUsageReading(value: unknown): value is SubscriptionCoreClaudeUsageReading {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    "observation" in value &&
    typeof (value as { status: unknown }).status === "string"
  );
}

/** The upstream Claude model ids among product model ids (other providers' ids are dropped). */
export function subscriptionCoreClaudeUpstreamModelIds(
  productModelIds: readonly string[],
): string[] {
  const upstream = new Set<string>();
  for (const modelId of productModelIds) {
    for (const prefix of SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES) {
      if (modelId.startsWith(`${prefix}/`) && modelId.length > prefix.length + 1)
        upstream.add(modelId.slice(prefix.length + 1));
    }
  }
  return [...upstream].sort();
}

/** The adapter's `decodeQuota`: an available reading in the shared quota model, else null. */
export function decodeSubscriptionCoreClaudeUsage(input: {
  response: unknown;
  observedAt: number;
  refreshGeneration: number;
  modelIds?: readonly string[];
}): SubscriptionQuota | null {
  if (!isUsageReading(input.response)) return null;
  const { status, observation } = input.response;
  if (status !== "available" || !observation) return null;
  return {
    ...decodeSubscriptionCoreClaudeQuota({
      observation,
      refreshGeneration: input.refreshGeneration,
      upstreamModelIds: subscriptionCoreClaudeUpstreamModelIds(input.modelIds ?? []),
    }),
    revision: 0,
  };
}

/** The fields of a core connection row the usage projection reads. */
export type SubscriptionCoreClaudeUsageRow = {
  status: string;
  provider_state: Record<string, unknown> | null;
  quota: unknown;
  quota_revision: number | string | null;
  quota_observed_refresh_generation: number | string | null;
  quota_updated_at: Date | string | null;
  /**
   * The connection's row version (the account listing's `version`): the
   * shared connection reads select it; a personal row gets it from the
   * owner-only version reader. Required: the projection throws without it.
   */
  version?: number | string;
};

/** A live refresh outcome to report instead of the one derived from the row. */
export type SubscriptionCoreClaudeUsageRefresh = {
  status: ClaudeSubscriptionUsage["refreshStatus"];
  checkedAt: string | null;
};

/**
 * Whether the connection's credential lacks the usage scope, from the
 * adapter-owned `provider_state.oauthScopes` (absent or malformed: unknown,
 * so not reported).
 */
export function subscriptionCoreClaudeUsageScopeMissing(
  providerState: Record<string, unknown> | null,
): boolean {
  const scopes = providerState?.oauthScopes;
  return (
    Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === "string") &&
    !scopes.includes(SUBSCRIPTION_CORE_CLAUDE_USAGE_SCOPE)
  );
}

/** A connection row without a usable row version (never reported as 0 or null). */
export class SubscriptionCoreClaudeUsageVersionMissing extends Error {
  constructor() {
    super("Claude usage needs the connection's row version");
  }
}

/** The row version a usage response reports; throws when the row has none. */
export function subscriptionCoreClaudeUsageVersion(row: { version?: number | string }): number {
  const version = row.version === undefined ? Number.NaN : Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new SubscriptionCoreClaudeUsageVersionMissing();
  return version;
}

// The upstream model families of the family windows (the adapter's decoder).
const FAMILY_PREFIXES: Partial<Record<ClaudeUsageWindow["id"], string>> = {
  seven_day_opus: "claude-opus-",
  seven_day_sonnet: "claude-sonnet-",
};

/**
 * The legacy status of one stored window:
 *
 * - a window the core holds as exhausted is `rejected`, whatever reading it
 *   came from (a partial reading may have kept it from an earlier one);
 * - after a usage-endpoint reading every other window is null, as legacy
 *   usage-endpoint windows were;
 * - after a response-header reading `ok` and `warning` map back to
 *   `allowed` and `allowed_warning`; the decoder stores family and overage
 *   windows as `unknown` (they never block the connection), so their
 *   header `rejected` is derived: a family window while a model of its
 *   family is cooling down, the overage window while the connection itself
 *   is exhausted (an overage that covered the plan would have kept it
 *   serving). Anything else is null.
 */
function windowStatus(
  window: QuotaWindow,
  quota: SubscriptionQuota,
  now: number,
): ClaudeUsageWindow["status"] {
  if (window.status === "exhausted") return "rejected";
  if (quota.source === "usage_endpoint") return null;
  if (window.status === "ok") return "allowed";
  if (window.status === "warning") return "allowed_warning";
  const running = window.resetsAt === null || window.resetsAt > now;
  const family = FAMILY_PREFIXES[window.id as ClaudeUsageWindow["id"]];
  if (family !== undefined)
    return running &&
      Object.entries(quota.modelCooldowns).some(
        ([modelId, until]) =>
          until > now &&
          subscriptionCoreClaudeUpstreamModelIds([modelId]).some((upstream) =>
            upstream.startsWith(family),
          ),
      )
      ? "rejected"
      : null;
  if (window.id === "overage")
    return running && quotaCapacity(quota, now).kind === "exhausted" ? "rejected" : null;
  return null;
}

function iso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * One core connection's stored quota as the legacy usage response.
 *
 * - `credentialVersion` is the connection's row version (the account
 *   listing's `version`; it moves on reconnect and rename, never on a token
 *   refresh). A row without one throws: a connected account never reports 0
 *   or null.
 * - Windows keep the legacy ids, percentages and ISO resets; every stored
 *   window stays visible whatever credential generation observed it (as
 *   legacy kept them across token refreshes). Statuses: see `windowStatus`.
 *   The shared quota keeps no per-window time or source, so each window
 *   carries the newest observation's.
 * - The refresh status is `reconnect` while the connection needs a new
 *   sign-in; else `refresh` when given (a live read decides by the
 *   credential it decoded); else `scope_required` when
 *   `provider_state.oauthScopes` lacks the usage scope, `available` when the
 *   newest stored observation is a usage-endpoint reading and `not_checked`
 *   otherwise.
 */
export function projectSubscriptionCoreClaudeUsage(
  row: SubscriptionCoreClaudeUsageRow,
  refresh?: SubscriptionCoreClaudeUsageRefresh,
): ClaudeSubscriptionUsage {
  const credentialVersion = subscriptionCoreClaudeUsageVersion(row);
  const now = Date.now();
  const quota = decodeSubscriptionQuota(row);
  const observedAt = iso(quota?.observedAt ?? null);
  const source =
    quota === null || quota.source === null || observedAt === null
      ? null
      : quota.source === "usage_endpoint"
        ? ("provider" as const)
        : ("response_headers" as const);
  const seen = new Set<string>();
  const windows: ClaudeUsageWindow[] = [];
  const stored = observedAt === null ? null : quota;
  for (const window of stored?.windows ?? []) {
    const id = ClaudeUsageWindowId.safeParse(window.id);
    if (!id.success || seen.has(id.data)) continue;
    seen.add(id.data);
    windows.push({
      id: id.data,
      usedPercent:
        window.usedPercent !== null &&
        Number.isFinite(window.usedPercent) &&
        window.usedPercent >= 0
          ? window.usedPercent
          : null,
      resetsAt: iso(window.resetsAt),
      status: windowStatus(window, stored!, now),
      observedAt: observedAt!,
      ...(source ? { source } : {}),
    });
  }
  const derived: SubscriptionCoreClaudeUsageRefresh =
    row.status === "needs_relogin"
      ? { status: "reconnect", checkedAt: refresh?.checkedAt ?? null }
      : (refresh ??
        (subscriptionCoreClaudeUsageScopeMissing(row.provider_state)
          ? { status: "scope_required", checkedAt: null }
          : source === "provider"
            ? { status: "available", checkedAt: observedAt }
            : { status: "not_checked", checkedAt: null }));
  return {
    // Every row a usage route can read is connected: the readers return no
    // disconnected connection.
    connected: true,
    credentialVersion,
    windows,
    observedAt: windows.length > 0 || source !== null ? observedAt : null,
    source,
    refreshStatus: derived.status,
    refreshCheckedAt: derived.checkedAt,
  };
}
