import { useHasToolReview, useRecordedToolReview } from "../components/tool-review-history";
import { ToolActionReviewCard } from "../components/tool-action-review";
import { SecretRefText } from "../components/secret-ref-chip";
import type { ToolReviewStatus } from "@opengeni/sdk";
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
import { useToolDetails } from "./tool-details";
import type { ToolCallItem } from "./types";
import { ConnectorLogoIcon, useToolConnectorLogo } from "./provider-logo";
import {
  generatedImageReceipt,
  mediaPreviewFact,
  parseToolArgs,
  retainedScreenshotMetadata,
  retainedToolResultImages,
  unwrapMcpOutput,
  screenshotDataUrl,
} from "./parsers";
import {
  createToolRegistry,
  type ToolRegistry,
  type ToolRegistryEntry,
  type ToolRenderer,
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
  type DisclosureChip,
} from "./shared";
import { RawPatch, ToolDiff } from "./tool-diff";
import {
  applyPatchPresentation,
  askPresentation,
  execPresentation,
  genericToolIconKind,
  parseDisclosedTools,
  parseSearchHits,
  pathBasename,
  pathDirname,
  machinePresentation,
  runOnPresentation,
  plainToolRow,
  presentedToolKind,
  presentsToolOutputPreview,
  toolRowPresentation,
  toolSearchPreview,
  toolSearchQuery,
  truncatePreview,
  webSearchPresentation,
  writeStdinPresentation,
  type PresentedToolKind,
  type ToolBody,
  type ToolIconKind,
  type ToolPreview,
  type ToolRowPresentation,
  type WebSearchResult,
} from "./tool-presentation";
import { isPatchFilename, PatchApplyCommand } from "./patch-apply-command";
import { mcpToolLeaf, toolDisplayName } from "./tool-display-name";
import { useOpenGeniLinkResolver } from "../components/open-geni-links";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

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

/**
 * The icon for a presentation kind, looked up when a row renders. A module-level
 * table would capture the icons at load time; in a bundle where this module and
 * the icon library's chunk import each other, an icon can still be undefined
 * then, and the row would render an undefined component (React #130).
 */
function toolIcon(kind: ToolIconKind): LucideIcon {
  switch (kind) {
    case "terminal":
      return TerminalIcon;
    case "keyboard":
      return KeyboardIcon;
    case "file-diff":
      return FileDiffIcon;
    case "search":
      return SearchIcon;
    case "question":
      return MessageCircleQuestionIcon;
    case "target":
      return TargetIcon;
    case "brain":
      return BrainCircuitIcon;
    case "sessions":
      return MessagesSquareIcon;
    case "server":
      return ServerIcon;
    case "server-cog":
      return ServerCogIcon;
    case "calendar":
      return CalendarClockIcon;
    case "panels":
      return PanelsTopLeftIcon;
    case "share":
      return Share2Icon;
    case "message":
      return MessageSquareIcon;
    case "git":
      return FolderGitIcon;
    case "box":
      return BoxIcon;
    case "key":
      return KeyRoundIcon;
    case "file-search":
      return FileSearchIcon;
    case "package-search":
      return PackageSearchIcon;
    case "plug":
      return PlugIcon;
    case "wrench":
      return WrenchIcon;
  }
}

function presentedPreviewNode(msg: OpenGeniText, preview: ToolPreview): ReactNode {
  switch (preview.kind) {
    case "text":
      return preview.running ? <RunningPreview>{preview.text}</RunningPreview> : preview.text;
    case "path":
      return <PathPreview path={preview.path} add={preview.add} del={preview.del} />;
    case "files":
      return (
        <span className="inline-flex items-center gap-2 font-og-mono">
          <span className="text-og-fg-muted">
            {msg("timeline.toolRenderers.filesCount", { count: preview.count })}
          </span>
          <span className="text-og-fg-subtle">
            +{preview.add} −{preview.del}
          </span>
        </span>
      );
    case "malformed":
      return (
        <span className="inline-flex items-center gap-2 font-og-mono">
          <span className="text-og-fg-muted">{preview.name}</span>
          <span className="text-og-fg-subtle">{msg("timeline.toolRenderers.malformedPatch")}</span>
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
          {body.note ? <p className="m-0 py-1 text-og-sm text-og-fg-muted">{body.note}</p> : null}
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
    case "none":
      return null;
  }
}

function WebSearchResults({ results }: { results: WebSearchResult[] | null }) {
  const msg = useOpenGeniText();
  const resultOccurrences = new Map<string, number>();
  const keyedResults = results?.map((result) => {
    const contentKey = `${result.domain}\u0000${result.title}\u0000${result.snippet}`;
    const occurrence = (resultOccurrences.get(contentKey) ?? 0) + 1;
    resultOccurrences.set(contentKey, occurrence);
    return { key: `${contentKey}\u0000${occurrence}`, result };
  });
  if (!keyedResults || !keyedResults.length) {
    return <BodyNote>{msg("timeline.toolRenderers.resultsFoldedIntoModelContext")}</BodyNote>;
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
function PresentedToolRow({
  presentation,
  item,
  logo = null,
}: {
  presentation: ToolRowPresentation;
  /** The call the row presents; plain tool details reduce the row from it. */
  item: ToolCallItem;
  /** A connector's logo, drawn in place of the row's icon. */
  logo?: string | null;
}) {
  const msg = useOpenGeniText();
  const computeLabel = useTimelineComputeLabel();
  const p =
    useToolDetails() === "plain"
      ? plainToolRow(msg, item, presentation, { computeLabel })
      : presentation;
  const Icon = toolIcon(p.icon);
  return (
    <ActivityDisclosure
      icon={<ConnectorLogoIcon src={logo} fallback={<Icon className={ICON_SIZE} />} />}
      iconTone={p.iconTone}
      // A chip inside the row's own toggle never links.
      title={<SecretRefText text={p.title} linkable={false} />}
      {...(p.titleMono ? { titleMono: true } : {})}
      {...(p.running ? { running: true } : {})}
      {...(p.chip ? { chip: p.chip } : {})}
      {...(p.failed !== undefined ? { failed: p.failed } : {})}
      {...(p.cancelled !== undefined ? { cancelled: p.cancelled } : {})}
      preview={p.preview ? presentedPreviewNode(msg, p.preview) : undefined}
      expandable={p.body.kind !== "none"}
    >
      <PresentedBody body={p.body} />
    </ActivityDisclosure>
  );
}

function ExecRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const computeLabel = useTimelineComputeLabel();
  return (
    <PresentedToolRow presentation={execPresentation(msg, item, { computeLabel })} item={item} />
  );
}

function WriteStdinRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  return <PresentedToolRow presentation={writeStdinPresentation(msg, item)} item={item} />;
}

function ApplyPatchRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const presentation = applyPatchPresentation(msg, item);
  return presentation ? (
    <PresentedToolRow presentation={presentation} item={item} />
  ) : (
    <GenericRenderer item={item} />
  );
}

function WebSearchRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  return <PresentedToolRow presentation={webSearchPresentation(msg, item)} item={item} />;
}

function AskRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  return <PresentedToolRow presentation={askPresentation(msg, item)} item={item} />;
}

function RunOnRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  return <PresentedToolRow presentation={runOnPresentation(msg, item)} item={item} />;
}

/**
 * Finding machines, moving onto one and back, and using its screen. A look at
 * the screen, or an action on it, shows the screenshot it took.
 */
function MachineRenderer({ item, loadRetainedScreenshot }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const presentation = machinePresentation(msg, item);
  const retained = mcpToolLeaf(item.name).startsWith("computer_")
    ? retainedScreenshotMetadata(item.output)
    : null;
  if (!retained?.available) return <PresentedToolRow presentation={presentation} item={item} />;
  return (
    <RetainedSessionImageDisclosure
      artifact={retained}
      load={loadRetainedScreenshot}
      title={presentation.title}
      caption={presentation.title}
      noun="screenshot"
      icon={<CameraIcon className={ICON_SIZE} />}
      lightboxLabel={msg("timeline.toolRenderers.screenshot")}
      batched={null}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
    />
  );
}

/**
 * Baseline craft for unmatched tools: family icon + title-cased leaf + honest
 * status preview (Running… / Done / error snippet). No argument-field sniffing —
 * JSON stays in the expandable body only.
 *
 * A tool the shared presenter knows but no dedicated renderer claims (screen
 * steps such as `cua_get_desktop_state`, `interaction_discover`) still reads
 * the way the presenter words it, so the web row and other renderers agree.
 */
