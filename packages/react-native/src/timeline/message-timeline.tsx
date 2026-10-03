import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import {
  buildTimeline,
  groupTimeline,
  type AgentMessageItem,
  type HumanInputItem,
  type TimelineGroup,
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react/session";
import {
  compactedLandmarkCount,
  durationBetween,
  flattenActivityItems,
  formatClockTime,
  isPreparingWork,
  readableWorkDefaultOpen,
  readableWorkShowsPreview,
  readableWorkStatus,
  timelineGroupContainsPresentedImage,
  type TurnSummaryFacetConfiguration,
} from "@opengeni/react/timeline-model";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { NativeActivityOptionsProvider, type NativeActivityOptions } from "./activity";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import {
  ActivityRail,
  FoldMemoryProvider,
  RollingActivity,
  TurnRailFrame,
  TurnSummary,
  type NativeTurnStatus,
  type PreparingProps,
} from "./turn";

/* ----------------------------------------------------------------------------
   Native MessageTimeline: the web MessageTimeline (components/message-timeline)
   in its rolling readable-turn configuration, drawn with native primitives.
   Grouping, fold defaults, statuses and facets come from the shared model.
   -------------------------------------------------------------------------- */

export type NativeMarkdownRenderer = (
  text: string,
  options: { tone: "body" | "muted"; streaming?: boolean | undefined },
) => ReactNode;

export interface NativeMessageTimelineProps extends NativeActivityOptions {
  /** Projected items (preferred) or raw durable events. */
  items?: TimelineItem[] | undefined;
  events?: SessionEvent[] | undefined;
  status?: SessionStatus | null | undefined;
  facets?: TurnSummaryFacetConfiguration | undefined;
  renderMarkdown?: NativeMarkdownRenderer | undefined;
  /** Replace the preparing visual (the web orb) — e.g. a product character. */
  renderPreparing?: ((props: PreparingProps) => ReactNode) | undefined;
  /** Extra actions beside copy under a message (feedback, share, …). */
  renderMessageActions?: ((item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  /** Rendered after the last group (pending questions, approvals, errors). */
  trailing?: ReactNode;
  emptyState?: ReactNode;
  header?: ReactNode;
  contentInsetTop?: number | undefined;
  contentInsetBottom?: number | undefined;
  style?: StyleProp<ViewStyle>;
}

export function MessageTimeline(props: NativeMessageTimelineProps) {
  const theme = useNativeTimelineTheme();
  const items = useMemo(
    () => props.items ?? buildTimeline(props.events ?? []),
    [props.items, props.events],
  );
  const groups = useMemo(() => groupTimeline(items, { readableTurns: true }), [items]);
  const foldMemory = useRef(new Map<string, "open" | "closed">()).current;
  const scrollRef = useRef<ScrollView>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    following.current = distance < 48;
    setShowJump(distance > 240);
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (following.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const activityOptions = useMemo<NativeActivityOptions>(
    () => ({
      toolRenderers: props.toolRenderers,
      computeLabel: props.computeLabel,
      renderMarkdown: props.renderMarkdown,
      onOpenSession: props.onOpenSession,
    }),
    [props.toolRenderers, props.computeLabel, props.renderMarkdown, props.onOpenSession],
  );
  const context: GroupContext = {
    facets: props.facets,
    renderMarkdown: props.renderMarkdown,
    renderPreparing: props.renderPreparing,
    renderMessageActions: props.renderMessageActions,
    onCopy: props.onCopy,
  };
  return (
    <NativeActivityOptionsProvider value={activityOptions}>
      <FoldMemoryProvider value={foldMemory}>
        <View style={[{ flex: 1, backgroundColor: theme.colors.bg }, props.style]}>
          <ScrollView
            ref={scrollRef}
            onScroll={onScroll}
            scrollEventThrottle={32}
            onContentSizeChange={onContentSizeChange}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingTop: props.contentInsetTop ?? 16,
              paddingHorizontal: 16,
              paddingBottom: props.contentInsetBottom ?? 24,
              gap: 20,
              flexGrow: 1,
            }}
          >
            {props.header}
            {groups.length === 0 && props.emptyState ? props.emptyState : null}
            {groups.map((group) => (
              <TimelineGroupView key={groupKey(group)} group={group} context={context} />
            ))}
            {props.trailing}
          </ScrollView>
          {showJump ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Jump to latest"
              onPress={() => {
                following.current = true;
                scrollRef.current?.scrollToEnd({ animated: true });
              }}
              style={{
                position: "absolute",
                bottom: 12,
                alignSelf: "center",
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.colors["surface-1"],
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <Icon name="arrow-down" size={16} color={theme.colors["fg-muted"]} />
            </Pressable>
          ) : null}
        </View>
      </FoldMemoryProvider>
    </NativeActivityOptionsProvider>
  );
}

type GroupContext = {
  facets?: TurnSummaryFacetConfiguration | undefined;
  renderMarkdown?: NativeMarkdownRenderer | undefined;
  renderPreparing?: ((props: PreparingProps) => ReactNode) | undefined;
  renderMessageActions?: ((item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
  onCopy?: ((text: string) => void) | undefined;
};

function groupKey(group: TimelineGroup): string {
  switch (group.kind) {
    case "item":
      return group.item.kind === "user-message" && group.item.reconciliationKey
        ? `user-${group.item.reconciliationKey}`
        : group.item.id;
    default:
      return group.id;
  }
}

function TimelineGroupView({
  group,
  context,
  insideTurn = false,
}: {
  group: TimelineGroup;
  context: GroupContext;
  insideTurn?: boolean;
}) {
  switch (group.kind) {
    case "activity": {
      if (group.work) {
        if (isPreparingWork(group, { startupDetails: false, startupDismissed: insideTurn })) {
          return (
            <ActivityRail
              items={group.items}
              startupActive
              renderPreparing={context.renderPreparing}
            />
          );
        }
        const base = readableWorkStatus({ ...group, work: group.work });
        const status: NativeTurnStatus =
          base.kind === "working"
            ? {
                kind: "working",
                since: base.since,
                label: base.label,
                preview: readableWorkShowsPreview(group) ? (
                  <RollingActivity items={group.items} showCount={false} />
                ) : undefined,
              }
            : base.kind === "waiting"
              ? { kind: "waiting", since: base.since, label: base.label }
              : { kind: "worked", durationMs: base.durationMs, label: base.label };
        return (
          <TurnSummary
            items={group.items}
            status={status}
            outcome={group.outcome}
            failureText={group.failureText}
            foldKey={group.id}
            defaultOpen={readableWorkDefaultOpen(group)}
            facets={context.facets}
            contextCompactionCount={compactedLandmarkCount(group.work.details)}
          >
            <TurnRailFrame compact>
              <FoldedGroups groups={group.work.details} context={context} />
            </TurnRailFrame>
          </TurnSummary>
        );
      }
      const preparationOnly =
        !insideTurn &&
        !group.outcome &&
        group.items.every(
          (item) =>
            item.kind === "startup-phase" || (item.kind === "reasoning" && !item.text.trim()),
        );
      if (preparationOnly) {
        return <ActivityRail items={group.items} renderPreparing={context.renderPreparing} />;
      }
      if (insideTurn) {
        return <ActivityRail items={group.items} startupActive={false} />;
      }
      const image = timelineGroupContainsPresentedImage(group);
      return (
        <TurnSummary
          items={group.items}
          outcome={group.outcome}
          failureText={group.failureText}
          defaultOpen={group.outcome === "failed" || image ? true : undefined}
          liveHeader={
            !image && !group.outcome ? <RollingActivity items={group.items} /> : undefined
          }
          foldKey={group.id}
          facets={context.facets}
        >
          <TurnRailFrame>
            <ActivityRail items={group.items} startupActive={false} />
          </TurnRailFrame>
        </TurnSummary>
      );
    }
    case "turn": {
      const activityItems = flattenActivityItems(group.groups);
      const image = timelineGroupContainsPresentedImage(group);
      return (
        <TurnSummary
          items={activityItems}
          outcome={group.outcome}
          failureText={insideTurn ? undefined : group.failureText}
          durationMs={durationBetween(group.startedAt, group.endedAt)}
          defaultOpen={!insideTurn && (group.outcome === "failed" || image) ? true : undefined}
          bare={insideTurn}
          foldKey={group.id}
          facets={context.facets}
          contextCompactionCount={group.contextCompactionCount}
        >
          {insideTurn ? (
            <View style={{ gap: 16 }}>
              <FoldedGroups groups={group.groups} context={context} />
            </View>
          ) : (
            <TurnRailFrame>
              <FoldedGroups groups={group.groups} context={context} />
            </TurnRailFrame>
          )}
        </TurnSummary>
      );
    }
    case "item":
      return <TimelineRow item={group.item} context={context} />;
  }
}

function FoldedGroups({
  groups,
  context,
}: {
  groups: readonly TimelineGroup[];
  context: GroupContext;
}) {
  return (
    <>
      {groups.map((child, index) => (
        <View
          key={groupKey(child)}
          style={
            index > 0 && (child.kind !== "activity" || groups[index - 1]?.kind !== "activity")
              ? { marginTop: 12 }
              : undefined
          }
        >
          <TimelineGroupView group={child} context={context} insideTurn />
        </View>
      ))}
    </>
  );
}

function TimelineRow({ item, context }: { item: TimelineItem; context: GroupContext }) {
  const theme = useNativeTimelineTheme();
  switch (item.kind) {
    case "user-message":
      return <UserMessageRow item={item} context={context} />;
    case "agent-message":
      return <AgentMessageRow item={item} context={context} />;
    case "human-input":
      return <HumanInputRow item={item} />;
    case "session-status":
      return (
        <SeparatorRow text={item.resolvedAt ? "work resumed" : item.status.replace(/_/g, " ")} />
      );
    case "context-compaction":
      return <SeparatorRow text="context compacted" />;
    case "notice":
      return (
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderColor:
              item.tone === "failed"
                ? withAlpha(theme.colors["status-failed"], 0.35)
                : theme.colors.border,
            backgroundColor:
              item.tone === "failed"
                ? withAlpha(theme.colors["status-failed"], 0.1)
                : theme.colors["surface-1"],
          }}
        >
          <Text
            style={{
              ...fontStyle(theme),
              flex: 1,
              fontSize: 14,
              lineHeight: 20,
              color:
                item.tone === "failed" ? theme.colors["status-failed"] : theme.colors["fg-muted"],
            }}
          >
            {item.text}
          </Text>
        </View>
      );
    case "goal":
      return item.text ? (
        <SeparatorRow text={`goal ${item.action} · ${item.text}`} />
      ) : (
        <SeparatorRow text={`goal ${item.action}`} />
      );
    case "worker-completion":
      return (
        <View
          style={{
            borderLeftWidth: 2,
            borderLeftColor: theme.colors.border,
            paddingLeft: 12,
            gap: 4,
          }}
        >
          <Text
            style={{ ...fontStyle(theme, 500), fontSize: theme.size.base, color: theme.colors.fg }}
          >
            Worker reported back
          </Text>
          <Text
            numberOfLines={3}
            style={{
              ...fontStyle(theme),
              fontSize: theme.size.sm,
              lineHeight: 18,
              color: theme.colors["fg-muted"],
            }}
          >
            {item.text}
          </Text>
        </View>
      );
    case "auth-needed":
      return (
        <View
          style={{
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 14,
            backgroundColor: theme.colors["surface-1"],
          }}
        >
          <Text
            style={{ ...fontStyle(theme, 500), fontSize: theme.size.md, color: theme.colors.fg }}
          >
            Connection needed
          </Text>
          <Text
            style={{
              ...fontStyle(theme),
              marginTop: 4,
              fontSize: theme.size.sm,
              color: theme.colors["fg-muted"],
            }}
          >
            {item.providerDomain} needs to be reconnected before the agent can continue.
          </Text>
        </View>
      );
    default:
      return null;
  }
}

/**
 * The web footer stamp. Hermes/iOS ICU joins date and time with " at " where the
 * browser's ICU uses ", "; normalize to the web form.
 */
function nativeClockTime(iso: string): string {
  return formatClockTime(iso).replace(" at ", ", ");
}

function SeparatorRow({ text }: { text: string }) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ height: 1, flex: 1, backgroundColor: theme.colors.border }} />
      <Text
        numberOfLines={1}
        style={{
          ...fontStyle(theme),
          maxWidth: "70%",
          fontSize: theme.size.xs,
          color: theme.colors["fg-subtle"],
        }}
      >
        {text}
      </Text>
      <View style={{ height: 1, flex: 1, backgroundColor: theme.colors.border }} />
    </View>
  );
}

