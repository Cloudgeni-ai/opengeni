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
 * `GitFileDiff` hunks). This sits behind `DiffView`'s `fallback` seam so a host
 * that lacks `@pierre/diffs` keeps the hand-rolled renderer.
 */
export function PierreDiff({
  diff,
  layout = "unified",
  themeType,
  theme,
  disableWorkerPool,
  loading,
  fallback,
  className,
}: PierreDiffProps) {
  const [failed, setFailed] = useState(false);

  // Probe the import once so a hard failure (peer missing) shows `fallback`
  // rather than a Suspense boundary that never resolves.
  useEffect(() => {
    let cancelled = false;
    void import("@pierre/diffs/react").catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed && fallback !== undefined) {
    return <div className={className}>{fallback}</div>;
  }

  // Default to the dark theme: the host UI is dark-first, and Pierre's own
  // auto-detection otherwise lands on the light Shiki theme (a white diff pane
  // inside a dark dock). Callers pass `themeType="light"` to opt into light.
  const options = {
    diffStyle: layout,
    overflow: "scroll" as const,
    stickyHeader: true,
    ...(theme ? { theme } : { theme: { dark: "github-dark", light: "github-light" } }),
    themeType: themeType ?? "dark",
  };

  // Pierre renders inside a shadow DOM, so host CSS can't reach it — but it reads
  // a set of `--diffs-*-override` custom properties through the shadow boundary.
  // Pin the diff's own base background to the dock surface (Pierre's dark default
  // is pure #000, which reads as a seam against our #0d0d0d panel) and quiet the
  // hunk-separator slab so the collapsed-context row isn't a heavy gray bar.
  const pierreVars = {
    "--diffs-dark-bg": "var(--og-color-bg, #0d0d0d)",
    "--diffs-light-bg": "var(--og-color-bg, #ffffff)",
    "--diffs-bg-buffer-override": "var(--og-color-surface-1, #161616)",
    "--diffs-bg-separator-override": "var(--og-color-surface-1, #161616)",
    "--diffs-font-size": "12.5px",
    "--diffs-line-height": "20px",
  } as CSSProperties;

  return (
    <div
      className={cn("min-w-0", className)}
      data-opengeni-pierre-diff
      style={pierreVars}
    >
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
  return (
    <div className="p-3 text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
      Loading diff…
    </div>
  );
}
