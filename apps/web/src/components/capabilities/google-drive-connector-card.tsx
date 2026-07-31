import { GoogleDriveConnectionMetadata } from "@opengeni/contracts";
import {
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
import { cn } from "@/lib/utils";
import type {
  ConnectionMetadata,
  GoogleDriveBrowseItem,
  GoogleDriveConnectionMetadata as GoogleDriveMetadata,
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
  const [selected, setSelected] = useState<GoogleDriveBrowseItem | null>(null);
  const [targetScope, setTargetScope] = useState<GoogleDriveTargetScope>("workspace");
  const [folderIdDraft, setFolderIdDraft] = useState("");

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
        description: "Choose a file or folder to complete the local metadata-only test.",
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
      if (mode === "replace") setSelected(null);
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
    setSelected(null);
    setNextPageToken(null);
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
      });
      setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setBrowseOpen(false);
      toast.success("Google Drive source saved", {
        description: "The connector configuration is ready. No content was ingested.",
      });
    } catch (error) {
      toast.error("Google Drive source could not be saved", {
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
                Connect an account and choose a knowledge source. This local preview can see file
                and folder metadata, but cannot download or ingest content yet.
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
                  Choose source
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
          <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-2">
            <div>
              <span className="text-fg-subtle">Account</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.googleDisplayName
                  ? `${metadata.googleDisplayName} · ${metadata.googleEmail}`
                  : metadata.googleEmail}
              </div>
            </div>
            <div>
              <span className="text-fg-subtle">Selected source</span>
              <div className="mt-0.5 truncate text-fg">
                {metadata.selectedSource
                  ? `${metadata.selectedSource.name} · ${scopeLabel(metadata.selectedSource.targetScope)}`
                  : "None yet"}
              </div>
            </div>
          </div>
        ) : null}

        <Notice tone="waiting" className="mt-3">
          Google classifies Drive-wide metadata access as a restricted OAuth scope. The local test
          is explicit about that permission and keeps tokens server-side in the encrypted connection
          vault.
        </Notice>
      </section>

      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Choose a Google Drive source</DialogTitle>
            <DialogDescription>
              This saves connector configuration only. It does not create a knowledge source or
              ingest documents.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
              {crumbs.map((crumb, index) => (
                <div key={crumb.id} className="flex items-center gap-1">
                  {index > 0 ? <ChevronRightIcon className="size-3" /> : null}
                  <button
                    type="button"
                    className="rounded px-1.5 py-1 hover:bg-surface-2 hover:text-fg"
                    onClick={() => openCrumb(index)}
                  >
                    {crumb.name}
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                value={folderIdDraft}
                onChange={(event) => setFolderIdDraft(event.target.value)}
                placeholder="Optional: paste a Google Drive folder link or folder ID"
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

            <div className="max-h-[45vh] min-h-52 overflow-y-auto rounded-lg border border-border">
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
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2",
                        selected?.id === item.id && "bg-brand/8",
                      )}
                    >
                      {item.kind === "folder" ? (
                        <FolderIcon className="size-4 shrink-0 text-brand" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-fg-subtle" />
                      )}
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-xs text-fg"
                        onClick={() => setSelected(item)}
                        title={item.name}
                      >
                        {item.name}
                      </button>
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
                      <Button
                        type="button"
                        variant={selected?.id === item.id ? "secondary" : "ghost"}
                        size="sm"
                        className="h-7"
                        onClick={() => setSelected(item)}
                      >
                        {selected?.id === item.id ? "Selected" : "Select"}
                      </Button>
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

            <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-end">
              <div className="min-w-0">
                <div className="text-xs text-fg-subtle">Selected</div>
                <div className="mt-0.5 truncate text-sm text-fg">
                  {selected?.name ?? "Choose a file or folder above"}
                </div>
              </div>
              <label className="grid gap-1 text-xs text-fg-muted">
                Knowledge scope after ingestion exists
                <Select
                  value={targetScope}
                  onChange={(event) => setTargetScope(event.target.value as GoogleDriveTargetScope)}
                >
                  <option value="user">Only me</option>
                  <option value="workspace">This workspace</option>
                  <option value="organization">Company</option>
                </Select>
              </label>
            </div>
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
              Save source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
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
