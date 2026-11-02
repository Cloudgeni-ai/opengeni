import { ApprovalSurface, type PendingApproval } from "@opengeni/react";
import { SecretsUiProvider } from "@opengeni/react/session-ui";
import {
  OpenGeniApiError,
  toolReviewAction,
  toolReviewDetails,
  toolReviewFields,
  type ToolActionReview,
} from "@opengeni/sdk";
import type { ToolReviewContext } from "@opengeni/contracts";

import { webSecretsUi } from "@opengeni/react/app/lib/secrets-ui";
import DescendantRequests, {
  type DescendantRequestsClient,
} from "@opengeni/react/app/components/session/descendant-requests";
import { KitBlock, KitSection, StateCell, StatesGrid } from "../kit";
import { ChatFrame, kitEvent, lead, showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   Tool and action approvals, rendered by the real ApprovalSurface with
   reviews built by the same presentation functions the server uses.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Scene = {
  approval: PendingApproval;
  review: ToolActionReview | null;
  context?: ToolReviewContext;
};

function scene(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  options: {
    context?: ToolReviewContext;
    display?: PendingApproval["display"];
    reason?: string;
    legacy?: boolean;
  } = {},
): Scene {
  const approval: PendingApproval = {
    id: `kit-${id}`,
    name: toolName,
    arguments: JSON.stringify(args),
    ...(options.display ? { display: options.display } : {}),
  };
  if (options.legacy) return { approval, review: null };
  const action = toolReviewAction(toolName, args, options.context);
  const { fields, moreFields } = toolReviewFields(args, options.context, toolName);
  const review = {
    version: 1,
    id: approval.id,
    actionDigest: `kit-${id}`,
    revision: "kit-1",
    status: "pending",
    ...action,
    ...(options.context?.accountLabel ? { accountLabel: options.context.accountLabel } : {}),
    samples: options.context?.samples ?? [],
    fields,
    moreFields,
    reason: options.reason ?? "",
    createdAt: "2026-09-26T11:48:00Z",
    updatedAt: "2026-09-26T11:48:00Z",
    availableActions: ["approve", "reject"],
    detailsAvailable: true,
  } as ToolActionReview;
  return { approval, review, ...(options.context ? { context: options.context } : {}) };
}

const EMAIL_BODY = [
  "Hi Sam,",
  "",
  "Thanks for the call today. As promised, here is the summary of what we agreed:",
  "",
  "- We move the launch to 12 November.",
  "- Your team sends the final copy by Friday.",
  "- I book the photographer for the week after.",
  "",
  "Talk soon,",
  "Alex",
].join("\n");

const SEND_EMAIL = scene(
  "email",
  "send_message",
  { raw: "…", expectedContentSha256: "0".repeat(64) },
  {
    display: { toolName: "send_message", connector: "Gmail", providerDomain: "gmail.com" },
    context: {
      kind: "gmail",
      // Long enough to wrap under the status at phone width.
      accountLabel: "Gmail · alex.morgan@example.com",
      email: {
        from: "alex@example.com",
        to: "sam@example.org",
        cc: "",
        bcc: "",
        subject: "Summary of today's call",
        textBody: EMAIL_BODY,
        htmlBody: "",
        contentSha256: "0".repeat(64),
        attachments: [{ name: "launch-plan.pdf", mediaType: "application/pdf", bytes: 248_000 }],
      },
    },
  },
);

const TRASH = scene(
  "trash",
  "batch_modify_messages",
  {
    messageIds: Array.from({ length: 37 }, (_, index) => `m-${index}`),
    addLabelIds: ["TRASH"],
    removeLabelIds: ["INBOX"],
  },
  {
    display: { toolName: "batch_modify_messages", connector: "Gmail", providerDomain: "gmail.com" },
    context: {
      kind: "gmail",
      samples: [
        {
          id: "m-0",
          title: "Your weekly digest",
          subtitle: "news@example.com",
          provenance: "provider_metadata",
        },
        {
          id: "m-1",
          title: "50% off this weekend only",
          subtitle: "deals@shop.example",
          provenance: "provider_metadata",
        },
        {
          id: "m-2",
          title: "Reminder: webinar tomorrow",
          subtitle: "events@example.net",
          provenance: "provider_metadata",
        },
      ],
    },
  },
);

const PULL_REQUEST = scene(
  "pr",
  "mcp_github__create_pull_request",
  {
    owner: "acme",
    repo: "storefront",
    title: "Fix rounding in cart totals",
    head: "fix/cart-rounding",
    base: "main",
    body: "Totals were rounded per line instead of once per cart, so carts with many cheap items could be off by a cent.\n\nAdds a regression test.",
    draft: true,
  },
  {
    display: { toolName: "create_pull_request", connector: "GitHub", providerDomain: "github.com" },
  },
);

const DELETE_BRANCH = scene(
  "branch",
  "mcp_github__delete_branch",
  { owner: "acme", repo: "storefront", branch: "release/2.3" },
  { display: { toolName: "delete_branch", connector: "GitHub", providerDomain: "github.com" } },
);

const APP_ACTION = scene(
  "app",
  "admin_action_call",
  {
    actionId: "organization.members.invite",
    method: "POST",
    path: "/v1/organizations/org/invitations",
    body: { email: "kim@example.com", role: "member" },
  },
  { context: { kind: "generic", title: "Invite kim@example.com to your organization?" } },
);

const LEGACY = scene(
  "legacy",
  "create_calendar_event",
  {
    summary: "Design review",
    start: "2026-09-29T10:00:00+02:00",
    end: "2026-09-29T11:00:00+02:00",
    attendees: ["sam@example.org", "kim@example.com"],
  },
  { legacy: true },
);

// Four parallel calls of one step, as in a cleanup the person approves one by one.
const DELETE_CONNECTIONS = ["Linear", "Notion", "Slack", "Jira"].map((name) =>
  scene(
    `delete-${name.toLowerCase()}`,
    "admin_action_call",
    {
      actionId: "workspace.connections.delete",
      method: "DELETE",
      path: `/v1/workspaces/ws/connections/${name.toLowerCase()}`,
    },
    { context: { kind: "generic", title: `Delete the ${name} connection?` } },
  ),
);

const SCENES = [
  SEND_EMAIL,
  TRASH,
  PULL_REQUEST,
  DELETE_BRANCH,
  APP_ACTION,
  LEGACY,
  ...DELETE_CONNECTIONS,
];

const loadReview = async (approval: PendingApproval): Promise<ToolActionReview> => {
  const found = SCENES.find((entry) => entry.approval.id === approval.id);
  if (!found?.review) throw new OpenGeniApiError(404, "Review not found");
  return found.review;
};

const loadDetails = async (review: ToolActionReview, path: string, offset: number) => {
  const found = SCENES.find((entry) => entry.approval.id === review.id)!;
  return {
    version: 1 as const,
    id: review.id,
    actionDigest: review.actionDigest,
    ...toolReviewDetails(found.approval.arguments, found.context, path, offset),
  };
};

function Surface({
  scenes,
  error,
  responding,
}: {
  scenes: Scene[];
  error?: string;
  responding?: boolean;
}) {
  return (
    <ApprovalSurface
      approvals={scenes.map((entry) => entry.approval)}
      loadReview={loadReview}
      loadDetails={loadDetails}
      onViewDetails={() => undefined}
      responding={responding}
      error={error ?? null}
      onApprove={async () => wait(900)}
      onReject={async () => wait(900)}
    />
  );
}

/**
 * A sub-session resuming from the first of its parallel approvals, decided on
 * its card in the parent chat: the card keeps the rest decidable meanwhile.
 */
const RESUMING_CHILD = {
  id: "session-kit-cleanup",
  workspaceId: "ws-kit",
  status: "running",
  title: "Clean up old connections",
  titleSource: "user",
  lastSequence: 12,
  createdAt: "2026-09-26T11:40:00Z",
  updatedAt: "2026-09-26T11:48:00Z",
  requiresActionSince: null,
} as never;

const resumingChildClient = {
  getSession: async () => RESUMING_CHILD,
  streamEvents: async function* () {},
  listHumanInputRequests: async () => [],
  submitHumanInputResponse: async () => {
    throw new OpenGeniApiError(409, "No question is waiting");
  },
  listEventPage: async () => ({
    events: [
      kitEvent("session.requiresAction", {
        approvals: DELETE_CONNECTIONS.map((entry) => entry.approval),
      }),
      kitEvent("user.approvalDecision", {
        approvalId: DELETE_CONNECTIONS[0]!.approval.id,
        decision: "approve",
      }),
    ],
  }),
  getToolActionReview: async (_workspaceId: string, _sessionId: string, approvalId: string) =>
    await loadReview({ id: approvalId } as PendingApproval),
  getToolReviewDetails: async () => {
    throw new OpenGeniApiError(404, "Details not found");
  },
  sendApprovalDecision: async () => {
    await wait(900);
    return {};
  },
  sendMessage: async () => ({}),
} as unknown as DescendantRequestsClient;

export default function ChatApprovalsSection() {
  return (
    <SecretsUiProvider value={webSecretsUi}>
      <KitSection sectionKey="chat-approvals">
        {showPart("chat") ? (
          <KitBlock
            title="In the chat"
            description="The approval sits at the end of the conversation while the turn waits."
          >
            <ChatFrame
              events={[
                ...lead(
                  "Write Sam a short summary of today's call and send it.",
                  "Here's the email. It needs your OK before it goes out.",
                ),
                kitEvent("session.requiresAction", { approvals: [SEND_EMAIL.approval] }),
              ]}
              height={720}
            >
              <Surface scenes={[SEND_EMAIL]} />
            </ChatFrame>
          </KitBlock>
        ) : null}

        {showPart("resuming") ? (
          <KitBlock
            title="While a decision resumes the turn"
            description="The first of four parallel actions was approved and the turn resumes. The other three stay up and can be decided right away; the decided one is not asked again."
          >
            <ChatFrame
              status="running"
              events={[
                ...lead(
                  "Delete the four connections we no longer use.",
                  "Each deletion needs your OK.",
                ),
                kitEvent("session.requiresAction", {
                  approvals: DELETE_CONNECTIONS.map((entry) => entry.approval),
                }),
                kitEvent("user.approvalDecision", {
                  approvalId: DELETE_CONNECTIONS[0]!.approval.id,
                  decision: "approve",
                }),
                kitEvent("session.status.changed", { status: "running" }),
              ]}
              height={640}
            >
              <Surface scenes={DELETE_CONNECTIONS.slice(1)} />
            </ChatFrame>
          </KitBlock>
        ) : null}

        {showPart("resuming-sub-session") ? (
          <KitBlock
            title="A sub-session's approvals while it resumes"
            description="Decided on the sub-session's card in the parent chat: the card stays while the sub-session resumes, with only the undecided actions."
          >
            <DescendantRequests
              client={resumingChildClient}
              workspaceId="ws-kit"
              parentSessionId="session-kit"
              waiting={[RESUMING_CHILD]}
            />
          </KitBlock>
        ) : null}

        {showPart("kinds") ? (
          <StatesGrid title="Kinds" columns={2}>
            <StateCell label="Send an email" align="stretch">
              <Surface scenes={[SEND_EMAIL]} />
            </StateCell>
            <StateCell label="Move 37 emails to Trash" align="stretch">
              <Surface scenes={[TRASH]} />
            </StateCell>
          </StatesGrid>
        ) : null}
        {showPart("kinds2") ? (
          <StatesGrid title="Kinds" columns={2}>
            <StateCell label="Connector tool (open a pull request)" align="stretch">
              <Surface scenes={[PULL_REQUEST]} />
            </StateCell>
            <StateCell label="Destructive connector tool" align="stretch">
              <Surface scenes={[DELETE_BRANCH]} />
            </StateCell>
            <StateCell label="Opengeni app action" align="stretch">
              <Surface scenes={[APP_ACTION]} />
            </StateCell>
            <StateCell label="Without a saved review" align="stretch">
              <Surface scenes={[LEGACY]} />
            </StateCell>
          </StatesGrid>
        ) : null}

        {showPart("states") ? (
          <StatesGrid title="States" columns={2}>
            <StateCell label="Three waiting" align="stretch">
              <Surface scenes={[PULL_REQUEST, DELETE_BRANCH, SEND_EMAIL]} />
            </StateCell>
            <StateCell label="Deciding" align="stretch">
              <Surface scenes={[PULL_REQUEST]} responding />
            </StateCell>
            <StateCell label="Decision failed" align="stretch">
              <Surface scenes={[PULL_REQUEST]} error="The approval couldn't be saved. Try again." />
            </StateCell>
          </StatesGrid>
        ) : null}
      </KitSection>
    </SecretsUiProvider>
  );
}
