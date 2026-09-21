import type { KnowledgeEntryRecord, KnowledgeEntryListRequest } from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";

const content = {
  kind: "source",
  title: "Connection settings screenshot",
  content:
    "Notion\nMCP server - Productivity\n\nConnect for workspace\nShared with agents and automations in this workspace.",
  source: { kind: "file", fileId: "image", retention: "full_text", purpose: "reference" },
  evidence: [],
  groupIds: [],
  relationships: [],
};
const record = {
  id: "image",
  workspaceId: "fixture",
  scope: "workspace",
  version: 1,
  publishedRevisionId: "revision",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  revision: {
    id: "revision",
    number: 1,
    title: content.title,
    kind: "source",
    entry: content,
    outcome: "published",
    change: "save",
  },
} as unknown as KnowledgeEntryRecord;
export const activity = { downloads: 0, lists: [] as KnowledgeEntryListRequest[] };
Object.assign(window, { knowledgeSourcesFixture: activity });
const context = {
  accessContext: null,
  workspaces: [],
  workspaceStateOwnerId: "fixture",
  captureWorkspaceInvocation: () => "fixture",
  ownsWorkspaceInvocation: () => true,
  client: {
    listKnowledgeEntries: async (_workspace: string, options: KnowledgeEntryListRequest) => {
      activity.lists.push(options);
      return { entries: [record], nextCursor: null };
    },
    getKnowledgeEntry: async () => record,
    createKnowledgeFileDownloadUrl: async () => {
      activity.downloads++;
      return {
        filename: "Connection settings screenshot",
        contentType: "image/svg+xml",
        url: new URL("/test/knowledge-source-image.svg", location.href).href,
        expiresAt: "2099-01-01T00:00:00Z",
      };
    },
  },
} as unknown as AppContextValue;
export const useAppContext = () => context;
