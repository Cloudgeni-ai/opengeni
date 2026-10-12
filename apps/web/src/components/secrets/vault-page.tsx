import type { VaultItemSummary, VaultItemType, VaultSummary } from "@opengeni/react";
import {
  ArchiveIcon,
  ClockIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchXIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { MoreMenu } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { SelectMenu } from "@/components/ui/select-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Toolbar, ToolbarGroup, ToolbarSearch } from "@/components/ui/toolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import {
  ITEM_TYPE_FILTERS,
  ITEM_TYPE_LABEL,
  itemSubtitle,
  itemsLabel,
  vaultAudience,
} from "./vault-model";
import {
  ExpiryBadge,
  ItemTile,
  SecretsLoadFailure,
  SyncStatus,
  VaultChips,
  VaultSyncNotice,
  VaultTile,
} from "./vault-parts";

/* ----------------------------------------------------------------------------
   A vault's page (S2): header with one primary action (New item), a toolbar
   with search and a type filter, and a dense list of items. Search and the
   filter run on the loaded list, so typing never waits on the network.
   -------------------------------------------------------------------------- */

const ITEM_COLUMNS: RowListColumn[] = [
  { id: "used", label: "Last used", width: 112 },
  { id: "updated", label: "Updated", width: 112 },
];

/** Rows rendered up front; more are added as the end of the list scrolls into view. */
const FIRST_ROWS = 120;
const MORE_ROWS = 200;

export interface VaultPageActions {
  back: () => void;
  newItem: () => void;
  openItem: (item: VaultItemSummary) => void;
  rename: () => void;
  editAvailability: () => void;
  sync: () => Promise<void>;
  reconnect: () => void;
  deleteVault: () => void;
  retry: () => void;
}

function matches(item: VaultItemSummary, words: string[]): boolean {
  if (words.length === 0) return true;
  const haystack = [item.name, item.username ?? "", ...item.websites].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function TotpGlyph() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 items-center justify-center text-fg-subtle"
          aria-label="Has one-time codes"
          role="img"
        >
          <ClockIcon aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Has one-time codes</TooltipContent>
    </Tooltip>
  );
}

