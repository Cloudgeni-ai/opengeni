import { ChevronRightIcon, CpuIcon, StarIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { MetaChip } from "@/components/ui/meta-chip";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  UsageMeter,
  UsageMeterGroup,
  type UsageMeterVariant,
  type UsageWindowReading,
} from "@/components/ui/usage-meter";
import {
  codexOrganizationAccounts,
  codexWorkspaceAccounts,
  exhaustedUsageWindow,
  type ModelAccount,
} from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import type { AlternativeId } from "./registry";

const VARIANT_BY_PICK: Record<AlternativeId, UsageMeterVariant> = {
  a: "bar",
  b: "text",
  c: "ring",
};

const [ops, research] = codexWorkspaceAccounts as [ModelAccount, ModelAccount];
const platform = codexOrganizationAccounts[0]!;

function readings(account: ModelAccount): UsageWindowReading[] {
  return account.usage.map((window) => ({
    label: window.label,
    percent: window.percentLeft,
    resetsLabel: window.resetsLabel,
  }));
}

function weekly(account: ModelAccount): UsageWindowReading {
  return readings(account).find((window) => window.label === "Weekly")!;
}

/** Simulates a usage check so the refresh button can be tried. */
function useFakeRefresh(initial: string) {
  const [refreshing, setRefreshing] = useState(false);
  const [checked, setChecked] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return {
    refreshing,
    checked,
    onRefresh: () => {
      setRefreshing(true);
      timer.current = setTimeout(() => {
        setRefreshing(false);
        setChecked("Checked just now");
      }, 1200);
    },
  };
}

function AccountPanel({ children, title = "Usage" }: { children: ReactNode; title?: string }) {
  return (
    <section className="min-w-0 rounded-[16px] border border-border bg-surface p-4">
      <h4 className="mb-3 text-sm font-semibold text-fg">{title}</h4>
      {children}
    </section>
  );
}

function AccountUsage({ variant }: { variant: UsageMeterVariant }) {
  const refresh = useFakeRefresh(ops.checkedLabel);
  return (
    <AccountPanel>
      <UsageMeterGroup
        windows={readings(ops)}
        variant={variant}
        checked={refresh.checked}
        refreshing={refresh.refreshing}
        onRefresh={refresh.onRefresh}
      />
    </AccountPanel>
  );
}

