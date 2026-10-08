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
  formatRelativeTime,
  isPreparingWork,
  noticeDisplayText,
  noticeTone,
  QUESTION_NAV_MARGIN_PX,
  recordedWaitSummaryText,
  questionNavTarget,
  readableWorkDefaultOpen,
  readableWorkShowsPreview,
  readableWorkStatus,
  SESSION_STATUS_PRESENTATION,
  timelineGroupContainsPresentedImage,
  timelineGroupIndexAtSequence,
  type TurnSummaryFacetConfiguration,
} from "@opengeni/react/timeline-model";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { NativeActivityOptionsProvider, type NativeActivityOptions } from "./activity";
import { Icon } from "./icon";
import { ReleaseFollowProvider, withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import {
  ActivityRail,
  FoldMemoryProvider,
  StickyWorkHeaderProvider,
  type StickyWorkHeader,
  RollingActivity,
  TurnRailFrame,
  TurnSummary,
  type NativeTurnStatus,
  type PreparingProps,
} from "./turn";
import { useNativeTimelineMessages } from "./messages";

/* ----------------------------------------------------------------------------
   Native MessageTimeline: the web MessageTimeline (components/message-timeline)
   in its rolling readable-turn configuration, drawn with native primitives.
   Grouping, fold defaults, statuses and facets come from the shared model.
   -------------------------------------------------------------------------- */

export type NativeMarkdownRenderer = (
  text: string,
  options: { tone: "body" | "muted"; streaming?: boolean | undefined },
) => ReactNode;

/** Start fetching older history this far before the reader reaches the top. */
const OLDER_HISTORY_PREFETCH_PX = 600;
/** Web's phone clamp for long user messages (max-h-56). */
const USER_MESSAGE_COLLAPSED_PX = 224;

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
  /** Files sent with a user message, shown above its bubble (images as previews). */
  renderUserAttachments?: ((item: UserMessageItem) => ReactNode) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  /** Rendered after the last group (pending questions, approvals, errors). */
  trailing?: ReactNode;
  emptyState?: ReactNode;
  header?: ReactNode;
  /**
   * Older durable history exists before the loaded window. When the reader
   * scrolls near the top (or the loaded window doesn't fill the screen), the
   * timeline calls `onLoadOlder` and keeps the reader's place as rows arrive.
   */
  hasOlder?: boolean | undefined;
  loadingOlder?: boolean | undefined;
  onLoadOlder?: (() => unknown) | undefined;
  /**
   * A durable event sequence to open on (an inbox item's or a notification's
   * moment): the timeline loads older history until it holds that moment,
   * then lands on its row, or the nearest row before it, once.
   */
  focusSequence?: number | null | undefined;
  contentInsetTop?: number | undefined;
  contentInsetBottom?: number | undefined;
  /** Height of host chrome floating over the timeline's bottom edge (a floating composer). */
  overlayInsetBottom?: number | undefined;
  style?: StyleProp<ViewStyle>;
}

