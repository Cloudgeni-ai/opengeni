/**
 * Smooth content swaps for toggles, tabs and filters that load a new list
 * (All/Yours, Active/Archived, a filter): the old list stays, dimmed, until
 * the new one is ready, then the new one fades in. No blank skeleton flash
 * between two lists, and nothing moves with prefers-reduced-motion.
 */
import { useState, type ReactNode } from "react";

import { cn } from "../lib/cn";

export type HeldValue<T> = {
  /** The value to show: the current one, or while it loads the last one shown. */
  value: T | undefined;
  /** The key the shown value belongs to (for headings and empty states). */
  key: string;
  /** True while an older value stands in for one still loading. */
  stale: boolean;
};

/**
 * Keeps the last loaded value while the value for a new `key` loads
 * (`value` is `undefined` while loading). Before anything has loaded, it
 * returns `undefined`, so the first load still shows its skeleton.
 */
export function useHeldWhileLoading<T>(value: T | undefined, key: string): HeldValue<T> {
  const [held, setHeld] = useState<{ value: T; key: string } | null>(null);
  if (value !== undefined && (held === null || held.value !== value || held.key !== key)) {
    setHeld({ value, key });
  }
  if (value !== undefined) return { value, key, stale: false };
  if (held) return { value: held.value, key: held.key, stale: true };
  return { value: undefined, key, stale: false };
}

/**
 * Wraps content that a toggle swaps. While `stale`, the old content dims and
 * is marked busy; when `swapKey` changes, the new content fades in.
 */
export function ContentSwap({
  swapKey,
  stale = false,
  className,
  children,
}: {
  swapKey: string;
  stale?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-content-swap=""
      data-stale={stale ? "" : undefined}
      aria-busy={stale || undefined}
      className={cn(
        "min-w-0 transition-opacity duration-150 motion-reduce:transition-none",
        stale && "pointer-events-none opacity-60",
        className,
      )}
    >
      <div
        key={swapKey}
        className="min-w-0 animate-in fade-in-0 duration-200 motion-reduce:animate-none"
      >
        {children}
      </div>
    </div>
  );
}
