import { NativeMenu, type MenuAction } from "@/native-menu";
import { defaultRepositoryMountPath, normalizeRepositoryTransportUri } from "@opengeni/contracts";
import type {
  Channel,
  GitHubRepository,
  MachineView,
  ResourceRef,
  SessionVisibility,
  VariableSet,
} from "@opengeni/sdk";
import {
  fontStyle,
  Icon,
  useNativeTimelineTheme,
  type NativeIconName,
} from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAccount } from "@/account";
import { openOnWeb, webPaths } from "@/web-links";

/** The repository resource web's composer attaches for a workspace GitHub repository. */
export function gitHubRepositoryResource(repo: GitHubRepository): ResourceRef {
  const uri = normalizeRepositoryTransportUri(repo.cloneUrl);
  return {
    kind: "repository",
    uri,
    ref: repo.defaultBranch,
    provider: "github",
    mountPath: defaultRepositoryMountPath(uri, "github"),
    githubRepositoryId: repo.id,
    githubInstallationId: repo.installationId,
  };
}

/** A machine this person can run a new chat on (web's "Runs on" machines). */
function selectableMachine(machine: MachineView): boolean {
  return machine.kind === "selfhosted" && !machine.isSessionGroup;
}

/** Built-in tool servers the workspace manages; the composer lists connectors only. */
const BUILT_IN_TOOL_SERVERS = new Set(["opengeni", "files", "docs"]);

export interface NewSessionConnector {
  id: string;
  name: string;
}

/** The choices a new chat carries, as the server-synced draft stores them. */
export interface NewSessionChoices {
  visibility: SessionVisibility;
  repositoryIds: number[];
  targetSandboxId: string | null;
  /** The project (workspace channel); null is Default. */
  channelId: string | null;
  variableSetIds: string[];
  /** Connectors turned off for this chat; the rest follow the workspace defaults. */
  excludedConnectorIds: string[];
}

const EMPTY_CHOICES: NewSessionChoices = {
  visibility: "workspace",
  repositoryIds: [],
  targetSandboxId: null,
  channelId: null,
  variableSetIds: [],
  excludedConnectorIds: [],
};

export interface NewSessionOptions {
  visibility: SessionVisibility;
  canCreatePrivate: boolean;
  setVisibility(next: SessionVisibility): void;
  repositories: GitHubRepository[];
  selectedRepositoryIds: number[];
  toggleRepository(id: number): void;
  machines: MachineView[];
  /** Null runs on the workspace's managed sandbox. */
  targetSandboxId: string | null;
  setTargetSandboxId(next: string | null): void;
  projects: Channel[];
  channelId: string | null;
  setChannelId(next: string | null): void;
  variableSets: VariableSet[];
  selectedVariableSetIds: string[];
  toggleVariableSet(id: string): void;
  connectors: NewSessionConnector[];
  excludedConnectorIds: string[];
  toggleConnector(id: string): void;
  /** True once this workspace's lists have loaded (a restored draft can apply). */
  ready: boolean;
  /** The current choices, for the synced draft. */
  choices: NewSessionChoices;
  /** Apply choices restored from the synced draft. */
  apply(next: Partial<NewSessionChoices>): void;
  /** Fields for `createSession` (resources excludes attachments). */
  request(): {
    visibility?: SessionVisibility;
    targetSandboxId?: string;
    channelId?: string;
    variableSetIds?: string[];
    excludedMcpServerIds?: string[];
    resources: ResourceRef[];
  };
  reset(): void;
}

/**
 * The new chat's options behind the composer's +: its project, who can see
 * it, which repositories, variable sets and connectors it uses, and where it
 * runs. A list without entries is simply not offered. Choices reset with the
 * workspace.
 */
