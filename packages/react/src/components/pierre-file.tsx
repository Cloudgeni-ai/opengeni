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

/** Pierre `File` props subset we drive — the single-file, syntax-highlighted view
 *  (Shiki), the read counterpart of `PatchDiff`. */
type FileComponent = ComponentType<{
  file: { name: string; contents: string; lang?: string };
  options?: {
    theme?: string | { dark: string; light: string };
    themeType?: "dark" | "light";
    overflow?: "scroll" | "wrap";
    stickyHeader?: boolean;
    showLineNumbers?: boolean;
  };
  disableWorkerPool?: boolean;
  className?: string;
}>;

export type PierreFileProps = {
  /** Workspace-relative path (used for the header + language inference). */
  path: string;
  /** The decoded text contents. */
  contents: string;
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

// Lazy-load `@pierre/diffs/react`'s `File` so Shiki + the worker pool stay off the
// critical path (and out of an SSR bundle) until a file is actually viewed.
const LazyFile = lazy(async () => {
  const mod = (await import("@pierre/diffs/react")) as unknown as { File: FileComponent };
  return { default: mod.File };
});

/**
 * The Pierre-backed single-file VIEWER: Shiki-highlighted, language inferred from
 * the filename — the read complement of `PierreDiff`. Wired to `fs.read` so
 * clicking any file in the tree shows its contents (NOT a diff; no repo needed).
 * Falls back to a plain `<pre>` when `@pierre/diffs` is absent / fails to import.
 */
export function PierreFile({
  path,
  contents,
  themeType,
  theme,
  disableWorkerPool,
  loading,
  fallback,
  className,
}: PierreFileProps) {
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

  const name = path.split("/").filter(Boolean).pop() ?? path;

  if (failed) {
    return (
      <div className={className}>
        {fallback ?? <PlainFile name={name} contents={contents} />}
      </div>
    );
  }

  const options = {
    overflow: "scroll" as const,
    stickyHeader: true,
    showLineNumbers: true,
    ...(theme ? { theme } : { theme: { dark: "github-dark", light: "github-light" } }),
    themeType: themeType ?? "dark",
  };

  // Same shadow-DOM override vars as PierreDiff: pin the base background to the
  // dock surface so the viewer reads as part of the panel, not a black seam.
  const pierreVars = {
    "--diffs-dark-bg": "var(--og-color-bg, #0d0d0d)",
    "--diffs-light-bg": "var(--og-color-bg, #ffffff)",
    "--diffs-bg-buffer-override": "var(--og-color-surface-1, #161616)",
    "--diffs-bg-separator-override": "var(--og-color-surface-1, #161616)",
    "--diffs-font-size": "12.5px",
    "--diffs-line-height": "20px",
  } as CSSProperties;

  return (
    <div className={cn("min-w-0", className)} data-opengeni-pierre-file style={pierreVars}>
      <Suspense fallback={loading ?? <FileSkeleton />}>
        {/* `cacheKey` keys Pierre's worker-pool highlight cache on path+size so a
            re-select of the same file is instant but an edited file re-highlights. */}
        <LazyFile
          file={{ name, contents }}
          options={options}
          {...(disableWorkerPool !== undefined ? { disableWorkerPool } : {})}
        />
      </Suspense>
    </div>
  );
}

function PlainFile({ name, contents }: { name: string; contents: string }) {
  return (
    <pre
      className="overflow-auto whitespace-pre p-2 font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[12px] leading-[18px] text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
      data-file={name}
    >
      {contents}
    </pre>
  );
}

function FileSkeleton() {
  return (
    <div className="p-3 text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
      Loading file…
    </div>
  );
}
