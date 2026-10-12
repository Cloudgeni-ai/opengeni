// Secrets: vaults of logins, keys, notes and files that agents use by
// reference. Values are revealed only on request ("use = reveal").
//
//   /secrets                      the vault list   ?view=new|connect-1password
//   /secrets/$vaultId             a vault's page   ?view=availability|new-item&type=
//   /secrets/$vaultId/$itemId     an item's page   ?view=edit
import {
  useVault,
  useVaultItem,
  useVaultItems,
  useVaults,
  type VaultSummary,
  type VaultsApi,
} from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { AvailabilityWorkspace } from "@/components/secrets/availability-editor";
import { ConnectOnePasswordPage } from "@/components/secrets/connect-onepassword";
import { ItemEditorPage } from "@/components/secrets/item-editor";
import { ItemPage, ItemPageLoading } from "@/components/secrets/item-page";
import { MoveItemDialog } from "@/components/secrets/move-item-dialog";
import {
  AvailabilityPage,
  NewVaultPage,
  RenameVaultDialog,
} from "@/components/secrets/vault-forms";
import { SecretsListPage, type SecretsListState } from "@/components/secrets/vault-list";
import { MIN_HIT_AREAS } from "@/components/secrets/secret-actions";
import { secretsCapabilityOff, vaultError } from "@/components/secrets/vault-model";
import { SecretsMissing, VaultPage, VaultPageLoading } from "@/components/secrets/vault-page";
import { ContentPage } from "@/components/ui/content-layout";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { useFocusOnNavigation } from "@/lib/use-focus-on-navigation";
import { cn } from "@/lib/utils";

export type SecretsListView = "new" | "connect-1password";
export type SecretsVaultView = "availability" | "new-item";
export type SecretsItemView = "edit";

const CREATABLE_TYPES = ["login", "api_key", "note", "file"] as const;
type CreatableType = (typeof CREATABLE_TYPES)[number];

export function parseCreatableType(value: unknown): CreatableType | undefined {
  return CREATABLE_TYPES.includes(value as CreatableType) ? (value as CreatableType) : undefined;
}

/** True when the workspace's default agent has the Secrets capability off. */

/** Wraps a mutation so its error carries the vault copy (UI-9). */
async function attempt<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw vaultError(error);
  }
}

