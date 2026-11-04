import type {
  ActivityItem,
  AgentMessageItem,
  ReasoningItem,
  SandboxItem,
  ToolCallItem,
  WorkerItem,
} from "@opengeni/react/session";
import {
  pathBasename,
  pathDirname,
  presentsToolOutputPreview,
  sandboxRowTitle,
  startupDuration,
  startupPhaseTitle,
  STARTUP_WAIT_TITLES,
  toolDisplayName,
  toolRowPresentation,
  workerRowTitle,
  type ToolBody,
  type ToolDetails,
  type ToolIconKind,
  type ToolPreview,
  type ToolRowPresentation,
  type WebSearchResult,
} from "@opengeni/react/timeline-model";
import { useOpenGeniText } from "@opengeni/react/messages";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, type NativeIconName } from "./icon";
import {
  ActivityDisclosure,
  BodyNote,
  Chip,
  PayloadBlock,
  RunningPreview,
  ShimmerText,
  TermBlock,
  ROW_MIN_HEIGHT,
} from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import { useNativeTimelineMessages } from "./messages";
import { annotationSourceTestId } from "./text-selection";

/* ----------------------------------------------------------------------------
   Native activity rows. Tool rows draw from the shared presentation model
   (`toolRowPresentation`), the same source the web renderers use; hosts can
   replace a tool's row via `NativeToolRenderers` (e.g. product-specific tools).
   -------------------------------------------------------------------------- */

export type NativeToolRendererProps = {
  item: ToolCallItem;
  presentation: ToolRowPresentation;
  compact: boolean;
};

/** Return null to fall back to the shared row. */
export type NativeToolRenderer = (props: NativeToolRendererProps) => ReactNode | null;

export interface NativeActivityOptions {
  /** Per-tool overrides keyed by exact tool name or MCP leaf. */
  toolRenderers?: Record<string, NativeToolRenderer> | undefined;
  /** Host renderer consulted for every tool call (return null for the shared row). */
  renderTool?: NativeToolRenderer | undefined;
  /** Active compute label for exec previews ("on <label> · …"). */
  computeLabel?: string | null | undefined;
  /**
   * `"plain"` keeps every tool step visible with its plain name and status but
   * never shows raw arguments, output or JSON. Defaults to `"full"`.
   */
  toolDetails?: ToolDetails | undefined;
  renderMarkdown?:
    | ((text: string, options: { tone: "body" | "muted"; streaming?: boolean }) => ReactNode)
    | undefined;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}

const ActivityOptionsContext = createContext<NativeActivityOptions>({});
export const NativeActivityOptionsProvider = ActivityOptionsContext.Provider;
export function useNativeActivityOptions(): NativeActivityOptions {
  return useContext(ActivityOptionsContext);
}

const TOOL_ICON: Record<ToolIconKind, NativeIconName> = {
  terminal: "terminal",
  keyboard: "keyboard",
  "file-diff": "file-diff",
  search: "search",
  question: "message-circle-question",
  target: "target",
  brain: "brain-circuit",
  sessions: "messages-square",
  server: "server",
  "server-cog": "server-cog",
  calendar: "calendar-clock",
  panels: "panels-top-left",
  share: "share-2",
  message: "message-square",
  git: "folder-git",
  box: "box",
  key: "key-round",
  "file-search": "file-search",
  "package-search": "package-search",
  plug: "plug",
  browser: "globe",
  screen: "monitor",
  spreadsheet: "file-spreadsheet",
  wait: "hourglass",
  download: "download",
  clipboard: "clipboard",
  image: "image",
  video: "video",
  record: "circle-dot",
  document: "file-text",
  file: "file",
  attachment: "paperclip",
  archive: "archive",
  folder: "folder",
  site: "app-window",
  skill: "graduation-cap",
  settings: "settings",
  bell: "bell",
  phone: "phone",
  inbox: "inbox",
  help: "hand",
  model: "sparkles",
  progress: "activity",
  helper: "bot",
  "sign-in": "log-in",
  code: "code",
  accounting: "receipt",
  rename: "pencil",
  wrench: "wrench",
};

