/* ----------------------------------------------------------------------------
   Approval-stack bottom-follow browser regression harness.

   Mirrors the session route: the real MessageTimeline (rolling turns) is a
   flex-1 child of a fixed-height column with the real ApprovalSurface as its
   trailing state, and an in-flow composer below. Each decision resolves a
   moment later and removes its card; the next card mounts in its loading
   state and grows when its saved review arrives, exactly as a queue of Gmail
   "Create email draft" approvals does in the app.
   -------------------------------------------------------------------------- */
import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ApprovalSurface,
  MessageTimeline,
  type PendingApproval,
  type TimelineItem,
} from "@opengeni/react";
import { toolReviewAction, toolReviewFields, type ToolActionReview } from "@opengeni/contracts";
import "./styles.css";

type ApprovalFollowHarness = {
  metrics: () => {
    distanceFromTip: number;
    scrollTop: number;
    following: boolean;
    approvalsLeft: number;
    /** The newest card's approve button is fully visible inside the scroller. */
    approveVisible: boolean;
  };
  appendAgentText: (text: string) => void;
  setComposerHeight: (px: number) => void;
};

declare global {
  interface Window {
    approvalFollowHarness?: ApprovalFollowHarness;
  }
}

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const COUNT = Number(params.get("count") ?? 10);
const context = { kind: "gmail" as const, accountLabel: "Gmail · person@example.test" };

function draftArguments(index: number) {
  return {
    to: [`person${index}@example.test`],
    subject: "What happened with Opengeni?",
    body: "Hi there,\n\nYou gave Opengeni a proper try but didn't come back after that. Honestly, that's the most useful thing for us to understand right now. Could you tell me what got in the way?",
  };
}

function savedReview(id: string, index: number): ToolActionReview {
  const args = draftArguments(index);
  return {
    version: 1,
    id,
    actionDigest: "a".repeat(64),
    revision: "1",
    status: "pending",
    ...toolReviewAction("create_draft", args, context),
    ...toolReviewFields(args, context),
    accountLabel: context.accountLabel,
    reason: "This action asks first by default.",
    createdAt: "2026-01-01T12:00:00Z",
    updatedAt: "2026-01-01T12:00:00Z",
    availableActions: ["approve", "reject"],
    detailsAvailable: false,
  };
}

const history: TimelineItem[] = Array.from({ length: 10 }, (_, index) => ({
  kind: "user-message",
  id: `history-${index}`,
  text: `Earlier message ${index}. `.repeat(10),
  resources: [],
  tools: [],
  occurredAt: new Date(1_750_000_000_000 + index * 1_000).toISOString(),
}));

function Harness() {
  const [remaining, setRemaining] = useState(() =>
    Array.from({ length: COUNT }, (_, index) => index),
  );
  const [agentText, setAgentText] = useState("I've prepared a draft for each person.");
  const [composerHeight, setComposerHeight] = useState(112);
  const approvals: PendingApproval[] = remaining.map((index) => ({
    id: `draft-${index}`,
    name: "create_draft",
    arguments: draftArguments(index),
  }));
  const items: TimelineItem[] = [
    ...history,
    {
      kind: "agent-message",
      id: "agent-1",
      turnId: "turn-1",
      text: agentText,
      occurredAt: new Date(1_750_000_100_000).toISOString(),
    },
  ];
  const loadReview = useCallback(
    (approval: PendingApproval) =>
      new Promise<ToolActionReview>((resolve) =>
        setTimeout(
          () => resolve(savedReview(approval.id, Number(approval.id.slice("draft-".length)))),
          200,
        ),
      ),
    [],
  );
  const decide = (approval: PendingApproval) =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        setRemaining((current) => current.filter((index) => `draft-${index}` !== approval.id));
        resolve();
      }, 150),
    );

  useEffect(() => {
    const scroller = () => document.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    window.approvalFollowHarness = {
      metrics: () => {
        const node = scroller();
        const view = node.getBoundingClientRect();
        const approve = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Create draft",
        );
        const box = approve?.getBoundingClientRect();
        return {
          distanceFromTip: node.scrollHeight - node.clientHeight - node.scrollTop,
          scrollTop: node.scrollTop,
          following: node.getAttribute("data-og-bottom-follow") === "true",
          approvalsLeft: document.querySelectorAll("[data-approval-id]").length,
          approveVisible: Boolean(box && box.top >= view.top && box.bottom <= view.bottom),
        };
      },
      appendAgentText: (text) => flushSync(() => setAgentText((current) => current + text)),
      setComposerHeight: (px) => flushSync(() => setComposerHeight(px)),
    };
    return () => {
      delete window.approvalFollowHarness;
    };
  }, []);

  return (
    <div
      className="og-root flex h-full flex-col bg-og-bg text-og-fg"
      data-og-theme={theme}
      style={{ colorScheme: theme }}
    >
      <div className="min-h-0 min-w-0 flex-1">
        <MessageTimeline
          className="h-full"
          turnSummary={{ rolling: true }}
          items={items}
          status="requires_action"
          trailingState={
            approvals.length > 0 ? (
              <ApprovalSurface
                approvals={approvals}
                loadReview={loadReview}
                onApprove={decide}
                onReject={decide}
              />
            ) : null
          }
        />
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div
          data-composer
          className="mx-auto w-full max-w-3xl rounded-og-lg border border-og-border bg-og-surface-1 p-4 text-og-fg-muted"
          style={{ height: composerHeight }}
        >
          Send a follow-up…
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
