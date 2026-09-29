import type {
  KnowledgeEntryContent,
  KnowledgeEntryKind,
  KnowledgeEntryRecord,
  KnowledgeEntryScope,
  KnowledgeEntrySummary,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Building2Icon,
  CalendarIcon,
  FileTextIcon,
  FolderIcon,
  LinkIcon,
  LockIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  QuoteIcon,
  Share2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { InAppHelpLink } from "@/components/in-app-help-link";
import { HelpLink } from "@/components/ui/inline-help";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { RevisionHistory, type Revision } from "@/components/ui/revision-history";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

import { errorText, useKnowledgeList } from "./knowledge-data";
import { KnowledgeEvidenceEditor } from "./knowledge-evidence-editor";
import { KnowledgeIndexNotice } from "./knowledge-index-status";
import {
  KNOWLEDGE_KIND_HELP,
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_PICKABLE_KINDS,
  KNOWLEDGE_SCOPE_LABEL,
  KNOWLEDGE_SOURCE_LABEL,
  knowledgeKindIcon,
} from "./knowledge-labels";
import {
  EntryList,
  KindTile,
  useCollectionMembers,
  type EntryRowActions,
} from "./knowledge-library";
import { KnowledgeOriginalFile } from "./knowledge-original-file";
import { MoreMenu } from "@/components/ui/page-actions";

/* ----------------------------------------------------------------------------
   One entry or collection: its own page with a back link, like a skill in
   Claude's settings. Overview and History tabs, the text in the main column
   and the facts in a quiet card. Edit and Add knowledge are form pages.
   -------------------------------------------------------------------------- */

export function externalUrl(value?: string): string | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Loads an entry for its page. A pending first revision is read from the
 * review view; a related entry whose only revision is pending is found there
 * too (for reviewers).
 */
export function useKnowledgeRecord(
  workspaceId: string,
  entryId: string,
  revisionId: string | undefined,
  canEdit: boolean,
  refresh = 0,
) {
  const { client } = useAppContext();
  const [record, setRecord] = useState<KnowledgeEntryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    setMissing(false);
    void (async () => {
      try {
        const loaded = await client.getKnowledgeEntry(workspaceId, entryId, {
          ...(revisionId ? { revisionId } : {}),
        });
        return loaded.revision.outcome === "pending"
          ? client.getKnowledgeEntry(workspaceId, loaded.id, {
              revisionId: loaded.revision.id,
              view: "needs_review",
            })
          : loaded;
      } catch (reason) {
        if (!revisionId && reason instanceof OpenGeniApiError && reason.status === 404) {
          // Archived entries are read from the archived view; reviewers can
          // also open an entry whose first revision is still pending.
          for (const view of canEdit
            ? (["archived", "needs_review"] as const)
            : (["archived"] as const)) {
            try {
              return await client.getKnowledgeEntry(workspaceId, entryId, { view });
            } catch (inner) {
              if (!(inner instanceof OpenGeniApiError) || inner.status !== 404) throw inner;
            }
          }
        }
        throw reason;
      }
    })()
      .then((value) => {
        if (current) setRecord(value);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        if (reason instanceof OpenGeniApiError && reason.status === 404) setMissing(true);
        else setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, entryId, revisionId, canEdit, refresh, retry]);
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  return { record: record?.id === entryId ? record : null, error, missing, reload };
}

/** The title of a linked entry, loaded on demand. */
function useEntryTitle(workspaceId: string, id: string, revisionId?: string) {
  const { client } = useAppContext();
  const [title, setTitle] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void client
      .getKnowledgeEntry(workspaceId, id, revisionId ? { revisionId } : {})
      .then((record) => {
        if (current) setTitle(record.revision.entry.title);
      })
      .catch(() => {
        if (current) setTitle(null);
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, id, revisionId]);
  return title;
}

function EntryLink({
  workspaceId,
  id,
  revisionId,
  onOpen,
}: {
  workspaceId: string;
  id: string;
  revisionId?: string;
  onOpen: (id: string, revisionId?: string) => void;
}) {
  const title = useEntryTitle(workspaceId, id, revisionId);
  if (title === undefined) return <Skeleton className="h-4 w-32" />;
  if (title === null) return <span className="text-fg-muted">An entry you can't open</span>;
  return (
    <HelpLink onClick={() => onOpen(id, revisionId)} className="text-left">
      {title}
    </HelpLink>
  );
}

const PATH_DEPTH = 6;

/**
 * The chain of parent collections, top first, following the first parent at
 * each level. Stops at a collection the viewer can't open, a loop, or
 * PATH_DEPTH levels.
 */
export function useCollectionPath(workspaceId: string, parentId: string) {
  const { client } = useAppContext();
  const [path, setPath] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    let current = true;
    setPath(null);
    void (async () => {
      const chain: { id: string; title: string }[] = [];
      let next: string | undefined = parentId;
      while (next && chain.length < PATH_DEPTH && !chain.some((part) => part.id === next)) {
        try {
          const record = await client.getKnowledgeEntry(workspaceId, next);
          chain.unshift({ id: record.id, title: record.revision.entry.title });
          next = record.revision.entry.groupIds[0];
        } catch {
          break;
        }
      }
      if (current) setPath(chain);
    })();
    return () => {
      current = false;
    };
  }, [client, workspaceId, parentId]);
  return path;
}