function UnreviewedGenericRenderer({ item, loadRetainedScreenshot }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const details = useToolDetails();
  const logo = useToolConnectorLogo(item.display);
  const { images, output } = retainedToolResultImages(item.output);
  if (images.length === 0 || item.status === "running") {
    return (
      <PresentedToolRow presentation={toolRowPresentation(msg, item)} item={item} logo={logo} />
    );
  }
  // A tool that returned images shows them like a viewed image, with its
  // ordinary result text (and any further images) in the expanded body.
  const presentation = toolRowPresentation(msg, { ...item, output }, { details });
  const Icon = toolIcon(presentation.icon);
  const [first, ...rest] = images;
  return (
    <RetainedSessionImageDisclosure
      artifact={first!}
      load={loadRetainedScreenshot}
      title={presentation.title}
      caption={presentation.title}
      noun="image"
      icon={<ConnectorLogoIcon src={logo} fallback={<Icon className={ICON_SIZE} />} />}
      lightboxLabel={presentation.title}
      batched={null}
      failed={presentation.failed ?? false}
      cancelled={presentation.cancelled ?? false}
    >
      <PresentedBody body={presentation.body} />
      {rest.map((image, index) => (
        <RetainedSessionImageDisclosure
          key={image.artifactId}
          artifact={image}
          load={loadRetainedScreenshot}
          title={msg("timeline.toolRenderers.imageIndex", { index: index + 2 })}
          caption={`${presentation.title}, image ${index + 2}`}
          noun="image"
          icon={<ImageIcon className={ICON_SIZE} />}
          lightboxLabel={presentation.title}
          batched={null}
          failed={false}
          cancelled={false}
        />
      ))}
    </RetainedSessionImageDisclosure>
  );
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

function computerVerb(msg: OpenGeniText, action: ComputerAction | undefined): string {
  if (!action || !action.type) {
    return msg("timeline.toolRenderers.acted");
  }
  switch (action.type) {
    case "screenshot":
      return msg("timeline.toolRenderers.screenshot");
    case "click":
      return msg("timeline.toolRenderers.clickedXY", { x: action.x, y: action.y });
    case "double_click":
      return msg("timeline.toolRenderers.doubleClickedXY", { x: action.x, y: action.y });
    case "move":
      return msg("timeline.toolRenderers.movedXY", { x: action.x, y: action.y });
    case "scroll":
      return msg("timeline.toolRenderers.scrolled");
    case "type": {
      const t = action.text ?? "";
      return msg("timeline.toolRenderers.typedSliceValue", {
        slice: t.slice(0, 28),
        value: t.length > 28 ? "…" : "",
      });
    }
    case "keypress":
      return msg("timeline.toolRenderers.pressedJoin", { join: (action.keys ?? []).join("+") });
    case "drag":
      return msg("timeline.toolRenderers.dragged");
    case "wait":
      return msg("timeline.toolRenderers.waited");
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
  const msg = useOpenGeniText();
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
  const verb = computerVerb(msg, action);
  const out = item.output;
  const running = item.status === "running";
  const rejected = raw.providerData?.approvalStatus === "rejected";
  const readOnly = typeof out === "string" && out.includes("read-only");
  const shotUrl = screenshotDataUrl(out);
  const retained = retainedScreenshotMetadata(out);
  const omittedMedia = mediaPreviewFact(out);
  const empty = out === "" || out == null;
  const batched = actions.length > 1 ? actions.map((a) => computerVerb(msg, a)).join(" · ") : null;
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
        <BodyNote>{msg("timeline.toolRenderers.capturingFrame")}</BodyNote>
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
        <BodyNote tone="error">{msg("timeline.toolRenderers.computerUseIsReadOnly")}</BodyNote>
      </ActivityDisclosure>
    );
  }

  if (rejected) {
    return (
      <ActivityDisclosure
        icon={<LockIcon className={ICON_SIZE} />}
        iconTone="muted"
        title={verb}
        preview={msg("timeline.toolRenderers.approvalRejectedThisActionDid2")}
      >
        <BodyNote>{msg("timeline.toolRenderers.approvalRejectedThisActionDid")}</BodyNote>
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
            {msg("timeline.toolRenderers.screenshotStateReplaceall", {
              state,
              replaceAll: retained.reason.replaceAll("_", " "),
            })}
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
        lightboxLabel={msg("timeline.toolRenderers.screenshot")}
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
        {batched ? (
          <BodyNote>{msg("timeline.toolRenderers.batchedBatched", { batched })}</BodyNote>
        ) : null}
      </ActivityDisclosure>
    );
  }

  if (omittedMedia) {
    return (
      <ActivityDisclosure
        icon={<CameraOffIcon className={ICON_SIZE} />}
        iconTone={isFailed ? "failed" : "muted"}
        title={msg("timeline.toolRenderers.verbCountsuffixImageOmittedNot", { verb, countSuffix })}
        failed={isFailed}
        cancelled={isCancelled}
        preview={msg("timeline.toolRenderers.inlineImageOmittedNotRetained")}
        media={<MediaEmpty />}
      >
        <BodyNote>
          {msg("timeline.toolRenderers.theInlineMediatypeOutputWas", {
            mediaType: omittedMedia.mediaType,
          })}
        </BodyNote>
        {batched ? (
          <BodyNote>{msg("timeline.toolRenderers.batchedBatched", { batched })}</BodyNote>
        ) : null}
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
            ? msg("timeline.toolRenderers.computerCallFailedNoImage")
            : isCancelled
              ? msg("timeline.toolRenderers.computerCallInterruptedNoImage")
              : msg("timeline.toolRenderers.noImageTheSessionReturned")}
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
  const msg = useOpenGeniText();
  const { item, loadRetainedScreenshot } = props;
  const leaf = mcpToolLeaf(item.name);
  const title =
    leaf === "browser_observe"
      ? msg("timeline.toolRenderers.observedBrowser")
      : leaf === "browser_act"
        ? msg("timeline.toolRenderers.usedBrowser")
        : msg("timeline.toolRenderers.browserScreenshot");
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
        <BodyNote>{msg("timeline.toolRenderers.capturingFrame")}</BodyNote>
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
          {msg("timeline.toolRenderers.screenshotStateReplaceall", {
            state,
            replaceAll: retained.reason.replaceAll("_", " "),
          })}
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
      lightboxLabel={msg("timeline.toolRenderers.browserScreenshot")}
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
  const msg = useOpenGeniText();
  const state = useRetainedImageObjectUrl(artifact, load);
  const downloadFilename = filename ?? retainedImageFilename(artifact);
  const figure = {
    src: state.kind === "ready" ? state.url : "",
    caption,
    alt: caption,
    expandLabel: msg("timeline.toolRenderers.expandNoun", { noun }),
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
          ? msg("timeline.toolRenderers.loadingRetainedNoun", { noun })
          : state.kind === "error"
            ? msg("timeline.toolRenderers.nounRetrievalFailed", { noun })
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
        <ScreenshotFigure {...figure} showCaption={caption !== title} />
      ) : state.kind === "loading" ? (
        <BodyNote>{msg("timeline.toolRenderers.loadingTheRetainedNoun", { noun })}</BodyNote>
      ) : state.kind === "unavailable" ? (
        <BodyNote>
          {noun === "screenshot"
            ? msg("timeline.toolRenderers.screenshot")
            : msg("timeline.toolRenderers.image")}{" "}
          {state.label}.
        </BodyNote>
      ) : (
        <ImageRetrievalError noun={noun} retry={state.retry} />
      )}
      {batched ? (
        <BodyNote>{msg("timeline.toolRenderers.batchedBatched", { batched })}</BodyNote>
      ) : null}
      {children}
    </ActivityDisclosure>
  );
}

