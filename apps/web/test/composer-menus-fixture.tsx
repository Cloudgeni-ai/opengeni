import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerMobilePlus } from "../src/components/composer-mobile-plus";
import {
  RepositoryContextMenuBody,
  type RepositoryContextPickerProps,
} from "../src/components/repository-picker";
import { FollowUpRepositoryMenuBody } from "../src/components/follow-up-repository-menu-body";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { NewSessionVariableSetPicker } from "../src/components/session/new-session-variable-set-picker";
import type { GitHubRepository } from "../src/types";
import type { SessionToolSelection } from "../src/components/pickers";
import type { AgentLearningOverrides } from "@opengeni/sdk";
import "../src/styles.css";

const repositories: GitHubRepository[] = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1,
  installationId: 123,
  fullName: `example/${index === 0 ? "app" : `repository-${index + 1}`}`,
  name: index === 0 ? "app" : `repository-${index + 1}`,
  private: false,
  htmlUrl: `https://github.com/example/repository-${index + 1}`,
  cloneUrl: `https://github.com/example/repository-${index + 1}.git`,
  defaultBranch: "main",
  accountLogin: "example",
  accountType: "Organization",
}));
const servers = [
  { id: "files", name: "Files", transport: "http" as const },
  ...["PostHog", "Slack", "Grafana — Production", "Grafana — Staging", "Linear"].map(
    (name, index) => ({
      id: `connector-${index}`,
      name,
      transport: "http" as const,
      detail: index === 1 ? "Personal account" : "Workspace connection",
      connectionStatus: "ready" as const,
    }),
  ),
];
function Fixture() {
  const isNew = new URLSearchParams(location.search).has("new");
  const [selection, setSelection] = useState<SessionToolSelection>({
    mcpServerIds: new Set(servers.map((server) => server.id)),
    firstPartyToolIds: new Set(),
  });
  const [connectorCustomizing, setConnectorCustomizing] = useState(false);
  const [selected, setSelected] = useState(new Set([1]));
  const [refs, setRefs] = useState<Record<number, string>>({});
  const [settings, setSettings] = useState<AgentLearningOverrides>({});
  const [refreshes, setRefreshes] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualAdded, setManualAdded] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [runtimeIds, setRuntimeIds] = useState(["set-2", "set-1"]);
  const props: RepositoryContextPickerProps = {
    configured: true,
    status: "bound",
    setupMode: "platform",
    installUrl: null,
    linkUrl: null,
    installations: [],
    repositories,
    groups: [{ installationId: 123, label: "example", detail: "Organization", repositories }],
    selectedRepoIds: selected,
    selectedRepoRefs: refs,
    selectedInstallationId: 123,
    lockedRepoIds: isNew ? new Set() : new Set([1]),
    manualRepos: [],
    manualOpen,
    githubAppOpen: settingsOpen,
    org: "",
    pending: false,
    repoBusy: false,
    githubAppBusy: false,
    onRefresh: async () => {
      setRefreshes((count) => count + 1);
    },
    onOpenRefresh: async () => {
      setRefreshes((count) => count + 1);
    },
    onToggleRepo: (repo) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(repo.id)) next.delete(repo.id);
        else next.add(repo.id);
        return next;
      }),
    onRefChange: (id, ref) => setRefs((current) => ({ ...current, [id]: ref })),
    onManualOpenChange: setManualOpen,
    onManualAdd: () => {
      setManualAdded(true);
      setManualOpen(true);
    },
    onManualUpdate: () => {},
    onManualRemove: () => {},
    onGitHubAppOpenChange: setSettingsOpen,
    onOrgChange: () => {},
    onStartGitHubApp: () => {},
    onDisconnectInstallation: async () => {},
    newChatUrl: "?new",
  };
  const RepositoryBody = isNew ? RepositoryContextMenuBody : FollowUpRepositoryMenuBody;
  return (
    <TooltipProvider>
      <main className="p-4" data-og-composer-id="menu-qa">
        <input
          data-og-composer-attach
          type="file"
          multiple
          hidden
          onChange={(event) => setFileCount(event.target.files?.length ?? 0)}
        />
        <ComposerMobilePlus
          fileUploadsEnabled
          servers={servers}
          firstPartyTools={[]}
          selection={selection}
          connectorCustomizing={connectorCustomizing}
          onConnectorCustomizingChange={setConnectorCustomizing}
          onToolSelectionChange={setSelection}
          menuSide="bottom"
          repositories={{ selectedCount: selected.size, panel: <RepositoryBody {...props} /> }}
          variableSets={{
            selectedCount: runtimeIds.length,
            panel: (
              <NewSessionVariableSetPicker
                workspaceId="fixture"
                canAttach
                canUse
                runtimeIds={runtimeIds}
                variableSets={Array.from({ length: 20 }, (_, index) => ({
                  id: `set-${index + 1}`,
                  name: `Environment ${index + 1}`,
                }))}
                disabled={false}
                onChange={setRuntimeIds}
              />
            ),
          }}
          draftChatSettings={
            isNew
              ? {
                  workspaceId: "fixture",
                  scope: "workspace",
                  value: settings,
                  onChange: setSettings,
                }
              : undefined
          }
          chatSettings={
            !isNew
              ? { workspaceId: "fixture", sessionId: "chat", scope: "workspace", canEdit: true }
              : undefined
          }
        />
        <div className="sr-only" data-testid="fixture-state">
          {JSON.stringify({
            selected: [...selected],
            connectors: [...selection.mcpServerIds],
            refreshes,
            manualAdded,
            fileCount,
            settings,
            runtimeIds,
          })}
        </div>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