export function MessageTimeline(props: NativeMessageTimelineProps) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const items = useMemo(
    () => props.items ?? buildTimeline(props.events ?? []),
    [props.items, props.events],
  );
  const groups = useMemo(() => groupTimeline(items, { readableTurns: true }), [items]);
  const foldMemory = useRef(new Map<string, "open" | "closed">()).current;
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // Opening on a moment starts away from the tip; the landing decides where.
  const following = useRef(!props.focusSequence);
  // Only reader gestures change follow intent; layout-driven scroll events
  // (content growing before the first scroll-to-end) must not unstick it.
  const readerScrolling = useRef(false);
  const [showJump, setShowJump] = useState(false);
  // "Back to your message": prompt rows' content offsets, read on scroll.
  const promptFrames = useRef(new Map<string, { top: number; bottom: number }>()).current;
  const [questionNav, setQuestionNav] = useState<string | null>(null);
  // Expanded outer turn headers, for the pinned copy (web: sticky in its section).
  const stickyHeaders = useRef(new Map<string, StickyWorkHeader>()).current;
  const scrollY = useRef(0);
  const [pinned, setPinned] = useState<{ key: string; offset: number; height: number } | null>(
    null,
  );
  const updatePinned = useCallback(() => {
    const y = scrollY.current;
    let next: { key: string; offset: number; height: number } | null = null;
    for (const [key, entry] of stickyHeaders) {
      const end = entry.top + entry.height - entry.headerHeight;
      if (entry.headerHeight > 0 && entry.top < y && y < end) {
        next = { key, offset: Math.min(0, end - y), height: entry.headerHeight };
      }
    }
    setPinned((current) =>
      current?.key === next?.key &&
      current?.offset === next?.offset &&
      current?.height === next?.height
        ? current
        : next,
    );
  }, [stickyHeaders]);
  const releaseFollow = useCallback(() => {
    following.current = false;
  }, []);
  // Older history: latest values for scroll callbacks without re-binding them.
  const history = useRef({
    hasOlder: false,
    loading: false,
    load: undefined as (() => unknown) | undefined,
  });
  history.current = {
    hasOlder: props.hasOlder === true,
    loading: props.loadingOlder === true,
    load: props.onLoadOlder,
  };
  const viewportHeight = useRef(0);
  // Older rows arrive above the reader. Keep the reader's place by moving the
  // offset by the added height (UIKit's maintainVisibleContentPosition fights
  // the reader's drag while live rows re-lay out, so it isn't used).
  const contentHeight = useRef(0);
  const firstGroupKey = useRef<string | null>(null);
  const prepended = useRef(false);
  const nextFirstKey = groups[0] ? groupKey(groups[0]) : null;
  if (nextFirstKey !== firstGroupKey.current) {
    const previous = firstGroupKey.current;
    if (previous !== null && groups.some((group) => groupKey(group) === previous)) {
      prepended.current = true;
    }
    firstGroupKey.current = nextFirstKey;
  }
  const requestOlder = useCallback(() => {
    const { hasOlder, loading, load } = history.current;
    if (!hasOlder || loading || !load) return;
    history.current = { ...history.current, loading: true };
    void Promise.resolve(load()).catch(() => undefined);
  }, []);
  const registerSticky = useMemo(
    () => ({
      register: (key: string, entry: StickyWorkHeader | null) => {
        if (entry) stickyHeaders.set(key, entry);
        else stickyHeaders.delete(key);
      },
      reveal: (top: number) => {
        // Collapsing from the pinned copy leaves the reader on that turn's row.
        following.current = false;
        setPinned(null);
        scrollRef.current?.scrollTo({ y: Math.max(0, top - 8), animated: false });
      },
    }),
    [stickyHeaders],
  );
  const measure = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    return contentSize.height - layoutMeasurement.height - contentOffset.y;
  }, []);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const distance = measure(event);
      // Mid-drag only releases follow; the drag's end decides whether to resume it.
      if (readerScrolling.current && distance >= 48) following.current = false;
      setShowJump(distance > 240 && !following.current);
      const { contentOffset, layoutMeasurement } = event.nativeEvent;
      scrollY.current = contentOffset.y;
      // The reader is approaching the oldest loaded row: fetch the window before it.
      // Momentum after a fling counts too, so this keys on follow, not the drag.
      if (!following.current && contentOffset.y < OLDER_HISTORY_PREFETCH_PX) requestOlder();
      updatePinned();
      const prompts = [...promptFrames.entries()]
        .map(([key, frame]) => ({ key, ...frame }))
        .sort((a, b) => a.top - b.top);
      const next = questionNavTarget(prompts, {
        top: contentOffset.y,
        height: layoutMeasurement.height,
      });
      setQuestionNav((current) => (current === next ? current : next));
    },
    [measure, promptFrames, requestOlder, updatePinned],
  );
  const onScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      following.current = measure(event) < 48;
      readerScrolling.current = false;
    },
    [measure],
  );
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const added = height - contentHeight.current;
      contentHeight.current = height;
      if (prepended.current) {
        prepended.current = false;
        if (!following.current && added > 0) {
          scrollY.current += added;
          scrollRef.current?.scrollTo({ y: scrollY.current, animated: false });
          return;
        }
      }
      if (following.current) scrollRef.current?.scrollToEnd({ animated: false });
      // A short window can't be scrolled, so it could never reach the top: keep loading.
      if (viewportHeight.current > 0 && height < viewportHeight.current + OLDER_HISTORY_PREFETCH_PX)
        requestOlder();
    },
    [requestOlder],
  );
  // Landing on a moment: each group's offset, read as it lays out.
  const groupTops = useRef(new Map<string, number>()).current;
  const landed = useRef<number | null>(null);
  const [layoutPass, setLayoutPass] = useState(0);
  const focusSequence = props.focusSequence ?? null;
  const focusIndex = useMemo(
    () => (focusSequence ? timelineGroupIndexAtSequence(groups, focusSequence) : -1),
    [focusSequence, groups],
  );
  useEffect(() => {
    if (!focusSequence || landed.current === focusSequence) return;
    following.current = false;
    if (focusIndex < 0) {
      // Older than the loaded window: fetch the window before it, else give up
      // and show the latest.
      if (history.current.hasOlder) requestOlder();
      else if (!history.current.loading && groups.length > 0) {
        landed.current = focusSequence;
        following.current = true;
        scrollRef.current?.scrollToEnd({ animated: false });
      }
      return;
    }
    const top = groupTops.get(groupKey(groups[focusIndex]!));
    if (top === undefined) return;
    landed.current = focusSequence;
    scrollY.current = Math.max(0, top - 12);
    scrollRef.current?.scrollTo({ y: scrollY.current, animated: false });
  }, [focusSequence, focusIndex, groups, groupTops, layoutPass, requestOlder]);
  const activityOptions = useMemo<NativeActivityOptions>(
    () => ({
      toolRenderers: props.toolRenderers,
      renderTool: props.renderTool,
      computeLabel: props.computeLabel,
      renderMarkdown: props.renderMarkdown,
      onOpenSession: props.onOpenSession,
    }),
    [
      props.toolRenderers,
      props.renderTool,
      props.computeLabel,
      props.renderMarkdown,
      props.onOpenSession,
    ],
  );
  const context: GroupContext = {
    facets: props.facets,
    renderMarkdown: props.renderMarkdown,
    renderPreparing: props.renderPreparing,
    renderMessageActions: props.renderMessageActions,
    renderUserAttachments: props.renderUserAttachments,
    onCopy: props.onCopy,
  };
  return (
    <NativeActivityOptionsProvider value={activityOptions}>
      <FoldMemoryProvider value={foldMemory}>
        <StickyWorkHeaderProvider value={registerSticky}>
          <ReleaseFollowProvider value={releaseFollow}>
            <View style={[{ flex: 1, backgroundColor: theme.colors.bg }, props.style]}>
              <ScrollView
                ref={scrollRef}
                onScroll={onScroll}
                onScrollBeginDrag={() => {
                  readerScrolling.current = true;
                  // The reader takes over: a live turn re-lays out the content many
                  // times a second, and snapping to the end on each pass would undo
                  // the drag before it got far. Follow is re-decided when it ends.
                  following.current = false;
                }}
                onScrollEndDrag={onScrollEnd}
                onMomentumScrollEnd={onScrollEnd}
                onLayout={(event: LayoutChangeEvent) => {
                  viewportHeight.current = event.nativeEvent.layout.height;
                  if (following.current) scrollRef.current?.scrollToEnd({ animated: false });
                }}
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
                <View>
                  {props.hasOlder ? (
                    <OlderHistoryRow loading={props.loadingOlder === true} onPress={requestOlder} />
                  ) : null}
                  {props.header}
                </View>
                {groups.length === 0 && props.emptyState ? props.emptyState : null}
                {groups.map((group, index) => {
                  const key = groupKey(group);
                  const prompt = group.kind === "item" && group.item.kind === "user-message";
                  // The landing row keeps one wrapper for its life, so landing never remounts it.
                  const landing = focusSequence !== null && index === focusIndex;
                  return prompt || landing ? (
                    <View
                      key={key}
                      onLayout={(event) => {
                        const { y, height } = event.nativeEvent.layout;
                        if (prompt) promptFrames.set(key, { top: y, bottom: y + height });
                        if (landing && landed.current !== focusSequence) {
                          groupTops.set(key, y);
                          setLayoutPass((pass) => pass + 1);
                        }
                      }}
                    >
                      <TimelineGroupView group={group} context={context} />
                    </View>
                  ) : (
                    <TimelineGroupView key={key} group={group} context={context} />
                  );
                })}
                {props.trailing}
              </ScrollView>
              {pinned && stickyHeaders.get(pinned.key) ? (
                <View
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    paddingHorizontal: 16,
                    backgroundColor: theme.colors.bg,
                    transform: [{ translateY: pinned.offset }],
                  }}
                >
                  {stickyHeaders.get(pinned.key)!.render()}
                </View>
              ) : null}
              {/* Web timeline navigation: two identical small round arrow buttons at
              fixed, centered spots that never dodge the content beneath them. */}
              {questionNav ? (
                <View
                  pointerEvents="box-none"
                  style={{
                    position: "absolute",
                    // Below a pinned work header so that strip stays a full-width target.
                    top: pinned ? pinned.height + pinned.offset + 8 : 12,
                    left: 0,
                    right: 0,
                    alignItems: "center",
                  }}
                >
                  <NavButton
                    icon="arrow-up"
                    label={m.backToYourMessage}
                    onPress={() => {
                      const frame = promptFrames.get(questionNav);
                      if (!frame) return;
                      following.current = false;
                      scrollRef.current?.scrollTo({
                        y: Math.max(0, frame.top - QUESTION_NAV_MARGIN_PX),
                        animated: true,
                      });
                    }}
                  />
                </View>
              ) : null}
              {showJump ? (
                <View
                  pointerEvents="box-none"
                  style={{
                    position: "absolute",
                    bottom: (props.overlayInsetBottom ?? 0) + 12,
                    left: 0,
                    right: 0,
                    alignItems: "center",
                  }}
                >
                  <NavButton
                    icon="arrow-down"
                    label={m.jumpToLatest}
                    onPress={() => {
                      following.current = true;
                      scrollRef.current?.scrollToEnd({ animated: true });
                    }}
                  />
                </View>
              ) : null}
            </View>
          </ReleaseFollowProvider>
        </StickyWorkHeaderProvider>
      </FoldMemoryProvider>
    </NativeActivityOptionsProvider>
  );
}

