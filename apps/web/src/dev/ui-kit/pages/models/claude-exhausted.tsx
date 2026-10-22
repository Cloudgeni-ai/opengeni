import type { ComponentType } from "react";
import type { SubscriptionUsagePool } from "@opengeni/sdk";
import { SubscriptionUsagePoolView } from "@/components/models/subscription-usage-pool";
import { ClaudeUsageReadout } from "@/components/models/claude-usage";
import { SubscriptionAccountRow } from "@/components/models/subscription-account-ui";
import { RowList } from "@opengeni/react/ui/list-row";
import { ACCOUNT_COLUMNS } from "@/components/models/codex-models";

/** Reproduction of the reported quota mix, not a live account or provider read. */
export function exhaustedClaudeFixture(now: number, mixed = false): SubscriptionUsagePool {
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const labels = [
    "Claude subscription",
    "bjarte327@gmail.com",
    "bendik@cloudgeni.ai",
    "bendik1@cloudgeni.ai",
    "jorgen.sandhaug@gmail.com",
    "yorgen0103@gmail.com",
  ];
  const weekly = labels.map((label, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    label,
    remainingPercent: index === 3 ? 44 : mixed && index === 1 ? 60 : 0,
    resetsAt: at([8.4, 53.4, 15.4, 102.4, 70.4, 66.4][index]!),
    weight: index === 0 ? 1 : 5,
    weightBasis: "plan_estimate" as const,
    observedAt: at(0),
  }));
  const forecast = {
    kind: "runs_out" as const,
    basis: "Observed pool exhaustion.",
    runsOutAt: at(0),
    nextResetAt: at(1.9),
    unusedPercent: null,
    utilizationPercent: 100,
    lowestPercent: 0,
    historyDays: 0,
  };
  return {
    provider: "claude",
    observedAt: at(0),
    windows: [
      {
        id: "weekly",
        remainingPercent: mixed ? (60 * 5) / 26 : 0,
        accounts: weekly,
        forecast: mixed
          ? {
              ...forecast,
              kind: "insufficient_history",
              basis: "Insufficient observed activity coverage.",
              runsOutAt: null,
            }
          : forecast,
      },
      {
        id: "five_hour",
        remainingPercent: mixed ? (100 * 5) / 26 : 0,
        accounts: weekly.map((account, index) => ({
          ...account,
          remainingPercent: index === 3 ? 0 : 100,
          resetsAt: index === 3 ? at(1.9) : null,
        })),
        forecast,
      },
    ],
  };
}

/** Real card, row, Claude readout and list grid; only the transport data is a fixture. */
export function ExhaustedClaudePreview({
  now = Date.now(),
  mixed = false,
  pool: suppliedPool,
  Card = SubscriptionUsagePoolView,
}: {
  now?: number;
  mixed?: boolean;
  pool?: SubscriptionUsagePool;
  Card?: ComponentType<{ pool: SubscriptionUsagePool; now?: number }>;
}) {
  const pool = suppliedPool ?? exhaustedClaudeFixture(now, mixed);
  const weekly = pool.windows.find((window) => window.id === "weekly")!;
  const short = pool.windows.find((window) => window.id === "five_hour")!;
  return (
    <RowList label="Claude model accounts" columns={ACCOUNT_COLUMNS} flush>
      <li className="col-span-full list-none">
        <Card pool={pool} now={now} />
      </li>
      {weekly.accounts.map((account, index) => (
        <SubscriptionAccountRow
          key={account.id}
          provider="claude_subscription"
          title={account.label}
          meta={[
            index === 2 || index === 3 ? "Everyone in Cloudgeni" : "cloudgeni only",
            index === 0 ? "Claude plan" : "Claude Max",
          ]}
          cells={{
            usage: (
              <ClaudeUsageReadout
                state={{
                  value: {
                    connected: true,
                    credentialVersion: 1,
                    observedAt: pool.observedAt,
                    source: "provider",
                    refreshStatus: "available",
                    refreshCheckedAt: pool.observedAt,
                    windows: [account, short.accounts[index]!].map((window, i) => ({
                      id: i === 0 ? "seven_day" : "five_hour",
                      usedPercent:
                        window.remainingPercent === null ? null : 100 - window.remainingPercent,
                      resetsAt: window.resetsAt,
                      status: window.remainingPercent === 0 ? "rejected" : null,
                      observedAt: pool.observedAt!,
                    })),
                  },
                  loading: false,
                  refreshing: false,
                  error: false,
                  canRefresh: false,
                  refresh: async () => {},
                }}
              />
            ),
          }}
          onOpen={() => undefined}
        />
      ))}
    </RowList>
  );
}
