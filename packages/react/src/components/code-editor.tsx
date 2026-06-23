import { Loader2Icon, SaveIcon } from "lucide-react";
import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";

// --- Lazy CodeMirror surface ----------------------------------------------
//
// CodeMirror 6 (via @uiw/react-codemirror) plus the per-language grammars are a
// heavy bundle (lezer parsers, the view layer). We keep them OFF the critical
// path and out of any SSR bundle by lazy-importing only when a file is actually
// EDITED. The read-only viewer stays Pierre's Shiki `File`; this is the
// editable complement, mounted on demand.

/** The subset of `@uiw/react-codemirror`'s props we drive. */
type ReactCodeMirrorComponent = ComponentType<{
  value?: string;
  height?: string;
  theme?: "light" | "dark" | "none" | unknown;
  editable?: boolean;
  readOnly?: boolean;
  basicSetup?: boolean | Record<string, boolean>;
  extensions?: unknown[];
  onChange?: ((value: string) => void) | undefined;
  className?: string;
  style?: CSSProperties;
}>;

// Resolved lazily on first edit: the editor component + the keymap/Prec helpers
// (both re-exported from @uiw/react-codemirror, which re-exports @codemirror/view
// and @codemirror/state) + the chosen language extension.
type EditorBundle = {
  Editor: ReactCodeMirrorComponent;
  saveKeymapExtension: (onSave: () => void) => unknown;
  languageExtension: unknown | null;
};

/** Language grammar loaders, keyed by the extension class we infer from the path. */
const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  javascript: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
};

/** Map a filename to a grammar key (or null for plain text — still fully editable). */
export function languageForPath(path: string): keyof typeof LANGUAGE_LOADERS | null {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
      return "json";
    case "py":
    case "pyi":
      return "python";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "vue":
      return "html";
    default:
      return null;
  }
}

const LazyCodeMirror = lazy(async () => {
  const mod = (await import("@uiw/react-codemirror")) as unknown as {
    default: ReactCodeMirrorComponent;
  };
  return { default: mod.default };
});

