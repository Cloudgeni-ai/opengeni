// MCP connect card preview: the console's real SessionCapabilityCard inside
// the real MessageTimeline, for the turn where the agent posts a connect card
// for a reviewed catalog service (Google Calendar) or for a server someone
// added by hand. Catalog and connection state come from a synthetic client,
// so nothing reaches an API or the service.
//   ?service=calendar|added|gmail-step-up|gmail-fixed   ?theme=light|dark
// gmail-step-up: a connected account that needs more access for one tool, as
// the session renders it (the stock row naming the action, for that exact
// account). The agent hit it twice: the chat shows one card.
//   ?state=waiting|done shows the card while Google's page is open, or after
//   the person allowed it (press the button to see it).
// gmail-approval: the same access for a tool set to Ask first: one approval
// for the action, whose Approve asks Google first (?state=waiting).
// gmail-pinned: the chat after the agent stopped on that card and more
// messages came in: the card stays above the composer until it is done, and
// the sidebar marks the chat as needing you (the orange dot).
// gmail-fixed: the same tool on an account whose access is fixed (for example
// managed by an integration platform): the stock row, with no action.
// Open the card's setup dialog with its button to see the dialog.
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectTransport } from "@opengeni/connect";
import {
  toolReviewAction,
  toolReviewFields,
  type CapabilityCatalogItem,
  type SessionEvent,
  type ToolActionReview,
} from "@opengeni/sdk";
import {
  ApprovalSurface,
  MessageTimeline,
  OpenGeniProvider,
  sessionAuthRecommendation,
  useOpenGeniText,
  buildTimeline,
  type AuthNeededItem,
} from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import { EventLog } from "./timeline-fixtures";
import { AuthNeededRow } from "../src/components/auth-needed-row";
import { pendingConnectionCard } from "../src/timeline/pending-connection-card";
import { SessionRowContent } from "@opengeni/react/app/components/rail/session-row-content";
import { summarizeRailRow } from "@opengeni/react/app/lib/sessions-group";
import { sessionStateLabel } from "@opengeni/react/app/lib/session-rail";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "session-connect";
const params = new URLSearchParams(window.location.search);
const serviceParam = params.get("service");
const service =
  serviceParam === "added" ||
  serviceParam === "gmail-step-up" ||
  serviceParam === "gmail-fixed" ||
  serviceParam === "gmail-approval" ||
  serviceParam === "gmail-pinned"
    ? serviceParam
    : "calendar";
const dark = params.get("theme") === "dark";
const recoveryState = params.get("state");

const CALENDAR = {
  id: "mcp:catalog:google-calendar",
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
  name: "Google Calendar",
  enabled: false,
  stale: false,
  mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
  providerDomain: "calendarmcp.googleapis.com",
  description:
    "See what's on your calendar, check when you're free, and add, move or cancel events in your Google Calendar.",
  metadata: {
    defaultConnectionOwnership: "personal",
    presentation: {
      providerName: "Google",
      icon: "calendar",
      introduction: "Let agents work with the Google Calendar you choose.",
      capabilities: [
        {
          title: "Answer questions about your schedule",
          description: "See what's on today, tomorrow or any week, in your own time zone.",
        },
        {
          title: "Find free time",
          description: "Check when you, or people who share their calendar with you, are free.",
        },
        {
          title: "Add and change events",
          description:
            "Create, move, update or delete events. You choose which actions need approval.",
        },
      ],
      permissionSummary:
        "Google asks to see your list of calendars, see and edit events, and see when you are free or busy.",
    },
  },
} as unknown as CapabilityCatalogItem;

const ADDED = {
  id: "mcp:custom:tickets",
  kind: "mcp",
  source: "manual",
  authKind: "oauth2",
  name: "Tickets",
  enabled: false,
  stale: false,
  mcpUrl: "https://mcp.tickets.example.com/mcp",
  providerDomain: "mcp.tickets.example.com",
  description: "Read and update support tickets.",
  metadata: {},
} as unknown as CapabilityCatalogItem;

const item = service === "added" ? ADDED : CALENDAR;

