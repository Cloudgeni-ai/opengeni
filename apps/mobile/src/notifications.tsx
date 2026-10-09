import type {
  InboxSettings,
  ListInboxResponse,
  NativePushDevice,
  NativePushRule,
  OpenGeniClient,
} from "@opengeni/sdk";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import { useAccount } from "@/account";
import type { SettingsSection } from "@/settings-model";

/** The rules a person can turn on, in the order Settings shows them. */
export const NOTIFICATION_RULES: Array<{ rule: NativePushRule; title: string; subtitle: string }> =
  [
    {
      rule: "needs_input",
      title: "Needs you",
      subtitle: "The agent asks a question or needs an approval",
    },
    { rule: "reply_ready", title: "Replies", subtitle: "The agent finished a reply" },
    { rule: "failed", title: "Failures", subtitle: "A turn failed" },
    { rule: "agent", title: "From the agent", subtitle: "The agent chose to notify you" },
  ];

const DEFAULT_RULES: NativePushRule[] = ["needs_input", "failed", "agent"];

/** The data every Opengeni push carries, so a tap can open the right place. */
export interface PushData {
  sessionId?: string;
  workspaceId?: string;
  subjectId?: string;
  rule?: NativePushRule;
  eventType?: string;
  /** The session event the push is about; opening lands on it. */
  sequence?: number;
}

function sessionPath(data: PushData): string {
  return data.sequence
    ? `/session/${data.sessionId}?at=${data.sequence}`
    : `/session/${data.sessionId}`;
}

/*
 * Actions on the notification itself. Approve asks for the device to be
 * unlocked first; Deny and an inline answer don't open the app. Categories
 * are static, so a question's own options open the app instead of showing as
 * buttons.
 */
const APPROVE_ACTION = "og.approve";
const DENY_ACTION = "og.deny";
const REPLY_ACTION = "og.reply";
void Notifications.setNotificationCategoryAsync("og.approval", [
  {
    identifier: APPROVE_ACTION,
    buttonTitle: "Approve",
    options: { opensAppToForeground: false, isAuthenticationRequired: true },
  },
  {
    identifier: DENY_ACTION,
    buttonTitle: "Deny",
    options: { opensAppToForeground: false, isDestructive: true },
  },
]).catch(() => undefined);
void Notifications.setNotificationCategoryAsync("og.question", [
  {
    identifier: REPLY_ACTION,
    buttonTitle: "Answer",
    textInput: { submitButtonTitle: "Send", placeholder: "Your answer" },
    options: { opensAppToForeground: false, isAuthenticationRequired: true },
  },
]).catch(() => undefined);

/**
 * Act on a notification's button without opening the app: decide the one open
 * approval in that session, or answer its one open question. Returns false when
 * the app has to open (several open, or a question that needs the full form).
 */
async function actOnNotification(
  client: OpenGeniClient,
  data: PushData,
  action: string,
  text: string | undefined,
): Promise<boolean> {
  if (!data.sessionId) return false;
  const inbox = await client.listInbox();
  const kind = action === REPLY_ACTION ? "question" : "approval";
  const open = inbox.items.filter(
    (item) => item.sessionId === data.sessionId && item.kind === kind,
  );
  const item = open[0];
  if (open.length !== 1 || !item) return false;
  if (kind === "approval") {
    await client.sendApprovalDecision(item.workspaceId, item.sessionId, {
      approvalId: item.sourceKey,
      decision: action === APPROVE_ACTION ? "approve" : "reject",
    });
    return true;
  }
  const answer = text?.trim();
  if (!answer) return false;
  const request = await client.getHumanInputRequest(
    item.workspaceId,
    item.sessionId,
    item.sourceKey,
  );
  const question = request.questions[0];
  if (request.status !== "pending" || request.questions.length !== 1 || !question) return false;
  if (question.kind === "text") {
    await client.submitHumanInputResponse(item.workspaceId, item.sessionId, item.sourceKey, {
      outcome: "answered",
      answers: [{ questionId: question.id, values: [answer] }],
    });
    return true;
  }
  // A choice question takes a typed answer only where it allows its own words.
  if (!question.allowOther) return false;
  await client.submitHumanInputResponse(item.workspaceId, item.sessionId, item.sourceKey, {
    outcome: "answered",
    answers: [{ questionId: question.id, values: [], other: answer }],
  });
  return true;
}

