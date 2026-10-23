// A parent session whose sub-sessions wait on the person: the production card
// pinned above the composer, with the real timeline, session chrome and
// composer around it. A scripted client stands in for the API; answering or
// deciding resolves the request and the tree re-read drops it, as on a real
// page. `?scenario=question|approval|stack|other`, `?light` for the light theme.
import { ChatComposer, MessageTimeline, SessionChrome } from "@opengeni/react";
import type { LineageNode, SessionEvent, SessionHumanInputRequest } from "@opengeni/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { DescendantRequests } from "@opengeni/react/app/components/session/descendant-requests";
import { Toaster } from "@opengeni/react/app/components/toaster";
import { t } from "@opengeni/react/app/lib/console-text";
import { sessionAgentsSignal } from "@opengeni/react/session-agents-model";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { waitingDescendants } from "../../../packages/react/src/app/lib/descendant-requests";
import {
  emptyAttachments,
  GALLERY_SESSION_ID,
  GALLERY_WORKSPACE_ID,
  galleryAgentNode,
  galleryQueue,
  idleComposer,
} from "../src/dev/composer-chrome-fixtures";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";
const scenario = (params.get("scenario") ?? "question") as
  | "question"
  | "approval"
  | "stack"
  | "other";

const workspaceId = GALLERY_WORKSPACE_ID;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function child(index: number, title: string, status: "requires_action" | "running", since = 4) {
  return galleryAgentNode(index, {
    status,
    title,
    titleSource: "user",
    metadata: { title },
    lastSequence: 40 + index,
    requiresActionSince: status === "requires_action" ? minutesAgo(since) : null,
  });
}

const reviewer = child(0, "Review PR #4418", "requires_action", 6);
const deployer = child(1, "Deploy staging worker", "requires_action", 3);
const migrator = child(2, "Backfill invoice totals", "requires_action", 1);
const tester = child(3, "Run browser tests", "running");
const signIn = child(4, "Sync Linear issues", "requires_action", 2);

const trees: Record<typeof scenario, LineageNode[]> = {
  question: [reviewer, tester],
  approval: [deployer, tester],
  stack: [reviewer, deployer, migrator, tester],
  other: [signIn, tester],
};

function humanInput(
  sessionId: string,
  id: string,
  questions: SessionHumanInputRequest["questions"],
): SessionHumanInputRequest {
  return {
    id,
    workspaceId,
    sessionId,
    turnId: "turn-1",
    turnGeneration: 1,
    creationAttemptId: `attempt-${id}`,
    toolCallId: `call-${id}`,
    status: "pending",
    questions,
    allowSkip: true,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: minutesAgo(5),
    updatedAt: minutesAgo(5),
  } as SessionHumanInputRequest;
}

const requests = new Map<string, SessionHumanInputRequest[]>([
  [
    reviewer.session.id,
    [
      humanInput(reviewer.session.id, "review-base", [
        {
          id: "base",
          kind: "single_select",
          prompt: "The fix also applies to the release branch. Where should it land?",
          options: [
            { id: "main", label: "main only" },
            { id: "both", label: "main and release/2026.10" },
          ],
          required: true,
          allowOther: true,
        },
      ]),
    ],
  ],
  [
    migrator.session.id,
    [
      humanInput(migrator.session.id, "backfill-window", [
        {
          id: "window",
          kind: "text",
          prompt: "Which months should the backfill cover?",
          options: [],
          required: true,
          allowOther: false,
        },
      ]),
    ],
  ],
]);

function childEvent(sessionId: string, sequence: number, type: string, payload: unknown) {
  return {
    id: `${sessionId}-${sequence}`,
    workspaceId,
    sessionId,
    sequence,
    type,
    payload,
    occurredAt: minutesAgo(3),
    turnId: "turn-1",
  } as SessionEvent;
}

