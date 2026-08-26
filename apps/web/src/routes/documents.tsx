// Documents: one scope-first surface over the internal document store. Storage
// collections remain an implementation detail; users add knowledge, choose who
// it belongs to, and search everything they are authorized to access.
import {
  ArrowLeftIcon,
  DownloadIcon,
  FileIcon,
  FileImageIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FilesIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasAccountPermission } from "@/lib/permissions";
import { usePageLiveActivity } from "@opengeni/react";
import { listViewState } from "@/lib/load-state";
import type {
  DocumentAuthorityKind,
  DocumentBase,
  DocumentSearchResult,
  IndexedDocument,
} from "@/types";

export const DEFAULT_DOCUMENT_AUTHORITY_KIND: DocumentAuthorityKind = "workspace";

export function defaultDocumentAuthorityKind(personalWorkspace: boolean): DocumentAuthorityKind {
  return personalWorkspace ? "personal" : DEFAULT_DOCUMENT_AUTHORITY_KIND;
}

export const DOCUMENT_AUTHORITY_OPTIONS = [
  { value: "organization", label: "Company" },
  { value: "workspace", label: "Current workspace" },
  { value: "personal", label: "Only me" },
] as const satisfies ReadonlyArray<{
  value: DocumentAuthorityKind;
  label: string;
}>;

