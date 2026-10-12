import { parseTotpInput, totpCodeSync, totpRemainingMs } from "@opengeni/contracts";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   A live one-time code with a countdown ring. The seed stays in the parent's
   component state (revealed once, audited) and codes are computed here.
   The ring's accessible label changes at most every 10 seconds.
   -------------------------------------------------------------------------- */

export function useTotp(seed: string | null) {
  const params = useMemo(() => {
    if (!seed) return null;
    try {
      return parseTotpInput(seed);
    } catch {
      return null;
    }
  }, [seed]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!params) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [params]);
  if (!params) return null;
  const remainingMs = totpRemainingMs(params, now);
  return {
    code: totpCodeSync(params, now),
    remainingMs,
    periodSeconds: params.periodSeconds,
  };
}

/** "123 456": grouped in threes (or fours for eight digits) for reading aloud. */
export function formatTotpCode(code: string): string {
  const size = code.length === 8 ? 4 : 3;
  return code.replace(new RegExp(`(.{${size}})(?=.)`, "g"), "$1 ");
}

export function TotpRing({
  remainingMs,
  periodSeconds,
  className,
}: {
  remainingMs: number;
  periodSeconds: number;
  className?: string;
}) {
  const seconds = Math.ceil(remainingMs / 1000);
  const fraction = Math.max(0, Math.min(1, remainingMs / (periodSeconds * 1000)));
  const radius = 7.5;
  const circumference = 2 * Math.PI * radius;
  const low = seconds <= 5;
  // Coarse, so screen readers aren't told every second.
  const label = `New code in about ${Math.max(10, Math.ceil(seconds / 10) * 10)} seconds`;
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("relative inline-flex size-6 shrink-0 items-center justify-center", className)}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true" className="size-6 -rotate-90">
        <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="2" className="stroke-border" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className={cn(
            "transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none",
            low ? "stroke-status-waiting" : "stroke-brand",
          )}
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute text-2xs leading-none font-semibold tabular-nums text-fg-muted"
      >
        {seconds}
      </span>
    </span>
  );
}