/** "Runbooks › Payments": every part opens that collection. */
function CollectionPath({
  workspaceId,
  parentId,
  onOpen,
}: {
  workspaceId: string;
  parentId: string;
  onOpen: (id: string) => void;
}) {
  const path = useCollectionPath(workspaceId, parentId);
  // It renders inside the page's meta line (a <p>), so only phrasing elements.
  if (path === null)
    return (
      <span
        data-slot="skeleton"
        className="inline-block h-4 w-32 animate-pulse rounded-md bg-accent align-middle"
      />
    );
  if (!path.length) return <span className="text-fg-muted">a collection you can't open</span>;
  return (
    <span
      role="navigation"
      aria-label="Collection path"
      className="inline-flex min-w-0 flex-wrap items-center"
    >
      {path.map((part, index) => (
        <span key={part.id} className="inline-flex min-w-0 items-center">
          {index > 0 ? (
            <span aria-hidden="true" className="px-1 text-fg-subtle">
              ›
            </span>
          ) : null}
          <HelpLink onClick={() => onOpen(part.id)} className="text-left">
            {part.title}
          </HelpLink>
        </span>
      ))}
    </span>
  );
}

function authorOf(
  revision: { createdBySessionId: string | null },
  scope: KnowledgeEntryScope,
): string {
  if (revision.createdBySessionId) return "Opengeni";
  return scope === "personal" ? "You" : "A teammate";
}

function summaryOf(summary: KnowledgeEntrySummary, previousTitle: string | undefined): string {
  if (summary.revision.change === "archive") return "Archived";
  if (summary.revision.restoredFromRevisionId) return "Restored an earlier version";
  if (summary.revision.number === 1 || !previousTitle) return "Created";
  if (previousTitle !== summary.revision.title) return `Renamed to ${summary.revision.title}`;
  return "Edited the text";
}

const RELATION_LABEL: Record<string, string> = {
  related_to: "Related to",
  depends_on: "Depends on",
  applies_to: "Applies to",
  conflicts_with: "Conflicts with",
  supersedes: "Replaces",
};

type EntryTab = "overview" | "history";

export interface EntryPageProps {
  workspaceId: string;
  entryId: string;
  revisionId?: string;
  canEdit: boolean;
  canWriteOrganization: boolean;
  refresh: number;
  /** The list the back link returns to. Default "Knowledge". */
  backLabel?: string;
  onBack: () => void;
  onOpenEntry: (id: string, revisionId?: string) => void;
  onEdit: (id: string) => void;
  onAddInCollection: (collectionId: string) => void;
  onOpenReview: () => void;
  onChanged: () => void;
  onArchive: (record: KnowledgeEntryRecord) => Promise<void>;
  entryLink: (id: string) => string;
  rowActions: EntryRowActions;
}

export function EntryPage(props: EntryPageProps) {
  return <EntryPageContent key={`${props.entryId}:${props.revisionId ?? ""}`} {...props} />;
}

