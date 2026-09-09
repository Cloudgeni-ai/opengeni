import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MessageTimeline } from "@opengeni/react/session-ui";
import MessageActions from "../src/components/session/message-actions";
import { SessionTenancyControl } from "../src/components/session/session-tenancy-control";
import { SessionTenancyOperationController } from "../src/lib/session-tenancy-operation-controller";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { Session } from "../src/types";
import { FeedbackDialog } from "../src/components/feedback";
import { Button } from "../src/components/ui/button";
import type { CreateFeedbackRequest, Feedback } from "@opengeni/sdk";
import "../src/styles.css";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const rows: Feedback[] = [];
const keys = new Map<string, Feedback>();
let failNext = false;
const client = {
  async createFeedback(workspace: string, request: CreateFeedbackRequest) {
    if (failNext) {
      failNext = false;
      throw new Error("Connection interrupted. Please retry.");
    }
    const previous = keys.get(request.idempotencyKey);
    if (previous) return { feedback: previous, replayed: true };
    const feedback: Feedback = {
      id: crypto.randomUUID(),
      workspaceId: workspace,
      subjectId: "preview-user",
      principalKind: "human_session",
      sessionId: request.sessionId ?? null,
      turnId: request.turnId ?? null,
      sentiment: request.sentiment ?? null,
      comment: request.comment ?? null,
      createdAt: new Date().toISOString(),
    };
    rows.unshift(feedback);
    keys.set(request.idempotencyKey, feedback);
    return { feedback, replayed: false };
  },
  async listOwnFeedback(_workspace: string, options: { sessionId?: string } = {}) {
    return { feedback: rows.filter((row) => row.sessionId === (options.sessionId ?? null)) };
  },
};
function Fixture() {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [rating, setRating] = useState<"positive" | "negative" | null>(null);
  const [forkPoint, setForkPoint] = useState<string | null>(null);
  const [forkedPoint, setForkedPoint] = useState<string | null>(null);
  const [controller] = useState(() => new SessionTenancyOperationController());
  const turnId = "33333333-3333-4333-8333-333333333333";
  const session = {
    id: sessionId,
    workspaceId,
    status: "idle",
    tenancy: {
      visibility: "private",
      authorityEpoch: 1,
      ownedByCurrentUser: true,
      fork: null,
    },
  } as Session;
  const forkClient = {
    async forkSession(
      _workspace: string,
      _session: string,
      request: { sourceEventId?: string; visibility: string },
    ) {
      setForkedPoint(request.sourceEventId ?? null);
      return {
        workspaceId,
        sessionId: "fork-preview",
        visibility: request.visibility,
        replay: false,
      };
    },
    async getSession() {
      return { ...session, id: "fork-preview" };
    },
  } as unknown as OpenGeniBrowserClient;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-xl">Feedback component preview</h1>
      <div className="mb-6">
        <Button variant="outline" onClick={() => setOpen(true)}>
          Send feedback
        </Button>
      </div>
      <section className="h-[380px] rounded-lg border">
        <MessageTimeline
          items={[
            {
              kind: "user-message",
              id: "44444444-4444-4444-8444-444444444444",
              text: "Create the report",
              resources: [],
              tools: [],
              occurredAt: "2026-09-09T07:00:00Z",
            },
            {
              kind: "agent-message",
              id: "55555555-5555-4555-8555-555555555555",
              turnId,
              text: "I created the requested report and checked the totals.",
              streaming: false,
              occurredAt: "2026-09-09T07:01:00Z",
            },
            {
              kind: "agent-message",
              id: "66666666-6666-4666-8666-666666666666",
              turnId,
              text: "This later reply should not be included when forking from the first answer.",
              streaming: false,
              occurredAt: "2026-09-09T07:02:00Z",
            },
          ]}
          renderMessageActions={(item) => (
            <MessageActions
              item={{
                ...item,
                annotationSource: {
                  kind: item.kind === "user-message" ? "user_message" : "assistant_message",
                  eventType:
                    item.kind === "user-message" ? "user.message" : "agent.message.completed",
                  eventId: item.id,
                  turnId,
                  sequence: 1,
                  text: item.text,
                },
              }}
              client={client as unknown as OpenGeniBrowserClient}
              workspaceId={workspaceId}
              sessionId={sessionId}
              mayRate
              mayFork
              savedSentiment={rating}
              onRated={(_turnId, sentiment) => setRating(sentiment)}
              onFork={setForkPoint}
            />
          )}
        />
      </section>
      {forkPoint ? (
        <SessionTenancyControl
          key={forkPoint}
          sourceEventId={forkPoint}
          onForkClose={() => setForkPoint(null)}
          session={session}
          client={forkClient}
          managedSession
          canForkPrivately
          scopeLabel="Preview workspace"
          captureWorkspaceInvocation={() => ({ workspaceId, revision: 1 })}
          ownsWorkspaceInvocation={() => true}
          operationController={controller}
          operationScope={{
            principalId: "preview-user",
            workspaceId,
            sessionId,
            workspaceTransitionRevision: 1,
          }}
          onOpenSession={() => setForkPoint(null)}
        />
      ) : null}
      {forkedPoint ? <p role="status">Forked through message {forkedPoint}</p> : null}
      <Button
        variant="ghost"
        className="mt-8"
        onClick={() => {
          failNext = true;
        }}
      >
        Simulate next submission failure
      </Button>
      <FeedbackDialog
        client={client}
        workspaceId={workspaceId}
        open={open}
        onOpenChange={setOpen}
        onSubmitted={() => setSubmitted(true)}
      />
      {submitted ? <p role="status">General feedback submitted</p> : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
