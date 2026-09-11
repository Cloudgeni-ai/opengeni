import type { KnowledgeEntryRecord, KnowledgeEntrySummary } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";

/** Show the readable content beside its original, without a second upload surface. */
export function FileSourceText({ workspaceId, fileId }: { workspaceId: string; fileId: string }) {
  const { client } = useAppContext();
  const [sources, setSources] = useState<KnowledgeEntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setSources([]);
    setCursor(null);
    setError(null);
    void client
      .listKnowledgeEntries(workspaceId, { fileId, kind: "source", limit: 20 })
      .then((result) => {
        if (current) {
          setSources(result.entries);
          setCursor(result.nextCursor);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, fileId, refresh]);
  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listKnowledgeEntries(workspaceId, {
        fileId,
        kind: "source",
        limit: 20,
        cursor,
      });
      setSources((prior) => [...prior, ...result.entries]);
      setCursor(result.nextCursor);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="grid gap-5">
      <p className="text-sm leading-6 text-fg-muted">
        Readable text retained from this file. Useful findings are linked under “View knowledge from
        this file”.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-status-error">
          {error}{" "}
          <Button variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
            Retry
          </Button>
        </p>
      ) : null}
      {sources.map((source) => (
        <SourcePassage key={source.revision.id} workspaceId={workspaceId} source={source} />
      ))}
      {loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading text…
        </p>
      ) : !sources.length && !error ? (
        <p className="py-6 text-sm text-fg-muted">
          No published text is available yet. You can still open the original file.
        </p>
      ) : null}
      {cursor ? (
        <Button variant="outline" disabled={loading} onClick={() => void more()}>
          Load more text
        </Button>
      ) : null}
    </div>
  );
}

function SourcePassage({
  workspaceId,
  source,
}: {
  workspaceId: string;
  source: KnowledgeEntrySummary;
}) {
  const { client } = useAppContext();
  const [record, setRecord] = useState<KnowledgeEntryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setRecord(null);
    setError(null);
    void client
      .getKnowledgeEntry(workspaceId, source.id, { revisionId: source.revision.id })
      .then((result) => {
        if (current) setRecord(result);
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, source.id, source.revision.id, refresh]);
  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">{source.revision.title}</h3>
      {error ? (
        <p role="alert" className="text-sm text-status-error">
          {error}{" "}
          <Button variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
            Retry
          </Button>
        </p>
      ) : record ? (
        <div className="whitespace-pre-wrap break-words rounded-lg bg-surface/60 p-5 text-sm leading-7">
          {record.revision.entry.content}
        </div>
      ) : (
        <p role="status" className="text-sm text-fg-muted">
          Loading text…
        </p>
      )}
    </section>
  );
}
