import type { NativePushDevice, NativePushRule } from "@opengeni/sdk";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
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

/** The data every OpenGeni push carries, so a tap can open the right place. */
export interface PushData {
  sessionId?: string;
  workspaceId?: string;
  subjectId?: string;
}

function appId(): string {
  return (
    (Platform.OS === "ios"
      ? Constants.expoConfig?.ios?.bundleIdentifier
      : Constants.expoConfig?.android?.package) ?? "dev.opengeni.app"
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
      router.push(`/session/${data.sessionId}`);
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
    router.push(`/session/${data.sessionId}`);
  }, [account?.id, setWorkspaceId, status]);

  // Each tapped notification opens once: one subscription for the app's life
  // (a new subscription can replay the last response), reading the latest
  // account state through a ref.
  const openRef = useRef(open);
  openRef.current = open;
  const handled = useRef(new Set<string>());
  const respond = useCallback((response: Notifications.NotificationResponse) => {
    const id = response.notification.request.identifier;
    if (handled.current.has(id)) return;
    handled.current.add(id);
    openRef.current(response.notification.request.content.data as PushData);
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
