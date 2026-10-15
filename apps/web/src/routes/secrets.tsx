// Secrets: vaults of logins, keys, notes and files that agents use by
// reference. Values are revealed only on request ("use = reveal").
//
//   /secrets                      the vault list   ?view=new|connect|connect-<provider>[&owner=]
//   /secrets?connection=<id>      a password manager connection   &view=choose-vaults|replace-token
//   /secrets/$vaultId             a vault's page   ?view=availability|new-item&type=
//   /secrets/$vaultId/$itemId     an item's page   ?view=edit
import {
  useVault,
  useVaultItem,
  useVaultItems,
  useVaults,
  type OnePasswordConnectionSummary,
  type ProviderVaultMeta,
  type VaultAvailability,
  type VaultSummary,
  type VaultsApi,
} from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { AvailabilityWorkspace } from "@/components/secrets/availability-editor";
import { ConnectOnePasswordPage, ReplaceTokenPage } from "@/components/secrets/connect-onepassword";
import {
  ConnectPickerPage,
  ConnectProviderPage,
  RenewCredentialsPage,
  type ProviderAvailability,
} from "@/components/secrets/connect-provider";
import { ItemEditorPage } from "@/components/secrets/item-editor";
import { ItemPage, ItemPageLoading, type ItemTransfer } from "@/components/secrets/item-page";
import { MoveItemDialog } from "@/components/secrets/move-item-dialog";
import { ConnectionMissing, ConnectionPage } from "@/components/secrets/provider-connections";
import { ChooseVaultsPage, type LinkVaultActions } from "@/components/secrets/vault-chooser";
import {
  AvailabilityPage,
  NewVaultPage,
  RenameVaultDialog,
} from "@/components/secrets/vault-forms";
import { SecretsListPage, type SecretsListState } from "@/components/secrets/vault-list";
import {
  secretsCapabilityOff,
  vaultError,
  vaultsOfConnection,
} from "@/components/secrets/vault-model";
import {
  acceptsItem,
  connectionName,
  creatableTypes,
  LEGACY_PROVIDER_OPERATIONS,
  PROVIDERS,
  sourceHome,
  vaultOperations,
  type ExternalVaultProviderKind,
  type VaultConnection,
} from "@/components/secrets/vault-providers";
import { SecretsMissing, VaultPage, VaultPageLoading } from "@/components/secrets/vault-page";
import { ContentPage } from "@/components/ui/content-layout";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import {
  connectViewProvider,
  type SecretsConnectOwner,
  type SecretsIndexView,
} from "@/lib/secrets-route";
import { useFocusOnNavigation } from "@/lib/use-focus-on-navigation";

export type SecretsListView = Exclude<SecretsIndexView, SecretsConnectionView>;
export type SecretsVaultView = "availability" | "new-item";
export type SecretsItemView = "edit";
export type SecretsConnectionView = "choose-vaults" | "replace-token";

const CREATABLE_TYPES = ["login", "api_key", "note", "file"] as const;
type CreatableType = (typeof CREATABLE_TYPES)[number];

export function parseCreatableType(value: unknown): CreatableType | undefined {
  return CREATABLE_TYPES.includes(value as CreatableType) ? (value as CreatableType) : undefined;
}

/**
 * Who chooses where a vault is available: organization admins for an
 * organization vault, the owner for their Only-me vaults except the default
 * one (it is where Only-me saves go, so it stays everywhere).
 */
function canEditAvailability(vault: VaultSummary): boolean {
  if (!vault.canManage) return false;
  if (vault.ownerKind === "organization") return true;
  return vault.ownerKind === "user" && !vault.isDefault;
}

/** Whether a vault still reaches this workspace after its availability changes. */
function vaultStaysHere(
  vault: VaultSummary,
  availability: VaultAvailability,
  workspaceId: string,
): boolean {
  const allowed = availability.allowedWorkspaceIds;
  if (allowed === null || allowed.includes(workspaceId)) return true;
  // An Only-me vault always reaches its home (Personal) workspace.
  return vault.ownerKind === "user" && vault.workspaceId === workspaceId;
}

