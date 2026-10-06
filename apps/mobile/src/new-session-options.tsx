import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { defaultRepositoryMountPath, normalizeRepositoryTransportUri } from "@opengeni/contracts";
import type { GitHubRepository, MachineView, ResourceRef, SessionVisibility } from "@opengeni/sdk";
import {
  fontStyle,
  Icon,
  useNativeTimelineTheme,
  type NativeIconName,
} from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, useColorScheme } from "react-native";
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
  /** Fields for `createSession` (resources excludes attachments). */
  request(): {
    visibility?: SessionVisibility;
    targetSandboxId?: string;
    resources: ResourceRef[];
  };
  reset(): void;
}

/**
 * The new chat's options behind the composer's +: who can see it, which
 * repositories it opens, and where it runs. Choices reset with the workspace.
 */
export function useNewSessionOptions(workspaceId: string | null): NewSessionOptions {
  const { client } = useAccount();
  const [state, setState] = useState<{
    workspaceId: string | null;
    visibility: SessionVisibility;
    repositoryIds: number[];
    targetSandboxId: string | null;
  }>({ workspaceId, visibility: "workspace", repositoryIds: [], targetSandboxId: null });
  const [catalog, setCatalog] = useState<{
    workspaceId: string | null;
    canCreatePrivate: boolean;
    repositories: GitHubRepository[];
    machines: MachineView[];
  }>({ workspaceId: null, canCreatePrivate: false, repositories: [], machines: [] });

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    // Each list is optional: a deployment without GitHub or machines simply omits it.
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
    ]).then(([canCreatePrivate, repositories, machines]) => {
      if (current) setCatalog({ workspaceId, canCreatePrivate, repositories, machines });
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId]);

  const own =
    state.workspaceId === workspaceId
      ? state
      : { workspaceId, visibility: "workspace" as const, repositoryIds: [], targetSandboxId: null };
  const ready = catalog.workspaceId === workspaceId;
  const repositories = ready ? catalog.repositories : [];
  const machines = ready ? catalog.machines : [];
  const canCreatePrivate = ready && catalog.canCreatePrivate;
  const patch = useCallback(
    (next: Partial<typeof state>) =>
      setState((current) => ({
        ...(current.workspaceId === workspaceId
          ? current
          : { workspaceId, visibility: "workspace", repositoryIds: [], targetSandboxId: null }),
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

  return {
    visibility,
    canCreatePrivate,
    setVisibility: (next) => patch({ visibility: next }),
    repositories,
    selectedRepositoryIds,
    toggleRepository: (id) =>
      patch({
        repositoryIds: own.repositoryIds.includes(id)
          ? own.repositoryIds.filter((each) => each !== id)
          : [...own.repositoryIds, id],
      }),
    machines,
    targetSandboxId,
    setTargetSandboxId: (next) => patch({ targetSandboxId: next }),
    request: () => ({
      ...(visibility === "private" ? { visibility } : {}),
      ...(targetSandboxId ? { targetSandboxId } : {}),
      resources: repositories
        .filter((repo) => selectedRepositoryIds.includes(repo.id))
        .map(gitHubRepositoryResource),
    }),
    reset: () => patch({ repositoryIds: [] }),
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
  const scheme = useColorScheme();
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
    <MenuView
      actions={actions}
      colorScheme={scheme}
      onPressAction={({ nativeEvent }) => {
        const event = nativeEvent.event;
        const [kind, value] = event.split(/:(.*)/su);
        void Haptics.selectionAsync().catch(() => undefined);
        if (event === "photos") props.onPickImages();
        else if (event === "files") props.onPickFiles();
        else if (kind === "repository" && value) options?.toggleRepository(Number(value));
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
    </MenuView>
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
  if (repos.length === 0 && !machine && options.visibility !== "private") return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 12 }}
    >
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
