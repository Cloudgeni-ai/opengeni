// The production repository picker with repositories from two GitHub App
// installations and the user's own GitHub. `?state=` picks the scenario:
//   mixed (default)  selections from both installations and as you, one
//                    repository reachable both ways expanded with "Acts as"
//   access           the "GitHub access" footer open
//   disconnected     your GitHub not connected yet
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RepositoryContextMenuBody,
  type RepositoryContextPickerProps,
} from "@opengeni/react/app/components/repository-picker";
import { REPOSITORY_PANEL_CLASS } from "@opengeni/react/app/components/repository-picker-layout";
import { groupRepositories } from "@opengeni/react/app/lib/session-tools";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import type {
  GitHubInstallationBinding,
  GitHubRepository,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubRepositoryCatalogItem,
} from "@opengeni/react/app/types";
import "../src/styles.css";

function appRepository(id: number, installationId: number, fullName: string): GitHubRepository {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id,
    installationId,
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
function personalRepository(
  repositoryId: string,
  fullName: string,
  selectedAccess: "read" | "write" = "write",
): PersonalGitHubRepositoryCatalogItem {
  return {
    repositoryId,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: {
      pull: true,
      push: selectedAccess === "write",
      admin: false,
      maintain: false,
      triage: false,
    },
    selectedAccess,
  };
}

const repositories = [
  appRepository(1, 100, "acme/api"),
  appRepository(2, 100, "acme/web"),
  appRepository(3, 200, "globex/grocery-bot"),
  appRepository(4, 200, "globex/infra"),
];
const personalRepositories = [
  personalRepository("901", "globex/grocery-bot"),
  personalRepository("902", "octocat/dotfiles"),
  personalRepository("903", "octocat/blog", "read"),
];
const installations = [
  { installationId: 100, accountLogin: "acme", repositoryCount: 2 },
  { installationId: 200, accountLogin: "globex", repositoryCount: 2 },
].map(
  (installation) =>
    ({
      ...installation,
      lifecycle: "active",
      repositoryScope: "selected",
      configureUrl: "https://github.com/settings/installations",
    }) as unknown as GitHubInstallationBinding,
);
const connected = {
  enabled: true,
  connection: { status: "active", metadata: { githubLogin: "octocat" } },
  reviewUrl: null,
} as unknown as PersonalGitHubConnectionStatusResponse;
const disconnected = {
  enabled: true,
  connection: null,
  reviewUrl: null,
} as unknown as PersonalGitHubConnectionStatusResponse;

function Fixture() {
  const scenario = new URLSearchParams(location.search).get("state") ?? "mixed";
  const personalConnected = scenario !== "disconnected";
  const [selectedRepoIds, setSelectedRepoIds] = useState(
    () => new Set(scenario === "mixed" ? [1, 3] : [1]),
  );
  const [selectedRepoRefs, setSelectedRepoRefs] = useState<Record<number, string>>({});
  const [selectedPersonal, setSelectedPersonal] = useState(
    () => new Set(scenario === "mixed" ? ["902"] : []),
  );
  const [personalRefs, setPersonalRefs] = useState<Record<string, string>>({});
  const [accessOpen, setAccessOpen] = useState(scenario !== "mixed");
  const sameRepository = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  const props: RepositoryContextPickerProps = {
    setupMode: "platform",
    configured: true,
    status: "bound",
    installUrl: "https://api.opengeni.test/github/connect",
    linkUrl: null,
    installations,
    repositories,
    groups: groupRepositories(repositories),
    personalGitHubStatus: personalConnected ? connected : disconnected,
    personalGitHubRepositories: personalConnected ? personalRepositories : [],
    selectedPersonalGitHubRepoIds: selectedPersonal,
    selectedPersonalGitHubRepoRefs: personalRefs,
    personalGitHubManageUrl: "#choose-repos",
    selectedRepoIds,
    selectedRepoRefs,
    manualRepos: [],
    manualOpen: false,
    githubAppOpen: accessOpen,
    org: "",
    pending: false,
    repoBusy: false,
    githubAppBusy: false,
    onRefresh: async () => {},
    onConnectPersonalGitHub: () => {},
    onTogglePersonalGitHubRepo: (repo) => {
      const adding = !selectedPersonal.has(repo.repositoryId);
      setSelectedPersonal((current) => {
        const next = new Set(current);
        if (adding) next.add(repo.repositoryId);
        else next.delete(repo.repositoryId);
        return next;
      });
      if (adding) {
        setSelectedRepoIds(
          (current) =>
            new Set(
              [...current].filter(
                (id) =>
                  !sameRepository(
                    repositories.find((candidate) => candidate.id === id)?.fullName ?? "",
                    repo.fullName,
                  ),
              ),
            ),
        );
      }
    },
    onPersonalGitHubRefChange: (id, ref) =>
      setPersonalRefs((current) => ({ ...current, [id]: ref })),
    onToggleRepo: (repo) => {
      const adding = !selectedRepoIds.has(repo.id);
      setSelectedRepoIds((current) => {
        const next = new Set(current);
        if (adding) next.add(repo.id);
        else next.delete(repo.id);
        return next;
      });
      if (adding) {
        setSelectedPersonal(
          (current) =>
            new Set(
              [...current].filter(
                (id) =>
                  !sameRepository(
                    personalRepositories.find((candidate) => candidate.repositoryId === id)
                      ?.fullName ?? "",
                    repo.fullName,
                  ),
              ),
            ),
        );
      }
    },
    onRefChange: (id, ref) => setSelectedRepoRefs((current) => ({ ...current, [id]: ref })),
    onManualOpenChange: () => {},
    onManualAdd: () => {},
    onManualUpdate: () => {},
    onManualRemove: () => {},
    onGitHubAppOpenChange: setAccessOpen,
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
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
