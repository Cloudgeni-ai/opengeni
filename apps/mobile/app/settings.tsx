import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import Constants from "expo-constants";
import { Stack, router } from "expo-router";
import { Alert, Platform } from "react-native";
import { useAccount } from "@/account";
import { setAppearance, useAppearancePreference, type AppearancePreference } from "@/appearance";
import { serverLabel } from "@/account-store";
import { useNotificationSettingsSection } from "@/notifications";
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
  const { accounts, account, workspace, organizations, switchAccount, signOut } = useAccount();
  const notifications = useNotificationSettingsSection();
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
          // The native grouped list owns the page color; the bar matches it.
          // The grouped list's page color for this theme. (A dynamic system
          // color here resolved light in the navigation bar even in dark mode.)
          headerStyle: {
            backgroundColor:
              Platform.OS === "ios" ? (theme.scheme === "dark" ? "#000000" : "#F2F2F7") : c.bg,
          },
        }}
      />
      <SettingsList sections={sections} />
    </>
  );
}
