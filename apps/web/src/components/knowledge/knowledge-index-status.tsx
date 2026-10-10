import type { KnowledgeEntryListResponse, KnowledgeIndexStatus } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { useAppContext } from "@/context";
import { hasAccountPermission } from "@/lib/permissions";

const labels: Record<KnowledgeIndexStatus, string> = {
  saved: "Saved · indexing not started",
  queued: "Saved · indexing queued",
  indexing: "Saved · indexing",
  awaiting_funding: "Saved · awaiting credits for indexing",
  indexed: "Indexed",
  source_unavailable: "Saved · source temporarily unavailable",
  provider_failed: "Saved · indexing provider unavailable",
};

/** Index status never changes whether the original or keyword search can be used. */
export function KnowledgeIndexNotice({
  status,
  workspaceId,
}: {
  status?: KnowledgeIndexStatus;
  workspaceId: string;
}) {
  const context = useAppContext();
  if (!status) return null;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const accountId = workspace?.accountId;
  const canBuy = Boolean(
    accountId && hasAccountPermission(context.accessContext, accountId, "billing:manage"),
  );
  // The worker parks paid indexing the same way when the workspace turned
  // credits off; adding credits would not resume it then. This reads the
  // viewed workspace's switch, which is the billed one for workspace entries
  // (personal and organization entries bill their own workspace).
  if (status === "awaiting_funding" && workspace?.settings?.allowCreditModels === false) {
    return (
      <div role="status" className="text-sm text-fg-muted">
        <span>Saved · indexing paused while Opengeni credits are off.</span>
        <span>
          {" "}
          The original and keyword search remain available. Indexing resumes automatically when
          Opengeni credits are turned back on for this workspace.
        </span>
      </div>
    );
  }
  return (
    <div role="status" className="text-sm text-fg-muted">
      <span>{labels[status]}.</span>
      {status === "awaiting_funding" ? (
        <span>
          {" "}
          The original and keyword search remain available. Indexing resumes automatically after
          credits are added.{" "}
          {canBuy ? (
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId }}
              search={{ section: "billing" }}
              className="inline-flex min-h-10 items-center font-medium text-brand underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Add credits
            </Link>
          ) : (
            "Ask an organization billing manager to add credits."
          )}
        </span>
      ) : status === "provider_failed" ? (
        <span> Indexing will retry; adding credits will not fix a provider outage.</span>
      ) : status === "source_unavailable" ? (
        <span> Indexing will retry when the source is available.</span>
      ) : null}
    </div>
  );
}

export function knowledgeIndexLabel(status?: KnowledgeIndexStatus) {
  return status ? labels[status] : null;
}

export function KnowledgeSearchFallback({
  reason,
  workspaceId,
}: {
  reason?: KnowledgeEntryListResponse["fallbackReason"];
  workspaceId: string;
}) {
  const context = useAppContext();
  if (!reason) return null;
  const accountId = context.workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
  const canBuy = Boolean(
    accountId && hasAccountPermission(context.accessContext, accountId, "billing:manage"),
  );
  const message = {
    awaiting_funding:
      "Semantic search needs credits. Showing keyword results; saved sources remain available.",
    credits_disabled:
      "Semantic search uses Opengeni credits, which are off in this workspace. Showing keyword results.",
    quota: "Semantic search quota reached. Showing keyword results.",
    provider_unavailable: "Semantic search provider unavailable. Showing keyword results.",
    query_limit: "Query exceeds the semantic search limit. Showing keyword results.",
  }[reason];
  return (
    <p role="status" className="text-sm text-fg-muted">
      {message}{" "}
      {reason === "awaiting_funding" ? (
        canBuy ? (
          <Link
            to="/workspaces/$workspaceId/organization"
            params={{ workspaceId }}
            search={{ section: "billing" }}
            className="font-medium text-brand underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Add credits
          </Link>
        ) : (
          "Ask a billing manager to add credits."
        )
      ) : null}
    </p>
  );
}
