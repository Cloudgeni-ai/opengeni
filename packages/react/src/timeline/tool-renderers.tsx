import { KnowledgeReceiptRow } from "./knowledge-receipt";
import { defaultUrlTransform } from "react-markdown";
import { isRetainedImageContentType, useRetainedImageObjectUrl } from "./retained-image";
import { parseSandboxFileArtifactReceipt, type RetainedArtifactReference } from "@opengeni/sdk";
import {
  BoxIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  CameraIcon,
  CameraOffIcon,
  DownloadIcon,
  FileDiffIcon,
  FileSearchIcon,
  FolderGitIcon,
  GlobeIcon,
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
  TerminalIcon,
  VideoIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { formatBytes, tryParseJson } from "../lib/format";
import { useTimelineComputeLabel } from "./compute-label";
import {
  generatedImageReceipt,
  mediaPreviewFact,
  parseToolArgs,
  retainedScreenshotMetadata,
  unwrapMcpOutput,
  screenshotDataUrl,
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
  CompactActivityContext,
} from "./shared";
import { RawPatch, ToolDiff } from "./tool-diff";
import {
  applyPatchPresentation,
  askPresentation,
  execPresentation,
  genericToolPresentation,
  pathBasename,
  pathDirname,
  runOnPresentation,
  truncatePreview,
  webSearchPresentation,
  writeStdinPresentation,
  type ToolBody,
  type ToolIconKind,
  type ToolPreview,
  type ToolRowPresentation,
  type WebSearchResult,
} from "./tool-presentation";
import { mcpToolLeaf, toolDisplayName } from "./tool-display-name";
import { useOpenGeniLinkResolver } from "../components/open-geni-links";

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
  const compact = useContext(CompactActivityContext);
  return (
    <span className="inline-flex items-center gap-1.5">
      {!compact && (
        <span className="size-1.5 shrink-0 animate-og-pulse rounded-full bg-og-status-running" />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
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
        <span className="text-og-fg-subtle">{pathDirname(path)}</span>
        <span className="text-og-fg-muted">{pathBasename(path)}</span>
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

/* ---- shared-model rows ------------------------------------------------------
   exec_command, write_stdin, apply_patch, web search, request_human_input,
   run_on and the generic fallback draw their row from the renderer-neutral
   presentation model in ./tool-presentation, which non-DOM renderers share.
   -------------------------------------------------------------------------- */

const TOOL_ICONS: Record<ToolIconKind, LucideIcon> = {
  terminal: TerminalIcon,
  keyboard: KeyboardIcon,
  "file-diff": FileDiffIcon,
  search: SearchIcon,
  question: MessageCircleQuestionIcon,
  target: TargetIcon,
  brain: BrainCircuitIcon,
  sessions: MessagesSquareIcon,
  server: ServerIcon,
  "server-cog": ServerCogIcon,
  calendar: CalendarClockIcon,
  panels: PanelsTopLeftIcon,
  share: Share2Icon,
  message: MessageSquareIcon,
  git: FolderGitIcon,
  box: BoxIcon,
  key: KeyRoundIcon,
  "file-search": FileSearchIcon,
  "package-search": PackageSearchIcon,
  plug: PlugIcon,
  wrench: WrenchIcon,
};

function presentedPreviewNode(preview: ToolPreview): ReactNode {
  switch (preview.kind) {
    case "text":
      return preview.running ? <RunningPreview>{preview.text}</RunningPreview> : preview.text;
    case "path":
      return <PathPreview path={preview.path} add={preview.add} del={preview.del} />;
    case "files":
      return (
        <span className="inline-flex items-center gap-2 font-og-mono">
          <span className="text-og-fg-muted">{preview.count} files</span>
          <span className="text-og-fg-subtle">
            +{preview.add} −{preview.del}
          </span>
        </span>
      );
    case "malformed":
      return (
        <span className="inline-flex items-center gap-2 font-og-mono">
          <span className="text-og-fg-muted">{preview.name}</span>
          <span className="text-og-fg-subtle">malformed V4A</span>
        </span>
      );
  }
}

function PresentedBody({ body }: { body: ToolBody }) {
  switch (body.kind) {
    case "term":
      return (
        <>
          {/* Exec rows pass command={null}: the row title already carries `$ cmd`. */}
          <TermBlock
            command={body.command}
            {...(body.workdir !== null || body.command === null ? { workdir: body.workdir } : {})}
            output={body.output}
            {...(body.live ? { live: true } : {})}
            {...(body.failed !== undefined ? { failed: body.failed } : {})}
          />
          {body.note ? <BodyNote>{body.note}</BodyNote> : null}
        </>
      );
    case "note":
      return body.tone ? (
        <BodyNote tone={body.tone}>{body.text}</BodyNote>
      ) : (
        <BodyNote>{body.text}</BodyNote>
      );
    case "payloads":
      return (
        <>
          {body.blocks.map((block) =>
            block.failed ? (
              <PayloadBlock key={block.label} label={block.label} value={block.value} failed />
            ) : (
              <PayloadBlock key={block.label} label={block.label} value={block.value} />
            ),
          )}
        </>
      );
    case "patch":
      if (body.bare) {
        return <RawPatch diff={body.files[0]?.diff ?? ""} />;
      }
      return (
        <>
          {body.files.map((entry) =>
            entry.file ? (
              <ToolDiff key={entry.key} files={[entry.file]} />
            ) : (
              <div key={entry.key}>
                <p className="mb-1 font-og-mono text-og-xs text-og-fg-muted">{entry.path}</p>
                <RawPatch diff={entry.diff} />
              </div>
            ),
          )}
        </>
      );
    case "web-results":
      return <WebSearchResults results={body.results} />;
  }
}

function WebSearchResults({ results }: { results: WebSearchResult[] | null }) {
  const resultOccurrences = new Map<string, number>();
  const keyedResults = results?.map((result) => {
    const contentKey = `${result.domain}\u0000${result.title}\u0000${result.snippet}`;
    const occurrence = (resultOccurrences.get(contentKey) ?? 0) + 1;
    resultOccurrences.set(contentKey, occurrence);
    return { key: `${contentKey}\u0000${occurrence}`, result };
  });
  if (!keyedResults || !keyedResults.length) {
    return <BodyNote>results folded into model context — no list available.</BodyNote>;
  }
  return (
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
  );
}

/** Draw one shared-model row with the web disclosure primitives. */
function PresentedToolRow({ presentation: p }: { presentation: ToolRowPresentation }) {
  const Icon = TOOL_ICONS[p.icon];
  return (
    <ActivityDisclosure
      icon={<Icon className={ICON_SIZE} />}
      iconTone={p.iconTone}
      title={p.title}
      {...(p.titleMono ? { titleMono: true } : {})}
      {...(p.running ? { running: true } : {})}
      {...(p.chip ? { chip: p.chip } : {})}
      {...(p.failed !== undefined ? { failed: p.failed } : {})}
      {...(p.cancelled !== undefined ? { cancelled: p.cancelled } : {})}
      preview={p.preview ? presentedPreviewNode(p.preview) : undefined}
    >
      <PresentedBody body={p.body} />
    </ActivityDisclosure>
  );
}

function ExecRenderer({ item }: ToolRendererProps) {
  const computeLabel = useTimelineComputeLabel();
  return <PresentedToolRow presentation={execPresentation(item, { computeLabel })} />;
}

function WriteStdinRenderer({ item }: ToolRendererProps) {
  return <PresentedToolRow presentation={writeStdinPresentation(item)} />;
}

function ApplyPatchRenderer({ item }: ToolRendererProps) {
  const presentation = applyPatchPresentation(item);
  return presentation ? (
    <PresentedToolRow presentation={presentation} />
  ) : (
    <GenericRenderer item={item} />
  );
}

function WebSearchRenderer({ item }: ToolRendererProps) {
  return <PresentedToolRow presentation={webSearchPresentation(item)} />;
}

function AskRenderer({ item }: ToolRendererProps) {
  return <PresentedToolRow presentation={askPresentation(item)} />;
}

function RunOnRenderer({ item }: ToolRendererProps) {
  return <PresentedToolRow presentation={runOnPresentation(item)} />;
}

/**
 * Baseline craft for unmatched tools: family icon + title-cased leaf + honest
 * status preview (Running… / Done / error snippet). No argument-field sniffing —
 * JSON stays in the expandable body only.
 */
function GenericRenderer({ item }: ToolRendererProps) {
  return <PresentedToolRow presentation={genericToolPresentation(item)} />;
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
      ? {
          type: item.name.slice("computer_".length),
          ...asComputerArgs(item.arguments),
        }
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

/** Browser tool images share authenticated screenshot loading, with their own media kind. */
function BrowserScreenshotRenderer(props: ToolRendererProps) {
  const { item, loadRetainedScreenshot } = props;
  const leaf = mcpToolLeaf(item.name);
  const title =
    leaf === "browser_observe"
      ? "Observed browser"
      : leaf === "browser_act"
        ? "Used browser"
        : "Browser screenshot";
  const retained = retainedScreenshotMetadata(item.output);
  const isFailed = item.status === "failed";
  const isCancelled = item.status === "cancelled";

  if (item.status === "running" && leaf === "browser_screenshot") {
    return (
      <ActivityDisclosure
        icon={<CameraIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        running
        media={<MediaSkeleton />}
      >
        <BodyNote>capturing frame…</BodyNote>
      </ActivityDisclosure>
    );
  }

  if (!retained) return <GenericRenderer {...props} />;
  if (!retained.available) {
    const state =
      retained.reason === "expired" || retained.reason === "deleted"
        ? retained.reason
        : "unavailable";
    return (
      <ActivityDisclosure
        icon={<CameraOffIcon className={ICON_SIZE} />}
        iconTone={isFailed ? "failed" : "muted"}
        title={`${title} · ${state}`}
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
      title={title}
      caption={title}
      noun="screenshot"
      icon={<CameraIcon className={ICON_SIZE} />}
      lightboxLabel="Browser screenshot"
      batched={null}
      failed={isFailed}
      cancelled={isCancelled}
    />
  );
}

type RetainedSessionImageDisclosureProps = {
  artifact: RetainedArtifactReference;
  load: ToolRendererProps["loadRetainedArtifact"];
  title: string;
  caption: string;
  noun: "image" | "screenshot";
  icon: ReactNode;
  lightboxLabel: string;
  batched: string | null;
  failed: boolean;
  cancelled: boolean;
  filename?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
};

function RetainedSessionImageDisclosure(props: RetainedSessionImageDisclosureProps) {
  const compact = useContext(CompactActivityContext);
  // The rolling progress label has no screenshot loader by design. Do not run
  // the full image hook there: it would report the missing loader as an error.
  if (compact) {
    return (
      <ActivityDisclosure
        icon={props.icon}
        title={props.title}
        compactPreview={null}
        failed={props.failed}
        cancelled={props.cancelled}
      />
    );
  }
  return <LoadedRetainedSessionImageDisclosure {...props} />;
}

function LoadedRetainedSessionImageDisclosure({
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
  filename,
  defaultOpen,
  children,
}: RetainedSessionImageDisclosureProps) {
  const state = useRetainedImageObjectUrl(artifact, load);
  const downloadFilename = filename ?? retainedImageFilename(artifact);
  const figure = {
    src: state.kind === "ready" ? state.url : "",
    caption,
    alt: caption,
    expandLabel: `Expand ${noun}`,
    lightboxLabel,
    downloadFilename,
  };

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone={failed ? "failed" : state.kind === "ready" ? "accent" : "muted"}
      title={title}
      defaultOpen={defaultOpen}
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
          <Thumbnail {...figure} />
        ) : state.kind === "loading" ? (
          <MediaSkeleton />
        ) : (
          <MediaEmpty />
        )
      }
    >
      {state.kind === "ready" ? (
        <ScreenshotFigure {...figure} />
      ) : state.kind === "loading" ? (
        <BodyNote>Loading the retained {noun}…</BodyNote>
      ) : state.kind === "unavailable" ? (
        <BodyNote>
          {noun === "screenshot" ? "Screenshot" : "Image"} {state.label}.
        </BodyNote>
      ) : (
        <ImageRetrievalError noun={noun} retry={state.retry} />
      )}
      {batched ? <BodyNote>batched: {batched}</BodyNote> : null}
      {children}
    </ActivityDisclosure>
  );
}

function ImageRetrievalError({ noun = "image", retry }: { noun?: string; retry: () => void }) {
  return (
    <BodyNote tone="error">
      {noun === "screenshot" ? "Screenshot" : "Image"} retrieval failed.{" "}
      <button
        type="button"
        aria-label={`Retry ${noun} retrieval`}
        onClick={retry}
        className="underline underline-offset-2"
      >
        Retry
      </button>
    </BodyNote>
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

function GeneratedVideoRenderer({ item }: ToolRendererProps) {
  const args = parseToolArgs(item.arguments);
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const parsedOutput = typeof item.output === "string" ? tryParseJson(item.output) : item.output;
  const accepted =
    parsedOutput &&
    typeof parsedOutput === "object" &&
    !Array.isArray(parsedOutput) &&
    (parsedOutput as Record<string, unknown>).status === "accepted";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const running = item.status === "running";
  return (
    <ActivityDisclosure
      icon={<VideoIcon className={ICON_SIZE} />}
      iconTone={failed ? "failed" : running ? "running" : accepted ? "accent" : "muted"}
      title={
        running ? "Starting video generation" : accepted ? "Generating video" : "Generate video"
      }
      running={running}
      failed={failed}
      cancelled={cancelled}
      preview={truncatePreview(prompt, 88) || (accepted ? "request accepted" : undefined)}
    >
      {prompt ? <BodyNote>{prompt}</BodyNote> : null}
      {accepted ? (
        <BodyNote>The video will appear here when it is ready.</BodyNote>
      ) : item.output !== undefined ? (
        <PayloadBlock label="Output" value={item.output} />
      ) : null}
    </ActivityDisclosure>
  );
}
function SandboxFilePublishRenderer({ item, loadRetainedArtifact }: ToolRendererProps) {
  const { text: output, isError } = unwrapMcpOutput(item.output);
  const receipt = parseSandboxFileArtifactReceipt(output);
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "error">("idle");
  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<DownloadIcon className={ICON_SIZE} />}
        iconTone="running"
        title="Publishing file"
        running
        preview={<RunningPreview>retaining workspace bytes…</RunningPreview>}
      />
    );
  }
  if (!receipt || isError || item.status === "failed") {
    return <GenericRenderer item={item} />;
  }

  // The closed SDK receipt has already checked the workspace-qualified route.
  const workspaceId = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\//.exec(
    receipt.artifact.retrieval.path,
  )?.[1];
  const openLink = workspaceId ? (
    <a
      href={`/workspaces/${workspaceId}/artifacts/files/${receipt.artifact.artifactId}`}
      aria-label={`Open ${receipt.filename} in Artifacts`}
      className="inline-flex min-h-7 items-center rounded-og-sm px-2 text-og-sm font-medium text-og-accent-strong hover:bg-og-surface-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-10"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      Open in Artifacts
    </a>
  ) : null;

  const download = async () => {
    if (!loadRetainedArtifact) {
      setDownloadState("error");
      return;
    }
    setDownloadState("loading");
    let objectUrl: string | null = null;
    try {
      const source = await loadRetainedArtifact(receipt.artifact, new AbortController().signal);
      if (!source) throw new Error("artifact unavailable");
      const url =
        source instanceof Uint8Array
          ? (objectUrl = URL.createObjectURL(
              new Blob([source as unknown as BlobPart], {
                type: receipt.artifact.contentType,
              }),
            ))
          : source.url;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = receipt.filename;
      anchor.rel = "noopener";
      anchor.click();
      setDownloadState("idle");
    } catch {
      setDownloadState("error");
    } finally {
      const urlToRevoke = objectUrl;
      if (urlToRevoke) setTimeout(() => URL.revokeObjectURL(urlToRevoke), 0);
    }
  };

  const downloadButton = (
    <button
      type="button"
      onClick={() => void download()}
      disabled={downloadState === "loading"}
      className="inline-flex items-center gap-1.5 rounded-og-sm border border-og-border px-2.5 py-1.5 text-og-sm font-medium text-og-fg transition-colors hover:border-og-border-strong hover:bg-og-surface-2 disabled:cursor-wait disabled:opacity-60"
    >
      <DownloadIcon className="size-3.5" />
      {downloadState === "loading"
        ? "Preparing…"
        : downloadState === "error"
          ? "Retry download"
          : "Download"}
    </button>
  );

  if (isRetainedImageContentType(receipt.artifact.contentType)) {
    return (
      <RetainedSessionImageDisclosure
        artifact={receipt.artifact}
        load={loadRetainedArtifact}
        title={`Published ${receipt.filename}`}
        caption={receipt.filename}
        noun="image"
        icon={<ImageIcon className={ICON_SIZE} />}
        lightboxLabel="Image"
        batched={null}
        failed={false}
        cancelled={false}
        filename={receipt.filename}
        defaultOpen
      >
        {downloadButton}
        {openLink}
      </RetainedSessionImageDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<DownloadIcon className={ICON_SIZE} />}
      iconTone="accent"
      title={`Published ${receipt.filename}`}
      defaultOpen
      preview={formatBytes(receipt.artifact.originalBytes)}
    >
      {downloadButton}
      {openLink}
    </ActivityDisclosure>
  );
}

type PublishedSiteReceipt = {
  workspaceId: string;
  artifactId: string;
  title: string;
  revision: number;
  replayed: boolean;
};

function publishedSiteReceipt(output: unknown): PublishedSiteReceipt | null {
  const { text, isError } = unwrapMcpOutput(output);
  if (isError) return null;
  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const artifact = (parsed as Record<string, unknown>).artifact;
  const version = (parsed as Record<string, unknown>).version;
  if (
    !artifact ||
    typeof artifact !== "object" ||
    Array.isArray(artifact) ||
    !version ||
    typeof version !== "object" ||
    Array.isArray(version)
  ) {
    return null;
  }
  const artifactRecord = artifact as Record<string, unknown>;
  const versionRecord = version as Record<string, unknown>;
  if (
    typeof artifactRecord.workspaceId !== "string" ||
    typeof artifactRecord.id !== "string" ||
    typeof artifactRecord.title !== "string" ||
    typeof versionRecord.revision !== "number" ||
    !Number.isInteger(versionRecord.revision) ||
    versionRecord.revision < 1
  ) {
    return null;
  }
  return {
    workspaceId: artifactRecord.workspaceId,
    artifactId: artifactRecord.id,
    title: artifactRecord.title,
    revision: versionRecord.revision,
    replayed: (parsed as Record<string, unknown>).replayed === true,
  };
}

const SITE_OPEN_CLASS =
  "inline-flex min-h-7 items-center rounded-og-sm px-2 text-og-sm font-medium text-og-accent-strong hover:bg-og-surface-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-10";

function SiteOpenLink({ receipt }: { receipt: PublishedSiteReceipt }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // The console route only exists in the OpenGeni console; a host decides.
  const resolution = useOpenGeniLinkResolver()?.({
    kind: "site",
    artifactId: receipt.artifactId,
    workspaceId: receipt.workspaceId,
  });
  const destination = resolution?.href ? defaultUrlTransform(resolution.href) : "";
  if (destination) {
    return (
      <a
        href={destination}
        aria-label={`Open ${receipt.title}`}
        className={SITE_OPEN_CLASS}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        Open
      </a>
    );
  }
  if (resolution?.open) {
    const open = resolution.open;
    return (
      <button
        type="button"
        aria-label={`Open ${receipt.title}`}
        aria-busy={pending}
        disabled={pending}
        className={SITE_OPEN_CLASS}
        onClick={(event) => {
          event.stopPropagation();
          if (pending) return;
          setPending(true);
          setFailed(false);
          void Promise.resolve()
            .then(open)
            .catch(() => setFailed(true))
            .finally(() => setPending(false));
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {pending ? "Opening…" : failed ? "Retry open" : "Open"}
      </button>
    );
  }
  return null;
}

function SiteArtifactRenderer({ item }: ToolRendererProps) {
  const leaf = mcpToolLeaf(item.name);
  const publishingExisting = leaf === "artifacts_publish";
  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<PanelsTopLeftIcon className={ICON_SIZE} />}
        iconTone="running"
        title={publishingExisting ? "Publishing Site update" : "Publishing Site"}
        running
        preview={<RunningPreview>retaining source and compiled HTML…</RunningPreview>}
      />
    );
  }
  const receipt = publishedSiteReceipt(item.output);
  if (!receipt || item.status === "failed") return <GenericRenderer item={item} />;
  return (
    <ActivityDisclosure
      icon={<PanelsTopLeftIcon className={ICON_SIZE} />}
      iconTone="accent"
      title={publishingExisting ? `Updated ${receipt.title}` : `Published ${receipt.title}`}
      media={<SiteOpenLink receipt={receipt} />}
    >
      <BodyNote>
        Version {receipt.revision} is live
        {receipt.replayed ? " (replayed from the original publication)." : "."}
      </BodyNote>
    </ActivityDisclosure>
  );
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
        <ImageRetrievalError retry={state.retry} />
      )}
      <BodyNote>
        {dimensions.width}×{dimensions.height} · {receipt.sandboxPath}
      </BodyNote>
    </ActivityDisclosure>
  );
}