export type CodeEditorProps = {
  /** Workspace-relative path — drives language inference (and the save target upstream). */
  path: string;
  /** The decoded text contents to seed the editor with. */
  initialContents: string;
  /** Persist the current buffer. Resolves when the write lands; rejects to surface an error. */
  onSave: (contents: string) => Promise<unknown>;
  /** Read-only mode (e.g. a truncated/too-large file shown for reference only). */
  readOnly?: boolean | undefined;
  themeType?: "dark" | "light" | undefined;
  /** Rendered while the (lazy) CodeMirror bundle loads. */
  loading?: ReactNode | undefined;
  /** Rendered if `@uiw/react-codemirror` is not installed / fails to import. */
  fallback?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * The EDITABLE single-file pane: CodeMirror 6 with a per-language grammar chosen
 * from the filename, og-* themed, with dirty tracking and a save path wired to
 * `Cmd/Ctrl+S` *and* an explicit Save button. The viewer (Pierre `File`) stays
 * the read-only complement — this is only mounted when the user opts to edit.
 *
 * Save semantics: the buffer is "dirty" the moment it diverges from the last
 * saved baseline; a successful `onSave` clears dirty and re-baselines. A failed
 * save keeps the buffer dirty (nothing is lost) and surfaces the error inline.
 * `readOnly` suppresses every mutation path so a truncated/binary file can never
 * be saved back (which would corrupt it by writing the truncated prefix).
 */
export function CodeEditor({
  path,
  initialContents,
  onSave,
  readOnly = false,
  themeType = "dark",
  loading,
  fallback,
  className,
}: CodeEditorProps) {
  const [failed, setFailed] = useState(false);
  const [bundle, setBundle] = useState<EditorBundle | null>(null);

  // The live buffer + the baseline it's compared against for dirtiness. The
  // baseline resets whenever a *new* file is loaded (path/initialContents change)
  // or after a successful save.
  const [value, setValue] = useState(initialContents);
  const [baseline, setBaseline] = useState(initialContents);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const dirty = value !== baseline;

  // Reload the buffer when the file identity changes. Guard on initialContents
  // too so an external refresh of the SAME path (e.g. fs.changed re-read) reseeds
  // a clean buffer — but only when the user hasn't got unsaved edits in flight.
  const lastSeed = useRef<{ path: string; contents: string }>({ path, contents: initialContents });
  useEffect(() => {
    const seedChanged =
      lastSeed.current.path !== path || lastSeed.current.contents !== initialContents;
    if (!seedChanged) return;
    lastSeed.current = { path, contents: initialContents };
    setValue(initialContents);
    setBaseline(initialContents);
    setSaveError(null);
    setSavedTick(false);
  }, [path, initialContents]);

  // Resolve the lazy bundle (editor + keymap/Prec helpers + language grammar)
  // once, re-resolving the grammar when the file's language class changes.
  const langKey = useMemo(() => languageForPath(path), [path]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cmMod = (await import("@uiw/react-codemirror")) as unknown as {
          default: ReactCodeMirrorComponent;
          keymap: { of: (binds: unknown[]) => unknown };
          Prec: { highest: (ext: unknown) => unknown };
        };
        const languageExtension = langKey ? await LANGUAGE_LOADERS[langKey]?.() : null;
        if (cancelled) return;
        // A high-precedence Cmd/Ctrl-S keymap that calls back into the latest
        // save handler (kept fresh via a ref) and swallows the browser's
        // "save page" default.
        const saveKeymapExtension = (run: () => void) =>
          cmMod.Prec.highest(
            cmMod.keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  run();
                  return true;
                },
              },
            ]),
          );
        setBundle({
          Editor: cmMod.default,
          saveKeymapExtension,
          languageExtension: languageExtension ?? null,
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [langKey]);

  // Keep the freshest save closure reachable from the (stable) keymap binding.
  const saveRef = useRef<() => void>(() => {});

  const save = useCallback(async () => {
    if (readOnly) return;
    // Snapshot the buffer at call time so an in-flight edit can't race the write.
    const snapshot = value;
    if (snapshot === baseline) return; // nothing to persist
    setSaving(true);
    setSaveError(null);
    setSavedTick(false);
    try {
      await onSave(snapshot);
      setBaseline(snapshot);
      lastSeed.current = { path, contents: snapshot };
      setSavedTick(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setSaving(false);
    }
  }, [readOnly, value, baseline, onSave, path]);

  saveRef.current = () => {
    void save();
  };

  // A brief "Saved" affordance after a successful write, cleared on the next edit.
  useEffect(() => {
    if (!savedTick) return;
    const t = setTimeout(() => setSavedTick(false), 1800);
    return () => clearTimeout(t);
  }, [savedTick]);

  const fileName = path.split("/").filter(Boolean).pop() ?? path;

  const cmExtensions = useMemo(() => {
    if (!bundle) return [] as unknown[];
    const exts: unknown[] = [bundle.saveKeymapExtension(() => saveRef.current())];
    if (bundle.languageExtension) exts.push(bundle.languageExtension);
    return exts;
  }, [bundle]);

  if (failed) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        {fallback ?? (
          <PlainTextarea
            value={value}
            readOnly={readOnly}
            onChange={(next) => {
              setValue(next);
              setSavedTick(false);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-opengeni-code-editor
      style={editorVars}
    >
      {/* Save bar: dirty indicator + status + the explicit Save button. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-surface-1,var(--color-surface,#161616))] px-2 py-1">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors",
            readOnly
              ? "bg-transparent"
              : dirty
                ? "bg-[color:var(--og-color-status-running,var(--color-warning,#d29922))]"
                : "bg-[color:var(--og-color-status-idle,var(--color-success,#3fb950))]",
          )}
          title={readOnly ? "read-only" : dirty ? "unsaved changes" : "saved"}
        />
        <span className="truncate font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[11px] text-[color:var(--og-color-fg-muted,var(--color-fg-muted,#aaa))]">
          {fileName}
          {dirty && !readOnly ? " •" : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {saveError && (
            <span
              className="max-w-[220px] truncate text-[10px] text-[color:var(--og-color-danger,var(--color-danger,#f85149))]"
              title={saveError.message}
            >
              {saveError.message}
            </span>
          )}
          {!saveError && savedTick && (
            <span className="text-[10px] text-[color:var(--og-color-status-idle,var(--color-success,#3fb950))]">
              Saved
            </span>
          )}
          {readOnly ? (
            <span className="text-[10px] uppercase tracking-wide text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
              Read-only
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              className={cn(
                "flex items-center gap-1 rounded-[var(--og-radius-sm,4px)] border border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] px-1.5 py-0.5 text-[10px]",
                saving || !dirty
                  ? "cursor-default text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))] opacity-60"
                  : "text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))] hover:bg-[color:var(--og-color-accent-soft,var(--color-surface-2,#222))]",
              )}
              title="Save (⌘/Ctrl+S)"
            >
              {saving ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <SaveIcon className="size-3" />
              )}
              Save
            </button>
          )}
        </div>
      </div>

      {/* The editor surface. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Suspense fallback={loading ?? <EditorSkeleton />}>
          <LazyCodeMirror
            value={value}
            theme={themeType === "light" ? "light" : "dark"}
            editable={!readOnly}
            readOnly={readOnly}
            basicSetup={true}
            extensions={cmExtensions}
            height="100%"
            className="og-cm-editor min-h-full text-[12.5px]"
            onChange={
              readOnly
                ? undefined
                : (next: string) => {
                    setValue(next);
                    setSavedTick(false);
                  }
            }
          />
        </Suspense>
      </div>
    </div>
  );
}

/** og-* themed CSS-var overrides handed to CodeMirror's container. */
const editorVars = {
  "--og-cm-bg": "var(--og-color-bg, #0d0d0d)",
  fontFamily: "var(--og-font-mono, var(--font-mono, monospace))",
} as CSSProperties;

function PlainTextarea({
  value,
  readOnly,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className="h-full w-full resize-none bg-transparent p-2 font-[family-name:var(--og-font-mono,var(--font-mono,monospace))] text-[12px] leading-[18px] text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))] outline-none"
    />
  );
}

function EditorSkeleton() {
  return (
    <div className="p-3 text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
      Loading editor…
    </div>
  );
}
