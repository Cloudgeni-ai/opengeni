import { Clock3Icon } from "lucide-react";

import { cn } from "../lib/cn";
import { providerRecoveryRetryingText, type ProviderRecoveryFacts } from "../lib/provider-recovery";

export type ProviderRecoveryNoticeProps = {
  /** From `currentProviderRecovery(session, events)`; renders nothing when null. */
  recovery: ProviderRecoveryFacts | null | undefined;
  /** Replaces the secondary line; `null` hides it. */
  detail?: string | null | undefined;
  className?: string | undefined;
};

export const PROVIDER_RECOVERY_NOTICE_DETAIL =
  "Your message is saved. Opengeni keeps retrying automatically for a few minutes.";

export const SANDBOX_WAIT_NOTICE_DETAIL =
  "Your message is saved and runs as soon as the sandbox is ready. This usually takes a few minutes.";

/**
 * One calm, live status line while the same turn waits for an automatic retry
 * after a transient provider failure. It replaces itself on every attempt
 * instead of adding timeline rows, and disappears once the turn runs again.
 */
export function ProviderRecoveryNotice({
  recovery,
  detail,
  className,
}: ProviderRecoveryNoticeProps) {
  if (!recovery) return null;
  const secondary =
    detail === undefined
      ? recovery.sandboxWait
        ? SANDBOX_WAIT_NOTICE_DETAIL
        : PROVIDER_RECOVERY_NOTICE_DETAIL
      : detail;
  return (
    <div
      className={cn("flex items-start gap-2 text-og-sm text-og-fg-muted", className)}
      data-og-provider-recovery=""
    >
      <Clock3Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0" role="status" aria-live="polite">
        <p className="font-medium text-og-fg">{providerRecoveryRetryingText(recovery)}</p>
        {secondary ? <p className="mt-0.5 text-og-xs">{secondary}</p> : null}
      </div>
    </div>
  );
}
