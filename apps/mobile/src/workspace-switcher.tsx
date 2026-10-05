import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { workspacesInOrg } from "@opengeni/react/organization-model";
import { fontStyle, Icon, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Text, View, useColorScheme } from "react-native";
import { useAccount } from "@/account";
import { serverLabel } from "@/account-store";
import { InitialTile } from "@/ui";
import { openOnWeb, webPaths } from "@/web-links";

/**
 * The web rail's workspace picker as a native menu (UIMenu on iOS, a Material
 * dropdown on Android). The trigger names the workspace and its organization;
 * the menu lists the organization's workspaces and, only for a person in
 * several organizations, the others.
 */
export function WorkspaceSwitcherBlock() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const scheme = useColorScheme();
  const { account, workspace, workspaces, organizations, setWorkspaceId, selectOrganization } =
    useAccount();
  const activeOrgId = workspace?.accountId ?? organizations[0]?.accountId ?? null;
  const org = organizations.find((each) => each.accountId === activeOrgId);
  const inOrg = activeOrgId ? workspacesInOrg(workspaces, activeOrgId) : [];
  const others = organizations.filter((each) => each.accountId !== activeOrgId);
  const personal = workspace?.kind === "personal";

  const actions: MenuAction[] = [
    {
      id: "workspaces",
      title: org?.label ?? "Workspaces",
      displayInline: true,
      subactions: inOrg.map((each) => ({
        id: `workspace:${each.id}`,
        title: each.name,
        state: each.id === workspace?.id ? ("on" as const) : ("off" as const),
        ...(each.kind === "personal" ? { image: "lock" as const } : {}),
      })),
    },
    ...(others.length > 0
      ? [
          {
            id: "organizations",
            title: "Switch organization",
            image: "building.2" as const,
            subactions: others.map((each) => ({
              id: `organization:${each.accountId}`,
              title: each.label,
            })),
          },
        ]
      : []),
    ...(org?.canManage && workspace
      ? [
          {
            id: "organization-settings",
            title: "Organization settings",
            image: "gearshape" as const,
          },
        ]
      : []),
  ];

  return (
    <MenuView
      title={account ? `${account.email} · ${serverLabel(account.baseUrl)}` : undefined}
      actions={actions}
      colorScheme={scheme}
      onPressAction={({ nativeEvent }) => {
        const [kind, id] = nativeEvent.event.split(/:(.*)/su);
        void Haptics.selectionAsync().catch(() => undefined);
        if (kind === "workspace" && id) setWorkspaceId(id);
        else if (kind === "organization" && id) selectOrganization(id);
        else if (nativeEvent.event === "organization-settings" && account && workspace) {
          openOnWeb(account.baseUrl, webPaths.organizationSettings(workspace.id));
        }
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${workspace?.name ?? "Select workspace"}${org ? `, ${org.label}` : ""}. Switch workspace`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 8,
          paddingVertical: 8,
          borderRadius: theme.radius.md,
        }}
      >
        <InitialTile
          size={32}
          {...(personal ? { icon: "lock" as const } : { label: workspace?.name ?? "W" })}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ ...fontStyle(theme, 600), fontSize: 15, lineHeight: 20, color: c.fg }}
          >
            {workspace?.name ?? "Select workspace"}
          </Text>
          {org ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name="building-2" size={11} color={c["fg-subtle"]} />
              <Text
                numberOfLines={1}
                style={{
                  ...fontStyle(theme, 500),
                  fontSize: 12,
                  lineHeight: 16,
                  color: c["fg-subtle"],
                  flexShrink: 1,
                }}
              >
                {org.label}
              </Text>
            </View>
          ) : null}
        </View>
        <Icon name="chevrons-up-down" size={16} color={c["fg-subtle"]} />
      </View>
    </MenuView>
  );
}

/**
 * The account button: a native menu of every account on this device (with its
 * server when there are several), Add account and Settings.
 */
export function AccountMenuButton() {
  const scheme = useColorScheme();
  const { accounts, account, switchAccount } = useAccount();
  const servers = new Set(accounts.map((each) => each.baseUrl)).size;
  const actions: MenuAction[] = [
    {
      id: "accounts",
      title: "Accounts",
      displayInline: true,
      subactions: accounts.map((each) => ({
        id: `account:${each.id}`,
        title: servers > 1 ? `${each.email} · ${serverLabel(each.baseUrl)}` : each.email,
        state: each.id === account?.id ? ("on" as const) : ("off" as const),
      })),
    },
    { id: "add-account", title: "Add account", image: "person.badge.plus" },
    { id: "settings", title: "Settings", image: "gearshape" },
  ];
  return (
    <MenuView
      actions={actions}
      colorScheme={scheme}
      onPressAction={({ nativeEvent }) => {
        const event = nativeEvent.event;
        if (event.startsWith("account:")) switchAccount(event.slice("account:".length));
        else if (event === "add-account") router.push("/add-account");
        else if (event === "settings") router.push("/settings");
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Accounts and settings${account ? `, signed in as ${account.email}` : ""}`}
        style={{ width: 44, height: 44, alignItems: "flex-end", justifyContent: "center" }}
      >
        <InitialTile label={account?.email ?? "?"} size={28} tone="accent" />
      </View>
    </MenuView>
  );
}
