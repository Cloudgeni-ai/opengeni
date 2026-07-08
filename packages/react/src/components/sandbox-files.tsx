import type { FsReadResponse } from "@opengeni/sdk";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useThemeType } from "../lib/use-theme-type";
import type { UseSandboxFilesResult } from "../hooks/use-sandbox-files";
import type { UseSandboxGitResult } from "../hooks/use-sandbox-git";
import { CodeEditor } from "./code-editor";
import { FileBrowser } from "./file-browser";
import { PierreFile } from "./pierre-file";

export type SandboxFilesProps = {
  /** From `useSandboxFiles(...)`. */
  files: UseSandboxFilesResult;
  /** From `useSandboxGit(...)` — drives the branch/dirty header only. */
  git: UseSandboxGitResult;
  /** @deprecated Diffs live in the dedicated Changes tab now; accepted for
   *  source-compat but unused (the Files surface is a browser + viewer). */
  stagedGit?: UseSandboxGitResult | undefined;
  /** Whether a FileSystem surface is advertised (drives the unavailable notice). */
  fileSystemAvailable?: boolean | undefined;
  /** Use Pierre's Shiki highlighter for the viewer (default true; plain fallback). */
  usePierre?: boolean | undefined;
  /** Allow in-place editing of tree files (CodeMirror). Default true. When false
   *  the surface is review-only: every text file opens in the read-only viewer. */
  editable?: boolean | undefined;
  /** Fired once when the user first edits an open file (wake-on-edit intent). The
   *  dock warms the box on this so the save lands fast; opening/reading never fires
   *  it. Browsing the tree/diff must not warm a box. */
  onEditIntent?: (() => void) | undefined;
  themeType?: "dark" | "light" | undefined;
  className?: string | undefined;
};

/**
 * The Files surface: a branch/dirty header, the full lazy file tree, and a
 * viewer/editor pane for the selected file. This is the workspace BROWSER — pick
 * a file to read or edit it. Diff review lives in the dedicated Changes tab (this
 * surface deliberately does NOT replicate the changed-files list, and does not
 * diff here — one job per tab). The agent commits; the human reviews.
 */
