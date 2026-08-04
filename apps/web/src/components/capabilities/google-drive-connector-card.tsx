import { FolderOpenIcon, HardDriveIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { request as apiRequest } from "@/api";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import {
  googleDriveAccountState,
  googleDriveConnectionMetadata,
  googleDriveDisconnectAttempt,
  preferredGoogleDriveConnection,
  type GoogleDriveAccountState,
  type GoogleDriveDisconnectAttempt,
} from "@/lib/google-drive-connection";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import type {
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
  GoogleDriveBrowseItem,
  GoogleDriveBrowseResponse,
  GoogleDriveConnectionMetadata as GoogleDriveMetadata,
  GoogleDriveLifecycleActionRequest,
  GoogleDriveOAuthStartResponse,
  GoogleDriveReadPolicy,
  GoogleDriveSyncCadence,
} from "@/types";

type FolderCrumb = { id: string; name: string };
type ConfiguredGoogleDriveSource = GoogleDriveBrowseItem & {
  authorityKind: ConnectorDocumentDestinationAuthority;
  syncCadence: GoogleDriveSyncCadence;
  readPolicy: GoogleDriveReadPolicy;
};

export function GoogleDriveConnectorCard({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const workspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManageWorkspaceDestination = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const canManageOrganizationDestination = Boolean(
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<GoogleDriveDisconnectAttempt | null>(
    null,
  );
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

  const connection = useMemo(() => preferredGoogleDriveConnection(connections), [connections]);
  const accountState = googleDriveAccountState(connection, !loading);
  const metadata = connection
    ? (googleDriveConnectionMetadata(connection.metadata) ?? undefined)
    : undefined;
  const stateNotice = googleDriveStateNotice(accountState.state);
  const savedSources = configuredGoogleDriveSources(metadata);
  const savedDefaults = savedSources[0];
  const folderItems = items.filter((item) => item.kind === "folder");

  const refreshConnections = useCallback(async () => {
    if (!canRead) {
      setConnections([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setConnections(await client.listConnections(workspaceId));
    } catch (error) {
      toast.error("Google Drive connection could not be loaded", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [canRead, client, workspaceId]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("google_drive");
    if (!status) return;
    if (status === "connected") {
      toast.success("Google Drive connected", {
        description: "Choose a Shared Drive or folder boundary and configure incremental sync.",
      });
      void refreshConnections();
    } else {
      toast.error("Google Drive connection failed", {
        description: googleDriveFailureMessage(url.searchParams.get("reason")),
      });
    }
    url.searchParams.delete("google_drive");
    url.searchParams.delete("connectionId");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [refreshConnections]);

  async function connect(reconnect = false) {
    if (!canWrite) return;
    setBusy(true);
    try {
      const start = await apiRequest<GoogleDriveOAuthStartResponse>(
        `/v1/workspaces/${workspaceId}/connections/google-drive/install`,
        {
          method: "POST",
          body: JSON.stringify(reconnect && connection ? { connectionId: connection.id } : {}),
        },
      );
      window.location.assign(start.authorizationUrl);
    } catch (error) {
      toast.error("Google Drive connection could not start", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  async function transitionLifecycle(
    action: GoogleDriveLifecycleActionRequest["action"],
  ): Promise<void> {
    if (!connection || !canWrite) return;
    setBusy(true);
    try {
      const updated = await client.transitionGoogleDriveLifecycle(workspaceId, connection.id, {
        action,
        expectedVersion: connection.version,
      });
      setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setBrowseOpen(false);
      toast.success(action === "pause" ? "Google Drive paused" : "Google Drive resumed");
    } catch (error) {
      toast.error(
        action === "pause" ? "Google Drive could not be paused" : "Google Drive could not resume",
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
      await refreshConnections();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!connection || !canWrite) return true;
    setBusy(true);
    try {
      const attempt = googleDriveDisconnectAttempt(connection, pendingDisconnect);
      setPendingDisconnect(attempt);
      const revoked = await client.disconnectGoogleDriveConnection(workspaceId, connection.id, {
        expectedVersion: attempt.expectedVersion,
        idempotencyKey: attempt.idempotencyKey,
      });
      setConnections((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
      setPendingDisconnect(null);
      setBrowseOpen(false);
      toast.success("Google Drive disconnected");
      return true;
    } catch (error) {
      toast.error("Google Drive could not be disconnected", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function loadFolder(
    folder: FolderCrumb,
    mode: "replace" | "append" = "replace",
    pageToken?: string,
  ): Promise<GoogleDriveBrowseItem | null> {
    if (!connection) return null;
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
      setConnections((current) =>
        current.map((item) => (item.id === response.connection.id ? response.connection : item)),
      );
      return response.current;
    } catch (error) {
      toast.error("Google Drive folder could not be opened", {
        description: error instanceof Error ? error.message : String(error),
      });
      await refreshConnections();
      return null;
    } finally {
      setBrowseBusy(false);
    }
  }

  function openBrowser() {
    setCrumbs([{ id: "root", name: "My Drive" }]);
    setItems([]);
    setCurrentFolder(null);
    setSelectedSources(configuredGoogleDriveSources(metadata));
    setNextPageToken(null);
    setFolderIdDraft("");
    const existingSource = configuredGoogleDriveSources(metadata)[0];
    setAuthorityKind(
      metadata?.documentDestination?.authorityKind ?? existingSource?.authorityKind ?? "workspace",
    );
    setSyncCadence(existingSource?.syncCadence ?? "hourly");
    setReadPolicy(existingSource?.readPolicy ?? "allow");
    setBrowseOpen(true);
    void loadFolder({ id: "root", name: "My Drive" });
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
    if (!connection || !canWrite) return;
    setBusy(true);
    try {
      const { connection: updated } = await apiRequest<{ connection: ConnectionMetadata }>(
        `/v1/workspaces/${workspaceId}/connections/google-drive/${connection.id}/source`,
        {
          method: "POST",
          body: JSON.stringify({
            sources: selectedSources.map((selected) => ({
              id: selected.id,
              name: selected.name,
              mimeType: selected.mimeType,
              driveId: selected.driveId,
            })),
            destination: { authorityKind, collectionId: null },
            syncCadence,
            readPolicy,
          }),
        },
      );
      setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setBrowseOpen(false);
      toast.success("Google Drive folders saved", {
        description: `${selectedSources.length} location${selectedSources.length === 1 ? "" : "s"} connected. Document ingestion is not running yet.`,
      });
    } catch (error) {
      toast.error("Google Drive sync could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      await refreshConnections();
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) {
    return null;
  }

  return (
    <>
      <section className="mt-5 rounded-lg border border-border bg-surface/35 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <HardDriveIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">Google Drive</div>
              <p className="mt-0.5 text-xs leading-5 text-fg-muted">
                Connect folders and Shared Drives for recurring knowledge import.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {loading ? (
              <Button type="button" variant="secondary" size="sm" disabled>
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading
              </Button>
            ) : connection && accountState.state !== "disconnected" ? (
              <>
                {accountState.state === "connected" ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !canWrite}
                      onClick={openBrowser}
                    >
                      <FolderOpenIcon className="size-3.5" />
                      {savedSources.length > 0 ? "Manage folders" : "Connect folders"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy || !canWrite}
                      onClick={() => void transitionLifecycle("pause")}
                    >
                      Pause
                    </Button>
                  </>
                ) : null}
                {accountState.state === "paused" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !canWrite}
                    onClick={() => void transitionLifecycle("resume")}
                  >
                    Resume
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !canWrite}
                  onClick={() => void connect(true)}
                >
                  {accountState.state === "reconsent_required"
                    ? "Re-consent"
                    : accountState.state === "app_removed"
                      ? "Retry reconnect"
                      : "Reconnect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !canWrite}
                  onClick={() => setDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy || !canWrite}
                onClick={() => void connect()}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <HardDriveIcon className="size-3.5" />
                )}
                Connect Google Drive
              </Button>
            )}
          </div>
        </div>

        {connection && metadata ? (
          <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-3">
            <div>
              <span className="text-fg-subtle">Account</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.googleDisplayName
                  ? `${metadata.googleDisplayName} · ${metadata.googleEmail}`
                  : metadata.googleEmail}
              </div>
            </div>
            <div>
              <span className="text-fg-subtle">Connected locations</span>
              <div className="mt-0.5 truncate text-fg">
                {savedSources.length > 0
                  ? savedSources.map(googleDriveBoundaryLabel).join(", ")
                  : "None"}
              </div>
            </div>
            <div>
              <span className="text-fg-subtle">Import defaults</span>
              <div className="mt-0.5 truncate text-fg">
                {savedDefaults
                  ? `${scopeLabel(savedDefaults.authorityKind)} · ${cadenceLabel(
                      savedDefaults.syncCadence,
                    )} · ${readPolicyLabel(savedDefaults.readPolicy)}`
                  : "Not configured"}
              </div>
            </div>
          </div>
        ) : null}

        <Notice tone={stateNotice.tone} title={stateNotice.title} className="mt-3">
          {stateNotice.description}
        </Notice>
      </section>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Google Drive?"
        description="OpenGeni will stop using this local connection. Google may still list the OAuth grant because disconnecting here does not revoke every grant for the Google OAuth project."
        confirmLabel="Disconnect Google Drive"
        cancelAutoFocus
        onConfirm={disconnect}
      />

      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
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
                          crumbs[crumbs.length - 1] ?? { id: "root", name: "My Drive" },
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

            <div className="text-2xs text-fg-subtle">
              First import: existing files. Later imports: changes only.
            </div>
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
            <Button type="button" variant="secondary" onClick={() => setBrowseOpen(false)}>
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
      </Dialog>
    </>
  );
}

function cadenceLabel(cadence: GoogleDriveSyncCadence): string {
  if (cadence === "manual") return "On demand";
  if (cadence === "daily") return "Daily";
  return "Hourly";
}

function readPolicyLabel(policy: GoogleDriveReadPolicy): string {
  if (policy === "ask") return "Ask";
  if (policy === "block") return "Blocked";
  return "Automatic";
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

export function configuredGoogleDriveSources(
  metadata: GoogleDriveMetadata | undefined,
): ConfiguredGoogleDriveSource[] {
  const sources =
    metadata?.selectedSources ?? (metadata?.selectedSource ? [metadata.selectedSource] : []);
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    mimeType: source.mimeType,
    kind: "folder",
    driveId: source.driveId,
    modifiedTime: null,
    size: null,
    webViewLink: null,
    authorityKind:
      source.destination?.authorityKind ??
      metadata?.documentDestination?.authorityKind ??
      "workspace",
    syncCadence: source.syncCadence,
    readPolicy: source.readPolicy,
  }));
}

export function googleDriveDestinationOptionDisabled(
  authorityKind: ConnectorDocumentDestinationAuthority,
  canManageWorkspaceDestination: boolean,
  canManageOrganizationDestination: boolean,
): boolean {
  if (authorityKind === "organization") return !canManageOrganizationDestination;
  if (authorityKind === "workspace") return !canManageWorkspaceDestination;
  return false;
}

function scopeLabel(scope: ConnectorDocumentDestinationAuthority): string {
  if (scope === "personal") return "Only me";
  if (scope === "organization") return "Company";
  return "Workspace";
}

function googleDriveFailureMessage(reason: string | null): string {
  if (reason === "provider_denied") return "Google access was not approved.";
  if (reason === "scope_not_granted") return "Google Drive read access was not approved.";
  if (reason === "refresh_token_missing")
    return "Google did not return offline access. Reconnect and approve the consent prompt.";
  if (reason === "account_mismatch")
    return "Reconnect must use the same Google account. Disconnect first to switch accounts.";
  if (reason === "connection_conflict") return "The connection changed. Start again.";
  return "Check the local OAuth configuration and try again.";
}

function googleDriveStateNotice(state: GoogleDriveAccountState["state"]): {
  tone: NoticeTone;
  title: string;
  description: string;
} {
  if (state === "paused") {
    return {
      tone: "waiting",
      title: "Google Drive is paused",
      description:
        "OpenGeni will not browse or use configured Drive locations until you resume this connection.",
    };
  }
  if (state === "token_revoked") {
    return {
      tone: "failed",
      title: "Google no longer accepts this grant",
      description: "Reconnect with the same Google account to continue using configured locations.",
    };
  }
  if (state === "app_removed") {
    return {
      tone: "failed",
      title: "The Google OAuth app is unavailable",
      description: "Ask an administrator to restore the app, then retry reconnecting.",
    };
  }
  if (state === "reconnect_required") {
    return {
      tone: "failed",
      title: "Google Drive must be reconnected",
      description:
        "Reconnect with the same Google account to restore access to configured locations.",
    };
  }
  if (state === "reconsent_required") {
    return {
      tone: "waiting",
      title: "Google Drive needs permission re-consent",
      description:
        "Reconnect with the same Google account and approve the requested read access for configured locations.",
    };
  }
  if (state === "disconnected") {
    return {
      tone: "muted",
      title: "Google Drive is disconnected",
      description:
        "OpenGeni will not use this local connection. You can connect a different Google account; Google may still list the prior project-wide OAuth grant.",
    };
  }
  if (state === "connected") {
    return {
      tone: "info",
      title: "Google Drive is connected",
      description: "Folder setup works locally; document import is not built yet.",
    };
  }
  return {
    tone: "waiting",
    title: "Google Drive is not connected",
    description: "Connect an account to select folders and Shared Drives.",
  };
}
