import type { KnowledgeEntryContent, KnowledgeEntryRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { KNOWLEDGE_KIND_LABEL, KNOWLEDGE_SOURCE_LABEL } from "./knowledge-labels";

/** Show all changed text with a little unchanged context, rather than repeating a long source. */
export function changedText(before: string, after: string) {
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  // Keep whole words/numbers, including currency values, in the highlighted change.
  while (start > 0 && !/\s/.test(before[start - 1]!)) start--;
  let tail = 0;
  while (
    tail < Math.min(before.length, after.length) - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  while (tail > 0 && !/\s/.test(before[before.length - tail]!)) tail--;
  const contextStart = Math.max(0, before.lastIndexOf(" ", Math.max(0, start - 100)) + 1);
  const contextEnd = Math.min(before.length, before.length - tail + 100);
  const prefix = `${contextStart > 0 ? "…" : ""}${before.slice(contextStart, start)}`;
  const suffix = `${before.slice(before.length - tail, contextEnd)}${contextEnd < before.length ? "…" : ""}`;
  return {
    prefix,
    before: before.slice(start, before.length - tail),
    after: after.slice(start, after.length - tail),
    suffix,
  };
}

export function KnowledgeReviewSummary({
  workspaceId,
  record,
}: {
  workspaceId: string;
  record: KnowledgeEntryRecord;
}) {
  const { client } = useAppContext();
  const [previous, setPrevious] = useState<KnowledgeEntryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(record.publishedRevisionId));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setPrevious(null);
    setError(null);
    setLoading(Boolean(record.publishedRevisionId));
    if (record.publishedRevisionId)
      void client
        .getKnowledgeEntry(workspaceId, record.id, { revisionId: record.publishedRevisionId })
        .then((result) => {
          if (current) setPrevious(result);
        })
        .catch(() => {
          if (current)
            setError("Couldn't load the current version. The proposed text is shown below.");
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    return () => {
      current = false;
    };
  }, [client, workspaceId, record.id, record.publishedRevisionId, retry]);
  const proposed = record.revision.entry;
  const original = previous?.revision.entry;
  if (record.revision.change === "archive")
    return (
      <section aria-label="Proposed change" className="grid gap-3">
        <p className="text-sm">
          Archive this knowledge? It will no longer appear in normal searches.
        </p>
        <TextPreview text={proposed.content} />
      </section>
    );
  if (loading)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading changes…
      </p>
    );
  return (
    <section aria-label="Proposed change" className="grid min-w-0 gap-4">
      {error ? (
        <p role="alert" className="text-sm text-fg-muted">
          {error}
          <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
            Retry comparison
          </Button>
        </p>
      ) : null}
      {original ? (
        <>
          {original.title !== proposed.title ? (
            <TextChange label="Title" before={original.title} after={proposed.title} />
          ) : null}
          {original.content !== proposed.content ? (
            <TextChange label="Changed text" before={original.content} after={proposed.content} />
          ) : (
            <p className="text-sm text-fg-muted">The text is unchanged.</p>
          )}
          {original.kind !== proposed.kind ? (
            <p className="text-sm">
              Type: {KNOWLEDGE_KIND_LABEL[original.kind]} → {KNOWLEDGE_KIND_LABEL[proposed.kind]}
            </p>
          ) : null}
          {!sameIds(original.groupIds, proposed.groupIds) ? (
            <section className="grid gap-2 text-sm">
              <h3 className="font-medium">Collections changed</h3>
              <CollectionChange
                workspaceId={workspaceId}
                before={original.groupIds}
                after={proposed.groupIds}
              />
            </section>
          ) : null}
          {(
            [
              ["source", "Original source changed"],
              ["evidence", "Sources changed"],
              ["relationships", "Related knowledge changed"],
            ] as const
          ).map(([field, title]) =>
            JSON.stringify(original[field]) !== JSON.stringify(proposed[field]) ? (
              <details key={field} className="text-sm">
                <summary className="cursor-pointer font-medium">{title}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <MetadataSnapshot
                    workspaceId={workspaceId}
                    label="Current"
                    entry={original}
                    field={field}
                  />
                  <MetadataSnapshot
                    workspaceId={workspaceId}
                    label="Proposed"
                    entry={proposed}
                    field={field}
                  />
                </div>
              </details>
            ) : null,
          )}
        </>
      ) : (
        <TextPreview
          text={proposed.content || "Create this collection to organize related knowledge."}
        />
      )}
    </section>
  );
}
function sameIds(a: string[], b: string[]) {
  return [...a].sort().join() === [...b].sort().join();
}
function TextPreview({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  return (
    <div
      className="grid gap-2 rounded-lg border border-l-[3px] bg-brand/5 p-4"
      style={{
        borderColor: "color-mix(in oklab, var(--color-brand) 30%, var(--color-border))",
        borderLeftColor: "var(--color-brand)",
      }}
    >
      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6">
        {full || text.length <= 800 ? text : `${text.slice(0, 800)}…`}
      </p>
      {text.length > 800 ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setFull(!full)}
        >
          {full ? "Show less" : `Read full text (${text.length.toLocaleString()} characters)`}
        </Button>
      ) : null}
    </div>
  );
}
function TextChange({ label, before, after }: { label: string; before: string; after: string }) {
  const difference = changedText(before, after);
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="text-xs font-medium text-fg-muted">{label}</h3>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {(
          [
            ["Current", difference.before],
            ["Proposed", difference.after],
          ] as const
        ).map(([title, text]) => (
          <div
            key={title}
            className={`min-w-0 rounded-lg border p-4 ${title === "Proposed" ? "border-t-[3px] bg-brand/5" : "bg-bg"}`}
            style={
              title === "Proposed"
                ? {
                    borderColor: "color-mix(in oklab, var(--color-brand) 30%, var(--color-border))",
                    borderTopColor: "var(--color-brand)",
                  }
                : { borderColor: "var(--color-border-strong)" }
            }
          >
            <p
              className={`mb-2 text-xs font-semibold ${title === "Proposed" ? "text-brand" : "text-fg-muted"}`}
            >
              {title}
            </p>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6">
              {difference.prefix}
              <mark
                className={
                  title === "Current" ? "bg-status-failed/10 text-fg" : "bg-brand/10 text-fg"
                }
              >
                {text}
              </mark>
              {difference.suffix}
              {!text && !difference.prefix && !difference.suffix ? (
                <span className="text-fg-muted">Empty</span>
              ) : null}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
function CollectionChange({
  workspaceId,
  before,
  after,
}: {
  workspaceId: string;
  before: string[];
  after: string[];
}) {
  return (
    <div className="grid gap-1">
      {before
        .filter((id) => !after.includes(id))
        .map((id) => (
          <p key={`remove:${id}`}>
            Remove from <CollectionName workspaceId={workspaceId} id={id} />
          </p>
        ))}
      {after
        .filter((id) => !before.includes(id))
        .map((id) => (
          <p key={`add:${id}`}>
            Add to <CollectionName workspaceId={workspaceId} id={id} />
          </p>
        ))}
    </div>
  );
}
function CollectionName({
  workspaceId,
  id,
  revisionId,
}: {
  workspaceId: string;
  id: string;
  revisionId?: string;
}) {
  const { client } = useAppContext();
  const [title, setTitle] = useState("Loading name…");
  useEffect(() => {
    let current = true;
    void client
      .getKnowledgeEntry(workspaceId, id, revisionId ? { revisionId } : {})
      .catch((error) => {
        if (!revisionId && error instanceof OpenGeniApiError && error.status === 404)
          return client.getKnowledgeEntry(workspaceId, id, { view: "needs_review" });
        throw error;
      })
      .then((result) => {
        if (current)
          setTitle(
            `${result.revision.entry.title}${revisionId ? ` · Revision ${result.revision.number}` : ""}`,
          );
      })
      .catch(() => {
        if (current) setTitle("Unavailable entry");
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, id, revisionId]);
  return <span className="font-medium">{title}</span>;
}
function MetadataSnapshot({
  workspaceId,
  label,
  entry,
  field,
}: {
  workspaceId: string;
  label: string;
  entry: KnowledgeEntryContent;
  field: "source" | "evidence" | "relationships";
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs text-fg-muted">{label}</p>
      {field === "source" ? (
        entry.source ? (
          <div className="grid gap-1 break-words text-sm">
            <p>{KNOWLEDGE_SOURCE_LABEL[entry.source.kind]}</p>
            {(
              [
                ["fileId", "File reference"],
                ["documentId", "Document reference"],
                ["sessionId", "Conversation reference"],
                ["noteId", "Task note reference"],
                ["externalId", "External reference"],
              ] as const
            ).map(([key, name]) =>
              entry.source?.[key] ? (
                <p key={key} className="break-all">
                  <span className="text-fg-muted">{name}: </span>
                  {entry.source[key]}
                </p>
              ) : null,
            )}
            {entry.source.uri ? <p>{entry.source.uri}</p> : null}
            {entry.source.version ? <p>Source version: {entry.source.version}</p> : null}
            {entry.source.retention ? (
              <p>
                {entry.source.retention === "full_text"
                  ? "Full text"
                  : entry.source.retention === "passages"
                    ? "Selected passages"
                    : "Reference only"}
              </p>
            ) : null}
            {entry.source.capturedAt ? (
              <p>Captured {new Date(entry.source.capturedAt).toLocaleString()}</p>
            ) : null}
          </div>
        ) : (
          <p>None</p>
        )
      ) : field === "evidence" ? (
        <div className="grid gap-3">
          {entry.evidence.length ? (
            entry.evidence.map((evidence) => (
              <div key={JSON.stringify(evidence)} className="grid gap-1">
                <CollectionName
                  workspaceId={workspaceId}
                  id={evidence.entryId}
                  revisionId={evidence.revisionId}
                />
                {evidence.quote ? (
                  <blockquote className="border-l-2 border-border pl-2 text-fg-muted">
                    {evidence.quote}
                  </blockquote>
                ) : null}
                {evidence.location.page ? <p>Page {evidence.location.page}</p> : null}
                {evidence.location.path ? (
                  <p className="break-words">{evidence.location.path}</p>
                ) : null}
                {evidence.location.lineStart ? (
                  <p>
                    Lines {evidence.location.lineStart}
                    {evidence.location.lineEnd ? `–${evidence.location.lineEnd}` : ""}
                  </p>
                ) : null}
                {evidence.location.commit ? (
                  <p className="break-all">Commit: {evidence.location.commit}</p>
                ) : null}
                {evidence.location.passage ? <p>Passage: {evidence.location.passage}</p> : null}
                {evidence.location.messageIds?.length ? (
                  <p className="break-all">Messages: {evidence.location.messageIds.join(", ")}</p>
                ) : null}
              </div>
            ))
          ) : (
            <p>None</p>
          )}
        </div>
      ) : (
        <div className="grid gap-2">
          {entry.relationships.length ? (
            entry.relationships.map((relation) => (
              <p key={`${relation.entryId}:${relation.relation}`}>
                {relation.relation.replaceAll("_", " ")}:{" "}
                <CollectionName workspaceId={workspaceId} id={relation.entryId} />
              </p>
            ))
          ) : (
            <p>None</p>
          )}
        </div>
      )}
    </div>
  );
}