export function SandboxFiles({
  files,
  git,
  fileSystemAvailable = true,
  usePierre = true,
  editable = true,
  onEditIntent,
  themeType,
  className,
}: SandboxFilesProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // View vs Edit for the selected file. Resets to View on every new selection so
  // opening a file never lands you in a stale dirty editor for a different path.
  const [editMode, setEditMode] = useState(false);

  // Side-by-side (tree left, viewer right) once the surface is wide enough;
  // stacked (tree over viewer) on a narrow dock. Tracked off the container so it
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

  // Resolve the effective viewer theme from the host palette (the `data-og-theme`
  // attribute the demo/app sets), defaulting to dark, unless the caller forced one.
  const resolvedTheme = useThemeType(themeType);

  // The selected tree file opens in the viewer (read-only) or the editor (when
  // writable). Nothing is auto-selected — the pane waits for a tree click, so the
  // Files tab opens as a calm browser, not a diff.
  const viewPath = selected;
  const fileView = useFileView(viewPath, files.readFile);

  // Selecting a (different) file always returns to View — never drop the user into
  // an editor whose buffer belongs to the previously-selected path.
  const selectFile = useCallback((path: string) => {
    setSelected(path);
    setEditMode(false);
  }, []);

  // A tree file is editable only when it is a real, fully-loaded text file: not
  // binary (would corrupt on save) and not truncated (we only hold a PREFIX). The
  // editor is then additionally gated on the `editable` prop; anything failing this
  // opens read-only in the viewer.
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
    return <Notice className={className}>This sandbox does not expose a file system.</Notice>;
  }

  return (
    <div ref={rootRef} className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}>
      {/* Branch + dirty header (context; NOT the changed-files list). */}
      <GitHeader git={git} dirtyCount={git.diff.length} />

      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        {/* Tree pane: the full lazy file tree. A fixed left column when wide, a top
            band when narrow. */}
        <div
          className={cn(
            "flex min-h-0 flex-col",
            wide ? "w-[280px] shrink-0 border-r border-og-border" : "flex-1",
          )}
        >
          <FileBrowser
            result={files}
            selectedPath={selected ?? undefined}
            onSelectFile={selectFile}
            editable={editable}
            emptyState="This directory is empty"
            className="min-w-0 flex-1"
          />
        </div>

        {/* Viewer pane: the selected file's contents (read-only) or the editor.
            Fills the remaining width when side-by-side, sits below the tree when
            stacked. */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            wide ? "flex-1" : "flex-[1.4] border-t border-og-border",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-og-border bg-og-surface-1 px-2 py-1">
            <span className="min-w-0 truncate font-og-mono text-og-xs text-og-fg-muted">
              {selected ?? "No file selected"}
            </span>
            {/* View/Edit toggle — only for a real, fully-loaded text file the editor
                can safely round-trip. Binary/truncated/read-only files never get an
                Edit affordance (they'd corrupt on save or can't be written). */}
            {canEdit && (
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
          <div className="min-h-0 flex-1 overflow-auto">
            {viewPath ? (
              showEditor && fileView.content !== null ? (
                <CodeEditor
                  key={viewPath}
                  path={viewPath}
                  initialContents={fileView.content}
                  themeType={resolvedTheme}
                  onSave={(contents) => files.writeFile(viewPath, contents)}
                  {...(onEditIntent ? { onEditIntent } : {})}
                  className="h-full"
                />
              ) : fileView.error ? (
                <Notice>
                  Could not open {viewPath}: {fileView.error.message}
                </Notice>
              ) : fileView.loading ? (
                <Notice>Loading {viewPath}…</Notice>
              ) : fileView.isBinary ? (
                <Notice>
                  {viewPath} is a binary file ({fileView.sizeBytes ?? 0} bytes).
                </Notice>
              ) : fileView.content !== null ? (
                <>
                  {fileView.truncated && (
                    <div className="border-b border-og-border bg-og-surface-1 px-2 py-1 text-og-xs text-og-status-running">
                      Large file — showing a truncated preview ({fileView.sizeBytes ?? 0} bytes
                      loaded). Editing is disabled to avoid corrupting the file.
                    </div>
                  )}
                  {usePierre ? (
                    <PierreFile
                      path={viewPath}
                      contents={fileView.content}
                      themeType={resolvedTheme}
                      fallback={
                        <pre className="overflow-auto whitespace-pre p-2 font-og-mono text-og-sm text-og-fg">
                          {fileView.content}
                        </pre>
                      }
                      className="p-1"
                    />
                  ) : (
                    <pre className="overflow-auto whitespace-pre p-2 font-og-mono text-og-sm text-og-fg">
                      {fileView.content}
                    </pre>
                  )}
                </>
              ) : (
                <Notice>Loading {viewPath}…</Notice>
              )
            ) : (
              // Nothing selected — the tree shows the whole workspace; pick a file.
              <Notice>Select a file in the tree to view it.</Notice>
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
    <div className="flex shrink-0 items-center gap-2 border-b border-og-border bg-og-surface-1 px-2 py-1 text-og-sm">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          dirty ? "bg-og-status-running" : "bg-og-status-idle",
        )}
        title={dirty ? `${dirtyCount} changed` : "clean"}
      />
      <span className="truncate font-og-mono text-og-fg">
        {git.branch ?? (git.isRepo ? "(detached)" : "no repo")}
      </span>
      {(git.ahead > 0 || git.behind > 0) && (
        <span className="flex shrink-0 items-center gap-1.5 text-og-xs text-og-fg-subtle">
          {git.ahead > 0 && <span>↑{git.ahead}</span>}
          {git.behind > 0 && <span>↓{git.behind}</span>}
        </span>
      )}
      {dirty && (
        <span className="ml-auto shrink-0 text-og-xs text-og-fg-subtle">{dirtyCount} changed</span>
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
    <div className="flex flex-wrap items-center rounded-og-sm border border-og-border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-og-xs px-1.5 py-0.5 text-og-xs pointer-coarse:min-h-10",
            opt.value === value
              ? "bg-og-accent-soft text-og-fg"
              : "text-og-fg-subtle hover:text-og-fg",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
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
      setState({
        content: null,
        isBinary: false,
        truncated: false,
        sizeBytes: null,
        loading: false,
        error: null,
      });
      return;
    }
    let cancelled = false;
    setState({
      content: null,
      isBinary: false,
      truncated: false,
      sizeBytes: null,
      loading: true,
      error: null,
    });
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
        "flex h-full items-center justify-center p-4 text-center text-og-sm text-og-fg-subtle",
        className,
      )}
    >
      {children}
    </div>
  );
}
