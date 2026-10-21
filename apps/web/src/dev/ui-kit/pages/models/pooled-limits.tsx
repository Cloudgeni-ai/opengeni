import type { SubscriptionUsagePool } from "@opengeni/sdk";
import { SubscriptionUsagePoolView } from "@/components/models/subscription-usage-pool";
import {
  AccountGroupHeading,
  SubscriptionAccountRow,
} from "@/components/models/subscription-account-ui";
import { ProviderTile } from "@opengeni/react/app/components/models/provider-mark";
import { ListRow, RowList } from "@opengeni/react/ui/list-row";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { Select } from "@opengeni/react/ui/select";
import { useState } from "react";

export const POOL_PREVIEW_NOW = Date.parse("2026-10-20T09:30:00Z");
const at = (hours: number) => new Date(POOL_PREVIEW_NOW + hours * 3_600_000).toISOString();
export function pooledLimitsFixture(
  scope: "organization" | "workspace",
  sparse = false,
  runsOut = false,
): SubscriptionUsagePool {
  const accounts = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Team Pro 1",
      remainingPercent: 60,
      resetsAt: at(79),
      weight: 10,
      weightBasis: "observed" as const,
      observedAt: at(-0.05),
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      label: "Team Pro 2",
      remainingPercent: 70,
      resetsAt: at(90),
      weight: 9.5,
      weightBasis: "observed" as const,
      observedAt: at(-0.05),
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      label: "Team Plus",
      remainingPercent: 80,
      resetsAt: at(76),
      weight: 1,
      weightBasis: "plan_estimate" as const,
      observedAt: at(-0.05),
    },
  ];
  // The filtered workspace can use the shared Pro 1 account and its own
  // Plus account. Pro 2 is available only to a different workspace.
  // Percentages and pace remain account-wide, including other workspaces' use.
  const selected = scope === "organization" ? accounts : [accounts[0]!, accounts[2]!];
  return {
    provider: "codex",
    observedAt: at(-0.05),
    windows: [
      {
        id: "weekly",
        remainingPercent: scope === "organization" ? 65.61 : 61.82,
        accounts: selected,
        forecast: {
          kind: sparse ? "insufficient_history" : runsOut ? "runs_out" : "unused",
          basis: sparse ? "collecting usage readings" : "last 7 days, adjusted to this week's pace",
          runsOutAt: !sparse && runsOut ? at(52) : null,
          nextResetAt: at(76),
          unusedPercent: sparse || runsOut ? null : 50,
          utilizationPercent: sparse ? null : runsOut ? 100 : 50,
          lowestPercent: sparse ? null : runsOut ? 0 : 30,
          historyDays: sparse ? 0.3 : 7,
        },
      },
      {
        id: "five_hour",
        remainingPercent: 72,
        accounts: selected.map((account, i) => ({
          ...account,
          remainingPercent: i === selected.length - 1 ? 0 : 74,
          resetsAt: at(i === 0 ? 2 : 3),
        })),
        forecast: {
          kind: sparse ? "insufficient_history" : "unused",
          basis: sparse ? "collecting usage readings" : "last 7 days, adjusted by the last hour",
          runsOutAt: null,
          nextResetAt: at(2),
          unusedPercent: sparse ? null : 30,
          lowestPercent: sparse ? null : 28,
          historyDays: sparse ? 0.3 : 7,
        },
      },
    ],
  };
}

export function PooledLimitsPreview() {
  const [scenario, setScenario] = useState<
    "normal" | "runout" | "sparse" | "partial" | "workspace" | "empty"
  >("normal");
  const scope = scenario === "workspace" || scenario === "empty" ? "workspace" : "organization";
  const pool = pooledLimitsFixture(scope, scenario === "sparse", scenario === "runout");
  if (scenario === "partial") {
    // One account has not reported its limit; the total covers the other two.
    const weekly = pool.windows.find((window) => window.id === "weekly")!;
    weekly.accounts = weekly.accounts.map((account, index) =>
      index === 1 ? { ...account, remainingPercent: null } : account,
    );
    weekly.remainingPercent = 61.82;
  }
  if (scenario === "empty")
    pool.windows.forEach((window) => {
      window.accounts = [];
    });
  return (
    <div data-testid="pooled-limits-preview" className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <Select
          aria-label="Preview scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value as typeof scenario)}
        >
          <option value="normal">Organization</option>
          <option value="runout">Runs out</option>
          <option value="sparse">Limited history</option>
          <option value="partial">One account not reported</option>
          <option value="workspace">Workspace · shared and own accounts</option>
          <option value="empty">Workspace · no available accounts</option>
        </Select>
      </div>
      <SectionStack variant="group">
        <Section
          title={scope === "organization" ? "Organization · Models" : "Design workspace · Models"}
        >
          <RowList label="Model providers" flush>
            <AccountGroupHeading>Subscriptions</AccountGroupHeading>
            <li className="col-span-full list-none">
              <SubscriptionUsagePoolView pool={pool} now={POOL_PREVIEW_NOW} />
            </li>
            {(pool.windows.find((window) => window.id === "weekly")?.accounts ?? []).map(
              (account) => (
                <SubscriptionAccountRow
                  key={account.id}
                  provider="codex"
                  title={account.label}
                  description={
                    account.remainingPercent === null
                      ? "Not reported yet"
                      : account.remainingPercent === 0
                        ? "Limit reached"
                        : `${Math.round(account.remainingPercent)}% left this week`
                  }
                  onOpen={() => undefined}
                />
              ),
            )}
            <AccountGroupHeading>Pay as you go</AccountGroupHeading>
            <ListRow
              leading={<ProviderTile provider="vercel" size="lg" />}
              title="Vercel AI Gateway"
              meta={["Belongs to Design", "API key"]}
              onOpen={() => undefined}
            />
          </RowList>
        </Section>
      </SectionStack>
    </div>
  );
}