/** The toast after renewing a connection's access. */
const RENEWED: Record<ExternalVaultProviderKind, string> = {
  protonpass: "Token replaced",
  keeper: "Reconnected",
  bitwarden: "Bridge updated",
  external: "Service updated",
};

/** Wraps a mutation so its error carries the vault copy (UI-9). */
async function attempt<T>(operation: () => Promise<T>, home?: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw vaultError(error, undefined, home);
  }
}

/** A connection from a server that only lists 1Password ones. */
function fromOnePassword(connection: OnePasswordConnectionSummary): VaultConnection {
  return {
    ...connection,
    provider: "onepassword",
    operations: LEGACY_PROVIDER_OPERATIONS,
    available: true,
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

/**
 * Every password manager connection this person can see; none without list
 * access. A server without the unified list still lists its 1Password ones.
 */
function useVaultConnections(api: VaultsApi, enabled: boolean) {
  const [state, setState] = useState<{
    connections: VaultConnection[] | null;
    loading: boolean;
    error: unknown;
  }>({ connections: null, loading: enabled, error: null });
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    if (!enabled) {
      setState({ connections: null, loading: false, error: null });
      return;
    }
    const current = new AbortController();
    controller.current = current;
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const connections = await api
        .listVaultProviderConnections(current.signal)
        .catch(async (error: unknown) => {
          if (!isNotFound(error)) throw error;
          return (await api.listOnePasswordConnections(current.signal)).map(fromOnePassword);
        });
      if (!current.signal.aborted) setState({ connections, loading: false, error: null });
    } catch (error) {
      if (!current.signal.aborted) setState((previous) => ({ ...previous, loading: false, error }));
    }
  }, [api, enabled]);
  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, [refresh]);
  return { ...state, refresh };
}

