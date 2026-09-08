import { createRoot } from "react-dom/client";
import { useState } from "react";
import { FeedbackDialog, SessionFeedback } from "../src/components/feedback";
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
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-xl">Feedback component preview</h1>
      <div className="mb-6">
        <Button variant="outline" onClick={() => setOpen(true)}>
          Send feedback
        </Button>
      </div>
      <section className="rounded-lg border p-5">
        <h2 className="mb-3 text-lg">Your session</h2>
        <p className="mb-4 text-sm">I created the requested report and checked the totals.</p>
        <SessionFeedback client={client} workspaceId={workspaceId} sessionId={sessionId} />
      </section>
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
