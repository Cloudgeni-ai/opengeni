import { KnowledgePage } from "@/components/knowledge/knowledge-page";
import type { KnowledgeSearch } from "@/components/knowledge/knowledge-navigation";

/** The Knowledge page (/state): Library, Instructions and Review. */
export function WorkspaceStateRoute({
  workspaceId,
  search,
}: {
  workspaceId: string;
  search: KnowledgeSearch;
}) {
  return <KnowledgePage key={workspaceId} workspaceId={workspaceId} search={search} />;
}