export function documentAuthorityLabel(kind: DocumentAuthorityKind): string {
  return DOCUMENT_AUTHORITY_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

export function localPopulatedDocumentsPreview(
  search: string,
  workspaceId: string,
  enabled = import.meta.env.DEV,
): { base: DocumentBase; documents: IndexedDocument[] } | null {
  if (!enabled || new URLSearchParams(search).get("previewDocuments") !== "populated") {
    return null;
  }

  const timestamp = "2026-08-10T10:00:00.000Z";
  const base: DocumentBase = {
    id: "preview-documents",
    workspaceId,
    name: "Documents",
    description: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const examples = [
    {
      title: "Company strategy 2026.pdf",
      parser: "pdf",
      summary: "Company direction, annual priorities, and the goals every agent should understand.",
      authorityKind: "organization" as const,
      topics: ["strategy", "company goals"],
    },
    {
      title: "Product launch plan.docx",
      parser: "docx",
      summary: "Launch milestones, owners, messaging, and the rollout plan for the next release.",
      authorityKind: "workspace" as const,
      topics: ["product", "launch"],
    },
    {
      title: "Brand guidelines.png",
      parser: "image",
      summary: "Visual reference covering the approved logo, colors, typography, and spacing.",
      authorityKind: "organization" as const,
      topics: ["brand", "design"],
    },
    {
      title: "Lead pipeline.xlsx",
      parser: "xlsx",
      summary: "Current sales prospects, stages, owners, and expected contract values.",
      authorityKind: "workspace" as const,
      topics: ["sales", "pipeline"],
    },
    {
      title: "Research notes.txt",
      parser: "text",
      summary: "Private notes and early observations for an upcoming market analysis.",
      authorityKind: "personal" as const,
      topics: ["research"],
    },
  ];

  return {
    base,
    documents: examples.map((example, index) => ({
      id: `preview-document-${index + 1}`,
      workspaceId,
      baseId: base.id,
      fileId: `preview-file-${index + 1}`,
      status: "ready",
      title: example.title,
      parser: example.parser,
      chunkCount: index === 2 ? 1 : 6 - index,
      error: null,
      sourceKind: "manual_upload",
      sourceUri: null,
      sourceExternalId: null,
      sourceTitle: null,
      sourceAuthor: "Preview user",
      sourceCreatedAt: timestamp,
      sourceUpdatedAt: timestamp,
      sourceVersion: "1",
      aclTags: [],
      authorityKind: example.authorityKind,
      authorityWorkspaceId: example.authorityKind === "workspace" ? workspaceId : null,
      authoritySubjectId: example.authorityKind === "personal" ? "preview-user" : null,
      visibility: example.authorityKind === "personal" ? "private" : "workspace",
      createdBy: "preview-user",
      agentAccess: true,
      summary: example.summary,
      topics: example.topics,
      curationStatus: "auto_filed",
      curation: null,
      createdAt: timestamp,
      updatedAt: new Date(Date.parse(timestamp) - index * 60_000).toISOString(),
    })),
  };
}

export function DocumentsRoute({
  workspaceId,
  returnToBrain = false,
  authorityKind,
}: {
  workspaceId: string;
  returnToBrain?: boolean;
  authorityKind?: DocumentAuthorityKind;
}) {
  const context = useAppContext();
  const client = context.client;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const personalWorkspace = isPersonalWorkspace(workspace, context.managedSelfContext);
  const canWriteOrganizationKnowledge = Boolean(
    workspace?.accountId &&
    hasAccountPermission(context.accessContext, workspace.accountId, "account:admin"),
  );
  const canAddKnowledge = authorityKind !== "organization" || canWriteOrganizationKnowledge;
  const dropAuthorityOptions = authorityKind
    ? DOCUMENT_AUTHORITY_OPTIONS.filter((option) => option.value === authorityKind)
    : DOCUMENT_AUTHORITY_OPTIONS.filter(
        (option) => option.value !== "organization" || canWriteOrganizationKnowledge,
      );
  const pageLive = usePageLiveActivity();
  const fileUploadsEnabled = context.clientConfig.fileUploads.enabled === true;
  const [bases, setBases] = useState<DocumentBase[]>([]);
  const [basesLoading, setBasesLoading] = useState(true);
  const [basesError, setBasesError] = useState<Error | null>(null);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<Error | null>(null);
  const [results, setResults] = useState<DocumentSearchResult[]>([]);
  const [query, setQuery] = useState("");
  const [dropText, setDropText] = useState("");
  const [dropAuthorityKind, setDropAuthorityKind] = useState<DocumentAuthorityKind>(
    () => authorityKind ?? defaultDocumentAuthorityKind(personalWorkspace),
  );
  const [dropping, setDropping] = useState(false);
  const dropFileInputRef = useRef<HTMLInputElement | null>(null);
  const [searching, setSearching] = useState(false);
  // The query behind the results on screen, so a completed search that found
  // nothing reads as "No results" rather than the initial prompt.
  const [searched, setSearched] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(() => new Set());
  const [retryingAll, setRetryingAll] = useState(false);
  // Set when background indexing-status polling fails, so stale "indexing…"
  // rows carry a visible notice instead of silently freezing.
  const [pollFailed, setPollFailed] = useState(false);
  const populatedPreview = localPopulatedDocumentsPreview(window.location.search, workspaceId);
  const allVisibleDocuments = populatedPreview?.documents ?? documents;
  const visibleDocuments = authorityKind
    ? allVisibleDocuments.filter((document) => document.authorityKind === authorityKind)
    : allVisibleDocuments;
  const failedDocuments = visibleDocuments.filter((document) => document.status === "failed");
  // Honest list states: an initial fetch renders as loading and a failed load
  // as an error with retry instead of exposing the internal storage model.
  const basesView = listViewState({
    loading: basesLoading,
    error: basesError,
    count: bases.length,
  });
  const visibleBasesView = populatedPreview ? "ready" : basesView;
  const visibleDocumentsView = populatedPreview
    ? visibleDocuments.length === 0
      ? "empty"
      : "ready"
    : listViewState({
        loading: documentsLoading,
        error: documentsError,
        count: visibleDocuments.length,
      });

  useEffect(() => {
    setDropAuthorityKind(authorityKind ?? defaultDocumentAuthorityKind(personalWorkspace));
  }, [authorityKind, personalWorkspace, workspaceId]);

  const refreshBases = useCallback(async () => {
    setBasesLoading(true);
    try {
      const next = await client.listDocumentBases(workspaceId);
      setBases(next);
      setBasesError(null);
    } catch (error) {
      setBasesError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load documents", { description: String(error) });
    } finally {
      setBasesLoading(false);
    }
  }, [client, workspaceId]);

  const refreshDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    try {
      const next = await client.listAccessibleDocuments(workspaceId);
      setDocuments(next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setDocumentsError(null);
    } catch (error) {
      setDocumentsError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load documents", { description: String(error) });
    } finally {
      setDocumentsLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void refreshBases();
  }, [refreshBases]);

  useEffect(() => {
    setResults([]);
    setSearched(null);
    setPollFailed(false);
    if (basesLoading || basesError) {
      setDocuments([]);
      setDocumentsError(null);
      return;
    }
    void refreshDocuments();
  }, [bases, basesError, basesLoading, refreshDocuments]);

  useEffect(() => {
    if (
      !pageLive ||
      bases.length === 0 ||
      !documents.some((document) => document.status === "queued" || document.status === "indexing")
    ) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      await client
        .listAccessibleDocuments(workspaceId)
        .then((next) => {
          if (!cancelled) {
            setDocuments(next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
            setPollFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setPollFailed(true);
        });
      if (!cancelled) timer = setTimeout(() => void load(), 1_200);
    };
    timer = setTimeout(() => void load(), 1_200);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, workspaceId, bases, documents, pageLive]);

  // Refresh every internal storage bucket after a drop. Collections stay
  // invisible, including when legacy curation rules move a document.
  async function finishDrop() {
    let nextBases = bases;
    try {
      nextBases = await client.listDocumentBases(workspaceId);
      setBases(nextBases);
    } catch {
      // The existing inventory can still be refreshed if the base-list request fails.
    }
    await refreshDocuments();
  }

  async function handleDropText() {
    const text = dropText.trim();
    if (!text || !canAddKnowledge) return;
    const selectedAuthorityKind = authorityKind ?? dropAuthorityKind;
    if (selectedAuthorityKind === "organization" && !canWriteOrganizationKnowledge) return;
    setDropping(true);
    try {
      const document = await client.createKnowledgeDrop(workspaceId, {
        text,
        authorityKind: selectedAuthorityKind,
        agentAccess: true,
      });
      setDropText("");
      toast.success("Dropped into knowledge", {
        description: dropResultDescription(document),
      });
      await finishDrop();
    } catch (error) {
      toast.error("Drop failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDropping(false);
    }
  }

  async function handleDropFiles(files: FileList | null) {
    if (!files || files.length === 0 || !canAddKnowledge) return;
    const selectedAuthorityKind = authorityKind ?? dropAuthorityKind;
    if (selectedAuthorityKind === "organization" && !canWriteOrganizationKnowledge) return;
    setDropping(true);
    try {
      let last: IndexedDocument | null = null;
      for (const file of Array.from(files)) {
        const asset = await client.uploadFile(workspaceId, {
          filename: file.name || "file",
          contentType: file.type || "application/octet-stream",
          data: file,
        });
        last = await client.createKnowledgeDrop(workspaceId, {
          fileId: asset.id,
          authorityKind: selectedAuthorityKind,
          agentAccess: true,
        });
      }
      toast.success(
        files.length === 1 ? "Dropped into knowledge" : `${files.length} files dropped`,
        {
          description: last ? dropResultDescription(last) : "The files were added to knowledge.",
        },
      );
      if (last) await finishDrop();
    } catch (error) {
      toast.error("Drop failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDropping(false);
      if (dropFileInputRef.current) dropFileInputRef.current.value = "";
    }
  }

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const response = await client.searchKnowledge(workspaceId, {
        query: query.trim(),
        ...(authorityKind ? { authorityKinds: [authorityKind] } : {}),
        limit: 8,
        mode: "hybrid",
      });
      setResults(response.results.slice(0, 8));
      setSearched(query.trim());
    } catch (error) {
      // Clear stale matches so a failed search never leaves prior results
      // reading as current; the toast carries the cause.
      setResults([]);
      setSearched(null);
      toast.error("Document search failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSearching(false);
    }
  }

  async function retryDocument(document: IndexedDocument): Promise<IndexedDocument> {
    setRetryingIds((current) => new Set(current).add(document.id));
    try {
      const indexed = await client.reindexDocument(workspaceId, document.baseId, document.id);
      setDocuments((current) => [indexed, ...current.filter((item) => item.id !== indexed.id)]);
      return indexed;
    } finally {
      setRetryingIds((current) => {
        const next = new Set(current);
        next.delete(document.id);
        return next;
      });
    }
  }

  async function handleRetryDocument(document: IndexedDocument) {
    try {
      await retryDocument(document);
      toast.success("Document retry started");
    } catch (error) {
      toast.error("Failed to retry document", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleRetryFailedDocuments() {
    if (failedDocuments.length === 0) return;
    setRetryingAll(true);
    try {
      for (const document of failedDocuments) {
        await retryDocument(document);
      }
      toast.success(
        `Retry started for ${failedDocuments.length} failed ${failedDocuments.length === 1 ? "document" : "documents"}`,
      );
    } catch (error) {
      toast.error("Failed to retry documents", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRetryingAll(false);
    }
  }

  async function handleDownloadDocument(document: IndexedDocument) {
    setDownloadingIds((current) => new Set(current).add(document.id));
    try {
      const signed = await client.createDocumentOriginalFileDownloadUrl(workspaceId, document.id);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Failed to download document", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDownloadingIds((current) => {
        const next = new Set(current);
        next.delete(document.id);
        return next;
      });
    }
  }

  return (
    <ContentPage>
      <section className="flex min-h-0 flex-1 flex-col text-left">
        <PageHeader
          icon={<FileSearchIcon className="size-4" />}
          title={personalWorkspace ? "Your Documents" : "Documents"}
          description={
            authorityKind === "organization"
              ? canWriteOrganizationKnowledge
                ? "Explore and add knowledge shared across this organization."
                : "Explore knowledge shared across this organization."
              : personalWorkspace
                ? "Manage your private documents and the company knowledge available to you."
                : "Add information agents can find when it is relevant."
          }
        />
        {returnToBrain ? (
          <Link
            to="/workspaces/$workspaceId/state"
            params={{ workspaceId }}
            search={{}}
            className="mt-6 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            <ArrowLeftIcon className="size-3" />
            Back to Agent Knowledge
          </Link>
        ) : null}

        {personalWorkspace ? (
          <Notice tone="info" className="mt-5" title="Your personal document library">
            New knowledge defaults to Only me. Personal documents belong to you and can follow you
            into other workspaces in this organization; company documents you can access are shown
            with their own scope label.
          </Notice>
        ) : null}

        {authorityKind === "organization" ? (
          <Notice tone="info" className="mt-5" title="Company knowledge">
            {canWriteOrganizationKnowledge
              ? "This view shows only organization-scoped Documents. New knowledge is locked to Company and is available across authorized workspaces in this organization."
              : "This view shows only organization-scoped Documents. It is read-only for you; only an organization owner can add Company knowledge."}
          </Notice>
        ) : null}

        {canAddKnowledge ? (
          <div
            role="region"
            aria-label="Knowledge drop zone"
            className="mt-5 rounded-lg border border-dashed border-border bg-surface/25 p-3"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void handleDropFiles(event.dataTransfer?.files ?? null);
            }}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <SparklesIcon className="size-4 text-brand" />
              Add knowledge
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <textarea
                aria-label="Knowledge drop text"
                value={dropText}
                onChange={(event) => setDropText(event.target.value)}
                placeholder="Paste text here, drag in files, or choose files below."
                rows={2}
                disabled={!fileUploadsEnabled || dropping}
                className="min-h-16 w-full resize-y rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-2 text-xs leading-5 text-[color:var(--color-fg)]"
              />
              <div className="flex flex-col gap-2">
                <label className="grid gap-1 text-2xs font-medium text-fg-subtle">
                  Save for
                  <Select
                    value={dropAuthorityKind}
                    onChange={(event) =>
                      setDropAuthorityKind(event.target.value as DocumentAuthorityKind)
                    }
                    disabled={dropping || authorityKind !== undefined}
                    aria-label="Drop authority"
                    className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs font-normal text-[color:var(--color-fg)] pointer-coarse:min-h-10"
                  >
                    {dropAuthorityOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <div className="flex gap-2">
                  <input
                    ref={dropFileInputRef}
                    type="file"
                    multiple
                    aria-label="Add files as a knowledge drop"
                    className="hidden"
                    onChange={(event) => void handleDropFiles(event.target.files)}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!fileUploadsEnabled || dropping}
                    onClick={() => dropFileInputRef.current?.click()}
                    className="h-8 pointer-coarse:min-h-10"
                  >
                    <FilesIcon className="size-3.5" />
                    Choose files
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!fileUploadsEnabled || dropping || !dropText.trim()}
                    onClick={() => void handleDropText()}
                    className="h-8 pointer-coarse:min-h-10"
                  >
                    {dropping ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <PlusIcon className="size-3.5" />
                    )}
                    Add
                  </Button>
                </div>
              </div>
            </div>
            {!fileUploadsEnabled ? (
              <div className="mt-2 text-2xs text-fg-subtle">
                Knowledge drops need object storage, which is off for this deployment.
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 grid min-h-0 min-w-0 flex-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            {visibleBasesView === "ready" ? (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-base font-medium">
                      {authorityKind === "organization"
                        ? "Organization knowledge"
                        : personalWorkspace
                          ? "Knowledge available to you"
                          : "Your documents"}
                    </div>
                  </div>
                  {failedDocuments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={retryingAll}
                        onClick={() => void handleRetryFailedDocuments()}
                        className="h-8 pointer-coarse:min-h-10"
                      >
                        {retryingAll ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3.5" />
                        )}
                        Retry failed
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 space-y-2">
                  {pollFailed ? (
                    <Notice
                      tone="waiting"
                      title="Indexing status may be stale"
                      action={
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => void refreshDocuments()}
                        >
                          <RefreshCwIcon className="size-3" />
                          Refresh
                        </Button>
                      }
                    >
                      Couldn't reach the server to refresh indexing progress. It will keep retrying.
                    </Notice>
                  ) : null}
                  {visibleDocumentsView === "loading" ? (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-6 text-xs text-fg-muted">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Loading documents
                    </div>
                  ) : visibleDocumentsView === "error" ? (
                    <LoadErrorState
                      title="Couldn't load documents"
                      error={documentsError}
                      onRetry={() => void refreshDocuments()}
                    />
                  ) : visibleDocumentsView === "empty" ? (
                    <EmptyState
                      icon={<FilesIcon className="size-4" />}
                      title={
                        authorityKind === "organization"
                          ? "No organization documents yet"
                          : "No documents yet"
                      }
                      description={
                        authorityKind === "organization" && !canWriteOrganizationKnowledge
                          ? "An organization owner can add Company knowledge."
                          : fileUploadsEnabled
                            ? "Add files or text above to make them available to agents."
                            : "File uploads are turned off for this deployment."
                      }
                    />
                  ) : (
                    visibleDocuments.map((document) => (
                      <div
                        key={document.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/35 px-3 py-2.5"
                      >
                        <div className="flex min-w-0 gap-3">
                          <DocumentTypeIcon document={document} />
                          <div className="min-w-0">
                            <div className="break-words text-sm font-medium" title={document.title}>
                              {document.title}
                            </div>
                            {document.summary ? (
                              <p className="mt-1 line-clamp-2 max-w-3xl text-xs leading-5 text-fg-muted">
                                {document.summary}
                              </p>
                            ) : null}
                            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-[color:var(--color-fg-subtle)]">
                              <span>{documentTypeLabel(document)}</span>
                              {document.sourceTitle ? <span>· {document.sourceTitle}</span> : null}
                              <span className="inline-flex items-center gap-1 rounded border border-[color:var(--color-border)] px-1">
                                {documentAuthorityLabel(document.authorityKind)}
                              </span>
                              {document.status !== "ready" ? <span>{document.status}</span> : null}
                              {document.agentAccess === false ? (
                                <span className="text-danger">Agents cannot access this</span>
                              ) : null}
                              {document.topics.slice(0, 2).map((topic) => (
                                <span
                                  key={topic}
                                  className="rounded border border-[color:var(--color-border)] px-1"
                                >
                                  {topic}
                                </span>
                              ))}
                            </div>
                            {document.status === "failed" && document.error ? (
                              <div className="mt-2 line-clamp-2 max-w-3xl text-xs leading-5 text-danger">
                                {document.error}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-0.5">
                          <StatusDot
                            tone={documentStatusTone(document.status)}
                            pulse={document.status === "indexing"}
                          />
                          <span className="sr-only">{document.status}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={downloadingIds.has(document.id)}
                            onClick={() => void handleDownloadDocument(document)}
                            aria-label={`Download ${document.title}`}
                            title="Download original file"
                          >
                            {downloadingIds.has(document.id) ? (
                              <Loader2Icon className="size-4 animate-spin" />
                            ) : (
                              <DownloadIcon className="size-4" />
                            )}
                          </Button>
                          {document.status === "failed" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={retryingIds.has(document.id)}
                              onClick={() => void handleRetryDocument(document)}
                              aria-label={`Retry ${document.title}`}
                              title="Retry indexing"
                            >
                              {retryingIds.has(document.id) ? (
                                <Loader2Icon className="size-4 animate-spin" />
                              ) : (
                                <RefreshCwIcon className="size-4" />
                              )}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : visibleBasesView === "loading" ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-6 text-xs text-fg-muted">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading documents
              </div>
            ) : visibleBasesView === "empty" ? (
              <EmptyState
                icon={<FileSearchIcon className="size-4" />}
                title="Preparing document storage"
                description="OpenGeni is preparing this workspace for document uploads."
                action={
                  <Button type="button" size="sm" onClick={() => void refreshBases()}>
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </Button>
                }
              />
            ) : (
              <LoadErrorState
                title="Couldn't load documents"
                error={basesError}
                onRetry={() => void refreshBases()}
              />
            )}
          </div>

          <aside
            aria-labelledby="document-search-heading"
            className="min-w-0 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0"
          >
            <h2
              id="document-search-heading"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <FileSearchIcon className="size-4 text-brand" />
              Search
            </h2>
            <div className="mt-3 grid gap-2">
              <Input
                aria-label="Search indexed documents"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search indexed documents"
                className="h-9 text-sm pointer-coarse:min-h-10"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSearch();
                }}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSearch()}
                disabled={searching || !query.trim()}
                className="h-9 pointer-coarse:min-h-10"
              >
                {searching ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <FileSearchIcon className="size-3.5" />
                )}
                Search
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {results.length > 0 ? (
                results.map((result) => (
                  <div
                    key={result.chunkId}
                    className="rounded-lg border border-border bg-surface/35 p-3"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 break-words font-medium text-fg">
                        {result.title}
                      </span>
                      <span className="shrink-0 text-fg-subtle">
                        {result.matchType} · {Math.round(result.score * 100)}%
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-fg-subtle">
                      {formatToken(result.sourceKind)}
                      {result.sourceTitle ? ` · ${result.sourceTitle}` : ""}
                    </div>
                    <p className="mt-2 line-clamp-4 text-xs leading-5 text-fg-muted">
                      {result.text}
                    </p>
                  </div>
                ))
              ) : searched ? (
                <div className="rounded-lg border border-dashed border-border p-4 text-xs leading-5 text-fg-muted">
                  No results for “{searched}”.
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-xs leading-5 text-fg-muted">
                  Results appear here.
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>
    </ContentPage>
  );
}

type DocumentType = "pdf" | "word" | "image" | "spreadsheet" | "text" | "file";

export function documentType(document: Pick<IndexedDocument, "parser" | "title">): DocumentType {
  const value = `${document.parser} ${document.title}`.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|heic|tiff?)\b/.test(value) || value.includes("image")) {
    return "image";
  }
  if (/\.(xlsx?|csv|tsv)\b/.test(value) || /spreadsheet|excel/.test(value)) {
    return "spreadsheet";
  }
  if (/\.(docx?|odt|rtf)\b/.test(value) || /word|docx/.test(value)) return "word";
  if (/\.pdf\b/.test(value) || value.includes("pdf")) return "pdf";
  if (/\.(txt|md|markdown)\b/.test(value) || /plain.?text|markdown/.test(value)) return "text";
  return "file";
}

export function documentTypeLabel(document: Pick<IndexedDocument, "parser" | "title">): string {
  const kind = documentType(document);
  if (kind === "pdf") return "PDF";
  if (kind === "word") return "Word document";
  if (kind === "image") return "Image";
  if (kind === "spreadsheet") return "Spreadsheet";
  if (kind === "text") return "Text";
  return formatToken(document.parser || "file");
}

function DocumentTypeIcon({ document }: { document: IndexedDocument }) {
  const kind = documentType(document);
  const Icon =
    kind === "image"
      ? FileImageIcon
      : kind === "spreadsheet"
        ? FileSpreadsheetIcon
        : kind === "pdf" || kind === "word" || kind === "text"
          ? FileTextIcon
          : FileIcon;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg text-fg-muted">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

function dropResultDescription(document: Pick<IndexedDocument, "curationStatus">): string {
  switch (document.curationStatus) {
    case "none":
      return "The document was added and is being prepared for agent search.";
    case "pending":
      return "The document was added; processing is still in progress.";
    case "suggested":
      return "The document was added and prepared for search.";
    case "auto_filed":
      return "The document was named, summarized, and prepared for search.";
    case "failed":
      return "Curation failed softly; the document remains searchable with safe fallback metadata.";
  }
}

function documentStatusTone(status: IndexedDocument["status"]): StatusTone {
  if (status === "ready") return "idle";
  if (status === "failed") return "failed";
  if (status === "indexing") return "running";
  return "waiting";
}

function formatToken(value: string): string {
  return value.replace(/_/g, " ");
}
