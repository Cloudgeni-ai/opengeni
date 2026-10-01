// Sample service responses only; the harness renders the production route/dialog.
import type { OpenGeniClient, SessionMessageSearchRequest } from "@opengeni/sdk";
import {
  fixtureClient,
  useAppContext as useStarterContext,
  useLatestCallback,
  workspaceId,
} from "./new-session-starters-context";

export { fixtureClient, useLatestCallback, workspaceId };
const context = { ...useStarterContext(), workspaceCapabilityCatalog: [] };
export const useAppContext = () => context;
export const discoveryEvidence = {
  titles: [] as Array<{ search?: string; parentSessionId?: string | null; limit?: number }>,
  messages: [] as SessionMessageSearchRequest[],
};
const rows = [
  ["Release readiness review", null],
  ["Release checklist", null],
  ["Release rollout notes", null],
  ["Customer onboarding", null],
  ["Workspace access cleanup", null],
  ["Search experience polish", null],
  ["Release CI review", "parent"],
  ["Release browser checks", "parent"],
].map(([title, parentSessionId], index) => ({
  id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
  title: title!,
  parentSessionId: parentSessionId ? "11111111-1111-4111-8111-000000000001" : null,
  workspaceId,
  status: "idle" as const,
  model: "qa-model",
  resources: [],
  initialMessage: "Check the release plan and confirm what is ready to ship.",
  pinned: false,
  createdAt: "2026-10-01T08:00:00Z",
  updatedAt: `2026-10-01T${String(9 - index).padStart(2, "0")}:00:00Z`,
}));
const message =
  "The **release** is ready for review.\n\n- Tests pass.\n- Browser checks cover desktop and mobile.\n- Ship after the independent review.";
Object.assign(fixtureClient, {
  connectTransport: () => ({}),
  listSessionPage: async (
    _workspace: string,
    options: { search?: string; parentSessionId?: string | null; limit?: number },
  ) => {
    discoveryEvidence.titles.push({ ...options });
    const scoped = rows.filter(
      (row) => options.parentSessionId !== null || row.parentSessionId === null,
    );
    const matched = options.search
      ? scoped.filter((row) => row.title.toLowerCase().includes(options.search!.toLowerCase()))
      : scoped;
    return { sessions: matched.slice(0, options.limit ?? 20), pinned: [], nextCursor: null };
  },
  searchSessionMessages: async (_workspace: string, request: SessionMessageSearchRequest) => {
    discoveryEvidence.messages.push({ ...request });
    const scoped = rows.filter((row) =>
      request.sessionId
        ? row.id === request.sessionId
        : (request.parentSessionId !== null || row.parentSessionId === null) &&
          row.title.startsWith("Release"),
    );
    const matches = scoped.map((row, index) => ({
      sessionId: row.id,
      sessionTitle: row.title,
      eventId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
      sequence: 1,
      turnId: null,
      role: "assistant" as const,
      messageId: null,
      messageMatchOffset: 6,
      snippet: { text: message, matchStart: 6, matchEnd: 13 },
    }));
    return {
      matches,
      nextCursor: null,
      hasMore: false,
      scannedMessages: scoped.length,
      matchedMessageCount: matches.length,
      matchedOccurrenceCount: matches.length,
      countIsExact: true,
    };
  },
  listEvents: async () => [],
  getSessionMessagePreview: async () => ({
    status: "available",
    text: message,
    messageStartOffset: 0,
    hasBefore: false,
    hasAfter: false,
  }),
} as unknown as Partial<OpenGeniClient>);