function retainedImageFilename(artifact: RetainedArtifactReference): string {
  const extension =
    artifact.contentType === "image/jpeg"
      ? "jpg"
      : artifact.contentType === "image/webp"
        ? "webp"
        : "png";
  return `${artifact.kind}-${artifact.artifactId}.${extension}`;
}

/* ---- web_search ------------------------------------------------------------ */

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
        title={`View ${pathBasename(path)}`}
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
    const title = `Viewed ${pathBasename(path)}`;
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
        title={`View ${pathBasename(path)}`}
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
        title={`Viewed ${pathBasename(path)}`}
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
        title={`Viewed ${pathBasename(path)} · image omitted · not retained`}
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
        title={`Viewed ${pathBasename(path)}`}
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
        title={`Viewed ${pathBasename(path)}`}
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
  const title = query
    ? `Search “${truncatePreview(query, 48)}”`
    : toolDisplayName(item.name, item.display);
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
  const display = toolDisplayName(item.name, item.display);
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

/* ---- run_on ---------------------------------------------------------------- */

/* ---- generic fallback (first-party MCP, external MCP, unknown) ------------- */

/* ---- the default registry -------------------------------------------------- */

function KnowledgeSaveRenderer({ item }: ToolRendererProps) {
  const output = unwrapMcpOutput(item.output);
  const parsed = tryParseJson(output.text);
  if (item.status === "running" || output.isError || !parsed || typeof parsed !== "object")
    return <GenericRenderer item={item} />;
  const value = parsed as Record<string, unknown>;
  const receipt = (value.status === "retained" ? value.receipt : value) as
    | Record<string, unknown>
    | undefined;
  if (
    !receipt ||
    typeof receipt.entryId !== "string" ||
    !["published", "pending", "rejected", "archived"].includes(String(receipt.outcome))
  )
    return <GenericRenderer item={item} />;
  const args = parseToolArgs(item.arguments);
  const entry = args.entry as Record<string, unknown> | undefined;
  return (
    <KnowledgeReceiptRow
      outcome={receipt.outcome as "published" | "pending" | "rejected" | "archived"}
      entryId={receipt.entryId}
      title={
        typeof entry?.title === "string"
          ? entry.title
          : typeof value.filename === "string"
            ? value.filename
            : undefined
      }
      source={value.status === "retained" || value.retained === true}
    />
  );
}