export function SecretsRoute({
  workspaceId,
  vaultId,
  itemId,
  view,
  type,
}: {
  workspaceId: string;
  vaultId?: string | undefined;
  itemId?: string | undefined;
  view?: string | undefined;
  type?: string | undefined;
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

  /* ------------------------------------------------------------ navigation */

  const openList = useCallback(
    (search: { view?: SecretsListView } = {}) =>
      void navigate({ to: "/workspaces/$workspaceId/secrets", params: { workspaceId }, search }),
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
  useEffect(() => {
    setRenaming(false);
    setDeletingVault(false);
  }, [vaultId]);

  const pageKey = `${vaultId ?? ""}|${itemId ?? ""}|${view ?? ""}`;
  const root = useFocusOnNavigation(pageKey, {
    onList: pageKey === "||",
    rememberTitle: Boolean(vaultId) && !view,
  });

  /* ------------------------------------------------------------ pages */

  const owners: ("user" | "workspace" | "organization")[] = [
    ...(canWriteWorkspace ? (["workspace"] as const) : []),
    "user",
    ...(canManageOrganization ? (["organization"] as const) : []),
  ];

  let page: ReactNode;
  if (!vaultId) {
    if (view === "new" && canList && canWrite) {
      page = (
        <NewVaultPage
          canCreateWorkspace={canWriteWorkspace}
          canCreateOrganization={canManageOrganization}
          organizationName={organizationName}
          workspaces={organizationWorkspaces}
          onClose={() => openList()}
          onCreate={async (request) => {
            const created = await attempt(() => api.createVault(request));
            await vaults.refresh();
            toast.success(`Created ${created.name}`);
            openVault(created.id);
          }}
        />
      );
    } else if (view === "connect-1password" && canList && canWrite) {
      page = (
        <ConnectOnePasswordPage
          owners={owners}
          organizationName={organizationName}
          onClose={() => {
            void vaults.refresh();
            openList();
          }}
          actions={{
            install: (request) => attempt(() => api.installOnePassword(request)),
            link: (meta, mode, ownerKind, connectionId) =>
              attempt(() =>
                api.linkProviderVault({
                  provider: "onepassword",
                  connectionId,
                  externalVaultId: meta.externalVaultId,
                  ownerKind,
                  mode,
                  name: meta.name,
                }),
              ),
            createManaged: (name, ownerKind, connectionId) =>
              attempt(() => api.createManagedProviderVault(connectionId, { name, ownerKind })),
            openVault: (linked) => {
              void vaults.refresh();
              openVault(linked.id);
            },
          }}
        />
      );
    } else {
      page = (
        <SecretsListPage
          state={listState}
          error={vaults.error}
          vaults={list}
          canList={canList}
          canCreate={canWrite}
          canConnect={canWrite}
          capabilityOff={capabilityOff}
          agentSettingsHref={agentSettingsHref}
          onRetry={() => void vaults.refresh()}
          onOpenVault={(each) => openVault(each.id)}
          onNewVault={() => openList({ view: "new" })}
          onConnectOnePassword={() => openList({ view: "connect-1password" })}
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
  } else if (view === "availability" && vault.canManage && vault.ownerKind === "organization") {
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
          toast.success("Saved");
          openVault(vault.id);
        }}
      />
    );
  } else if (view === "new-item" && vault.canWrite) {
    page = (
      <ItemEditorPage
        vault={vault}
        initialType={parseCreatableType(type)}
        onClose={() => openVault(vault.id)}
        onCreate={async (request) => {
          const created = await attempt(() => api.createItem(vault.id, request));
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
        canManageAvailability={vault.canManage && vault.ownerKind === "organization"}
        actions={{
          back: () => openList(),
          newItem: () => openVault(vault.id, { view: "new-item" }),
          openItem: (item) => openItem(vault.id, item.id),
          rename: () => setRenaming(true),
          editAvailability: () => openVault(vault.id, { view: "availability" }),
          sync: async () => {
            await attempt(() => api.syncVault(vault.id));
            await vaults.refresh();
          },
          reconnect: () => openList({ view: "connect-1password" }),
          deleteVault: () => setDeletingVault(true),
          retry: () => void vaults.refresh(),
        }}
      />
    );
  }

  const unlinks = vault?.source !== "opengeni";

  return (
    <ContentPage width="standard">
      <TooltipProvider delayDuration={300}>
        <div ref={root} className={cn("min-w-0 pb-7", MIN_HIT_AREAS)}>
          {page}
        </div>
      </TooltipProvider>

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
                  "Nothing is deleted in 1Password.",
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
  actions,
}: {
  vault: VaultSummary;
  organizationName: string;
  canManageAvailability: boolean;
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
      actions={{ ...actions, retry: () => void items.refresh() }}
    />
  );
}

/* ------------------------------------------------------------ an item's page */

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

  if (!item) {
    return loaded.error && !loaded.loading ? (
      <SecretsMissing what="item" backLabel={vault.name} onBack={onBack} />
    ) : (
      <ItemPageLoading backLabel={vault.name} onBack={onBack} />
    );
  }

  if (view === "edit" && vault.canWrite) {
    return (
      <ItemEditorPage
        vault={vault}
        item={item}
        onClose={() => onOpenItem(vault.id, item.id)}
        onCreate={async () => undefined}
        onUpdate={async (request) => {
          await attempt(() => api.updateItem(vault.id, item.id, request));
          await loaded.refresh();
          await onChanged();
          toast.success("Saved");
          onOpenItem(vault.id, item.id);
        }}
        onReload={() => void loaded.refresh()}
      />
    );
  }

  const archive = async () => {
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

  return (
    <>
      <ItemPage
        item={item}
        vault={vault}
        api={api}
        canUse={canUse}
        actions={{
          back: onBack,
          edit: () => onOpenItem(vault.id, item.id, { view: "edit" }),
          archive,
          restore: async () => {
            await attempt(() => api.restoreItem(vault.id, item.id));
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
        vaults={vaults}
        open={moving}
        onOpenChange={setMoving}
        onMove={async (request, target) => {
          const moved = await attempt(() => api.moveItem(vault.id, item.id, request));
          await onChanged();
          toast.success(
            request.mode === "move" ? `Moved to ${target.name}` : `Copied to ${target.name}`,
          );
          if (request.mode === "move") onOpenItem(target.id, moved.id);
        }}
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
