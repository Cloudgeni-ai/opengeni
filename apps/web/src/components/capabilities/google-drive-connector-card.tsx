import { GoogleDriveConnectionMetadata } from "@opengeni/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Loader2Icon,
  LogOutIcon,
  RefreshCwIcon,
} from "lucide-react";
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
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import type {
  ConnectionMetadata,
  GoogleDriveBrowseItem,
  GoogleDriveConnectionMetadata as GoogleDriveMetadata,
  GoogleDriveReadPolicy,
  GoogleDriveSyncCadence,
  GoogleDriveTargetScope,
} from "@/types";

const GOOGLE_DRIVE_PROVIDER_DOMAIN = "googleapis.com";

type FolderCrumb = { id: string; name: string };

export function GoogleDriveConnectorCard({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [items, setItems] = useState<GoogleDriveBrowseItem[]>([]);
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([{ id: "root", name: "My Drive" }]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<GoogleDriveBrowseItem | null>(null);
  const [selected, setSelected] = useState<GoogleDriveBrowseItem | null>(null);
  const [targetScope, setTargetScope] = useState<GoogleDriveTargetScope>("workspace");
  const [folderIdDraft, setFolderIdDraft] = useState("");
  const [syncCadence, setSyncCadence] = useState<GoogleDriveSyncCadence>("hourly");
  const [readPolicy, setReadPolicy] = useState<GoogleDriveReadPolicy>("allow");

  const connection = useMemo(
    () =>
      connections.find(
        (candidate) =>
          candidate.providerDomain === GOOGLE_DRIVE_PROVIDER_DOMAIN &&
          candidate.kind === "oauth2" &&
          candidate.status !== "revoked" &&
          candidate.subjectId !== null &&
          GoogleDriveConnectionMetadata.safeParse(candidate.metadata).success,
      ) ?? null,
    [connections],
  );
  const metadata = connection ? googleDriveMetadata(connection.metadata) : undefined;

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
      const start = await client.startGoogleDriveConnection(workspaceId, {
        ...(reconnect && connection ? { connectionId: connection.id } : {}),
      });
      window.location.assign(start.authorizationUrl);
    } catch (error) {
      toast.error("Google Drive connection could not start", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection || !canWrite) return;
    setBusy(true);
    try {
      await client.deleteConnection(workspaceId, connection.id);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setBrowseOpen(false);
      toast.success("Google Drive disconnected");
    } catch (error) {
      toast.error("Google Drive could not be disconnected", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function loadFolder(
    folder: FolderCrumb,
    mode: "replace" | "append" = "replace",
    pageToken?: string,
  ) {
    if (!connection) return;
    setBrowseBusy(true);
    try {
      const response = await client.browseGoogleDrive(workspaceId, connection.id, {
        parentId: folder.id,
        ...(pageToken ? { pageToken } : {}),
      });
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
    } catch (error) {
      toast.error("Google Drive folder could not be opened", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBrowseBusy(false);
    }
  }

  function openBrowser() {
    setCrumbs([{ id: "root", name: "My Drive" }]);
    setItems([]);
    setCurrentFolder(null);
    setSelected(null);
    setNextPageToken(null);
    setFolderIdDraft("");
    setTargetScope(metadata?.selectedSource?.targetScope ?? "workspace");
    setSyncCadence(metadata?.selectedSource?.syncCadence ?? "hourly");
    setReadPolicy(metadata?.selectedSource?.readPolicy ?? "allow");
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

  function openFolderId() {
    const id = folderIdDraft.trim();
    if (!id) return;
    const folder = { id, name: "Linked folder" };
    setCrumbs([folder]);
    void loadFolder(folder);
  }

  async function saveSelection() {
    if (!connection || !selected || !canWrite) return;
    setBusy(true);
    try {
      const updated = await client.saveGoogleDriveSource(workspaceId, connection.id, {
        source: {
          id: selected.id,
          name: selected.name,
          mimeType: selected.mimeType,
          driveId: selected.driveId,
        },
        targetScope,
        syncCadence,
        readPolicy,
      });
      setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setBrowseOpen(false);
      toast.success("Google Drive sync configured", {
        description:
          "The boundary and recurring policy are saved. Content ingestion is not running yet.",
      });
    } catch (error) {
      toast.error("Google Drive sync could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
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
                Connecting grants the approved Drive access. Nothing syncs until you explicitly
                choose and save a Shared Drive or folder boundary.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {loading ? (
              <Button type="button" variant="secondary" size="sm" disabled>
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading
              </Button>
            ) : connection ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || connection.status !== "active"}
                  onClick={openBrowser}
                >
                  <FolderOpenIcon className="size-3.5" />
                  Configure sync
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !canWrite}
                  onClick={() => void connect(true)}
                >
                  <RefreshCwIcon className="size-3.5" />
                  Reconnect
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || !canWrite}
                  onClick={() => void disconnect()}
                >
                  <LogOutIcon className="size-3.5" />
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy || !canWrite}
                onClick={() => connect()}
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
          <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <span className="text-fg-subtle">Account</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.googleDisplayName
                  ? `${metadata.googleDisplayName} · ${metadata.googleEmail}`
                  : metadata.googleEmail}
              </div>
            </div>
            <div>
              <span className="text-fg-subtle">Sync boundary</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.selectedSource
                  ? googleDriveBoundaryLabel(metadata.selectedSource)
                  : "Not configured"}
              </div>
            </div>
            <div>
              <span className="text-fg-subtle">Knowledge scope</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.selectedSource
                  ? scopeLabel(metadata.selectedSource.targetScope)
                  : "Not configured"}
              </div>
            </div>
            <div>
              <span className="text-fg-subtle">Incremental sync</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.selectedSource
                  ? `${cadenceLabel(metadata.selectedSource.syncCadence)} · ${readPolicyLabel(metadata.selectedSource.readPolicy)}`
                  : "Not configured"}
              </div>
            </div>
          </div>
        ) : null}

        <Notice tone="waiting" className="mt-3">
          This local slice saves the Drive boundary and recurring incremental-sync policy. It does
          not download documents or run the knowledge ingestion worker yet.
        </Notice>
      </section>

      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Configure Google Drive sync</DialogTitle>
            <DialogDescription>
              Browse first, then explicitly choose one Shared Drive or folder. Opening a location
              does not select it for sync.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 gap-2 overflow-y-auto pr-1">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                disabled={crumbs.length <= 1 || browseBusy}
                onClick={goBack}
              >
                <ArrowLeftIcon className="size-3.5" />
                Back
              </Button>
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-fg-muted">
                {crumbs.map((crumb, index) => (
                  <div key={crumb.id} className="flex min-w-0 items-center gap-1">
                    {index > 0 ? <ChevronRightIcon className="size-3 shrink-0" /> : null}
                    <button
                      type="button"
                      className="max-w-44 truncate rounded px-1.5 py-1 hover:bg-surface-2 hover:text-fg"
                      onClick={() => openCrumb(index)}
                    >
                      {crumb.name}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-1">
              <div className="text-2xs text-fg-subtle">
                To open a Shared Drive, paste its Google Drive link.
              </div>
              <div className="flex gap-2">
                <Input
                  value={folderIdDraft}
                  onChange={(event) => setFolderIdDraft(event.target.value)}
                  placeholder="Paste a Shared Drive or folder link"
                  className="h-8 text-xs"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openFolderId();
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!folderIdDraft.trim() || browseBusy}
                  onClick={openFolderId}
                >
                  Open
                </Button>
              </div>
            </div>

            {currentFolder ? (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-surface/45 px-3 py-2.5">
                <FolderOpenIcon className="size-4 shrink-0 text-brand" />
                <div className="min-w-0 flex-1">
                  <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                    Current location (not selected)
                  </div>
                  <div className="truncate text-sm font-medium text-fg">
                    {googleDriveBoundaryLabel(currentFolder)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={selected?.id === currentFolder.id ? "secondary" : "default"}
                  disabled={selected?.id === currentFolder.id || browseBusy}
                  onClick={() => setSelected(currentFolder)}
                >
                  {selected?.id === currentFolder.id ? "Selected" : useBoundaryLabel(currentFolder)}
                </Button>
              </div>
            ) : null}

            <div className="max-h-[26vh] min-h-28 overflow-y-auto rounded-lg border border-border">
              {browseBusy && items.length === 0 ? (
                <div className="flex h-52 items-center justify-center gap-2 text-xs text-fg-muted">
                  <Loader2Icon className="size-4 animate-spin" />
                  Loading Drive metadata
                </div>
              ) : items.length === 0 ? (
                <div className="flex h-52 items-center justify-center text-xs text-fg-muted">
                  This folder is empty.
                </div>
              ) : (
                <div className="divide-y divide-border/70">
                  {items.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 px-3 py-2">
                      {item.kind === "folder" ? (
                        <FolderIcon className="size-4 shrink-0 text-brand" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-fg-subtle" />
                      )}
                      <div
                        className="min-w-0 flex-1 truncate text-left text-xs text-fg"
                        title={item.name}
                      >
                        {item.name}
                      </div>
                      {item.kind === "folder" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => openFolder(item)}
                        >
                          Open
                        </Button>
                      ) : null}
                      {item.kind === "file" ? (
                        <span className="text-2xs text-fg-subtle">Included</span>
                      ) : null}
                    </div>
                  ))}
                </div>
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
                    {browseBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                    Load more
                  </Button>
                </div>
              ) : null}
            </div>

            <div
              className={`rounded-lg border px-3 py-2.5 text-xs ${
                selected ? "border-brand/30 bg-brand/5" : "border-border bg-surface/30"
              }`}
            >
              {selected ? (
                <>
                  <div className="font-medium text-fg">
                    Sync boundary: {googleDriveBoundaryLabel(selected)}
                  </div>
                  <div className="mt-0.5 text-fg-muted">
                    The first run imports all existing supported documents inside this boundary,
                    including nested folders. Later runs process only new, changed, moved, or
                    deleted documents since the last successful run.
                  </div>
                </>
              ) : (
                <>
                  <div className="font-medium text-fg">No sync boundary selected</div>
                  <div className="mt-0.5 text-fg-muted">
                    Browsing My Drive or a linked Shared Drive does not configure a sync.
                  </div>
                </>
              )}
              <div className="mt-1 text-fg-subtle">
                Local preview: saving stores configuration only; document ingestion is not running
                yet.
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <label className="grid gap-1 text-xs text-fg-muted">
              Knowledge scope
              <Select
                value={targetScope}
                onChange={(event) => setTargetScope(event.target.value as GoogleDriveTargetScope)}
              >
                <option value="user">Only me</option>
                <option value="workspace">This workspace</option>
                <option value="organization">Company</option>
              </Select>
            </label>
            <label className="grid gap-1 text-xs text-fg-muted">
              After the initial import
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
              Read access
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
              disabled={!selected || busy || !canWrite}
              onClick={() => void saveSelection()}
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save sync setup
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
  if (source.id === source.driveId && source.name.trim() === "Drive") return "Shared Drive";
  return source.name.trim();
}

function useBoundaryLabel(source: { id: string; driveId: string | null }): string {
  if (source.id === "root") return "Use My Drive";
  if (source.driveId === source.id) return "Use this Shared Drive";
  return "Use this folder";
}

function scopeLabel(scope: GoogleDriveTargetScope): string {
  if (scope === "user") return "Only me";
  if (scope === "organization") return "Company";
  return "Workspace";
}

function googleDriveFailureMessage(reason: string | null): string {
  if (reason === "provider_denied") return "Google access was not approved.";
  if (reason === "scope_not_granted") return "The required metadata scope was not approved.";
  if (reason === "refresh_token_missing")
    return "Google did not return offline access. Reconnect and approve the consent prompt.";
  if (reason === "account_mismatch")
    return "Reconnect must use the same Google account. Disconnect first to switch accounts.";
  if (reason === "connection_conflict") return "The connection changed. Start again.";
  return "Check the local OAuth configuration and try again.";
}

function googleDriveMetadata(value: Record<string, unknown>): GoogleDriveMetadata | undefined {
  const parsed = GoogleDriveConnectionMetadata.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
