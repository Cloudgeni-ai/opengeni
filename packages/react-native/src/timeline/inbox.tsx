// The inbox at phone width: what agents wait on the person for (questions,
// approvals, goals paused on them) and what they chose to tell them. The same
// rules as the web Inbox page: rows are messages, approvals decide in place, a
// single short choice answers in one tap, everything else opens its session.
import {
  notificationPlainText,
  parseNotificationText,
  type NotificationSpan,
} from "@opengeni/react/timeline-model";
import type { InboxItem, ListInboxResponse, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  AppState,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { withAlpha } from "./primitives";
import { SectionLabel } from "./session-list";
import { fontStyle, useNativeTimelineTheme } from "./theme";

export type NativeInboxClient = Pick<
  OpenGeniClient,
  | "listInbox"
  | "updateInboxItem"
  | "sendApprovalDecision"
  | "getHumanInputRequest"
  | "submitHumanInputResponse"
>;

type InboxState = { data: ListInboxResponse | null; error: unknown; loading: boolean };

function snoozedNow(item: InboxItem, now: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;
}

/** Questions, approvals and paused goals wait on the person; notes and replies don't. */
export function isNeedsYouKind(kind: InboxItem["kind"]): boolean {
  return kind === "question" || kind === "approval" || kind === "goal_paused";
}

/** What waits on the person right now: needs-you items plus unread notes, unsnoozed. */
export function nativeInboxAttentionCount(data: ListInboxResponse | null): number {
  if (!data) return 0;
  const now = Date.now();
  return data.items.filter(
    (item) => !snoozedNow(item, now) && (isNeedsYouKind(item.kind) || item.unread),
  ).length;
}

/**
 * An item as this app reads it. Servers from before rich notifications leave
 * out the subtitle, facts, link and moment; read those as empty.
 */
function normalizeInboxItem(item: InboxItem): InboxItem {
  return {
    ...item,
    subtitle: item.subtitle ?? "",
    facts: Array.isArray(item.facts) ? item.facts : [],
    link: item.link ?? null,
    eventSequence: item.eventSequence ?? null,
    choices: Array.isArray(item.choices) ? item.choices : [],
  };
}

/** The person's inbox, refreshed on an interval, on foreground and after every action. */
export function useNativeInbox(client: NativeInboxClient, options: { pollMs?: number } = {}) {
  const [state, setState] = useState<InboxState>({ data: null, error: null, loading: true });
  const pollMs = options.pollMs ?? 30_000;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const listed = await client.listInbox();
      const data = { ...listed, items: listed.items.map(normalizeInboxItem) };
      if (request === generation.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (request === generation.current)
        setState((current) => ({ ...current, error, loading: false }));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [pollMs, refresh]);
  const patch = useCallback((update: (items: InboxItem[]) => InboxItem[]) => {
    setState((current) =>
      current.data
        ? { ...current, data: { ...current.data, items: update(current.data.items) } }
        : current,
    );
  }, []);
  return { ...state, refresh, patch };
}

const KIND_ICON: Record<InboxItem["kind"], NativeIconName> = {
  question: "message-circle-question",
  approval: "shield-check",
  goal_paused: "circle-pause",
  notification: "bell",
  reply: "message-square-text",
};

function kindIcon(item: InboxItem): NativeIconName {
  return item.kind === "notification" && item.urgency === "time_sensitive"
    ? "bell-ring"
    : (KIND_ICON[item.kind] ?? "bell");
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

function Spans({ spans }: { spans: NotificationSpan[] }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return spans.map((span, index) =>
    span.kind === "bold" ? (
      <Text key={index} style={{ ...fontStyle(theme, 500), color: c.fg }}>
        {span.text}
      </Text>
    ) : span.kind === "code" ? (
      <Text key={index} style={{ fontFamily: MONO, fontSize: 13, color: c.fg }}>
        {span.text}
      </Text>
    ) : span.kind === "link" ? (
      <Text
        key={index}
        accessibilityRole="link"
        onPress={() => void Linking.openURL(span.href)}
        style={{ color: c.fg, textDecorationLine: "underline" }}
      >
        {span.text}
      </Text>
    ) : (
      <Text key={index}>{span.text}</Text>
    ),
  );
}

/**
 * An agent's notification under its title: the subtitle, the message (short
 * paragraphs and bullets) and its facts as a quiet two-column list.
 */
function NotificationContent({ item }: { item: InboxItem }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const blocks = parseNotificationText(item.body);
  // One label column for every fact, as wide as the longest label needs.
  const longest = Math.max(0, ...item.facts.map((fact) => fact.label.length));
  const labelWidth = Math.min(132, Math.max(56, Math.ceil(longest * 7.4) + 4));
  const text = { ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] };
  return (
    <>
      {item.subtitle ? (
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 20, color: c["fg-subtle"] }}
        >
          {item.subtitle}
        </Text>
      ) : null}
      {blocks.length > 0 ? (
        <View style={{ gap: 6, marginTop: 2 }}>
          {blocks.map((block, index) =>
            block.kind === "paragraph" ? (
              <Text key={index} style={text}>
                <Spans spans={block.spans} />
              </Text>
            ) : (
              <View key={index} style={{ gap: 2 }}>
                {block.items.map((spans, bullet) => (
                  <View key={bullet} style={{ flexDirection: "row", gap: 8 }}>
                    <View
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: 2,
                        marginTop: 8,
                        marginLeft: 2,
                        backgroundColor: c["fg-subtle"],
                      }}
                    />
                    <Text style={[text, { flex: 1 }]}>
                      <Spans spans={spans} />
                    </Text>
                  </View>
                ))}
              </View>
            ),
          )}
        </View>
      ) : null}
      {item.facts.length > 0 ? (
        <View style={{ marginTop: 8, gap: 2 }}>
          {item.facts.map((fact) => (
            <View key={fact.label} style={{ flexDirection: "row", gap: 16 }}>
              <Text
                numberOfLines={1}
                style={{
                  ...fontStyle(theme),
                  width: labelWidth,
                  fontSize: 13,
                  lineHeight: 20,
                  color: c["fg-subtle"],
                }}
              >
                {fact.label}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  ...fontStyle(theme),
                  flex: 1,
                  fontSize: 13,
                  lineHeight: 20,
                  color: c.fg,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {fact.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Each revealed swipe action's width. */
const SWIPE_ACTION = 76;
/** A partial swipe past this opens the actions. */
const SWIPE_OPEN = 56;
/** A full swipe past this dismisses outright. */
const SWIPE_FULL = 220;

type SwipeAction = { label: string; icon: NativeIconName; color: string; onPress: () => void };

/**
 * A row that swipes like Mail: drag left to reveal Snooze and Dismiss, or keep
 * going to dismiss in one motion (a light haptic marks the point). Drags to the
 * right stay with the system back gesture.
 */
function SwipeRow(props: {
  children: ReactNode;
  snooze: SwipeAction;
  dismiss: SwipeAction;
  onThreshold?: (() => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const x = useRef(new Animated.Value(0)).current;
  const width = useRef(0);
  const base = useRef(0);
  const full = useRef(false);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const settle = useCallback(
    (to: number) => {
      base.current = to;
      setOpen(to !== 0);
      Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 18 }).start(
        () => {
          if (to === 0) setDragging(false);
        },
      );
    },
    [x],
  );
  const responder = useMemo(
    () =>
      PanResponder.create({
        // Clearly horizontal drags only: to the left from rest, either way once open.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dx) > 10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6 &&
          (gesture.dx < 0 || base.current !== 0),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          x.stopAnimation();
          setDragging(true);
        },
        onPanResponderMove: (_event, gesture) => {
          const next = Math.min(0, base.current + gesture.dx);
          x.setValue(next);
          const past = next < -SWIPE_FULL;
          if (past !== full.current) {
            full.current = past;
            if (past) latest.current.onThreshold?.();
          }
        },
        onPanResponderRelease: (_event, gesture) => {
          const end = Math.min(0, base.current + gesture.dx);
          if (full.current) {
            full.current = false;
            Animated.timing(x, {
              toValue: -(width.current || 400),
              duration: 160,
              useNativeDriver: true,
            }).start(() => {
              latest.current.dismiss.onPress();
              // Back in place in case the row stays (the dismissal failed).
              setTimeout(() => {
                x.setValue(0);
                base.current = 0;
                setOpen(false);
                setDragging(false);
              }, 800);
            });
            return;
          }
          settle(end < -SWIPE_OPEN && gesture.vx <= 0.3 ? -SWIPE_ACTION * 2 : 0);
        },
        onPanResponderTerminate: () => {
          full.current = false;
          settle(0);
        },
      }),
    [settle, x],
  );
  // Snooze rides along with the row's edge on a long swipe, then fades as
  // Dismiss takes the whole strip.
  const snoozeShift = x.interpolate({
    inputRange: [-SWIPE_ACTION * 2 - 1, -SWIPE_ACTION * 2, 0],
    outputRange: [-1, 0, 0],
    extrapolateLeft: "extend",
    extrapolateRight: "clamp",
  });
  const snoozeOpacity = x.interpolate({
    inputRange: [-SWIPE_FULL, -SWIPE_ACTION * 2 - 24, 0],
    outputRange: [0, 1, 1],
    extrapolate: "clamp",
  });
  const button = (action: SwipeAction, after: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      onPress={() => {
        after();
        action.onPress();
      }}
      style={{
        width: SWIPE_ACTION,
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        backgroundColor: action.color,
      }}
    >
      <Icon name={action.icon} size={18} color="#ffffff" />
      <Text style={{ ...fontStyle(theme, 600), fontSize: 13, color: "#ffffff" }}>
        {action.label}
      </Text>
    </Pressable>
  );
  return (
    <View
      onLayout={(event: LayoutChangeEvent) => {
        width.current = event.nativeEvent.layout.width;
      }}
      style={{ overflow: "hidden", borderRadius: theme.radius.md }}
    >
      {dragging || open ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            flexDirection: "row",
            justifyContent: "flex-end",
            backgroundColor: props.dismiss.color,
          }}
        >
          <Animated.View
            style={{ opacity: snoozeOpacity, transform: [{ translateX: snoozeShift }] }}
          >
            {button(props.snooze, () => settle(0))}
          </Animated.View>
          {button(props.dismiss, () => undefined)}
        </View>
      ) : null}
      <Animated.View
        {...responder.panHandlers}
        style={{ transform: [{ translateX: x }], backgroundColor: theme.colors.bg }}
      >
        {props.children}
        {open ? (
          // While open, a tap on the row closes the actions instead of opening it.
          <Pressable
            accessibilityLabel="Close actions"
            onPress={() => settle(0)}
            style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

function tomorrowMorning(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date;
}

/** How long ago, or until when a snoozed item stays hidden. */
function when(item: InboxItem): string {
  if (item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= Date.now()) {
    return relative(item.updatedAt);
  }
  const until = new Date(item.snoozedUntil);
  const time = until.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return until.toDateString() === new Date().toDateString()
    ? `Until ${time}`
    : `Until ${until.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

export interface NativeInboxListProps {
  client: NativeInboxClient;
  inbox: ReturnType<typeof useNativeInbox>;
  /** Open the item's session (and its question or approval there). */
  onOpenSession: (item: InboxItem) => void;
  /** Names for the workspace line when items span workspaces. */
  workspaceNames?: ReadonlyMap<string, string> | undefined;
  /** A short confirmation after an action ("Approved"). */
  onNotice?: ((message: string) => void) | undefined;
  /** A light haptic when a swipe passes the point where letting go acts. */
  onSwipeThreshold?: (() => void) | undefined;
}

/** The Inbox's sections and rows; the host supplies the screen around it. */
export function NativeInboxList({
  client,
  inbox,
  onOpenSession,
  workspaceNames,
  onNotice,
  onSwipeThreshold,
}: NativeInboxListProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [busy, setBusy] = useState<Record<string, string>>({});
  const now = Date.now();
  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data]);
  const awake = items.filter((item) => !snoozedNow(item, now));
  // Most important first: what waits on the person, then agents' notes, then replies.
  const needsYou = awake.filter((item) => isNeedsYouKind(item.kind));
  const fromAgents = awake.filter((item) => item.kind === "notification");
  const replies = awake.filter((item) => item.kind === "reply");
  const snoozed = items.filter((item) => snoozedNow(item, now));
  const spansWorkspaces = new Set(items.map((item) => item.workspaceId)).size > 1;

  // Seen once shown: the server learns, the dot stays for this visit.
  const shownUnread = useRef(new Set<string>());
  useEffect(() => {
    const unseen = items.filter((item) => item.unread && !shownUnread.current.has(item.id));
    if (unseen.length === 0) return;
    for (const item of unseen) shownUnread.current.add(item.id);
    const timer = setTimeout(() => {
      for (const item of unseen)
        void client.updateInboxItem(item.id, { seen: true }).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [client, items]);

  const leave = (item: InboxItem) =>
    inbox.patch((current) => current.filter((each) => each.id !== item.id));

  const run = async (item: InboxItem, label: string, action: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [item.id]: label }));
    try {
      await action();
      void inbox.refresh();
    } catch (error) {
      Alert.alert("That didn't go through", error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(({ [item.id]: _done, ...rest }) => rest);
    }
  };

  const decide = (item: InboxItem, decision: "approve" | "reject") =>
    void run(item, decision, async () => {
      await client.sendApprovalDecision(item.workspaceId, item.sessionId, {
        approvalId: item.sourceKey,
        decision,
      });
      leave(item);
      onNotice?.(decision === "approve" ? "Approved" : "Denied");
    });

  const choose = (item: InboxItem, choice: { id: string; label: string }) =>
    void run(item, `choice:${choice.id}`, async () => {
      const request = await client.getHumanInputRequest(
        item.workspaceId,
        item.sessionId,
        item.sourceKey,
      );
      const question = request.questions[0];
      if (request.status !== "pending" || !question) {
        leave(item);
        onNotice?.("Already answered");
        return;
      }
      await client.submitHumanInputResponse(item.workspaceId, item.sessionId, item.sourceKey, {
        outcome: "answered",
        answers: [{ questionId: question.id, values: [choice.id] }],
      });
      leave(item);
      onNotice?.(`Answered: ${choice.label}`);
    });

  const snooze = (item: InboxItem, until: Date | null) =>
    void run(item, "snooze", async () => {
      const snoozedUntil = until ? until.toISOString() : null;
      inbox.patch((current) =>
        current.map((each) => (each.id === item.id ? { ...each, snoozedUntil } : each)),
      );
      await client.updateInboxItem(item.id, { snoozedUntil });
    });

  const dismiss = (item: InboxItem) =>
    void run(item, "dismiss", async () => {
      leave(item);
      await client.updateInboxItem(item.id, { dismissed: true });
    });

  const showSheet = (
    title: string,
    actions: Array<{ label: string; run: () => void; destructive?: boolean }>,
  ) => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          options: [...actions.map((action) => action.label), "Cancel"],
          cancelButtonIndex: actions.length,
          destructiveButtonIndex: actions.findIndex((action) => action.destructive),
        },
        (index) => actions[index]?.run(),
      );
      return;
    }
    Alert.alert(title, undefined, [
      ...actions.map((action) => ({
        text: action.label,
        style: action.destructive ? ("destructive" as const) : ("default" as const),
        onPress: action.run,
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  // A swipe toward the right snoozes: pick how long, or bring a snoozed one back.
  const swipeSnooze = (item: InboxItem) => {
    if (snoozedNow(item, Date.now())) {
      snooze(item, null);
      onNotice?.("Back in your inbox");
      return;
    }
    showSheet("Snooze", [
      { label: "For 1 hour", run: () => snooze(item, new Date(Date.now() + 3_600_000)) },
      { label: "Until tomorrow morning", run: () => snooze(item, tomorrowMorning()) },
    ]);
  };

  const openMenu = (item: InboxItem) => {
    const isSnoozed = snoozedNow(item, Date.now());
    const actions: Array<{ label: string; run: () => void; destructive?: boolean }> = [
      { label: "Open session", run: () => onOpenSession(item) },
      ...(isSnoozed
        ? [{ label: "Unsnooze", run: () => snooze(item, null) }]
        : [
            {
              label: "Snooze for 1 hour",
              run: () => snooze(item, new Date(Date.now() + 3_600_000)),
            },
            { label: "Snooze until tomorrow", run: () => snooze(item, tomorrowMorning()) },
          ]),
      {
        label: isNeedsYouKind(item.kind) ? "Remove from inbox" : "Dismiss",
        run: () => dismiss(item),
        destructive: true,
      },
    ];
    showSheet(item.title, actions);
  };

  // Where it comes from; the time sits apart so a long session title never hides it.
  const meta = (item: InboxItem): string => {
    const parts: string[] = [];
    if (item.kind === "notification" && item.urgency === "time_sensitive") {
      parts.push("Time-sensitive");
    }
    if (item.kind === "question") parts.push("Question");
    if (item.kind === "goal_paused") parts.push("Goal paused");
    if (item.kind === "reply") parts.push("Reply");
    if (item.kind === "approval" && !item.body) parts.push("Approval");
    parts.push(item.sessionTitle ?? "Untitled session");
    const workspace = spansWorkspaces ? workspaceNames?.get(item.workspaceId) : undefined;
    if (workspace) parts.push(workspace);
    if (item.kind === "question" && item.body) parts.push(item.body);
    return parts.join(" · ");
  };

  const actions = (item: InboxItem) => {
    const pending = busy[item.id];
    if (item.kind === "approval") {
      return (
        <>
          <Button
            label={pending === "reject" ? "Denying…" : "Deny"}
            icon="x"
            disabled={Boolean(pending)}
            onPress={() => decide(item, "reject")}
          />
          <Button
            label={pending === "approve" ? "Approving…" : "Approve"}
            icon="check"
            disabled={Boolean(pending)}
            onPress={() => decide(item, "approve")}
          />
        </>
      );
    }
    if (item.kind === "question" && item.choices.length > 0) {
      return item.choices.map((choice) => (
        <Button
          key={choice.id}
          label={pending === `choice:${choice.id}` ? "Sending…" : choice.label}
          disabled={Boolean(pending)}
          onPress={() => choose(item, choice)}
        />
      ));
    }
    if (item.kind === "question") {
      return (
        <Button label="Answer" disabled={Boolean(pending)} onPress={() => onOpenSession(item)} />
      );
    }
    if (item.kind === "notification" && item.link) {
      const url = item.link.url;
      return (
        <Button
          label={item.link.label}
          icon="arrow-up-right"
          onPress={() => void Linking.openURL(url)}
        />
      );
    }
    return null;
  };

  const row = (item: InboxItem, index: number) => {
    const unread = !isNeedsYouKind(item.kind) && (item.unread || shownUnread.current.has(item.id));
    const rowActions = actions(item);
    return (
      <View key={item.id}>
        {index > 0 ? (
          <View style={{ height: 1, marginLeft: 48, backgroundColor: c.border }} />
        ) : null}
        <SwipeRow
          onThreshold={onSwipeThreshold}
          snooze={{
            label: snoozedNow(item, now) ? "Unsnooze" : "Snooze",
            icon: "alarm-clock",
            color: c["status-waiting"],
            onPress: () => swipeSnooze(item),
          }}
          dismiss={{
            label: isNeedsYouKind(item.kind) ? "Remove" : "Dismiss",
            icon: "x",
            color: c["danger-fill"],
            onPress: () => dismiss(item),
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. ${meta(item)}, ${when(item)}`}
            accessibilityHint="Opens the session"
            accessibilityActions={[
              { name: "snooze", label: snoozedNow(item, now) ? "Unsnooze" : "Snooze" },
              {
                name: "dismiss",
                label: item.kind === "notification" ? "Dismiss" : "Remove from inbox",
              },
            ]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "snooze") swipeSnooze(item);
              if (event.nativeEvent.actionName === "dismiss") dismiss(item);
            }}
            onPress={() => onOpenSession(item)}
            onLongPress={() => openMenu(item)}
            style={({ pressed }) => ({
              flexDirection: "row",
              gap: 12,
              paddingVertical: 14,
              paddingHorizontal: 4,
              borderRadius: theme.radius.md,
              backgroundColor: pressed ? c.hover : "transparent",
            })}
          >
            <View style={{ width: 32, height: 32, marginTop: 1 }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: c["surface-2"],
                }}
              >
                <Icon
                  name={kindIcon(item)}
                  size={16}
                  color={
                    item.kind === "notification" && item.urgency === "time_sensitive"
                      ? c["status-waiting"]
                      : c["fg-muted"]
                  }
                />
              </View>
              {unread ? (
                <View
                  accessibilityLabel="Unread"
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    borderWidth: 2,
                    borderColor: c.bg,
                    backgroundColor: c.accent,
                  }}
                />
              ) : null}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={2}
                style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 20, color: c.fg }}
              >
                {item.title}
              </Text>
              {item.body && item.kind === "approval" ? (
                <View
                  style={{
                    alignSelf: "flex-start",
                    maxWidth: "100%",
                    marginTop: 4,
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 6,
                    backgroundColor: c["surface-2"],
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                      fontSize: 12,
                      color: c.fg,
                    }}
                  >
                    {item.body}
                  </Text>
                </View>
              ) : item.kind === "notification" ? (
                <NotificationContent item={item} />
              ) : item.kind === "reply" && item.body ? (
                <Text
                  numberOfLines={2}
                  style={{
                    ...fontStyle(theme),
                    fontSize: 14,
                    lineHeight: 20,
                    color: c["fg-muted"],
                  }}
                >
                  {notificationPlainText(item.body)}
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", marginTop: 2 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    ...fontStyle(theme),
                    flexShrink: 1,
                    fontSize: 12,
                    lineHeight: 18,
                    color: c["fg-subtle"],
                  }}
                >
                  {meta(item)}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    ...fontStyle(theme),
                    fontSize: 12,
                    lineHeight: 18,
                    color: c["fg-subtle"],
                  }}
                >
                  {` · ${when(item)}`}
                </Text>
              </View>
              {rowActions ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                  {rowActions}
                </View>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`More actions for ${item.title}`}
              hitSlop={8}
              onPress={() => openMenu(item)}
              style={({ pressed }) => ({
                width: 32,
                height: 32,
                marginTop: -4,
                marginRight: -4,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                backgroundColor: pressed ? c["surface-3"] : "transparent",
              })}
            >
              <Icon name="ellipsis" size={16} color={c["fg-subtle"]} />
            </Pressable>
          </Pressable>
        </SwipeRow>
      </View>
    );
  };

  const section = (title: string, list: InboxItem[], first: boolean) =>
    list.length === 0 ? null : (
      <View key={title} style={{ marginTop: first ? 16 : 32 }}>
        <View style={{ paddingHorizontal: 2 }}>
          <SectionLabel>{title}</SectionLabel>
        </View>
        {list.map(row)}
      </View>
    );

  // A failed first load says so, rather than claiming nothing waits.
  if (!inbox.data && inbox.error && !inbox.loading) {
    return (
      <View style={{ alignItems: "center", paddingTop: 72, paddingHorizontal: 32, gap: 12 }}>
        <Text style={{ ...fontStyle(theme, 600), fontSize: 16, color: c.fg, textAlign: "center" }}>
          Couldn't load your inbox
        </Text>
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: 14,
            lineHeight: 20,
            color: c["fg-muted"],
            textAlign: "center",
          }}
        >
          Check your connection, or this server may not have the inbox yet.
        </Text>
        <Button label="Try again" onPress={() => void inbox.refresh()} />
      </View>
    );
  }

  if (awake.length === 0 && snoozed.length === 0) {
    return (
      <View style={{ alignItems: "center", paddingTop: 72, paddingHorizontal: 32, gap: 10 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(c["fg-muted"], 0.08),
          }}
        >
          <Icon name="inbox" size={20} color={c["fg-muted"]} />
        </View>
        <Text style={{ ...fontStyle(theme, 600), fontSize: 16, color: c.fg, textAlign: "center" }}>
          {inbox.loading ? "Loading your inbox" : "Nothing is waiting on you"}
        </Text>
        {inbox.loading ? null : (
          <Text
            style={{
              ...fontStyle(theme),
              fontSize: 14,
              lineHeight: 20,
              color: c["fg-muted"],
              textAlign: "center",
            }}
          >
            When an agent asks you something, needs an approval or wants you to know something, it
            shows up here.
          </Text>
        )}
      </View>
    );
  }

  return (
    <View>
      {section("Needs you", needsYou, true)}
      {section("From your agents", fromAgents, needsYou.length === 0)}
      {section("Replies", replies, needsYou.length === 0 && fromAgents.length === 0)}
      {awake.length === 0 ? (
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: 14,
            color: c["fg-muted"],
            marginTop: 8,
            paddingHorizontal: 4,
          }}
        >
          Nothing needs you right now. Snoozed items come back on their own.
        </Text>
      ) : null}
      {section("Snoozed", snoozed, awake.length === 0)}
    </View>
  );
}
