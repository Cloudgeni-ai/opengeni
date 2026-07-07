import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act } from "react";
import { registerDom, renderComponent, flush } from "./render-hook";
import { MessageTimeline } from "../src";

/* ----------------------------------------------------------------------------
   WorkerCompletionRow — a child session reporting back to its manager.

   The completion rides a `user.message` carrying a `childCompletion` payload; it
   must project to a `worker-completion` card (NOT a user bubble), carry the
   right outcome label, keep the report behind a collapsed disclosure, and
   deep-link into the child via onOpenSession.
   -------------------------------------------------------------------------- */

registerDom();

let sequence = 0;

function completionEvent(payload: unknown): SessionEvent {
  sequence += 1;
  return {
    id: `wc-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type: "user.message",
    payload,
    occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
    turnId: null,
  };
}

const CHILD_ID = "9efcd759-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

describe("MessageTimeline — worker completions", () => {
  test("a completed goal renders a result card, not a user bubble", async () => {
    const events = [
      completionEvent({
        text: "All 128 assertions passed.",
        childCompletion: {
          childSessionId: CHILD_ID,
          status: "idle",
          goal: { status: "completed", text: "verify login flow end-to-end", evidence: "128/128 green" },
        },
      }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} onOpenSession={() => undefined} />);

    expect(r.container.textContent).toContain("Worker completed");
    expect(r.container.textContent).toContain("verify login flow end-to-end");
    // The report/evidence stay behind the fold — visible only after expanding.
    expect(r.container.textContent).not.toContain("All 128 assertions passed.");
    expect(r.container.textContent).not.toContain("128/128 green");
    // A "View session" affordance is present when a handler is wired.
    const viewButton = Array.from(r.container.querySelectorAll("button")).find((b) => /View session/.test(b.textContent ?? ""));
    expect(viewButton).toBeDefined();
  });

  test("expanding the disclosure reveals the report and evidence", async () => {
    const events = [
      completionEvent({
        text: "All 128 assertions passed.",
        childCompletion: {
          childSessionId: CHILD_ID,
          status: "idle",
          goal: { status: "completed", text: "verify login flow", evidence: "128/128 green" },
        },
      }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} onOpenSession={() => undefined} />);
    const toggle = Array.from(r.container.querySelectorAll("button")).find((b) => /Show details/.test(b.textContent ?? ""));
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.click();
      await flush();
    });
    expect(r.container.textContent).toContain("All 128 assertions passed.");
    expect(r.container.textContent).toContain("128/128 green");
  });

  test("deep-links into the child session on click", async () => {
    let opened: string | null = null;
    const events = [
      completionEvent({
        text: "done",
        childCompletion: { childSessionId: CHILD_ID, status: "idle", goal: { status: "completed", text: "ship it" } },
      }),
    ];
    const r = await renderComponent(<MessageTimeline events={events} onOpenSession={(id) => { opened = id; }} />);
    const viewButton = Array.from(r.container.querySelectorAll("button")).find((b) => /View session/.test(b.textContent ?? ""));
    await act(async () => {
      viewButton!.click();
      await flush();
    });
    expect(opened).toBe(CHILD_ID);
  });

  test("a failed child reads as a failure, a paused goal as paused", async () => {
    const failed = [
      completionEvent({
        text: "staging 503 for the whole window",
        childCompletion: { childSessionId: CHILD_ID, status: "failed", goal: { status: "active", text: "capture a baseline" } },
      }),
    ];
    const rf = await renderComponent(<MessageTimeline events={failed} />);
    expect(rf.container.textContent).toContain("Worker failed");

    const paused = [
      completionEvent({
        text: "blocked on credentials",
        childCompletion: {
          childSessionId: CHILD_ID,
          status: "idle",
          goal: { status: "paused", text: "migrate billing", pausedReason: "missing GHCR credentials" },
        },
      }),
    ];
    const rp = await renderComponent(<MessageTimeline events={paused} />);
    expect(rp.container.textContent).toContain("Worker paused");
  });
});
