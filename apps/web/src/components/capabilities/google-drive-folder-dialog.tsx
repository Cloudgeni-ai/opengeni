import { FolderOpenIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { request as apiRequest } from "@/api";
import {
  configuredGoogleDriveSources,
  googleDriveBoundaryLabel,
  googleDriveDestinationOptionDisabled,
  saveGoogleDriveSources,
} from "@/components/capabilities/google-drive-sources";
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
import { GOOGLE_DRIVE_SYNC_BEHAVIOR } from "@/lib/google-drive-connection";
import type {
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
  GoogleDriveBrowseItem,
  GoogleDriveBrowseResponse,
  GoogleDriveConnectionMetadata as GoogleDriveMetadata,
  GoogleDriveReadPolicy,
  GoogleDriveSyncCadence,
} from "@/types";

type FolderCrumb = { id: string; name: string };
const ROOT_CRUMB: FolderCrumb = { id: "root", name: "My Drive" };

/**
 * The Google Drive folder picker. Opened from the integration sheet's Access
 * block; owns its own browsing state and starts fresh every time it opens.
 */
export function GoogleDriveFolderDialog({
  workspaceId,
  connection,
  metadata,
  open,
  canWrite,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  onOpenChange,
  onConnectionUpdated,
  onLoadFailed,
}: {
  workspaceId: string;
  connection: ConnectionMetadata | null;
  metadata: GoogleDriveMetadata | undefined;
  open: boolean;
  canWrite: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  onOpenChange: (open: boolean) => void;
  onConnectionUpdated: (connection: ConnectionMetadata) => void;
  onLoadFailed: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && connection ? (
        <GoogleDriveFolderDialogBody
          workspaceId={workspaceId}
          connection={connection}
          metadata={metadata}
          canWrite={canWrite}
          canManageWorkspaceDestination={canManageWorkspaceDestination}
          canManageOrganizationDestination={canManageOrganizationDestination}
          onClose={() => onOpenChange(false)}
          onConnectionUpdated={onConnectionUpdated}
          onLoadFailed={onLoadFailed}
        />
      ) : null}
    </Dialog>
  );
}

