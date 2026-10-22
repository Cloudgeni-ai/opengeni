import { sql } from "drizzle-orm";
import { buildSubscriptionUsagePool } from "@opengeni/subscriptions";
import type { SubscriptionUsagePool } from "@opengeni/contracts";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { subscriptionCoreProvider } from "./subscription-core-providers";
import {
  readSubscriptionCoreOrganizationPool,
  readSubscriptionCoreWorkspaceView,
  type SubscriptionCoreConnectionRow,
} from "./subscription-core/administration";
import { projectSubscriptionCoreAccountUsage } from "./subscription-core/account-usage-presentation";

type Provider = SubscriptionUsagePool["provider"];
type Window = "five_hour" | "weekly";
type Reading = {
  connectionId: string;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  observedAt: number;
};
type Call = { connectionId: string; at: number; units: number };

/** Provider wire ids are normalized only at the presentation boundary. */
function windowId(provider: Provider, id: string): Window | null {
  if ((provider === "codex" && id === "primary") || id === "five_hour") return "five_hour";
  if ((provider === "codex" && id === "secondary") || id === "seven_day" || id === "weekly")
    return "weekly";
  return null;
}
function epoch(value: string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}
function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Windows the provider refuses until a later time, as the account list shows
 * "Limit reached": an exhausted window, or the account's usage-limit deadline
 * matched to the window that resets then (otherwise by its distance).
 */
export function blockedSubscriptionWindows(
  provider: Provider,
  usage: ReturnType<typeof projectSubscriptionCoreAccountUsage>,
  now: number,
): Partial<Record<Window, number | null>> {
  const blocked: Partial<Record<Window, number | null>> = {};
  if (!usage) return blocked;
  const block = (id: Window, until: number) => {
    if (until > now && blocked[id] !== null) blocked[id] = Math.max(blocked[id] ?? 0, until);
  };
  const windows = usage.windows.flatMap((window) => {
    const id = windowId(provider, window.id);
    const resetsAt = epoch(window.resetsAt);
    return id === null ? [] : [{ id, resetsAt, status: window.status }];
  });
  for (const window of windows) {
    if (window.status === "exhausted") {
      if (window.resetsAt === null) blocked[window.id] = null;
      else block(window.id, window.resetsAt);
    }
  }
  const until = epoch(usage.exhaustedUntil);
  if (until !== null && until > now) {
    const matched = windows.find(
      (window) => window.resetsAt !== null && Math.abs(window.resetsAt - until) <= 15 * 60_000,
    );
    block(matched?.id ?? (until - now > 5 * 3_600_000 ? "weekly" : "five_hour"), until);
  }
  return blocked;
}

/** Relative estimates, not promised provider allowances; observations supersede these. */
export function subscriptionPlanWeight(provider: Provider, plan: string | null): number {
  const tier = plan?.toLowerCase().replaceAll(/[^a-z0-9]/g, "") ?? "";
  if (provider === "codex") return tier === "pro" || tier === "chatgptpro" ? 10 : 1;
  if (provider === "claude") {
    if (tier.includes("max") && tier.includes("20")) return 20;
    if (tier.includes("max") && tier.includes("5")) return 5;
    if (tier.includes("max")) return 5;
  }
  return 1;
}

