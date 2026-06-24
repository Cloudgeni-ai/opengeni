import type { GitFileDiff } from "@opengeni/sdk";
import {
  CameraIcon,
  CameraOffIcon,
  FileDiffIcon,
  GlobeIcon,
  ImageIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LockIcon,
  MousePointer2Icon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { stringifyPayload } from "../lib/format";
import {
  applyPatchOps,
  controlCaret,
  execTruncated,
  isExecSessionLostBanner,
  looksBinary,
  parseExecBannerSessionId,
  parseToolArgs,
  redactSecrets,
  sandboxCommandExitCode,
  stripExecBanner,
  tailPeek,
  unwrapMcpOutput,
  v4aToGitFileDiff,
  type ApplyPatchOperation,
} from "./parsers";
import { createToolRegistry, type ToolRegistry, type ToolRegistryEntry, type ToolRendererProps } from "./registry";
import {
  BodyNote,
  MediaEmpty,
  MediaSkeleton,
  PayloadBlock,
  ScreenshotFigure,
  TermBlock,
  Thumbnail,
  ActivityDisclosure,
  type DisclosureChip,
} from "./shared";
import { RawPatch, ToolDiff } from "./tool-diff";
import { toolDisplayName } from "./projection";

/* ----------------------------------------------------------------------------
   Per-tool renderers

   Each renderer takes one projected `ToolCallItem` and returns an `ActivityDisclosure`
   tuned for that tool's real wire shape. The defaults below populate the
   registry; the mapping is registered at the bottom of the file.

   Restraint is the rule: compact title + one quiet preview, secondary detail
   only on expand. No loud right-side badges — at most a single settle chip.
   -------------------------------------------------------------------------- */

const ICON_SIZE = "size-3.5";

/**
 * The single in-flight locus for a running row: a pulse dot immediately left of
 * the status word, riding the preview line — NOT a detached gutter badge. The
 * title already shimmers; this keeps the live signal in one place the eye reads
 * left-to-right.
 */
function RunningPreview({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 shrink-0 animate-og-pulse rounded-full bg-og-status-running" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/* ---- exec_command ---------------------------------------------------------- */

function ExecRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const cmd = typeof args.cmd === "string" ? args.cmd : "";
  const workdir = typeof args.workdir === "string" ? args.workdir : null;
  const running = item.status === "running";
  const out = item.output;
  const title = `$ ${cmd}`;

  // Orphaned output: the turn failed on the output insert (NUL byte) — no output
  // event ever arrived. Surface the loss instead of a blank row.
  if (item.status === "failed" && (out == null || out === "")) {
    return (
      <ActivityDisclosure
        icon={<TerminalIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={title}
        titleMono
        chip={{ tone: "bad", text: "failed" }}
        preview="output lost — NUL byte could not be stored"
      >
        <BodyNote tone="error">
          output contained a NUL byte and could not be stored; the turn failed on this tool&apos;s output insert — no output
          event ever arrived.
        </BodyNote>
      </ActivityDisclosure>
    );
  }

  if (running) {
    const streamed = typeof out === "string" ? stripExecBanner(out) : "";
    return (
      <ActivityDisclosure
        icon={<TerminalIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        titleMono
        running
        preview={<RunningPreview>{streamed ? `${streamed.split("\n").length} lines` : "running…"}</RunningPreview>}
      >
        {/* The row title is already `$ ${cmd}`; the TermBlock header drops the
            command (command={null}) so it never repeats above the output. */}
        <TermBlock command={null} workdir={workdir} output={streamed} live />
      </ActivityDisclosure>
    );
  }

  const text = typeof out === "string" ? out : stringifyPayload(out);
  const stripped = stripExecBanner(text);
  const bgSession = parseExecBannerSessionId(text);
  const exitCode = sandboxCommandExitCode(text);
  const binary = looksBinary(stripped);

  // Color is spent on the exception only: a clean exit (0) earns NO chip — the
  // absence of a red token is the success signal. Background sessions surface a
  // muted id; a non-zero exit is the one red token.
  let chip: DisclosureChip | undefined;
  let iconTone: "accent" | "failed" | "muted" = "muted";
  if (bgSession != null) {
    chip = { tone: "muted", text: `session ${bgSession}` };
  } else if (exitCode != null && exitCode !== 0) {
    chip = { tone: "bad", text: `exit ${exitCode}` };
    iconTone = "failed";
  }

  const preview = binary ? "binary output" : tailPeek(stripped) || "(no output)";
  const truncated = execTruncated(text);
  // Hand TermBlock the FULL stripped output; it owns the tail/show-more slicing.
  const body = binary ? "(binary output suppressed)" : stripped;

  return (
    <ActivityDisclosure
      icon={<TerminalIcon className={ICON_SIZE} />}
      iconTone={iconTone}
      title={title}
      titleMono
      {...(chip ? { chip } : {})}
      preview={truncated ? `⋯ truncated · ${preview}` : preview}
    >
      <TermBlock command={null} workdir={workdir} output={body} />
      {bgSession != null ? (
        <BodyNote>↳ session {bgSession} — a later write_stdin can target this PTY.</BodyNote>
      ) : null}
    </ActivityDisclosure>
  );
}

/* ---- write_stdin ----------------------------------------------------------- */

function WriteStdinRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const sessionId = args.session_id;
  const text = typeof item.output === "string" ? item.output : stringifyPayload(item.output);
  const lost = isExecSessionLostBanner(text);
  const keys = controlCaret(typeof args.chars === "string" ? args.chars : "");
  const exitCode = sandboxCommandExitCode(text);
  const stripped = stripExecBanner(text);

  // Success (exit 0 or a quiet ack) earns no chip; only a lost PTY / non-zero
  // exit gets the one red token.
  let chip: DisclosureChip | undefined;
  if (lost) {
    chip = { tone: "bad", text: "lost" };
  } else if (exitCode != null && exitCode !== 0) {
    chip = { tone: "bad", text: `exit ${exitCode}` };
  }

  return (
    <ActivityDisclosure
      icon={<KeyboardIcon className={ICON_SIZE} />}
      iconTone={lost ? "failed" : "muted"}
      title={`session ${sessionId} ← ${keys || "∅"}`}
      titleMono
      {...(chip ? { chip } : {})}
      preview={lost ? `session ${sessionId} PTY vanished` : tailPeek(stripped) || "sent"}
    >
      {lost ? (
        <BodyNote tone="error">{stripped || text}</BodyNote>
      ) : (
        <TermBlock command={`write_stdin → session ${sessionId}`} output={stripped} />
      )}
    </ActivityDisclosure>
  );
}

/* ---- apply_patch ----------------------------------------------------------- */

function verbForOp(op: ApplyPatchOperation | undefined): string {
  if (!op) {
    return "Edited";
  }
  return op.type === "create_file" ? "Created" : op.type === "delete_file" ? "Deleted" : op.moveTo ? "Renamed" : "Edited";
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}

/**
 * The collapsed-row path preview. Diff magnitude is rendered as a SINGLE muted
 * "+N −M" glyph pair — the saturated add/del green/red is reserved exclusively
 * for the expanded DiffView gutter, so the one-line rail stays a calm, single
 * hue (the file path) with no competing colored numerics.
 */
function PathPreview({ path, add, del }: { path: string; add?: number | undefined; del?: number | undefined }) {
  return (
    <span className="inline-flex items-center gap-2 truncate font-og-mono">
      <span className="truncate">
        <span className="text-og-fg-subtle">{dirname(path)}</span>
        <span className="text-og-fg-muted">{basename(path)}</span>
      </span>
      {add != null || del != null ? (
        <span className="shrink-0 text-og-fg-subtle">
          {add != null ? `+${add}` : ""}
          {add != null && del != null ? " " : ""}
          {del != null ? `−${del}` : ""}
        </span>
      ) : null}
    </span>
  );
}

function ApplyPatchRenderer({ item }: ToolRendererProps) {
  const ops = applyPatchOps(item.raw);
  const failed = item.status === "failed";
  const firstOp = ops[0];

  if (failed) {
    return (
      <ActivityDisclosure
        icon={<FileDiffIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={firstOp ? `${verbForOp(firstOp)} ${basename(firstOp.path)}` : "apply_patch"}
        chip={{ tone: "bad", text: "failed" }}
        preview={typeof item.output === "string" ? item.output : "patch failed"}
      >
        <PayloadBlock label="Error" value={item.output} failed />
      </ActivityDisclosure>
    );
  }

  // multi-file edit — magnitude stays a single muted glyph; the per-file
  // green/red lives only inside the expanded DiffView gutter.
  if (ops.length > 1) {
    const files = ops.map((op) => safeParseOp(op)).filter((f): f is GitFileDiff => f !== null);
    const add = files.reduce((n, f) => n + f.additions, 0);
    const del = files.reduce((n, f) => n + f.deletions, 0);
    return (
      <ActivityDisclosure
        icon={<FileDiffIcon className={ICON_SIZE} />}
        iconTone="accent"
        title={`Edited ${ops.length} files`}
        preview={
          <span className="inline-flex items-center gap-2 font-og-mono">
            <span className="text-og-fg-muted">{ops.length} files</span>
            <span className="text-og-fg-subtle">
              +{add} −{del}
            </span>
          </span>
        }
      >
        {files.length ? <ToolDiff files={files} /> : <BodyNote>No structured diff available.</BodyNote>}
      </ActivityDisclosure>
    );
  }

  // single op
  if (!firstOp) {
    return <GenericRenderer item={item} />;
  }
  if (firstOp.type === "delete_file") {
    return (
      <ActivityDisclosure
        icon={<FileDiffIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={`Deleted ${basename(firstOp.path)}`}
        preview={<PathPreview path={firstOp.path} />}
      >
        <BodyNote>File deleted — no diff to show.</BodyNote>
      </ActivityDisclosure>
    );
  }

  const file = safeParseOp(firstOp);
  if (!file) {
    return (
      <ActivityDisclosure
        icon={<FileDiffIcon className={ICON_SIZE} />}
        iconTone="accent"
        title={`${verbForOp(firstOp)} ${basename(firstOp.path)}`}
        preview={
          <span className="inline-flex items-center gap-2 font-og-mono">
            <span className="text-og-fg-muted">{basename(firstOp.path)}</span>
            <span className="text-og-fg-subtle">malformed V4A</span>
          </span>
        }
      >
        <RawPatch diff={firstOp.diff ?? ""} />
      </ActivityDisclosure>
    );
  }

  // The collapsed row shows verb + basename (title) and a muted "+N −M"
  // (preview); on expand the preview is hidden and the DiffView header carries
  // the path + churn — so the filename/stat never appears twice at once.
  return (
    <ActivityDisclosure
      icon={<FileDiffIcon className={ICON_SIZE} />}
      iconTone="accent"
      title={`${verbForOp(firstOp)} ${basename(file.path)}`}
      preview={<PathPreview path={file.path} add={file.additions} del={file.deletions} />}
    >
      <ToolDiff files={[file]} />
    </ActivityDisclosure>
  );
}

function safeParseOp(op: ApplyPatchOperation): GitFileDiff | null {
  try {
    return v4aToGitFileDiff(op);
  } catch {
    return null;
  }
}

/* ---- computer_call --------------------------------------------------------- */

type ComputerAction = {
  type?: string;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  button?: string;
};

function computerVerb(action: ComputerAction | undefined): string {
  if (!action || !action.type) {
    return "Acted";
  }
  switch (action.type) {
    case "screenshot":
      return "Screenshot";
    case "click":
      return `Clicked (${action.x}, ${action.y})`;
    case "double_click":
      return `Double-clicked (${action.x}, ${action.y})`;
    case "move":
      return `Moved (${action.x}, ${action.y})`;
    case "scroll":
      return "Scrolled";
    case "type": {
      const t = action.text ?? "";
      return `Typed “${t.slice(0, 28)}${t.length > 28 ? "…" : ""}”`;
    }
    case "keypress":
      return `Pressed ${(action.keys ?? []).join("+")}`;
    case "drag":
      return "Dragged";
    case "wait":
      return "Waited";
    default:
      return action.type;
  }
}

function ComputerCallRenderer({ item }: ToolRendererProps) {
  const raw = (item.raw ?? {}) as {
    action?: ComputerAction;
    actions?: ComputerAction[];
    providerData?: { approvalStatus?: string };
  };
  const action = raw.action;
  const actions = raw.actions ?? (action ? [action] : []);
  const verb = computerVerb(action);
  const out = item.output;
  const running = item.status === "running";
  const rejected = raw.providerData?.approvalStatus === "rejected";
  const readOnly = typeof out === "string" && out.includes("read-only");
  const isImage = typeof out === "string" && out.startsWith("data:image");
  const empty = out === "" || out == null;
  const batched = actions.length > 1 ? actions.map((a) => computerVerb(a)).join(" · ") : null;
  // Fold the batched-action count into the title (one media affordance per row),
  // rather than a separate "+N more" mono label competing beside the thumbnail.
  const countSuffix = actions.length > 1 ? ` ·${actions.length}` : "";
  const isShot = action?.type === "screenshot";

  if (running) {
    return (
      <ActivityDisclosure
        icon={isShot ? <CameraIcon className={ICON_SIZE} /> : <MousePointer2Icon className={ICON_SIZE} />}
        iconTone="running"
        title={verb}
        running
        media={<MediaSkeleton />}
      >
        <BodyNote>capturing frame…</BodyNote>
      </ActivityDisclosure>
    );
  }

  if (readOnly) {
    return (
      <ActivityDisclosure
        icon={<MousePointer2Icon className={ICON_SIZE} />}
        iconTone="failed"
        title={verb}
        chip={{ tone: "bad", text: "read-only" }}
        preview="write actions disabled"
      >
        <BodyNote tone="error">computer-use is read-only — write actions are disabled.</BodyNote>
      </ActivityDisclosure>
    );
  }

  if (rejected) {
    return (
      <ActivityDisclosure
        icon={<LockIcon className={ICON_SIZE} />}
        iconTone="muted"
        title={verb}
        preview="approval rejected — this action did not run"
      >
        <BodyNote>approval rejected — this action did not run.</BodyNote>
      </ActivityDisclosure>
    );
  }

  if (isImage && typeof out === "string") {
    const caption = `computer_call · ${verb}${actions.length > 1 ? ` (+${actions.length - 1} more)` : ""}`;
    return (
      <ActivityDisclosure
        icon={isShot ? <CameraIcon className={ICON_SIZE} /> : <MousePointer2Icon className={ICON_SIZE} />}
        iconTone="accent"
        title={`${verb}${countSuffix}`}
        media={<Thumbnail src={out} caption={caption} />}
      >
        <ScreenshotFigure src={out} caption={caption} />
        {batched ? <BodyNote>batched: {batched}</BodyNote> : null}
      </ActivityDisclosure>
    );
  }

  if (empty) {
    return (
      <ActivityDisclosure
        icon={<CameraOffIcon className={ICON_SIZE} />}
        iconTone="muted"
        title={verb}
        media={<MediaEmpty />}
      >
        <BodyNote>(no image) — the session returned an empty screenshot.</BodyNote>
      </ActivityDisclosure>
    );
  }

  // a non-screenshot action whose output is not an image (click/keypress)
  return (
    <ActivityDisclosure
      icon={<MousePointer2Icon className={ICON_SIZE} />}
      iconTone="accent"
      title={verb}
      preview={batched ?? undefined}
      expandable={batched != null}
    >
      {batched ? <BodyNote>{batched}</BodyNote> : null}
    </ActivityDisclosure>
  );
}

/* ---- web_search ------------------------------------------------------------ */

type WebSearchResult = { title: string; domain: string; snippet: string };

function WebSearchRenderer({ item }: ToolRendererProps) {
  const raw = (item.raw ?? {}) as { providerData?: { action?: { query?: string; queries?: string[] } } };
  const action = raw.providerData?.action ?? {};
  const query = action.query ?? "(query unavailable)";
  const queries = action.queries ?? [];
  const variants = queries.length > 1 ? ` +${queries.length - 1} variants` : "";
  const running = item.status === "running";
  // web_search may surface a results array on the output when the host enriches it.
  const results = Array.isArray((item.output as { results?: unknown })?.results)
    ? ((item.output as { results: WebSearchResult[] }).results)
    : undefined;

  if (running) {
    return (
      <ActivityDisclosure
        icon={<SearchIcon className={ICON_SIZE} />}
        iconTone="running"
        title="Searching the web"
        running
        preview={<RunningPreview>{`${query}${variants}`}</RunningPreview>}
      >
        <BodyNote>searching… results fold into the model context (no output event).</BodyNote>
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<SearchIcon className={ICON_SIZE} />}
      iconTone="muted"
      title="Searched the web"
      preview={`${query}${variants}`}
    >
      {results && results.length ? (
        <ul className="flex flex-col gap-2">
          {results.map((result, index) => (
            <li key={index} className="flex gap-2.5">
              <GlobeIcon className="mt-0.5 size-3.5 shrink-0 text-og-fg-subtle" />
              <div className="min-w-0">
                <p className="truncate text-og-base text-og-fg">
                  {result.title} <span className="text-og-fg-subtle">{result.domain}</span>
                </p>
                <p className="text-og-sm leading-5 text-og-fg-muted">{result.snippet}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <BodyNote>results folded into model context — no list available.</BodyNote>
      )}
    </ActivityDisclosure>
  );
}

/* ---- view_image ------------------------------------------------------------ */

const VIEW_IMAGE_ERRORS = ["was not found", "is not a file", "exceeded the allowed size", "is not a supported image", "unable to read image"];

function ViewImageRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const path = typeof args.path === "string" ? args.path : "";
  const out = item.output;
  const text = typeof out === "string" ? out : "";

  const errMatch = VIEW_IMAGE_ERRORS.find((p) => text.includes(p));
  if (errMatch) {
    const tooBig = text.includes("exceeded the allowed size");
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={`View ${basename(path)}`}
        chip={{ tone: "bad", text: tooBig ? "too large" : "error" }}
        preview={text}
      >
        <BodyNote tone="error">{text}</BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.startsWith("OpenAI file reference:")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="muted"
        title={`Viewed ${basename(path)}`}
        preview={path}
      >
        <BodyNote>{text}</BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.includes("No image data")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="muted"
        title={`Viewed ${basename(path)}`}
        preview="(no image)"
      >
        <BodyNote>(no image) — the sandbox session returned no image data.</BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.startsWith("data:")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="accent"
        title={`Viewed ${basename(path)}`}
        media={<Thumbnail src={text} caption={path} alt={path} />}
      >
        <ScreenshotFigure src={text} caption={path} alt={path} />
      </ActivityDisclosure>
    );
  }
  return <GenericRenderer item={item} />;
}

/* ---- environment_set_variable (secret-safe, write-only) -------------------- */

function SecretSetRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const name = typeof args.name === "string" ? args.name : "variable";
  return (
    <ActivityDisclosure
      icon={<KeyRoundIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={`Set ${name}`}
      preview="value write-only · never returned"
    >
      <PayloadBlock label="Arguments" value={redactSecrets(args)} />
      <BodyNote>the value is a secret — redacted in every view; the API never returns it.</BodyNote>
    </ActivityDisclosure>
  );
}

/* ---- generic fallback (first-party MCP, external MCP, unknown) ------------- */

function GenericRenderer({ item }: ToolRendererProps) {
  const running = item.status === "running";
  const args = redactSecrets(parseToolArgs(item.arguments));
  const display = toolDisplayName(item.name);

  if (running) {
    return (
      <ActivityDisclosure
        icon={<PlugIcon className={ICON_SIZE} />}
        iconTone="running"
        title={display}
        running
        preview={<RunningPreview>{compactArgs(args) || "running…"}</RunningPreview>}
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if (isError || item.status === "failed") {
    return (
      <ActivityDisclosure
        icon={<WrenchIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={display}
        chip={{ tone: "bad", text: "error" }}
        preview={outText.slice(0, 80)}
      >
        <PayloadBlock label="Arguments" value={args} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<WrenchIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={display}
      preview={compactArgs(args)}
    >
      <PayloadBlock label="Arguments" value={args} />
      <PayloadBlock label="Result" value={outText} />
    </ActivityDisclosure>
  );
}

function compactArgs(args: unknown): string {
  const text = stringifyPayload(args).replace(/\s+/g, " ").trim();
  return text === "{}" ? "" : text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/* ---- the default registry -------------------------------------------------- */

const BASE_ENTRIES: ToolRegistryEntry[] = [
  // Provider-native items carry `raw.type` on the wire — this is their source of
  // truth and is consulted first by the registry.
  { match: "rawType", type: "apply_patch_call", render: ApplyPatchRenderer },
  { match: "rawType", type: "computer_call", render: ComputerCallRenderer },
  { match: "rawType", type: "hosted_tool_call", render: WebSearchRenderer },
  // First-party sandbox + MCP tools resolve by name. `apply_patch_call` /
  // `computer_call` are intentionally repeated by name as a fallback only for
  // first-party replays that omit `raw` (the rawType entries above win whenever
  // `raw.type` is present, which is the live-wire case).
  { match: "name", name: "exec_command", render: ExecRenderer },
  { match: "name", name: "write_stdin", render: WriteStdinRenderer },
  { match: "name", name: "apply_patch_call", render: ApplyPatchRenderer },
  { match: "name", name: "computer_call", render: ComputerCallRenderer },
  { match: "name", name: "web_search_call", render: WebSearchRenderer },
  { match: "name", name: "view_image", render: ViewImageRenderer },
  { match: "name", name: "environment_set_variable", render: SecretSetRenderer },
];

/** The built-in tool renderer registry: every first-party tool plus a fallback. */
export const defaultToolRegistry: ToolRegistry = createToolRegistry(BASE_ENTRIES, GenericRenderer);

/** Build a registry that extends the built-ins with consumer entries/fallback. */
export function createDefaultToolRegistry(
  options: Parameters<typeof createToolRegistry>[2] = {},
): ToolRegistry {
  return createToolRegistry(BASE_ENTRIES, GenericRenderer, options);
}
