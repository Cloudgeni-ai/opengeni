import type {
  MemberAllowanceDefault,
  WorkspaceAllowanceState,
} from "@opengeni/sdk/usage-allowances";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { RowSelect } from "@/components/settings/row-select";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { TextInput } from "@/components/ui/field";
import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import {
  dollarsInputValue,
  formatBudget,
  formatCredits,
  ordinalDay,
  parseDollars,
} from "@/lib/usage-allowances";
import type { BudgetDraft } from "./use-workspace-budget";

type MemberMode = "equal_share" | "none";

const DAY_OPTIONS = [
  ...Array.from({ length: 28 }, (_, index) => ({
    value: String(index + 1),
    label: `${ordinalDay(index + 1)} of each month`,
  })),
  { value: "31", label: "Last day of each month" },
];

function memberMode(value: MemberAllowanceDefault | undefined): MemberMode {
  return value === "equal_share" ? "equal_share" : "none";
}

/**
 * The workspace's monthly budget. Owners edit it; everyone else reads the same
 * rows. Member limits default to an equal share, which is what most teams want
 * and what keeps one person from using the whole month on day one.
 */
export function BudgetForm({
  workspaceName,
  state,
  memberCount,
  canEdit,
  onSave,
  onRemove,
}: {
  workspaceName: string;
  state: WorkspaceAllowanceState;
  memberCount: number | null;
  canEdit: boolean;
  onSave: (draft: BudgetDraft) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const config = state.config;
  const custom = config?.memberDefault !== undefined && typeof config.memberDefault === "object";
  const [amount, setAmount] = useState(() =>
    config ? dollarsInputValue(config.includedCredits) : "",
  );
  const [day, setDay] = useState(() => String(config?.anchorDay ?? 1));
  const [members, setMembers] = useState<MemberMode>(() =>
    config ? memberMode(config.memberDefault) : "equal_share",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  // A newer configuration (after a save or a conflict reload) resets the form.
  useEffect(() => {
    setAmount(config ? dollarsInputValue(config.includedCredits) : "");
    setDay(String(config?.anchorDay ?? 1));
    setMembers(config ? memberMode(config.memberDefault) : "equal_share");
  }, [config, state.version]);

  const micros = parseDollars(amount);
  const invalid = amount.trim() !== "" && micros === null;
  const changed =
    !config ||
    micros !== config.includedCredits ||
    Number(day) !== (config.anchorDay ?? 1) ||
    (!custom && members !== memberMode(config.memberDefault));
  const perMember =
    micros !== null && memberCount && memberCount > 0 ? Math.floor(micros / memberCount) : null;
  const memberOptions = useMemo(
    () => [
      {
        value: "equal_share" as const,
        label: "Equal share",
        description:
          perMember !== null && memberCount
            ? `Each of ${memberCount} members can use up to ${formatCredits(perMember)}. Admins can give someone more or less.`
            : "Each member can use up to an equal part of the budget. Admins can give someone more or less.",
      },
      {
        value: "none" as const,
        label: "No individual limits",
        description: "Everyone draws from the shared budget until it runs out.",
      },
    ],
    [memberCount, perMember],
  );

  async function save() {
    if (micros === null) {
      setError("Enter a monthly amount in dollars, for example 500.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        includedCredits: micros,
        anchorDay: Number(day),
        memberDefault: custom && config?.memberDefault ? config.memberDefault : members,
      });
      toast.success(config ? "Budget saved" : `${workspaceName} now has a monthly budget`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Budget"
      description={
        config
          ? `What ${workspaceName} can spend from the organization's credits each month. Resets at midnight UTC.`
          : `${workspaceName} has no budget: it can use the organization's credits without a monthly limit.`
      }
    >
      <SettingRowGroup>
        <SettingRow
          label="Monthly budget"
          description={
            canEdit ? "Work stops for everyone in the workspace once it's used up." : undefined
          }
          error={invalid ? "Enter an amount in dollars, for example 500." : undefined}
          controlWidth="auto"
          control={
            canEdit ? (
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle"
                >
                  $
                </span>
                <TextInput
                  aria-label="Monthly budget (USD)"
                  name="monthly-budget"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="500"
                  value={amount}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => setAmount(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && changed && !saving) void save();
                  }}
                  className="h-8 w-32 pl-6 tabular-nums pointer-coarse:h-11"
                />
              </div>
            ) : (
              <span className="text-sm text-fg tabular-nums">
                {config ? `${formatBudget(config.includedCredits)} a month` : "None"}
              </span>
            )
          }
        />
        <SettingRow
          label="Resets on"
          description="Unused budget doesn't roll over."
          controlWidth="auto"
          control={
            canEdit ? (
              <RowSelect
                options={DAY_OPTIONS}
                value={day}
                onValueChange={(value) => setDay(value)}
              />
            ) : (
              <span className="text-sm text-fg">
                {DAY_OPTIONS.find((option) => option.value === day)?.label ?? `Day ${day}`}
              </span>
            )
          }
        />
        <SettingRow
          label="Member limits"
          description={
            custom
              ? "Set through the API. Change it there, or set a limit per member below."
              : memberOptions.find((option) => option.value === members)?.description
          }
          controlWidth="auto"
          control={
            canEdit && !custom ? (
              <RowSelect
                options={memberOptions.map(({ value, label }) => ({ value, label }))}
                value={members}
                onValueChange={(value) => setMembers(value)}
              />
            ) : (
              <span className="text-sm text-fg">
                {custom
                  ? "Custom default"
                  : memberOptions.find((option) => option.value === members)?.label}
              </span>
            )
          }
        />
      </SettingRowGroup>
      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {error ? (
            <p role="alert" className="min-w-0 flex-1 text-xs leading-[18px] text-danger">
              {error}
            </p>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {config ? (
              <RowButton onClick={() => setRemoveOpen(true)} disabled={saving}>
                Remove budget
              </RowButton>
            ) : null}
            <RowButton
              variant="default"
              disabled={saving || !changed || micros === null}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : config ? "Save" : "Set budget"}
            </RowButton>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs leading-[18px] text-fg-muted">
          Only organization owners can change workspace budgets.
        </p>
      )}
      <DestructiveConfirm
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${workspaceName}'s budget?`}
        consequences={[
          "The workspace can use the organization's credits without a monthly limit.",
          "Member limits stop applying.",
          "Usage so far stays on record.",
        ]}
        confirmLabel="Remove budget"
        pendingLabel="Removing…"
        onConfirm={async () => {
          await onRemove();
          toast.success(`${workspaceName} no longer has a budget`);
        }}
      />
    </Section>
  );
}