function EntryPageContent({
  workspaceId,
  entryId,
  revisionId,
  canEdit,
  canWriteOrganization,
  refresh,
  backLabel = "Knowledge",
  onBack,
  onOpenEntry,
  onEdit,
  onAddInCollection,
  onOpenReview,
  onChanged,
  onArchive,
  entryLink,
  rowActions,
}: EntryPageProps) {
  const { client } = useAppContext();
  const [localRefresh, setLocalRefresh] = useState(0);
  const { record, error, missing, reload } = useKnowledgeRecord(
    workspaceId,
    entryId,
    revisionId,
    canEdit,
    refresh + localRefresh,
  );
  const [tab, setTab] = useState<EntryTab>("overview");
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const back = { label: backLabel, onClick: onBack };

  if (missing) {
    return (
      <DetailPage back={back}>
        <EmptyState
          variant="page"
          icon={<FileTextIcon />}
          title="This entry isn't available"
          description="It may have been removed, or it belongs to someone else's private knowledge."
          action={
            <Button type="button" variant="outline" onClick={onBack}>
              Back to Knowledge
            </Button>
          }
        />
      </DetailPage>
    );
  }
  if (error && !record) {
    return (
      <DetailPage back={back}>
        <Notice
          tone="failed"
          title="Couldn't load this entry"
          action={
            <Button type="button" size="sm" variant="outline" onClick={reload}>
              Try again
            </Button>
          }
          actionLayout="responsive"
        >
          {error}
        </Notice>
      </DetailPage>
    );
  }
  if (!record) {
    return (
      <DetailPage back={back}>
        <div aria-busy="true" aria-label="Loading entry" className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-[10px]" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          <Skeleton className="mt-6 h-24 w-full" />
        </div>
      </DetailPage>
    );
  }

  const entry = record.revision.entry;
  const pending = record.revision.outcome === "pending";
  const rejected = record.revision.outcome === "rejected";
  const historical = !pending && record.revision.id !== record.publishedRevisionId;
  const collection = entry.kind === "group";
  const writable = canEdit && (record.scope !== "organization" || canWriteOrganization);
  const editable = writable && !pending && !record.archived && !historical && !rejected;

  const restore = async (targetRevisionId: string, label: string) => {
    setBusy(true);
    try {
      const receipt = await client.restoreKnowledgeEntry(workspaceId, {
        operationId: crypto.randomUUID(),
        entryId: record.id,
        revisionId: targetRevisionId,
        expectedVersion: record.version,
      });
      // Restoring is reversible: Undo puts back what was there before.
      const wasArchived = record.archived;
      const previous = record.publishedRevisionId;
      showUndoToast({
        title: label,
        onUndo: () => {
          const undo = wasArchived
            ? client.archiveKnowledgeEntry(workspaceId, record.id, {
                operationId: crypto.randomUUID(),
                expectedVersion: receipt.version,
              })
            : previous
              ? client.restoreKnowledgeEntry(workspaceId, {
                  operationId: crypto.randomUUID(),
                  entryId: record.id,
                  revisionId: previous,
                  expectedVersion: receipt.version,
                })
              : null;
          void undo
            ?.then(() => {
              onChanged();
              setLocalRefresh((value) => value + 1);
            })
            .catch((reason: unknown) =>
              toast.error("Couldn't undo it", { description: errorText(reason) }),
            );
        },
      });
      onChanged();
      if (revisionId) onOpenEntry(record.id);
      else setLocalRefresh((value) => value + 1);
    } catch (reason) {
      toast.error("Couldn't restore it", { description: errorText(reason) });
    } finally {
      setBusy(false);
    }
  };

  const status = record.archived ? (
    <StatusBadge tone="neutral" icon={<ArchiveIcon />}>
      Archived
    </StatusBadge>
  ) : rejected ? (
    <StatusBadge tone="neutral">Rejected</StatusBadge>
  ) : pending ? (
    <StatusBadge status="pending_review" />
  ) : historical ? (
    <StatusBadge tone="neutral">Earlier version</StatusBadge>
  ) : null;

  const firstCollection = entry.groupIds[0];
  const otherCollections = entry.groupIds.length - 1;

  const aside = (
    <DetailAside label={`About ${entry.title}`}>
      <DetailAsideItem
        label="Where"
        icon={
          record.scope === "personal" ? (
            <LockIcon />
          ) : record.scope === "organization" ? (
            <Building2Icon />
          ) : (
            <FolderIcon />
          )
        }
      >
        {record.scope === "personal"
          ? "Only me"
          : record.scope === "organization"
            ? "Organization"
            : "This workspace"}
      </DetailAsideItem>
      {/* One collection is already the header's path; several are listed here. */}
      {!collection && entry.groupIds.length !== 1 ? (
        <DetailAsideItem label="Collections" icon={<FolderIcon />}>
          {entry.groupIds.length ? (
            <span className="flex min-w-0 flex-col gap-1">
              {entry.groupIds.map((id) => (
                <EntryLink key={id} workspaceId={workspaceId} id={id} onOpen={onOpenEntry} />
              ))}
            </span>
          ) : (
            <span className="text-fg-muted">None</span>
          )}
        </DetailAsideItem>
      ) : null}
      {entry.source && entry.source.kind !== "manual" ? (
        <DetailAsideItem
          label="Source"
          icon={entry.source.kind === "conversation" ? <MessageSquareIcon /> : <FileTextIcon />}
        >
          {entry.source.kind === "conversation" && entry.source.sessionId ? (
            <InAppHelpLink href={`/workspaces/${workspaceId}/sessions/${entry.source.sessionId}`}>
              Open the chat
            </InAppHelpLink>
          ) : externalUrl(entry.source.uri) ? (
            <a
              href={externalUrl(entry.source.uri)!}
              target="_blank"
              rel="noreferrer"
              className="text-brand underline-offset-2 hover:underline"
            >
              {KNOWLEDGE_SOURCE_LABEL[entry.source.kind] ?? "Original source"}
            </a>
          ) : (
            (KNOWLEDGE_SOURCE_LABEL[entry.source.kind] ?? "Connected source")
          )}
        </DetailAsideItem>
      ) : null}
      <DetailAsideItem label="Added" icon={<CalendarIcon />}>
        <RelativeTime date={record.createdAt} />
      </DetailAsideItem>
    </DetailAside>
  );

  const menu = (
    <MoreMenu label={`More actions for ${entry.title}`}>
      <DropdownMenuItem
        onSelect={() => {
          void navigator.clipboard
            ?.writeText(new URL(entryLink(record.id), window.location.origin).href)
            .then(() => toast("Copied a link to this entry"))
            .catch(() => toast.error("Couldn't copy the link"));
        }}
      >
        <LinkIcon />
        Copy link
      </DropdownMenuItem>
      {collection && editable ? (
        <DropdownMenuItem onSelect={() => onAddInCollection(record.id)}>
          <PlusIcon />
          Add knowledge here
        </DropdownMenuItem>
      ) : null}
      {canEdit && record.scope === "personal" && !collection && !record.archived && !pending ? (
        <DropdownMenuItem onSelect={() => setSharing(true)}>
          <Share2Icon />
          Share with a workspace…
        </DropdownMenuItem>
      ) : null}
      {writable && !pending && !historical && !rejected ? (
        <>
          <DropdownMenuSeparator />
          {record.archived ? (
            <DropdownMenuItem
              disabled={busy}
              onSelect={() =>
                void restore(record.revision.id, `Restored ${entry.title}. Agents use it again.`)
              }
            >
              <ArchiveRestoreIcon />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => {
                setBusy(true);
                void onArchive(record).finally(() => {
                  setBusy(false);
                  setLocalRefresh((value) => value + 1);
                });
              }}
            >
              <ArchiveIcon />
              Archive
            </DropdownMenuItem>
          )}
        </>
      ) : null}
    </MoreMenu>
  );

  return (
    <DetailPage back={back}>
      <LineTabs
        value={tab}
        onValueChange={(value) => setTab(value as EntryTab)}
        className="min-w-0"
      >
        <DetailPageHeader
          leading={knowledgeKindIcon(entry.kind) ? <KindTile kind={entry.kind} /> : null}
          title={entry.title}
          chips={
            <>
              <MetaChip variant="soft">{KNOWLEDGE_SCOPE_LABEL[record.scope]}</MetaChip>
              {status}
            </>
          }
          meta={[
            KNOWLEDGE_KIND_LABEL[entry.kind],
            firstCollection ? (
              <span key="in" className="inline-flex min-w-0 flex-wrap items-center gap-1">
                in{" "}
                <CollectionPath
                  workspaceId={workspaceId}
                  parentId={firstCollection}
                  onOpen={onOpenEntry}
                />
              </span>
            ) : null,
            // Entries list every collection in the aside; a collection says it here.
            collection && otherCollections > 0 ? (
              <span key="also">
                also in {otherCollections} other{" "}
                {otherCollections === 1 ? "collection" : "collections"}
              </span>
            ) : null,
            <span key="updated">
              updated <RelativeTime date={record.revision.createdAt} inSentence />
            </span>,
          ]}
          actions={
            <>
              {editable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(record.id)}
                  className="rounded-[10px] pointer-coarse:h-11"
                >
                  <PencilIcon aria-hidden="true" />
                  Edit
                </Button>
              ) : null}
              {menu}
            </>
          }
          tabs={
            <LineTabsList aria-label={entry.title}>
              <LineTabsTrigger value="overview">Overview</LineTabsTrigger>
              <LineTabsTrigger value="history">History</LineTabsTrigger>
            </LineTabsList>
          }
        />
        <LineTabsContent value="overview">
          <DetailPageBody aside={aside}>
            {pending ? (
              <DetailSection>
                <Notice
                  tone="waiting"
                  title="Waiting for review"
                  action={
                    <Button type="button" size="sm" onClick={onOpenReview}>
                      Open Review
                    </Button>
                  }
                  actionLayout="responsive"
                >
                  An agent proposed this. Agents don't use it until someone approves it.
                </Notice>
              </DetailSection>
            ) : record.archived || rejected ? (
              <DetailSection>
                <Notice
                  tone="muted"
                  icon={<ArchiveIcon className="size-4" />}
                  title={record.archived ? "Archived" : "Rejected"}
                  action={
                    writable ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void restore(
                            record.revision.id,
                            `Restored ${entry.title}. Agents use it again.`,
                          )
                        }
                      >
                        Restore
                      </Button>
                    ) : undefined
                  }
                  actionLayout="responsive"
                >
                  {record.archived
                    ? "Agents don't use archived knowledge. Restore it to make it available again."
                    : "This proposal was rejected. It stays in History and agents don't use it."}
                </Notice>
              </DetailSection>
            ) : historical ? (
              <DetailSection>
                <Notice
                  tone="muted"
                  title="You're looking at an earlier version"
                  action={
                    <span className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onOpenEntry(record.id)}
                      >
                        See the current version
                      </Button>
                      {writable ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void restore(record.revision.id, "Restored this version")}
                        >
                          Restore this version
                        </Button>
                      ) : null}
                    </span>
                  }
                  actionLayout="responsive"
                >
                  Agents use the current version.
                </Notice>
              </DetailSection>
            ) : null}
            {!historical && entry.kind === "source" && !pending ? (
              <DetailSection>
                <KnowledgeIndexNotice status={record.indexStatus} workspaceId={workspaceId} />
              </DetailSection>
            ) : null}
            {collection ? (
              <>
                {entry.content ? (
                  <DetailSection title="About this collection">
                    <p className="text-sm leading-6 whitespace-pre-line text-fg">{entry.content}</p>
                  </DetailSection>
                ) : null}
                <CollectionMembers
                  workspaceId={workspaceId}
                  collectionId={record.id}
                  refresh={refresh + localRefresh}
                  actions={rowActions}
                  canAdd={editable}
                  onAdd={() => onAddInCollection(record.id)}
                />
              </>
            ) : entry.kind === "source" && entry.source?.fileId ? (
              <DetailSection title="File">
                <KnowledgeOriginalFile
                  workspaceId={workspaceId}
                  entryId={record.id}
                  revisionId={record.revision.id}
                  autoOpen
                  extractedText={entry.content}
                />
              </DetailSection>
            ) : (
              <DetailSection title="What agents know">
                <p className="text-sm leading-6 text-pretty break-words whitespace-pre-line text-fg">
                  {entry.content}
                </p>
              </DetailSection>
            )}
            {entry.evidence.length || (entry.source?.fileId && entry.kind !== "source") ? (
              <DetailSection title="Sources">
                <div className="flex min-w-0 flex-col gap-4">
                  {entry.source?.fileId && entry.kind !== "source" ? (
                    <KnowledgeOriginalFile
                      key={`${record.id}:${record.revision.id}`}
                      workspaceId={workspaceId}
                      entryId={record.id}
                      revisionId={record.revision.id}
                    />
                  ) : null}
                  {entry.evidence.map((evidence) => (
                    <div key={JSON.stringify(evidence)} className="flex min-w-0 flex-col gap-1.5">
                      {evidence.quote ? (
                        <blockquote className="flex gap-2 border-l-2 border-brand/40 pl-3 text-sm leading-6 text-fg">
                          <QuoteIcon aria-hidden="true" className="sr-only" />
                          {evidence.quote}
                        </blockquote>
                      ) : null}
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted">
                        From{" "}
                        <EntryLink
                          workspaceId={workspaceId}
                          id={evidence.entryId}
                          revisionId={evidence.revisionId}
                          onOpen={onOpenEntry}
                        />
                        {evidence.location.page ? (
                          <span>· page {evidence.location.page}</span>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              </DetailSection>
            ) : null}
            {entry.relationships.length ? (
              <DetailSection title="Related knowledge">
                <ul className="flex min-w-0 flex-col gap-2 text-sm">
                  {entry.relationships.map((relation) => (
                    <li
                      key={`${relation.entryId}:${relation.relation}`}
                      className="flex min-w-0 flex-wrap items-center gap-x-2"
                    >
                      <span className="text-fg-muted">
                        {RELATION_LABEL[relation.relation] ?? "Related to"}
                      </span>
                      <EntryLink
                        workspaceId={workspaceId}
                        id={relation.entryId}
                        onOpen={onOpenEntry}
                      />
                    </li>
                  ))}
                </ul>
              </DetailSection>
            ) : null}
          </DetailPageBody>
        </LineTabsContent>
        <LineTabsContent value="history">
          <DetailPageBody>
            <DetailSection description="Restoring saves that version again as the newest one, so you can always go back.">
              {tab === "history" ? (
                <EntryHistory
                  workspaceId={workspaceId}
                  record={record}
                  canRestore={writable && !pending}
                  onRestore={(target) =>
                    restore(target, "Restored an earlier version. Agents use it from now on.")
                  }
                />
              ) : null}
            </DetailSection>
          </DetailPageBody>
        </LineTabsContent>
      </LineTabs>
      {sharing ? (
        <ShareEntryDialog
          record={record}
          workspaceId={workspaceId}
          onClose={() => setSharing(false)}
          onShared={() => {
            setSharing(false);
            onChanged();
          }}
        />
      ) : null}
    </DetailPage>
  );
}

function CollectionMembers({
  workspaceId,
  collectionId,
  refresh,
  actions,
  canAdd,
  onAdd,
}: {
  workspaceId: string;
  collectionId: string;
  refresh: number;
  actions: EntryRowActions;
  canAdd: boolean;
  onAdd: () => void;
}) {
  const members = useCollectionMembers(workspaceId, collectionId, undefined, refresh);
  const { subCollections, entries } = members;
  const any = subCollections.length > 0 || entries.length > 0;
  return (
    <DetailSection
      title="In this collection"
      action={
        canAdd ? (
          <Button type="button" size="sm" onClick={onAdd}>
            <PlusIcon aria-hidden="true" />
            Add knowledge
          </Button>
        ) : undefined
      }
    >
      {members.loading && !any ? (
        <RowList label="In this collection" busy flush>
          <ListRowSkeleton count={2} />
        </RowList>
      ) : members.error && !any ? (
        <Notice
          tone="failed"
          title="Couldn't load the entries"
          action={
            <Button type="button" size="sm" variant="outline" onClick={members.reload}>
              Try again
            </Button>
          }
          actionLayout="responsive"
        >
          {members.error}
        </Notice>
      ) : any ? (
        <div className="flex min-w-0 flex-col gap-6">
          {subCollections.length ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              {/* Sub-collections lead as their own quiet group. */}
              <MembersLabel>Collections</MembersLabel>
              <EntryList label="Collections" entries={subCollections} actions={actions} flush />
              {members.subCursor ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-1.5 self-start"
                  disabled={members.loading}
                  onClick={() => void members.loadMoreSubs()}
                >
                  More collections
                </Button>
              ) : null}
            </div>
          ) : null}
          {entries.length || members.cursor ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              {subCollections.length ? <MembersLabel>Entries</MembersLabel> : null}
              <EntryList label="Entries" entries={entries} actions={actions} flush />
              {members.cursor ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-1.5 self-start"
                  disabled={members.loading}
                  onClick={() => void members.loadMore()}
                >
                  Load more
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          Nothing here yet. Add knowledge to it, or pick it as a collection when you edit an entry.
        </p>
      )}
    </DetailSection>
  );
}

function MembersLabel({ children }: { children: string }) {
  return <h3 className="m-0 text-xs leading-4.5 font-medium text-fg-subtle">{children}</h3>;
}

function EntryHistory({
  workspaceId,
  record,
  canRestore,
  onRestore,
}: {
  workspaceId: string;
  record: KnowledgeEntryRecord;
  canRestore: boolean;
  onRestore: (revisionId: string) => Promise<void>;
}) {
  const { client } = useAppContext();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const loaded = useRef<KnowledgeEntrySummary[]>([]);

  const toRevisions = useCallback(
    async (summaries: KnowledgeEntrySummary[]): Promise<Revision[]> => {
      const kept = summaries.filter(
        (item) => item.revision.outcome === "published" || item.revision.outcome === "superseded",
      );
      const full = await Promise.all(
        kept.map((item) =>
          client
            .getKnowledgeEntry(workspaceId, record.id, { revisionId: item.revision.id })
            .then((value) => value.revision.entry.content)
            .catch(() => item.revision.preview),
        ),
      );
      return kept.map((item, index) => ({
        id: item.revision.id,
        author: authorOf(item.revision as { createdBySessionId: string | null }, record.scope),
        createdAt: item.revision.createdAt,
        summary: summaryOf(item, kept[index + 1]?.revision.title),
        content: full[index] ?? "",
      }));
    },
    [client, workspaceId, record.id, record.scope],
  );

  useEffect(() => {
    let current = true;
    setRevisions(null);
    setError(null);
    void client
      .listKnowledgeEntryHistory(workspaceId, record.id)
      .then(async (page) => {
        loaded.current = page.entries;
        const next = await toRevisions(page.entries);
        if (!current) return;
        setRevisions(next);
        setBefore(page.beforeRevision);
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, record.id, record.version, toRevisions, retry]);

  const more = async () => {
    if (!before) return;
    setLoadingMore(true);
    try {
      const page = await client.listKnowledgeEntryHistory(workspaceId, record.id, before);
      loaded.current = [...loaded.current, ...page.entries];
      setRevisions(await toRevisions(loaded.current));
      setBefore(page.beforeRevision);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RevisionHistory
        revisions={revisions ?? []}
        loading={revisions === null && !error}
        error={
          error && !revisions
            ? {
                message: "Couldn't load the history",
                detail: error,
                onRetry: () => setRetry((n) => n + 1),
              }
            : undefined
        }
        format="text"
        label={`History of ${record.revision.entry.title}`}
        onRestore={(revision) => onRestore(revision.id)}
        restoreDisabledReason={
          canRestore
            ? undefined
            : "Only people who can manage Knowledge here can restore a version."
        }
      />
      {before ? (
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {loadingMore ? "Loading…" : "Earlier versions"}
        </Button>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Edit and Add: form pages.
   -------------------------------------------------------------------------- */

function CollectionPicker({
  workspaceId,
  scope,
  value,
  exclude,
  onChange,
  disabled,
}: {
  workspaceId: string;
  scope: KnowledgeEntryScope;
  value: string[];
  exclude?: string;
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);
  const groups = useKnowledgeList(workspaceId, {
    kind: "group",
    scope,
    limit: 50,
    ...(debounced ? { query: debounced } : {}),
  });
  const options = groups.entries.filter((group) => group.id !== exclude);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {groups.entries.length > 8 || debounced ? (
        <TextInput
          aria-label="Find a collection"
          value={query}
          placeholder="Find a collection"
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
        />
      ) : null}
      {groups.loading && !options.length ? (
        <Skeleton className="h-9 w-full" />
      ) : options.length ? (
        <ul className="flex max-h-56 min-w-0 flex-col overflow-y-auto">
          {options.map((group) => (
            <li key={group.id}>
              <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-[10px] px-2 text-sm text-fg hover:bg-surface-2 pointer-coarse:min-h-11">
                <Checkbox
                  checked={value.includes(group.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange(checked ? [...value, group.id] : value.filter((id) => id !== group.id))
                  }
                />
                <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
                <span className="min-w-0 truncate">{group.revision.title}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">
          {debounced
            ? "No collections match."
            : "No collections yet. Create one from Add › New collection."}
        </p>
      )}
    </div>
  );
}

function kindOptions(current: KnowledgeEntryKind) {
  const kinds: KnowledgeEntryKind[] =
    current === "source" || current === "group" ? [current] : [...KNOWLEDGE_PICKABLE_KINDS];
  return kinds.map((value) => ({
    value,
    label: KNOWLEDGE_KIND_LABEL[value],
    description: KNOWLEDGE_KIND_HELP[value],
  }));
}

export function EntryEditPage({
  workspaceId,
  entryId,
  canEdit,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  entryId: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client } = useAppContext();
  const { record, error, missing, reload } = useKnowledgeRecord(
    workspaceId,
    entryId,
    undefined,
    canEdit,
  );
  const [draft, setDraft] = useState<KnowledgeEntryContent | null>(null);
  const [errors, setErrors] = useState<{ title?: string; content?: string }>({});
  useEffect(() => {
    if (record && !draft) setDraft(record.revision.entry);
  }, [record, draft]);
  const original = record?.revision.entry;
  const unchanged = useMemo(
    () => Boolean(original && draft && JSON.stringify(original) === JSON.stringify(draft)),
    [original, draft],
  );
  const title = original?.title ?? "entry";
  const collection = original?.kind === "group";

  if (missing || (error && !record)) {
    return (
      <FormPage
        title={`Edit ${title}`}
        back={{ label: title, onClick: onClose }}
        onCancel={onClose}
        submitLabel="Save changes"
        submitDisabled
        error={missing ? "This entry isn't available any more." : error}
      >
        {!missing ? (
          <Button type="button" variant="outline" onClick={reload}>
            Try again
          </Button>
        ) : null}
      </FormPage>
    );
  }

  return (
    <FormPage
      title={record ? `Edit ${title}` : "Edit"}
      description="Agents use the new text from their next message. The old version stays in History."
      back={{ label: record ? title : "Back", onClick: onClose }}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      loading={!record || !draft}
      loadingFields={3}
      submitDisabled={unchanged}
      // Cancel and Save show once something changed; until then the back link is the way out.
      className={unchanged ? "[&>form>footer]:hidden" : undefined}
      onCancel={onClose}
      onSubmitted={() => {
        toast("Saved. Agents use the new text from their next message.");
        onSaved();
      }}
      onSubmit={async () => {
        if (!record || !draft) return false;
        const next = {
          title: draft.title.trim() ? undefined : "Add a title.",
          content:
            collection || draft.kind === "source" || draft.content.trim()
              ? undefined
              : "Add what agents should know.",
        };
        setErrors(next);
        if (next.title || next.content) return false;
        await client.saveKnowledgeEntry(workspaceId, {
          operationId: crypto.randomUUID(),
          entryId: record.id,
          expectedVersion: record.version,
          entry: { ...draft, title: draft.title.trim() },
        });
        return true;
      }}
    >
      {draft && record ? (
        <FieldStack>
          <Field label={collection ? "Name" : "Title"} error={errors.title}>
            <TextInput
              value={draft.title}
              maxLength={1024}
              suppressAutofill
              onChange={(event) => {
                setDraft({ ...draft, title: event.target.value });
                setErrors((current) => ({ ...current, title: undefined }));
              }}
            />
          </Field>
          <Field
            label={collection ? "Description" : "What agents should know"}
            optional={collection || draft.kind === "source"}
            hint={
              collection
                ? "What belongs in this collection."
                : "Keep it to one fact or decision. Rules for how agents work go in Instructions."
            }
            error={errors.content}
          >
            <TextArea
              rows={draft.kind === "source" ? 12 : 6}
              value={draft.content}
              onChange={(event) => {
                setDraft({ ...draft, content: event.target.value });
                setErrors((current) => ({ ...current, content: undefined }));
              }}
            />
          </Field>
          {!collection && draft.kind !== "source" ? (
            <Field label="Type" hint={KNOWLEDGE_KIND_HELP[draft.kind]}>
              <SelectMenu<KnowledgeEntryKind>
                size="md"
                options={kindOptions(draft.kind)}
                value={draft.kind}
                onValueChange={(kind) => setDraft({ ...draft, kind })}
                className="w-full max-w-60"
              />
            </Field>
          ) : null}
          <Field label="Collections" optional group>
            <CollectionPicker
              workspaceId={workspaceId}
              scope={record.scope}
              value={draft.groupIds}
              exclude={record.id}
              onChange={(groupIds) => setDraft({ ...draft, groupIds })}
            />
          </Field>
          {draft.evidence.length ? (
            <KnowledgeEvidenceEditor
              workspaceId={workspaceId}
              evidence={draft.evidence}
              disabled={false}
              onChange={(evidence) => setDraft({ ...draft, evidence })}
            />
          ) : null}
        </FieldStack>
      ) : null}
    </FormPage>
  );
}

export type AddKind = "note" | "group";

export function AddKnowledgePage({
  workspaceId,
  workspaceName,
  personal,
  canWriteOrganization,
  defaultScope,
  collectionId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  workspaceName: string;
  personal: boolean;
  canWriteOrganization: boolean;
  defaultScope: KnowledgeEntryScope;
  collectionId?: string;
  onClose: () => void;
  onCreated: (entryId: string) => void;
}) {
  const { client } = useAppContext();
  const [entryId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<KnowledgeEntryKind>("note");
  const [scope, setScope] = useState<KnowledgeEntryScope>(defaultScope);
  const [groupIds, setGroupIds] = useState<string[]>(collectionId ? [collectionId] : []);
  const [errors, setErrors] = useState<{ title?: string; content?: string }>({});
  const collectionTitle = useEntryTitleOptional(workspaceId, collectionId);
  const scopes: KnowledgeEntryScope[] = personal
    ? ["personal"]
    : ["workspace", "personal", ...(canWriteOrganization ? (["organization"] as const) : [])];

  return (
    <FormPage
      title="Add knowledge"
      description={
        collectionTitle
          ? `A fact or decision in ${collectionTitle}. Agents look it up when it's relevant.`
          : "Something agents should look up when it's relevant."
      }
      back={{ label: collectionTitle ?? "Knowledge", onClick: onClose }}
      submitLabel="Add to Library"
      pendingLabel="Adding…"
      onCancel={onClose}
      onSubmit={async () => {
        const next = {
          title: title.trim() ? undefined : "Add a title.",
          content: content.trim() ? undefined : "Add what agents should know.",
        };
        setErrors(next);
        if (next.title || next.content) return false;
        await client.saveKnowledgeEntry(workspaceId, {
          operationId: crypto.randomUUID(),
          entryId,
          expectedVersion: 0,
          scope,
          entry: {
            title: title.trim(),
            kind,
            content: content.trim(),
            evidence: [],
            relationships: [],
            groupIds,
          },
        });
        toast(`Added ${title.trim()} to the Library`);
        onCreated(entryId);
        return true;
      }}
    >
      <FieldStack>
        <Field label="Title" error={errors.title}>
          <TextInput
            value={title}
            maxLength={1024}
            placeholder="For example: Staging deploys run from the main branch"
            suppressAutofill
            onChange={(event) => {
              setTitle(event.target.value);
              setErrors((current) => ({ ...current, title: undefined }));
            }}
          />
        </Field>
        <Field
          label="What agents should know"
          hint="One fact or decision. Rules for how agents work belong in Instructions."
          error={errors.content}
        >
          <TextArea
            rows={5}
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setErrors((current) => ({ ...current, content: undefined }));
            }}
          />
        </Field>
        {scopes.length > 1 ? (
          <Field
            label="Save to"
            group
            hint={
              scope === "workspace"
                ? `Agents in ${workspaceName} can use it.`
                : scope === "organization"
                  ? "Agents in every workspace of your organization can use it."
                  : "Only your own chats can use it."
            }
          >
            <SegmentedControl<KnowledgeEntryScope>
              aria-label="Save to"
              options={scopes.map((value) => ({
                value,
                label:
                  value === "workspace"
                    ? "This workspace"
                    : value === "personal"
                      ? "Only me"
                      : "Organization",
              }))}
              value={scope}
              onValueChange={(next) => {
                setScope(next);
                if (next !== defaultScope) setGroupIds([]);
              }}
              className="self-start"
            />
          </Field>
        ) : null}
        <Field label="Type" hint={KNOWLEDGE_KIND_HELP[kind]}>
          <SelectMenu<KnowledgeEntryKind>
            size="md"
            options={kindOptions("note")}
            value={kind}
            onValueChange={setKind}
            className="w-full max-w-60"
          />
        </Field>
        <Field label="Collections" optional group>
          <CollectionPicker
            workspaceId={workspaceId}
            scope={scope}
            value={groupIds}
            onChange={setGroupIds}
          />
        </Field>
      </FieldStack>
    </FormPage>
  );
}

function useEntryTitleOptional(workspaceId: string, id: string | undefined) {
  const { client } = useAppContext();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let current = true;
    void client
      .getKnowledgeEntry(workspaceId, id)
      .then((record) => {
        if (current) setTitle(record.revision.entry.title);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, workspaceId, id]);
  return id ? title : null;
}

/** New collection: a one-field prompt. */
export function NewCollectionDialog({
  open,
  onOpenChange,
  workspaceId,
  scope,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  scope: KnowledgeEntryScope;
  onCreated: (entryId: string) => void;
}) {
  const { client } = useAppContext();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setName("");
          setError(null);
        }
      }}
      size="sm"
      title="New collection"
      description="A folder in the Library for related entries, like a customer, a system or your runbooks."
      submitLabel="Create collection"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Name the collection.");
          return false;
        }
        const entryId = crypto.randomUUID();
        await client.saveKnowledgeEntry(workspaceId, {
          operationId: crypto.randomUUID(),
          entryId,
          expectedVersion: 0,
          scope,
          entry: {
            title: trimmed,
            kind: "group",
            content: "",
            evidence: [],
            relationships: [],
            groupIds: [],
          },
        });
        toast(`Created the ${trimmed} collection`);
        setName("");
        onCreated(entryId);
        return true;
      }}
    >
      <Field label="Name" error={error ?? undefined}>
        <TextInput
          value={name}
          maxLength={1024}
          placeholder="For example: Runbooks"
          suppressAutofill
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/** Share a private entry: a copy of its text becomes a new workspace entry. One choice. */
function ShareEntryDialog({
  record,
  workspaceId,
  onClose,
  onShared,
}: {
  record: KnowledgeEntryRecord;
  workspaceId: string;
  onClose: () => void;
  onShared: () => void;
}) {
  const context = useAppContext();
  const targets = context.workspaces.filter(
    (workspace) =>
      workspace.kind !== "personal" &&
      hasWorkspacePermission(context.accessContext, workspace.id, "documents:manage"),
  );
  const [target, setTarget] = useState(
    () => targets.find((workspace) => workspace.id === workspaceId)?.id ?? targets[0]?.id ?? "",
  );
  const [entryId] = useState(() => crypto.randomUUID());
  const text = record.revision.entry;
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title="Share with a workspace"
      description="Adds a copy of this text to the workspace's Library. Your private entry stays private, and attached files aren't shared."
      submitLabel="Share copy"
      pendingLabel="Sharing…"
      submitDisabled={!targets.length}
      disabledReason={
        targets.length
          ? undefined
          : "You need permission to manage Knowledge in a shared workspace to share this."
      }
      onSubmit={async () => {
        await context.client.saveKnowledgeEntry(target, {
          operationId: crypto.randomUUID(),
          entryId,
          expectedVersion: 0,
          scope: "workspace",
          entry: {
            title: text.title,
            kind: text.kind,
            content: text.content,
            source: { kind: "manual" },
            evidence: [],
            relationships: [],
            groupIds: [],
          },
        });
        toast(`Shared a copy of ${text.title}`);
        onShared();
        return true;
      }}
    >
      {targets.length ? (
        <Field label="Workspace">
          <SelectMenu
            size="md"
            options={targets.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
            value={target}
            onValueChange={setTarget}
            className="w-full"
          />
        </Field>
      ) : null}
    </FormDialog>
  );
}
