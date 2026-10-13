import { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseIcon, DownloadIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import type {
  SiteDataCollectionResponse,
  SiteDataDescribeResponse,
  SiteDataQueryResponse,
  SiteDataRecordResponse,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { BackLink, DetailMeta } from "@/components/ui/detail-page";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { UsageMeter } from "@/components/ui/usage-meter";
import { formatBytes } from "@/lib/format";

export type SiteDataClient = Pick<
  OpenGeniBrowserClient,
  "getSiteData" | "querySiteData" | "writeSiteData" | "exportSiteData"
>;

const PAGE_SIZE = 50;
const COLLECTION_COLUMNS: RowListColumn[] = [
  { id: "records", label: "Records", width: 96, align: "end" },
  { id: "size", label: "Size", width: 96, align: "end" },
];
const RECORD_COLUMNS: RowListColumn[] = [
  { id: "updated", label: "Updated", width: 132 },
  { id: "size", label: "Size", width: 88, align: "end" },
];

/** Who can read and write a collection, in the words a Site's manager uses. */
export function siteDataAccessLabel(
  collection: Pick<SiteDataCollectionResponse, "accessMode" | "privateRecords">,
): string {
  switch (collection.accessMode) {
    case "shared":
      return "Everyone can edit";
    case "shared_read":
      return "Everyone can view";
    case "per_viewer":
      return collection.privateRecords
        ? "Each person's own, hidden from managers"
        : "Each person sees their own";
    case "append_only":
      return "Submissions";
  }
}

/** A record's one-line name: its key, else its first short text field. */
export function siteDataRecordTitle(record: Pick<SiteDataRecordResponse, "key" | "data">): string {
  if (record.key) return record.key;
  for (const value of Object.values(record.data)) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return "Untitled record";
}

function countLabel(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function percentUsed(used: number, limit: number): number {
  return limit > 0 ? (used / limit) * 100 : 0;
}

function forbidden(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 403
  );
}

/**
 * The Site page's Data tab: what the Site and its agents saved. Host-owned,
 * for the people who manage the Site; records are shown as text, never HTML.
 */
export function SiteData(props: { workspaceId: string; siteId: string; title: string }) {
  const { client, accessContext } = useAppContext();
  return (
    <SiteDataPanel
      {...props}
      client={client}
      currentPrincipal={accessContext.subjectId ? `user:${accessContext.subjectId}` : null}
    />
  );
}

export function SiteDataPanel({
  client,
  workspaceId,
  siteId,
  title,
  currentPrincipal,
}: {
  client: SiteDataClient;
  workspaceId: string;
  siteId: string;
  title: string;
  currentPrincipal: string | null;
}) {
  const [described, setDescribed] = useState<SiteDataDescribeResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [collectionName, setCollectionName] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await client.getSiteData(workspaceId, siteId, { signal: controller.signal });
      if (!controller.signal.aborted) setDescribed(next);
    } catch (nextError) {
      if (!controller.signal.aborted) setError(nextError);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [client, workspaceId, siteId]);
  useEffect(() => {
    setDescribed(null);
    setCollectionName(null);
    void load();
    return () => request.current?.abort();
  }, [load]);

  const collection =
    collectionName && described
      ? (described.collections.find((candidate) => candidate.name === collectionName) ?? null)
      : null;
  if (collection && described)
    return (
      <SiteDataCollection
        client={client}
        workspaceId={workspaceId}
        siteId={siteId}
        collection={collection}
        currentPrincipal={currentPrincipal}
        onBack={() => {
          setCollectionName(null);
          void load();
        }}
      />
    );

  return (
    <section aria-label={`Data saved by ${title}`} className="flex min-w-0 flex-col gap-6">
      {error ? (
        <Notice
          tone={forbidden(error) ? "muted" : "failed"}
          live="assertive"
          action={
            forbidden(error) ? undefined : (
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCwIcon aria-hidden="true" />
                Retry
              </Button>
            )
          }
        >
          {forbidden(error)
            ? "Only the Site's owner and workspace admins can see its data."
            : "Couldn't load this Site's data."}
        </Notice>
      ) : !described ? (
        <RowList label="Collections" busy flush>
          <ListRowSkeleton count={3} />
        </RowList>
      ) : described.collections.length === 0 && described.usage.fileCount === 0 ? (
        <EmptyState
          variant="inline"
          icon={<DatabaseIcon />}
          title="No saved data yet."
          description="Ask Opengeni to add a collection, and the Site can save records and files in it."
        />
      ) : (
        <>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <UsageMeter
              label="Records"
              measure="used"
              percent={percentUsed(described.usage.recordBytes, described.limits.recordBytesPerSite)}
              valueLabel={`${formatBytes(described.usage.recordBytes)} of ${formatBytes(described.limits.recordBytesPerSite)}`}
            />
            <UsageMeter
              label="Files"
              measure="used"
              percent={percentUsed(described.usage.fileBytes, described.limits.fileBytesPerSite)}
              valueLabel={`${formatBytes(described.usage.fileBytes)} of ${formatBytes(described.limits.fileBytesPerSite)}`}
            />
          </div>
          <RowList label="Collections" columns={COLLECTION_COLUMNS} busy={busy} flush>
            {described.collections.map((item) => (
              <ListRow
                key={item.id}
                leading={<LogoTile icon={<DatabaseIcon />} name="Collection" />}
                title={item.name}
                meta={[siteDataAccessLabel(item)]}
                cells={{
                  records: item.recordCount.toLocaleString(),
                  size: formatBytes(item.recordBytes),
                }}
                indicator="open"
                onOpen={() => setCollectionName(item.name)}
              />
            ))}
          </RowList>
        </>
      )}
    </section>
  );
}

function SiteDataCollection({
  client,
  workspaceId,
  siteId,
  collection,
  currentPrincipal,
  onBack,
}: {
  client: SiteDataClient;
  workspaceId: string;
  siteId: string;
  collection: SiteDataCollectionResponse;
  currentPrincipal: string | null;
  onBack: () => void;
}) {
  const [page, setPage] = useState<SiteDataQueryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<SiteDataRecordResponse | null>(null);
  const [exporting, setExporting] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError(false);
      try {
        const next = await client.querySiteData(
          workspaceId,
          siteId,
          {
            collection: collection.name,
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : { count: true }),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setPage((previous) =>
          cursor && previous
            ? { ...next, count: previous.count, records: [...previous.records, ...next.records] }
            : next,
        );
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [client, workspaceId, siteId, collection.name],
  );
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  const exportAs = async (format: "json" | "csv") => {
    setExporting(true);
    try {
      const exported = await client.exportSiteData(workspaceId, siteId, collection.name, {
        format,
      });
      const url = URL.createObjectURL(
        new Blob([exported.content], {
          type: format === "csv" ? "text/csv" : "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${collection.name}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      if (exported.truncated)
        toast.warning("Exported the first 10,000 records", {
          description: "Ask Opengeni to export the rest in parts.",
        });
    } catch (nextError) {
      toast.error("Couldn't export records", {
        description: nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      setExporting(false);
    }
  };

  if (open)
    return (
      <SiteDataRecordView
        client={client}
        workspaceId={workspaceId}
        siteId={siteId}
        collection={collection}
        record={open}
        currentPrincipal={currentPrincipal}
        onBack={() => setOpen(null)}
        onDeleted={() => {
          setOpen(null);
          void load();
        }}
      />
    );

  const total = page?.count ?? collection.recordCount;
  return (
    <section aria-label={`${collection.name} records`} className="flex min-w-0 flex-col gap-4">
      <div>
        <BackLink back={{ label: "Data", onClick: onBack }} />
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-base leading-6 font-semibold text-fg">
              {collection.name}
            </h2>
            <DetailMeta>
              {siteDataAccessLabel(collection)}
              {countLabel(total, "record")}
              {formatBytes(collection.recordBytes)}
            </DetailMeta>
          </div>
          <MoreMenu label={`More actions for ${collection.name}`} disabled={exporting}>
            <DropdownMenuItem onSelect={() => void exportAs("csv")}>
              <DownloadIcon />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportAs("json")}>
              <DownloadIcon />
              Export as JSON
            </DropdownMenuItem>
          </MoreMenu>
        </div>
      </div>
      {error ? (
        <Notice
          tone="failed"
          live="assertive"
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              <RefreshCwIcon aria-hidden="true" />
              Retry
            </Button>
          }
        >
          Couldn't load records.
        </Notice>
      ) : !page ? (
        <RowList label="Records" variant="table" columns={RECORD_COLUMNS} busy>
          <ListRowSkeleton count={4} />
        </RowList>
      ) : page.records.length === 0 ? (
        <EmptyState variant="inline" title="No records yet." />
      ) : (
        <RowList
          label="Records"
          variant="table"
          nameLabel="Record"
          columns={RECORD_COLUMNS}
          busy={busy}
        >
          {page.records.map((record) => (
            <ListRow
              key={record.id}
              title={siteDataRecordTitle(record)}
              cells={{
                updated: <RelativeTime date={record.updatedAt} />,
                size: formatBytes(record.sizeBytes),
              }}
              indicator="open"
              onOpen={() => setOpen(record)}
            />
          ))}
        </RowList>
      )}
      {page?.nextCursor && !error ? (
        <Button
          type="button"
          variant="outline"
          className="self-start pointer-coarse:h-11"
          disabled={busy}
          onClick={() => void load(page.nextCursor!)}
        >
          Load more records
        </Button>
      ) : null}
    </section>
  );
}

function SiteDataRecordView({
  client,
  workspaceId,
  siteId,
  collection,
  record,
  currentPrincipal,
  onBack,
  onDeleted,
}: {
  client: SiteDataClient;
  workspaceId: string;
  siteId: string;
  collection: SiteDataCollectionResponse;
  record: SiteDataRecordResponse;
  currentPrincipal: string | null;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = siteDataRecordTitle(record);
  const remove = async () => {
    await client.writeSiteData(workspaceId, siteId, {
      operations: [
        {
          op: "delete",
          collection: collection.name,
          id: record.id,
          expectedVersion: record.version,
        },
      ],
    });
    toast.success("Record deleted");
    onDeleted();
  };
  return (
    <section aria-label={name} className="flex min-w-0 flex-col gap-4">
      <div>
        <BackLink back={{ label: collection.name, onClick: onBack }} />
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-base leading-6 font-semibold text-fg">{name}</h2>
            <DetailMeta>
              <RelativeTime key="updated" date={record.updatedAt} prefix="Updated" inSentence />
              {`Version ${record.version}`}
              {formatBytes(record.sizeBytes)}
              {currentPrincipal && record.owner === currentPrincipal ? "Added by you" : null}
            </DetailMeta>
          </div>
          <RowButton onClick={() => setConfirming(true)}>
            <Trash2Icon aria-hidden="true" />
            Delete
          </RowButton>
        </div>
      </div>
      <pre
        aria-label="Record contents"
        className="m-0 max-h-[32rem] min-w-0 overflow-auto rounded-[10px] border border-border bg-surface-2 p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-fg"
      >
        {JSON.stringify(record.data, null, 2)}
      </pre>
      <DestructiveConfirm
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete “${name}”?`}
        consequences={[
          `It's removed from ${collection.name}, and the Site no longer shows it.`,
          "This can't be undone.",
        ]}
        confirmLabel="Delete record"
        pendingLabel="Deleting…"
        onConfirm={remove}
      />
    </section>
  );
}
