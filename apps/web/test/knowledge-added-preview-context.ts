import type {
  KnowledgeEntryKind,
  KnowledgeEntryListRequest,
  KnowledgeEntrySummary,
} from "@opengeni/sdk";

const now = Date.now();
const ago = (days: number) => new Date(now - days * 86400000).toISOString();
function sample(
  index: number,
  title: string,
  kind: KnowledgeEntryKind,
  days: number,
  preview: string,
): KnowledgeEntrySummary {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    scope: "workspace",
    version: 1,
    publishedRevisionId: id,
    latestRevisionId: id,
    archived: false,
    createdAt: ago(days),
    updatedAt: ago(0),
    excerpts: [],
    revision: {
      id,
      entryId: id,
      number: 1,
      change: "upsert",
      previousRevisionId: null,
      restoredFromRevisionId: null,
      createdAt: ago(days),
      createdBySessionId: null,
      reviewBatchId: null,
      outcome: "published",
      title,
      kind,
      preview,
      groupIds: [],
      sourceKind: null,
    },
  };
}

const samples = [
  sample(
    1,
    "Customer onboarding checklist",
    "requirement",
    0.25,
    "Send the setup checklist before the kickoff call.",
  ),
  sample(
    2,
    "Release verification",
    "decision",
    2,
    "Check the staging release before promoting it.",
  ),
  sample(3, "Support handoff", "fact", 5, "The support team owns the first response."),
  sample(4, "Quarterly planning", "note", 20, "Review priorities at the start of each quarter."),
  sample(
    5,
    "Older knowledge edited today",
    "fact",
    90,
    "A recent edit does not make an old entry newly added.",
  ),
];

declare global {
  interface Window {
    knowledgeAddedRequests: KnowledgeEntryListRequest[];
  }
}
window.knowledgeAddedRequests = [];

const context = {
  client: {
    async listKnowledgeEntries(_workspace: string, request: KnowledgeEntryListRequest) {
      window.knowledgeAddedRequests.push(request);
      const entries = samples.filter(
        (entry) =>
          (!request.createdSince ||
            Date.parse(entry.createdAt) >= Date.parse(request.createdSince)) &&
          (!request.kind || entry.revision.kind === request.kind) &&
          (!request.scope || entry.scope === request.scope) &&
          (!request.query ||
            entry.revision.title.toLowerCase().includes(request.query.toLowerCase())) &&
          (!request.view || request.view === "published"),
      );
      const offset = request.cursor ? Number(request.cursor) : 0;
      const page = entries.slice(offset, offset + 2);
      return { entries: page, nextCursor: offset + 2 < entries.length ? String(offset + 2) : null };
    },
  },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
export function useAppContext() {
  return context;
}
