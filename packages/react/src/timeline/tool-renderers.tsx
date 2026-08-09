import type { GitFileDiff, RetainedArtifactReference } from "@opengeni/sdk";
import { parseEditableArtifactPublicationReceipt } from "@opengeni/sdk/editable-artifact-publication";
import {
  ArrowRightIcon,
  BoxIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  CameraIcon,
  CameraOffIcon,
  FileDiffIcon,
  FilePenLineIcon,
  FileSearchIcon,
  FolderGitIcon,
  GlobeIcon,
  GalleryHorizontalEndIcon,
  ImageIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LockIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  MessageSquareIcon,
  MousePointer2Icon,
  PackageSearchIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  SearchIcon,
  ServerCogIcon,
  ServerIcon,
  Share2Icon,
  TargetIcon,
  Table2Icon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes, stringifyPayload, tryParseJson } from "../lib/format";
import { useTimelineComputeLabel } from "./compute-label";
import {
  applyPatchOpsFromToolItem,
  controlCaret,
  execTruncated,
  generatedImageReceipt,
  isExecSessionLostBanner,
  looksBinary,
  mediaPreviewFact,
  parseExecBannerSessionId,
  parseToolArgs,
  retainedScreenshotMetadata,
  sandboxCommandExitCode,
  stripExecBanner,
  tailPeek,
  unwrapMcpOutput,
  v4aToGitFileDiff,
  screenshotDataUrl,
  type ApplyPatchOperation,
} from "./parsers";
import {
  createToolRegistry,
  type ToolRegistry,
  type ToolRegistryEntry,
  type ToolRendererProps,
} from "./registry";
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
import { mcpToolLeaf, toolDisplayName } from "./tool-display-name";

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

/** Prefix a collapsed preview with the host-supplied active compute label. */
function withComputePreview(label: string | null, preview: string): string {
  if (!label) {
    return preview;
  }
  return `on ${label} · ${preview}`;
}

/* ---- exec_command ---------------------------------------------------------- */

function ExecRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const cmd = typeof args.cmd === "string" ? args.cmd : "";
  const workdir = typeof args.workdir === "string" ? args.workdir : null;
  const running = item.status === "running";
  const out = item.output;
  const title = `$ ${cmd}`;
  const computeLabel = useTimelineComputeLabel();

  // No output event ever arrived (item.output stays undefined from creation):
  // the turn failed before the output insert — most likely a NUL byte in the
  // command output prevented storage. Surface the specific explanation.
  // (Cancelled items bypass this: a cancellation is not a NUL-storage failure.)
  if (item.status === "failed" && out === undefined) {
    return (
      <ActivityDisclosure
        icon={<TerminalIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={title}
        titleMono
        chip={{ tone: "bad", text: "failed" }}
        preview={withComputePreview(computeLabel, "output lost — NUL byte could not be stored")}
      >
        <BodyNote tone="error">
          output contained a NUL byte and could not be stored; the turn failed on this tool&apos;s
          output insert — no output event ever arrived.
        </BodyNote>
      </ActivityDisclosure>
    );
  }

  // An output event arrived but the tool still failed (error:true / MCP isError)
  // and the output is empty — show a generic failure rather than claiming NUL.
  // (Cancelled items bypass this: a cancellation is not a tool-call failure.)
  if (item.status === "failed" && (out == null || out === "")) {
    return (
      <ActivityDisclosure
        icon={<TerminalIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={title}
        titleMono
        chip={{ tone: "bad", text: "failed" }}
        preview={withComputePreview(computeLabel, "tool call failed")}
      >
        <BodyNote tone="error">the tool call failed with no output.</BodyNote>
      </ActivityDisclosure>
    );
  }

  if (running) {
    const streamed = typeof out === "string" ? stripExecBanner(out) : "";
    const runningPreview = streamed ? `${streamed.split("\n").length} lines` : "running…";
    return (
      <ActivityDisclosure
        icon={<TerminalIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        titleMono
        running
        preview={
          <RunningPreview>{withComputePreview(computeLabel, runningPreview)}</RunningPreview>
        }
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

  const peek = binary ? "binary output" : tailPeek(stripped) || "(no output)";
  const truncated = execTruncated(text);
  const preview = withComputePreview(computeLabel, truncated ? `⋯ truncated · ${peek}` : peek);
  // Hand TermBlock the FULL stripped output; it owns the tail/show-more slicing.
  const body = binary ? "(binary output suppressed)" : stripped;

  return (
    <ActivityDisclosure
      icon={<TerminalIcon className={ICON_SIZE} />}
      iconTone={iconTone}
      title={title}
      titleMono
      {...(chip ? { chip } : {})}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
      preview={preview}
    >
      <TermBlock
        command={null}
        workdir={workdir}
        output={body}
        failed={item.status === "failed" || (exitCode != null && exitCode !== 0)}
      />
      {bgSession != null ? (
        <BodyNote>↳ session {bgSession} — a later write_stdin can target this PTY.</BodyNote>
      ) : null}
    </ActivityDisclosure>
  );
}

/* ---- write_stdin ----------------------------------------------------------- */

function WriteStdinRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const sessionId =
    typeof args.session_id === "string" || typeof args.session_id === "number"
      ? args.session_id
      : undefined;
  const running = item.status === "running";
  const text = typeof item.output === "string" ? item.output : stringifyPayload(item.output);
  const lost = isExecSessionLostBanner(text);
  const keys = controlCaret(typeof args.chars === "string" ? args.chars : "");
  const exitCode = sandboxCommandExitCode(text);
  const stripped = stripExecBanner(text);

  if (running) {
    return (
      <ActivityDisclosure
        icon={<KeyboardIcon className={ICON_SIZE} />}
        iconTone="running"
        title={`session ${sessionId} ← ${keys || "∅"}`}
        titleMono
        running
        preview={<RunningPreview>sending…</RunningPreview>}
      >
        <BodyNote>sending input to session {sessionId}…</BodyNote>
      </ActivityDisclosure>
    );
  }

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
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
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
  return op.type === "create_file"
    ? "Created"
    : op.type === "delete_file"
      ? "Deleted"
      : op.moveTo
        ? "Renamed"
        : "Edited";
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
function PathPreview({
  path,
  add,
  del,
}: {
  path: string;
  add?: number | undefined;
  del?: number | undefined;
}) {
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
  const ops = applyPatchOpsFromToolItem(item);
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const running = item.status === "running";
  const firstOp = ops[0];

  if (running) {
    // Show the patch structure from the arguments (available immediately on
    // creation), but mark the row clearly as in-progress — not applied yet.
    const fileCount = ops.length;
    const titleVerb = firstOp ? `Applying ${basename(firstOp.path)}` : "Applying patch";
    return (
      <ActivityDisclosure
        icon={<FileDiffIcon className={ICON_SIZE} />}
        iconTone="running"
        title={fileCount > 1 ? `Applying ${fileCount} files` : titleVerb}
        running
        preview={
          <RunningPreview>
            {fileCount > 1 ? `${fileCount} files` : firstOp ? firstOp.path : "applying…"}
          </RunningPreview>
        }
      >
        {ops.map((op, index) => {
          const file = safeParseOp(op);
          const key = `${op.type}:${op.path}:${index}`;
          return file ? (
            <ToolDiff key={key} files={[file]} />
          ) : (
            <div key={key}>
              <p className="mb-1 font-og-mono text-og-xs text-og-fg-muted">{op.path}</p>
              <RawPatch diff={op.diff ?? ""} />
            </div>
          );
        })}
      </ActivityDisclosure>
    );
  }

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
    // Parse every op: successfully parsed ones go into ToolDiff; malformed ops
    // fall back to a RawPatch display (mirroring the single-op fallback path).
    // The count in the title/preview equals ops.length so it is always truthful
    // regardless of how many ops parsed successfully.
    const parsed = ops.map((op) => safeParseOp(op));
    const goodFiles = parsed.filter((f): f is GitFileDiff => f !== null);
    const add = goodFiles.reduce((n, f) => n + f.additions, 0);
    const del = goodFiles.reduce((n, f) => n + f.deletions, 0);
    return (
      <ActivityDisclosure
        icon={<FileDiffIcon className={ICON_SIZE} />}
        iconTone="accent"
        title={`Edited ${ops.length} files`}
        cancelled={cancelled}
        preview={
          <span className="inline-flex items-center gap-2 font-og-mono">
            <span className="text-og-fg-muted">{ops.length} files</span>
            <span className="text-og-fg-subtle">
              +{add} −{del}
            </span>
          </span>
        }
      >
        {ops.map((op, index) => {
          const file = parsed[index];
          const key = `${op.type}:${op.path}:${index}`;
          return file ? (
            <ToolDiff key={key} files={[file]} />
          ) : (
            <div key={key}>
              <p className="mb-1 font-og-mono text-og-xs text-og-fg-muted">{op.path}</p>
              <RawPatch diff={op.diff ?? ""} />
            </div>
          );
        })}
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
        cancelled={cancelled}
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
        cancelled={cancelled}
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
      cancelled={cancelled}
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

/** Coerce a function-tool arguments payload into the ComputerAction fields. */
function asComputerArgs(args: unknown): Partial<ComputerAction> {
  if (!args) {
    return {};
  }
  const parsed = typeof args === "string" ? tryParseJson(args) : args;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.x === "number" ? { x: record.x } : {}),
    ...(typeof record.y === "number" ? { y: record.y } : {}),
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(Array.isArray(record.keys) ? { keys: record.keys as string[] } : {}),
    ...(typeof record.button === "string" ? { button: record.button } : {}),
  };
}

function ComputerCallRenderer({ item, loadRetainedScreenshot }: ToolRendererProps) {
  const raw = (item.raw ?? {}) as {
    action?: ComputerAction;
    actions?: ComputerAction[];
    providerData?: { approvalStatus?: string };
  };
  // Function-mode computer tools (computer_screenshot / computer_click / …,
  // used on codex + chat-wire providers since the explicit tool-transport
  // change) carry the action in the tool NAME + arguments instead of raw.action.
  // Normalize them into the same ComputerAction shape so one renderer serves
  // every transport.
  const functionAction: ComputerAction | undefined =
    !raw.action && item.name.startsWith("computer_") && item.name !== "computer_call"
      ? { type: item.name.slice("computer_".length), ...asComputerArgs(item.arguments) }
      : undefined;
  const action = raw.action ?? functionAction;
  const actions = raw.actions ?? (action ? [action] : []);
  const verb = computerVerb(action);
  const out = item.output;
  const running = item.status === "running";
  const rejected = raw.providerData?.approvalStatus === "rejected";
  const readOnly = typeof out === "string" && out.includes("read-only");
  const shotUrl = screenshotDataUrl(out);
  const retained = retainedScreenshotMetadata(out);
  const omittedMedia = mediaPreviewFact(out);
  const empty = out === "" || out == null;
  const batched = actions.length > 1 ? actions.map((a) => computerVerb(a)).join(" · ") : null;
  // Fold the batched-action count into the title (one media affordance per row),
  // rather than a separate "+N more" mono label competing beside the thumbnail.
  const countSuffix = actions.length > 1 ? ` ·${actions.length}` : "";
  const isShot = action?.type === "screenshot";

  if (running) {
    return (
      <ActivityDisclosure
        icon={
          isShot ? (
            <CameraIcon className={ICON_SIZE} />
          ) : (
            <MousePointer2Icon className={ICON_SIZE} />
          )
        }
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

  const isFailed = item.status === "failed";
  const isCancelled = item.status === "cancelled";

  if (retained) {
    if (!retained.available) {
      const state =
        retained.reason === "expired" || retained.reason === "deleted"
          ? retained.reason
          : "unavailable";
      return (
        <ActivityDisclosure
          icon={<CameraOffIcon className={ICON_SIZE} />}
          iconTone={isFailed ? "failed" : "muted"}
          title={`${verb}${countSuffix} · ${state}`}
          failed={isFailed}
          cancelled={isCancelled}
          preview={`screenshot ${state}`}
          media={<MediaEmpty />}
        >
          <BodyNote tone={isFailed ? "error" : undefined}>
            Screenshot {state}: {retained.reason.replaceAll("_", " ")}.
          </BodyNote>
        </ActivityDisclosure>
      );
    }
    return (
      <RetainedSessionImageDisclosure
        artifact={retained}
        load={loadRetainedScreenshot}
        title={`${verb}${countSuffix}`}
        caption={`${verb}${countSuffix}`}
        noun="screenshot"
        icon={<CameraIcon className={ICON_SIZE} />}
        lightboxLabel="Screenshot"
        batched={batched}
        failed={isFailed}
        cancelled={isCancelled}
      />
    );
  }

  if (shotUrl) {
    const caption = `${verb}${actions.length > 1 ? ` (+${actions.length - 1} more)` : ""}`;
    return (
      <ActivityDisclosure
        icon={
          isShot ? (
            <CameraIcon className={ICON_SIZE} />
          ) : (
            <MousePointer2Icon className={ICON_SIZE} />
          )
        }
        iconTone={isFailed ? "failed" : "accent"}
        title={`${verb}${countSuffix}`}
        failed={isFailed}
        cancelled={isCancelled}
        media={<Thumbnail src={shotUrl} caption={caption} />}
      >
        <ScreenshotFigure src={shotUrl} caption={caption} />
        {batched ? <BodyNote>batched: {batched}</BodyNote> : null}
      </ActivityDisclosure>
    );
  }

  if (omittedMedia) {
    return (
      <ActivityDisclosure
        icon={<CameraOffIcon className={ICON_SIZE} />}
        iconTone={isFailed ? "failed" : "muted"}
        title={`${verb}${countSuffix} · image omitted · not retained`}
        failed={isFailed}
        cancelled={isCancelled}
        preview="inline image omitted · not retained"
        media={<MediaEmpty />}
      >
        <BodyNote>
          The inline {omittedMedia.mediaType} output was omitted from the audit timeline and its
          source bytes were not retained.
        </BodyNote>
        {batched ? <BodyNote>batched: {batched}</BodyNote> : null}
      </ActivityDisclosure>
    );
  }

  if (empty) {
    return (
      <ActivityDisclosure
        icon={<CameraOffIcon className={ICON_SIZE} />}
        iconTone={isFailed ? "failed" : "muted"}
        title={verb}
        failed={isFailed}
        cancelled={isCancelled}
        media={<MediaEmpty />}
      >
        <BodyNote>
          {isFailed
            ? "computer_call failed — no image returned."
            : isCancelled
              ? "computer_call interrupted — no image returned."
              : "(no image) — the session returned an empty screenshot."}
        </BodyNote>
      </ActivityDisclosure>
    );
  }

  // a non-screenshot action whose output is not an image (click/keypress)
  return (
    <ActivityDisclosure
      icon={<MousePointer2Icon className={ICON_SIZE} />}
      iconTone={isFailed ? "failed" : "accent"}
      title={verb}
      failed={isFailed}
      cancelled={isCancelled}
      preview={batched ?? undefined}
      expandable={batched != null}
    >
      {batched ? <BodyNote>{batched}</BodyNote> : null}
    </ActivityDisclosure>
  );
}

type RetainedImageState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "unavailable"; label: string }
  | { kind: "error"; message: string };

function useRetainedImageObjectUrl(
  artifact: RetainedArtifactReference,
  load: ToolRendererProps["loadRetainedArtifact"],
): RetainedImageState {
  const [state, setState] = useState<RetainedImageState>({ kind: "loading" });
  // Function outputs are commonly serialized JSON. Parsing them creates a new
  // object on every render, so depend on the immutable wire value rather than
  // object identity; otherwise the loader can refetch after its own setState.
  const artifactValue = retainedArtifactValue(artifact);
  const stableArtifactRef = useRef({ value: artifactValue, artifact });
  if (stableArtifactRef.current.value !== artifactValue) {
    stableArtifactRef.current = { value: artifactValue, artifact };
  }
  const stableArtifact = stableArtifactRef.current.artifact;
  useEffect(() => {
    if (!load) {
      setState({ kind: "unavailable", label: "retrieval is not configured" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void load(stableArtifact, controller.signal)
      .then((source) => {
        if (controller.signal.aborted) return;
        if (!source) {
          setState({ kind: "unavailable", label: "bytes are unavailable" });
          return;
        }
        if (!(source instanceof Uint8Array)) {
          if (!source.url.trim()) {
            setState({ kind: "unavailable", label: "URL is unavailable" });
            return;
          }
          setState({ kind: "ready", url: source.url });
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([source as unknown as BlobPart], { type: stableArtifact.contentType }),
        );
        setState({ kind: "ready", url: objectUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status =
          error && typeof error === "object" && "status" in error
            ? Number((error as { status?: unknown }).status)
            : null;
        setState(
          status === 404
            ? { kind: "unavailable", label: "deleted" }
            : status === 410
              ? { kind: "unavailable", label: "expired or unavailable" }
              : { kind: "error", message: "retrieval failed" },
        );
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [stableArtifact, load]);
  return state;
}

function retainedArtifactValue(artifact: RetainedArtifactReference): string {
  return [
    artifact.artifactId,
    artifact.kind,
    artifact.contentType,
    artifact.originalBytes,
    artifact.sha256,
    artifact.retainedAt,
    artifact.dimensions?.width ?? "",
    artifact.dimensions?.height ?? "",
    artifact.retention.policy,
    artifact.retention.expiresAt ?? "",
    artifact.retrieval.method,
    artifact.retrieval.path,
    artifact.retrieval.acceptRanges,
    artifact.retrieval.maxRangeBytes,
  ].join("\0");
}

function RetainedSessionImageDisclosure({
  artifact,
  load,
  title,
  caption,
  noun,
  icon,
  lightboxLabel,
  batched,
  failed,
  cancelled,
}: {
  artifact: RetainedArtifactReference;
  load: ToolRendererProps["loadRetainedScreenshot"];
  title: string;
  caption: string;
  noun: "image" | "screenshot";
  icon: ReactNode;
  lightboxLabel: string;
  batched: string | null;
  failed: boolean;
  cancelled: boolean;
}) {
  const state = useRetainedImageObjectUrl(artifact, load);

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone={failed ? "failed" : state.kind === "ready" ? "accent" : "muted"}
      title={title}
      failed={failed}
      cancelled={cancelled}
      preview={
        state.kind === "loading"
          ? `loading retained ${noun}…`
          : state.kind === "error"
            ? `${noun} retrieval failed`
            : state.kind === "unavailable"
              ? `${noun} ${state.label}`
              : undefined
      }
      media={
        state.kind === "ready" ? (
          <Thumbnail
            src={state.url}
            caption={caption}
            alt={caption}
            expandLabel={`Expand ${noun}`}
            lightboxLabel={lightboxLabel}
          />
        ) : state.kind === "loading" ? (
          <MediaSkeleton />
        ) : (
          <MediaEmpty />
        )
      }
    >
      {state.kind === "ready" ? (
        <ScreenshotFigure
          src={state.url}
          caption={caption}
          alt={caption}
          expandLabel={`Expand ${noun}`}
          lightboxLabel={lightboxLabel}
        />
      ) : state.kind === "loading" ? (
        <BodyNote>Loading the retained {noun}…</BodyNote>
      ) : state.kind === "unavailable" ? (
        <BodyNote>
          {noun === "screenshot" ? "Screenshot" : "Image"} {state.label}.
        </BodyNote>
      ) : (
        <BodyNote tone="error">
          {noun === "screenshot" ? "Screenshot" : "Image"} retrieval failed: {state.message}
        </BodyNote>
      )}
      {batched ? <BodyNote>batched: {batched}</BodyNote> : null}
    </ActivityDisclosure>
  );
}

function GeneratedImageRenderer({ item, loadRetainedArtifact }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const raw =
    item.raw && typeof item.raw === "object" && !Array.isArray(item.raw)
      ? (item.raw as Record<string, unknown>)
      : null;
  // Function tools settle through agent.toolCall.output; OpenAI's hosted image
  // call is already complete on agent.toolCall.created and carries the compact
  // receipt in raw.output. Both paths deliberately converge on one renderer.
  const receipt = generatedImageReceipt(item.output) ?? generatedImageReceipt(raw?.output);
  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="running"
        title="Generating image"
        running
        preview={<RunningPreview>{truncatePreview(prompt, 72) || "creating…"}</RunningPreview>}
        media={<MediaSkeleton />}
      >
        {prompt ? <BodyNote>{prompt}</BodyNote> : null}
      </ActivityDisclosure>
    );
  }
  if (!receipt) return <GenericRenderer item={item} />;
  return (
    <GeneratedImageDisclosure
      receipt={receipt}
      load={loadRetainedArtifact}
      prompt={prompt}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
    />
  );
}

function EditableArtifactPublicationRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const requestedTitle = typeof args.title === "string" ? args.title : "artifact";
  const requestedModality =
    args.modality === "document" ||
    args.modality === "spreadsheet" ||
    args.modality === "presentation"
      ? args.modality
      : null;
  const noun = requestedModality ?? "artifact";
  const icon = editableArtifactIcon(requestedModality);
  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title={`Publishing editable ${noun}`}
        running
        preview={<RunningPreview>{truncatePreview(requestedTitle, 80)}</RunningPreview>}
      />
    );
  }
  const raw =
    item.raw && typeof item.raw === "object" && !Array.isArray(item.raw)
      ? (item.raw as Record<string, unknown>)
      : null;
  const receipt =
    parseEditableArtifactPublicationReceipt(item.output) ??
    parseEditableArtifactPublicationReceipt(raw?.output);
  if (!receipt) {
    if (item.status !== "failed" && item.status !== "cancelled") {
      return <GenericRenderer item={item} />;
    }
    return (
      <ActivityDisclosure
        icon={icon}
        title={`Publish editable ${noun}`}
        failed={item.status === "failed"}
        cancelled={item.status === "cancelled"}
        preview={truncatePreview(requestedTitle, 80)}
      >
        <PayloadBlock label="Arguments" value={args} />
        {item.output !== undefined ? <PayloadBlock label="Output" value={item.output} /> : null}
      </ActivityDisclosure>
    );
  }
  return (
    <ActivityDisclosure
      icon={editableArtifactIcon(receipt.artifact.modality)}
      iconTone="accent"
      title={`Published editable ${receipt.artifact.modality}`}
      preview={`${receipt.artifact.title} · ${receipt.sourceFile.filename}`}
    >
      <BodyNote>{receipt.artifact.title}</BodyNote>
      <a
        href={receipt.editorPath}
        className="group/memlink inline-flex min-h-9 items-center gap-1.5 rounded-og-md bg-og-accent px-3 py-1.5 text-og-sm font-medium text-og-accent-fg transition-colors hover:bg-og-accent-strong"
      >
        Open editor
        <ArrowRightIcon className="size-3.5 transition-transform group-hover/memlink:translate-x-0.5" />
      </a>
      <BodyNote>
        {receipt.sourceFile.filename} · {formatBytes(receipt.sourceFile.sizeBytes)}
      </BodyNote>
    </ActivityDisclosure>
  );
}

function editableArtifactIcon(
  modality: "document" | "spreadsheet" | "presentation" | null,
): ReactNode {
  if (modality === "document") return <FilePenLineIcon className={ICON_SIZE} />;
  if (modality === "spreadsheet") return <Table2Icon className={ICON_SIZE} />;
  if (modality === "presentation") return <GalleryHorizontalEndIcon className={ICON_SIZE} />;
  return <PanelsTopLeftIcon className={ICON_SIZE} />;
}

function GeneratedImageDisclosure({
  receipt,
  load,
  prompt,
  failed,
  cancelled,
}: {
  receipt: NonNullable<ReturnType<typeof generatedImageReceipt>>;
  load: ToolRendererProps["loadRetainedArtifact"];
  prompt: string;
  failed: boolean;
  cancelled: boolean;
}) {
  const state = useRetainedImageObjectUrl(receipt.artifact, load);
  const dimensions = receipt.artifact.dimensions!;
  const title = failed ? "Image generation failed" : "Generated image";
  const caption = prompt || `Generated image · ${dimensions.width}×${dimensions.height}`;
  return (
    <ActivityDisclosure
      icon={<ImageIcon className={ICON_SIZE} />}
      iconTone={failed ? "failed" : state.kind === "ready" ? "accent" : "muted"}
      title={title}
      defaultOpen={!failed && !cancelled}
      failed={failed}
      cancelled={cancelled}
      preview={
        state.kind === "loading"
          ? "loading image…"
          : state.kind === "error"
            ? "image retrieval failed"
            : state.kind === "unavailable"
              ? `image ${state.label}`
              : truncatePreview(prompt, 88) || `${dimensions.width}×${dimensions.height}`
      }
      media={
        state.kind === "ready" ? (
          <Thumbnail
            src={state.url}
            caption={caption}
            alt={caption}
            expandLabel="Expand generated image"
            lightboxLabel="Generated image"
          />
        ) : state.kind === "loading" ? (
          <MediaSkeleton />
        ) : (
          <MediaEmpty />
        )
      }
    >
      {state.kind === "ready" ? (
        <ScreenshotFigure
          src={state.url}
          caption={caption}
          alt={caption}
          expandLabel="Expand generated image"
          lightboxLabel="Generated image"
        />
      ) : state.kind === "loading" ? (
        <BodyNote>Loading the generated image…</BodyNote>
      ) : state.kind === "unavailable" ? (
        <BodyNote>Image {state.label}.</BodyNote>
      ) : (
        <BodyNote tone="error">Image retrieval failed.</BodyNote>
      )}
      <BodyNote>
        {dimensions.width}×{dimensions.height} · {receipt.sandboxPath}
      </BodyNote>
    </ActivityDisclosure>
  );
}

/* ---- web_search ------------------------------------------------------------ */

type WebSearchResult = { title: string; domain: string; snippet: string };

/** Pull a search string from tool-call arguments when providerData.action is sparse. */
function webSearchQueryFromArguments(args: unknown): string | null {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return webSearchQueryFromArguments(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (!args || typeof args !== "object") {
    return null;
  }
  const record = args as Record<string, unknown>;
  if (typeof record.query === "string" && record.query.trim().length > 0) {
    return record.query;
  }
  if (Array.isArray(record.queries)) {
    const first = record.queries.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (first) {
      return first;
    }
  }
  return null;
}

function WebSearchRenderer({ item }: ToolRendererProps) {
  const raw = (item.raw ?? {}) as {
    providerData?: {
      action?: {
        type?: string;
        query?: string;
        queries?: string[];
        url?: string;
        pattern?: string;
      };
    };
  };
  const action = raw.providerData?.action ?? {};
  const actionType = action.type ?? "search";
  // Responses API deprecated singular `query` in favor of `queries[]`.
  // Codex/current OpenAI often only populate the array.
  const queries = (action.queries ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const searchQuery =
    (typeof action.query === "string" && action.query.trim().length > 0 ? action.query : null) ??
    queries[0] ??
    webSearchQueryFromArguments(item.arguments);
  const running = item.status === "running";
  const query =
    actionType === "open_page"
      ? (action.url ?? "(page unavailable)")
      : actionType === "find_in_page"
        ? action.pattern && action.url
          ? `"${action.pattern}" in ${action.url}`
          : (action.pattern ?? action.url ?? "(page unavailable)")
        : // Codex often emits the live card before action.query/queries land;
          // don't flash the scary unavailable copy while still searching.
          (searchQuery ?? (running ? "…" : "(query unavailable)"));
  const variants = queries.length > 1 ? ` +${queries.length - 1} variants` : "";
  const runningTitle =
    actionType === "open_page"
      ? "Opening web page"
      : actionType === "find_in_page"
        ? "Searching within page"
        : "Searching the web";
  const completedTitle =
    actionType === "open_page"
      ? "Opened web page"
      : actionType === "find_in_page"
        ? "Searched within page"
        : "Searched the web";
  // web_search may surface a results array on the output when the host enriches it.
  // Filter out null/undefined/non-object entries before casting: host-provided
  // data is untrusted and a null element would throw on result.title access.
  const rawResults = (item.output as { results?: unknown } | undefined)?.results;
  const results = Array.isArray(rawResults)
    ? (rawResults as unknown[]).filter((r): r is WebSearchResult => !!r && typeof r === "object")
    : undefined;
  const resultOccurrences = new Map<string, number>();
  const keyedResults = results?.map((result) => {
    const contentKey = `${result.domain}\u0000${result.title}\u0000${result.snippet}`;
    const occurrence = (resultOccurrences.get(contentKey) ?? 0) + 1;
    resultOccurrences.set(contentKey, occurrence);
    return { key: `${contentKey}\u0000${occurrence}`, result };
  });

  if (running) {
    return (
      <ActivityDisclosure
        icon={<SearchIcon className={ICON_SIZE} />}
        iconTone="running"
        title={runningTitle}
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
      title={completedTitle}
      preview={`${query}${variants}`}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
    >
      {keyedResults && keyedResults.length ? (
        <ul className="flex flex-col gap-2">
          {keyedResults.map(({ key, result }) => (
            <li key={key} className="flex gap-2.5">
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

const VIEW_IMAGE_ERRORS = [
  "was not found",
  "is not a file",
  "exceeded the allowed size",
  "is not a supported image",
  "unable to read image",
];

function ViewImageRenderer({ item, loadRetainedScreenshot }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const path = typeof args.path === "string" ? args.path : "";
  const out = item.output;
  const text = typeof out === "string" ? out : "";
  const retained = retainedScreenshotMetadata(out);
  const omittedMedia = mediaPreviewFact(out);

  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="running"
        title={`View ${basename(path)}`}
        running
        preview={<RunningPreview>reading…</RunningPreview>}
        media={<MediaSkeleton />}
      >
        <BodyNote>reading image…</BodyNote>
      </ActivityDisclosure>
    );
  }

  const viewFailed = item.status === "failed";
  const viewCancelled = item.status === "cancelled";

  if (retained) {
    const title = `Viewed ${basename(path)}`;
    if (!retained.available) {
      const state =
        retained.reason === "expired" || retained.reason === "deleted"
          ? retained.reason
          : "unavailable";
      return (
        <ActivityDisclosure
          icon={<ImageIcon className={ICON_SIZE} />}
          iconTone={viewFailed ? "failed" : "muted"}
          title={`${title} · ${state}`}
          failed={viewFailed}
          cancelled={viewCancelled}
          preview={`image ${state}`}
          media={<MediaEmpty />}
        >
          <BodyNote tone={viewFailed ? "error" : undefined}>
            Image {state}: {retained.reason.replaceAll("_", " ")}.
          </BodyNote>
        </ActivityDisclosure>
      );
    }
    return (
      <RetainedSessionImageDisclosure
        artifact={retained}
        load={loadRetainedScreenshot}
        title={title}
        caption={path || title}
        noun="image"
        icon={<ImageIcon className={ICON_SIZE} />}
        lightboxLabel="Image"
        batched={null}
        failed={viewFailed}
        cancelled={viewCancelled}
      />
    );
  }

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
        iconTone={viewFailed ? "failed" : "muted"}
        title={`Viewed ${basename(path)}`}
        failed={viewFailed}
        cancelled={viewCancelled}
        preview={path}
      >
        <BodyNote>{text}</BodyNote>
      </ActivityDisclosure>
    );
  }
  if (omittedMedia) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone={viewFailed ? "failed" : "muted"}
        title={`Viewed ${basename(path)} · image omitted · not retained`}
        failed={viewFailed}
        cancelled={viewCancelled}
        preview="inline image omitted · not retained"
        media={<MediaEmpty />}
      >
        <BodyNote>
          The inline {omittedMedia.mediaType} output was omitted from the audit timeline and its
          source bytes were not retained.
        </BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.includes("No image data")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone={viewFailed ? "failed" : "muted"}
        title={`Viewed ${basename(path)}`}
        failed={viewFailed}
        cancelled={viewCancelled}
        preview="(no image)"
      >
        <BodyNote>
          {viewFailed
            ? "view_image failed — no image data returned."
            : viewCancelled
              ? "view_image interrupted."
              : "(no image) — the sandbox session returned no image data."}
        </BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.startsWith("data:")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone={viewFailed ? "failed" : "accent"}
        title={`Viewed ${basename(path)}`}
        failed={viewFailed}
        cancelled={viewCancelled}
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

  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<KeyRoundIcon className={ICON_SIZE} />}
        iconTone="running"
        title={`Set ${name}`}
        running
        preview={<RunningPreview>setting…</RunningPreview>}
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  if (item.status === "failed") {
    const errorText = typeof item.output === "string" ? item.output : null;
    return (
      <ActivityDisclosure
        icon={<KeyRoundIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={`Set ${name}`}
        failed
        preview={errorText ?? "variable write failed"}
      >
        <PayloadBlock label="Arguments" value={args} />
        {errorText ? (
          <PayloadBlock label="Error" value={errorText} failed />
        ) : (
          <BodyNote tone="error">the tool call failed with no output.</BodyNote>
        )}
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<KeyRoundIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={`Set ${name}`}
      cancelled={item.status === "cancelled"}
      preview="exact value preserved"
    >
      <PayloadBlock label="Arguments" value={args} />
      <BodyNote>
        The configured value is preserved exactly and available through authorized secret reads.
      </BodyNote>
    </ActivityDisclosure>
  );
}

/* ---- tool_search (progressive MCP disclosure) ------------------------------ */

type DisclosedTool = {
  /** Full wire name (`server__leaf` or bare). */
  name: string;
  /** Server / namespace prefix before `__`, when present. */
  source: string | null;
  /** Leaf tool name after `__`. */
  leaf: string;
};

function splitToolWireName(name: string): DisclosedTool {
  const boundary = name.indexOf("__");
  if (boundary <= 0) {
    return { name, source: null, leaf: name };
  }
  return {
    name,
    source: name.slice(0, boundary),
    leaf: name.slice(boundary + 2),
  };
}

/** Capability query from live tool_search args (object or JSON string). */
function toolSearchQuery(item: ToolRendererProps["item"]): string {
  const fromArgs = parseToolArgs(item.arguments);
  if (typeof fromArgs.query === "string" && fromArgs.query.trim()) {
    return fromArgs.query.trim();
  }
  const raw = item.raw;
  if (raw && typeof raw === "object") {
    const rawArgs = (raw as { arguments?: unknown }).arguments;
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      const parsed = tryParseJson(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const query = (parsed as { query?: unknown }).query;
        if (typeof query === "string" && query.trim()) {
          return query.trim();
        }
      }
    } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      const query = (rawArgs as { query?: unknown }).query;
      if (typeof query === "string" && query.trim()) {
        return query.trim();
      }
    }
  }
  return "";
}

/**
 * Parse disclosed tools from the runtime event shape.
 * `normalizeSdkEvent` collapses `tool_search_output.tools[]` into text:
 *   "Disclosed tools: a, b" | "No matching tools found."
 * Also accept a structured `tools` array when a host/enricher preserves it.
 */
function parseDisclosedTools(output: unknown): DisclosedTool[] | null {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const tools = (output as { tools?: unknown }).tools;
    if (Array.isArray(tools)) {
      return tools
        .map((tool) => {
          if (typeof tool === "string" && tool.trim()) {
            return splitToolWireName(tool.trim());
          }
          if (
            tool &&
            typeof tool === "object" &&
            typeof (tool as { name?: unknown }).name === "string"
          ) {
            const name = (tool as { name: string }).name.trim();
            return name ? splitToolWireName(name) : null;
          }
          return null;
        })
        .filter((tool): tool is DisclosedTool => tool != null);
    }
  }

  const { text } = unwrapMcpOutput(output);
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (/^no matching tools found\.?$/i.test(trimmed)) {
    return [];
  }
  const disclosed = trimmed.match(/^disclosed tools:\s*(.+)$/i);
  if (disclosed?.[1]) {
    return disclosed[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(splitToolWireName);
  }
  const parsed = tryParseJson(trimmed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parseDisclosedTools(parsed);
  }
  return null;
}

function toolSearchPreview(tools: DisclosedTool[] | null, cancelled: boolean): string | undefined {
  if (cancelled) {
    return undefined;
  }
  if (!tools) {
    return "Done";
  }
  if (tools.length === 0) {
    return "No matches";
  }
  if (tools.length === 1) {
    return tools[0]!.leaf;
  }
  const head = tools[0]!.leaf;
  return `${tools.length} tools · ${truncatePreview(head, 28)}`;
}

function ToolSearchRenderer({ item }: ToolRendererProps) {
  const query = toolSearchQuery(item);
  const icon = <PackageSearchIcon className={ICON_SIZE} />;
  const running = item.status === "running";
  const queryPreview = query ? truncatePreview(query, 64) : "";

  if (running) {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title="Looking up tools"
        running
        preview={
          queryPreview ? (
            <RunningPreview>{queryPreview}</RunningPreview>
          ) : (
            <RunningPreview>Matching capabilities…</RunningPreview>
          )
        }
      >
        {query ? <BodyNote>capability query: {query}</BodyNote> : null}
        <PayloadBlock label="Arguments" value={parseToolArgs(item.arguments)} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="failed"
        title="Tool lookup failed"
        failed
        preview={truncatePreview(outText, 80) || queryPreview || "Lookup failed"}
      >
        {query ? <BodyNote>capability query: {query}</BodyNote> : null}
        <PayloadBlock label="Arguments" value={parseToolArgs(item.arguments)} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  const tools = parseDisclosedTools(item.output);
  const preview = toolSearchPreview(tools, item.status === "cancelled");

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone="muted"
      title="Looked up tools"
      cancelled={item.status === "cancelled"}
      preview={preview}
    >
      {query ? <BodyNote>capability query: {query}</BodyNote> : null}
      {tools && tools.length > 0 ? (
        <ul className="grid gap-1.5">
          {tools.slice(0, 12).map((tool) => (
            <li key={tool.name} className="flex min-w-0 items-baseline gap-2">
              {tool.source ? (
                <span className="shrink-0 text-og-xs text-og-fg-subtle">{tool.source}</span>
              ) : null}
              <span className="truncate font-mono text-og-sm text-og-fg">{tool.leaf}</span>
            </li>
          ))}
          {tools.length > 12 ? (
            <li className="text-og-xs text-og-fg-muted">+{tools.length - 12} more</li>
          ) : null}
        </ul>
      ) : tools && tools.length === 0 ? (
        <BodyNote>no deferred tools matched this capability query.</BodyNote>
      ) : null}
      <PayloadBlock label="Arguments" value={parseToolArgs(item.arguments)} />
      {tools == null && outText ? <PayloadBlock label="Result" value={outText} /> : null}
    </ActivityDisclosure>
  );
}

/* ---- docs / knowledge search ----------------------------------------------- */

function DocsSearchRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const title = query ? `Search “${truncatePreview(query, 48)}”` : toolDisplayName(item.name);
  const running = item.status === "running";

  if (running) {
    return (
      <ActivityDisclosure
        icon={<FileSearchIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        running
        preview={<RunningPreview>Searching…</RunningPreview>}
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={<FileSearchIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={title}
        failed
        preview={truncatePreview(outText, 80) || "Search failed"}
      >
        <PayloadBlock label="Arguments" value={args} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  const hits = parseSearchHits(outText);
  const preview =
    item.status === "cancelled"
      ? undefined
      : hits
        ? hits.length === 0
          ? "No hits"
          : `${hits.length} hit${hits.length === 1 ? "" : "s"}`
        : "Done";

  return (
    <ActivityDisclosure
      icon={<FileSearchIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={title}
      cancelled={item.status === "cancelled"}
      preview={preview}
    >
      {hits && hits.length > 0 ? (
        <ul className="grid gap-2">
          {hits.slice(0, 8).map((hit) => (
            <li key={`${hit.title}\u0000${hit.snippet}`} className="min-w-0">
              <div className="truncate text-og-sm font-medium text-og-fg">{hit.title}</div>
              {hit.snippet ? (
                <div className="mt-0.5 line-clamp-2 text-og-xs text-og-fg-muted">{hit.snippet}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <PayloadBlock label="Arguments" value={args} />
      <PayloadBlock label="Result" value={outText} />
    </ActivityDisclosure>
  );
}

/* ---- set_session_title / set_other_session_title --------------------------- */

function SetSessionTitleRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const titleArg = typeof args.title === "string" ? args.title.trim() : "";
  const display = toolDisplayName(item.name);
  const previewTitle = titleArg ? truncatePreview(titleArg, 72) : "";
  const icon = <MessagesSquareIcon className={ICON_SIZE} />;

  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title={display}
        running
        preview={
          previewTitle ? (
            <RunningPreview>{previewTitle}</RunningPreview>
          ) : (
            <RunningPreview>Setting title…</RunningPreview>
          )
        }
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="failed"
        title={display}
        failed
        preview={truncatePreview(outText, 80) || "Rename failed"}
      >
        <PayloadBlock label="Arguments" value={args} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  // Prefer the submitted title; fall back to a title field in the tool result.
  let settledTitle = previewTitle;
  if (!settledTitle) {
    const parsed = tryParseJson(outText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fromResult = (parsed as { title?: unknown }).title;
      if (typeof fromResult === "string" && fromResult.trim()) {
        settledTitle = truncatePreview(fromResult.trim(), 72);
      }
    }
  }

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone="muted"
      title={display}
      cancelled={item.status === "cancelled"}
      preview={item.status === "cancelled" ? undefined : settledTitle || undefined}
    >
      <PayloadBlock label="Arguments" value={args} />
      {outText ? <PayloadBlock label="Result" value={outText} /> : null}
    </ActivityDisclosure>
  );
}

type SearchHit = { title: string; snippet: string };

function parseSearchHits(outText: string): SearchHit[] | null {
  const parsed = tryParseJson(outText);
  if (parsed == null) {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { hits?: unknown }).hits)
        ? (parsed as { hits: unknown[] }).hits
        : null;
  if (!list) {
    return null;
  }
  return list.map((row) => {
    const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const title =
      (typeof r.title === "string" && r.title) ||
      (typeof r.name === "string" && r.name) ||
      (typeof r.documentTitle === "string" && r.documentTitle) ||
      (typeof r.path === "string" && r.path) ||
      (typeof r.id === "string" && r.id) ||
      "Result";
    const snippet =
      (typeof r.snippet === "string" && r.snippet) ||
      (typeof r.text === "string" && r.text) ||
      (typeof r.content === "string" && r.content) ||
      "";
    return { title, snippet: truncatePreview(snippet, 160) };
  });
}

/* ---- company memory propose (docs MCP) ------------------------------------- */

function MemoryProposeRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const title = "Propose memory";
  const running = item.status === "running";

  if (running) {
    return (
      <ActivityDisclosure
        icon={<BrainCircuitIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        running
        preview={<RunningPreview>Proposing…</RunningPreview>}
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={<BrainCircuitIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={title}
        failed
        preview={truncatePreview(outText, 80) || "Propose failed"}
      >
        {text ? <BodyNote>{text}</BodyNote> : null}
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<BrainCircuitIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={title}
      cancelled={item.status === "cancelled"}
      preview={text ? truncatePreview(text, 90) : "Done"}
    >
      {text ? <BodyNote>{text}</BodyNote> : null}
      <PayloadBlock label="Result" value={outText} />
    </ActivityDisclosure>
  );
}

/* ---- request_human_input --------------------------------------------------- */

function askToolPreview(args: unknown): string | null {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const questions = Array.isArray(record?.questions) ? record.questions : null;
  if (!questions || questions.length === 0) {
    return null;
  }
  const first = questions[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  const q = first as Record<string, unknown>;
  const text =
    typeof q.label === "string" && q.label.trim()
      ? q.label.trim()
      : typeof q.prompt === "string" && q.prompt.trim()
        ? q.prompt.trim()
        : null;
  if (!text) {
    return null;
  }
  const preview = truncatePreview(text, 90);
  return questions.length > 1 ? `${preview} · ${questions.length} questions` : preview;
}

function AskRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const preview = askToolPreview(args);
  const icon = <MessageCircleQuestionIcon className={ICON_SIZE} />;
  const title = "Ask";

  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title={title}
        running
        preview={
          preview ? (
            <RunningPreview>{preview}</RunningPreview>
          ) : (
            <RunningPreview>Waiting…</RunningPreview>
          )
        }
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="failed"
        title={title}
        chip={{ tone: "bad", text: "error" }}
        preview={truncatePreview(outText, 80) || preview || "Error"}
      >
        <PayloadBlock label="Arguments" value={args} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone="muted"
      title={title}
      cancelled={item.status === "cancelled"}
      preview={item.status === "cancelled" ? undefined : (preview ?? undefined)}
    >
      <PayloadBlock label="Arguments" value={args} />
      {outText ? <PayloadBlock label="Result" value={outText} /> : null}
    </ActivityDisclosure>
  );
}

/* ---- run_on ---------------------------------------------------------------- */

function runOnTargetName(output: unknown): string | null {
  const { text } = unwrapMcpOutput(output);
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const name = (parsed as { targetName?: unknown }).targetName;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  return null;
}

function runOnOpPreview(args: Record<string, unknown>): string | null {
  const op = args.op;
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    return null;
  }
  const record = op as Record<string, unknown>;
  if (record.kind === "exec" && typeof record.cmd === "string" && record.cmd.trim()) {
    return `$ ${record.cmd.trim()}`;
  }
  if (
    (record.kind === "read" || record.kind === "write") &&
    typeof record.path === "string" &&
    record.path.trim()
  ) {
    return truncatePreview(record.path.trim(), 72);
  }
  return null;
}

function RunOnRenderer({ item }: ToolRendererProps) {
  const parsedArgs = parseToolArgs(item.arguments);
  const args = parsedArgs;
  const targetName = runOnTargetName(item.output);
  const title = targetName ? `Run on ${targetName}` : "Run on";
  const opPreview = runOnOpPreview(parsedArgs);
  const icon = <ServerIcon className={ICON_SIZE} />;

  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title={title}
        running
        preview={
          opPreview ? (
            <RunningPreview>{opPreview}</RunningPreview>
          ) : (
            <RunningPreview>Running…</RunningPreview>
          )
        }
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="failed"
        title={title}
        chip={{ tone: "bad", text: "error" }}
        preview={truncatePreview(outText, 80) || opPreview || "Error"}
      >
        <PayloadBlock label="Arguments" value={args} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone="muted"
      title={title}
      cancelled={item.status === "cancelled"}
      preview={item.status === "cancelled" ? undefined : (opPreview ?? undefined)}
    >
      <PayloadBlock label="Arguments" value={args} />
      {outText ? <PayloadBlock label="Result" value={outText} /> : null}
    </ActivityDisclosure>
  );
}

/* ---- generic fallback (first-party MCP, external MCP, unknown) ------------- */

/**
 * Baseline craft for unmatched tools: family icon + title-cased leaf + honest
 * status preview (Running… / Done / error snippet). No argument-field sniffing —
 * JSON stays in the expandable body only.
 */
function GenericRenderer({ item }: ToolRendererProps) {
  const running = item.status === "running";
  const args = parseToolArgs(item.arguments);
  const display = toolDisplayName(item.name);
  const icon = <GenericToolIcon name={item.name} />;
  // Goal tools: surface the objective text on the collapsed row so the in-cluster
  // tool replaces the old breakaway GoalRow pill without losing the gist.
  const goalPreview = goalToolPreview(item.name, args);

  if (running) {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title={display}
        running
        preview={goalPreview ?? <RunningPreview>Running…</RunningPreview>}
      >
        <PayloadBlock label="Arguments" value={args} />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  // Cancelled is NOT an error — a user-cancelled tool should not surface the red
  // error chip even if the output payload carries an isError flag (the error may be
  // a consequence of the cancellation, not the tool's own failure).
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="failed"
        title={display}
        chip={{ tone: "bad", text: "error" }}
        preview={truncatePreview(outText, 80) || "Error"}
      >
        <PayloadBlock label="Arguments" value={args} />
        <PayloadBlock label="Error" value={outText} failed />
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone="muted"
      title={display}
      cancelled={item.status === "cancelled"}
      preview={item.status === "cancelled" ? undefined : (goalPreview ?? "Done")}
    >
      <PayloadBlock label="Arguments" value={args} />
      <PayloadBlock label="Result" value={outText} />
    </ActivityDisclosure>
  );
}

function goalToolPreview(name: string, args: unknown): string | null {
  const leaf = mcpToolLeaf(name);
  if (
    leaf !== "goal_set" &&
    leaf !== "goal_update" &&
    leaf !== "goal_complete" &&
    leaf !== "goal_pause"
  ) {
    return null;
  }
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.evidence === "string"
        ? record.evidence
        : typeof record.rationale === "string"
          ? record.rationale
          : typeof record.progressNote === "string"
            ? record.progressNote
            : null;
  return text ? truncatePreview(text, 90) : null;
}

function truncatePreview(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Explicit first-party leaf/prefix → canonical product icons (match nav/pages). */
function GenericToolIcon({ name }: { name: string }) {
  const leaf = mcpToolLeaf(name);
  const Icon =
    leaf === "request_human_input"
      ? MessageCircleQuestionIcon
      : leaf.startsWith("goal_")
        ? TargetIcon
        : leaf.startsWith("memory_") ||
            leaf === "preference_registry_summary" ||
            leaf === "preference_registry_get"
          ? BrainCircuitIcon
          : leaf.startsWith("session_") ||
              leaf === "sessions_list" ||
              leaf === "set_session_title" ||
              leaf === "set_other_session_title"
            ? MessagesSquareIcon
            : leaf.startsWith("sandbox") || leaf === "sandboxes_list" || leaf === "run_on"
              ? ServerIcon
              : leaf.startsWith("rig_")
                ? ServerCogIcon
                : leaf.startsWith("scheduled_")
                  ? CalendarClockIcon
                  : leaf.startsWith("artifacts_")
                    ? PanelsTopLeftIcon
                    : leaf.startsWith("social_")
                      ? Share2Icon
                      : leaf.startsWith("slack_")
                        ? MessageSquareIcon
                        : leaf.startsWith("github_")
                          ? FolderGitIcon
                          : leaf.startsWith("variable_")
                            ? BoxIcon
                            : leaf.startsWith("environment_")
                              ? KeyRoundIcon
                              : leaf.includes("document") ||
                                  leaf.includes("knowledge") ||
                                  leaf === "list_document_bases"
                                ? FileSearchIcon
                                : leaf === "tool_search"
                                  ? PackageSearchIcon
                                  : leaf === "load_skill"
                                    ? PlugIcon
                                    : WrenchIcon;
  return <Icon className={ICON_SIZE} />;
}

/* ---- the default registry -------------------------------------------------- */

const BASE_ENTRIES: ToolRegistryEntry[] = [
  // Provider-native items carry `raw.type` on the wire — this is their source of
  // truth and is consulted first by the registry.
  { match: "rawType", type: "apply_patch_call", render: ApplyPatchRenderer },
  { match: "rawType", type: "computer_call", render: ComputerCallRenderer },
  { match: "rawType", type: "tool_search_call", render: ToolSearchRenderer },
  // First-party sandbox + MCP tools resolve by name (exact or MCP leaf).
  { match: "name", name: "exec_command", render: ExecRenderer },
  { match: "name", name: "request_human_input", render: AskRenderer },
  { match: "name", name: "run_on", render: RunOnRenderer },
  { match: "name", name: "write_stdin", render: WriteStdinRenderer },
  { match: "name", name: "apply_patch_call", render: ApplyPatchRenderer },
  { match: "name", name: "apply_patch", render: ApplyPatchRenderer },
  { match: "name", name: "computer_call", render: ComputerCallRenderer },
  // Function-mode computer tools (codex / chat-wire transports).
  { match: "name", name: "computer_screenshot", render: ComputerCallRenderer },
  { match: "name", name: "computer_click", render: ComputerCallRenderer },
  { match: "name", name: "computer_double_click", render: ComputerCallRenderer },
  { match: "name", name: "computer_move", render: ComputerCallRenderer },
  { match: "name", name: "computer_scroll", render: ComputerCallRenderer },
  { match: "name", name: "computer_type", render: ComputerCallRenderer },
  { match: "name", name: "computer_keypress", render: ComputerCallRenderer },
  { match: "name", name: "computer_drag", render: ComputerCallRenderer },
  { match: "name", name: "web_search_call", render: WebSearchRenderer },
  { match: "name", name: "image_generation_call", render: GeneratedImageRenderer },
  { match: "name", name: "generate_image", render: GeneratedImageRenderer },
  {
    match: "name",
    name: "publish_editable_artifact",
    render: EditableArtifactPublicationRenderer,
  },
  { match: "name", name: "tool_search", render: ToolSearchRenderer },
  { match: "name", name: "view_image", render: ViewImageRenderer },
  { match: "name", name: "environment_set_variable", render: SecretSetRenderer },
  { match: "name", name: "variable_set_set_variable", render: SecretSetRenderer },
  { match: "name", name: "search_documents", render: DocsSearchRenderer },
  { match: "name", name: "knowledge_search", render: DocsSearchRenderer },
  { match: "name", name: "memory_propose", render: MemoryProposeRenderer },
  { match: "name", name: "set_session_title", render: SetSessionTitleRenderer },
  { match: "name", name: "set_other_session_title", render: SetSessionTitleRenderer },
];

/** The built-in tool renderer registry: every first-party tool plus a fallback. */
export const defaultToolRegistry: ToolRegistry = createToolRegistry(BASE_ENTRIES, GenericRenderer);

/** Build a registry that extends the built-ins with consumer entries/fallback. */
export function createDefaultToolRegistry(
  options: Parameters<typeof createToolRegistry>[2] = {},
): ToolRegistry {
  return createToolRegistry(BASE_ENTRIES, GenericRenderer, options);
}
