// The card's primary status: the fused HEALTH verdict (dot + label), which
// subsumes plain connection state (offline/reconnecting fall out of it) and adds
// resource-pressure + staleness. Capability limitations (consent / no display /
// enrolling) are orthogonal to reachability, so they ride alongside as their own
// quiet chip — reusing the existing badge meta so the two surfaces never drift.
import { cn } from "../lib/cn";
import type { MachineState, MetricSample } from "../types/machines";
import { deriveHealth, HEALTH_TOKEN, healthPulses } from "./machines/health";
import { MACHINE_STATE_BADGE_META } from "./machine-status-pill";

export type MachineHealthPillProps = {
  state: MachineState;
  metrics: MetricSample | null;
  now?: number | undefined;
  size?: "sm" | "md" | undefined;
  className?: string | undefined;
};

export function MachineHealthPill({
  state,
  metrics,
  now,
  size = "sm",
  className,
}: MachineHealthPillProps) {
  const health = deriveHealth(state, metrics, now ?? Date.now());
  const tone = HEALTH_TOKEN[health.level];
  const badge = MACHINE_STATE_BADGE_META[state];
  const pad = size === "md" ? "px-2.5 py-1 text-og-sm" : "px-2 py-0.5 text-og-xs";

  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)}>
      {badge ? (
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-og-xs font-medium",
            badge.badgeClassName,
          )}
        >
          {badge.label}
        </span>
      ) : null}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border font-medium",
          pad,
          tone.soft,
          tone.text,
        )}
        data-health={health.level}
        title={health.reason}
      >
        <span className="relative flex size-2">
          {healthPulses(health.level) && (
            <span
              className={cn(
                "absolute inline-flex size-full animate-og-pulse rounded-full opacity-60",
                tone.dot,
              )}
            />
          )}
          <span className={cn("relative inline-flex size-2 rounded-full", tone.dot)} />
        </span>
        {health.label}
      </span>
    </div>
  );
}