/** Copy + time under a message: the web CopyHoverFrame footer at coarse pointer. */
function MessageFooter({
  text,
  occurredAt,
  align,
  actions,
  onCopy,
}: {
  text: string;
  occurredAt: string;
  align: "start" | "end";
  actions?: ReactNode;
  onCopy?: ((text: string) => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: align === "end" ? "flex-end" : "flex-start",
        gap: 6,
        height: 44,
      }}
    >
      {onCopy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy message"
          onPress={() => {
            onCopy(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: theme.radius.sm,
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} color={theme.colors["fg-subtle"]} />
        </Pressable>
      ) : null}
      {actions}
      <Text
        style={{
          ...fontStyle(theme),
          fontSize: theme.size.xs,
          color: theme.colors["fg-subtle"],
          fontVariant: ["tabular-nums"],
        }}
      >
        {nativeClockTime(occurredAt)}
      </Text>
    </View>
  );
}

function UserMessageRow({ item, context }: { item: UserMessageItem; context: GroupContext }) {
  const theme = useNativeTimelineTheme();
  const failed = item.delivery?.state === "failed";
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ alignItems: "flex-end" }}>
      <View style={{ maxWidth: "85%", alignItems: "flex-end" }}>
        <View
          style={{
            backgroundColor: theme.colors["surface-2"],
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
            borderBottomLeftRadius: 14,
            borderBottomRightRadius: 4,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          {item.text ? (
            <Text
              selectable
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.md,
                lineHeight: 28,
                color: theme.colors.fg,
              }}
            >
              {item.text}
            </Text>
          ) : null}
        </View>
        <MessageFooter
          text={item.text}
          occurredAt={item.occurredAt}
          align="end"
          actions={context.renderMessageActions?.(item)}
          onCopy={context.onCopy}
        />
        {failed ? (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}
          >
            <Icon name="triangle-alert" size={14} color={theme.colors["status-failed"]} />
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.xs,
                color: theme.colors["status-failed"],
              }}
            >
              {item.delivery?.error || "Message not sent"}
            </Text>
            {item.delivery?.onRetry ? (
              <Pressable onPress={item.delivery.onRetry} accessibilityRole="button">
                <Text
                  style={{
                    ...fontStyle(theme, 500),
                    fontSize: theme.size.xs,
                    color: theme.colors["status-failed"],
                    textDecorationLine: "underline",
                  }}
                >
                  Retry
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

function AgentMessageRow({ item, context }: { item: AgentMessageItem; context: GroupContext }) {
  const theme = useNativeTimelineTheme();
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ minWidth: 0 }}>
      {context.renderMarkdown ? (
        context.renderMarkdown(item.text, { tone: "body", streaming: item.streaming })
      ) : (
        <Text
          selectable
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.md,
            lineHeight: 28,
            color: theme.colors.fg,
          }}
        >
          {item.text}
        </Text>
      )}
      {item.streaming ? null : (
        <MessageFooter
          text={item.text}
          occurredAt={item.occurredAt}
          align="start"
          actions={context.renderMessageActions?.(item)}
          onCopy={context.onCopy}
        />
      )}
    </Animated.View>
  );
}