const BASE_ENTRIES: ToolRegistryEntry[] = [
  ...[
    "knowledge_save",
    "knowledge_archive",
    "knowledge_retain_file",
    "knowledge_retain_message",
    "task_note_promote_knowledge",
  ].flatMap((name) =>
    [name, `opengeni__${name}`, `mcp__opengeni__${name}`].map((trustedName) => ({
      match: "name" as const,
      name: trustedName,
      matchPrefixedLeaf: false,
      render: KnowledgeSaveRenderer,
    })),
  ),
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
  {
    match: "name",
    name: "browser_screenshot",
    render: BrowserScreenshotRenderer,
  },
  { match: "name", name: "browser_observe", render: BrowserScreenshotRenderer },
  { match: "name", name: "browser_act", render: BrowserScreenshotRenderer },
  // Function-mode computer tools (codex / chat-wire transports).
  { match: "name", name: "computer_screenshot", render: ComputerCallRenderer },
  { match: "name", name: "computer_click", render: ComputerCallRenderer },
  {
    match: "name",
    name: "computer_double_click",
    render: ComputerCallRenderer,
  },
  { match: "name", name: "computer_move", render: ComputerCallRenderer },
  { match: "name", name: "computer_scroll", render: ComputerCallRenderer },
  { match: "name", name: "computer_type", render: ComputerCallRenderer },
  { match: "name", name: "computer_keypress", render: ComputerCallRenderer },
  { match: "name", name: "computer_drag", render: ComputerCallRenderer },
  { match: "name", name: "web_search_call", render: WebSearchRenderer },
  {
    match: "name",
    name: "image_generation_call",
    render: GeneratedImageRenderer,
  },
  { match: "name", name: "generate_image", render: GeneratedImageRenderer },
  { match: "name", name: "generate_video", render: GeneratedVideoRenderer },
  { match: "name", name: "tool_search", render: ToolSearchRenderer },
  { match: "name", name: "view_image", render: ViewImageRenderer },
  {
    match: "name",
    name: "sandbox_file_publish",
    render: SandboxFilePublishRenderer,
  },
  {
    match: "name",
    name: "artifacts_create",
    render: SiteArtifactRenderer,
    matchPrefixedLeaf: false,
  },
  {
    match: "name",
    name: "artifacts_publish",
    render: SiteArtifactRenderer,
    matchPrefixedLeaf: false,
  },
  {
    match: "name",
    name: "opengeni__artifacts_create",
    render: SiteArtifactRenderer,
    matchPrefixedLeaf: false,
  },
  {
    match: "name",
    name: "opengeni__artifacts_publish",
    render: SiteArtifactRenderer,
    matchPrefixedLeaf: false,
  },
  {
    match: "name",
    name: "environment_set_variable",
    render: SecretSetRenderer,
  },
  {
    match: "name",
    name: "variable_set_set_variable",
    render: SecretSetRenderer,
  },
  { match: "name", name: "search_documents", render: DocsSearchRenderer },
  { match: "name", name: "knowledge_search", render: DocsSearchRenderer },
  { match: "name", name: "memory_propose", render: MemoryProposeRenderer },
  { match: "name", name: "set_session_title", render: SetSessionTitleRenderer },
  {
    match: "name",
    name: "set_other_session_title",
    render: SetSessionTitleRenderer,
  },
];

/** The built-in tool renderer registry: every first-party tool plus a fallback. */
export const defaultToolRegistry: ToolRegistry = createToolRegistry(BASE_ENTRIES, GenericRenderer);

/** Build a registry that extends the built-ins with consumer entries/fallback. */
export function createDefaultToolRegistry(
  options: Parameters<typeof createToolRegistry>[2] = {},
): ToolRegistry {
  return createToolRegistry(BASE_ENTRIES, GenericRenderer, options);
}