/**
 * The web timeline's navigation button (NAV_BUTTON_CLASS): 32pt round, surface-3
 * at 90% with a border and shadow, a 16pt fg-muted arrow, and a 44pt touch target.
 */
function NavButton(props: { icon: "arrow-up" | "arrow-down"; label: string; onPress: () => void }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        onPress={props.onPress}
        hitSlop={6}
        style={({ pressed }) => ({
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: pressed ? c["border-strong"] : c.border,
          backgroundColor: withAlpha(c["surface-3"], 0.9),
          shadowColor: "#000",
          shadowOpacity: 0.1,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        })}
      >
        {({ pressed }) => (
          <Icon name={props.icon} size={16} color={pressed ? c.fg : c["fg-muted"]} />
        )}
      </Pressable>
    </Animated.View>
  );
}

type GroupContext = {
  facets?: TurnSummaryFacetConfiguration | undefined;
  renderMarkdown?: NativeMarkdownRenderer | undefined;
  renderPreparing?: ((props: PreparingProps) => ReactNode) | undefined;
  renderMessageActions?: ((item: AgentMessageItem | UserMessageItem) => ReactNode) | undefined;
  renderUserAttachments?: ((item: UserMessageItem) => ReactNode) | undefined;
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
      return <HumanInputRow item={item} onCopy={context.onCopy} />;
    case "session-status": {
      const meta = SESSION_STATUS_PRESENTATION[item.status];
      return (
        <SeparatorRow
          dot={item.resolvedAt ? undefined : theme.colors[`status-${meta.tone}`]}
          text={`${item.resolvedAt ? "work resumed" : meta.label.toLowerCase()} · ${formatRelativeTime(item.resolvedAt ?? item.occurredAt)}`}
        />
      );
    }
    case "context-compaction":
      return <SeparatorRow text="context compacted" />;
    case "notice":
      return <NoticeRow item={item} />;
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

function NoticeRow({ item }: { item: Extract<TimelineItem, { kind: "notice" }> }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  // An agent's own wait is ordinary progress, not a warning: a quiet line that
  // discloses the reason, as on web.
  if (item.recordedOutcome) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ paddingVertical: 4 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <Icon name="chevron-right" size={14} color={c["fg-muted"]} />
          </View>
          <Text style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}>
            {recordedWaitSummaryText(item).replace(" at ", ", ")}
          </Text>
        </View>
        {open ? (
          <Text
            style={{
              ...fontStyle(theme),
              marginTop: 4,
              paddingLeft: 22,
              fontSize: theme.size.sm,
              lineHeight: 19,
              color: c["fg-muted"],
            }}
          >
            {item.text}
          </Text>
        ) : null}
      </Pressable>
    );
  }
  const tone = noticeTone(item);
  const accent =
    tone === "failed"
      ? c["status-failed"]
      : tone === "waiting"
        ? c["status-waiting"]
        : c["fg-muted"];
  return (
    <View
      accessibilityRole="text"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderColor: tone === "neutral" ? c.border : withAlpha(accent, 0.35),
        backgroundColor: tone === "neutral" ? c["surface-1"] : withAlpha(accent, 0.1),
      }}
    >
      <View style={{ marginTop: 2, opacity: item.tone === "cancelled" ? 0.6 : 1 }}>
        <Icon name="triangle-alert" size={16} color={accent} />
      </View>
      <Text style={{ ...fontStyle(theme), flex: 1, fontSize: 14, lineHeight: 20, color: accent }}>
        {noticeDisplayText(item)}
      </Text>
    </View>
  );
}

