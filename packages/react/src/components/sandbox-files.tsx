import type { FsReadResponse, GitFileDiff } from "@opengeni/sdk";
import { FileIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import type { UseSandboxFilesResult } from "../hooks/use-sandbox-files";
import type { UseSandboxGitResult } from "../hooks/use-sandbox-git";
import { CodeEditor } from "./code-editor";
import { FileBrowser } from "./file-browser";
import { DiffView } from "./diff-view";
import { PierreDiff } from "./pierre-diff";
import { PierreFile } from "./pierre-file";

export type SandboxFilesProps = {
  /** From `useSandboxFiles(...)`. */
  files: UseSandboxFilesResult;
  /** From `useSandboxGit(...)` — the working-tree diff. */
  git: UseSandboxGitResult;
  /** From a second `useSandboxGit(..., { staged: true })` — the staged diff. */
  stagedGit?: UseSandboxGitResult | undefined;
  /** Whether a FileSystem surface is advertised (drives the unavailable notice). */
  fileSystemAvailable?: boolean | undefined;
  /** Use Pierre's Shiki-highlighted diff (default true; falls back to built-in). */
  usePierre?: boolean | undefined;
  /** Allow in-place editing of tree files (CodeMirror). Default true. When false
   *  the surface is review-only: every text file opens in the read-only viewer. */
  editable?: boolean | undefined;
  themeType?: "dark" | "light" | undefined;
  className?: string | undefined;
};

const STATUS_TINT: Record<GitFileDiff["status"], string> = {
  added: "text-[color:var(--og-color-status-idle,var(--color-success,#3fb950))]",
  modified: "text-[color:var(--og-color-status-running,var(--color-warning,#d29922))]",
  deleted: "text-[color:var(--og-color-danger,var(--color-danger,#f85149))]",
  renamed: "text-[color:var(--og-color-accent,var(--color-info,#58a6ff))]",
  copied: "text-[color:var(--og-color-accent,var(--color-info,#58a6ff))]",
  untracked: "text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]",
  ignored: "text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]",
  conflicted: "text-[color:var(--og-color-danger,var(--color-danger,#f85149))]",
  typechange: "text-[color:var(--og-color-status-running,var(--color-warning,#d29922))]",
};

const STATUS_LETTER: Record<GitFileDiff["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  ignored: "I",
  conflicted: "!",
  typechange: "T",
};

/**
 * The review-first Files surface: a sticky branch/dirty header, a "Changes"
 * group (changed files vs HEAD, badged), the full lazy file tree for context,
 * and an inline diff pane below for the selected changed file. The agent
 * commits; the human reviews — there is no stage/commit/push UI here (power-git
 * lives in the terminal).
 */
export function SandboxFiles({
  files,
  git,
  stagedGit,
  fileSystemAvailable = true,
  usePierre = true,
  editable = true,
  themeType,
  className,
}: SandboxFilesProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  // View vs Edit for the read-only-viewer branch (a tree file that is NOT a
  // diff). Resets to View on every new selection so opening a file never lands
  // you in a stale dirty editor for a different path.
  const [editMode, setEditMode] = useState(false);

  // Side-by-side (tree left, diff right) once the surface is wide enough;
  // stacked (tree over diff) on a narrow dock. Tracked off the container so it
  // reacts to the dock resize, not just the viewport.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWide(w >= 720);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Resolve the effective diff theme from the host palette (the `data-og-theme`
  // attribute the demo/app sets), defaulting to dark, unless the caller forced
  // one. Keeps the Pierre diff dark-on-dark instead of a white slab.
  const resolvedTheme = useThemeType(themeType);

  const activeGit = staged && stagedGit ? stagedGit : git;
  const changed = activeGit.diff;
  const changedPaths = useMemo(() => new Set(changed.map((f) => f.path)), [changed]);

  // The selection is EITHER a changed file (-> diff pane) or any tree file
  // (-> read-only viewer pane). An explicit pick wins; otherwise default to the
  // first changed file so a review-first dock opens on a diff. Crucially this is
  // NOT gated on a repo: with no changes (or no repo) the pane simply waits for a
  // tree click, and a clicked tree file always resolves to the viewer.
  const effectiveSelected = selected ?? changed[0]?.path ?? null;
  const selectedDiff = changed.find((f) => f.path === effectiveSelected) ?? null;
  // A selected path that is not a changed file is viewed (fs.read), not diffed.
  const viewPath = effectiveSelected && !selectedDiff ? effectiveSelected : null;

  // Read the selected file's contents for the viewer pane (text/base64). The
  // hook caps size + flags binary; we surface a notice for binary rather than
  // dumping base64 into the highlighter.
  const fileView = useFileView(viewPath, files.readFile);

  // Selecting a (different) file always returns to View — never drop the user
  // into an editor whose buffer belongs to the previously-selected path.
  const selectFile = useCallback((path: string) => {
    setSelected(path);
    setEditMode(false);
  }, []);

  // A tree file is editable only when it is a real, fully-loaded text file: not
  // binary (would corrupt on save) and not truncated (we only hold a PREFIX, so
  // a save would write the prefix back and lose the tail). The editor is then
  // additionally gated on the `editable` prop. Anything failing this opens
  // read-only in the viewer.
  const canEdit =
    editable &&
    viewPath !== null &&
    !fileView.loading &&
    fileView.error === null &&
    !fileView.isBinary &&
    !fileView.truncated &&
    fileView.content !== null;
  const showEditor = canEdit && editMode;

  if (!fileSystemAvailable) {
    return (
      <Notice className={className}>This sandbox does not expose a file system.</Notice>
    );
  }

  return (
    <div ref={rootRef} className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}>
      {/* Branch + dirty header */}
      <GitHeader git={git} dirtyCount={changedPaths.size} />

      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        {/* Tree pane: Changes group + full tree. A fixed left column when wide,
            a top band when narrow. */}
        <div
          className={cn(
            "min-h-0 overflow-auto",
            wide
              ? "w-[280px] shrink-0 border-r border-[color:var(--og-color-border,var(--color-border,#2a2a2a))]"
              : "flex-1",
          )}
        >
          {changed.length > 0 && (
            <div className="border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))]">
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
                Changes · {changed.length}
              </div>
              <ul className="pb-1">
                {changed.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => selectFile(file.path)}
                      className={cn(
                        "flex w-full items-center gap-1.5 truncate px-2 py-0.5 text-left text-xs hover:bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))]",
                        file.path === effectiveSelected &&
                          "bg-[color:var(--og-color-surface-2,var(--color-bg-subtle,#1c1c1c))]",
                      )}
                    >
                      <span
                        className={cn(
                          "w-3 shrink-0 text-center font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[10px]",
                          STATUS_TINT[file.status],
                        )}
                      >
                        {STATUS_LETTER[file.status]}
                      </span>
                      <FileIcon className="size-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{file.path}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[10px]">
                        <span className="text-[color:var(--og-color-status-idle,var(--color-success,#3fb950))]">
                          +{file.additions}
                        </span>
                        <span className="text-[color:var(--og-color-danger,var(--color-danger,#f85149))]">
                          −{file.deletions}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
            Files
          </div>
          <FileBrowser
            result={files}
            selectedPath={effectiveSelected ?? undefined}
            onSelectFile={selectFile}
            emptyState="No files."
            className="min-w-0"
          />
        </div>

        {/* Diff pane: the selected file's diff. Fills the remaining width when
            side-by-side, sits below the tree when stacked. */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            wide
              ? "flex-1"
              : "flex-[1.4] border-t border-[color:var(--og-color-border,var(--color-border,#2a2a2a))]",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-surface-1,var(--color-surface,#161616))] px-2 py-1">
            <span className="truncate font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[11px] text-[color:var(--og-color-fg-muted,var(--color-fg-muted,#aaa))]">
              {effectiveSelected ?? "No file selected"}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {/* The Working/Staged + Unified/Split toggles only apply to a diff.
                  Hide them in the read-only viewer (a non-changed tree file). */}
              {selectedDiff && stagedGit && (
                <Segmented
                  options={[
                    { value: "working", label: "Working tree" },
                    { value: "staged", label: "Staged" },
                  ]}
                  value={staged ? "staged" : "working"}
                  onChange={(v) => setStaged(v === "staged")}
                />
              )}
              {selectedDiff && (
                <Segmented
                  options={[
                    { value: "unified", label: "Unified" },
                    { value: "split", label: "Split" },
                  ]}
                  value={layout}
                  onChange={(v) => setLayout(v as "unified" | "split")}
                />
              )}
              {/* View/Edit toggle — only for a real, fully-loaded text file the
                  editor can safely round-trip. Binary/truncated files never get
                  an Edit affordance (they'd corrupt on save). */}
              {!selectedDiff && canEdit && (
                <Segmented
                  options={[
                    { value: "view", label: "View" },
                    { value: "edit", label: "Edit" },
                  ]}
                  value={editMode ? "edit" : "view"}
                  onChange={(v) => setEditMode(v === "edit")}
                />
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {selectedDiff ? (
              // A changed file -> diff pane (HEAD vs working/staged).
              usePierre ? (
                <PierreDiff
                  diff={[selectedDiff]}
                  layout={layout}
                  themeType={resolvedTheme}
                  fallback={
                    <DiffView diff={[selectedDiff]} layout={layout} isRepo={git.isRepo} className="p-1" />
                  }
                  className="p-1"
                />
              ) : (
                <DiffView diff={[selectedDiff]} layout={layout} isRepo={git.isRepo} className="p-1" />
              )
            ) : viewPath ? (
              // Any other tree file -> editable editor (Edit mode) or read-only
              // single-file viewer (fs.read). This works with NO repo — viewing
              // and editing files never requires git.
              showEditor && fileView.content !== null ? (
                <CodeEditor
                  key={viewPath}
                  path={viewPath}
                  initialContents={fileView.content}
                  themeType={resolvedTheme}
                  onSave={(contents) => files.writeFile(viewPath, contents)}
                  className="h-full"
                />
              ) : fileView.error ? (
                <Notice>Could not open {viewPath}: {fileView.error.message}</Notice>
              ) : fileView.loading ? (
                <Notice>Loading {viewPath}…</Notice>
              ) : fileView.isBinary ? (
                <Notice>{viewPath} is a binary file ({fileView.sizeBytes ?? 0} bytes).</Notice>
              ) : fileView.content !== null ? (
                <>
                {fileView.truncated && (
                  <div className="border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-surface-1,var(--color-surface,#161616))] px-2 py-1 text-[10px] text-[color:var(--og-color-status-running,var(--color-warning,#d29922))]">
                    Large file — showing a truncated preview ({fileView.sizeBytes ?? 0} bytes loaded). Editing is disabled to avoid corrupting the file.
                  </div>
                )}
                {usePierre ? (
                  <PierreFile
                    path={viewPath}
                    contents={fileView.content}
                    themeType={resolvedTheme}
                    fallback={
                      <pre className="overflow-auto whitespace-pre p-2 font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[12px] leading-[18px]">
                        {fileView.content}
                      </pre>
                    }
                    className="p-1"
                  />
                ) : (
                  <pre className="overflow-auto whitespace-pre p-2 font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[12px] leading-[18px]">
                    {fileView.content}
                  </pre>
                )}
                </>
              ) : (
                <Notice>Loading {viewPath}…</Notice>
              )
            ) : (
              // Nothing selected — never claim a repo is required; the tree shows
              // the whole workspace regardless of git.
              <Notice>
                {changed.length > 0
                  ? "Select a changed file to review its diff, or a file in the tree to view it."
                  : "Select a file in the tree to view it."}
              </Notice>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GitHeader({ git, dirtyCount }: { git: UseSandboxGitResult; dirtyCount: number }) {
  const dirty = dirtyCount > 0;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-surface-1,var(--color-surface,#161616))] px-2 py-1 text-xs">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          dirty
            ? "bg-[color:var(--og-color-status-running,var(--color-warning,#d29922))]"
            : "bg-[color:var(--og-color-status-idle,var(--color-success,#3fb950))]",
        )}
        title={dirty ? `${dirtyCount} changed` : "clean"}
      />
      <span className="truncate font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]">
        {git.branch ?? (git.isRepo ? "(detached)" : "no repo")}
      </span>
      {(git.ahead > 0 || git.behind > 0) && (
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
          {git.ahead > 0 && <span>↑{git.ahead}</span>}
          {git.behind > 0 && <span>↓{git.behind}</span>}
        </span>
      )}
      {dirty && (
        <span className="ml-auto shrink-0 text-[10px] text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
          {dirtyCount} changed
        </span>
      )}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center rounded-[var(--og-radius-sm,4px)] border border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-[var(--og-radius-xs,3px)] px-1.5 py-0.5 text-[10px]",
            opt.value === value
              ? "bg-[color:var(--og-color-accent-soft,var(--color-surface-2,#222))] text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
              : "text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Resolve the diff theme. An explicit prop wins; otherwise read the host's
 * `data-og-theme` (set on `<html>` or an ancestor) and default to dark. Tracks
 * live theme flips via a MutationObserver.
 */
function useThemeType(forced: "dark" | "light" | undefined): "dark" | "light" {
  const [detected, setDetected] = useState<"dark" | "light">("dark");
  useEffect(() => {
    if (forced || typeof document === "undefined") return;
    const read = () => {
      const el = document.querySelector("[data-og-theme]");
      const value = el?.getAttribute("data-og-theme");
      setDetected(value === "light" ? "light" : "dark");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-og-theme"],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [forced]);
  return forced ?? detected;
}

type FileViewState = {
  content: string | null;
  isBinary: boolean;
  /** The backend truncated the read (size cap hit) — content is a PREFIX only.
   *  Editing+saving such a file would write the prefix back and corrupt it, so
   *  the editor must stay read-only for a truncated read. */
  truncated: boolean;
  sizeBytes: number | null;
  loading: boolean;
  error: Error | null;
};

/**
 * Read a file's contents for the viewer pane. Calls `fs.read` (text by default;
 * the backend flags binary), decodes a base64 payload if one comes back, and
 * exposes loading/error/binary state. Re-fetches when the path changes; ignores
 * a stale resolve after the selection moves on.
 */
function useFileView(
  path: string | null,
  readFile: (path: string) => Promise<FsReadResponse>,
): FileViewState {
  const [state, setState] = useState<FileViewState>({
    content: null,
    isBinary: false,
    truncated: false,
    sizeBytes: null,
    loading: false,
    error: null,
  });
  useEffect(() => {
    if (!path) {
      setState({ content: null, isBinary: false, truncated: false, sizeBytes: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ content: null, isBinary: false, truncated: false, sizeBytes: null, loading: true, error: null });
    void readFile(path)
      .then((res) => {
        if (cancelled) return;
        const content = res.isBinary
          ? null
          : res.encoding === "base64"
            ? decodeBase64Utf8(res.content)
            : res.content;
        setState({
          content,
          isBinary: res.isBinary,
          truncated: res.truncated,
          sizeBytes: res.sizeBytes,
          loading: false,
          error: null,
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setState({
          content: null,
          isBinary: false,
          truncated: false,
          sizeBytes: null,
          loading: false,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path, readFile]);
  return state;
}

/** Decode a base64 payload to a UTF-8 string (browser `atob` + TextDecoder). */
function decodeBase64Utf8(b64: string): string {
  try {
    if (typeof atob === "function") {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
  } catch {
    /* fall through to returning the raw payload */
  }
  return b64;
}

function Notice({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-4 text-center text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]",
        className,
      )}
    >
      {children}
    </div>
  );
}
