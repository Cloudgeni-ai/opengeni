import type {
  CompanyBrainContextReceiptPage,
  CompanyBrainKnowledgeProposalPage,
  CompanyBrainOkfPackage,
  CompanyBrainKnowledgeBrowseResponse,
  CompanyBrainKnowledgeRecord,
  CompanyBrainKnowledgeSearchResponse,
} from "@opengeni/sdk";
import {
  browseCompanyBrainKnowledge,
  getCompanyBrainKnowledge,
  listCompanyBrainContextReceipts,
  listCompanyBrainKnowledgeProposals,
  searchCompanyBrainKnowledge,
} from "@opengeni/sdk";
import { SearchIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState, LoadErrorState } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

function KnowledgeRecordCard({
  record,
  onOpen,
  onBrowse,
}: {
  record: CompanyBrainKnowledgeRecord;
  onOpen: (id: string) => void;
  onBrowse: (id: string) => void;
}) {
  return (
    <article className="rounded-md border border-border bg-surface-2/30 p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-medium text-fg">{record.title || "Untitled knowledge"}</h4>
          <p className="mt-1 text-fg-muted">
            {label(record.authority.kind)} · {label(record.provenance.source.kind)} · updated{" "}
            {date(record.lifecycle.updatedAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="font-medium text-brand hover:underline"
            onClick={() => onOpen(record.id)}
            type="button"
          >
            Inspect
          </button>
          {record.kind === "document" ? (
            <button
              className="font-medium text-brand hover:underline"
              onClick={() => onBrowse(record.id)}
              type="button"
            >
              Contents
            </button>
          ) : null}
        </div>
      </div>
      {record.content.summary ? (
        <p className="mt-2 whitespace-pre-wrap leading-5 text-fg-muted">{record.content.summary}</p>
      ) : null}
      {record.projection.truncated ? (
        <p className="mt-2 text-status-waiting">
          Bounded projection: {record.projection.fields.join(", ")}
        </p>
      ) : null}
    </article>
  );
}

export function CompanyBrainInspector({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const [brain, setBrain] = useState<CompanyBrainOkfPackage | null>(null);
  const [browse, setBrowse] = useState<CompanyBrainKnowledgeBrowseResponse | null>(null);
  const [browseParentId, setBrowseParentId] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<CompanyBrainContextReceiptPage | null>(null);
  const [proposals, setProposals] = useState<CompanyBrainKnowledgeProposalPage | null>(null);
  const [selected, setSelected] = useState<CompanyBrainKnowledgeRecord | null>(null);
  const [search, setSearch] = useState<CompanyBrainKnowledgeSearchResponse | null>(null);
  const [query, setQuery] = useState("");
  const [guidanceFilter, setGuidanceFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const recordGeneration = useRef(0);
  const browseGeneration = useRef(0);
  const receiptGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    searchGeneration.current += 1;
    recordGeneration.current += 1;
    browseGeneration.current += 1;
    receiptGeneration.current += 1;
    setLoading(true);
    setSearching(false);
    setError(null);
    setBrain(null);
    setBrowse(null);
    setBrowseParentId(null);
    setReceipts(null);
    setProposals(null);
    setSelected(null);
    setSearch(null);
    setQuery("");
    setGuidanceFilter("");
    try {
      const nextBrain = await client.getCompanyBrain(workspaceId);
      if (generation !== loadGeneration.current) return;
      setBrain(nextBrain);

      const optionalReads = await Promise.allSettled([
        listCompanyBrainContextReceipts(client, workspaceId, { limit: 12 }),
        nextBrain.permissions.knowledge === "available"
          ? browseCompanyBrainKnowledge(client, workspaceId, { limit: 12 })
          : Promise.resolve(null),
        nextBrain.permissions.knowledge === "available"
          ? listCompanyBrainKnowledgeProposals(client, workspaceId, { limit: 12 })
          : Promise.resolve(null),
      ]);
      if (generation !== loadGeneration.current) return;
      const [receiptResult, browseResult, proposalResult] = optionalReads;
      setReceipts(receiptResult.status === "fulfilled" ? receiptResult.value : null);
      setBrowse(browseResult.status === "fulfilled" ? browseResult.value : null);
      setProposals(proposalResult.status === "fulfilled" ? proposalResult.value : null);
      const rejected = optionalReads.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        setError(
          rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason)),
        );
      }
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
      searchGeneration.current += 1;
      recordGeneration.current += 1;
      browseGeneration.current += 1;
      receiptGeneration.current += 1;
    };
  }, [load]);

  const guidance = useMemo(() => {
    const normalized = guidanceFilter.trim().toLocaleLowerCase();
    if (!normalized) return brain?.guidance.entries ?? [];
    return (brain?.guidance.entries ?? []).filter((entry) =>
      [entry.title, entry.description ?? "", entry.path, entry.content]
        .join("\n")
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [brain?.guidance.entries, guidanceFilter]);

  const knowledgeAvailable = brain?.permissions.knowledge === "available";

  const runSearch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const value = query.trim();
    if (!value || searching) return;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setError(null);
    try {
      const response = await searchCompanyBrainKnowledge(client, workspaceId, {
        query: value,
        limit: 12,
      });
      if (generation === searchGeneration.current) setSearch(response);
    } catch (searchError) {
      if (generation === searchGeneration.current) {
        setError(searchError instanceof Error ? searchError : new Error(String(searchError)));
      }
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  };

  const openRecord = async (id: string): Promise<void> => {
    const generation = ++recordGeneration.current;
    setError(null);
    try {
      const response = await getCompanyBrainKnowledge(client, workspaceId, id);
      if (generation === recordGeneration.current) setSelected(response.record);
    } catch (openError) {
      if (generation === recordGeneration.current) {
        setError(openError instanceof Error ? openError : new Error(String(openError)));
      }
    }
  };

  const browseContents = async (parentId: string): Promise<void> => {
    const generation = ++browseGeneration.current;
    setError(null);
    try {
      const response = await browseCompanyBrainKnowledge(client, workspaceId, {
        parentId,
        limit: 20,
      });
      if (generation === browseGeneration.current) {
        setSearch(null);
        setBrowseParentId(parentId);
        setBrowse(response);
      }
    } catch (browseError) {
      if (generation === browseGeneration.current) {
        setError(browseError instanceof Error ? browseError : new Error(String(browseError)));
      }
    }
  };

  const loadMoreKnowledge = async (): Promise<void> => {
    if (!browse?.nextCursor) return;
    const generation = ++browseGeneration.current;
    setError(null);
    try {
      const response = await browseCompanyBrainKnowledge(client, workspaceId, {
        ...(browseParentId ? { parentId: browseParentId } : {}),
        cursor: browse.nextCursor,
        limit: 20,
      });
      if (generation !== browseGeneration.current) return;
      setBrowse((current) => {
        if (!current) return response;
        const seen = new Set(current.records.map((item) => item.id));
        return {
          ...response,
          records: [...current.records, ...response.records.filter((item) => !seen.has(item.id))],
        };
      });
    } catch (browseError) {
      if (generation === browseGeneration.current) {
        setError(browseError instanceof Error ? browseError : new Error(String(browseError)));
      }
    }
  };

  const loadMoreReceipts = async (): Promise<void> => {
    if (!receipts?.nextCursor) return;
    const generation = ++receiptGeneration.current;
    setError(null);
    try {
      const response = await listCompanyBrainContextReceipts(client, workspaceId, {
        cursor: receipts.nextCursor,
        limit: 20,
      });
      if (generation !== receiptGeneration.current) return;
      setReceipts((current) => {
        if (!current) return response;
        const seen = new Set(current.receipts.map((item) => item.id));
        return {
          ...response,
          receipts: [
            ...current.receipts,
            ...response.receipts.filter((item) => !seen.has(item.id)),
          ],
        };
      });
    } catch (receiptError) {
      if (generation === receiptGeneration.current) {
        setError(receiptError instanceof Error ? receiptError : new Error(String(receiptError)));
      }
    }
  };

  if (loading && !brain) return <Skeleton className="h-96 w-full" />;
  if (error && !brain) {
    return (
      <LoadErrorState
        title="Couldn't load the Agent Knowledge inspector"
        error={error}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <section
      aria-labelledby="company-brain-inspector-title"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="company-brain-inspector-title" className="text-sm font-semibold text-fg">
            Explore Agent Knowledge
          </h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Search authorized knowledge, inspect your guidance history, and see content-free context
            receipts and pending proposals.
          </p>
        </div>
        <button
          className="w-fit text-xs font-medium text-brand hover:underline"
          type="button"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      {error ? (
        <div className="mt-3">
          <LoadErrorState
            title="Some inspector data couldn't be refreshed"
            error={error}
            onRetry={() => void load()}
          />
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section
          className="rounded-md border border-border p-3"
          aria-labelledby="guidance-history-title"
        >
          <h3 id="guidance-history-title" className="text-sm font-medium text-fg">
            Guidance & history
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            Authorized bodies are loaded here on demand; only compact descriptors are
            prompt-default.
          </p>
          {brain?.guidance.truncated ? (
            <p className="mt-2 text-xs text-status-waiting">
              This bounded history reached: {brain.guidance.truncationReasons.map(label).join(", ")}
              . Export carries the same explicit loss facts.
            </p>
          ) : null}
          <label className="mt-3 grid gap-1 text-xs text-fg-muted">
            Filter guidance
            <input
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
              value={guidanceFilter}
              onChange={(event) => setGuidanceFilter(event.target.value)}
            />
          </label>
          <div className="mt-3 grid max-h-[34rem] gap-2 overflow-auto pr-1">
            {guidance.map((entry) => (
              <details
                key={`${entry.id}:${entry.revisionId}`}
                className="rounded-md border border-border bg-surface-2/30 p-3"
              >
                <summary className="cursor-pointer text-xs font-medium text-fg">
                  {entry.title} · r{entry.revision} ·{" "}
                  {entry.active ? "active" : label(entry.lifecycle)}
                </summary>
                <p className="mt-2 text-2xs text-fg-muted">
                  {label(entry.classification)} · {label(entry.scope)} · {entry.path}
                </p>
                {entry.description ? (
                  <p className="mt-2 text-xs text-fg-muted">{entry.description}</p>
                ) : null}
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface p-3 text-xs text-fg">
                  {entry.content}
                </pre>
              </details>
            ))}
            {guidance.length === 0 ? (
              <EmptyState>No matching guidance is visible.</EmptyState>
            ) : null}
          </div>
        </section>

        <section
          className="rounded-md border border-border p-3"
          aria-labelledby="knowledge-explorer-title"
        >
          <h3 id="knowledge-explorer-title" className="text-sm font-medium text-fg">
            Knowledge explorer
          </h3>
          {knowledgeAvailable ? (
            <>
              <form
                className="mt-3 flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => void runSearch(event)}
              >
                <label className="sr-only" htmlFor="company-brain-knowledge-query">
                  Search company knowledge
                </label>
                <input
                  id="company-brain-knowledge-query"
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                  value={query}
                  required
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={searching}
                  type="submit"
                >
                  <SearchIcon className="size-3" /> {searching ? "Searching…" : "Search"}
                </button>
              </form>
              <div className="mt-3 grid max-h-[34rem] gap-2 overflow-auto pr-1">
                {(search?.results.map((result) => result.record) ?? browse?.records ?? []).map(
                  (record) => (
                    <KnowledgeRecordCard
                      key={record.id}
                      record={record}
                      onOpen={(id) => void openRecord(id)}
                      onBrowse={(id) => void browseContents(id)}
                    />
                  ),
                )}
                {(search?.results.length ?? browse?.records.length ?? 0) === 0 ? (
                  <EmptyState>No authorized knowledge records found.</EmptyState>
                ) : null}
              </div>
              {!search && browse?.nextCursor ? (
                <button
                  className="mt-3 text-xs font-medium text-brand hover:underline"
                  type="button"
                  onClick={() => void loadMoreKnowledge()}
                >
                  Load more knowledge
                </button>
              ) : null}
              {search ? (
                <p className="mt-2 text-2xs text-fg-muted">
                  {search.results.length} results · {search.selection.omitted.belowRelevanceFloor}{" "}
                  below the relevance floor · about {search.selection.budget.estimatedTokens} tokens
                </p>
              ) : null}
              {selected ? (
                <div className="mt-3 rounded-md border border-brand/30 bg-brand/5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-xs font-medium text-fg">{selected.title}</h4>
                    <button
                      className="text-xs text-brand"
                      type="button"
                      onClick={() => setSelected(null)}
                    >
                      Close
                    </button>
                  </div>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-fg-muted">
                    {selected.content.body ?? selected.content.summary ?? "No body available."}
                  </pre>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState>Knowledge is unavailable with your current workspace access.</EmptyState>
          )}
        </section>

        <section
          className="rounded-md border border-border p-3"
          aria-labelledby="context-receipts-title"
        >
          <h3 id="context-receipts-title" className="text-sm font-medium text-fg">
            Why agents used context
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            Content-free accepted-turn receipts. These explain selected authorities without
            revealing memory bodies.
          </p>
          <div className="mt-3 grid gap-2">
            {receipts?.receipts.map((receipt) => (
              <details key={receipt.id} className="rounded-md border border-border p-3 text-xs">
                <summary className="cursor-pointer font-medium text-fg">
                  {label(receipt.sessionRole)} turn · {date(receipt.acceptedAt)}
                </summary>
                <dl className="mt-2 grid gap-2 text-fg-muted sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-fg">Prompt mode</dt>
                    <dd>{label(receipt.memoryPromptMode)}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-fg">Company profile</dt>
                    <dd>{receipt.companyProfileIncluded ? "Included" : "Not included"}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-fg">Memory selection</dt>
                    <dd>
                      {receipt.renderedMemoryCount} rendered of {receipt.selectedMemoryCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-fg">Snapshot</dt>
                    <dd>{label(receipt.turnContextSnapshotSource)}</dd>
                  </div>
                </dl>
              </details>
            ))}
            {receipts?.receipts.length === 0 ? (
              <EmptyState>No accepted-turn context receipts exist yet.</EmptyState>
            ) : null}
          </div>
          {receipts?.nextCursor ? (
            <button
              className="mt-3 text-xs font-medium text-brand hover:underline"
              type="button"
              onClick={() => void loadMoreReceipts()}
            >
              Load more context receipts
            </button>
          ) : null}
        </section>

        <section
          className="rounded-md border border-border p-3"
          aria-labelledby="knowledge-proposals-title"
        >
          <h3 id="knowledge-proposals-title" className="text-sm font-medium text-fg">
            Knowledge-backed proposals
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            Visible proposals remain inactive until the existing human-authoritative review path
            accepts them.
          </p>
          {knowledgeAvailable ? (
            <div className="mt-3 grid gap-2">
              {proposals?.proposals.map((proposal) => (
                <details key={proposal.id} className="rounded-md border border-border p-3 text-xs">
                  <summary className="cursor-pointer font-medium text-fg">
                    {label(proposal.targetKind)} ·{" "}
                    {proposal.targetKey ?? label(proposal.targetScope)}
                  </summary>
                  <p className="mt-2 text-fg-muted">
                    {label(proposal.authority.kind)} · proposed {date(proposal.createdAt)}
                  </p>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-fg">
                    {proposal.content}
                  </pre>
                  {proposal.projection.truncated ? (
                    <p className="mt-2 text-status-waiting">
                      Preview bounded from {proposal.projection.originalContentUtf8Bytes} UTF-8
                      bytes.
                    </p>
                  ) : null}
                </details>
              ))}
              {proposals?.proposals.length === 0 ? (
                <EmptyState>No visible Knowledge-backed proposals need review.</EmptyState>
              ) : null}
            </div>
          ) : (
            <EmptyState>
              Knowledge proposals are unavailable with your current workspace access.
            </EmptyState>
          )}
          {knowledgeAvailable &&
          (proposals?.truncatedForCount || proposals?.truncatedForResponseBytes) ? (
            <p className="mt-2 text-xs text-status-waiting">
              This proposal preview is bounded
              {proposals.truncatedForResponseBytes ? " by response bytes" : " by item count"}.
            </p>
          ) : null}
        </section>
      </div>
    </section>
  );
}