function ImageRetrievalError({ noun = "image", retry }: { noun?: string; retry: () => void }) {
  const msg = useOpenGeniText();
  return (
    <BodyNote tone="error">
      {noun === "screenshot"
        ? msg("timeline.toolRenderers.screenshot")
        : msg("timeline.toolRenderers.image")}{" "}
      {msg("timeline.toolRenderers.retrievalFailed")}{" "}
      <button
        type="button"
        aria-label={msg("timeline.toolRenderers.retryNounRetrieval", { noun })}
        onClick={retry}
        className="underline underline-offset-2"
      >
        {msg("timeline.toolRenderers.retry")}
      </button>
    </BodyNote>
  );
}

function GeneratedImageRenderer({ item, loadRetainedArtifact }: ToolRendererProps) {
  const msg = useOpenGeniText();
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
        title={msg("timeline.toolRenderers.generatingImage")}
        running
        preview={
          <RunningPreview>
            {truncatePreview(prompt, 72) || msg("timeline.toolRenderers.creating")}
          </RunningPreview>
        }
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
  const msg = useOpenGeniText();
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
        running
          ? msg("timeline.toolRenderers.startingVideoGeneration")
          : accepted
            ? msg("timeline.toolRenderers.generatingVideo")
            : msg("timeline.toolRenderers.generateVideo")
      }
      running={running}
      failed={failed}
      cancelled={cancelled}
      preview={
        truncatePreview(prompt, 88) ||
        (accepted ? msg("timeline.toolRenderers.requestAccepted") : undefined)
      }
    >
      {prompt ? <BodyNote>{prompt}</BodyNote> : null}
      {accepted ? (
        <BodyNote>{msg("timeline.toolRenderers.theVideoWillAppearHere")}</BodyNote>
      ) : item.output !== undefined ? (
        <PayloadBlock label={msg("timeline.toolRenderers.output")} value={item.output} />
      ) : null}
    </ActivityDisclosure>
  );
}
function SandboxFilePublishRenderer({ item, loadRetainedArtifact }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const plain = useToolDetails() === "plain";
  const { text: output, isError } = unwrapMcpOutput(item.output);
  const receipt = parseSandboxFileArtifactReceipt(output);
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "error">("idle");
  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<DownloadIcon className={ICON_SIZE} />}
        iconTone="running"
        title={msg("timeline.toolRenderers.publishingFile")}
        running
        preview={
          <RunningPreview>{msg("timeline.toolRenderers.retainingWorkspaceBytes")}</RunningPreview>
        }
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
      aria-label={msg("timeline.toolRenderers.openFilenameInArtifacts", {
        filename: receipt.filename,
      })}
      className="inline-flex min-h-7 items-center rounded-og-sm px-2 text-og-sm font-medium text-og-accent-strong hover:bg-og-surface-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-10"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {msg("timeline.toolRenderers.openInArtifacts")}
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
        ? msg("timeline.toolRenderers.preparing")
        : downloadState === "error"
          ? msg("timeline.toolRenderers.retryDownload")
          : msg("timeline.toolRenderers.download")}
    </button>
  );

  if (isRetainedImageContentType(receipt.artifact.contentType)) {
    return (
      <RetainedSessionImageDisclosure
        artifact={receipt.artifact}
        load={loadRetainedArtifact}
        title={msg("timeline.toolRenderers.publishedFilename", { filename: receipt.filename })}
        caption={receipt.filename}
        noun="image"
        icon={<ImageIcon className={ICON_SIZE} />}
        lightboxLabel={msg("timeline.toolRenderers.image")}
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
      title={msg("timeline.toolRenderers.publishedFilename", { filename: receipt.filename })}
      defaultOpen
      preview={formatBytes(receipt.artifact.originalBytes)}
    >
      {downloadButton}
      {openLink}
      {plain ? null : isPatchFilename(receipt.filename) ? (
        <PatchApplyCommand
          artifact={receipt.artifact}
          filename={receipt.filename}
          load={loadRetainedArtifact}
        />
      ) : null}
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
  const msg = useOpenGeniText();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // The console route only exists in the Opengeni console; a host decides.
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
        aria-label={msg("timeline.toolRenderers.openTitle", { title: receipt.title })}
        className={SITE_OPEN_CLASS}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {msg("timeline.toolRenderers.open")}
      </a>
    );
  }
  if (resolution?.open) {
    const open = resolution.open;
    return (
      <button
        type="button"
        aria-label={msg("timeline.toolRenderers.openTitle", { title: receipt.title })}
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
        {pending
          ? msg("timeline.toolRenderers.opening")
          : failed
            ? msg("timeline.toolRenderers.retryOpen")
            : msg("timeline.toolRenderers.open")}
      </button>
    );
  }
  return null;
}

function SiteArtifactRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const leaf = mcpToolLeaf(item.name);
  const publishingExisting = leaf === "artifacts_publish";
  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<PanelsTopLeftIcon className={ICON_SIZE} />}
        iconTone="running"
        title={
          publishingExisting
            ? msg("timeline.toolRenderers.publishingSiteUpdate")
            : msg("timeline.toolRenderers.publishingSite")
        }
        running
        preview={
          <RunningPreview>
            {msg("timeline.toolRenderers.retainingSourceAndCompiledHtml")}
          </RunningPreview>
        }
      />
    );
  }
  const receipt = publishedSiteReceipt(item.output);
  if (!receipt || item.status === "failed") return <GenericRenderer item={item} />;
  return (
    <ActivityDisclosure
      icon={<PanelsTopLeftIcon className={ICON_SIZE} />}
      iconTone="accent"
      title={
        publishingExisting
          ? msg("timeline.toolRenderers.updatedTitle", { title: receipt.title })
          : msg("timeline.toolRenderers.publishedTitle", { title: receipt.title })
      }
      media={<SiteOpenLink receipt={receipt} />}
    >
      <BodyNote>
        {msg("timeline.toolRenderers.versionRevisionIsLive", { revision: receipt.revision })}
        {receipt.replayed
          ? ` ${msg("timeline.toolRenderers.replayedFromTheOriginalPublication")}`
          : "."}
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
  const msg = useOpenGeniText();
  const state = useRetainedImageObjectUrl(receipt.artifact, load);
  const dimensions = receipt.artifact.dimensions!;
  const title = failed
    ? msg("timeline.toolRenderers.imageGenerationFailed")
    : msg("timeline.toolRenderers.generatedImage");
  const caption =
    prompt ||
    msg("timeline.toolRenderers.generatedImageWidthHeight", {
      width: dimensions.width,
      height: dimensions.height,
    });
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
          ? msg("timeline.toolRenderers.loadingImage")
          : state.kind === "error"
            ? msg("timeline.toolRenderers.imageRetrievalFailed")
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
            expandLabel={msg("timeline.toolRenderers.expandGeneratedImage")}
            lightboxLabel={msg("timeline.toolRenderers.generatedImage")}
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
          expandLabel={msg("timeline.toolRenderers.expandGeneratedImage")}
          lightboxLabel={msg("timeline.toolRenderers.generatedImage")}
        />
      ) : state.kind === "loading" ? (
        <BodyNote>{msg("timeline.toolRenderers.loadingTheGeneratedImage")}</BodyNote>
      ) : state.kind === "unavailable" ? (
        <BodyNote>{msg("timeline.toolRenderers.imageLabel", { label: state.label })}</BodyNote>
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

// Fragments of the tool's own (English) error output; matched, never displayed.
const VIEW_IMAGE_ERRORS = (msg: OpenGeniText) => [
  msg("timeline.toolRenderers.wasNotFound"),
  msg("timeline.toolRenderers.isNotAFile"),
  msg("timeline.toolRenderers.exceededTheAllowedSize"),
  msg("timeline.toolRenderers.isNotASupportedImage"),
  msg("timeline.toolRenderers.unableToReadImage"),
];

function ViewImageRenderer({ item, loadRetainedScreenshot }: ToolRendererProps) {
  const msg = useOpenGeniText();
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
        title={msg("timeline.toolRenderers.viewPathbasename", { pathBasename: pathBasename(path) })}
        running
        preview={<RunningPreview>{msg("timeline.toolRenderers.reading")}</RunningPreview>}
        media={<MediaSkeleton />}
      >
        <BodyNote>{msg("timeline.toolRenderers.readingImage")}</BodyNote>
      </ActivityDisclosure>
    );
  }

  const viewFailed = item.status === "failed";
  const viewCancelled = item.status === "cancelled";

  if (retained) {
    const title = msg("timeline.toolRenderers.viewedPathbasename", {
      pathBasename: pathBasename(path),
    });
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
            {msg("timeline.toolRenderers.imageStateReplaceall", {
              state,
              replaceAll: retained.reason.replaceAll("_", " "),
            })}
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
        lightboxLabel={msg("timeline.toolRenderers.image")}
        batched={null}
        failed={viewFailed}
        cancelled={viewCancelled}
      />
    );
  }

  const errMatch = VIEW_IMAGE_ERRORS(msg).find((p) => text.includes(p));
  if (errMatch) {
    const tooBig = text.includes("exceeded the allowed size");
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={msg("timeline.toolRenderers.viewPathbasename", { pathBasename: pathBasename(path) })}
        chip={{
          tone: "bad",
          text: tooBig ? msg("timeline.toolRenderers.tooLarge") : msg("timeline.chip.error"),
        }}
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
        title={msg("timeline.toolRenderers.viewedPathbasename", {
          pathBasename: pathBasename(path),
        })}
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
        title={msg("timeline.toolRenderers.viewedPathbasenameImageOmittedNot", {
          pathBasename: pathBasename(path),
        })}
        failed={viewFailed}
        cancelled={viewCancelled}
        preview={msg("timeline.toolRenderers.inlineImageOmittedNotRetained")}
        media={<MediaEmpty />}
      >
        <BodyNote>
          {msg("timeline.toolRenderers.theInlineMediatypeOutputWas", {
            mediaType: omittedMedia.mediaType,
          })}
        </BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.includes("No image data")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone={viewFailed ? "failed" : "muted"}
        title={msg("timeline.toolRenderers.viewedPathbasename", {
          pathBasename: pathBasename(path),
        })}
        failed={viewFailed}
        cancelled={viewCancelled}
        preview={msg("timeline.toolRenderers.noImage")}
      >
        <BodyNote>
          {viewFailed
            ? msg("timeline.toolRenderers.viewImageFailedNoImage")
            : viewCancelled
              ? msg("timeline.toolRenderers.viewImageInterrupted")
              : msg("timeline.toolRenderers.noImageTheSandboxSession")}
        </BodyNote>
      </ActivityDisclosure>
    );
  }
  if (text.startsWith("data:")) {
    return (
      <ActivityDisclosure
        icon={<ImageIcon className={ICON_SIZE} />}
        iconTone={viewFailed ? "failed" : "accent"}
        title={msg("timeline.toolRenderers.viewedPathbasename", {
          pathBasename: pathBasename(path),
        })}
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

/** Plain tool details read this tool through the shared row model (no raw detail). */
function SecretSetRenderer(props: ToolRendererProps) {
  return useToolDetails() === "plain" ? (
    <UnreviewedGenericRenderer {...props} />
  ) : (
    <FullSecretSetRenderer {...props} />
  );
}

function FullSecretSetRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const args = parseToolArgs(item.arguments);
  const name = typeof args.name === "string" ? args.name : "variable";

  if (item.status === "running") {
    return (
      <ActivityDisclosure
        icon={<KeyRoundIcon className={ICON_SIZE} />}
        iconTone="running"
        title={msg("timeline.toolRenderers.setName", { name })}
        running
        preview={<RunningPreview>{msg("timeline.toolRenderers.setting")}</RunningPreview>}
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
      </ActivityDisclosure>
    );
  }

  if (item.status === "failed") {
    const errorText = typeof item.output === "string" ? item.output : null;
    return (
      <ActivityDisclosure
        icon={<KeyRoundIcon className={ICON_SIZE} />}
        iconTone="failed"
        title={msg("timeline.toolRenderers.setName", { name })}
        failed
        preview={errorText ?? msg("timeline.toolRenderers.variableWriteFailed")}
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
        {errorText ? (
          <PayloadBlock label={msg("timeline.toolRenderers.error")} value={errorText} failed />
        ) : (
          <BodyNote tone="error">{msg("timeline.toolRenderers.theToolCallFailedWith")}</BodyNote>
        )}
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<KeyRoundIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={msg("timeline.toolRenderers.setName", { name })}
      cancelled={item.status === "cancelled"}
      preview="exact value preserved"
    >
      <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
      <BodyNote>{msg("timeline.toolRenderers.theConfiguredValueIsPreserved")}</BodyNote>
    </ActivityDisclosure>
  );
}

/* ---- tool_search (progressive MCP disclosure) ------------------------------ */

/** Plain tool details read this tool through the shared row model (no raw detail). */
function ToolSearchRenderer(props: ToolRendererProps) {
  return useToolDetails() === "plain" ? (
    <UnreviewedGenericRenderer {...props} />
  ) : (
    <FullToolSearchRenderer {...props} />
  );
}

function FullToolSearchRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const query = toolSearchQuery(item);
  const icon = <PackageSearchIcon className={ICON_SIZE} />;
  const running = item.status === "running";
  const queryPreview = query ? truncatePreview(query, 64) : "";

  if (running) {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="running"
        title={msg("timeline.toolRenderers.lookingUpTools")}
        running
        preview={
          queryPreview ? (
            <RunningPreview>{queryPreview}</RunningPreview>
          ) : (
            <RunningPreview>{msg("timeline.toolRenderers.matchingCapabilities")}</RunningPreview>
          )
        }
      >
        {query ? (
          <BodyNote>{msg("timeline.toolRenderers.capabilityQueryQuery", { query })}</BodyNote>
        ) : null}
        <PayloadBlock
          label={msg("timeline.toolRenderers.arguments")}
          value={parseToolArgs(item.arguments)}
        />
      </ActivityDisclosure>
    );
  }

  const { text: outText, isError } = unwrapMcpOutput(item.output);
  if ((isError || item.status === "failed") && item.status !== "cancelled") {
    return (
      <ActivityDisclosure
        icon={icon}
        iconTone="failed"
        title={msg("timeline.toolRenderers.toolLookupFailed")}
        failed
        preview={
          truncatePreview(outText, 80) || queryPreview || msg("timeline.toolRenderers.lookupFailed")
        }
      >
        {query ? (
          <BodyNote>{msg("timeline.toolRenderers.capabilityQueryQuery", { query })}</BodyNote>
        ) : null}
        <PayloadBlock
          label={msg("timeline.toolRenderers.arguments")}
          value={parseToolArgs(item.arguments)}
        />
        <PayloadBlock label={msg("timeline.toolRenderers.error")} value={outText} failed />
      </ActivityDisclosure>
    );
  }

  const tools = parseDisclosedTools(item.output);
  const preview = toolSearchPreview(msg, tools, item.status === "cancelled");

  return (
    <ActivityDisclosure
      icon={icon}
      iconTone="muted"
      title={msg("timeline.toolRenderers.lookedUpTools")}
      cancelled={item.status === "cancelled"}
      preview={preview}
    >
      {query ? (
        <BodyNote>{msg("timeline.toolRenderers.capabilityQueryQuery", { query })}</BodyNote>
      ) : null}
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
            <li className="text-og-xs text-og-fg-muted">
              +{tools.length - 12} {msg("timeline.toolRenderers.more")}
            </li>
          ) : null}
        </ul>
      ) : tools && tools.length === 0 ? (
        <BodyNote>{msg("timeline.toolRenderers.noDeferredToolsMatchedThis")}</BodyNote>
      ) : null}
      <PayloadBlock
        label={msg("timeline.toolRenderers.arguments")}
        value={parseToolArgs(item.arguments)}
      />
      {tools == null && outText ? (
        <PayloadBlock label={msg("timeline.toolRenderers.result")} value={outText} />
      ) : null}
    </ActivityDisclosure>
  );
}

