import type { InboxItem } from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";

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
export const activity = { updates: [] as Array<{ id: string; body: unknown }> };
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
  },
} as unknown as AppContextValue;
export const useAppContext = () => context;