function PreviewNode({ preview, compact }: { preview: ToolPreview; compact: boolean }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const mono = { ...fontStyle(theme, 400, "mono"), fontSize: theme.size.sm, lineHeight: 18 };
  switch (preview.kind) {
    case "text":
      return preview.running ? (
        <RunningPreview text={preview.text} compact={compact} />
      ) : (
        <>{preview.text}</>
      );
    case "path":
      return (
        <Text numberOfLines={1} style={mono}>
          <Text style={{ color: theme.colors["fg-subtle"] }}>{pathDirname(preview.path)}</Text>
          <Text style={{ color: theme.colors["fg-muted"] }}>{pathBasename(preview.path)}</Text>
          {preview.add != null || preview.del != null ? (
            <Text style={{ color: theme.colors["fg-subtle"] }}>
              {"  "}
              {preview.add != null ? `+${preview.add}` : ""}
              {preview.add != null && preview.del != null ? " " : ""}
              {preview.del != null ? `−${preview.del}` : ""}
            </Text>
          ) : null}
        </Text>
      );
    case "files":
      return (
        <Text numberOfLines={1} style={mono}>
          <Text style={{ color: theme.colors["fg-muted"] }}>
            {t("native.timeline.activity.countvalueFiles", { countValue: preview.count })}
          </Text>
          <Text
            style={{ color: theme.colors["fg-subtle"] }}
          >{`  +${preview.add} −${preview.del}`}</Text>
        </Text>
      );
    case "malformed":
      return (
        <Text numberOfLines={1} style={mono}>
          <Text style={{ color: theme.colors["fg-muted"] }}>{preview.name}</Text>
          <Text style={{ color: theme.colors["fg-subtle"] }}>{"  malformed V4A"}</Text>
        </Text>
      );
  }
}

function previewContent(preview: ToolPreview, compact: boolean): ReactNode {
  if (preview.kind === "text" && !preview.running) return preview.text;
  return <PreviewNode preview={preview} compact={compact} />;
}

function keyedResults(results: readonly WebSearchResult[]) {
  const seen = new Map<string, number>();
  return results.map((result) => {
    const content = `${result.domain}\u0000${result.title}\u0000${result.snippet}`;
    const occurrence = (seen.get(content) ?? 0) + 1;
    seen.set(content, occurrence);
    return { key: `${content}\u0000${occurrence}`, result };
  });
}

