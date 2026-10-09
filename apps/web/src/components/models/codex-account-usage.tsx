import type { CodexAccount, CodexUsage, CodexUsagePayload } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { codexUsageReadings } from "@/components/codex-connection";
import { RelativeTime } from "@/components/ui/relative-time";
import { UsageMeterGroup } from "@/components/ui/usage-meter";

export const CODEX_EXTRA_CREDITS_DESCRIPTION =
  "Allow extra credits after included usage runs out. Spread work uses other accounts' included usage first. Usage updates can lag, so a request may still use credits when this is off.";

export function CodexCreditBalance({ credits }: { credits?: CodexUsagePayload["credits"] }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 text-sm">
      <span className="text-fg-muted">Extra credits</span>
      <span className="text-right text-fg">
        {credits?.unlimited ? "Unlimited" : (credits?.balance ?? "Not reported")}
        {credits?.overageLimitReached ? " · spending limit reached" : null}
      </span>
    </div>
  );
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
  const [live, setLive] = useState<CodexUsage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setRefreshing(true);
    setFailed(false);
    try {
      const result = await client.organizationCodexAccountUsage(organizationId, account.id);
      if (generation.current !== current) return;
      setLive(result);
      setFailed(result.status === "error");
      if (result.usage?.reason === "needs_relogin") await onNeedsReconnect();
    } catch {
      if (generation.current !== current) return;
      setFailed(true);
      setLive(null);
    } finally {
      if (generation.current === current) setRefreshing(false);
    }
  }, [client, organizationId, account.id, onNeedsReconnect]);
  useEffect(() => {
    setLive(null);
    setFailed(false);
    if (account.status === "active") void refresh();
    else setRefreshing(false);
    return () => {
      generation.current += 1;
    };
  }, [refresh, account.status]);
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
            <RelativeTime date={checkedAt} prefix={usage ? "Checked" : "Last saved"} />
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
      <CodexCreditBalance credits={usage?.credits} />
    </>
  );
}
