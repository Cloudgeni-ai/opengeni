import { useEffect, useState } from "react";
import type { KnowledgeEntryContent, KnowledgeEntryRecord } from "@opengeni/sdk";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";

type Evidence = KnowledgeEntryContent["evidence"][number];

/** Evidence changes are explicit: old quotes/locations never silently move to new text. */
export function KnowledgeEvidenceEditor(props: {
  workspaceId: string;
  evidence: Evidence[];
  disabled: boolean;
  onChange: (evidence: Evidence[]) => void;
}) {
  return (
    <fieldset disabled={props.disabled} className="grid gap-3">
      <legend className="mb-2 text-sm font-medium">Supporting evidence</legend>
      {props.evidence.map((evidence, index) => (
        <EvidenceRevision
          key={`${evidence.entryId}:${evidence.revisionId}:${JSON.stringify(evidence.location)}:${evidence.quote ?? ""}`}
          workspaceId={props.workspaceId}
          evidence={evidence}
          onReplace={(replacement) =>
            props.onChange(props.evidence.map((item, i) => (i === index ? replacement : item)))
          }
          onRemove={() => props.onChange(props.evidence.filter((_, i) => i !== index))}
        />
      ))}
    </fieldset>
  );
}

function EvidenceRevision(props: {
  workspaceId: string;
  evidence: Evidence;
  onReplace: (evidence: Evidence) => void;
  onRemove: () => void;
}) {
  const { client } = useAppContext();
  const [source, setSource] = useState<KnowledgeEntryRecord | null>(null);
  const [published, setPublished] = useState<KnowledgeEntryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      client.getKnowledgeEntry(props.workspaceId, props.evidence.entryId, {
        revisionId: props.evidence.revisionId,
      }),
      client.getKnowledgeEntry(props.workspaceId, props.evidence.entryId),
    ]).then(([pinned, active]) => {
      if (!current) return;
      if (pinned.status === "fulfilled") setSource(pinned.value);
      else setError("The cited revision could not be loaded. Check the source before approving.");
      if (active.status === "fulfilled") setPublished(active.value);
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [client, props.workspaceId, props.evidence.entryId, props.evidence.revisionId]);
  const replacement = published && published.revision.id !== props.evidence.revisionId;
  return (
    <div className="grid gap-2 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium">{source?.revision.entry.title ?? "Source"}</p>
      {loading ? <p className="text-fg-muted">Checking cited revision…</p> : null}
      {error ? (
        <p role="alert" className="text-status-error">
          {error}
        </p>
      ) : null}
      {source ? (
        <details>
          <summary className="cursor-pointer text-fg-muted">
            Cited revision {source.revision.number} · {source.revision.outcome}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans">
            {source.revision.entry.content}
          </pre>
          {props.evidence.quote ? (
            <blockquote className="mt-2 border-l-2 border-border pl-3">
              {props.evidence.quote}
            </blockquote>
          ) : null}
        </details>
      ) : null}
      {replacement ? (
        <>
          <p>
            A different revision is published. Compare the source and update this citation before
            approving.
          </p>
          <details>
            <summary className="cursor-pointer">
              Published revision {published.revision.number}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans">
              {published.revision.entry.content}
            </pre>
          </details>
          <p className="text-xs text-fg-muted">
            Switching removes the old quote and passage location. Verify that your finding is still
            supported by the published text.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              props.onReplace({
                entryId: props.evidence.entryId,
                revisionId: published.revision.id,
                location: {},
              })
            }
          >
            Use published revision
          </Button>
        </>
      ) : !loading && source?.revision.outcome === "pending" ? (
        <p className="text-fg-muted">
          This source is awaiting review. Approve it first or together with this finding. If you
          edit the source, update this citation afterward.
        </p>
      ) : null}
      <Button type="button" variant="ghost" onClick={props.onRemove}>
        Remove citation
      </Button>
    </div>
  );
}