function ToolBodyView({ body }: { body: ToolBody }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  switch (body.kind) {
    case "term":
      return (
        <>
          <TermBlock
            command={body.command}
            workdir={body.workdir}
            output={body.output}
            live={body.live}
            failed={body.failed}
          />
          {body.note ? <BodyNote>{body.note}</BodyNote> : null}
        </>
      );
    case "note":
      return <BodyNote tone={body.tone}>{body.text}</BodyNote>;
    case "payloads":
      return (
        <>
          {body.blocks.map((block) => (
            <PayloadBlock
              key={block.label}
              label={block.label}
              value={block.value}
              failed={block.failed}
            />
          ))}
        </>
      );
    case "patch":
      return (
        <>
          {body.files.map((entry) => (
            <PatchView key={entry.key} path={entry.path} diff={entry.diff} bare={body.bare} />
          ))}
        </>
      );
    case "web-results":
      if (!body.results?.length) {
        return <BodyNote>{t("native.timeline.activity.resultsFoldedIntoModelContext")}</BodyNote>;
      }
      return (
        <View style={{ gap: 8 }}>
          {keyedResults(body.results).map(({ key, result }) => (
            <View key={key} style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ marginTop: 3 }}>
                <Icon name="globe" size={14} color={theme.colors["fg-subtle"]} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{ ...fontStyle(theme), fontSize: theme.size.base, color: theme.colors.fg }}
                >
                  {result.title}{" "}
                  <Text style={{ color: theme.colors["fg-subtle"] }}>{result.domain}</Text>
                </Text>
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: theme.size.sm,
                    lineHeight: 20,
                    color: theme.colors["fg-muted"],
                  }}
                >
                  {result.snippet}
                </Text>
              </View>
            </View>
          ))}
        </View>
      );
    case "none":
      return null;
    case "listing":
      return (
        <>
          {body.note ? <BodyNote>{body.note}</BodyNote> : null}
          {body.entries.length > 0 ? (
            <View style={{ gap: body.entries.some((entry) => entry.snippet) ? 8 : 6 }}>
              {body.entries.map((entry) => (
                <View key={entry.key} style={{ minWidth: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                    {entry.eyebrow ? (
                      <Text
                        style={{
                          ...fontStyle(theme),
                          fontSize: theme.size.xs,
                          color: theme.colors["fg-subtle"],
                        }}
                      >
                        {entry.eyebrow}
                      </Text>
                    ) : null}
                    <Text
                      numberOfLines={1}
                      style={{
                        ...(entry.mono ? fontStyle(theme, 400, "mono") : fontStyle(theme, 500)),
                        fontSize: theme.size.sm,
                        color: theme.colors.fg,
                        flexShrink: 1,
                      }}
                    >
                      {entry.title}
                    </Text>
                  </View>
                  {entry.snippet ? (
                    <Text
                      numberOfLines={2}
                      style={{
                        ...fontStyle(theme),
                        marginTop: 2,
                        fontSize: theme.size.xs,
                        color: theme.colors["fg-muted"],
                      }}
                    >
                      {entry.snippet}
                    </Text>
                  ) : null}
                </View>
              ))}
              {body.more ? (
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: theme.size.xs,
                    color: theme.colors["fg-muted"],
                  }}
                >
                  {t("native.timeline.activity.moreMore", { more: body.more })}
                </Text>
              ) : null}
            </View>
          ) : body.empty ? (
            <BodyNote>{body.empty}</BodyNote>
          ) : null}
          {body.blocks.map((block) => (
            <PayloadBlock
              key={block.label}
              label={block.label}
              value={block.value}
              failed={block.failed}
            />
          ))}
        </>
      );
  }
}