// Nothing is pending and a connect never starts here: the preview shows the
// card and its setup dialog before the person presses Connect.
const transport = {
  catalog: async () => [],
  accounts: async () => [],
  pending: async () => [],
  begin: async () => {
    throw new Error("Connecting is not part of this preview");
  },
  get: async () => {
    throw new Error("No attempt in this preview");
  },
  advance: async () => {
    throw new Error("No attempt in this preview");
  },
  cancel: async () => {
    throw new Error("No attempt in this preview");
  },
  disconnect: async () => {},
} as unknown as ConnectTransport;

class PreviewClient extends MockOpenGeniClient {
  connectTransport() {
    return transport as never;
  }
  async listCapabilities() {
    return { items: [item] } as never;
  }
  async listConnections() {
    return [] as never;
  }
  async listOwnConnectionAccounts() {
    return [] as never;
  }
  async listWorkspaceMembers() {
    return [] as never;
  }
  async downloadCatalogAsset(): Promise<Blob> {
    throw new Error("No catalog assets in this preview");
  }
}

const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const APPROVAL_ARGS = {
  messageIds: Array.from({ length: 12 }, (_, index) => `m-${index + 1}`),
  removeLabelIds: ["UNREAD"],
};
const APPROVAL = {
  id: "call-mark-read",
  name: "mcp_gmail__batch_modify_messages",
  arguments: APPROVAL_ARGS,
};
/** The saved review the server returns for that call, as it builds it. */
function approvalReview(): ToolActionReview {
  const context = { kind: "gmail" as const, accountLabel: "kari@example.com" };
  return {
    version: 1,
    id: APPROVAL.id,
    actionDigest: "digest",
    revision: "1",
    status: "pending",
    ...toolReviewAction("batch_modify_messages", APPROVAL_ARGS, context),
    toolName: "batch_modify_messages",
    accountLabel: context.accountLabel,
    samples: [
      {
        id: "m-1",
        title: "Daily standup notes",
        subtitle: "Native",
        provenance: "provider_metadata",
      },
      {
        id: "m-2",
        title: "Your sign-in code",
        subtitle: "Vercel",
        provenance: "provider_metadata",
      },
    ],
    ...toolReviewFields(APPROVAL_ARGS, context, "batch_modify_messages"),
    reason: "This action is set to Ask first.",
    reasonCode: "asks_by_setting",
    createdAt: "2026-11-19T12:00:00.000Z",
    updatedAt: "2026-11-19T12:00:00.000Z",
    availableActions: ["approve", "reject"],
    accessNeeded: {
      providerDomain: "gmailmcp.googleapis.com",
      connectionId: "conn-gmail-1",
      scopes: [MODIFY],
    },
    detailsAvailable: true,
  };
}

function events(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-connect";
  if (service === "gmail-approval") {
    log.push("user.message", { text: "Mark the newsletters in my inbox as read." });
    return log.events;
  }
  if (service === "gmail-step-up" || service === "gmail-fixed" || service === "gmail-pinned") {
    const fixed = service === "gmail-fixed";
    log.push("user.message", { text: "Mark the newsletters in my inbox as read." });
    const needed = {
      serverId: "gmail",
      toolName: "batch_modify_messages",
      providerDomain: "gmailmcp.googleapis.com",
      connectionId: "conn-gmail-1",
      ...(fixed
        ? { reason: "unsupported_auth", accountReason: "account_scope_fixed" }
        : { reason: "insufficient_scope" }),
      scopes: [MODIFY],
    };
    log.push("tool.auth_needed", needed, turn);
    // The agent retried the same tool before reading the answer.
    if (!fixed) log.push("tool.auth_needed", needed, turn);
    log.push(
      "agent.message.completed",
      {
        text: fixed
          ? "The connected Gmail account can't change messages, so nothing was marked as read."
          : "Nothing is marked as read yet. Allow it in the chat and I'll carry on.",
      },
      turn,
    );
    log.push("turn.completed", {}, turn);
    if (service === "gmail-pinned") {
      // Later updates would push the card out of view; it stays pinned.
      const later = "turn-later";
      log.push(
        "agent.message.completed",
        {
          text: "The research agent finished: two emails need a reply from you (Boardy intro, Gemini retirement).",
        },
        later,
      );
      log.push("turn.completed", {}, later);
    }
    return log.events;
  }
  log.push("user.message", {
    text: service === "added" ? "Close the ticket about the login bug." : "Am I free on Friday?",
  });
  log.push(
    "tool.auth_needed",
    {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: item.providerDomain,
      reason: "missing_connection",
      capability: {
        id: item.id,
        name: item.name,
        kind: "mcp",
        source: item.source,
        action: "connect",
        rationale:
          service === "added"
            ? "Connect Tickets so I can close the ticket."
            : "Connect your Google Calendar so I can check Friday.",
        requiredVariables: [],
      },
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    { text: "Connect it with the card above and I'll carry on." },
    turn,
  );
  log.push("turn.completed", {}, turn);
  return log.events;
}

const NOW = Date.now();
const RAIL = [
  { id: "s-inbox", title: "Inbox cleanup", status: "idle", awaiting: true },
  { id: "s-ideas", title: "Product ideas", status: "idle", awaiting: false },
  { id: "s-audit", title: "API audit", status: "running", awaiting: false },
].map((row) => ({
  title: row.title,
  session: {
    id: row.id,
    workspaceId: WORKSPACE_ID,
    title: row.title,
    status: row.status,
    effectiveControl: { state: "active" },
    unread: false,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 120_000).toISOString(),
    ...(row.awaiting ? { awaitingConnectionSince: new Date(NOW - 120_000).toISOString() } : {}),
  } as never,
}));