/* ---- docs / knowledge search ----------------------------------------------- */

/** Plain tool details read this tool through the shared row model (no raw detail). */
function DocsSearchRenderer(props: ToolRendererProps) {
  return useToolDetails() === "plain" ? (
    <UnreviewedGenericRenderer {...props} />
  ) : (
    <FullDocsSearchRenderer {...props} />
  );
}

function FullDocsSearchRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const args = parseToolArgs(item.arguments);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const title = query
    ? msg("timeline.toolRenderers.searchTruncatepreview", {
        truncatePreview: truncatePreview(query, 48),
      })
    : toolDisplayName(msg, item.name, item.display);
  const running = item.status === "running";

  if (running) {
    return (
      <ActivityDisclosure
        icon={<FileSearchIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        running
        preview={<RunningPreview>{msg("timeline.toolRenderers.searching")}</RunningPreview>}
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
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
        preview={truncatePreview(outText, 80) || msg("timeline.toolRenderers.searchFailed")}
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
        <PayloadBlock label={msg("timeline.toolRenderers.error")} value={outText} failed />
      </ActivityDisclosure>
    );
  }

  const hits = parseSearchHits(msg, outText);
  const preview =
    item.status === "cancelled"
      ? undefined
      : hits
        ? hits.length === 0
          ? msg("timeline.toolRenderers.noHits")
          : msg("counts.hits", { count: hits.length })
        : msg("timeline.toolRenderers.done");

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
      <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
      <PayloadBlock label={msg("timeline.toolRenderers.result")} value={outText} />
    </ActivityDisclosure>
  );
}

