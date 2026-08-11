import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  ApiIntegrationInstallationSummary,
  ConnectorDocumentDestinationAuthority,
  GoogleDriveBrowseItem,
  GoogleDriveKnowledgeSourceConfig,
  GoogleDriveReadPolicy,
  GoogleDriveSyncCadence,
  IntegrationFeatureBindingSummary,
  IntegrationFeatureDefinitionSummary,
} from "@/types";

type FolderCrumb = { id: string; name: string };

export type GoogleDriveFeatureEntry = {
  definition: IntegrationFeatureDefinitionSummary;
  binding: IntegrationFeatureBindingSummary | null;
};

export function GoogleDriveKnowledgeSourceDialog({
  client,
  workspaceId,
  instance,
  entry,
  canManage,
  canManagePersonalDestination,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  onClose,
  onBusyChange,
  onSaved,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  instance: ApiIntegrationInstallationSummary;
  entry: GoogleDriveFeatureEntry | null;
  canManage: boolean;
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [items, setItems] = useState<GoogleDriveBrowseItem[]>([]);
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([{ id: "root", name: "My Drive" }]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<GoogleDriveBrowseItem | null>(null);
  const [selectedSources, setSelectedSources] = useState<GoogleDriveBrowseItem[]>([]);
  const [authorityKind, setAuthorityKind] =
    useState<ConnectorDocumentDestinationAuthority>("workspace");
  const [folderIdDraft, setFolderIdDraft] = useState("");
  const [syncCadence, setSyncCadence] = useState<GoogleDriveSyncCadence>("hourly");
  const [readPolicy, setReadPolicy] = useState<GoogleDriveReadPolicy>("allow");

  const folderItems = useMemo(() => items.filter((item) => item.kind === "folder"), [items]);

  const loadFolder = useCallback(
    async (
      folder: FolderCrumb,
      mode: "replace" | "append" = "replace",
      pageToken?: string,
    ): Promise<GoogleDriveBrowseItem | null> => {
      if (!entry) return null;
      setBrowseBusy(true);
      try {
        const response = await client.browseGoogleDriveIntegrationSource(
          workspaceId,
          instance.capabilityId,
          instance.instanceKey,
          entry.definition.featureKey,
          {
            parentId: folder.id,
            ...(pageToken ? { pageToken } : {}),
          },
        );
        setItems((current) =>
          mode === "append" ? [...current, ...response.items] : response.items,
        );
        setNextPageToken(response.nextPageToken);
        if (mode === "replace") {
          setCurrentFolder(response.current);
          setCrumbs((current) => {
            const last = current.at(-1);
            if (!last || !response.current) return current;
            return [
              ...current.slice(0, -1),
              { id: response.current.id, name: googleDriveBoundaryLabel(response.current) },
            ];
          });
        }
        if (response.incompleteSearch) {
          toast.warning("Google returned a partial Drive listing");
        }
        return response.current;
      } catch (error) {
        toast.error("Google Drive folder could not be opened", {
          description: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        setBrowseBusy(false);
      }
    },
    [client, entry, instance.capabilityId, instance.instanceKey, workspaceId],
  );

  useEffect(() => {
    if (!entry) return;
    const config = googleDriveKnowledgeSourceConfig(entry.binding?.config);
    setSelectedSources(configuredGoogleDriveKnowledgeSources(entry.binding?.config));
    setAuthorityKind(
      config?.destination.authorityKind ??
        defaultGoogleDriveDestination({
          canManagePersonalDestination,
          canManageWorkspaceDestination,
          canManageOrganizationDestination,
        }),
    );
    setSyncCadence(config?.syncCadence ?? "hourly");
    setReadPolicy(config?.readPolicy ?? "allow");
    setCrumbs([{ id: "root", name: "My Drive" }]);
    setItems([]);
    setCurrentFolder(null);
    setNextPageToken(null);
    setFolderIdDraft("");
    void loadFolder({ id: "root", name: "My Drive" });
  }, [
    canManageOrganizationDestination,
    canManagePersonalDestination,
    canManageWorkspaceDestination,
    entry,
    loadFolder,
  ]);

  function openFolder(item: GoogleDriveBrowseItem): void {
    const folder = { id: item.id, name: item.name };
    setCrumbs((current) => [...current, folder]);
    void loadFolder(folder);
  }

  function openCrumb(index: number): void {
    const folder = crumbs[index];
    if (!folder) return;
    setCrumbs((current) => current.slice(0, index + 1));
    void loadFolder(folder);
  }

  function goBack(): void {
    if (crumbs.length <= 1) return;
    const folder = crumbs.at(-2);
    if (!folder) return;
    setCrumbs((current) => current.slice(0, -1));
    void loadFolder(folder);
  }

  async function addFolderId(): Promise<void> {
    const id = folderIdDraft.trim();
    if (!id) return;
    const folder = { id, name: "Linked folder" };
    setCrumbs([folder]);
    const resolved = await loadFolder(folder);
    if (resolved) addSource(resolved);
  }

  function addSource(source: GoogleDriveBrowseItem): void {
    if (selectedSources.some((item) => item.id === source.id)) return;
    const visibleDescendantIds =
      currentFolder?.id === source.id ? new Set(folderItems.map((item) => item.id)) : null;
    const next = [...selectedSources.filter((item) => !visibleDescendantIds?.has(item.id)), source];
    if (next.length > 100) {
      toast.warning("A knowledge source can include at most 100 Drive locations");
      return;
    }
    setSelectedSources(next);
  }

  function removeSource(sourceId: string): void {
    setSelectedSources((current) => current.filter((source) => source.id !== sourceId));
  }

  function toggleSource(source: GoogleDriveBrowseItem): void {
    if (selectedSources.some((item) => item.id === source.id)) {
      removeSource(source.id);
    } else {
      addSource(source);
    }
  }

  const currentFolderIncludedByAncestor = crumbs
    .slice(0, -1)
    .some((crumb) => selectedSources.some((source) => source.id === crumb.id));
  const childFoldersIncludedByAncestor =
    currentFolderIncludedByAncestor ||
    (currentFolder ? selectedSources.some((source) => source.id === currentFolder.id) : false);
  const destinationDisabled = googleDriveDestinationOptionDisabled(authorityKind, {
    canManagePersonalDestination,
    canManageWorkspaceDestination,
    canManageOrganizationDestination,
  });

  async function saveSelection(): Promise<void> {
    if (!entry || selectedSources.length === 0 || destinationDisabled || !canManage) return;
    setBusy(true);
    onBusyChange(true);
    try {
      await client.saveGoogleDriveIntegrationSource(
        workspaceId,
        instance.capabilityId,
        instance.instanceKey,
        entry.definition.featureKey,
        {
          sources: selectedSources.map((source) => ({
            id: source.id,
            name: source.name,
            mimeType: source.mimeType,
            driveId: source.driveId,
          })),
          destination: { authorityKind, collectionId: null },
          syncCadence,
          syncEnabled: true,
          readPolicy,
          ...(entry.binding ? { expectedVersion: entry.binding.version } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
      );
      await onSaved();
      onClose();
      toast.success("Google Drive locations saved", {
        description: `Only ${instance.displayName} was updated; sibling Drive accounts were unchanged.`,
      });
    } catch (error) {
      toast.error("Google Drive locations could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Google Drive locations · {instance.displayName}</DialogTitle>
          <DialogDescription>
            Choose one or more folders or Shared Drives for this exact connected account.
            Descendants are included automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-3 overflow-y-auto pr-1">
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-fg">Selected locations</span>
              <span className="text-fg-subtle">{selectedSources.length}/100</span>
            </div>
            {selectedSources.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {selectedSources.map((source) => (
                  <span
                    key={source.id}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg"
                  >
                    <FolderOpenIcon className="size-3 shrink-0 text-brand" />
                    <span className="max-w-56 truncate">{googleDriveBoundaryLabel(source)}</span>
                    <button
                      type="button"
                      className="rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
                      aria-label={`Remove ${googleDriveBoundaryLabel(source)}`}
                      onClick={() => removeSource(source.id)}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-fg-subtle">
                Select at least one Drive or folder.
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex min-w-0 items-center gap-1 border-b border-border bg-surface/35 px-2 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                disabled={crumbs.length <= 1 || browseBusy}
                onClick={goBack}
                aria-label="Back one folder"
              >
                <span aria-hidden="true">←</span>
              </Button>
              <div className="flex min-w-0 items-center gap-0.5 text-xs text-fg-muted">
                {crumbs.map((crumb, index) => (
                  <div key={crumb.id} className="flex min-w-0 items-center gap-0.5">
                    {index > 0 ? <span aria-hidden="true">›</span> : null}
                    <button
                      type="button"
                      className="max-w-32 truncate rounded px-1.5 py-1 hover:bg-surface-2 hover:text-fg"
                      disabled={browseBusy}
                      onClick={() => openCrumb(index)}
                    >
                      {crumb.name}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="max-h-[30vh] min-h-40 overflow-y-auto">
              {browseBusy && !currentFolder ? (
                <div className="flex h-40 items-center justify-center gap-2 text-xs text-fg-muted">
                  <Loader2Icon className="size-4 animate-spin" />
                  Loading folders
                </div>
              ) : (
                <>
                  {currentFolder ? (
                    <FolderChoice
                      source={currentFolder}
                      selected={
                        currentFolderIncludedByAncestor ||
                        selectedSources.some((source) => source.id === currentFolder.id)
                      }
                      disabled={currentFolderIncludedByAncestor}
                      busy={browseBusy}
                      primary
                      onToggle={() => toggleSource(currentFolder)}
                    />
                  ) : null}
                  {folderItems.map((item) => (
                    <FolderChoice
                      key={item.id}
                      source={item}
                      selected={
                        childFoldersIncludedByAncestor ||
                        selectedSources.some((source) => source.id === item.id)
                      }
                      disabled={childFoldersIncludedByAncestor}
                      busy={browseBusy}
                      onToggle={() => toggleSource(item)}
                      onOpen={() => openFolder(item)}
                    />
                  ))}
                  {currentFolder && folderItems.length === 0 ? (
                    <div className="px-3 py-5 text-center text-xs text-fg-subtle">
                      No subfolders
                    </div>
                  ) : null}
                </>
              )}
              {nextPageToken ? (
                <div className="border-t border-border p-2 text-center">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={browseBusy}
                    onClick={() =>
                      void loadFolder(
                        crumbs.at(-1) ?? { id: "root", name: "My Drive" },
                        "append",
                        nextPageToken,
                      )
                    }
                  >
                    Load more folders
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex gap-2">
            <Input
              value={folderIdDraft}
              onChange={(event) => setFolderIdDraft(event.target.value)}
              placeholder="Paste a folder or Shared Drive link"
              className="h-8 text-xs"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addFolderId();
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!folderIdDraft.trim() || browseBusy}
              onClick={() => void addFolderId()}
            >
              Add
            </Button>
          </div>

          <p className="text-2xs leading-5 text-fg-subtle">
            Provider credentials, page tokens, and cursor state stay private. This versioned
            selection belongs only to {instance.displayName}.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <label className="grid gap-1 text-xs text-fg-muted">
            Save to
            <Select
              value={authorityKind}
              onChange={(event) =>
                setAuthorityKind(event.target.value as ConnectorDocumentDestinationAuthority)
              }
            >
              <option
                value="personal"
                disabled={googleDriveDestinationOptionDisabled("personal", {
                  canManagePersonalDestination,
                  canManageWorkspaceDestination,
                  canManageOrganizationDestination,
                })}
              >
                Only me
              </option>
              <option
                value="workspace"
                disabled={googleDriveDestinationOptionDisabled("workspace", {
                  canManagePersonalDestination,
                  canManageWorkspaceDestination,
                  canManageOrganizationDestination,
                })}
              >
                This workspace
              </option>
              <option
                value="organization"
                disabled={googleDriveDestinationOptionDisabled("organization", {
                  canManagePersonalDestination,
                  canManageWorkspaceDestination,
                  canManageOrganizationDestination,
                })}
              >
                Company
              </option>
            </Select>
          </label>
          <label className="grid gap-1 text-xs text-fg-muted">
            Check
            <Select
              value={syncCadence}
              onChange={(event) => setSyncCadence(event.target.value as GoogleDriveSyncCadence)}
            >
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="manual">Only when triggered</option>
            </Select>
          </label>
          <label className="grid gap-1 text-xs text-fg-muted">
            Access
            <Select
              value={readPolicy}
              onChange={(event) => setReadPolicy(event.target.value as GoogleDriveReadPolicy)}
            >
              <option value="allow">Allow automatically</option>
              <option value="ask">Ask before each run</option>
              <option value="block">Block</option>
            </Select>
          </label>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !canManage || selectedSources.length === 0 || destinationDisabled}
            onClick={() => void saveSelection()}
          >
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Save {selectedSources.length} location{selectedSources.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderChoice({
  source,
  selected,
  disabled,
  busy,
  primary = false,
  onToggle,
  onOpen,
}: {
  source: GoogleDriveBrowseItem;
  selected: boolean;
  disabled: boolean;
  busy: boolean;
  primary?: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5 last:border-b-0">
      <input
        type="checkbox"
        className="size-4 accent-brand"
        aria-label={`Connect ${googleDriveBoundaryLabel(source)}`}
        checked={selected}
        disabled={disabled || busy}
        title={disabled ? "Included by a selected parent folder" : undefined}
        onChange={onToggle}
      />
      <FolderOpenIcon className="size-4 shrink-0 text-brand" />
      {onOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-fg hover:text-brand"
          disabled={busy}
          onClick={onOpen}
        >
          <span className="min-w-0 flex-1 truncate">{googleDriveBoundaryLabel(source)}</span>
          <span aria-hidden="true">›</span>
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-fg">
            {googleDriveBoundaryLabel(source)}
          </div>
          {primary ? <div className="text-2xs text-fg-subtle">Everything inside</div> : null}
        </div>
      )}
    </div>
  );
}

export function configuredGoogleDriveKnowledgeSources(
  rawConfig: Record<string, unknown> | null | undefined,
): GoogleDriveBrowseItem[] {
  const config = googleDriveKnowledgeSourceConfig(rawConfig);
  if (!config) return [];
  return config.sources.map((source) => ({
    id: source.id,
    name: source.name,
    mimeType: source.mimeType,
    kind: "folder",
    driveId: source.driveId ?? null,
    modifiedTime: null,
    size: null,
    webViewLink: null,
  }));
}

export function googleDriveDestinationOptionDisabled(
  authorityKind: ConnectorDocumentDestinationAuthority,
  permissions: {
    canManagePersonalDestination: boolean;
    canManageWorkspaceDestination: boolean;
    canManageOrganizationDestination: boolean;
  },
): boolean {
  if (authorityKind === "personal") return !permissions.canManagePersonalDestination;
  if (authorityKind === "workspace") return !permissions.canManageWorkspaceDestination;
  return !permissions.canManageOrganizationDestination;
}

function defaultGoogleDriveDestination(permissions: {
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
}): ConnectorDocumentDestinationAuthority {
  if (permissions.canManageWorkspaceDestination) return "workspace";
  if (permissions.canManagePersonalDestination) return "personal";
  return "organization";
}

function googleDriveKnowledgeSourceConfig(
  rawConfig: Record<string, unknown> | null | undefined,
): GoogleDriveKnowledgeSourceConfig | null {
  const config = objectValue(rawConfig);
  const rawSources = Array.isArray(config.sources) ? config.sources : null;
  const destination = objectValue(config.destination);
  const authorityKind = destination.authorityKind;
  const syncCadence = config.syncCadence;
  const readPolicy = config.readPolicy;
  if (
    !rawSources ||
    (authorityKind !== "organization" &&
      authorityKind !== "workspace" &&
      authorityKind !== "personal") ||
    (syncCadence !== "manual" && syncCadence !== "hourly" && syncCadence !== "daily") ||
    (readPolicy !== "allow" && readPolicy !== "ask" && readPolicy !== "block") ||
    typeof destination.authorityAccountId !== "string"
  ) {
    return null;
  }
  const sources = rawSources.flatMap((raw) => {
    const source = objectValue(raw);
    const sourceKind = source.sourceKind;
    if (
      typeof source.id !== "string" ||
      typeof source.name !== "string" ||
      typeof source.mimeType !== "string" ||
      (sourceKind !== "my_drive" && sourceKind !== "shared_drive" && sourceKind !== "folder") ||
      typeof source.includeDescendants !== "boolean"
    ) {
      return [];
    }
    const parsedSource: GoogleDriveKnowledgeSourceConfig["sources"][number] = {
      id: source.id,
      name: source.name,
      mimeType: source.mimeType,
      ...(typeof source.driveId === "string" ? { driveId: source.driveId } : {}),
      sourceKind: sourceKind as GoogleDriveKnowledgeSourceConfig["sources"][number]["sourceKind"],
      includeDescendants: source.includeDescendants,
    };
    return [parsedSource];
  });
  if (sources.length !== rawSources.length || sources.length === 0) return null;
  return {
    sources,
    destination: {
      authorityKind,
      authorityAccountId: destination.authorityAccountId,
      ...(typeof destination.authorityWorkspaceId === "string"
        ? { authorityWorkspaceId: destination.authorityWorkspaceId }
        : {}),
      ...(typeof destination.authoritySubjectId === "string"
        ? { authoritySubjectId: destination.authoritySubjectId }
        : {}),
      ...(typeof destination.collectionId === "string"
        ? { collectionId: destination.collectionId }
        : {}),
    },
    syncCadence,
    readPolicy,
  };
}

function googleDriveBoundaryLabel(source: {
  id: string;
  name: string;
  driveId: string | null;
}): string {
  if (source.id === source.driveId && source.name.trim() === "Drive") {
    return `Shared Drive · ${source.id.slice(-6)}`;
  }
  return source.name.trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
