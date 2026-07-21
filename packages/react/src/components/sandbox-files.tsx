import { FileCode2Icon, FileWarningIcon, LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useThemeType } from "../lib/use-theme-type";
import {
  CapturedFileUnavailableError,
  type UseSandboxFilesResult,
} from "../hooks/use-sandbox-files";
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
  /** A guarded diff path routed here by the parent workspace. */
  requestedPath?: string | undefined;
  /** Identity for one guarded-file request. Increment this when the same path is
   *  deliberately requested again; it also lets a pending request be consumed
   *  without overriding later manual tree navigation. Defaults to the path. */
  requestedPathRequestId?: string | number | undefined;
  /** False while the parent is waking a cold sandbox for `requestedPath`. */
  requestedPathReady?: boolean | undefined;
  /** The machine is cold and no durable capture exists yet. Render an explicit
   *  wake gate instead of an empty-tree lie or an implicit Channel-A read. */
  workspaceResting?: boolean | undefined;
  /** A deliberate wake has started but the live file surface is not ready yet. */
  workspaceWaking?: boolean | undefined;
  /** Whether live reads are currently authoritative. */
  liveWorkspaceReady?: boolean | undefined;
  /** Deliberately wake the machine to read content absent from the capture. */
  onWakeWorkspace?: (() => void) | undefined;
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
  requestedPath,
  requestedPathRequestId,
  requestedPathReady = true,
  workspaceResting = false,
  workspaceWaking = false,
  liveWorkspaceReady = true,
  onWakeWorkspace,
  themeType,
  className,
}: SandboxFilesProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // View vs Edit for the selected file. Resets to View on every new selection so
  // opening a file never lands you in a stale dirty editor for a different path.
  const [editMode, setEditMode] = useState(false);
  const [liveRequestedPath, setLiveRequestedPath] = useState<string | null>(null);
  const [viewReloadRevision, setViewReloadRevision] = useState(0);
  const pendingRequestRef = useRef<string | number | null>(null);
  const handledRequestRef = useRef<string | number | null>(null);
  const requestKey = requestedPath ? (requestedPathRequestId ?? requestedPath) : null;

  useEffect(() => {
    if (!requestedPath || requestKey === null) {
      pendingRequestRef.current = null;
      handledRequestRef.current = null;
      return;
    }
    if (handledRequestRef.current === requestKey) {
      return;
    }
    if (!requestedPathReady) {
      pendingRequestRef.current = requestKey;
      return;
    }
    handledRequestRef.current = requestKey;
    pendingRequestRef.current = null;
    setSelected(requestedPath);
    setEditMode(false);
  }, [requestKey, requestedPath, requestedPathReady]);

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
  const fileView = useFileView(viewPath, files.readFile, viewReloadRevision);

  // Selecting a (different) file always returns to View — never drop the user into
  // an editor whose buffer belongs to the previously-selected path. Manual
  // navigation also consumes a pending guarded-file request: a late cold→warm
  // transition must never pull the user away from the file they chose meanwhile.
  const selectFile = useCallback((path: string) => {
    if (pendingRequestRef.current !== null) {
      handledRequestRef.current = pendingRequestRef.current;
      pendingRequestRef.current = null;
    }
    setSelected(path);
    setEditMode(false);
    setLiveRequestedPath(null);
    setViewReloadRevision(0);
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
  const captureFileUnavailable =
    fileView.error instanceof CapturedFileUnavailableError ? fileView.error : null;
  const waitingForSelectedFile =
    liveRequestedPath === viewPath &&
    (!liveWorkspaceReady || files.loading) &&
    captureFileUnavailable !== null;

  if (!fileSystemAvailable) {
    return (
      <Notice
        className={className}
        icon={<FileWarningIcon className="size-5" aria-hidden />}
        title="Files unavailable"
        announce="alert"
      >
        This sandbox does not expose a file system.
      </Notice>
    );
  }

  if (workspaceResting || workspaceWaking) {
    return (
      <div className={cn("h-full", className)} data-opengeni-workspace-resting>
        <Notice
          icon={
            workspaceWaking ? (
              <LoaderCircleIcon
                className="size-5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <FileCode2Icon className="size-5" aria-hidden />
            )
          }
          title={workspaceWaking ? "Waking workspace" : "Workspace is resting"}
          announce="status"
        >
          <p>
            {workspaceWaking
              ? "Connecting to the live file system…"
              : "No captured revision is available yet. Wake the sandbox to browse its current files."}
          </p>
          {!workspaceWaking && onWakeWorkspace ? (
            <WakeButton onClick={onWakeWorkspace}>Open live workspace</WakeButton>
          ) : null}
        </Notice>
      </div>
    );
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
            <span
              data-opengeni-selected-file
              className="min-w-0 truncate font-og-mono text-og-xs text-og-fg-muted"
            >
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
                  onSave={(contents) =>
                    files.writeFile(viewPath, contents, { expectedContent: fileView.content! })
                  }
                  onOverwrite={(contents) => files.writeFile(viewPath, contents, { force: true })}
                  onReload={() => setViewReloadRevision((revision) => revision + 1)}
                  {...(onEditIntent ? { onEditIntent } : {})}
                  className="h-full"
                />
              ) : waitingForSelectedFile ? (
                <Notice
                  icon={
                    <LoaderCircleIcon
                      className="size-5 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  }
                  title="Waking workspace"
                  announce="status"
                >
                  Opening {viewPath} when the live file system is ready…
                </Notice>
              ) : captureFileUnavailable ? (
                <Notice icon={<FileCode2Icon className="size-5" aria-hidden />} title="On machine">
                  <p>
                    {captureFileUnavailable.reason === "too-large"
                      ? "This file is larger than the captured preview limit."
                      : captureFileUnavailable.reason === "content-missing"
                        ? "The captured copy is no longer available."
                        : "This file was indexed, but it was not changed in the captured turn."}
                  </p>
                  {onWakeWorkspace ? (
                    <WakeButton
                      onClick={() => {
                        setLiveRequestedPath(viewPath);
                        if (liveWorkspaceReady) void files.refresh();
                        else onWakeWorkspace();
                      }}
                    >
                      {liveWorkspaceReady ? "Retry live file" : "Open live file"}
                    </WakeButton>
                  ) : null}
                </Notice>
              ) : fileView.error ? (
                <Notice announce="alert">
                  Could not open {viewPath}: {fileView.error.message}
                </Notice>
              ) : fileView.loading ? (
                <Notice announce="status">Loading {viewPath}…</Notice>
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
                <Notice announce="status">Loading {viewPath}…</Notice>
              )
            ) : // Nothing selected — the tree shows the whole workspace; pick a file.
            requestedPath && !requestedPathReady ? (
              <Notice
                icon={
                  <LoaderCircleIcon
                    className="size-5 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                }
                title="Waking sandbox"
                announce="status"
              >
                Opening {requestedPath} when the live workspace is ready…
              </Notice>
            ) : (
              <Notice icon={<FileCode2Icon className="size-5" aria-hidden />} title="Choose a file">
                Select a file in the tree to preview it.
              </Notice>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WakeButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 inline-flex min-h-11 items-center justify-center rounded-og-md bg-og-accent px-3 py-2 text-og-sm font-medium text-og-on-accent shadow-sm transition-colors hover:bg-og-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent focus-visible:ring-offset-2 focus-visible:ring-offset-og-bg"
    >
      {children}
    </button>
  );
}

function GitHeader({ git, dirtyCount }: { git: UseSandboxGitResult; dirtyCount: number }) {
  const dirty = dirtyCount > 0;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-og-border bg-og-surface-1 px-2 py-1 text-og-sm">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          dirty ? "bg-og-status-running" : "bg-og-status-idle",
        )}
      />
      <span className="sr-only">
        {dirty ? `Working tree has ${dirtyCount} changed files` : "Working tree clean"}
      </span>
      <span className="truncate font-og-mono text-og-fg">
        {git.repoCount > 1
          ? `${git.repoCount} repositories`
          : (git.branch ?? (git.isRepo ? "(detached)" : "no repo"))}
      </span>
      {(git.ahead > 0 || git.behind > 0) && (
        <span className="flex shrink-0 items-center gap-1.5 text-og-xs text-og-fg-subtle">
          {git.ahead > 0 && <span>↑{git.ahead}</span>}
          {git.behind > 0 && <span>↓{git.behind}</span>}
        </span>
      )}
      {dirty && (
        <span
          aria-hidden="true"
          data-contrast-audited
          className="ml-auto shrink-0 text-og-xs text-og-fg-subtle"
        >
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
    <div className="flex flex-wrap items-center rounded-og-sm border border-og-border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "min-h-7 rounded-og-xs px-1.5 py-0.5 text-og-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 max-[1023px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
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
  readFile: UseSandboxFilesResult["readFile"],
  reloadRevision = 0,
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
    const abort = new AbortController();
    setState({
      content: null,
      isBinary: false,
      truncated: false,
      sizeBytes: null,
      loading: true,
      error: null,
    });
    void readFile(path, { signal: abort.signal })
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
      abort.abort();
    };
  }, [path, readFile, reloadRevision]);
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

function Notice({
  children,
  className,
  icon,
  title,
  announce,
}: {
  children: ReactNode;
  className?: string | undefined;
  icon?: ReactNode | undefined;
  title?: string | undefined;
  announce?: "status" | "alert" | undefined;
}) {
  return (
    <div
      role={announce}
      aria-atomic={announce ? "true" : undefined}
      aria-live={announce === "alert" ? "assertive" : announce === "status" ? "polite" : undefined}
      className={cn(
        "flex h-full items-center justify-center p-4 text-center text-og-sm text-og-fg-subtle",
        className,
      )}
    >
      <div className="flex max-w-sm flex-col items-center gap-2.5">
        {icon ? (
          <span className="grid size-10 place-items-center rounded-og-lg border border-og-border bg-og-surface-1 text-og-fg-muted shadow-sm">
            {icon}
          </span>
        ) : null}
        {title ? <p className="font-medium text-og-fg">{title}</p> : null}
        <div className="leading-5">{children}</div>
      </div>
    </div>
  );
}