/* ---- set_session_title / set_other_session_title --------------------------- */

/** Plain tool details read this tool through the shared row model (no raw detail). */
function SetSessionTitleRenderer(props: ToolRendererProps) {
  return useToolDetails() === "plain" ? (
    <UnreviewedGenericRenderer {...props} />
  ) : (
    <FullSetSessionTitleRenderer {...props} />
  );
}

function FullSetSessionTitleRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const args = parseToolArgs(item.arguments);
  const titleArg = typeof args.title === "string" ? args.title.trim() : "";
  const display = toolDisplayName(msg, item.name, item.display);
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
            <RunningPreview>{msg("timeline.toolRenderers.settingTitle")}</RunningPreview>
          )
        }
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
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
        preview={truncatePreview(outText, 80) || msg("timeline.toolRenderers.renameFailed")}
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
        <PayloadBlock label={msg("timeline.toolRenderers.error")} value={outText} failed />
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
      <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
      {outText ? (
        <PayloadBlock label={msg("timeline.toolRenderers.result")} value={outText} />
      ) : null}
    </ActivityDisclosure>
  );
}

/* ---- company memory propose (docs MCP) ------------------------------------- */

/** Plain tool details read this tool through the shared row model (no raw detail). */
function MemoryProposeRenderer(props: ToolRendererProps) {
  return useToolDetails() === "plain" ? (
    <UnreviewedGenericRenderer {...props} />
  ) : (
    <FullMemoryProposeRenderer {...props} />
  );
}

function FullMemoryProposeRenderer({ item }: ToolRendererProps) {
  const msg = useOpenGeniText();
  const args = parseToolArgs(item.arguments);
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const title = msg("timeline.toolRenderers.proposeMemory");
  const running = item.status === "running";

  if (running) {
    return (
      <ActivityDisclosure
        icon={<BrainCircuitIcon className={ICON_SIZE} />}
        iconTone="running"
        title={title}
        running
        preview={<RunningPreview>{msg("timeline.toolRenderers.proposing")}</RunningPreview>}
      >
        <PayloadBlock label={msg("timeline.toolRenderers.arguments")} value={args} />
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
        preview={truncatePreview(outText, 80) || msg("timeline.toolRenderers.proposeFailed")}
      >
        {text ? <BodyNote>{text}</BodyNote> : null}
        <PayloadBlock label={msg("timeline.toolRenderers.error")} value={outText} failed />
      </ActivityDisclosure>
    );
  }

  return (
    <ActivityDisclosure
      icon={<BrainCircuitIcon className={ICON_SIZE} />}
      iconTone="muted"
      title={title}
      cancelled={item.status === "cancelled"}
      preview={text ? truncatePreview(text, 90) : msg("timeline.toolRenderers.done")}
    >
      {text ? <BodyNote>{text}</BodyNote> : null}
      <PayloadBlock label={msg("timeline.toolRenderers.result")} value={outText} />
    </ActivityDisclosure>
  );
}

/* ---- request_human_input --------------------------------------------------- */

/* ---- run_on ---------------------------------------------------------------- */

/* ---- generic fallback (first-party MCP, external MCP, unknown) ------------- */

/**
 * Baseline craft for unmatched tools: family icon + title-cased leaf + honest
 * status preview (Running… / Done / error snippet). No argument-field sniffing —
 * JSON stays in the expandable body only.
 */
