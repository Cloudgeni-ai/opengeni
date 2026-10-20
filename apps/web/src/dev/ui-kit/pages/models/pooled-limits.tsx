import type { SubscriptionUsagePool } from "@opengeni/sdk";
import { SubscriptionUsagePoolView } from "@/components/models/subscription-usage-pool";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useState } from "react";

export const POOL_PREVIEW_NOW = Date.parse("2026-10-20T09:30:00Z");
const at = (hours: number) => new Date(POOL_PREVIEW_NOW + hours * 3_600_000).toISOString();
export function pooledLimitsFixture(
  scope: "organization" | "workspace",
  sparse = false,
): SubscriptionUsagePool {
  const accounts = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Engineering · Pro",
      remainingPercent: 46,
      resetsAt: at(79),
      weight: 10,
      weightBasis: "observed" as const,
      observedAt: at(-0.05),
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      label: "Operations · Pro",
      remainingPercent: 52,
      resetsAt: at(90),
      weight: 9.5,
      weightBasis: "observed" as const,
      observedAt: at(-0.05),
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      label: "Design · Plus",
      remainingPercent: 20,
      resetsAt: at(76),
      weight: 1,
      weightBasis: "plan_estimate" as const,
      observedAt: at(-0.05),
    },
  ];
  const selected = scope === "organization" ? accounts : [accounts[0]!, accounts[2]!];
  return {
    provider: "codex",
    observedAt: at(-0.05),
    windows: [
      {
        id: "weekly",
        remainingPercent: scope === "organization" ? 48 : 44,
        accounts: selected,
        forecast: {
          kind: sparse ? "insufficient_history" : "runs_out",
          basis: sparse ? "collecting usage readings" : "last 7 days, adjusted to this week's pace",
          runsOutAt: sparse ? null : at(77.5),
          nextResetAt: at(79),
          unusedPercent: null,
          lowestPercent: sparse ? null : 0,
          historyDays: sparse ? 0.3 : 7,
        },
      },
      {
        id: "five_hour",
        remainingPercent: 72,
        accounts: selected.map((account, i) => ({
          ...account,
          remainingPercent: i === 0 ? 74 : 52,
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
  const [scope, setScope] = useState<"organization" | "workspace">("organization");
  const [state, setState] = useState<"forecast" | "sparse">("forecast");
  return (
    <div data-testid="pooled-limits-preview" className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <SegmentedControl
          value={scope}
          onValueChange={setScope}
          options={[
            { value: "organization", label: "Organization" },
            { value: "workspace", label: "Workspace" },
          ]}
        />
        <SegmentedControl
          value={state}
          onValueChange={setState}
          options={[
            { value: "forecast", label: "Forecast" },
            { value: "sparse", label: "Limited history" },
          ]}
        />
      </div>
      <SectionStack variant="group">
        <Section
          title={
            scope === "organization" ? "Organization · Models" : "Engineering workspace · Models"
          }
        >
          <SubscriptionUsagePoolView
            pool={pooledLimitsFixture(scope, state === "sparse")}
            now={POOL_PREVIEW_NOW}
          />
        </Section>
      </SectionStack>
    </div>
  );
}
