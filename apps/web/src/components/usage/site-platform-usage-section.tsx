import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SitePlatformUsage } from "@opengeni/sdk";
import { useEffect, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { Section } from "@/components/ui/section";
import { UsageMeter } from "@/components/ui/usage-meter";
import { apiErrorFacts } from "@/lib/api-error";
import { PLATFORM_METER_LABELS, formatPlatformAmount } from "@/lib/site-publishing";
import { formatCredits } from "@/lib/usage-allowances";

type Load =
  | { state: "loading" }
  | { state: "hidden" }
  | { state: "failed" }
  | { state: "ready"; usage: SitePlatformUsage };

const MODE_DESCRIPTION: Record<SitePlatformUsage["billingMode"], string> = {
  usage_only: "What this workspace's published Sites used this month. Not charged.",
  shadow: "What this workspace's published Sites used this month. Not charged yet.",
  credits: "Included every month. Use above it is paid with credits.",
};

/**
 * Workspace settings > Usage: this month's Site platform usage (requests,
 * Site SQL rows, storage) against the monthly allowance, separate from agent
 * spend. Hidden where the deployment doesn't publish Sites.
 */
export function SitePlatformUsageSection({
  client,
  workspaceId,
}: {
  client: Pick<OpenGeniBrowserClient, "getSitePlatformUsage">;
  workspaceId: string;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
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
  if (load.state === "hidden" || load.state === "loading") return null;
  if (load.state === "failed")
    return (
      <Section title="Published Sites">
        <p className="text-sm text-fg-muted">Couldn't load Site usage.</p>
      </Section>
    );
  return <SitePlatformUsageView usage={load.usage} />;
}

export function SitePlatformUsageView({ usage }: { usage: SitePlatformUsage }) {
  const charged =
    usage.billingMode === "credits"
      ? `${formatCredits(usage.chargedMicros)} charged this month`
      : usage.billingMode === "shadow" && usage.shadowMicros > 0
        ? `${formatCredits(usage.shadowMicros)} would have been charged this month`
        : null;
  return (
    <Section title="Published Sites" description={MODE_DESCRIPTION[usage.billingMode]}>
      <div className="flex min-w-0 flex-col gap-4 py-1">
        {usage.brake.engaged ? (
          <Notice tone="failed" title="Sites are paused">
            Opengeni paused Site writes, publishing and visitor agents while it reviews unusual
            usage. Pages still load.
          </Notice>
        ) : null}
        <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 max-sm:grid-cols-1">
          {usage.meters.map((meter) => (
            <UsageMeter
              key={meter.meter}
              label={PLATFORM_METER_LABELS[meter.meter]}
              measure="used"
              percent={
                usage.billingMode !== "usage_only" && meter.allowance > 0
                  ? (meter.used / meter.allowance) * 100
                  : null
              }
              valueLabel={
                usage.billingMode === "usage_only"
                  ? formatPlatformAmount(meter.meter, meter.used)
                  : `${formatPlatformAmount(meter.meter, meter.used)} of ${formatPlatformAmount(meter.meter, meter.allowance)}`
              }
            />
          ))}
        </div>
        {charged ? <p className="text-xs text-fg-muted">{charged}</p> : null}
      </div>
    </Section>
  );
}
