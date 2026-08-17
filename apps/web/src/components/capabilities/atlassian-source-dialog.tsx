import { BookOpenIcon, Loader2Icon, PanelsTopLeftIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { request as apiRequest } from "@/api";
import { saveAtlassianSources } from "@/components/capabilities/atlassian-sources";
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
  AtlassianBrowseItem,
  AtlassianBrowseResponse,
  AtlassianConnectionMetadata,
  AtlassianSyncCadence,
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
} from "@/types";

/**
 * The Jira and Confluence source picker. Opened from the integration sheet's
 * Access block; owns its own browsing state and starts fresh every time it opens.
 */
export function AtlassianSourceDialog({
  workspaceId,
  connection,
  metadata,
  open,
  readOnly,
  canWrite,
  canManageWorkspace,
  canManageOrganization,
  onOpenChange,
  onConnectionUpdated,
  onSaveFailed,
}: {
  workspaceId: string;
  connection: ConnectionMetadata | null;
  metadata: AtlassianConnectionMetadata | null;
  open: boolean;
  readOnly: boolean;
  canWrite: boolean;
  canManageWorkspace: boolean;
  canManageOrganization: boolean;
  onOpenChange: (open: boolean) => void;
  onConnectionUpdated: (connection: ConnectionMetadata) => void;
  onSaveFailed: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && connection && metadata ? (
        <AtlassianSourceDialogBody
          workspaceId={workspaceId}
          connection={connection}
          metadata={metadata}
          readOnly={readOnly}
          canWrite={canWrite}
          canManageWorkspace={canManageWorkspace}
          canManageOrganization={canManageOrganization}
          onClose={() => onOpenChange(false)}
          onConnectionUpdated={onConnectionUpdated}
          onSaveFailed={onSaveFailed}
        />
      ) : null}
    </Dialog>
  );
}

function AtlassianSourceDialogBody({
  workspaceId,
  connection,
  metadata,
  readOnly,
  canWrite,
  canManageWorkspace,
  canManageOrganization,
  onClose,
  onConnectionUpdated,
  onSaveFailed,
}: {
  workspaceId: string;
  connection: ConnectionMetadata;
  metadata: AtlassianConnectionMetadata;
  readOnly: boolean;
  canWrite: boolean;
  canManageWorkspace: boolean;
  canManageOrganization: boolean;
  onClose: () => void;
  onConnectionUpdated: (connection: ConnectionMetadata) => void;
  onSaveFailed: () => void | Promise<void>;
}) {
  const selectedSources = metadata.selectedSources ?? [];
  const [busy, setBusy] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [items, setItems] = useState<AtlassianBrowseItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(selectedSources.map((source) => source.id)),
  );
  const [query, setQuery] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(selectedSources[0]?.syncEnabled ?? false);
  const [syncCadence, setSyncCadence] = useState<AtlassianSyncCadence>(
    selectedSources[0]?.syncCadence ?? "hourly",
  );
  const [authorityKind, setAuthorityKind] = useState<ConnectorDocumentDestinationAuthority>(
    metadata.documentDestination?.authorityKind ??
      selectedSources[0]?.destination?.authorityKind ??
      "workspace",
  );

  useEffect(() => {
    let cancelled = false;
    if (readOnly) {
      setItems(previewItems());
      return;
    }
    setBrowseBusy(true);
    void (async () => {
      try {
        const response = await apiRequest<AtlassianBrowseResponse>(
          `/v1/workspaces/${workspaceId}/connections/atlassian/${connection.id}/browse`,
        );
        if (cancelled) return;
        setItems(response.items);
        onConnectionUpdated(response.connection);
      } catch (error) {
        if (cancelled) return;
        toast.error("Atlassian sources could not be loaded", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!cancelled) setBrowseBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, readOnly, workspaceId]);

  async function save() {
    if (!canWrite || readOnly) return;
    const sources = items.filter((item) => selectedIds.has(item.id));
    setBusy(true);
    try {
      const updated = await saveAtlassianSources(workspaceId, connection.id, {
        sources,
        authorityKind,
        syncCadence,
        syncEnabled,
      });
      onConnectionUpdated(updated);
      onClose();
      toast.success("Atlassian sources saved", {
        description: syncEnabled
          ? "Agents can read them live and the knowledge sync is enabled."
          : "Agents can read them live. Knowledge sync remains off.",
      });
    } catch (error) {
      toast.error("Atlassian sources could not be saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      await onSaveFailed();
    } finally {
      setBusy(false);
    }
  }

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
        <Button variant="secondary" onClick={() => onClose()}>
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
  );
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