/**
 * Keep the phone in step with the inbox: the app badge counts what waits on
 * the person, and delivered notifications whose item was answered, decided or
 * withdrawn (here or anywhere else) leave Notification Center.
 */
export async function syncInboxBadge(inbox: ListInboxResponse): Promise<void> {
  const now = Date.now();
  const awake = inbox.items.filter(
    (item) => item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now,
  );
  const count = awake.filter(
    (item) =>
      item.kind === "question" ||
      item.kind === "approval" ||
      item.kind === "goal_paused" ||
      item.unread,
  ).length;
  await Notifications.setBadgeCountAsync(count).catch(() => undefined);
  const presented = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  for (const notification of presented) {
    const data = notification.request.content.data as PushData | undefined;
    if (!data?.sessionId) continue;
    const kinds =
      data.rule === "needs_input"
        ? ["question", "approval", "goal_paused"]
        : data.rule === "agent"
          ? ["notification"]
          : null;
    if (!kinds) continue;
    const stillOpen = inbox.items.some(
      (item) => item.sessionId === data.sessionId && kinds.includes(item.kind),
    );
    if (!stillOpen) {
      await Notifications.dismissNotificationAsync(notification.request.identifier).catch(
        () => undefined,
      );
    }
  }
}

function appId(): string {
  return (
    (Platform.OS === "ios"
      ? Constants.expoConfig?.ios?.bundleIdentifier
      : Constants.expoConfig?.android?.package) ?? "ai.opengeni.app"
  );
}

async function devicePushToken(): Promise<string> {
  const token = await Notifications.getDevicePushTokenAsync();
  return typeof token.data === "string" ? token.data : JSON.stringify(token.data);
}

/**
 * The Notifications section of Settings for the active account: whether this
 * device gets pushes for it, and for which events. Each signed-in account
 * registers this device with its own credential, so every account's pushes
 * arrive and sign-out stops them.
 */
export function useNotificationSettingsSection(): SettingsSection | null {
  const { account, client, status } = useAccount();
  const [device, setDevice] = useState<NativePushDevice | null | undefined>(undefined);
  const [permission, setPermission] = useState<Notifications.PermissionStatus | null>(null);
  // Android 13+ reports "denied" before the first prompt; only a refusal the
  // system won't ask again for sends the person to system settings.
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready") return;
    let live = true;
    void Notifications.getPermissionsAsync().then((result) => {
      if (!live) return;
      setPermission(result.status);
      setCanAskAgain(result.canAskAgain);
    });
    client
      .getNativePushDevice()
      .then((next) => {
        if (live) setDevice(next);
      })
      .catch(() => {
        if (live) setDevice(null);
      });
    return () => {
      live = false;
    };
  }, [client, status, account?.id]);

  const save = useCallback(
    async (rules: NativePushRule[]) => {
      setProblem(null);
      try {
        if (rules.length === 0) {
          await client.unregisterNativePushDevice();
          setDevice(null);
          return;
        }
        let granted = permission === "granted";
        if (!granted) {
          const asked = await Notifications.requestPermissionsAsync();
          setPermission(asked.status);
          setCanAskAgain(asked.canAskAgain);
          granted = asked.status === "granted";
        }
        if (!granted) return;
        const token = await devicePushToken();
        setDevice(
          await client.registerNativePushDevice({
            platform: Platform.OS === "android" ? "android" : "ios",
            appId: appId(),
            environment: __DEV__ ? "development" : "production",
            token,
            rules,
          }),
        );
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "";
        setProblem(
          /firebase|googleServicesFile|aps-environment|entitlement/iu.test(message)
            ? "This build of the app isn't set up for push notifications."
            : "Notifications couldn't be turned on. Try again.",
        );
      }
    },
    [client, permission],
  );

  if (status !== "ready" || device === undefined) return null;
  const rules = device?.rules ?? [];
  if (permission === "denied" && !canAskAgain) {
    return {
      id: "notifications",
      title: "Notifications",
      footer: "Notifications are off for Opengeni in system settings.",
      rows: [
        {
          kind: "action",
          id: "open-settings",
          title: "Turn on in system settings",
          symbol: "bell.badge",
          onPress: () => void Linking.openSettings(),
        },
      ],
    };
  }
  return {
    id: "notifications",
    title: "Notifications",
    footer:
      problem ??
      (device
        ? "Sent to this device for sessions you start. Tap one to open the session."
        : "Get a push when a session you started needs you."),
    rows: device
      ? NOTIFICATION_RULES.map(({ rule, title, subtitle }) => ({
          kind: "toggle" as const,
          id: rule,
          title,
          subtitle,
          value: rules.includes(rule),
          onChange: (on: boolean) =>
            void save(on ? [...rules, rule] : rules.filter((each) => each !== rule)),
        }))
      : [
          {
            kind: "action" as const,
            id: "enable",
            title: "Turn on notifications",
            symbol: "bell" as const,
            onPress: () => void save(DEFAULT_RULES),
          },
        ],
  };
}