export function SecretsRoute({
  workspaceId,
  vaultId,
  itemId,
  view,
  type,
  connectionId,
  owner,
}: {
  workspaceId: string;
  vaultId?: string | undefined;
  itemId?: string | undefined;
  view?: string | undefined;
  type?: string | undefined;
  connectionId?: string | undefined;
  owner?: SecretsConnectOwner | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const access = context.accessContext;
  const can = (permission: string) => hasWorkspacePermission(access, workspaceId, permission);
  const canList = can("secrets:list") || can("variable-sets:list");
  const canWrite = can("secrets:write");
  // "use = reveal": viewers can see that an item exists, never its value.
  const canUse = can("secrets:use") || can("variable-sets:use") || can("environments:use");
  const workspaceGrant = access.workspaceGrants.find((grant) => grant.workspaceId === workspaceId);
  const accountId = workspaceGrant?.accountId ?? null;
  const canManageOrganization = Boolean(
    accountId && hasAccountPermission(access, accountId, "account:admin"),
  );
  const canWriteWorkspace = can("variable-sets:write") || can("secrets:write");
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const organizationName = workspace
    ? orgLabel(workspace.accountId, access.accountGrants)
    : "your organization";
  const organizationWorkspaces: AvailabilityWorkspace[] = useMemo(
    () =>
      context.workspaces
        .filter((each) => each.accountId === workspace?.accountId && each.kind === "shared")
        .map((each) => ({ id: each.id, name: each.name })),
    [context.workspaces, workspace?.accountId],
  );
  const capabilityOff = secretsCapabilityOff(workspace?.settings);
  const canEditAgentDefaults = can("workspace:admin");

  const vaults = useVaults({ enabled: canList });
  const api = vaults.api;
  const list = vaults.vaults ?? [];
  const listState: SecretsListState =
    vaults.loading && !vaults.vaults
      ? "loading"
      : vaults.error && !vaults.vaults
        ? "error"
        : "ready";
  const listed = vaultId ? list.find((candidate) => candidate.id === vaultId) : undefined;
  // A task vault (or one shared since the list loaded) isn't in the list: read it directly.
  const direct = useVault(vaultId ?? "", {
    enabled: canList && Boolean(vaultId) && !listed && listState === "ready",
  });
  const vault = listed ?? (direct.vault?.id === vaultId ? direct.vault : null) ?? undefined;
  const refreshDirect = direct.refresh;
  const refreshList = vaults.refresh;
  const refreshVaults = useCallback(async () => {
    await Promise.all([refreshList(), listed ? null : refreshDirect()]);
  }, [refreshList, refreshDirect, listed]);
  const connectionList = useVaultConnections(api, canList);
  const connections = connectionList.connections;
  const refreshConnections = connectionList.refresh;
  const connection = connectionId
    ? connections?.find((candidate) => candidate.id === connectionId)
    : undefined;
  const connectionHome = connection ? PROVIDERS[connection.provider].home : undefined;
  // Who connected an account, on its page only.
  const personName = usePersonName(workspaceId, Boolean(connectionId) && !vaultId);

  /* ------------------------------------------------------------ navigation */

  const openList = useCallback(
    (search: { view?: SecretsListView; owner?: SecretsConnectOwner } = {}) =>
      void navigate({ to: "/workspaces/$workspaceId/secrets", params: { workspaceId }, search }),
    [navigate, workspaceId],
  );
  const openConnection = useCallback(
    (id: string, connectionView?: SecretsConnectionView) =>
      void navigate({
        to: "/workspaces/$workspaceId/secrets",
        params: { workspaceId },
        search: connectionView ? { connection: id, view: connectionView } : { connection: id },
      }),
    [navigate, workspaceId],
  );
  const openVault = useCallback(
    (id: string, search: { view?: SecretsVaultView; type?: CreatableType } = {}) =>
      void navigate({
        to: "/workspaces/$workspaceId/secrets/$vaultId",
        params: { workspaceId, vaultId: id },
        search,
      }),
    [navigate, workspaceId],
  );
  const openItem = useCallback(
    (inVaultId: string, targetItemId: string, search: { view?: SecretsItemView } = {}) =>
      void navigate({
        to: "/workspaces/$workspaceId/secrets/$vaultId/$itemId",
        params: { workspaceId, vaultId: inVaultId, itemId: targetItemId },
        search,
      }),
    [navigate, workspaceId],
  );
  const agentSettingsHref = canEditAgentDefaults
    ? `/workspaces/${encodeURIComponent(workspaceId)}/settings?section=general&view=agent-defaults`
    : null;

  /* ------------------------------------------------------------ dialogs */

  const [renaming, setRenaming] = useState(false);
  const [deletingVault, setDeletingVault] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  useEffect(() => {
    setRenaming(false);
    setDeletingVault(false);
    setDisconnecting(false);
  }, [vaultId, connectionId]);

  const pageKey = `${vaultId ?? ""}|${itemId ?? ""}|${connectionId ?? ""}|${view ?? ""}`;
  const root = useFocusOnNavigation(pageKey, {
    onList: pageKey === "|||",
    rememberTitle: Boolean(vaultId || connectionId) && !view,
  });

  /* ------------------------------------------------------------ pages */

  // The same order as New vault; Connect 1Password starts on This workspace when allowed.
  const owners: ("user" | "workspace" | "organization")[] = [
    "user",
    ...(canWriteWorkspace ? (["workspace"] as const) : []),
    ...(canManageOrganization ? (["organization"] as const) : []),
  ];

  const linkActions: LinkVaultActions = {
    link: (meta, mode, ownerKind, linkConnectionId, provider) =>
      attempt(
        () =>
          api.linkProviderVault({
            provider,
            connectionId: linkConnectionId,
            externalVaultId: meta.externalVaultId,
            ownerKind,
            mode,
            name: meta.name,
          }),
        PROVIDERS[provider].home,
      ),
    createManaged: (name, ownerKind, linkConnectionId) =>
      attempt(() => api.createManagedProviderVault(linkConnectionId, { name, ownerKind })),
    openVault: (linked) => {
      void vaults.refresh();
      openVault(linked.id);
    },
  };
  const loadProviderVaults = useCallback(
    (signal: AbortSignal): Promise<ProviderVaultMeta[]> =>
      connectionId
        ? api.listProviderVaults(connectionId, signal).catch((error: unknown) => {
            throw vaultError(error, undefined, connectionHome);
          })
        : Promise.resolve([]),
    [api, connectionId, connectionHome],
  );
  // A provider this server can't reach: its existing connections say so.
  const unavailableProviders: ProviderAvailability = useMemo(() => {
    const result: ProviderAvailability = {};
    for (const each of connections ?? []) {
      if (!each.available) result[each.provider] = "Not enabled on this server";
    }
    return result;
  }, [connections]);
  const connectProvider = connectViewProvider(view);
  const closeConnect = () => {
    void Promise.all([vaults.refresh(), refreshConnections()]);
    openList();
  };

  let page: ReactNode;
  if (!vaultId && connectionId) {
    if (!canList || !connection) {
      page = (
        <ConnectionMissing
          loading={canList && (connectionList.loading || !connections) && !connectionList.error}
          error={connections ? null : connectionList.error}
          onBack={() => openList()}
          onRetry={() => void refreshConnections()}
        />
      );
    } else if (view === "choose-vaults" && connection.canManage) {
      page = (
        <ChooseVaultsPage
          connection={connection}
          vaults={list}
          loadProviderVaults={loadProviderVaults}
          onClose={() => openConnection(connection.id)}
          onLinked={(linked) => {
            void Promise.all([vaults.refresh(), refreshConnections()]);
            if (linked.length > 0) {
              toast.success(
                linked.length === 1
                  ? `Linked ${linked[0]!.name}`
                  : `Linked ${linked.length} vaults`,
              );
            }
            openConnection(connection.id);
          }}
          actions={linkActions}
        />
      );
    } else if (view === "replace-token" && connection.canManage) {
      const renewing = connection.provider;
      page =
        renewing === "onepassword" ? (
          <ReplaceTokenPage
            connection={connection}
            onClose={() => openConnection(connection.id)}
            onReplace={async (request) => {
              await api.replaceOnePasswordToken(connection.id, request);
              await Promise.all([vaults.refresh(), refreshConnections()]);
              toast.success("Token replaced");
              openConnection(connection.id);
            }}
          />
        ) : (
          <RenewCredentialsPage
            connection={{ ...connection, provider: renewing }}
            onClose={() => openConnection(connection.id)}
            onRenew={async (credentials) => {
              await api.replaceVaultProviderCredentials(connection.id, { credentials });
              await Promise.all([vaults.refresh(), refreshConnections()]);
              toast.success(RENEWED[renewing]);
              openConnection(connection.id);
            }}
          />
        );
    } else {
      page = (
        <ConnectionPage
          connection={connection}
          vaults={list}
          organizationName={organizationName}
          creatorName={
            connection.createdBySubjectId ? personName(connection.createdBySubjectId) : null
          }
          actions={{
            back: () => openList(),
            chooseVaults: () => openConnection(connection.id, "choose-vaults"),
            renew: () => openConnection(connection.id, "replace-token"),
            disconnect: () => setDisconnecting(true),
            openVault: (linked) => openVault(linked.id),
            retry: () => {
              void Promise.all(
                vaultsOfConnection(list, connection.id).map((linked) =>
                  api.syncVault(linked.id).catch(() => undefined),
                ),
              ).then(() => vaults.refresh());
            },
          }}
        />
      );
    }
  } else if (!vaultId) {
    if (view === "new" && canList && canWrite) {
      page = (
        <NewVaultPage
          canCreateWorkspace={canWriteWorkspace}
          canCreateOrganization={canManageOrganization}
          organizationName={organizationName}
          workspaces={organizationWorkspaces}
          currentWorkspaceId={workspace?.kind === "shared" ? workspaceId : null}
          onClose={() => openList()}
          onCreate={async (request) => {
            const created = await attempt(() => api.createVault(request));
            await vaults.refresh();
            toast.success(`Created ${created.name}`);
            openVault(created.id);
          }}
        />
      );
    } else if (view === "connect" && canList && canWrite) {
      page = (
        <ConnectPickerPage
          unavailable={unavailableProviders}
          onClose={() => openList()}
          onPick={(provider) =>
            openList({ view: `connect-${provider === "onepassword" ? "1password" : provider}` })
          }
        />
      );
    } else if (view === "connect-1password" && canList && canWrite) {
      page = (
        <ConnectOnePasswordPage
          owners={owners}
          defaultOwner={owner}
          organizationName={organizationName}
          onClose={closeConnect}
          onConnected={() => void refreshConnections()}
          actions={{
            install: (request) => attempt(() => api.installOnePassword(request), "1Password"),
            ...linkActions,
          }}
        />
      );
    } else if (connectProvider && canList && canWrite) {
      page = (
        <ConnectProviderPage
          key={connectProvider}
          provider={connectProvider}
          owners={owners}
          defaultOwner={owner}
          organizationName={organizationName}
          onClose={closeConnect}
          onConnected={() => void refreshConnections()}
          actions={{
            install: (request) => api.installVaultProvider(request),
            ...linkActions,
          }}
        />
      );
    } else {
      page = (
        <SecretsListPage
          state={listState}
          error={vaults.error}
          vaults={list}
          connections={connections}
          connectionsLoading={connectionList.loading}
          canList={canList}
          canCreate={canWrite}
          canConnect={canWrite}
          capabilityOff={capabilityOff}
          agentSettingsHref={agentSettingsHref}
          onRetry={() => void Promise.all([vaults.refresh(), refreshConnections()])}
          onOpenVault={(each) => openVault(each.id)}
          onOpenConnection={(each) => openConnection(each.id)}
          onNewVault={() => openList({ view: "new" })}
          onConnect={() => openList({ view: "connect" })}
          onOpenAgentSettings={() => {
            if (agentSettingsHref) void navigate({ href: agentSettingsHref });
          }}
        />
      );
    }
  } else if (!canList) {
    page = <SecretsMissing what="vault" backLabel="Secrets" onBack={() => openList()} />;
  } else if (!vault) {
    page =
      listState === "loading" || direct.loading ? (
        <VaultPageLoading onBack={() => openList()} />
      ) : (
        <SecretsMissing what="vault" backLabel="Secrets" onBack={() => openList()} />
      );
  } else if (itemId) {
    page = (
      <ItemRoute
        key={`${vault.id}/${itemId}`}
        vault={vault}
        vaults={list}
        itemId={itemId}
        view={view}
        api={api}
        canUse={canUse}
        onBack={() => openVault(vault.id)}
        onOpenItem={openItem}
        onChanged={refreshVaults}
      />
    );
  } else if (view === "availability" && canEditAvailability(vault)) {
    page = (
      <AvailabilityPage
        vault={vault}
        organizationName={organizationName}
        workspaces={organizationWorkspaces}
        onClose={() => openVault(vault.id)}
        onSave={async (availability) => {
          await attempt(() =>
            api.updateVault(vault.id, { expectedGeneration: vault.generation, availability }),
          );
          await vaults.refresh();
          if (!vaultStaysHere(vault, availability, workspaceId)) {
            toast.success(`Saved. ${vault.name} is no longer available in this workspace.`);
            openList();
            return;
          }
          toast.success("Saved");
          openVault(vault.id);
        }}
      />
    );
  } else if (view === "new-item" && creatableTypes(vaultOperations(vault)).length > 0) {
    page = (
      <ItemEditorPage
        vault={vault}
        initialType={parseCreatableType(type)}
        onClose={() => openVault(vault.id)}
        onCreate={async (request) => {
          const created = await attempt(() => api.createItem(vault.id, request), sourceHome(vault));
          await vaults.refresh();
          toast.success(`Saved ${created.name}`);
          openItem(vault.id, created.id);
        }}
        onUpdate={async () => undefined}
        onReload={() => openVault(vault.id, { view: "new-item" })}
      />
    );
  } else {
    page = (
      <VaultRoute
        key={vault.id}
        vault={vault}
        organizationName={organizationName}
        canManageAvailability={canEditAvailability(vault)}
        providerAccount={(() => {
          const source = vault.providerConnectionId
            ? connections?.find((each) => each.id === vault.providerConnectionId)
            : undefined;
          return source
            ? { name: connectionName(source), onOpen: () => openConnection(source.id) }
            : null;
        })()}
        actions={{
          back: () => openList(),
          newItem: () => openVault(vault.id, { view: "new-item" }),
          openItem: (item) => openItem(vault.id, item.id),
          rename: () => setRenaming(true),
          editAvailability: () => openVault(vault.id, { view: "availability" }),
          sync: async () => {
            await attempt(() => api.syncVault(vault.id), sourceHome(vault));
            await vaults.refresh();
          },
          reconnect: (() => {
            const source = vault.providerConnectionId
              ? connections?.find((each) => each.id === vault.providerConnectionId)
              : undefined;
            // Only someone who manages the connection can renew it.
            return source?.canManage ? () => openConnection(source.id, "replace-token") : undefined;
          })(),
          deleteVault: () => setDeletingVault(true),
          retry: () => void vaults.refresh(),
        }}
      />
    );
  }

  const unlinks = vault?.source !== "opengeni";
  const vaultHome = vault ? sourceHome(vault) : "";
  const disconnectVaults = connection ? vaultsOfConnection(list, connection.id) : [];

  return (
    <ContentPage width="standard">
      <TooltipProvider delayDuration={300}>
        <div ref={root} className="min-w-0 pb-7">
          {page}
        </div>
      </TooltipProvider>

      <DestructiveConfirm
        open={Boolean(connection && disconnecting)}
        onOpenChange={(open) => (open ? undefined : setDisconnecting(false))}
        title={connection ? `Disconnect ${connectionName(connection)}?` : ""}
        consequences={[
          disconnectVaults.length === 0
            ? "No vaults are linked through it."
            : disconnectVaults.length === 1
              ? `${disconnectVaults[0]!.name} is unlinked, and agents here stop using its items.`
              : `Its ${disconnectVaults.length} vaults are unlinked (${disconnectVaults.map((each) => each.name).join(", ")}), and agents here stop using their items.`,
          `Opengeni forgets ${connection ? PROVIDERS[connection.provider].credential : "its access"}.`,
          `Nothing is deleted in ${connectionHome ?? "the password manager"}. You can connect it again later.`,
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          if (!connection) return;
          const name = connectionName(connection);
          await attempt(
            () =>
              connection.provider === "onepassword"
                ? api.disconnectOnePassword(connection.id)
                : api.disconnectVaultProvider(connection.id),
            connectionHome,
          );
          setDisconnecting(false);
          openList();
          toast.success(`Disconnected ${name}`);
          await Promise.all([vaults.refresh(), refreshConnections()]);
        }}
      />

      <RenameVaultDialog
        vault={vault}
        open={Boolean(vault && renaming)}
        onOpenChange={setRenaming}
        onRename={async (name) => {
          if (!vault) return;
          await attempt(() =>
            api.updateVault(vault.id, { expectedGeneration: vault.generation, name }),
          );
          await vaults.refresh();
          toast.success(`Renamed to ${name}`);
        }}
      />

      <DestructiveConfirm
        open={Boolean(vault && deletingVault)}
        onOpenChange={(open) => (open ? undefined : setDeletingVault(false))}
        title={vault ? (unlinks ? `Unlink ${vault.name}?` : `Delete ${vault.name}?`) : ""}
        consequences={
          vault
            ? unlinks
              ? [
                  "Agents here stop using its items.",
                  `Nothing is deleted in ${vaultHome}.`,
                  "You can link it again later.",
                ]
              : [
                  vault.itemCount === 0
                    ? "It has no items."
                    : `Its ${vault.itemCount === 1 ? "item goes" : `${vault.itemCount} items go`} with it, including their history.`,
                  "References to it stop working, and runs that use them fail.",
                  "This can't be undone.",
                ]
            : undefined
        }
        confirmText={vault && !unlinks && vault.itemCount > 0 ? vault.name : undefined}
        confirmPlaceholder="Vault name"
        confirmLabel={unlinks ? "Unlink vault" : "Delete vault"}
        pendingLabel={unlinks ? "Unlinking…" : "Deleting…"}
        onConfirm={async () => {
          if (!vault) return;
          const name = vault.name;
          await attempt(() => api.deleteVault(vault.id, name));
          setDeletingVault(false);
          openList();
          toast.success(unlinks ? `Unlinked ${name}` : `Deleted ${name}`);
          await vaults.refresh();
        }}
      />
    </ContentPage>
  );
}

/* ------------------------------------------------------------ a vault's page */

function VaultRoute({
  vault,
  organizationName,
  canManageAvailability,
  providerAccount,
  actions,
}: {
  vault: VaultSummary;
  organizationName: string;
  canManageAvailability: boolean;
  providerAccount: { name: string; onOpen: () => void } | null;
  actions: Parameters<typeof VaultPage>[0]["actions"];
}) {
  const [showArchived, setShowArchived] = useState(false);
  const items = useVaultItems(vault.id, showArchived ? { includeArchived: true } : {});
  // A sync or an edit elsewhere changes the vault's generation: reload its items.
  const { refresh } = items;
  useEffect(() => {
    void refresh();
  }, [vault.generation, vault.lastSyncedAt, refresh]);
  return (
    <VaultPage
      vault={vault}
      items={items.items}
      itemsLoading={items.loading}
      itemsError={items.error}
      organizationName={organizationName}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      canManageAvailability={canManageAvailability}
      providerAccount={providerAccount}
      actions={{ ...actions, retry: () => void items.refresh() }}
    />
  );
}

/* ------------------------------------------------------------ an item's page */

/**
 * Who a subject is, for "Version 3 · by Ada": "you" for the signed-in person,
 * else the workspace member's name. Null until known; history then says "a person".
 */
function usePersonName(workspaceId: string, enabled = true): (subjectId: string) => string | null {
  const context = useAppContext();
  const selfSubjectId = context.accessContext.subjectId;
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void context.client
      .listWorkspaceMembers(workspaceId)
      .then((members) => {
        if (!active) return;
        setNames(
          new Map(
            members.map((member) => [
              member.subjectId,
              member.subjectLabel?.trim() || member.subjectId.replace(/^(user|service):/, ""),
            ]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [context.client, workspaceId, enabled]);
  return useCallback(
    (subjectId: string) => (subjectId === selfSubjectId ? "you" : (names.get(subjectId) ?? null)),
    [names, selfSubjectId],
  );
}

function ItemRoute({
  vault,
  vaults,
  itemId,
  view,
  api,
  canUse,
  onBack,
  onOpenItem,
  onChanged,
}: {
  vault: VaultSummary;
  vaults: VaultSummary[];
  itemId: string;
  view: string | undefined;
  api: VaultsApi;
  canUse: boolean;
  onBack: () => void;
  onOpenItem: (vaultId: string, itemId: string, search?: { view?: SecretsItemView }) => void;
  onChanged: () => Promise<void>;
}) {
  const loaded = useVaultItem(vault.id, itemId);
  const item = loaded.item;
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const personName = usePersonName(vault.workspaceId);
  const operations = vaultOperations(vault);
  const home = sourceHome(vault);
  const hosted = vault.source === "opengeni";

  if (!item) {
    return loaded.error && !loaded.loading ? (
      <SecretsMissing what="item" backLabel={vault.name} onBack={onBack} />
    ) : (
      <ItemPageLoading backLabel={vault.name} onBack={onBack} />
    );
  }

  if (view === "edit" && operations.updateItem && item.archivedAt === null) {
    return (
      <ItemEditorPage
        vault={vault}
        item={item}
        onClose={() => onOpenItem(vault.id, item.id)}
        onCreate={async () => undefined}
        onUpdate={async (request) => {
          await attempt(() => api.updateItem(vault.id, item.id, request), home);
          await loaded.refresh();
          await onChanged();
          toast.success("Saved");
          onOpenItem(vault.id, item.id);
        }}
        onReload={() => void loaded.refresh()}
      />
    );
  }

  // Copy needs a vault that takes this item; Move also needs this vault to let it go.
  const targets = vaults.filter((each) => each.id !== vault.id && acceptsItem(each, item));
  const canMove = operations.archiveItem && operations.archiveKind !== "none";
  const transfer: ItemTransfer = targets.length === 0 ? null : canMove ? "move" : "copy";
  const removal = operations.archiveKind === "trash" ? "trash" : "archive";

  const archiveHosted = async () => {
    await attempt(() => api.deleteItem(vault.id, item.id));
    await loaded.refresh();
    await onChanged();
    toast.success(`Archived ${item.name}`, {
      description: "Agents can't use it until it's restored.",
      action: {
        label: "Undo",
        onClick: () => {
          void api
            .restoreItem(vault.id, item.id)
            .then(() => Promise.all([loaded.refresh(), onChanged()]))
            .catch((error: unknown) => toast.error(vaultError(error).message));
        },
      },
    });
  };
  // Over there it can't be undone from here: confirm first, then leave the item.
  const removeInProvider = async () => {
    await attempt(() => api.deleteItem(vault.id, item.id), home);
    setRemoving(false);
    await onChanged();
    toast.success(
      removal === "trash"
        ? `Moved ${item.name} to trash in ${home}`
        : `Archived ${item.name} in ${home}`,
    );
    onBack();
  };

  return (
    <>
      <ItemPage
        item={item}
        vault={vault}
        api={api}
        canUse={canUse}
        personName={personName}
        transfer={transfer}
        actions={{
          back: onBack,
          edit: () => onOpenItem(vault.id, item.id, { view: "edit" }),
          archive: async () => {
            if (hosted || operations.restoreItem) await archiveHosted();
            else setRemoving(true);
          },
          restore: async () => {
            await attempt(() => api.restoreItem(vault.id, item.id), home);
            await loaded.refresh();
            await onChanged();
            toast.success(`Restored ${item.name}`);
          },
          deletePermanently: () => setDeleting(true),
          move: () => setMoving(true),
          refresh: () => loaded.refresh(),
        }}
      />
      <MoveItemDialog
        item={item}
        targets={targets}
        canMove={canMove}
        open={moving}
        onOpenChange={setMoving}
        onMove={async (request, target) => {
          const moved = await attempt(() => api.moveItem(vault.id, item.id, request), home);
          await onChanged();
          toast.success(
            request.mode === "move" ? `Moved to ${target.name}` : `Copied to ${target.name}`,
          );
          if (request.mode === "move") onOpenItem(target.id, moved.id);
        }}
      />
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        title={
          removal === "trash"
            ? `Move ${item.name} to trash in ${home}?`
            : `Archive ${item.name} in ${home}?`
        }
        consequences={[
          "Agents here stop using it, and references to it stop working.",
          `To bring it back, restore it in ${home}.`,
        ]}
        confirmLabel={removal === "trash" ? "Move to trash" : "Archive item"}
        pendingLabel={removal === "trash" ? "Moving…" : "Archiving…"}
        onConfirm={removeInProvider}
      />
      <DestructiveConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${item.name} permanently?`}
        consequences={[
          "Its values and history are erased.",
          "References to it stop working.",
          "This can't be undone.",
        ]}
        confirmLabel="Delete item"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await attempt(() => api.deleteItem(vault.id, item.id, true));
          setDeleting(false);
          await onChanged();
          toast.success(`Deleted ${item.name}`);
          onBack();
        }}
      />
    </>
  );
}