/** Unified-diff-ish view of a V4A patch: add/del gutters tinted like the web diff. */
function PatchView({
  path,
  diff,
  bare,
}: {
  path: string;
  diff: string;
  bare?: boolean | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const mono = { ...fontStyle(theme, 400, "mono"), fontSize: theme.size.xs, lineHeight: 18 };
  let offset = 0;
  const lines = diff
    .split("\n")
    .map((text) => {
      const entry = { text, key: `l${offset}` };
      offset += text.length + 1;
      return entry;
    })
    .filter((entry) => !entry.text.startsWith("*** "));
  return (
    <View
      style={{
        borderRadius: theme.radius.sm,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden",
      }}
    >
      {bare ? null : (
        <Text
          style={[
            mono,
            {
              paddingHorizontal: 8,
              paddingVertical: 6,
              color: theme.colors["fg-muted"],
              backgroundColor: theme.colors["surface-2"],
            },
          ]}
          numberOfLines={1}
        >
          {path}
        </Text>
      )}
      {lines.slice(0, 400).map(({ text: line, key }) => (
        <Text
          key={key}
          style={[
            mono,
            {
              paddingHorizontal: 8,
              color: theme.colors["fg-muted"],
              backgroundColor: line.startsWith("+")
                ? theme.colors["diff-add-bg"]
                : line.startsWith("-")
                  ? theme.colors["diff-del-bg"]
                  : "transparent",
            },
          ]}
        >
          {line || " "}
        </Text>
      ))}
    </View>
  );
}

export function PresentedToolRow({
  presentation: p,
  compact = false,
  outputPreview,
}: {
  presentation: ToolRowPresentation;
  compact?: boolean;
  /** The row's output preview, when its output is not exact. */
  outputPreview?: ToolCallItem["outputPreview"];
}) {
  return (
    <ActivityDisclosure
      icon={TOOL_ICON[p.icon]}
      iconTone={p.iconTone}
      title={p.title}
      titleMono={p.titleMono}
      running={p.running}
      chip={p.chip}
      failed={p.failed}
      cancelled={p.cancelled}
      compact={compact}
      preview={p.preview ? previewContent(p.preview, compact) : undefined}
      expandable={p.body.kind !== "none"}
      outputPreview={outputPreview}
    >
      <ToolBodyView body={p.body} />
    </ActivityDisclosure>
  );
}

function ToolCallRow({ item, compact }: { item: ToolCallItem; compact: boolean }) {
  const t = useOpenGeniText();
  const options = useNativeActivityOptions();
  const presentation = toolRowPresentation(t, item, {
    computeLabel: options.computeLabel ?? null,
    details: options.toolDetails ?? "full",
  });
  const leaf = item.name.includes("__")
    ? item.name.slice(item.name.lastIndexOf("__") + 2)
    : item.name;
  const custom = options.toolRenderers?.[item.name] ?? options.toolRenderers?.[leaf];
  const outputPreview = item.outputPreview ?? null;
  // Custom renderers and presentations that parse their result need the
  // exact output first; a failed read falls back to the built-in row, which
  // says it is a preview.
  const exactFirst =
    outputPreview !== null &&
    (custom !== undefined || options.renderTool !== undefined || !presentsToolOutputPreview(item));
  if (exactFirst && outputPreview.load && outputPreview.state !== "error") {
    return <ToolOutputExactRow item={item} preview={outputPreview} compact={compact} />;
  }
  if (!exactFirst) {
    for (const renderer of [custom, options.renderTool]) {
      if (!renderer) continue;
      const node = renderer({ item, presentation, compact });
      if (node != null) return <>{node}</>;
    }
  }
  return (
    <PresentedToolRow presentation={presentation} compact={compact} outputPreview={outputPreview} />
  );
}

/** A tool row reading its exact output before it renders. */
function ToolOutputExactRow({
  item,
  preview,
  compact,
}: {
  item: ToolCallItem;
  preview: NonNullable<ToolCallItem["outputPreview"]>;
  compact: boolean;
}) {
  const t = useOpenGeniText();
  const pending = preview.state === "preview";
  const load = preview.load;
  useEffect(() => {
    if (pending) load?.();
  }, [pending, load]);
  return (
    <ActivityDisclosure
      icon="wrench"
      title={toolDisplayName(t, item.name)}
      preview={t("timeline.toolRenderers.loadingOutput")}
      compact={compact}
      expandable={false}
    />
  );
}

function ReasoningRow({ item, compact }: { item: ReasoningItem; compact: boolean }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const options = useNativeActivityOptions();
  const plain = item.text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const titleStyle = {
    ...fontStyle(theme, 500),
    fontSize: theme.size.base,
    lineHeight: 20,
    color: theme.colors["fg-muted"],
  };
  return (
    <ActivityDisclosure
      icon="brain"
      iconTone="muted"
      compact={compact}
      running={item.streaming}
      title={
        item.streaming ? (
          <ShimmerText style={titleStyle} numberOfLines={1}>
            {t("native.timeline.activity.thinking")}
          </ShimmerText>
        ) : (
          <Text
            style={{
              ...fontStyle(theme, 400),
              fontSize: theme.size.base,
              lineHeight: 20,
              fontStyle: "italic",
              color: theme.colors["fg-subtle"],
            }}
          >
            {t("native.timeline.activity.thought")}
          </Text>
        )
      }
      accessibilityLabel={item.streaming ? m.thinking : m.thought}
      preview={plain || undefined}
    >
      <View testID={annotationSourceTestId(undefined)} collapsable={false}>
        {options.renderMarkdown ? (
          options.renderMarkdown(item.text, { tone: "muted", streaming: item.streaming })
        ) : (
          <Text
            selectable
            style={{
              ...fontStyle(theme),
              fontSize: theme.size.base,
              lineHeight: 24,
              color: theme.colors["fg-muted"],
            }}
          >
            {item.text}
          </Text>
        )}
      </View>
    </ActivityDisclosure>
  );
}

function SandboxRow({ item, compact }: { item: SandboxItem; compact: boolean }) {
  const m = useNativeTimelineMessages();
  const t = useOpenGeniText();
  return (
    <ActivityDisclosure
      icon="square-terminal"
      iconTone={
        item.status === "failed" ? "failed" : item.status === "running" ? "running" : "muted"
      }
      title={sandboxRowTitle(t, item, (name) => toolDisplayName(t, name))}
      running={item.status === "running"}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
      compact={compact}
      preview={item.command ?? undefined}
    >
      {item.command ? <PayloadBlock label={m.command} value={item.command} /> : null}
      {item.output ? <PayloadBlock label={m.output} value={item.output} /> : null}
    </ActivityDisclosure>
  );
}

function StartupPhaseRow({
  item,
  compact,
}: {
  item: Extract<ActivityItem, { kind: "startup-phase" }>;
  compact: boolean;
}) {
  const m = useNativeTimelineMessages();
  const failed = item.status === "failed";
  const t = useOpenGeniText();
  const running = item.status === "running";
  const duration = startupDuration(item.durationMs);
  return (
    <ActivityDisclosure
      icon="bot"
      iconTone={failed ? "failed" : running ? "running" : "muted"}
      title={
        item.blockedReason
          ? STARTUP_WAIT_TITLES(t)[item.blockedReason]
          : startupPhaseTitle(t, item.phase, item.status, item.outcome)
      }
      preview={item.phase === "model_preparation" ? m.startupDetail : undefined}
      running={running}
      failed={failed}
      cancelled={item.status === "cancelled"}
      chip={duration ? { tone: failed ? "bad" : "muted", text: duration } : undefined}
      expandable={false}
      compact={compact}
    />
  );
}

function WorkerRow({ item, compact }: { item: WorkerItem; compact: boolean }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const options = useNativeActivityOptions();
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const title = workerRowTitle(t, item);
  if (compact) {
    return (
      <ActivityDisclosure
        icon="bot"
        title={title}
        preview={item.prompt}
        running={running}
        compact
      />
    );
  }
  const sessionId = item.workerSessionId;
  const deepLink = Boolean(sessionId) && Boolean(options.onOpenSession) && !failed && !cancelled;
  const titleStyle = {
    ...fontStyle(theme, 500),
    fontSize: theme.size.base,
    lineHeight: 20,
    color: failed ? theme.colors["status-failed"] : theme.colors.fg,
  };
  const inner = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        minHeight: ROW_MIN_HEIGHT,
        paddingHorizontal: 6,
        paddingVertical: 10,
      }}
    >
      <View style={{ width: 14 }} />
      <View style={{ marginTop: 3 }}>
        <Icon
          name="bot"
          size={14}
          color={failed ? theme.colors["status-failed"] : theme.colors.accent}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ShimmerText style={titleStyle} active={running}>
          {title}
        </ShimmerText>
        {item.prompt ? (
          <Text
            numberOfLines={1}
            style={{
              ...fontStyle(theme),
              marginTop: 2,
              fontSize: theme.size.sm,
              color: theme.colors["fg-muted"],
            }}
          >
            {item.prompt}
          </Text>
        ) : null}
        {failed && item.failure ? (
          <View style={{ marginTop: 4 }}>
            <Text
              style={{
                ...fontStyle(theme, 400, "mono"),
                fontSize: theme.size.xs,
                color: theme.colors["status-failed"],
              }}
            >
              {item.failure.code}
            </Text>
            <Text
              style={{
                ...fontStyle(theme),
                marginTop: 2,
                fontSize: theme.size.sm,
                color: theme.colors["status-failed"],
              }}
            >
              {item.failure.message}
            </Text>
          </View>
        ) : null}
      </View>
      {failed ? (
        <Chip chip={{ tone: "bad", text: "failed" }} />
      ) : cancelled ? (
        <Chip chip={{ tone: "interrupted", text: "interrupted" }} />
      ) : deepLink ? (
        <Icon name="chevron-right" size={14} color={theme.colors["fg-subtle"]} />
      ) : null}
    </View>
  );
  if (deepLink && sessionId && options.onOpenSession) {
    const open = options.onOpenSession;
    return (
      <Pressable accessibilityRole="button" onPress={() => open(sessionId)}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

/** Assistant commentary folded into the rail: quieter than an answer. */
function ActivityNoteRow({ item }: { item: AgentMessageItem }) {
  const theme = useNativeTimelineTheme();
  const options = useNativeActivityOptions();
  if (!item.text.trim()) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingHorizontal: 6,
        paddingVertical: 6,
      }}
    >
      <View style={{ width: 14 }} />
      <View style={{ marginTop: 4 }}>
        <Icon name="message-square-text" size={14} color={theme.colors["fg-subtle"]} />
      </View>
      <View
        testID={annotationSourceTestId(item.annotationSource?.eventId)}
        collapsable={false}
        style={{ flex: 1, minWidth: 0 }}
      >
        {options.renderMarkdown ? (
          options.renderMarkdown(item.text, { tone: "muted", streaming: item.streaming })
        ) : (
          <Text
            selectable
            style={{
              ...fontStyle(theme),
              fontSize: theme.size.sm,
              lineHeight: 20,
              color: theme.colors["fg-muted"],
            }}
          >
            {item.text}
          </Text>
        )}
      </View>
    </View>
  );
}

