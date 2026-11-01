// The production follow-up repository picker with two mounted repositories,
// and the removal confirmation it opens. `?state=` picks the scenario:
//   picker (default)  mounted repositories, switchable off
//   clean             confirmation for a folder without unsaved changes
//   unsaved           confirmation for a folder with unsaved changes
//   unknown           confirmation when the unsaved-changes check failed
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RepositoryContextMenuBody,
  type RepositoryContextPickerProps,
} from "@opengeni/react/app/components/repository-picker";
import { REPOSITORY_PANEL_CLASS } from "@opengeni/react/app/components/repository-picker-layout";
import { RepositoryRemovalDialog } from "@opengeni/react/app/lib/use-follow-up-repositories";
import { groupRepositories } from "@opengeni/react/app/lib/session-tools";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import type { GitHubInstallationBinding, GitHubRepository } from "@opengeni/react/app/types";
import "../src/styles.css";

function appRepository(id: number, fullName: string): GitHubRepository {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id,
    installationId: 100,
    fullName,
    name,
    private: true,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    accountLogin: owner,
    accountType: "Organization",
  };
}

const repositories = [
  appRepository(1, "acme/api"),
  appRepository(2, "acme/grocery-bot"),
  appRepository(3, "acme/web"),
];
const installations = [
  {
    installationId: 100,
    accountLogin: "acme",
    repositoryCount: 3,
    lifecycle: "active",
    repositoryScope: "selected",
    configureUrl: "https://github.com/settings/installations",
  } as unknown as GitHubInstallationBinding,
];

function Fixture() {
  const scenario = new URLSearchParams(location.search).get("state") ?? "picker";
  const [mounted, setMounted] = useState(() => new Set([1, 2]));
  const [removing, setRemoving] = useState<GitHubRepository | null>(() =>
    scenario === "picker" ? null : (repositories[1] ?? null),
  );
  const props: RepositoryContextPickerProps = {
    setupMode: "platform",
    configured: true,
    status: "bound",
    installUrl: "https://api.opengeni.test/github/connect",
    linkUrl: null,
    installations,
    repositories,
    groups: groupRepositories(repositories),
    selectedRepoIds: mounted,
    selectedRepoRefs: {},
    lockedRepoIds: mounted,
    manualRepos: [],
    manualOpen: false,
    githubAppOpen: false,
    org: "",
    pending: false,
    repoBusy: false,
    githubAppBusy: false,
    newChatUrl: "#new-chat",
    onRemoveMountedRepository: (target) => {
      if (target.kind === "app") setRemoving(target.repository);
    },
    onRefresh: async () => {},
    onToggleRepo: () => {},
    onRefChange: () => {},
    onManualOpenChange: () => {},
    onManualAdd: () => {},
    onManualUpdate: () => {},
    onManualRemove: () => {},
    onGitHubAppOpenChange: () => {},
    onOrgChange: () => {},
    onStartGitHubApp: () => {},
    onConnectWorkspaceApp: () => {},
    onConfigureInstallation: async () => {},
    onDisconnectInstallation: async () => {},
  };
  return (
    <TooltipProvider>
      <main className="p-4">
        <div className={REPOSITORY_PANEL_CLASS} data-testid="repository-panel">
          <RepositoryContextMenuBody {...props} />
        </div>
        <RepositoryRemovalDialog
          open={removing !== null}
          name={removing?.name ?? ""}
          folder={scenario === "unsaved" ? "unsaved" : scenario === "unknown" ? "unknown" : "clean"}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const id = removing?.id;
            setMounted((current) => new Set([...current].filter((value) => value !== id)));
            return true;
          }}
        />
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