export function VaultPage({
  vault,
  items,
  itemsLoading,
  itemsError,
  organizationName,
  showArchived,
  onShowArchivedChange,
  canManageAvailability,
  actions,
}: {
  vault: VaultSummary;
  items: VaultItemSummary[] | null;
  itemsLoading: boolean;
  itemsError: unknown;
  organizationName: string;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  canManageAvailability: boolean;
  actions: VaultPageActions;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | VaultItemType>("all");
  const [syncing, setSyncing] = useState(false);
  const words = useMemo(
    () => query.trim().toLowerCase().split(/\s+/u).filter(Boolean),
    [query],
  );
  const all = items ?? [];
  const typesPresent = useMemo(() => new Set(all.map((item) => item.type)), [all]);
  const visible = useMemo(
    () =>
      all.filter((item) => (type === "all" || item.type === type) && matches(item, words)),
    [all, type, words],
  );
  const [limit, setLimit] = useState(FIRST_ROWS);
  useEffect(() => setLimit(FIRST_ROWS), [query, type, vault.id]);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = visible.length > limit;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setLimit((value) => value + MORE_ROWS);
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, limit]);

  const readOnly = vault.mode === "read_only";
  const isProvider = vault.source !== "opengeni";
  const canDelete = vault.canManage && !vault.isDefault && vault.ownerKind !== "task";
  const canRename = vault.canManage && vault.ownerKind !== "task" && !isProvider;
  const loaded = items !== null;
  const empty = loaded && all.length === 0;
  const filtering = words.length > 0 || type !== "all";

  const newItemButton = (
    <Button type="button" size="sm" onClick={actions.newItem} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />
      New item
    </Button>
  );

  const menuItems: ReactNode[] = [];
  if (canRename)
    menuItems.push(
      <DropdownMenuItem key="rename" onSelect={actions.rename}>
        <PencilIcon aria-hidden="true" />
        Rename
      </DropdownMenuItem>,
    );
  if (vault.ownerKind === "organization" && canManageAvailability)
    menuItems.push(
      <DropdownMenuItem key="availability" onSelect={actions.editAvailability}>
        <UsersIcon aria-hidden="true" />
        Available in…
      </DropdownMenuItem>,
    );
  if (isProvider)
    menuItems.push(
      <DropdownMenuItem
        key="sync"
        disabled={syncing}
        onSelect={() => {
          setSyncing(true);
          void actions.sync().finally(() => setSyncing(false));
        }}
      >
        <RefreshCwIcon aria-hidden="true" />
        Sync now
      </DropdownMenuItem>,
    );
  if (!empty)
    menuItems.push(
      <DropdownMenuItem key="archived" onSelect={() => onShowArchivedChange(!showArchived)}>
        <ArchiveIcon aria-hidden="true" />
        {showArchived ? "Hide archived items" : "Show archived items"}
      </DropdownMenuItem>,
    );
  if (canDelete) {
    if (menuItems.length) menuItems.push(<DropdownMenuSeparator key="sep" />);
    menuItems.push(
      <DropdownMenuItem key="delete" variant="destructive" onSelect={actions.deleteVault}>
        <Trash2Icon aria-hidden="true" />
        {isProvider ? "Unlink vault" : "Delete vault"}
      </DropdownMenuItem>,
    );
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      {vault.canWrite && !empty ? newItemButton : null}
      {menuItems.length ? (
        <MoreMenu label={`More actions for ${vault.name}`}>{menuItems}</MoreMenu>
      ) : null}
    </div>
  );

  const typeOptions = ITEM_TYPE_FILTERS.filter(
    (option) => option.value === "all" || typesPresent.has(option.value),
  ).map((option) => ({ value: option.value, label: option.label }));

  let body: ReactNode;
  if (!loaded && itemsError) {
    body = <SecretsLoadFailure title="Couldn't load items" error={itemsError} onRetry={actions.retry} />;
  } else if (!loaded || itemsLoading && !items) {
    body = (
      <RowList variant="table" label="Items" columns={ITEM_COLUMNS} busy>
        <ListRowSkeleton count={8} />
      </RowList>
    );
  } else if (empty) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title={vault.ownerKind === "task" ? "Nothing saved in this task yet" : "No items yet"}
        description={
          vault.canWrite
            ? "Add a login, API key, note or file. Agents use it by reference, never by value."
            : readOnly
              ? "Items you add to this vault in 1Password show up here."
              : "Someone who can edit this vault can add items."
        }
        action={vault.canWrite ? newItemButton : undefined}
      />
    );
  } else {
    body = (
      <>
        <Toolbar className="mb-3">
          <ToolbarSearch
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${itemsLabel(all.length)}`}
            aria-label={`Search items in ${vault.name}`}
            wrapperClassName="min-w-0 flex-1 basis-56"
          />
          {typeOptions.length > 2 ? (
            <ToolbarGroup align="end">
              <SelectMenu
                aria-label="Item type"
                options={typeOptions}
                value={type}
                onValueChange={(value) => setType(value as typeof type)}
                className="w-36"
                align="end"
              />
            </ToolbarGroup>
          ) : null}
        </Toolbar>
        {visible.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<SearchXIcon />}
            title="No items match"
            description={
              words.length
                ? `Nothing in ${vault.name} matches “${query.trim()}”${type === "all" ? "" : ` in ${ITEM_TYPE_FILTERS.find((each) => each.value === type)?.label.toLowerCase()}`}.`
                : "No items of this type."
            }
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setType("all");
                }}
              >
                {filtering ? "Clear search" : "Show all"}
              </Button>
            }
            className="pt-10"
          />
        ) : (
          <RowList variant="table" label={`Items in ${vault.name}`} columns={ITEM_COLUMNS}>
            {visible.slice(0, limit).map((item) => {
              const subtitle = itemSubtitle(item);
              return (
                <ListRow
                  key={item.id}
                  leading={<ItemTile item={item} />}
                  title={item.name}
                  titleAddon={item.hasTotp ? <TotpGlyph /> : null}
                  description={
                    subtitle ? `${ITEM_TYPE_LABEL[item.type]} · ${subtitle}` : ITEM_TYPE_LABEL[item.type]
                  }
                  status={
                    item.archivedAt ? (
                      <span className="text-xs text-fg-subtle">Archived</span>
                    ) : (
                      <ExpiryBadge expiresAt={item.expiresAt} />
                    )
                  }
                  cells={{
                    used: item.lastUsedAt ? <RelativeTime date={item.lastUsedAt} /> : null,
                    updated: <RelativeTime date={item.updatedAt} />,
                  }}
                  indicator="open"
                  onOpen={() => actions.openItem(item)}
                />
              );
            })}
          </RowList>
        )}
        {more ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null}
      </>
    );
  }

  return (
    <DetailPage back={{ label: "Secrets", onClick: actions.back }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<VaultTile vault={vault} />}
        title={vault.name}
        chips={
          <>
            <VaultChips vault={vault} showOwner />
            <SyncStatus vault={vault} variant="outline" />
          </>
        }
        meta={[
          <span key="count">{itemsLabel(vault.itemCount)}</span>,
          <span key="audience">{vaultAudience(vault, organizationName)}</span>,
          <span key="updated">
            updated <RelativeTime date={vault.updatedAt} inSentence />
          </span>,
        ]}
        actions={headerActions}
      />
      <div className="mt-6 flex min-w-0 flex-col gap-4">
        <VaultSyncNotice
          vault={vault}
          retrying={syncing}
          onRetry={() => {
            setSyncing(true);
            void actions.sync().finally(() => setSyncing(false));
          }}
          onReconnect={actions.reconnect}
        />
        {readOnly && vault.syncStatus === "ok" ? (
          <p className="m-0 text-sm leading-5 text-fg-muted">
            Read-only: items come from 1Password and change there.
          </p>
        ) : null}
        <div className="min-w-0">{body}</div>
      </div>
    </DetailPage>
  );
}

/** Loading, in the page's own shape. */
export function VaultPageLoading({ onBack }: { onBack: () => void }) {
  return (
    <DetailPage back={{ label: "Secrets", onClick: onBack }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <div role="status" aria-label="Loading vault" className="min-w-0">
        <div aria-hidden="true" className="flex items-start gap-4">
          <Skeleton className="size-10 shrink-0 rounded-[10px] bg-surface-2" />
          <div className="min-w-0 flex-1 pt-1">
            <Skeleton className="h-5 w-48 rounded-full bg-surface-3" />
            <Skeleton className="mt-3 h-3.5 w-80 max-w-full rounded-full bg-surface-2" />
          </div>
        </div>
        <div className="mt-6">
          <Skeleton className="mb-3 h-9 w-full rounded-[10px] bg-surface-2" />
          <RowList variant="table" label="Items" busy columns={ITEM_COLUMNS}>
            <ListRowSkeleton count={8} />
          </RowList>
        </div>
      </div>
    </DetailPage>
  );
}

/** The vault was deleted, or this person can't see it. */
export function SecretsMissing({
  what,
  backLabel,
  onBack,
}: {
  what: "vault" | "item";
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <DetailPage back={{ label: backLabel, onClick: onBack }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title={what === "vault" ? "This vault isn't here" : "This item isn't here"}
        description="It may have been deleted or moved, or you don't have access to it."
        action={
          <Button type="button" variant="outline" onClick={onBack}>
            Back to {backLabel.toLowerCase() === "secrets" ? "secrets" : backLabel}
          </Button>
        }
      />
    </DetailPage>
  );
}
