import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SitePlatformUsage } from "@opengeni/sdk";
import { useEffect, useState } from "react";

import { Notice } from "@opengeni/react/ui/notice";
import { StatGroup, StatTile } from "@opengeni/react/ui/stat-tile";
import { apiErrorFacts } from "@opengeni/react/ui/api-error";
import {
  PLATFORM_METER_LABELS,
  formatPlatformAmount,
} from "@opengeni/react/app/lib/site-publishing";
import { formatCredits } from "@/lib/usage-allowances";

export type SitePlatformUsageLoad =
  | { state: "loading" }
  | { state: "hidden" }
  | { state: "failed" }
  | { state: "ready"; usage: SitePlatformUsage };

/**
 * This month's Site platform metrics, separate from model charges and the
 * dashboard's selected window. Hidden where the workspace can't publish.
 */
export function useSitePlatformUsage(
  client: Pick<OpenGeniBrowserClient, "getSitePlatformUsage">,
  workspaceId: string,
): SitePlatformUsageLoad {
  const [load, setLoad] = useState<SitePlatformUsageLoad>({ state: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    setLoad({ state: "loading" });
    client
      .getSitePlatformUsage(workspaceId, { signal: abort.signal })
      .then((usage) => {
        if (!abort.signal.aborted) setLoad({ state: "ready", usage });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const { status } = apiErrorFacts(error);
        setLoad({
          state: status === 404 || status === 503 || status === 403 ? "hidden" : "failed",
        });
      });
    return () => abort.abort();
  }, [client, workspaceId]);
  return load;
}

function platformNote(usage: SitePlatformUsage): string {
  switch (usage.billingMode) {
    case "usage_only":
      return "Platform activity this month. Not charged.";
    case "shadow":
      return usage.shadowMicros > 0
        ? `Platform activity this month. Not charged yet; ${formatCredits(usage.shadowMicros)} would have been charged.`
        : "Platform activity this month. Not charged yet.";
    case "credits":
      return `Platform activity this month. Use above what's included is paid with credits; ${formatCredits(usage.chargedMicros)} charged so far.`;
  }
}

/**
 * One value per meter in the KPI tiles' style. Without a limit (usage_only)
 * a meter is a plain value; with one, the tile says how much is included.
 */
export function SitePlatformUsageView({ usage }: { usage: SitePlatformUsage }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {usage.brake.engaged ? (
        <Notice tone="failed" title="Sites are paused">
          Opengeni paused Site writes, publishing and visitor agents while it reviews unusual usage.
          Pages still load.
        </Notice>
      ) : null}
      {usage.meters.length > 0 ? (
        <StatGroup columns={4} label="Site platform activity this month">
          {usage.meters.map((meter) => (
            <StatTile
              key={meter.meter}
              label={PLATFORM_METER_LABELS[meter.meter]}
              value={formatPlatformAmount(meter.meter, meter.used)}
              {...(usage.billingMode === "usage_only"
                ? {}
                : { caption: `of ${formatPlatformAmount(meter.meter, meter.allowance)} included` })}
            />
          ))}
        </StatGroup>
      ) : null}
      <p className="text-xs leading-4.5 text-fg-subtle">{platformNote(usage)}</p>
    </div>
  );
}
