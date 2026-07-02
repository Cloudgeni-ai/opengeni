// Documents: indexed document bases for agent search, with upload, reindex,
// and semantic search — all through the SDK client.
import { CheckIcon, FileSearchIcon, FilesIcon, Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";
import { listViewState } from "@/lib/load-state";
import { cn } from "@/lib/utils";
import type { DocumentBase, DocumentSearchResult, IndexedDocument } from "@/types";

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
  const [creatingBase, setCreatingBase] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const [retryingAll, setRetryingAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null;
  const failedDocuments = documents.filter((document) => document.status === "failed");
  // Honest list states: an initial fetch renders as loading and a failed load
  // as an error with retry — never as "Create a document base to start." or
  // "Upload files to index this base."
  const basesView = listViewState({ loading: basesLoading, error: basesError, count: bases.length });
  const documentsView = listViewState({ loading: documentsLoading, error: documentsError, count: documents.length });

  useEffect(() => {
    void refreshBases();
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedBaseId) {
      setDocuments([]);
      setDocumentsError(null);
      setResults([]);
      return;
    }
    void refreshDocuments(selectedBaseId);
  }, [workspaceId, selectedBaseId]);

  useEffect(() => {
    if (!selectedBaseId || !documents.some((document) => document.status === "queued" || document.status === "indexing")) {
      return;
    }
    const timer = window.setInterval(() => {
      void client.listDocuments(workspaceId, selectedBaseId).then(setDocuments).catch(() => undefined);
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

  async function handleCreateBase() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreatingBase(true);
    try {
      const base = await client.createDocumentBase(workspaceId, { name: trimmed });
      setBases((current) => [...current, base]);
      setSelectedBaseId(base.id);
      setName("");
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
      for (const file of Array.from(files)) {
        const asset = await client.uploadFile(workspaceId, {
          filename: file.name || "file",
          contentType: file.type || "application/octet-stream",
          data: file,
        });
        const indexed = await client.addDocument(workspaceId, selectedBaseId, { fileId: asset.id });
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
      const response = await client.searchDocuments(workspaceId, selectedBaseId, { query: query.trim(), limit: 8 });
      setResults(response.results);
    } catch (error) {
      toast.error("Document search failed", { description: error instanceof Error ? error.message : String(error) });
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
          description="Manage indexed document bases for agent search and retry failed document indexing."
          actions={(
            <div className="flex min-w-0 gap-2">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New base"
                className="h-8 min-w-0 text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreateBase();
                }}
              />
              <Button type="button" size="sm" onClick={() => void handleCreateBase()} disabled={creatingBase || !name.trim()} className="h-8 shrink-0">
                {creatingBase ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                Create
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
                <div className="rounded-lg border border-dashed border-border p-3 text-xs text-fg-muted">
                  Create a document base to start.
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

                <div className="mt-4 space-y-2">
                  {documentsView === "loading" ? (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-6 text-xs text-fg-muted">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Loading documents
                    </div>
                  ) : documentsView === "error" ? (
                    <LoadErrorState title="Couldn't load documents" error={documentsError} onRetry={() => selectedBaseId ? void refreshDocuments(selectedBaseId) : undefined} />
                  ) : documentsView === "empty" ? (
                    <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-fg-muted">
                      Upload files to index this base.
                    </div>
                  ) : (
                    documents.map((document) => (
                      <div key={document.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/35 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{document.title}</div>
                          <div className="mt-1 text-2xs text-fg-subtle">
                            {document.status} · {document.chunkCount} chunks · {document.parser}
                          </div>
                          {document.status === "failed" && document.error ? (
                            <div className="mt-2 line-clamp-2 max-w-3xl text-xs leading-5 text-danger">
                              {document.error}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-0.5">
                          <DocumentStatusDot status={document.status} />
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
            ) : (
              <div className="grid min-h-48 place-items-center text-center text-xs text-fg-muted">
                Select or create a base.
              </div>
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
                      <span className="shrink-0 text-fg-subtle">{Math.round(result.score * 100)}%</span>
                    </div>
                    <p className="mt-2 line-clamp-4 text-xs leading-5 text-fg-muted">{result.text}</p>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-xs leading-5 text-fg-muted">
                  Search results appear here for the selected base.
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function DocumentStatusDot({ status }: { status: IndexedDocument["status"] }) {
  return (
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        status === "ready" && "bg-status-idle",
        status === "failed" && "bg-status-failed",
        (status === "queued" || status === "indexing") && "bg-status-waiting",
      )}
      aria-label={status}
      title={status}
    />
  );
}
