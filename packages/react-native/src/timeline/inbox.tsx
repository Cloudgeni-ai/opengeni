// The inbox at phone width: what agents wait on the person for (questions,
// approvals, goals paused on them) and what they chose to tell them. The same
// rules as the web Inbox page: rows are messages, approvals decide in place, a
// single short choice answers in one tap, everything else opens its session.
import type { InboxItem, ListInboxResponse, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Alert, AppState, Platform, Pressable, Text, View } from "react-native";

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

/** What waits on the person right now: needs-you items plus unread notes, unsnoozed. */
export function nativeInboxAttentionCount(data: ListInboxResponse | null): number {
  if (!data) return 0;
  const now = Date.now();
  return data.items.filter(
    (item) => !snoozedNow(item, now) && (item.kind !== "notification" || item.unread),
  ).length;
}

/** The person's inbox, refreshed on an interval, on foreground and after every action. */
export function useNativeInbox(client: NativeInboxClient, options: { pollMs?: number } = {}) {
  const [state, setState] = useState<InboxState>({ data: null, error: null, loading: true });
  const pollMs = options.pollMs ?? 30_000;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const data = await client.listInbox();
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
};

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

export interface NativeInboxListProps {
  client: NativeInboxClient;
  inbox: ReturnType<typeof useNativeInbox>;
  /** Open the item's session (and its question or approval there). */
  onOpenSession: (item: InboxItem) => void;
  /** Names for the workspace line when items span workspaces. */
  workspaceNames?: ReadonlyMap<string, string> | undefined;
  /** A short confirmation after an action ("Approved"). */
  onNotice?: ((message: string) => void) | undefined;
}

/** The Inbox's sections and rows; the host supplies the screen around it. */
export function NativeInboxList({
  client,
  inbox,
  onOpenSession,
  workspaceNames,
  onNotice,
}: NativeInboxListProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [busy, setBusy] = useState<Record<string, string>>({});
  const now = Date.now();
  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data]);
  const awake = items.filter((item) => !snoozedNow(item, now));
  const needsYou = awake.filter((item) => item.kind !== "notification");
  const fromAgents = awake.filter((item) => item.kind === "notification");
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
        label: item.kind === "notification" ? "Dismiss" : "Remove from inbox",
        run: () => dismiss(item),
        destructive: true,
      },
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: item.title,
          options: [...actions.map((action) => action.label), "Cancel"],
          cancelButtonIndex: actions.length,
          destructiveButtonIndex: actions.findIndex((action) => action.destructive),
        },
        (index) => actions[index]?.run(),
      );
      return;
    }
    Alert.alert(item.title, undefined, [
      ...actions.map((action) => ({
        text: action.label,
        style: action.destructive ? ("destructive" as const) : ("default" as const),
        onPress: action.run,
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  // Where it comes from; the time sits apart so a long session title never hides it.
  const meta = (item: InboxItem): string => {
    const parts: string[] = [];
    if (item.kind === "question") parts.push("Question");
    if (item.kind === "goal_paused") parts.push("Goal paused");
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
    return null;
  };

  const row = (item: InboxItem, index: number) => {
    const unread =
      item.kind === "notification" && (item.unread || shownUnread.current.has(item.id));
    const rowActions = actions(item);
    return (
      <View key={item.id}>
        {index > 0 ? (
          <View style={{ height: 1, marginLeft: 48, backgroundColor: c.border }} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.title}. ${meta(item)}, ${relative(item.updatedAt)}`}
          accessibilityHint="Opens the session"
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
              <Icon name={KIND_ICON[item.kind]} size={16} color={c["fg-muted"]} />
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
            ) : item.body && item.kind === "notification" ? (
              <Text
                numberOfLines={2}
                style={{ ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] }}
              >
                {item.body}
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
                style={{ ...fontStyle(theme), fontSize: 12, lineHeight: 18, color: c["fg-subtle"] }}
              >
                {` · ${relative(item.updatedAt)}`}
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