function SeparatorRow({ text, dot }: { text: string; dot?: string | undefined }) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ height: 1, flex: 1, backgroundColor: theme.colors.border }} />
      {dot ? (
        <View
          style={{ width: 4, height: 4, borderRadius: 2, marginRight: -6, backgroundColor: dot }}
        />
      ) : null}
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
  const m = useNativeTimelineMessages();
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
          accessibilityLabel={m.copyMessage}
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

/**
 * Web's long-message disclosure: a sent message taller than the phone clamp
 * shows its top with a fade and "Show more"; the full text stays mounted.
 */
function CollapsibleUserText({ children }: { children: ReactNode }) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const [height, setHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // A little slack so a message just over the clamp isn't hidden behind a control.
  const collapsible = height > USER_MESSAGE_COLLAPSED_PX + 48;
  const collapsed = collapsible && !expanded;
  const surface = theme.colors["surface-2"];
  return (
    <View>
      <View style={collapsed ? { maxHeight: USER_MESSAGE_COLLAPSED_PX, overflow: "hidden" } : null}>
        {/* Measure only while unclipped: inside the clip the content is laid out
            shorter, and re-measuring there would flip collapse on and off. */}
        <View
          onLayout={(event) => {
            if (!collapsed) setHeight(event.nativeEvent.layout.height);
          }}
        >
          {children}
        </View>
        {collapsed ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 48 }}
          >
            {[0.25, 0.5, 0.75, 0.95].map((alpha) => (
              <View key={alpha} style={{ flex: 1, backgroundColor: withAlpha(surface, alpha) }} />
            ))}
          </View>
        ) : null}
      </View>
      {collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((value) => !value)}
          style={{ alignSelf: "flex-start", paddingTop: 6 }}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.sm,
              color: theme.colors["fg-muted"],
            }}
          >
            {expanded ? m.showLess : m.showMore}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Top of the loaded window: a spinner while older history loads, else a manual control. */