/** The session the person is looking at, so its own pushes stay quiet. */
let visibleSessionId: string | null = null;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as PushData | undefined;
    const quiet = Boolean(data?.sessionId && data.sessionId === visibleSessionId);
    return {
      shouldShowBanner: !quiet,
      shouldShowList: true,
      shouldPlaySound: !quiet,
      shouldSetBadge: false,
    };
  },
});

/**
 * Open the session a tapped notification is about, in the account it belongs
 * to: switch account and workspace first when needed. Also refreshes this
 * device's token for the active account when notifications are on.
 */
export function NotificationRouting() {
  const { accounts, account, status, switchAccount, setWorkspaceId, client } = useAccount();
  const pathname = usePathname();
  const pending = useRef<{ accountId: string; data: PushData } | null>(null);
  visibleSessionId = pathname.startsWith("/session/") ? pathname.slice("/session/".length) : null;

  const open = useCallback(
    (data: PushData) => {
      if (!data.sessionId) return;
      const owner = data.subjectId
        ? accounts.find((each) => each.subjectId === data.subjectId && !each.signedOut)
        : account;
      if (owner && owner.id !== account?.id) {
        pending.current = { accountId: owner.id, data };
        switchAccount(owner.id);
        return;
      }
      if (data.workspaceId) setWorkspaceId(data.workspaceId);
      router.push(sessionPath(data));
    },
    [account, accounts, setWorkspaceId, switchAccount],
  );

  // After an account switch for a tapped notification, finish opening it.
  useEffect(() => {
    const target = pending.current;
    if (!target || status !== "ready" || account?.id !== target.accountId) return;
    pending.current = null;
    const data = target.data;
    if (data.workspaceId) setWorkspaceId(data.workspaceId);
    router.push(sessionPath(data));
  }, [account?.id, setWorkspaceId, status]);

  // Each tapped notification opens once: one subscription for the app's life
  // (a new subscription can replay the last response), reading the latest
  // account state through a ref.
  const openRef = useRef(open);
  openRef.current = open;
  const clientRef = useRef(client);
  clientRef.current = client;
  const handled = useRef(new Set<string>());
  const respond = useCallback((response: Notifications.NotificationResponse) => {
    const id = response.notification.request.identifier;
    const action = response.actionIdentifier;
    const key = `${id}:${action}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);
    const data = response.notification.request.content.data as PushData;
    if (action === APPROVE_ACTION || action === DENY_ACTION || action === REPLY_ACTION) {
      // Settled from the notification: confirm quietly, or open the session when
      // the action needs more than a button (several open, a full form).
      void actOnNotification(clientRef.current, data, action, response.userText)
        .then(async (settled) => {
          if (!settled) {
            openRef.current(data);
            return;
          }
          await Notifications.dismissNotificationAsync(id).catch(() => undefined);
          const inbox = await clientRef.current.listInbox().catch(() => null);
          if (inbox) await syncInboxBadge(inbox);
        })
        .catch(() => openRef.current(data));
      return;
    }
    openRef.current(data);
  }, []);
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(respond);
    return () => subscription.remove();
  }, [respond]);

  const handledLaunch = useRef(false);
  useEffect(() => {
    if (handledLaunch.current || status !== "ready") return;
    handledLaunch.current = true;
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) respond(response);
    });
  }, [respond, status]);

  // Coming to the foreground brings the badge and Notification Center in step
  // with the inbox, so answered or withdrawn items don't linger on the phone.
  useEffect(() => {
    if (status !== "ready") return;
    const sync = () =>
      void client
        .listInbox()
        .then(syncInboxBadge)
        .catch(() => undefined);
    sync();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") sync();
    });
    return () => subscription.remove();
  }, [client, status]);

  // Tokens rotate: re-register the current token for the active account.
  useEffect(() => {
    if (status !== "ready") return;
    let live = true;
    void (async () => {
      const device = await client.getNativePushDevice().catch(() => null);
      if (!live || !device || device.rules.length === 0) return;
      const { status: granted } = await Notifications.getPermissionsAsync();
      if (granted !== "granted") return;
      const token = await devicePushToken().catch(() => null);
      if (!token || token === device.token) return;
      await client
        .registerNativePushDevice({
          platform: Platform.OS === "android" ? "android" : "ios",
          appId: appId(),
          environment: __DEV__ ? "development" : "production",
          token,
          rules: device.rules,
        })
        .catch(() => undefined);
    })();
    return () => {
      live = false;
    };
  }, [client, status]);

  return null;
}

/**
 * The Inbox section of Settings: what besides questions, approvals and agents'
 * notes the active account's inbox keeps. The same settings as the web Inbox page.
 */
export function useInboxSettingsSection(): SettingsSection | null {
  const { account, client, status } = useAccount();
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    let live = true;
    client
      .getInboxSettings()
      .then((next) => {
        if (live) setSettings(next);
      })
      .catch(() => {
        if (live) setSettings(null);
      });
    return () => {
      live = false;
    };
  }, [client, status, account?.id]);
  const change = useCallback(
    async (next: Partial<InboxSettings>) => {
      if (!settings) return;
      const previous = settings;
      const wanted = { ...settings, ...next };
      setSettings(wanted);
      setProblem(null);
      try {
        setSettings(await client.updateInboxSettings(wanted));
      } catch {
        setSettings(previous);
        setProblem("That setting couldn't be saved. Try again.");
      }
    },
    [client, settings],
  );
  // A server that doesn't know these settings yet leaves them out: show only what it keeps.
  const supportsReplies = typeof settings?.replies === "boolean";
  const supportsPausedGoals = typeof settings?.pausedGoals === "boolean";
  if (status !== "ready" || !settings || (!supportsReplies && !supportsPausedGoals)) return null;
  return {
    id: "inbox",
    title: "Inbox",
    footer:
      problem ??
      "Questions, approvals and agents' notes always reach your inbox. Replies stay until you swipe them away.",
    rows: [
      ...(supportsReplies
        ? [
            {
              kind: "toggle" as const,
              id: "replies",
              title: "Replies",
              subtitle: "Each session's latest reply",
              value: settings.replies ?? false,
              onChange: (on: boolean) => void change({ replies: on }),
            },
          ]
        : []),
      ...(supportsPausedGoals
        ? [
            {
              kind: "toggle" as const,
              id: "paused-goals",
              title: "Paused goals",
              subtitle: "When an agent pauses a goal",
              value: settings.pausedGoals ?? false,
              onChange: (on: boolean) => void change({ pausedGoals: on }),
            },
          ]
        : []),
    ],
  };
}

/**
 * Looking at a session reads its replies and agent notes in the inbox (they
 * stay there until cleared). Needs-you items are untouched: those leave only
 * when answered.
 */
export async function markSessionInboxRead(
  client: OpenGeniClient,
  sessionId: string,
): Promise<void> {
  const inbox = await client.listInbox().catch(() => null);
  if (!inbox) return;
  const unread = inbox.items.filter(
    (item) =>
      item.sessionId === sessionId &&
      item.unread &&
      (item.kind === "reply" || item.kind === "notification"),
  );
  if (unread.length === 0) return;
  await Promise.all(
    unread.map((item) => client.updateInboxItem(item.id, { seen: true }).catch(() => undefined)),
  );
  await syncInboxBadge({
    ...inbox,
    items: inbox.items.map((item) =>
      unread.some((each) => each.id === item.id) ? { ...item, unread: false } : item,
    ),
  });
}
