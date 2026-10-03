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
  sandboxRowTitle,
  startupDuration,
  startupPhaseTitle,
  STARTUP_WAIT_TITLES,
  toolDisplayName,
  toolRowPresentation,
  workerRowTitle,
  type ToolBody,
  type ToolIconKind,
  type ToolPreview,
  type ToolRowPresentation,
  type WebSearchResult,
} from "@opengeni/react/timeline-model";
import { createContext, useContext, type ReactNode } from "react";
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
  /** Active compute label for exec previews ("on <label> · …"). */
  computeLabel?: string | null | undefined;
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
  wrench: "wrench",
};

function PreviewNode({ preview, compact }: { preview: ToolPreview; compact: boolean }) {
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
          <Text style={{ color: theme.colors["fg-muted"] }}>{preview.count} files</Text>
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
        return <BodyNote>results folded into model context — no list available.</BodyNote>;
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
}: {
  presentation: ToolRowPresentation;
  compact?: boolean;
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
    >
      <ToolBodyView body={p.body} />
    </ActivityDisclosure>
  );
}

function ToolCallRow({ item, compact }: { item: ToolCallItem; compact: boolean }) {
  const options = useNativeActivityOptions();
  const presentation = toolRowPresentation(item, { computeLabel: options.computeLabel ?? null });
  const leaf = item.name.includes("__")
    ? item.name.slice(item.name.lastIndexOf("__") + 2)
    : item.name;
  const custom = options.toolRenderers?.[item.name] ?? options.toolRenderers?.[leaf];
  if (custom) {
    const node = custom({ item, presentation, compact });
    if (node != null) return <>{node}</>;
  }
  return <PresentedToolRow presentation={presentation} compact={compact} />;
}

function ReasoningRow({ item, compact }: { item: ReasoningItem; compact: boolean }) {
  const theme = useNativeTimelineTheme();
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
            Thinking
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
            Thought
          </Text>
        )
      }
      accessibilityLabel={item.streaming ? "Thinking" : "Thought"}
      preview={plain || undefined}
    >
      {options.renderMarkdown ? (
        options.renderMarkdown(item.text, { tone: "muted", streaming: item.streaming })
      ) : (
        <Text
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
    </ActivityDisclosure>
  );
}

function SandboxRow({ item, compact }: { item: SandboxItem; compact: boolean }) {
  return (
    <ActivityDisclosure
      icon="square-terminal"
      iconTone={
        item.status === "failed" ? "failed" : item.status === "running" ? "running" : "muted"
      }
      title={sandboxRowTitle(item, (name) => toolDisplayName(name))}
      running={item.status === "running"}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
      compact={compact}
      preview={item.command ?? undefined}
    >
      {item.command ? <PayloadBlock label="Command" value={item.command} /> : null}
      {item.output ? <PayloadBlock label="Output" value={item.output} /> : null}
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
  const failed = item.status === "failed";
  const running = item.status === "running";
  const duration = startupDuration(item.durationMs);
  return (
    <ActivityDisclosure
      icon="bot"
      iconTone={failed ? "failed" : running ? "running" : "muted"}
      title={
        item.blockedReason
          ? STARTUP_WAIT_TITLES[item.blockedReason]
          : startupPhaseTitle(item.phase, item.status, item.outcome)
      }
      preview={
        item.phase === "model_preparation"
          ? "Includes overlapping sandbox startup, custom environment setup, repository preparation, and runtime setup shown below."
          : undefined
      }
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
  const theme = useNativeTimelineTheme();
  const options = useNativeActivityOptions();
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const title = workerRowTitle(item);
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
      <View style={{ flex: 1, minWidth: 0 }}>
        {options.renderMarkdown ? (
          options.renderMarkdown(item.text, { tone: "muted", streaming: item.streaming })
        ) : (
          <Text
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
              ? "Proposed knowledge"
              : item.outcome === "failed"
                ? "Knowledge save failed"
                : "Saved to knowledge"
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
          title="Saved to memory"
          preview={"text" in item && typeof item.text === "string" ? item.text : undefined}
          expandable={false}
          compact={compact}
        />
      );
    case "fleet-decision":
      return (
        <ActivityDisclosure
          icon="messages-square"
          title="Worker decision"
          expandable={false}
          compact={compact}
        />
      );
    default:
      return null;
  }
}