function OlderHistoryRow({ loading, onPress }: { loading: boolean; onPress: () => void }) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  return (
    <View style={{ alignItems: "center", paddingVertical: 8 }}>
      {loading ? (
        <ActivityIndicator color={theme.colors["fg-muted"]} accessibilityLabel={m.loadingEarlier} />
      ) : (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress}>
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.sm,
              color: theme.colors["fg-muted"],
            }}
          >
            Load earlier messages
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function UserMessageRow({ item, context }: { item: UserMessageItem; context: GroupContext }) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const failed = item.delivery?.state === "failed";
  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ alignItems: "flex-end" }}>
      <View style={{ maxWidth: "85%", alignItems: "flex-end", gap: 6 }}>
        {item.resources.some((resource) => resource.kind === "file")
          ? context.renderUserAttachments?.(item)
          : null}
        {item.text ? (
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
            <CollapsibleUserText>
              {context.renderMarkdown ? (
                context.renderMarkdown(item.text, { tone: "body" })
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
            </CollapsibleUserText>
          </View>
        ) : null}
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
              {item.delivery?.error || m.messageNotSent}
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

function HumanInputRow({
  item,
  onCopy,
}: {
  item: HumanInputItem;
  onCopy?: ((text: string) => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const multiple = Math.max(item.questions.length, item.answers.length) > 1;
  const settled =
    item.response.outcome === "answered"
      ? m.humanInputOutcome.answered
      : item.response.outcome === "skipped"
        ? m.humanInputOutcome.skipped
        : item.response.outcome === "expired"
          ? m.humanInputOutcome.expired
          : m.humanInputOutcome.cancelled;
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
        <MessageFooter
          text={answerText || settled}
          occurredAt={item.occurredAt}
          align="end"
          onCopy={onCopy}
        />
      </View>
    </View>
  );
}
