import type { CodexAccount, CodexUsagePayload } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect } from "react";
import { useOrganizationCodexUsage } from "./use-organization-codex-overview";
import { ModelSettingsPlaceholder } from "./model-settings-placeholder";
import { codexUsageReadings } from "@/components/codex-connection";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { UsageMeterGroup } from "@opengeni/react/ui/usage-meter";

export const CODEX_EXTRA_CREDITS_DESCRIPTION =
  "Allow extra credits after included usage runs out. Spread work uses other accounts' included usage first. Usage updates can lag, so a request may still use credits when this is off.";

export function CodexCreditBalance({
  credits,
  loading = false,
}: {
  credits?: CodexUsagePayload["credits"];
  loading?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 text-sm">
      <span className="text-fg-muted">Extra credits</span>
      <span className="text-right text-fg tabular-nums">
        {loading ? (
          <ModelSettingsPlaceholder />
        ) : credits?.unlimited ? (
          "Unlimited"
        ) : (
          formatCreditBalance(credits?.balance)
        )}
        {credits?.overageLimitReached ? " · spending limit reached" : null}
      </span>
    </div>
  );
}

/** "61,686.58": the balance ChatGPT reports, which may arrive as an unformatted decimal string. */
export function formatCreditBalance(balance: string | number | null | undefined): string {
  if (balance === null || balance === undefined || balance === "") return "Not reported";
  const value = typeof balance === "number" ? balance : Number(balance);
  if (!Number.isFinite(value)) return String(balance);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** No workspace assignment is required to inspect an account the administrator owns. */
export function OrganizationCodexUsage({
  client,
  organizationId,
  account,
  onNeedsReconnect,
}: {
  client: OpenGeniBrowserClient;
  organizationId: string;
  account: CodexAccount;
  onNeedsReconnect: () => Promise<void>;
}) {
  const query = useOrganizationCodexUsage(client, organizationId, account);
  const { data: live, fetching: refreshing, refresh } = query;
  const failed = Boolean(query.error) || live?.status === "error";
  useEffect(() => {
    if (live?.usage?.reason === "needs_relogin" && account.status === "active")
      void onNeedsReconnect();
  }, [live?.usage?.reason, account.status, onNeedsReconnect]);
  const needsReconnect = account.status !== "active" || live?.usage?.reason === "needs_relogin";
  const usage = live?.status !== "error" ? live?.usage : null;
  const readings = codexUsageReadings(
    usage ?? { weekly: account.weekly ?? null, fiveHour: account.fiveHour ?? null },
    Date.now(),
  );
  const checkedAt = usage?.fetchedAt ?? account.usageCheckedAt;
  return (
    <>
      <UsageMeterGroup
        windows={readings}
        loading={refreshing && !live && !account.usageCheckedAt}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        checked={
          refreshing ? (
            "Checking…"
          ) : checkedAt ? (
            <RelativeTime
              date={checkedAt}
              prefix={query.source === "provider" ? "Checked" : "Last saved"}
            />
          ) : (
            "Not checked yet"
          )
        }
        error={
          needsReconnect
            ? "Sign in to ChatGPT again to check usage."
            : failed
              ? "Couldn't check usage. Try again in a moment."
              : undefined
        }
        refreshDisabledReason={
          needsReconnect ? "Sign in to ChatGPT again to check usage." : undefined
        }
      />
      <CodexCreditBalance credits={usage?.credits} loading={query.loading} />
    </>
  );
}
