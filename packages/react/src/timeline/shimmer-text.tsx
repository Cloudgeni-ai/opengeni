import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * In-flight text ("Thinking", a running tool) with a highlight sweeping across it.
 *
 * The highlight is an aria-hidden copy of the same content inside a masked
 * window. The window slides across on `transform` while the copy slides back
 * by the same amount, so the copy's text stays put and only the soft band
 * moves. Both are transform animations, which the compositor runs off the main
 * thread. The previous gradient (`background-clip: text` with an animated
 * `background-position`) repainted the text on every frame and kept the main
 * thread busy for as long as anything was running.
 *
 * Plain-string labels draw the copy from an attribute in a pseudo-element, so
 * the DOM text is not duplicated. Rich content gets an element copy carrying
 * the same `className`, so it lays out exactly like the original (flex,
 * truncation, padding). `active="ancestor"` renders the copy but leaves it to
 * an ancestor's CSS (a running rolling status) to show it.
 */
export function ShimmerText({
  active = true,
  tone = "text",
  className,
  children,
}: {
  active?: boolean | "ancestor";
  /** `text` for status labels; `reel` for the narrower beam on running activity rows. */
  tone?: "text" | "reel";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn("og-shimmer", className)}
      data-og-shimmer={active === false ? undefined : active === true ? "on" : "ancestor"}
      data-og-shimmer-tone={tone}
    >
      {children}
      {active === false ? null : typeof children === "string" ? (
        <span className="og-shimmer-beam" aria-hidden="true" data-og-shimmer-copy={children} />
      ) : (
        <span className="og-shimmer-beam" aria-hidden="true">
          <span className={cn("og-shimmer-copy", className)}>{children}</span>
        </span>
      )}
    </span>
  );
}