export async function readSubscriptionUsagePool(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string | null;
    subjectId: string;
    provider: Provider;
    now?: number;
  },
): Promise<SubscriptionUsagePool> {
  const provider = subscriptionCoreProvider(input.provider);
  const now = input.now ?? Date.now();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      let rows: SubscriptionCoreConnectionRow[];
      if (input.workspaceId === null) {
        const pool = await readSubscriptionCoreOrganizationPool(tx, provider, {
          organizationId: input.accountId,
          subjectId: input.subjectId,
        });
        if (!pool) throw new Error("Organization subscription pool is not visible");
        rows = pool.rows;
      } else {
        const { pool, personal } = await readSubscriptionCoreWorkspaceView(tx, provider, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          viewerSubjectId: input.subjectId,
          includeAllAvailableConnections: true,
        });
        rows = [
          ...new Map(
            [...pool.connections.map(({ row }) => row), ...personal].map((row) => [row.id, row]),
          ).values(),
        ];
      }
      // Only accounts that can serve work hold included usage: a disabled or
      // disconnected account is left out, as it is for routing.
      rows = rows.filter((row) => row.status === "active" && row.allocator_enabled);
      // Workspace scope selects accounts, never a fraction of their usage: a shared
      // account's history and forecast include activity from every workspace.
      const ids = rows.map((row) => row.id);
      const [data] =
        ids.length === 0
          ? []
          : await rawRows<{ history: { readings: Reading[]; calls: Call[] } }>(
              tx,
              sql`select opengeni_private.read_subscription_usage_history(${input.accountId}::uuid,
        ${input.workspaceId}::uuid, ${input.subjectId}, ${input.provider},
        ARRAY[${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]) as history`,
            );
      const readings = (data?.history.readings ?? []).flatMap((reading) => {
        const id = windowId(input.provider, reading.window);
        return id === null ? [] : [{ ...reading, window: id }];
      });
      const calls = data?.history.calls ?? [];
      const result = buildSubscriptionUsagePool({
        provider: input.provider,
        now,
        accounts: rows.map((row) => {
          const usage = projectSubscriptionCoreAccountUsage(row);
          const history = readings.filter((reading) => reading.connectionId === row.id);
          return {
            id: row.id,
            label: row.label ?? row.account_email ?? row.provider_account_id ?? "Account",
            plan: row.plan_type,
            planWeight: subscriptionPlanWeight(input.provider, row.plan_type),
            blocked: blockedSubscriptionWindows(input.provider, usage, now),
            // The stored snapshot and the retained readings compete by time:
            // the newest observation of each window is its current value.
            windows: [
              ...(usage?.windows ?? []).flatMap((window) => {
                const id = windowId(input.provider, window.id);
                return id === null
                  ? []
                  : [
                      {
                        id,
                        usedPercent: window.usedPercent,
                        resetsAt: epoch(window.resetsAt),
                        observedAt: epoch(usage?.observedAt ?? null),
                      },
                    ];
              }),
              ...history.map((reading) => ({
                id: reading.window,
                usedPercent: reading.usedPercent,
                resetsAt: reading.resetsAt,
                observedAt: reading.observedAt,
              })),
            ],
          };
        }),
        readings: readings.flatMap((reading) =>
          reading.usedPercent === null ? [] : [{ ...reading, usedPercent: reading.usedPercent }],
        ),
        calls,
        historyStart:
          readings.length || calls.length
            ? readings.reduce(
                (at, r) => Math.min(at, r.observedAt),
                calls.reduce((at, c) => Math.min(at, c.at), now),
              )
            : null,
      });
      return {
        ...result,
        provider: input.provider,
        observedAt: iso(result.observedAt),
        windows: result.windows.map((window) => ({
          ...window,
          accounts: window.accounts.map((account) => ({
            ...account,
            resetsAt: iso(account.resetsAt),
            observedAt: iso(account.observedAt),
          })),
          forecast: {
            ...window.forecast,
            runsOutAt: iso(window.forecast.runsOutAt),
            nextResetAt: iso(window.forecast.nextResetAt),
          },
        })),
      };
    },
  );
}

export async function subscriptionUsageHistoryPruneDue(db: Database): Promise<boolean> {
  const [row] = await rawRows<{ due: boolean }>(
    db,
    sql`select opengeni_private.subscription_usage_history_prune_due() as due`,
  );
  return row?.due === true;
}
export async function pruneSubscriptionUsageHistory(db: Database): Promise<number> {
  const [row] = await rawRows<{ count: number }>(
    db,
    sql`select opengeni_private.prune_subscription_usage_history() as count`,
  );
  return row?.count ?? 0;
}