export function useNewSessionOptions(workspaceId: string | null): NewSessionOptions {
  const { client } = useAccount();
  const [state, setState] = useState<NewSessionChoices & { workspaceId: string | null }>({
    workspaceId,
    ...EMPTY_CHOICES,
  });
  const [catalog, setCatalog] = useState<{
    workspaceId: string | null;
    canCreatePrivate: boolean;
    repositories: GitHubRepository[];
    machines: MachineView[];
    projects: Channel[];
    variableSets: VariableSet[];
    connectors: NewSessionConnector[];
  }>({
    workspaceId: null,
    canCreatePrivate: false,
    repositories: [],
    machines: [],
    projects: [],
    variableSets: [],
    connectors: [],
  });

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    // Each list is optional: a deployment without GitHub, machines, projects,
    // variable sets or connectors simply omits that choice.
    void Promise.all([
      client
        .getSessionTenancyCreateCapabilities(workspaceId)
        .then((caps) => caps.canCreatePrivate)
        .catch(() => false),
      client
        .listGitHubRepositories(workspaceId)
        .then((response) => response.repositories.filter((repo) => !repo.archived))
        .catch(() => [] as GitHubRepository[]),
      client
        .listMachines(workspaceId)
        .then((response) => response.machines.filter(selectableMachine))
        .catch(() => [] as MachineView[]),
      client.listChannels(workspaceId).catch(() => [] as Channel[]),
      client
        .listVariableSets(workspaceId)
        .then((sets) => sets.filter((set) => set.status === "active"))
        .catch(() => [] as VariableSet[]),
      client
        .listCapabilities(workspaceId)
        .then((catalog) =>
          catalog.items.flatMap((item) =>
            item.kind === "mcp" &&
            item.enabled &&
            item.runtime.available &&
            item.runtime.mcpServerId &&
            !BUILT_IN_TOOL_SERVERS.has(item.runtime.mcpServerId)
              ? [{ id: item.runtime.mcpServerId, name: item.name }]
              : [],
          ),
        )
        .catch(() => [] as NewSessionConnector[]),
    ]).then(([canCreatePrivate, repositories, machines, projects, variableSets, connectors]) => {
      if (current) {
        setCatalog({
          workspaceId,
          canCreatePrivate,
          repositories,
          machines,
          projects,
          variableSets,
          connectors,
        });
      }
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId]);

  const own = state.workspaceId === workspaceId ? state : { workspaceId, ...EMPTY_CHOICES };
  const ready = catalog.workspaceId === workspaceId;
  const repositories = ready ? catalog.repositories : [];
  const machines = ready ? catalog.machines : [];
  const projects = ready ? catalog.projects : [];
  const variableSets = ready ? catalog.variableSets : [];
  const connectors = ready ? catalog.connectors : [];
  const canCreatePrivate = ready && catalog.canCreatePrivate;
  const patch = useCallback(
    (next: Partial<NewSessionChoices>) =>
      setState((current) => ({
        ...(current.workspaceId === workspaceId ? current : { workspaceId, ...EMPTY_CHOICES }),
        ...next,
        workspaceId,
      })),
    [workspaceId],
  );
  const visibility = canCreatePrivate ? own.visibility : "workspace";
  const targetSandboxId = machines.some((machine) => machine.sandboxId === own.targetSandboxId)
    ? own.targetSandboxId
    : null;
  const selectedRepositoryIds = own.repositoryIds.filter((id) =>
    repositories.some((repo) => repo.id === id),
  );
  const channelId = projects.some((project) => project.id === own.channelId) ? own.channelId : null;
  const selectedVariableSetIds = own.variableSetIds.filter((id) =>
    variableSets.some((set) => set.id === id),
  );
  const excludedConnectorIds = own.excludedConnectorIds.filter((id) =>
    connectors.some((connector) => connector.id === id),
  );
  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((each) => each !== value) : [...list, value];
  const choices: NewSessionChoices = ready
    ? {
        visibility,
        repositoryIds: selectedRepositoryIds,
        targetSandboxId,
        channelId,
        variableSetIds: selectedVariableSetIds,
        excludedConnectorIds,
      }
    : own;

  return {
    visibility,
    canCreatePrivate,
    setVisibility: (next) => patch({ visibility: next }),
    repositories,
    selectedRepositoryIds,
    toggleRepository: (id) => patch({ repositoryIds: toggle(own.repositoryIds, id) }),
    machines,
    targetSandboxId,
    setTargetSandboxId: (next) => patch({ targetSandboxId: next }),
    projects,
    channelId,
    setChannelId: (next) => patch({ channelId: next }),
    variableSets,
    selectedVariableSetIds,
    toggleVariableSet: (id) => patch({ variableSetIds: toggle(own.variableSetIds, id) }),
    connectors,
    excludedConnectorIds,
    toggleConnector: (id) =>
      patch({ excludedConnectorIds: toggle(own.excludedConnectorIds, id).sort() }),
    ready,
    choices,
    apply: (next) => patch(next),
    request: () => ({
      ...(visibility === "private" ? { visibility } : {}),
      ...(targetSandboxId ? { targetSandboxId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(selectedVariableSetIds.length > 0 ? { variableSetIds: selectedVariableSetIds } : {}),
      ...(excludedConnectorIds.length > 0 ? { excludedMcpServerIds: excludedConnectorIds } : {}),
      resources: repositories
        .filter((repo) => selectedRepositoryIds.includes(repo.id))
        .map(gitHubRepositoryResource),
    }),
    // A new chat starts in the same project, as web keeps the selected project.
    reset: () =>
      patch({
        repositoryIds: [],
        variableSetIds: [],
        excludedConnectorIds: [],
        visibility: "workspace",
      }),
  };
}

/**
 * The composer's + as a native menu (web's mobile + panel): photos and files,
 * then the new chat's repositories, where it runs and who can see it. Options
 * this app does not edit natively open on the web.
 */
export function ComposerPlusMenu(props: {
  onPickImages: () => void;
  onPickFiles: () => void;
  options?: NewSessionOptions | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const { account, workspace } = useAccount();
  const options = props.options;
  const actions: MenuAction[] = [
    {
      id: "attach",
      title: "",
      displayInline: true,
      subactions: [
        { id: "photos", title: "Photo Library", image: "photo.on.rectangle" },
        { id: "files", title: "Files", image: "folder" },
      ],
    },
  ];
  if (options) {
    const sessionActions: MenuAction[] = [];
    if (options.projects.length > 0) {
      const project = options.projects.find((each) => each.id === options.channelId);
      sessionActions.push({
        id: "project",
        title: `Project · ${project?.name ?? "Default"}`,
        image: "folder",
        subactions: [
          {
            id: "project:default",
            title: "Default",
            state: options.channelId === null ? "on" : "off",
          },
          ...options.projects.map((each) => ({
            id: `project:${each.id}`,
            title: each.name,
            state: each.id === options.channelId ? ("on" as const) : ("off" as const),
          })),
        ],
      });
    }
    if (options.repositories.length > 0) {
      sessionActions.push({
        id: "repositories",
        title:
          options.selectedRepositoryIds.length > 0
            ? `Repositories · ${options.selectedRepositoryIds.length}`
            : "Repositories",
        image: "arrow.triangle.branch",
        subactions: options.repositories.map((repo) => ({
          id: `repository:${repo.id}`,
          title: repo.fullName,
          state: options.selectedRepositoryIds.includes(repo.id) ? "on" : "off",
        })),
      });
    }
    if (options.machines.length > 0) {
      const machine = options.machines.find((each) => each.sandboxId === options.targetSandboxId);
      sessionActions.push({
        id: "runs-on",
        title: `Runs on · ${machine?.name ?? "Managed sandbox"}`,
        image: "desktopcomputer",
        subactions: [
          {
            id: "runs-on:managed",
            title: "Managed sandbox",
            state: options.targetSandboxId === null ? "on" : "off",
          },
          ...options.machines.map((each) => ({
            id: `runs-on:${each.sandboxId}`,
            title: each.state === "online" ? each.name : `${each.name} (offline)`,
            state: each.sandboxId === options.targetSandboxId ? ("on" as const) : ("off" as const),
            attributes: { disabled: each.state !== "online" },
          })),
        ],
      });
    }
    if (options.connectors.length > 0) {
      const off = options.excludedConnectorIds.length;
      sessionActions.push({
        id: "connectors",
        title: off > 0 ? `Connectors · ${off} off` : "Connectors",
        image: "puzzlepiece.extension",
        subactions: options.connectors.map((each) => ({
          id: `connector:${each.id}`,
          title: each.name,
          state: options.excludedConnectorIds.includes(each.id)
            ? ("off" as const)
            : ("on" as const),
        })),
      });
    }
    if (options.variableSets.length > 0) {
      sessionActions.push({
        id: "variable-sets",
        title:
          options.selectedVariableSetIds.length > 0
            ? `Variable sets · ${options.selectedVariableSetIds.length}`
            : "Variable sets",
        image: "key",
        subactions: options.variableSets.map((each) => ({
          id: `variable-set:${each.id}`,
          title: each.name,
          state: options.selectedVariableSetIds.includes(each.id)
            ? ("on" as const)
            : ("off" as const),
        })),
      });
    }
    if (options.canCreatePrivate) {
      sessionActions.push({
        id: "visibility",
        title: `Visibility · ${options.visibility === "private" ? "Only me" : "Workspace"}`,
        image: "eye",
        subactions: [
          {
            id: "visibility:workspace",
            title: "Workspace",
            state: options.visibility === "workspace" ? "on" : "off",
          },
          {
            id: "visibility:private",
            title: "Only me",
            image: "lock",
            state: options.visibility === "private" ? "on" : "off",
          },
        ],
      });
    }
    sessionActions.push({
      id: "more",
      title: "More options on the web",
      image: "safari",
    });
    actions.push({ id: "session", title: "", displayInline: true, subactions: sessionActions });
  }
  return (
    <NativeMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const event = nativeEvent.event;
        const [kind, value] = event.split(/:(.*)/su);
        void Haptics.selectionAsync().catch(() => undefined);
        if (event === "photos") props.onPickImages();
        else if (event === "files") props.onPickFiles();
        else if (kind === "repository" && value) options?.toggleRepository(Number(value));
        else if (kind === "project" && value)
          options?.setChannelId(value === "default" ? null : value);
        else if (kind === "connector" && value) options?.toggleConnector(value);
        else if (kind === "variable-set" && value) options?.toggleVariableSet(value);
        else if (kind === "runs-on" && value)
          options?.setTargetSandboxId(value === "managed" ? null : value);
        else if (kind === "visibility" && (value === "private" || value === "workspace"))
          options?.setVisibility(value);
        else if (event === "more" && account && workspace)
          openOnWeb(account.baseUrl, webPaths.workspace(workspace.id));
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel="Add photos, files and options"
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="plus" size={20} color={theme.colors["fg-muted"]} />
      </View>
    </NativeMenu>
  );
}

function OptionChip(props: {
  icon: NativeIconName;
  label: string;
  onRemove?: (() => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole={props.onRemove ? "button" : "text"}
      accessibilityLabel={props.onRemove ? `${props.label}, remove` : props.label}
      disabled={!props.onRemove}
      onPress={props.onRemove}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingLeft: 10,
        paddingRight: props.onRemove ? 8 : 10,
        borderRadius: 14,
        backgroundColor: pressed ? c.hover : c["surface-2"],
      })}
    >
      <Icon name={props.icon} size={13} color={c["fg-muted"]} />
      <Text
        numberOfLines={1}
        style={{ ...fontStyle(theme, 500), fontSize: 13, color: c.fg, maxWidth: 180 }}
      >
        {props.label}
      </Text>
      {props.onRemove ? <Icon name="x" size={12} color={c["fg-subtle"]} /> : null}
    </Pressable>
  );
}

/** The new chat's chosen options as chips above the field, each removable. */
export function NewSessionOptionChips({ options }: { options: NewSessionOptions }) {
  const machine = options.machines.find((each) => each.sandboxId === options.targetSandboxId);
  const repos = useMemo(
    () => options.repositories.filter((repo) => options.selectedRepositoryIds.includes(repo.id)),
    [options.repositories, options.selectedRepositoryIds],
  );
  const project = options.projects.find((each) => each.id === options.channelId);
  const sets = options.variableSets.filter((set) =>
    options.selectedVariableSetIds.includes(set.id),
  );
  const off = options.excludedConnectorIds.length;
  if (
    repos.length === 0 &&
    !machine &&
    !project &&
    sets.length === 0 &&
    off === 0 &&
    options.visibility !== "private"
  )
    return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 12 }}
    >
      {project ? (
        <OptionChip
          icon="folder"
          label={project.name}
          onRemove={() => options.setChannelId(null)}
        />
      ) : null}
      {options.visibility === "private" ? (
        <OptionChip
          icon="lock"
          label="Only me"
          onRemove={() => options.setVisibility("workspace")}
        />
      ) : null}
      {machine ? (
        <OptionChip
          icon="server"
          label={machine.name}
          onRemove={() => options.setTargetSandboxId(null)}
        />
      ) : null}
      {sets.map((set) => (
        <OptionChip
          key={set.id}
          icon="key-round"
          label={set.name}
          onRemove={() => options.toggleVariableSet(set.id)}
        />
      ))}
      {off > 0 ? (
        <OptionChip icon="plug" label={`${off} connector${off === 1 ? "" : "s"} off`} />
      ) : null}
      {repos.map((repo) => (
        <OptionChip
          key={repo.id}
          icon="folder-git"
          label={repo.fullName}
          onRemove={() => options.toggleRepository(repo.id)}
        />
      ))}
    </ScrollView>
  );
}
