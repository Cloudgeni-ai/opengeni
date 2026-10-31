import type { OrganizationPrivacySettings } from "@opengeni/react/app/types";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@opengeni/contracts/values";
import { useAppContext } from "@opengeni/react/app/app-context";
import { TextInput } from "@opengeni/react/ui/field";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup, SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { dollarsInputValue, formatBudget, parseDollars } from "@/lib/usage-allowances";
import { isForbidden } from "./use-workspace-budget";

const DESCRIPTION =
  "What each person can spend from the organization's credits in their own Personal workspace each month. Their own model plans and keys don't count.";

/**
 * Organization settings > Billing: the optional per-person monthly limit on
 * Personal-workspace spending. Shown to the owners and admins who can read
 * the organization's privacy settings, and only while Personal workspaces
 * are on.
 */
export function PersonalWorkspaceLimitSection({ organizationId }: { organizationId: string }) {
  const { client } = useAppContext();
  const [settings, setSettings] = useState<OrganizationPrivacySettings | null>(null);
  const [hidden, setHidden] = useState(false);
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setHidden(false);
    client
      .getOrganizationPrivacySettings(organizationId)
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        // Members without the setting see nothing here; other failures say so.
        if (isForbidden(loadError)) setHidden(true);
        else setError(errorMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, [client, organizationId]);

  const current = settings?.personalWorkspaceMonthlyCredits ?? null;
  useEffect(() => {
    setAmount(current === null ? "" : dollarsInputValue(current));
  }, [current]);

  const save = useCallback(
    async (next: number | null) => {
      setSaving(true);
      setError(null);
      try {
        const value = await client.updateOrganizationPrivacySettings(organizationId, {
          personalWorkspaceMonthlyCredits: next,
        });
        setSettings(value);
        toast.success(
          next === null
            ? "Personal workspaces have no monthly limit"
            : `Each person can spend up to ${formatBudget(next)} a month in their Personal workspace`,
        );
      } catch (saveError) {
        setError(errorMessage(saveError));
      } finally {
        setSaving(false);
      }
    },
    [client, organizationId],
  );

  if (hidden || (settings && !settings.personalWorkspaces)) return null;
  if (!settings) {
    return (
      <Section title="Personal workspaces" description={DESCRIPTION}>
        {error ? (
          <p role="alert" className="text-xs leading-[18px] text-danger">
            {error}
          </p>
        ) : (
          <SettingRowSkeleton />
        )}
      </Section>
    );
  }

  const micros = parseDollars(amount);
  const empty = amount.trim() === "";
  const invalid = !empty && micros === null;
  const next = empty ? null : micros;
  const changed = !invalid && next !== current;
  return (
    <Section title="Personal workspaces" description={DESCRIPTION}>
      <SettingRowGroup>
        <SettingRow
          label="Monthly limit per person"
          description={
            current === null
              ? "None: people can use the organization's credits there without a monthly limit."
              : "Work there stops for the rest of the month once it's used up. Resets on the 1st at midnight UTC."
          }
          error={invalid ? "Enter an amount in dollars, for example 50." : undefined}
          controlWidth="auto"
          control={
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle"
              >
                $
              </span>
              <TextInput
                aria-label="Monthly limit per person (USD)"
                name="personal-workspace-monthly-limit"
                inputMode="decimal"
                autoComplete="off"
                placeholder="50"
                value={amount}
                aria-invalid={invalid || undefined}
                onChange={(event) => setAmount(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && changed && !saving) void save(next);
                }}
                className="h-8 w-32 pl-6 tabular-nums pointer-coarse:h-11"
              />
            </div>
          }
        />
      </SettingRowGroup>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {error ? (
          <p role="alert" className="min-w-0 flex-1 text-xs leading-[18px] text-danger">
            {error}
          </p>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {current !== null ? (
            <RowButton onClick={() => void save(null)} disabled={saving}>
              Remove limit
            </RowButton>
          ) : null}
          <RowButton
            variant="default"
            disabled={saving || !changed}
            onClick={() => void save(next)}
          >
            {saving ? "Saving…" : current === null ? "Set limit" : "Save"}
          </RowButton>
        </div>
      </div>
    </Section>
  );
}