const childEvents = new Map<string, SessionEvent[]>([
  [
    reviewer.session.id,
    [
      childEvent(reviewer.session.id, 38, "session.humanInput.requested", {
        request: { id: "review-base", questions: [] },
      }),
    ],
  ],
  [
    deployer.session.id,
    [
      childEvent(deployer.session.id, 37, "session.requiresAction", {
        approvals: [
          {
            id: "merge-4420",
            name: "github.merge_pull_request",
            arguments: { repository: "Cloudgeni-ai/opengeni", pullNumber: 4420 },
          },
        ],
      }),
    ],
  ],
]);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Page() {
  const [nodes, setNodes] = useState(() => trees[scenario]);
  const waiting = useMemo(() => waitingDescendants(nodes), [nodes]);
  const settle = (sessionId: string) =>
    setNodes((current) =>
      current.map((node) =>
        node.session.id === sessionId
          ? { ...node, session: { ...node.session, status: "running" } }
          : node,
      ),
    );
  const client = useMemo(
    () =>
      ({
        getSession: async () => {
          throw new Error("unused");
        },
        streamEvents: () => {
          throw new Error("unused");
        },
        listHumanInputRequests: async (_workspace: string, sessionId: string) => {
          await delay(40);
          return requests.get(sessionId) ?? [];
        },
        submitHumanInputResponse: async (
          _workspace: string,
          sessionId: string,
          requestId: string,
        ) => {
          await delay(300);
          const answered = requests.get(sessionId)?.find((item) => item.id === requestId);
          requests.set(sessionId, []);
          setTimeout(() => settle(sessionId), 200);
          return { ...answered, status: "answered" };
        },
        listEventPage: async (_workspace: string, sessionId: string) => {
          await delay(40);
          return { events: childEvents.get(sessionId) ?? [] };
        },
        sendApprovalDecision: async (_workspace: string, sessionId: string) => {
          await delay(300);
          childEvents.set(sessionId, []);
          setTimeout(() => settle(sessionId), 200);
          return {};
        },
        getToolActionReview: async (_workspace: string, _sessionId: string, approvalId: string) => {
          await delay(60);
          return {
            version: 1,
            id: approvalId,
            actionDigest: "merge-4420-digest",
            revision: "r1",
            status: "pending",
            title: "Merge pull request #4420",
            accountLabel: "GitHub - Cloudgeni-ai",
            effects: ["Merges into main"],
            samples: [],
            fields: [
              {
                path: "repository",
                label: "Repository",
                preview: "Cloudgeni-ai/opengeni",
                truncated: false,
              },
              { path: "pullNumber", label: "Pull request", preview: "4420", truncated: false },
            ],
            moreFields: 0,
            reason: "Merging changes the main branch.",
            createdAt: minutesAgo(3),
            updatedAt: minutesAgo(3),
            approveLabel: "Merge",
            availableActions: ["approve", "reject"],
            detailsAvailable: false,
          };
        },
        getToolReviewDetails: async () => {
          throw new Error("unused");
        },
      }) as never,
    [],
  );
  const events = useMemo(() => parentTimeline(), []);
  const queue = useMemo(() => galleryQueue(), []);
  return (
    <TooltipProvider>
      <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 text-sm font-medium">
          Ship the October release
        </header>
        <div className="min-h-0 flex-1">
          <MessageTimeline className="h-full" events={events} />
        </div>
        <div className="mb-2 w-full shrink-0 px-4 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <DescendantRequests
              client={client}
              workspaceId={workspaceId}
              parentSessionId={GALLERY_SESSION_ID}
              waiting={waiting}
              onOpenSession={(sessionId, at) =>
                console.info("open sub-session", sessionId, at ?? "latest")
              }
            />
            <SessionChrome
              sessionStatus="running"
              queue={queue}
              agentsSignal={sessionAgentsSignal(t, nodes)}
              // The app mounts the sub-session tree here; the pill is what matters.
              agentsPanel={<div className="p-3 text-sm text-fg-muted">Sub-sessions</div>}
            />
          </div>
        </div>
        <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <ChatComposer
              composer={idleComposer({ value: "", canSend: false })}
              attachments={emptyAttachments()}
              placeholder="Message"
            />
          </div>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

function parentTimeline(): SessionEvent[] {
  const event = (sequence: number, type: string, payload: unknown) =>
    ({
      id: `parent-${sequence}`,
      workspaceId,
      sessionId: GALLERY_SESSION_ID,
      sequence,
      type,
      payload,
      occurredAt: minutesAgo(12 - sequence),
      turnId: "turn-1",
    }) as SessionEvent;
  return [
    event(1, "user.message", {
      text: "Get the October release ready: review the open PRs, deploy staging, and backfill invoice totals.",
    }),
    event(2, "turn.started", {}),
    event(3, "agent.message.completed", {
      messageId: "m1",
      text: "I started a sub-session for each part: one reviews PR #4418, one deploys the staging worker, one backfills invoice totals, and one runs the browser tests. I'll report back as they finish.",
    }),
  ];
}

createRoot(document.getElementById("root")!).render(<Page />);
