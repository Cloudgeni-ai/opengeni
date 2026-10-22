import { workspacesInOrg } from "@opengeni/react/organization-model";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useAccount } from "@/account";
import { SettingsList } from "@/settings-list";
import type { SettingsSection } from "@/settings-model";
import { AppThemeProvider } from "@/theme";
import { openOnWeb, webPaths } from "@/web-links";

export default function WorkspacesSheet() {
  return (
    <AppThemeProvider>
      <Workspaces />
    </AppThemeProvider>
  );
}

/* The workspace switcher as a sheet: the organization's workspaces, the other
   organizations for a person in several, and the web's settings pages. */
function Workspaces() {
  const { account, workspace, workspaces, organizations, setWorkspaceId, selectOrganization } =
    useAccount();
  const activeOrgId = workspace?.accountId ?? organizations[0]?.accountId ?? null;
  const org = organizations.find((each) => each.accountId === activeOrgId);
  const inOrg = activeOrgId ? workspacesInOrg(workspaces, activeOrgId) : [];
  const pick = (apply: () => void) => {
    void Haptics.selectionAsync().catch(() => undefined);
    apply();
    if (router.canGoBack()) router.back();
  };

  const sections: SettingsSection[] = [
    {
      id: "workspaces",
      title: org?.label ?? "Workspaces",
      rows: inOrg.map((each) => ({
        kind: "choice" as const,
        id: each.id,
        title: each.name,
        ...(each.kind === "personal" ? { subtitle: "Only you" } : {}),
        selected: each.id === workspace?.id,
        onPress: () => pick(() => setWorkspaceId(each.id)),
      })),
    },
  ];
  if (organizations.length > 1) {
    sections.push({
      id: "organizations",
      title: "Organizations",
      rows: organizations.map((each) => ({
        kind: "choice" as const,
        id: each.accountId,
        title: each.label,
        selected: each.accountId === activeOrgId,
        onPress: () => pick(() => selectOrganization(each.accountId)),
      })),
    });
  }
  if (account && workspace) {
    sections.push({
      id: "settings",
      rows: [
        {
          kind: "external",
          id: "workspace-settings",
          title: "Workspace settings",
          symbol: "square.stack",
          onPress: () => openOnWeb(account.baseUrl, webPaths.workspaceSettings(workspace.id)),
        },
        ...(org?.canManage
          ? [
              {
                kind: "external" as const,
                id: "organization-settings",
                title: "Organization settings",
                symbol: "building.2" as const,
                onPress: () =>
                  openOnWeb(account.baseUrl, webPaths.organizationSettings(workspace.id)),
              },
            ]
          : []),
      ],
    });
  }
  return <SettingsList sections={sections} />;
}
