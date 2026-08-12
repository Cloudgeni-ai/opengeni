import { BookOpenIcon, Loader2Icon, PanelsTopLeftIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { request as apiRequest } from "@/api";
import { Button } from "@/components/ui/button";
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
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import {
  ATLASSIAN_APP_DESCRIPTION,
  atlassianConnectionMetadata,
  atlassianStatus,
  localConnectedAtlassianPreview,
  preferredAtlassianConnection,
} from "@/lib/atlassian-connection";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import type {
  AtlassianBrowseItem,
  AtlassianBrowseResponse,
  AtlassianSyncCadence,
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
} from "@/types";

export function AtlassianConnectorCard({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const canWrite = hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
  const canManageWorkspace = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const workspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManageOrganization = Boolean(
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [items, setItems] = useState<AtlassianBrowseItem[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncCadence, setSyncCadence] = useState<AtlassianSyncCadence>("hourly");
  const [authorityKind, setAuthorityKind] =
    useState<ConnectorDocumentDestinationAuthority>("workspace");

  const preview = useMemo(
    () => localConnectedAtlassianPreview(window.location.search, workspaceId),
    [workspaceId],
  );
  const connection = useMemo(
    () => preview ?? preferredAtlassianConnection(connections),
    [connections, preview],
  );
  const metadata = connection ? atlassianConnectionMetadata(connection.metadata) : null;
  const status = atlassianStatus(connection, loaded || preview !== null);
  const readOnly = preview !== null;
  const selectedSources = metadata?.selectedSources ?? [];

  const refresh = useCallback(async () => {
    if (!canRead) return;
    try {
      setConnections(await context.client.listConnections(workspaceId));
    } catch (error) {
      toast.error("Atlassian connection could not be loaded", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoaded(true);
    }
  }, [canRead, context.client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("atlassian");
    if (!result) return;
    if (result === "connected") {
      toast.success("Atlassian connected", {
        description: "Choose the Jira projects and Confluence spaces agents may use.",
      });
      void refresh();
    } else {
      toast.error("Atlassian connection failed", {
        description: failureMessage(url.searchParams.get("reason")),
      });
    }
    url.searchParams.delete("atlassian");
    url.searchParams.delete("connectionId");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [refresh]);

  async function connect(reconnect = false) {
    if (!canWrite) return;
    setBusy(true);
    try {
      const start = await apiRequest<{ authorizationUrl: string }>(
        `/v1/workspaces/${workspaceId}/connections/atlassian/install`,
        {
          method: "POST",
          body: JSON.stringify(reconnect && connection ? { connectionId: connection.id } : {}),
        },
      );
      window.location.assign(start.authorizationUrl);
    } catch (error) {
      toast.error("Atlassian connection could not start", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  async function openSources() {
    if (!connection || !metadata) return;
    setSelectedIds(new Set(selectedSources.map((source) => source.id)));
    setSyncEnabled(selectedSources[0]?.syncEnabled ?? false);
    setSyncCadence(selectedSources[0]?.syncCadence ?? "hourly");
    setAuthorityKind(
      metadata.documentDestination?.authorityKind ??
        selectedSources[0]?.destination?.authorityKind ??
        "workspace",
    );
    setQuery("");
    setDialogOpen(true);
    if (readOnly) {
      setItems(previewItems());
      return;
    }
    setBrowseBusy(true);
    try {
      const response = await apiRequest<AtlassianBrowseResponse>(
        `/v1/workspaces/${workspaceId}/connections/atlassian/${connection.id}/browse`,
      );
      setItems(response.items);
      setConnections((current) =>
        current.map((item) => (item.id === response.connection.id ? response.connection : item)),
      );
    } catch (error) {
      toast.error("Atlassian sources could not be loaded", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBrowseBusy(false);
    }
  }

  async function save() {
    if (!connection || !canWrite || readOnly) return;
    const sources = items.filter((item) => selectedIds.has(item.id));
    setBusy(true);
    try {
      const { connection: updated } = await apiRequest<{ connection: ConnectionMetadata }>(
        `/v1/workspaces/${workspaceId}/connections/atlassian/${connection.id}/source`,
        {
          method: "POST",
          body: JSON.stringify({
            sources: sources.map(
              ({ id, cloudId, siteName, siteUrl, resourceId, key, name, kind }) => ({
                id,
                cloudId,
                siteName,
                siteUrl,
                resourceId,
                key,
                name,
                kind,
              }),
            ),
            destination: { authorityKind, collectionId: null },
            syncCadence,
            syncEnabled,
            readPolicy: "allow",
          }),
        },
      );
      setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDialogOpen(false);
      toast.success("Atlassian sources saved", {
        description: syncEnabled
          ? "Agents can read them live and the knowledge sync is enabled."
          : "Agents can read them live. Knowledge sync remains off.",
      });
    } catch (error) {
      toast.error("Atlassian sources could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!connection || !canWrite || readOnly) return true;
    setBusy(true);
    try {
      const { connection: updated } = await apiRequest<{ connection: ConnectionMetadata }>(
        `/v1/workspaces/${workspaceId}/connections/${connection.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expectedVersion: connection.version,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      setConnections((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.success("Atlassian disconnected");
      return true;
    } catch (error) {
      toast.error("Atlassian could not be disconnected", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = items.filter((item) =>
    normalizedQuery
      ? [item.name, item.key, item.siteName].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        )
      : true,
  );
  const sites = [...new Set(visibleItems.map((item) => item.siteName))];

  return (
    <>
      <section className="mt-12 rounded-lg border border-border bg-surface/35 p-4">
        <div className="flex items-center gap-3">
          <AtlassianMark />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Jira & Confluence</div>
            <p className="mt-0.5 text-xs leading-5 text-fg-muted">{ATLASSIAN_APP_DESCRIPTION}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {status === "loading" ? (
              <Button variant="secondary" size="sm" disabled>
                <Loader2Icon className="size-3.5 animate-spin" /> Loading
              </Button>
            ) : status === "connected" || status === "paused" ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => void openSources()}>
                  Manage sources
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || readOnly}
                  onClick={() => setDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={busy || !canWrite}
                onClick={() => void connect(status === "needs_attention")}
              >
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {status === "needs_attention" ? "Reconnect" : "Connect"}
              </Button>
            )}
          </div>
        </div>
        {metadata ? (
          <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-3">
            <Summary label="Account" value={metadata.email ?? metadata.displayName} />
            <Summary label="Sites" value={metadata.sites.map((site) => site.name).join(", ")} />
            <Summary
              label="Sources"
              value={
                selectedSources.length > 0
                  ? `${selectedSources.length} selected · live access on${selectedSources.some((source) => source.syncEnabled) ? " · sync on" : ""}`
                  : "None selected"
              }
            />
          </div>
        ) : null}
      </section>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Atlassian?"
        description="Agents will lose live Jira and Confluence access, and synchronization will stop. Already imported knowledge remains available."
        confirmLabel="Disconnect Atlassian"
        cancelAutoFocus
        onConfirm={disconnect}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Choose Jira & Confluence sources</DialogTitle>
            <DialogDescription>
              Agents can search and open selected sources live. Synchronization is optional.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 gap-3 overflow-y-auto pr-1">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a project or space"
                className="h-8 pl-8 text-xs"
              />
            </div>
            {browseBusy ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-xs text-fg-muted">
                <Loader2Icon className="size-4 animate-spin" /> Loading sources
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {sites.map((site) => (
                  <div key={site}>
                    <div className="border-b border-border bg-surface/50 px-3 py-2 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                      {site}
                    </div>
                    {visibleItems
                      .filter((item) => item.siteName === site)
                      .map((item) => (
                        <label
                          key={item.id}
                          className="flex cursor-pointer items-center gap-3 border-b border-border/70 px-3 py-2.5 last:border-b-0 hover:bg-surface/40"
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-brand"
                            checked={selectedIds.has(item.id)}
                            onChange={() =>
                              setSelectedIds((current) => {
                                const next = new Set(current);
                                if (next.has(item.id)) next.delete(item.id);
                                else next.add(item.id);
                                return next;
                              })
                            }
                          />
                          {item.kind === "jira_project" ? (
                            <PanelsTopLeftIcon className="size-4 shrink-0 text-blue-500" />
                          ) : (
                            <BookOpenIcon className="size-4 shrink-0 text-blue-500" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-fg">
                              {item.name}
                            </span>
                            <span className="block text-2xs text-fg-subtle">
                              {item.kind === "jira_project" ? "Jira project" : "Confluence space"} ·{" "}
                              {item.key}
                            </span>
                          </span>
                        </label>
                      ))}
                  </div>
                ))}
                {visibleItems.length === 0 ? (
                  <div className="px-3 py-8 text-center text-xs text-fg-subtle">
                    No matching sources
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 text-xs text-fg-muted sm:col-span-2">
              <input
                type="checkbox"
                checked={syncEnabled}
                onChange={(event) => setSyncEnabled(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium text-fg">Add to the knowledge base</span>
                Keep selected issues and pages indexed for fast retrieval. Live reading works either
                way.
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
                <option value="workspace" disabled={!canManageWorkspace}>
                  This workspace
                </option>
                <option value="organization" disabled={!canManageOrganization}>
                  Company
                </option>
              </Select>
            </label>
            <label className="grid gap-1 text-xs text-fg-muted">
              Refresh
              <Select
                value={syncCadence}
                disabled={!syncEnabled}
                onChange={(event) => setSyncCadence(event.target.value as AtlassianSyncCadence)}
              >
                <option value="hourly">Every hour</option>
                <option value="daily">Every day</option>
                <option value="manual">Only when triggered</option>
              </Select>
            </label>
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || browseBusy || selectedIds.size === 0 || readOnly}
              onClick={() => void save()}
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save {selectedIds.size} source{selectedIds.size === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AtlassianMark() {
  return (
    <span
      className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg text-sm font-semibold text-blue-600"
      aria-hidden="true"
    >
      A
    </span>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-fg-subtle">{label}</span>
      <div className="mt-0.5 truncate text-fg">{value}</div>
    </div>
  );
}

function failureMessage(reason: string | null): string {
  if (reason === "provider_denied") return "Atlassian access was not approved.";
  if (reason === "scope_not_granted") return "The required read permissions were not approved.";
  if (reason === "no_accessible_sites")
    return "This account has no accessible Jira or Confluence sites.";
  if (reason === "account_mismatch") return "Reconnect with the same Atlassian account.";
  if (reason === "refresh_token_missing")
    return "Offline access was not granted. Try connecting again.";
  return "Check the Atlassian OAuth configuration and try again.";
}

function previewItems(): AtlassianBrowseItem[] {
  return [
    {
      id: "jira_project:preview-cloud:10000",
      cloudId: "preview-cloud",
      siteName: "OpenGeni Integration Lab",
      siteUrl: "https://opengeni-lab.atlassian.net",
      resourceId: "10000",
      key: "KAN",
      name: "OpenGeni Product Lab",
      kind: "jira_project",
      description: null,
      webUrl: "https://opengeni-lab.atlassian.net/jira/software/c/projects/KAN",
    },
    {
      id: "confluence_space:preview-cloud:20000",
      cloudId: "preview-cloud",
      siteName: "OpenGeni Integration Lab",
      siteUrl: "https://opengeni-lab.atlassian.net",
      resourceId: "20000",
      key: "SD",
      name: "Software development",
      kind: "confluence_space",
      description: null,
      webUrl: "https://opengeni-lab.atlassian.net/wiki/spaces/SD",
    },
    {
      id: "confluence_space:preview-cloud:20001",
      cloudId: "preview-cloud",
      siteName: "OpenGeni Integration Lab",
      siteUrl: "https://opengeni-lab.atlassian.net",
      resourceId: "20001",
      key: "CA",
      name: "Customer Alpha",
      kind: "confluence_space",
      description: null,
      webUrl: "https://opengeni-lab.atlassian.net/wiki/spaces/CA",
    },
  ];
}