function HumanInputRow({ item }: { item: HumanInputItem }) {
  const theme = useNativeTimelineTheme();
  const multiple = Math.max(item.questions.length, item.answers.length) > 1;
  const settled =
    item.response.outcome === "answered"
      ? "You answered"
      : item.response.outcome === "skipped"
        ? "Skipped"
        : item.response.outcome === "expired"
          ? "Expired"
          : "Cancelled";
  const answerText = item.answers
    .map((answer) => `${multiple ? `${answer.label}: ` : ""}${answer.values.join(", ")}`)
    .join("\n");
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          maxWidth: "90%",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors["surface-1"],
          borderTopLeftRadius: theme.radius.lg,
          borderTopRightRadius: theme.radius.lg,
          borderBottomRightRadius: theme.radius.lg,
          borderBottomLeftRadius: theme.radius.xs,
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        <View
          style={{
            marginTop: 2,
            width: 32,
            height: 32,
            borderRadius: theme.radius.md,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(theme.colors["status-waiting"], 0.1),
          }}
        >
          <Icon name="message-circle-question" size={16} color={theme.colors["status-waiting"]} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.xs,
              color: theme.colors["fg-subtle"],
            }}
          >
            Agent asked
          </Text>
          <View style={{ marginTop: 6, gap: 12 }}>
            {item.questions.map((question, index) => (
              <View key={question.id}>
                {question.label ? (
                  <Text
                    style={{
                      ...fontStyle(theme, 600),
                      fontSize: theme.size.sm,
                      color: theme.colors.fg,
                    }}
                  >
                    {multiple ? `${index + 1}. ` : ""}
                    {question.label}
                  </Text>
                ) : null}
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: question.label ? theme.size.sm : theme.size.md,
                    lineHeight: question.label ? 18 : 24,
                    marginTop: question.label ? 2 : 0,
                    color: question.label ? theme.colors["fg-muted"] : theme.colors.fg,
                  }}
                >
                  {question.prompt}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <View
          style={{
            maxWidth: "85%",
            backgroundColor: theme.colors["surface-2"],
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
            borderBottomLeftRadius: 14,
            borderBottomRightRadius: 4,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.xs,
              color: theme.colors["fg-subtle"],
            }}
          >
            {settled}
          </Text>
          {answerText ? (
            <Text
              style={{
                ...fontStyle(theme),
                marginTop: 2,
                fontSize: theme.size.md,
                lineHeight: 24,
                color: theme.colors.fg,
              }}
            >
              {answerText}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}