/** The sidebar's rows, as the rail draws them. */
function RailPreview() {
  return (
    <nav className="w-[260px] shrink-0 border-r border-border bg-surface px-2 py-4">
      {RAIL.map(({ title, session }) => (
        <div
          key={title}
          className="flex h-9 items-center gap-1 rounded-sm px-2 text-sm text-fg hover:bg-surface-2"
        >
          <SessionRowContent
            title={title}
            stateLabel={sessionStateLabel(session)}
            mobile={false}
            summary={summarizeRailRow({ session, children: [], hasActiveDescendant: false })}
            relativeTime="2m"
          />
        </div>
      ))}
    </nav>
  );
}

function Preview() {
  const t = useOpenGeniText();
  const client = useMemo(() => new PreviewClient(), []);
  // As the session page does: the card the agent waits on leaves the
  // timeline and stays above the composer.
  const allItems = useMemo(() => buildTimeline(t, events()), [t]);
  const pinned = service === "gmail-pinned" ? pendingConnectionCard(allItems, () => true) : null;
  const pinnedItems = allItems.filter((entry) => entry !== pinned);
  const reconnect = () =>
    recoveryState === "done"
      ? Promise.resolve({ outcome: "done" as const })
      : recoveryState === "waiting"
        ? new Promise<never>(() => {})
        : undefined;
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          subjectId: "user:kari",
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              permissions: [
                "sessions:control",
                "workspace:admin",
                "connections:write",
                "capabilities:write",
              ],
            },
          ],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "team" }],
        workspaceCapabilityCatalog: [item],
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{
          api: { apiBaseUrl: "https://app.opengeni.ai" } as never,
          navigation: undefined as never,
        }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root flex h-screen overflow-auto bg-bg text-fg">
            {service === "gmail-pinned" ? <RailPreview /> : null}
            <main className="mx-auto max-w-[760px] flex-1 px-4 py-8" data-shot="">
              <MessageTimeline
                {...(service === "gmail-pinned" ? { items: pinnedItems } : {})}
                trailingState={
                  pinned ? (
                    <div className="pb-1" data-pinned-connection-card="">
                      <AuthNeededRow item={pinned} onReconnect={reconnect} />
                    </div>
                  ) : undefined
                }
                events={events()}
                renderAuthNeeded={(entry: AuthNeededItem) => {
                  // The session's own choice: a recommendation card, or the
                  // stock row when there is nothing to recommend.
                  const recommendation = sessionAuthRecommendation(t, entry, [item]);
                  return recommendation ? (
                    <SessionCapabilityCard
                      item={recommendation}
                      workspaceId={WORKSPACE_ID}
                      sessionId={SESSION_ID}
                    />
                  ) : undefined;
                }}
                onReconnect={reconnect}
              />
              {service === "gmail-approval" ? (
                <ApprovalSurface
                  approvals={[APPROVAL]}
                  loadReview={async () => approvalReview()}
                  onAllowAccess={() =>
                    recoveryState === "waiting"
                      ? new Promise<boolean>(() => {})
                      : Promise.resolve(true)
                  }
                  onApprove={() => new Promise<void>(() => {})}
                  onReject={() => undefined}
                />
              ) : null}
            </main>
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
