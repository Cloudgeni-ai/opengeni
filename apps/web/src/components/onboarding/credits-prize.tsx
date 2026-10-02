import { GiftIcon, SparkleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatCreditAmount } from "@/lib/onboarding-use-case";

const COUNT_UP_MS = 1_100;

function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** Counts up to `target` once, easing out; the final value at once under reduced motion. */
function useCountUp(target: number, from: number): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : from));
  useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - (1 - progress) ** 3;
      setValue(from + (target - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from, target]);
  return value;
}

/**
 * The "you won something" visual for credits: a gift-card shaped voucher on
 * the palette's teal and peach glow, with the amount counting up, a shine that
 * sweeps across once and a few twinkling sparkles. The heading next to it
 * carries the amount in words, so the voucher is hidden from assistive
 * technology. Under reduced motion it renders the final, still card.
 */
export function CreditsPrize({
  amountMicros,
  currency,
  label,
  caption,
}: {
  amountMicros: number;
  currency: string;
  /** Small caps line above the amount, for example "Free credits". */
  label: string;
  /** One quiet line under the amount, for example the new balance. */
  caption?: string | undefined;
}) {
  const wholeAmount = amountMicros / 1_000_000;
  const shown = useCountUp(wholeAmount, Number.isInteger(wholeAmount) ? 0 : wholeAmount);
  const shineRef = useRef<HTMLSpanElement>(null);
  const sparkleRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const animations: Animation[] = [];
    const shine = shineRef.current;
    if (shine && typeof shine.animate === "function") {
      animations.push(
        shine.animate(
          [
            { transform: "translateX(-120%) skewX(-18deg)", opacity: 0 },
            { transform: "translateX(-40%) skewX(-18deg)", opacity: 1, offset: 0.3 },
            { transform: "translateX(260%) skewX(-18deg)", opacity: 0 },
          ],
          { duration: 1_400, delay: 500, easing: "ease-out", fill: "both" },
        ),
      );
    }
    sparkleRefs.current.forEach((sparkle, index) => {
      if (!sparkle || typeof sparkle.animate !== "function") return;
      animations.push(
        sparkle.animate(
          [
            { transform: "scale(0.4) rotate(0deg)", opacity: 0 },
            { transform: "scale(1.15) rotate(45deg)", opacity: 1, offset: 0.4 },
            { transform: "scale(0.85) rotate(90deg)", opacity: 0.85 },
          ],
          { duration: 900, delay: 350 + index * 220, easing: "ease-out", fill: "both" },
        ),
      );
    });
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, []);

  const sparkles = [
    "top-3 right-5 size-4",
    "top-10 right-12 size-2.5",
    "bottom-4 left-6 size-3",
    "top-5 left-[38%] size-2",
  ];

  return (
    <div
      aria-hidden="true"
      data-slot="credits-prize"
      className="relative isolate overflow-hidden rounded-2xl border border-primary-border bg-surface px-6 py-6 text-center"
    >
      {/* The palette's glow, stronger than the page wash: the card is the prize. */}
      <span className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_90%_at_0%_0%,var(--og-glow-teal),transparent_70%),radial-gradient(ellipse_80%_90%_at_100%_100%,var(--og-glow-peach),transparent_70%)]" />
      <span className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_70%_at_0%_0%,var(--og-glow-teal),transparent_70%),radial-gradient(ellipse_60%_70%_at_100%_100%,var(--og-glow-peach),transparent_70%)]" />
      {/* Gift-card notches on both edges. */}
      <span className="absolute top-1/2 -left-2.5 size-5 -translate-y-1/2 rounded-full border border-primary-border bg-bg" />
      <span className="absolute top-1/2 -right-2.5 size-5 -translate-y-1/2 rounded-full border border-primary-border bg-bg" />
      <span
        ref={shineRef}
        className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent opacity-0 dark:via-white/15"
      />
      {sparkles.map((position, index) => (
        <span
          key={position}
          ref={(element) => {
            sparkleRefs.current[index] = element;
          }}
          className={`absolute text-status-running ${position}`}
        >
          <SparkleIcon className="size-full fill-current" />
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-xs font-medium tracking-[0.14em] text-fg-muted uppercase">
        <GiftIcon className="size-3.5" />
        {label}
      </span>
      <span className="mt-2 block text-5xl leading-none font-semibold tracking-tight text-fg tabular-nums sm:text-6xl">
        {formatCreditAmount(
          Math.round((Number.isInteger(wholeAmount) ? Math.round(shown) : shown) * 1_000_000),
          currency,
        )}
      </span>
      {caption ? <span className="mt-3 block text-xs text-fg-muted">{caption}</span> : null}
    </div>
  );
}