function AccountRow({
  account,
  variant,
  children,
}: {
  account: ModelAccount;
  variant: UsageMeterVariant;
  children?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center gap-3 py-2.5">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-2 text-xs font-semibold text-fg-muted"
      >
        {account.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 truncate text-sm leading-5 font-medium text-fg">{account.name}</p>
          {children}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4.5 text-fg-subtle">
          <span className="shrink-0">{account.plan}</span>
          <span aria-hidden="true">·</span>
          <UsageMeter
            label="Weekly"
            percent={weekly(account).percent}
            variant={variant}
            density="compact"
          />
        </div>
      </div>
      <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
    </li>
  );
}

function AccountRows({ variant }: { variant: UsageMeterVariant }) {
  return (
    <ul className="flex min-w-0 flex-col divide-y divide-border">
      <AccountRow account={ops} variant={variant}>
        <MetaChip variant="text" icon={<StarIcon />}>
          Primary
        </MetaChip>
      </AccountRow>
      <AccountRow account={research} variant={variant}>
        <StatusBadge status="paused" variant="dot" />
      </AccountRow>
      <AccountRow account={platform} variant={variant}>
        <MetaChip variant="text">{platform.sourceLabel}</MetaChip>
      </AccountRow>
    </ul>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs font-medium text-fg-subtle">{children}</p>;
}

function VersionDemo({ id }: { id: AlternativeId }) {
  const variant = VARIANT_BY_PICK[id];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <Label>On the account page</Label>
        <AccountUsage variant={variant} />
      </div>
      <div>
        <Label>In rows</Label>
        <AccountRows variant={variant} />
      </div>
      <div>
        <Label>Limit reached</Label>
        <AccountPanel>
          <UsageMeterGroup
            windows={[
              {
                label: exhaustedUsageWindow.label,
                percent: exhaustedUsageWindow.percentLeft,
                resetsLabel: exhaustedUsageWindow.resetsLabel,
              },
              { label: "5-hour", percent: 41, resetsLabel: "Today, 16:20" },
            ]}
            variant={variant}
          />
        </AccountPanel>
      </div>
    </div>
  );
}

function RefreshDemo() {
  const refresh = useFakeRefresh(ops.checkedLabel);
  return (
    <UsageMeterGroup
      windows={readings(ops)}
      checked={refresh.checked}
      refreshing={refresh.refreshing}
      onRefresh={refresh.onRefresh}
    />
  );
}

export default function UsageMeterSection() {
  return (
    <KitSection sectionKey="usage-meter">
      <Fork>
        {/* One line each, so the three versions start at the same height. */}
        <Alternative id="a" rationale="A 4px bar on the account page, plain text in rows.">
          <VersionDemo id="a" />
        </Alternative>
        <Alternative id="b" rationale="Text everywhere, no bar. The quietest.">
          <VersionDemo id="b" />
        </Alternative>
        <Alternative id="c" rationale="A ring per window. Compact, harder to compare.">
          <VersionDemo id="c" />
        </Alternative>
      </Fork>

      <StatesGrid description="The recommended thin bar, on the fixtures from the Models page.">
        <StateCell
          label="Healthy"
          note="Brand blue and no warning, down to 10% left."
          align="stretch"
          canvas="surface"
        >
          <UsageMeter label="5-hour" percent={64} resetsLabel="Today, 17:10" />
        </StateCell>
        <StateCell
          label="Low"
          note="Below 10% left the meter turns red. Above that it stays quiet."
          align="stretch"
          canvas="surface"
        >
          <UsageMeter
            label="Weekly"
            percent={weekly(research).percent}
            resetsLabel={weekly(research).resetsLabel}
          />
        </StateCell>
        <StateCell
          label="Limit reached"
          note="The reset time is what people need, so it reads darker."
          align="stretch"
          canvas="surface"
        >
          <UsageMeter
            label="Weekly"
            percent={exhaustedUsageWindow.percentLeft}
            resetsLabel={exhaustedUsageWindow.resetsLabel}
          />
        </StateCell>
        <StateCell
          label="Unknown"
          note="Codex hasn't reported this window yet. No bar, no guess."
          align="stretch"
          canvas="surface"
        >
          <UsageMeter label="5-hour" percent={null} />
        </StateCell>
        <StateCell
          label="Loading"
          note="Labels stay put; only the values wait."
          align="stretch"
          canvas="surface"
        >
          <UsageMeterGroup windows={readings(ops)} loading checked="Checking usage…" />
        </StateCell>
        <StateCell label="Refresh" note="Try the refresh button." align="stretch" canvas="surface">
          <RefreshDemo />
        </StateCell>
        <StateCell
          label="Couldn't check"
          note="The last good reading stays; the footer says what happened."
          align="stretch"
          canvas="surface"
        >
          <UsageMeterGroup
            windows={readings(ops)}
            error="Couldn't check usage. Showing the reading from 2 hours ago."
            onRefresh={() => undefined}
          />
        </StateCell>
        <StateCell
          label="Disabled with reason"
          note="Hover, focus or tap the refresh button."
          align="stretch"
          canvas="surface"
        >
          <UsageMeterGroup
            windows={readings(research)}
            checked={research.checkedLabel}
            onRefresh={() => undefined}
            refreshDisabledReason="Reconnect research@acme.dev to check its usage."
          />
        </StateCell>
        <StateCell
          label="In a row"
          note="Weekly only; the account page shows both windows."
          align="stretch"
          canvas="bg"
        >
          <div className="flex flex-col gap-2">
            <UsageMeter label="Weekly" percent={22} density="compact" />
            <UsageMeter label="Weekly" percent={8} density="compact" />
            <UsageMeter label="Weekly" percent={0} density="compact" />
            <UsageMeter label="5-hour" percent={null} density="compact" />
          </div>
        </StateCell>
        <StateCell
          label="Machines"
          note="Machines count what's used, so the tone flips near full."
          align="stretch"
          canvas="surface"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-xs text-fg-subtle">
              <CpuIcon aria-hidden="true" className="size-3.5" />
              Build box · Linux x86_64
            </div>
            <UsageMeter label="Memory" percent={32} measure="used" valueLabel="5.1 of 16 GB" />
            <UsageMeter label="Disk" percent={94} measure="used" valueLabel="226 of 240 GB" />
          </div>
        </StateCell>
        <StateCell
          label="Mobile 390"
          note="The account page at phone width."
          width="mobile"
          align="stretch"
          span={2}
          canvas="surface"
        >
          <AccountPanel>
            <UsageMeterGroup
              windows={readings(research)}
              checked={research.checkedLabel}
              onRefresh={() => undefined}
            />
          </AccountPanel>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "What's left of an account's quota: the Codex Weekly and 5-hour limits, with the reset time.",
          "Both windows on the account page; only the Weekly window in account rows, as text.",
          "Machine resources, counted as used: Memory 5.1 of 16 GB.",
        ]}
        avoid={[
          "Progress of a task or a sync. Use a status or a spinner.",
          "Abbreviations: never Wk or 5h.",
          "Color before it matters. The tone changes only below 10% left.",
          "Future wording for the past: Checked just now, never in 1m.",
        ]}
      />
    </KitSection>
  );
}
