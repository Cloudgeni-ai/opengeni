import type { GitFileDiff } from "@opengeni/sdk";
import { type ReactNode } from "react";
import { cn } from "../lib/cn";
import { PierreDiff } from "./pierre-diff";

/**
 * @deprecated Use {@link PierreDiff} directly. Retained only as a thin,
 * back-compat alias that renders the Pierre (Shiki) renderer with a plain-text
 * degrade. The old hand-rolled hunk renderer was removed in Workbench v2 — the
 * workbench keeps exactly ONE diff renderer. This alias is removed next major.
 */
export type DiffTheme = {
  addBackground?: string;
  delBackground?: string;
  contextBackground?: string;
  metaForeground?: string;
};

/**
 * @deprecated Use {@link PierreDiff}. `theme`/`onSelectFile`/`emptyState` from the
 * removed hand-rolled renderer are accepted for source compatibility and ignored;
 * `fallback` still overrides the plain-text degrade.
 */
export type DiffViewProps = {
  diff: GitFileDiff[];
  fallback?: ReactNode | undefined;
  layout?: "unified" | "split" | undefined;
  themeType?: "dark" | "light" | undefined;
  /** @deprecated line-background theming was part of the removed renderer. */
  theme?: DiffTheme | undefined;
  /** @deprecated the alias no longer renders a clickable file header. */
  onSelectFile?: ((path: string) => void) | undefined;
  isRepo?: boolean | undefined;
  emptyState?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * @deprecated Use {@link PierreDiff} directly. Thin alias: renders `PierreDiff`
 * (Shiki-highlighted, unified/split) with a plain-text fallback for a host
 * without `@pierre/diffs`. Removed next major.
 */
export function DiffView({
  diff,
  fallback,
  layout = "unified",
  themeType,
  isRepo = true,
  emptyState,
  className,
}: DiffViewProps) {
  if (diff.length === 0) {
    return (
      <div className={cn("p-3 text-og-sm text-og-fg-subtle", className)}>
        {emptyState ?? (isRepo ? "No changes" : "No repository mounted")}
      </div>
    );
  }
  return (
    <PierreDiff
      diff={diff}
      layout={layout}
      themeType={themeType}
      {...(fallback !== undefined ? { fallback } : {})}
      className={className}
    />
  );
}