function GenericRenderer(props: ToolRendererProps) {
  const reviewed = useHasToolReview(props.item.callId);
  if (reviewed && props.item.callId) return <ReviewedGenericRenderer {...props} />;
  return <UnreviewedGenericRenderer {...props} />;
}

/** Settled review states earn one quiet gutter word; success and waiting stay chip-free. */
const REVIEW_CHIP = (msg: OpenGeniText): Partial<Record<ToolReviewStatus, DisclosureChip>> => ({
  rejected: { tone: "interrupted", text: msg("timeline.chip.declined") },
  cancelled: { tone: "interrupted", text: msg("timeline.toolRenderers.notRun") },
  expired: { tone: "interrupted", text: msg("timeline.chip.expired") },
  stale: { tone: "interrupted", text: msg("timeline.toolRenderers.notRun") },
  revoked: { tone: "interrupted", text: msg("timeline.toolRenderers.notRun") },
  blocked: { tone: "interrupted", text: msg("timeline.chip.blocked") },
  unknown: { tone: "bad", text: msg("timeline.toolRenderers.outcomeUnknown") },
  partial: { tone: "bad", text: msg("timeline.toolRenderers.partlyDone") },
  failed: { tone: "bad", text: msg("timeline.chip.failed") },
});

/**
 * A call that went through approval keeps the ordinary row shape, titled with
 * what was approved. The expanded body is the saved review plus the result.
 */
function ReviewedGenericRenderer(props: ToolRendererProps) {
  const msg = useOpenGeniText();
  const { item } = props;
  const { review, onViewDetails } = useRecordedToolReview(item.callId);
  const logo = useToolConnectorLogo(item.display);
  if (!review) return <UnreviewedGenericRenderer {...props} />;
  const ReviewIcon = toolIcon(genericToolIconKind(item.name));
  const icon = <ConnectorLogoIcon src={logo} fallback={<ReviewIcon className={ICON_SIZE} />} />;
  const waiting = review.status === "pending";
  const running =
    !waiting &&
    (review.status === "executing" || review.status === "approved") &&
    item.status === "running";
  const { text: outText, isError } = unwrapMcpOutput(retainedToolResultImages(item.output).output);
  const chip =
    REVIEW_CHIP(msg)[review.status] ??
    (isError && !running && !waiting
      ? ({ tone: "bad", text: msg("timeline.chip.error") } as const)
      : undefined);
  return (
    <ActivityDisclosure
      icon={icon}
      iconTone={chip?.tone === "bad" ? "failed" : waiting ? "accent" : "muted"}
      title={review.title}
      running={running}
      chip={chip}
      preview={
        waiting ? (
          msg("timeline.toolRenderers.waitingForYourApproval")
        ) : running ? (
          <RunningPreview>{msg("timeline.toolRenderers.running")}</RunningPreview>
        ) : item.display?.connector ? (
          // The logo names the connector; only a second account needs words.
          (item.display.accountLabel ?? undefined)
        ) : (
          (review.accountLabel ?? undefined)
        )
      }
    >
      <div className="py-1" data-approval-id={item.callId} data-review-origin="history">
        <ToolActionReviewCard
          bare
          review={{ ...review, availableActions: [] }}
          onViewDetails={onViewDetails}
        />
      </div>
      {outText ? (
        <PayloadBlock
          label={msg("timeline.toolRenderers.result")}
          value={outText}
          failed={isError}
        />
      ) : null}
    </ActivityDisclosure>
  );
}

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
  { match: "name", name: "sandboxes_list", render: MachineRenderer },
  { match: "name", name: "sandbox_swap", render: MachineRenderer },
  { match: "name", name: "computer_open", render: MachineRenderer },
  { match: "name", name: "computer_observe", render: MachineRenderer },
  { match: "name", name: "computer_act", render: MachineRenderer },
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

/** Built-in renderers that draw their row from the shared presentation. */
const PRESENTATION_RENDERERS: ReadonlyMap<ToolRenderer, PresentedToolKind> = new Map<
  ToolRenderer,
  PresentedToolKind
>([
  [ExecRenderer, "exec"],
  [WriteStdinRenderer, "write_stdin"],
  [ApplyPatchRenderer, "apply_patch"],
  [GenericRenderer, "generic"],
]);

/**
 * Whether `renderer` can draw `item` while its output is a bounded preview
 * (see {@link presentsToolOutputPreview}). Every other row (media, receipts,
 * cards that parse their result, consumer renderers) needs its exact output
 * before it renders.
 */
export function rendersToolOutputPreview(renderer: ToolRenderer, item: ToolCallItem): boolean {
  if (!item.outputPreview) return true;
  return (
    PRESENTATION_RENDERERS.get(renderer) === presentedToolKind(item) &&
    presentsToolOutputPreview(item)
  );
}

/** The built-in tool renderer registry: every first-party tool plus a fallback. */
export const defaultToolRegistry: ToolRegistry = createToolRegistry(BASE_ENTRIES, GenericRenderer);

/** Build a registry that extends the built-ins with consumer entries/fallback. */
export function createDefaultToolRegistry(
  options: Parameters<typeof createToolRegistry>[2] = {},
): ToolRegistry {
  return createToolRegistry(BASE_ENTRIES, GenericRenderer, options);
}
