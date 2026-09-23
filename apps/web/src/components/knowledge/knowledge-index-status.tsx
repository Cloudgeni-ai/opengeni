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
  const accountId = context.workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
  const canBuy = Boolean(
    accountId && hasAccountPermission(context.accessContext, accountId, "billing:manage"),
  );
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