/** Renders one activity item — the native `renderActivity`. */
export function ActivityRow({ item, compact = false }: { item: ActivityItem; compact?: boolean }) {
  const m = useNativeTimelineMessages();
  switch (item.kind) {
    case "tool-call":
      return <ToolCallRow item={item} compact={compact} />;
    case "reasoning":
      return <ReasoningRow item={item} compact={compact} />;
    case "sandbox":
      return <SandboxRow item={item} compact={compact} />;
    case "startup-phase":
      return <StartupPhaseRow item={item} compact={compact} />;
    case "worker":
      return <WorkerRow item={item} compact={compact} />;
    case "agent-message":
      return compact ? (
        <ActivityDisclosure
          icon="message-square-text"
          title={item.text.replace(/\s+/g, " ").trim()}
          compact
        />
      ) : (
        <ActivityNoteRow item={item} />
      );
    case "knowledge":
      return (
        <ActivityDisclosure
          icon="file-search"
          iconTone={item.status === "failed" ? "failed" : "muted"}
          title={
            item.outcome === "pending"
              ? m.proposedKnowledge
              : item.outcome === "failed"
                ? m.knowledgeSaveFailed
                : m.savedToKnowledge
          }
          preview={
            "filename" in item && typeof item.filename === "string" ? item.filename : undefined
          }
          expandable={false}
          compact={compact}
        />
      );
    case "memory":
      return (
        <ActivityDisclosure
          icon="brain-circuit"
          title={m.savedToMemory}
          preview={"text" in item && typeof item.text === "string" ? item.text : undefined}
          expandable={false}
          compact={compact}
        />
      );
    case "fleet-decision":
      return (
        <ActivityDisclosure
          icon="messages-square"
          title={m.workerDecision}
          expandable={false}
          compact={compact}
        />
      );
    default:
      return null;
  }
}
