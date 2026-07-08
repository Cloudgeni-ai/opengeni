import type { GitFileDiff } from "@opengeni/sdk";
import { useState } from "react";
import { cn } from "../lib/cn";
import { useThemeType } from "../lib/use-theme-type";
import { PierreDiff } from "../components/pierre-diff";

/* ----------------------------------------------------------------------------
   Tool diff

   Renders parsed `GitFileDiff[]` (from the V4A apply_patch parser) through the
   EXACT same diff stack the Files/Changes tabs use: `PierreDiff` (Shiki-
   highlighted), with a built-in plain-text degrade for a host without
   `@pierre/diffs` — one renderer, a single data contract. A per-block
   Unified/Split toggle sits in the header.
   -------------------------------------------------------------------------- */

export function ToolDiff({ files }: { files: GitFileDiff[] }) {
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  // Resolve the host theme (auto-detect via `data-og-theme`) with the SAME hook
  // the Files tab uses, then thread it into Pierre. Without it Pierre falls back
  // to its hard dark default and renders a github-dark slab inside a light page.
  const themeType = useThemeType(undefined);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex justify-end">
        <LayoutToggle layout={layout} onChange={setLayout} />
      </div>
      <PierreDiff diff={files} layout={layout} themeType={themeType} />
    </div>
  );
}

function LayoutToggle({ layout, onChange }: { layout: "unified" | "split"; onChange: (next: "unified" | "split") => void }) {
  return (
    <div className="inline-flex items-center gap-px rounded-og-xs border border-og-border p-px">
      {(["unified", "split"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={cn(
            "rounded-og-xs px-2 py-[3px] text-og-xs font-medium capitalize transition-colors",
            layout === value ? "bg-og-surface-2 text-og-fg" : "text-og-fg-subtle hover:text-og-fg-muted",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/** Raw-patch fallback for a V4A hunk string the parser could not structure. */
export function RawPatch({ diff }: { diff: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-og-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle">
        raw patch (could not parse hunks)
      </p>
      <pre className="max-h-72 overflow-auto border-l-2 border-og-border pl-3 font-og-mono text-og-xs leading-5">
        {diff.split("\n").map((line, index) => (
          <span
            key={index}
            className={cn(
              "block",
              line.startsWith("@@")
                ? "text-og-accent"
                : line.startsWith("+")
                  ? "text-og-status-idle"
                  : line.startsWith("-")
                    ? "text-og-status-failed"
                    : "text-og-fg-muted",
            )}
          >
            {line || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}
