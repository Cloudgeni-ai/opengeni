import type { InboxItem } from "@opengeni/sdk";
import type { AppContextValue } from "@opengeni/react/app/app-context";

const at = new Date(Date.now() - 12 * 60_000).toISOString();
const base = {
  workspaceId: "fixture",
  sessionTitle: "Release checks",
  subtitle: "",
  facts: [],
  link: null,
  eventSequence: 1,
  choices: [],
  urgency: "normal",
  status: "open",
  unread: false,
  snoozedUntil: null,
  createdAt: at,
  updatedAt: at,
  resolvedAt: null,
  sessionAvailable: true,
} as const;
let items: InboxItem[] = [
  {
    ...base,
    id: "approval",
    sessionId: "s1",
    kind: "approval",
    sourceKey: "a1",
    title: "Run a command on the build machine",
    body: "bun run deploy --env staging",
  },
  {
    ...base,
    id: "server-confirmation",
    sessionId: "s4",
    kind: "approval",
    sourceKey: "a2",
    title: "Share “Q3 plan” with everyone in the Design team?",
    body: "Share document",
    serverQuestion: { server: "Docs", kind: "confirm" },
  },
  {
    ...base,
    id: "server-form",
    sessionId: "s5",
    kind: "approval",
    sourceKey: "a3",
    title: "Which folder should the budget go in?",
    body: "Save document",
    serverQuestion: { server: "Docs", kind: "form" },
  },
  {
    ...base,
    id: "server-page",
    sessionId: "s6",
    kind: "approval",
    sourceKey: "a4",
    title: "Sign in to your Docs work account to continue.",
    body: "Export document",
    serverQuestion: {
      server: "Docs",
      kind: "url",
      url: "https://accounts.example.com/sign-in?account=work",
    },
  },
  {
    ...base,
    id: "notification",
    sessionId: "s2",
    kind: "notification",
    sourceKey: "n1",
    title: "Nightly build finished",
    subtitle: "All 214 checks passed",
    body: "The staging deploy is live and the smoke tests are green.",
    unread: true,
  },
  {
    ...base,
    id: "reply",
    sessionId: "s3",
    kind: "reply",
    sourceKey: "r1",
    title: "Research summary is ready",
    body: "I compared the three vendors and wrote up the tradeoffs.",
  },
];
export const activity = {
  updates: [] as Array<{ id: string; body: unknown }>,
  decisions: [] as Array<{ sessionId: string; body: unknown }>,
};
Object.assign(window, { inboxFixture: activity });
const context = {
  accessContext: { subjectId: "user:fixture", mode: "hosted", workspaceGrants: [] },
  workspaces: [{ id: "fixture", name: "Fixture" }],
  workspaceStateOwnerId: "fixture",
  captureWorkspaceInvocation: () => "fixture",
  ownsWorkspaceInvocation: () => true,
  client: {
    listInbox: async () => ({
      items,
      needsYouCount: items.filter((item) => item.kind === "approval").length,
      unreadCount: items.filter((item) => item.unread).length,
    }),
    updateInboxItem: async (id: string, body: { dismissed?: boolean }) => {
      activity.updates.push({ id, body });
      if (body.dismissed) items = items.filter((item) => item.id !== id);
      return {};
    },
    getInboxSettings: async () => ({ tidyPolicy: "own_sessions" }),
    listWorkspaceMembers: async () => [],
    getMemberNotifications: async () => ({ allowOthers: true }),
    getToolActionReview: async (_workspaceId: string, _sessionId: string, id: string) => ({
      id,
      title: "Save document",
      accountLabel: "Budget 2027",
      question: {
        server: "Docs",
        requests: [
          {
            id: "q1",
            message: "Which folder should the budget go in?",
            requestedSchema: {
              type: "object",
              properties: {
                folder: {
                  type: "string",
                  title: "Folder",
                  oneOf: [
                    { const: "finance", title: "Finance" },
                    { const: "planning", title: "Planning" },
                    { const: "shared", title: "Shared with leadership" },
                  ],
                },
                note: { type: "string", title: "Note for the team" },
              },
              required: ["folder"],
            },
          },
        ],
      },
    }),
    sendApprovalDecision: async (
      _workspaceId: string,
      sessionId: string,
      body: { approvalId: string },
    ) => {
      activity.decisions.push({ sessionId, body });
      items = items.filter((item) => item.sourceKey !== body.approvalId);
      return {};
    },
  },
} as unknown as AppContextValue;
export const useAppContext = () => context;
