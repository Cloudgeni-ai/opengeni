import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import Constants from "expo-constants";
import { Stack, router } from "expo-router";
import { Alert } from "react-native";
import { useAccount } from "@/account";
import { setAppearance, useAppearancePreference, type AppearancePreference } from "@/appearance";
import { serverLabel } from "@/account-store";
import {
  setOutsideCallTarget,
  useOutsideCallPreferences,
  type OutsideCallTarget,
} from "@/call-preferences";
import { useInboxSettingsSection, useNotificationSettingsSection } from "@/notifications";
import { SettingsList } from "@/settings-list";
import type { SettingsSection } from "@/settings-model";
import { dismissToHome } from "@/navigation";
import { AppThemeProvider } from "@/theme";
import { openOnWeb, webPaths } from "@/web-links";

export default function SettingsScreen() {
  return (
    <AppThemeProvider>
      <Settings />
    </AppThemeProvider>
  );
}

/* Accounts on this device; the current organization and workspace, whose
   administration stays on the web; notifications; sign out. */
function Settings() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const appearance = useAppearancePreference();
  const { target: outsideCallTarget, pinned: pinnedCallSession } = useOutsideCallPreferences();
  const { accounts, account, workspace, organizations, switchAccount, signOut } = useAccount();
  const notifications = useNotificationSettingsSection();
  const inboxSettings = useInboxSettingsSection();
  const org = organizations.find((each) => each.accountId === workspace?.accountId);
  const multipleServers = new Set(accounts.map((each) => each.baseUrl)).size > 1;

  const confirmSignOut = () => {
    if (!account) return;
    Alert.alert(
      `Sign out of ${account.email}?`,
      `This device stops using Opengeni on ${serverLabel(account.baseUrl)}. Other accounts stay signed in.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void signOut(account.id).then(() => dismissToHome());
          },
        },
      ],
    );
  };

  const sections: SettingsSection[] = [
    {
      id: "accounts",
      title: "Accounts",
      rows: [
        ...accounts.map((each) => ({
          kind: "choice" as const,
          id: each.id,
          title: each.email,
          subtitle: each.signedOut
            ? `${serverLabel(each.baseUrl)} · Signed out`
            : multipleServers || accounts.length > 1
              ? serverLabel(each.baseUrl)
              : undefined,
          selected: each.id === account?.id,
          onPress: () => {
            switchAccount(each.id);
            dismissToHome();
          },
        })),
        {
          kind: "action" as const,
          id: "add-account",
          title: "Add account",
          symbol: "plus" as const,
          onPress: () => router.push("/add-account"),
        },
      ],
    },
  ];
  if (account && workspace) {
    sections.push({
      id: "workspace",
      title: org?.label ?? "Organization",
      rows: [
        {
          kind: "external",
          id: "workspace-settings",
          title: "Workspace settings",
          subtitle: workspace.name,
          symbol: workspace.kind === "personal" ? "lock" : "square.stack",
          onPress: () => openOnWeb(account.baseUrl, webPaths.workspaceSettings(workspace.id)),
        },
        ...(org?.canManage
          ? [
              {
                kind: "external" as const,
                id: "organization-settings",
                title: "Organization settings",
                subtitle: "Members, billing, models and plugins",
                symbol: "building.2" as const,
                onPress: () =>
                  openOnWeb(account.baseUrl, webPaths.organizationSettings(workspace.id)),
              },
            ]
          : []),
      ],
    });
  }
  if (account && notifications) sections.push(notifications);
  if (account && inboxSettings) sections.push(inboxSettings);
  const appearances: { id: AppearancePreference; title: string }[] = [
    { id: "system", title: "System" },
    { id: "light", title: "Light" },
    { id: "dark", title: "Dark" },
  ];
  sections.push({
    id: "appearance",
    title: "Appearance",
    rows: appearances.map((each) => ({
      kind: "choice" as const,
      id: `appearance-${each.id}`,
      title: each.title,
      selected: appearance === each.id,
      onPress: () => setAppearance(each.id),
    })),
  });
  const callTargets: { id: OutsideCallTarget; title: string; subtitle: string }[] = [
    {
      id: "latest",
      title: "Continue your last session",
      subtitle: "The conversation you last had open",
    },
    { id: "new", title: "Start a new session", subtitle: "A fresh conversation for each call" },
    {
      id: "pinned",
      title: "Call a chosen session",
      subtitle: pinnedCallSession
        ? pinnedCallSession.title || "Untitled session"
        : "Choose one with “Take calls here” in a session's menu",
    },
  ];
  sections.push({
    id: "calls",
    title: "Calls from outside the app",
    footer:
      "Applies to calls from the Phone app's recents, Siri, the home-screen action and Shortcuts (opengeni://call). Calling from a session always talks to that session.",
    rows: callTargets.map((each) => ({
      kind: "choice" as const,
      id: `calls-${each.id}`,
      title: each.title,
      subtitle: each.subtitle,
      selected: outsideCallTarget === each.id,
      onPress: () => {
        if (each.id === "pinned" && !pinnedCallSession) {
          Alert.alert(
            "Choose a session first",
            "Open the session you want to call, tap its ⋯ menu and choose “Take calls here”.",
          );
          return;
        }
        setOutsideCallTarget(each.id);
      },
    })),
  });
  if (account) {
    sections.push({
      id: "you",
      title: account.email,
      footer: `Opengeni ${Constants.expoConfig?.version ?? ""} · ${serverLabel(account.baseUrl)}`,
      rows: [
        {
          kind: "external",
          id: "security",
          title: "Security and sign-in",
          symbol: "key",
          onPress: () => openOnWeb(account.baseUrl, webPaths.security()),
        },
        {
          kind: "destructive",
          id: "sign-out",
          title: "Sign out",
          symbol: "rectangle.portrait.and.arrow.right",
          onPress: confirmSignOut,
        },
      ],
    });
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "Settings",
          headerTintColor: c.fg,
          headerShadowVisible: false,
          // The list paints the app canvas, so the bar matches every other screen.
          headerStyle: { backgroundColor: c.bg },
        }}
      />
      <SettingsList sections={sections} />
    </>
  );
}
