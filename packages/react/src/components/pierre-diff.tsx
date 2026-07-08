import type { GitFileDiff } from "@opengeni/sdk";
import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  lazy,
  Suspense,
  useEffect,
  useState,
} from "react";
import { cn } from "../lib/cn";
import { gitFileDiffToPatch } from "../lib/git-patch";

/** Pierre `PatchDiff` props subset we drive. */
type PatchDiffComponent = ComponentType<{
  patch: string;
  options?: {
    theme?: string | { dark: string; light: string };
    themeType?: "dark" | "light";
    diffStyle?: "unified" | "split";
    overflow?: "scroll" | "wrap";
    stickyHeader?: boolean;
  };
  disableWorkerPool?: boolean;
  className?: string;
}>;

export type PierreDiffProps = {
  diff: GitFileDiff[];
  layout?: "unified" | "split" | undefined;
  themeType?: "dark" | "light" | undefined;
  /** Shiki bundled theme names (dark/light) — derived from the host palette. */
  theme?: { dark: string; light: string } | undefined;
  /** Disable Pierre's worker pool if its worker bundling fights the host bundler. */
  disableWorkerPool?: boolean | undefined;
  /** Rendered while the (lazy) Pierre bundle loads. */
  loading?: ReactNode | undefined;
  /** Rendered if `@pierre/diffs/react` is not installed / fails to import. */
  fallback?: ReactNode | undefined;
  /** Skip the Shiki renderer entirely and show the plain-text degrade (the old
   *  `usePierre={false}` path — one renderer, opted out of highlighting). */
  plain?: boolean | undefined;
  /** Long-line handling: `"wrap"` soft-wraps (the default — a diff in a narrow
   *  dock pane should be readable without a horizontal-scroll tax), `"scroll"`
   *  keeps lines on one row behind a horizontal scrollbar (better for a wide
   *  viewport or pathological minified lines). */
  overflow?: "wrap" | "scroll" | undefined;
  className?: string | undefined;
};

// Lazy-load `@pierre/diffs/react` so Shiki + the worker pool stay off the
// critical path (and out of an SSR bundle) until a diff is actually shown. The
// dynamic specifier is static so the bundler can resolve + chunk it. If the
// optional peer is absent the import rejects and we render `fallback`.
const LazyPatchDiff = lazy(async () => {
  const mod = (await import("@pierre/diffs/react")) as unknown as {
    PatchDiff: PatchDiffComponent;
  };
  return { default: mod.PatchDiff };
});

/**
 * The Pierre-backed diff: Shiki-highlighted, virtualized, unified/split. Renders
 * one `PatchDiff` per changed file (a reconstructed unified patch from the
 * `GitFileDiff` hunks). The ONE workbench diff renderer; a host without
 * `@pierre/diffs` gets the built-in plain-text degrade (`PlainPatch`).
 */
export function PierreDiff({
  diff,
  layout = "unified",
  themeType,
  theme,
  disableWorkerPool,
  loading,
  fallback,
  plain,
  overflow = "wrap",
  className,
}: PierreDiffProps) {
  const [failed, setFailed] = useState(false);

  // Probe the import once so a hard failure (peer missing) shows `fallback`
  // rather than a Suspense boundary that never resolves. Skipped when `plain`.
  useEffect(() => {
    if (plain) return;
    let cancelled = false;
    void import("@pierre/diffs/react").catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [plain]);

  if (plain || failed) {
    // `plain` opts out of highlighting; `failed` = `@pierre/diffs` not installed.
    // Render the caller's fallback, or a plain (unhighlighted) patch dump — NOT a
    // second hunk renderer. One highlighted renderer (Pierre) + a text degrade.
    return <div className={className}>{fallback ?? <PlainPatch diff={diff} />}</div>;
  }

  // Default to the dark theme: the host UI is dark-first, and Pierre's own
  // auto-detection otherwise lands on the light Shiki theme (a white diff pane
  // inside a dark dock). Callers pass `themeType="light"` to opt into light.
  const options = {
    diffStyle: layout,
    overflow,
    stickyHeader: true,
    ...(theme ? { theme } : { theme: { dark: "github-dark", light: "github-light" } }),
    themeType: themeType ?? "dark",
  };

  // Pierre renders inside a shadow DOM, so host CSS can't reach it — but it reads
  // a set of `--diffs-*-override` custom properties through the shadow boundary.
  // Pin the diff's own base background to the dock surface and quiet the hunk
  // separator slab so collapsed context rows do not become heavy bars.
  const pierreVars = {
    "--diffs-dark-bg": "var(--og-color-bg)",
    "--diffs-light-bg": "var(--og-color-bg)",
    "--diffs-bg-buffer-override": "var(--og-color-surface-1)",
    "--diffs-bg-separator-override": "var(--og-color-surface-1)",
    "--diffs-font-size": "var(--og-code-font-size)",
    "--diffs-line-height": "var(--og-code-line-height)",
  } as CSSProperties;

  return (
    <div className={cn("min-w-0", className)} data-opengeni-pierre-diff style={pierreVars}>
      <Suspense fallback={loading ?? <DiffSkeleton />}>
        {diff.map((file) => (
          <div key={file.path} className="mb-2">
            <LazyPatchDiff
              patch={gitFileDiffToPatch(file)}
              options={options}
              {...(disableWorkerPool !== undefined ? { disableWorkerPool } : {})}
            />
          </div>
        ))}
      </Suspense>
    </div>
  );
}

function DiffSkeleton() {
  return <div className="p-3 text-og-sm text-og-fg-subtle">Loading diff…</div>;
}

/**
 * The unhighlighted degrade for a host without `@pierre/diffs`: the reconstructed
 * unified patch as monospace text with +/−/@@ tinting. Deliberately NOT a
 * structured hunk renderer — the workbench keeps exactly one of those (Pierre).
 */
function PlainPatch({ diff }: { diff: GitFileDiff[] }) {
  if (diff.length === 0) {
    return <div className="p-3 text-og-sm text-og-fg-subtle">No changes</div>;
  }
  return (
    <div className="min-w-0">
      {diff.map((file) => (
        <pre
          key={file.path}
          className="mb-2 overflow-auto whitespace-pre rounded-og-sm border border-og-border bg-og-bg/60 p-2.5 font-og-mono text-og-xs leading-5"
        >
          {gitFileDiffToPatch(file)
            .split("\n")
            .map((line, index) => (
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
      ))}
    </div>
  );
}
