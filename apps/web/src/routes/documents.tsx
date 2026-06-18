// Documents: indexed document bases for agent search, with upload, reindex,
// and semantic search — all through the SDK client.
import { BrainCircuitIcon, CheckIcon, CheckCircle2Icon, FileSearchIcon, FilesIcon, Loader2Icon, PlusIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { useAppContext } from "@/context";
import { listViewState } from "@/lib/load-state";
import { cn } from "@/lib/utils";
import type { DocumentBase, DocumentSearchMode, DocumentSearchResult, IndexedDocument, KnowledgeMemory, KnowledgeMemoryKind, KnowledgeMemoryStatus, KnowledgeSourceKind } from "@/types";

const sourceKindOptions: KnowledgeSourceKind[] = ["manual_upload", "meeting_transcript", "repository", "email", "chat", "document", "web", "other"];
const memoryKindOptions: KnowledgeMemoryKind[] = ["semantic", "episodic", "procedural", "decision", "preference"];
const memoryStatusOptions: KnowledgeMemoryStatus[] = ["proposed", "approved", "rejected"];

export function DocumentsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const fileUploadsEnabled = context.clientConfig.fileUploads.enabled === true;
  const [bases, setBases] = useState<DocumentBase[]>([]);
  const [basesLoading, setBasesLoading] = useState(true);
  const [basesError, setBasesError] = useState<Error | null>(null);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<Error | null>(null);
  const [results, setResults] = useState<DocumentSearchResult[]>([]);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<DocumentSearchMode>("hybrid");
  const [searchSourceKind, setSearchSourceKind] = useState<KnowledgeSourceKind | "">("");
  const [searchAclTags, setSearchAclTags] = useState("");
  const [uploadSourceKind, setUploadSourceKind] = useState<KnowledgeSourceKind>("manual_upload");
  const [uploadSourceUri, setUploadSourceUri] = useState("");
  const [uploadSourceTitle, setUploadSourceTitle] = useState("");
  const [uploadSourceAuthor, setUploadSourceAuthor] = useState("");
  const [uploadAclTags, setUploadAclTags] = useState("");
  const [memories, setMemories] = useState<KnowledgeMemory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [memoryKind, setMemoryKind] = useState<KnowledgeMemoryKind>("semantic");
  const [memoryStatusFilter, setMemoryStatusFilter] = useState<KnowledgeMemoryStatus | "">("proposed");
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [proposingMemory, setProposingMemory] = useState(false);
  const [reviewingMemoryIds, setReviewingMemoryIds] = useState<Set<string>>(() => new Set());
  const [creatingBase, setCreatingBase] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  // The query behind the results on screen, so a completed search that found
  // nothing reads as "No results" rather than the initial prompt.
  const [searched, setSearched] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const [retryingAll, setRetryingAll] = useState(false);
  // Set when background indexing-status polling fails, so stale "indexing…"
  // rows carry a visible notice instead of silently freezing.
  const [pollFailed, setPollFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null;
  const failedDocuments = documents.filter((document) => document.status === "failed");
  // Honest list states: an initial fetch renders as loading and a failed load
  // as an error with retry — never as "Create a document base to start." or
  // "Upload files to index this base."
  const basesView = listViewState({ loading: basesLoading, error: basesError, count: bases.length });
  const documentsView = listViewState({ loading: documentsLoading, error: documentsError, count: documents.length });

  useEffect(() => {
    void refreshBases();
    void refreshMemories();
  }, [workspaceId]);

  useEffect(() => {
    setResults([]);
    setSearched(null);
    setPollFailed(false);
    if (!selectedBaseId) {
      setDocuments([]);
      setDocumentsError(null);
      return;
    }
    void refreshDocuments(selectedBaseId);
  }, [workspaceId, selectedBaseId]);

  useEffect(() => {
    if (!selectedBaseId || !documents.some((document) => document.status === "queued" || document.status === "indexing")) {
      return;
    }
    const timer = window.setInterval(() => {
      void client.listDocuments(workspaceId, selectedBaseId)
        .then((next) => {
          setDocuments(next);
          setPollFailed(false);
        })
        .catch(() => setPollFailed(true));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [workspaceId, selectedBaseId, documents]);

  async function refreshBases() {
    setBasesLoading(true);
    try {
      const next = await client.listDocumentBases(workspaceId);
      setBases(next);
      setBasesError(null);
      setSelectedBaseId((current) => current ?? next[0]?.id ?? null);
    } catch (error) {
      setBasesError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load document bases", { description: String(error) });
    } finally {
      setBasesLoading(false);
    }
  }

  async function refreshDocuments(baseId: string) {
    setDocumentsLoading(true);
    try {
      setDocuments(await client.listDocuments(workspaceId, baseId));
      setDocumentsError(null);
    } catch (error) {
      setDocumentsError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load documents", { description: String(error) });
    } finally {
      setDocumentsLoading(false);
    }
  }

  async function refreshMemories() {
    setMemoriesLoading(true);
    try {
      setMemories(await client.listKnowledgeMemories(workspaceId, {
        ...(memoryQuery.trim() ? { query: memoryQuery.trim() } : {}),
        ...(memoryStatusFilter ? { status: memoryStatusFilter } : {}),
        limit: 20,
      }));
    } catch (error) {
      toast.error("Failed to load memories", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setMemoriesLoading(false);
    }
  }

  async function handleCreateBase() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreatingBase(true);
    try {
      const base = await client.createDocumentBase(workspaceId, { name: trimmed });
      setBases((current) => [...current, base]);
      setSelectedBaseId(base.id);
      setName("");
      toast.success("Document base created", { description: `“${base.name}” is ready for uploads.` });
    } catch (error) {
      toast.error("Failed to create document base", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setCreatingBase(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!selectedBaseId || !files || files.length === 0) return;
    setUploading(true);
    try {
      const aclTags = splitTags(uploadAclTags);
      for (const file of Array.from(files)) {
        const asset = await client.uploadFile(workspaceId, {
          filename: file.name || "file",
          contentType: file.type || "application/octet-stream",
          data: file,
        });
        const indexed = await client.addDocument(workspaceId, selectedBaseId, {
          fileId: asset.id,
          sourceKind: uploadSourceKind,
          ...(uploadSourceUri.trim() ? { sourceUri: uploadSourceUri.trim() } : {}),
          ...(uploadSourceTitle.trim() ? { sourceTitle: uploadSourceTitle.trim() } : {}),
          ...(uploadSourceAuthor.trim() ? { sourceAuthor: uploadSourceAuthor.trim() } : {}),
          ...(aclTags.length > 0 ? { aclTags } : {}),
        });
        setDocuments((current) => [indexed, ...current.filter((item) => item.id !== indexed.id)]);
      }
      toast.success("Document indexed");
    } catch (error) {
      toast.error("Failed to index document", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSearch() {
    if (!selectedBaseId || !query.trim()) return;
    setSearching(true);
    try {
      const response = await client.searchDocuments(workspaceId, selectedBaseId, {
        query: query.trim(),
        limit: 8,
        mode: searchMode,
        ...(searchSourceKind ? { sourceKinds: [searchSourceKind] } : {}),
        ...(splitTags(searchAclTags).length > 0 ? { aclTags: splitTags(searchAclTags) } : {}),
      });
      setResults(response.results);
      setSearched(query.trim());
    } catch (error) {
      // Clear stale matches so a failed search never leaves prior results
      // reading as current; the toast carries the cause.
      setResults([]);
      setSearched(null);
      toast.error("Document search failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSearching(false);
    }
  }

  async function handleProposeMemory() {
    const text = memoryText.trim();
    if (!text) return;
    setProposingMemory(true);
    try {
      const memory = await client.createKnowledgeMemory(workspaceId, {
        text,
        kind: memoryKind,
        status: "proposed",
        confidence: 0.7,
      });
      setMemories((current) => [memory, ...current]);
      setMemoryText("");
      toast.success("Memory proposed");
    } catch (error) {
      toast.error("Failed to propose memory", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setProposingMemory(false);
    }
  }

  async function handleReviewMemory(memory: KnowledgeMemory, status: "approved" | "rejected") {
    setReviewingMemoryIds((current) => new Set(current).add(memory.id));
    try {
      const updated = await client.updateKnowledgeMemory(workspaceId, memory.id, { status });
      setMemories((current) => current.map((item) => item.id === updated.id ? updated : item));
      toast.success(status === "approved" ? "Memory approved" : "Memory rejected");
    } catch (error) {
      toast.error("Failed to review memory", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setReviewingMemoryIds((current) => {
        const next = new Set(current);
        next.delete(memory.id);
        return next;
      });
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
      toast.error("Failed to retry document", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleRetryFailedDocuments() {
    if (failedDocuments.length === 0) return;
    setRetryingAll(true);
    try {
      for (const document of failedDocuments) {
        await retryDocument(document);
      }
      toast.success(`Retry started for ${failedDocuments.length} failed ${failedDocuments.length === 1 ? "document" : "documents"}`);
    } catch (error) {
      toast.error("Failed to retry documents", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRetryingAll(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <section className="flex min-h-0 flex-1 flex-col text-left">
        <PageHeader
          icon={<FileSearchIcon className="size-4" />}
          title="Documents"
          description="Indexed document bases the agent can search."
          actions={(
            <div className="flex min-w-0 gap-2">
              <Input
                ref={nameInputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New base name"
                className="h-8 min-w-0 text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreateBase();
                }}
              />
              <Button type="button" size="sm" onClick={() => void handleCreateBase()} disabled={creatingBase || !name.trim()} className="h-8 shrink-0 pointer-coarse:min-h-10">
                {creatingBase ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                Create base
              </Button>
            </div>
          )}
        />

        <div className="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_360px]">
          <aside className="min-w-0 border-b border-border pb-4 lg:border-b-0 lg:border-r lg:pr-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase text-fg-subtle">Bases</div>
              <div className="text-2xs text-fg-subtle">{bases.length}</div>
            </div>
            <div className="space-y-1">
              {basesView === "loading" ? (
                <div className="flex items-center gap-2 rounded-lg border border-border p-3 text-xs text-fg-muted">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Loading bases
                </div>
              ) : basesView === "error" ? (
                <LoadErrorState title="Couldn't load document bases" error={basesError} onRetry={() => void refreshBases()} />
              ) : basesView === "empty" ? (
                <div className="rounded-lg border border-dashed border-border p-3 text-xs leading-5 text-fg-muted">
                  No bases yet. Name one above to start indexing documents.
                </div>
              ) : bases.map((base) => (
                <button
                  key={base.id}
                  type="button"
                  onClick={() => setSelectedBaseId(base.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs",
                    selectedBaseId === base.id
                      ? "border-brand/40 bg-brand/10 text-fg"
                      : "border-border bg-bg/25 text-fg-muted hover:bg-surface-2",
                  )}
                >
                  <span className="truncate">{base.name}</span>
                  {selectedBaseId === base.id ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                </button>
              ))}
            </div>
          </aside>

          <div className="min-w-0">
            {selectedBase ? (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-base font-medium">{selectedBase.name}</div>
                    <div className="text-xs text-fg-subtle">
                      {documents.length} files · {failedDocuments.length} failed
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => void handleFiles(event.target.files)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={uploading || !fileUploadsEnabled}
                      onClick={() => fileInputRef.current?.click()}
                      className="h-8"
                    >
                      {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <FilesIcon className="size-3.5" />}
                      Upload
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={retryingAll || failedDocuments.length === 0}
                      onClick={() => void handleRetryFailedDocuments()}
                      className="h-8"
                    >
                      {retryingAll ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
                      Retry failed
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/25 p-3 sm:grid-cols-2 xl:grid-cols-5">
                  <label className="grid gap-1 text-[11px] font-medium text-[color:var(--color-fg-subtle)]">
                    Source
                    <select
                      value={uploadSourceKind}
                      onChange={(event) => setUploadSourceKind(event.target.value as KnowledgeSourceKind)}
                      className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs text-[color:var(--color-fg)]"
                    >
                      {sourceKindOptions.map((kind) => <option key={kind} value={kind}>{formatToken(kind)}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-[color:var(--color-fg-subtle)]">
                    URI
                    <Input value={uploadSourceUri} onChange={(event) => setUploadSourceUri(event.target.value)} className="h-8 text-xs" placeholder="https://..." />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-[color:var(--color-fg-subtle)]">
                    Title
                    <Input value={uploadSourceTitle} onChange={(event) => setUploadSourceTitle(event.target.value)} className="h-8 text-xs" placeholder="Source title" />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-[color:var(--color-fg-subtle)]">
                    Author
                    <Input value={uploadSourceAuthor} onChange={(event) => setUploadSourceAuthor(event.target.value)} className="h-8 text-xs" placeholder="Owner" />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-[color:var(--color-fg-subtle)]">
                    ACL tags
                    <Input value={uploadAclTags} onChange={(event) => setUploadAclTags(event.target.value)} className="h-8 text-xs" placeholder="team, confidential" />
                  </label>
                </div>

                <div className="mt-4 space-y-2">
                  {pollFailed ? (
                    <Notice
                      tone="waiting"
                      title="Indexing status may be stale"
                      action={(
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => selectedBaseId ? void refreshDocuments(selectedBaseId) : undefined}
                        >
                          <RefreshCwIcon className="size-3" />
                          Refresh
                        </Button>
                      )}
                    >
                      Couldn't reach the server to refresh indexing progress. It will keep retrying.
                    </Notice>
                  ) : null}
                  {documentsView === "loading" ? (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-6 text-xs text-fg-muted">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Loading documents
                    </div>
                  ) : documentsView === "error" ? (
                    <LoadErrorState title="Couldn't load documents" error={documentsError} onRetry={() => selectedBaseId ? void refreshDocuments(selectedBaseId) : undefined} />
                  ) : documentsView === "empty" ? (
                    <EmptyState
                      icon={<FilesIcon className="size-4" />}
                      title="No documents yet"
                      description={fileUploadsEnabled
                        ? "Upload files to index them for agent search."
                        : "File uploads are turned off for this deployment."}
                      action={fileUploadsEnabled ? (
                        <Button type="button" size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                          {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <FilesIcon className="size-3.5" />}
                          Upload files
                        </Button>
                      ) : undefined}
                    />
                  ) : (
                    documents.map((document) => (
                      <div key={document.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/35 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{document.title}</div>
                          <div className="mt-1 text-2xs text-fg-subtle">
                            {document.status} · {document.chunkCount} chunks · {document.parser}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-[color:var(--color-fg-subtle)]">
                            <span>{formatToken(document.sourceKind)}</span>
                            {document.sourceTitle ? <span>· {document.sourceTitle}</span> : null}
                            {document.aclTags.slice(0, 3).map((tag) => <span key={tag} className="rounded border border-[color:var(--color-border)] px-1">{tag}</span>)}
                          </div>
                          {document.status === "failed" && document.error ? (
                            <div className="mt-2 line-clamp-2 max-w-3xl text-xs leading-5 text-danger">
                              {document.error}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-0.5">
                          <StatusDot tone={documentStatusTone(document.status)} pulse={document.status === "indexing"} />
                          <span className="sr-only">{document.status}</span>
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
                              {retryingIds.has(document.id) ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : basesView === "empty" ? (
              <EmptyState
                icon={<FileSearchIcon className="size-4" />}
                title="Create your first base"
                description="A document base is an indexed corpus the agent can search. Name one and upload files to it."
                action={(
                  <Button type="button" size="sm" onClick={() => nameInputRef.current?.focus()}>
                    <PlusIcon className="size-3.5" />
                    Create base
                  </Button>
                )}
              />
            ) : (
              <EmptyState
                icon={<FileSearchIcon className="size-4" />}
                title="No base selected"
                description="Pick a base on the left to upload and search its documents."
              />
            )}
          </div>

          <aside className="min-w-0 border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pl-4 lg:pt-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileSearchIcon className="size-4 text-brand" />
              Search
            </div>
            <div className="mt-3 grid gap-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search indexed documents"
                className="h-9 text-sm"
                disabled={!selectedBaseId}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSearch();
                }}
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={searchMode}
                  onChange={(event) => setSearchMode(event.target.value as DocumentSearchMode)}
                  className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs text-[color:var(--color-fg)]"
                  disabled={!selectedBaseId}
                >
                  <option value="hybrid">Hybrid</option>
                  <option value="vector">Vector</option>
                  <option value="keyword">Keyword</option>
                </select>
                <select
                  value={searchSourceKind}
                  onChange={(event) => setSearchSourceKind(event.target.value as KnowledgeSourceKind | "")}
                  className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs text-[color:var(--color-fg)]"
                  disabled={!selectedBaseId}
                >
                  <option value="">All sources</option>
                  {sourceKindOptions.map((kind) => <option key={kind} value={kind}>{formatToken(kind)}</option>)}
                </select>
              </div>
              <Input
                value={searchAclTags}
                onChange={(event) => setSearchAclTags(event.target.value)}
                placeholder="ACL tags"
                className="h-8 text-xs"
                disabled={!selectedBaseId}
              />
              <Button type="button" size="sm" onClick={() => void handleSearch()} disabled={searching || !selectedBaseId || !query.trim()} className="h-9">
                {searching ? <Loader2Icon className="size-3.5 animate-spin" /> : <FileSearchIcon className="size-3.5" />}
                Search
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {results.length > 0 ? (
                results.map((result) => (
                  <div key={result.chunkId} className="rounded-lg border border-border bg-surface/35 p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-medium text-fg">{result.title}</span>
                      <span className="shrink-0 text-fg-subtle">{result.matchType} · {Math.round(result.score * 100)}%</span>
                    </div>
                    <div className="mt-1 text-[11px] text-fg-subtle">
                      {formatToken(result.sourceKind)}{result.sourceTitle ? ` · ${result.sourceTitle}` : ""}
                    </div>
                    <p className="mt-2 line-clamp-4 text-xs leading-5 text-fg-muted">{result.text}</p>
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

            <div className="mt-6 border-t border-[color:var(--color-border)] pt-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <BrainCircuitIcon className="size-4 text-[color:var(--color-brand)]" />
                  Memory
                </div>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => void refreshMemories()} disabled={memoriesLoading} aria-label="Refresh memories" title="Refresh memories">
                  {memoriesLoading ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
                </Button>
              </div>

              <div className="mt-3 grid gap-2">
                <Textarea
                  value={memoryText}
                  onChange={(event) => setMemoryText(event.target.value)}
                  placeholder="Propose a reusable fact, decision, or preference"
                  className="min-h-20 text-xs"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={memoryKind}
                    onChange={(event) => setMemoryKind(event.target.value as KnowledgeMemoryKind)}
                    className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs text-[color:var(--color-fg)]"
                  >
                    {memoryKindOptions.map((kind) => <option key={kind} value={kind}>{formatToken(kind)}</option>)}
                  </select>
                  <Button type="button" size="sm" className="h-8" disabled={proposingMemory || !memoryText.trim()} onClick={() => void handleProposeMemory()}>
                    {proposingMemory ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                    Propose
                  </Button>
                </div>
              </div>

              <div className="mt-4 grid gap-2">
                <div className="grid grid-cols-[1fr_120px] gap-2">
                  <Input
                    value={memoryQuery}
                    onChange={(event) => setMemoryQuery(event.target.value)}
                    placeholder="Search memory"
                    className="h-8 text-xs"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void refreshMemories();
                    }}
                  />
                  <select
                    value={memoryStatusFilter}
                    onChange={(event) => setMemoryStatusFilter(event.target.value as KnowledgeMemoryStatus | "")}
                    className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs text-[color:var(--color-fg)]"
                  >
                    <option value="">All</option>
                    {memoryStatusOptions.map((status) => <option key={status} value={status}>{formatToken(status)}</option>)}
                  </select>
                </div>
                <Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => void refreshMemories()} disabled={memoriesLoading}>
                  {memoriesLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : <FileSearchIcon className="size-3.5" />}
                  Load memories
                </Button>
              </div>

              <div className="mt-3 space-y-2">
                {memories.length > 0 ? memories.map((memory) => (
                  <div key={memory.id} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 text-xs font-medium text-[color:var(--color-fg)]">
                        {formatToken(memory.kind)}
                      </div>
                      <span className="shrink-0 rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px] text-[color:var(--color-fg-subtle)]">
                        {formatToken(memory.status)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-4 text-xs leading-5 text-[color:var(--color-fg-muted)]">{memory.text}</p>
                    <div className="mt-2 text-[11px] text-[color:var(--color-fg-subtle)]">
                      {memory.scope} · {Math.round(memory.confidence * 100)}%
                    </div>
                    {memory.status === "proposed" ? (
                      <div className="mt-3 flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-7 flex-1"
                          disabled={reviewingMemoryIds.has(memory.id)}
                          onClick={() => void handleReviewMemory(memory, "approved")}
                        >
                          <CheckCircle2Icon className="size-3.5" />
                          Approve
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 flex-1"
                          disabled={reviewingMemoryIds.has(memory.id)}
                          onClick={() => void handleReviewMemory(memory, "rejected")}
                        >
                          <XCircleIcon className="size-3.5" />
                          Reject
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )) : (
                  <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-4 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                    No memory records match this view.
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function documentStatusTone(status: IndexedDocument["status"]): StatusTone {
  if (status === "ready") return "idle";
  if (status === "failed") return "failed";
  if (status === "indexing") return "running";
  return "waiting";
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function formatToken(value: string): string {
  return value.replace(/_/g, " ");
}