function GoogleDriveFolderDialogBody({
  workspaceId,
  connection,
  metadata,
  canWrite,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  onClose,
  onConnectionUpdated,
  onLoadFailed,
}: {
  workspaceId: string;
  connection: ConnectionMetadata;
  metadata: GoogleDriveMetadata | undefined;
  canWrite: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  onClose: () => void;
  onConnectionUpdated: (connection: ConnectionMetadata) => void;
  onLoadFailed: () => void | Promise<void>;
}) {
  const savedSources = configuredGoogleDriveSources(metadata);
  const existingSource = savedSources[0];
  const [busy, setBusy] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [items, setItems] = useState<GoogleDriveBrowseItem[]>([]);
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([ROOT_CRUMB]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<GoogleDriveBrowseItem | null>(null);
  const [selectedSources, setSelectedSources] = useState<GoogleDriveBrowseItem[]>(savedSources);
  const [authorityKind, setAuthorityKind] = useState<ConnectorDocumentDestinationAuthority>(
    metadata?.documentDestination?.authorityKind ?? existingSource?.authorityKind ?? "workspace",
  );
  const [folderIdDraft, setFolderIdDraft] = useState("");
  const [syncCadence, setSyncCadence] = useState<GoogleDriveSyncCadence>(
    existingSource?.syncCadence ?? "hourly",
  );
  const [syncEnabled, setSyncEnabled] = useState(existingSource?.syncEnabled ?? false);
  const [readPolicy, setReadPolicy] = useState<GoogleDriveReadPolicy>(
    existingSource?.readPolicy ?? "allow",
  );
  const [initialLoadStarted, setInitialLoadStarted] = useState(false);
  const folderItems = items.filter((item) => item.kind === "folder");

  useEffect(() => {
    if (initialLoadStarted) return;
    setInitialLoadStarted(true);
    void loadFolder(ROOT_CRUMB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoadStarted]);

  async function loadFolder(
    folder: FolderCrumb,
    mode: "replace" | "append" = "replace",
    pageToken?: string,
  ): Promise<GoogleDriveBrowseItem | null> {
    setBrowseBusy(true);
    try {
      const query = new URLSearchParams({
        parentId: folder.id,
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await apiRequest<GoogleDriveBrowseResponse>(
        `/v1/workspaces/${workspaceId}/connections/google-drive/${connection.id}/browse?${query}`,
      );
      setItems((current) => (mode === "append" ? [...current, ...response.items] : response.items));
      setNextPageToken(response.nextPageToken);
      if (mode === "replace") {
        setCurrentFolder(response.current);
        setCrumbs((current) => {
          const last = current[current.length - 1];
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
      onConnectionUpdated(response.connection);
      return response.current;
    } catch (error) {
      toast.error("Google Drive folder could not be opened", {
        description: error instanceof Error ? error.message : String(error),
      });
      await onLoadFailed();
      return null;
    } finally {
      setBrowseBusy(false);
    }
  }

  function openFolder(item: GoogleDriveBrowseItem) {
    const folder = { id: item.id, name: item.name };
    setCrumbs((current) => [...current, folder]);
    void loadFolder(folder);
  }

  function openCrumb(index: number) {
    const folder = crumbs[index];
    if (!folder) return;
    setCrumbs((current) => current.slice(0, index + 1));
    void loadFolder(folder);
  }

  function goBack() {
    if (crumbs.length <= 1) return;
    const folder = crumbs[crumbs.length - 2];
    if (!folder) return;
    setCrumbs((current) => current.slice(0, -1));
    void loadFolder(folder);
  }

  async function addFolderId() {
    const id = folderIdDraft.trim();
    if (!id) return;
    const folder = { id, name: "Linked folder" };
    setCrumbs([folder]);
    const resolved = await loadFolder(folder);
    if (resolved) addSource(resolved);
  }

  function addSource(source: GoogleDriveBrowseItem) {
    setSelectedSources((current) => {
      if (current.some((item) => item.id === source.id)) return current;
      const visibleDescendantIds =
        currentFolder?.id === source.id ? new Set(folderItems.map((item) => item.id)) : null;
      return [...current.filter((item) => !visibleDescendantIds?.has(item.id)), source];
    });
  }

  function removeSource(sourceId: string) {
    setSelectedSources((current) => current.filter((source) => source.id !== sourceId));
  }

  function toggleSource(source: GoogleDriveBrowseItem) {
    if (selectedSources.some((item) => item.id === source.id)) {
      removeSource(source.id);
      return;
    }
    addSource(source);
  }

  const currentFolderIncludedByAncestor = crumbs
    .slice(0, -1)
    .some((crumb) => selectedSources.some((source) => source.id === crumb.id));
  const childFoldersIncludedByAncestor =
    currentFolderIncludedByAncestor ||
    (currentFolder ? selectedSources.some((source) => source.id === currentFolder.id) : false);

  async function saveSelection() {
    if (!canWrite) return;
    setBusy(true);
    try {
      const updated = await saveGoogleDriveSources(workspaceId, connection.id, {
        sources: selectedSources,
        authorityKind,
        syncCadence,
        syncEnabled,
        readPolicy,
      });
      onConnectionUpdated(updated);
      onClose();
      toast.success("Google Drive folders saved", {
        description: syncEnabled
          ? `${selectedSources.length} location${selectedSources.length === 1 ? "" : "s"} enabled. Manage cadence and pause state in Schedules.`
          : `${selectedSources.length} location${selectedSources.length === 1 ? "" : "s"} selected. Synchronization remains disabled.`,
      });
    } catch (error) {
      toast.error("Google Drive sync could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      await onLoadFailed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogContent className="max-h-[90vh] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden">
      <DialogHeader>
        <DialogTitle>Connect Google Drive folders</DialogTitle>
        <DialogDescription>
          Choose one or more locations. Subfolders are included automatically.
        </DialogDescription>
      </DialogHeader>

      <div className="grid min-h-0 gap-3 overflow-y-auto pr-1">
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-fg">Connected locations</span>
            <span className="text-fg-subtle">{selectedSources.length}</span>
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
            <div className="text-xs text-fg-subtle">No folders connected</div>
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
                  <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      aria-label={`Connect ${googleDriveBoundaryLabel(currentFolder)}`}
                      checked={
                        currentFolderIncludedByAncestor ||
                        selectedSources.some((source) => source.id === currentFolder.id)
                      }
                      disabled={currentFolderIncludedByAncestor}
                      title={
                        currentFolderIncludedByAncestor
                          ? "Included by a connected parent folder"
                          : undefined
                      }
                      onChange={() => toggleSource(currentFolder)}
                    />
                    <FolderOpenIcon className="size-4 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-fg">
                        {googleDriveBoundaryLabel(currentFolder)}
                      </div>
                      <div className="text-2xs text-fg-subtle">Everything inside</div>
                    </div>
                  </div>
                ) : null}
                {folderItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 border-b border-border/70 px-3 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      aria-label={`Connect ${item.name}`}
                      checked={
                        childFoldersIncludedByAncestor ||
                        selectedSources.some((source) => source.id === item.id)
                      }
                      disabled={childFoldersIncludedByAncestor}
                      title={
                        childFoldersIncludedByAncestor
                          ? "Included by a connected parent folder"
                          : undefined
                      }
                      onChange={() => toggleSource(item)}
                    />
                    <FolderOpenIcon className="size-4 shrink-0 text-brand" />
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-fg hover:text-brand"
                      onClick={() => openFolder(item)}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </div>
                ))}
                {currentFolder && folderItems.length === 0 ? (
                  <div className="px-3 py-5 text-center text-xs text-fg-subtle">No subfolders</div>
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
                      crumbs[crumbs.length - 1] ?? ROOT_CRUMB,
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
              if (event.key === "Enter") void addFolderId();
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

        <div className="text-2xs text-fg-subtle">{GOOGLE_DRIVE_SYNC_BEHAVIOR}</div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex items-start gap-2 rounded-md border border-border-subtle p-3 text-xs text-fg-muted sm:col-span-3">
          <input
            type="checkbox"
            checked={syncEnabled}
            onChange={(event) => setSyncEnabled(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-fg">Enable synchronization</span>
            Selection alone never starts ingestion. Once enabled, cadence and user pause are managed
            from Schedules.
          </span>
        </label>
        <label className="grid gap-1 text-xs text-fg-muted">
          Save to
          <Select
            value={authorityKind}
            onChange={(event) =>
              setAuthorityKind(event.target.value as ConnectorDocumentDestinationAuthority)
            }
          >
            <option value="personal">Only me</option>
            <option
              value="workspace"
              disabled={googleDriveDestinationOptionDisabled(
                "workspace",
                canManageWorkspaceDestination,
                canManageOrganizationDestination,
              )}
            >
              This workspace
            </option>
            <option
              value="organization"
              disabled={googleDriveDestinationOptionDisabled(
                "organization",
                canManageWorkspaceDestination,
                canManageOrganizationDestination,
              )}
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
          Interactive actions
          <Select
            value={readPolicy}
            onChange={(event) => setReadPolicy(event.target.value as GoogleDriveReadPolicy)}
          >
            <option value="allow">Allow connector actions</option>
            <option value="ask">Ask before interactive actions</option>
            <option value="block">Block connector actions</option>
          </Select>
          <span>
            Background synchronization is authorized only by Enable synchronization; this
            interactive policy does not gate scheduled runs.
          </span>
        </label>
      </div>

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={() => onClose()}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            busy || !canWrite || (selectedSources.length === 0 && savedSources.length === 0)
          }
          onClick={() => void saveSelection()}
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          Save {selectedSources.length} location{selectedSources.length === 1 ? "" : "s"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
