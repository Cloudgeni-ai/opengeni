/* ----------------------------------------------------------------------------
   Bottom-follow belongs to where the person moved the view, nothing else.

   Pressing a button in the conversation (Chromium focuses it), a card handing
   focus to the next card, or opening a dialog from a card must never stop the
   timeline following its tip. Working through a stack of approvals is the
   motivating case: each answer brings the next card, and it has to arrive in
   view rather than below the composer. Only a deliberate scroll away (and a
   text selection or in-place disclosure, which own their place) hands the
   view to the reader, and then nothing yanks it back.
   -------------------------------------------------------------------------- */
import { expect, test } from "bun:test";
import type { SessionEvent, ToolActionReview } from "@opengeni/sdk";
import { act, type ReactElement } from "react";
import type { PendingApproval } from "../src/approvals";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
// Radix decides at import time whether a DOM exists; its portals stay empty
// when imported before the DOM is registered.
const { ApprovalSurface, MessageTimeline, SessionCapabilityFrame } = await import("../src");

let sequence = 0;
const START = Date.now() - 60_000;
function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `bottom-follow-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(START + sequence * 5_000).toISOString(),
    turnId,
  };
}

function conversation(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Draft a note to everyone who tried it." }, null),
    event("turn.started", {}),
    event(
      "agent.message.delta",
      { text: "I've prepared the drafts.", messageId: "drafts", phase: "commentary" },
      "turn-1",
    ),
  ];
}

function continuation(): SessionEvent[] {
  return [
    event(
      "agent.message.delta",
      { text: "All drafts are in Gmail.", messageId: "done", phase: "final_answer" },
      "turn-1",
    ),
  ];
}

function approvals(count: number, offset = 0): PendingApproval[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `approval-${offset + index}`,
    name: "create_draft",
    arguments: { to: [`person${offset + index}@example.test`], subject: "Hello" },
  }));
}

function review(id: string): ToolActionReview {
  return {
    version: 1,
    id,
    actionDigest: "a".repeat(64),
    revision: "1",
    status: "pending",
    title: "Create email draft",
    effects: [],
    samples: [],
    fields: [{ path: "/to", label: "To", preview: `${id}@example.test`, truncated: false }],
    moreFields: 0,
    reason: "This action asks first by default.",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    approveLabel: "Create draft",
    availableActions: ["approve", "reject"],
    detailsAvailable: false,
  };
}

function following(container: HTMLElement): string | null {
  return (
    container.querySelector("[data-og-timeline-scroller]")?.getAttribute("data-og-bottom-follow") ??
    null
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** A real mouse press in Chromium/Electron: focus lands on the button first. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    target.focus();
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    target.click();
  });
}

async function scrollUpWithWheel(container: HTMLElement) {
  const scroller = container.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  });
}

function approvalTimeline(
  events: SessionEvent[],
  pending: PendingApproval[],
  loadReview: (approval: PendingApproval) => Promise<ToolActionReview>,
  onApprove: (approval: PendingApproval) => Promise<void>,
): ReactElement {
  return (
    <MessageTimeline
      events={events}
      status="requires_action"
      turnSummary={{ rolling: true }}
      trailingState={
        pending.length > 0 ? (
          <ApprovalSurface
            approvals={pending}
            loadReview={loadReview}
            onApprove={onApprove}
            onReject={async () => {}}
          />
        ) : null
      }
    />
  );
}

test("answering approvals one after another keeps following the tip as each next card loads", async () => {
  const events = conversation();
  const reviews = new Map<string, (value: ToolActionReview) => void>();
  const loadReview = (approval: PendingApproval) =>
    new Promise<ToolActionReview>((resolve) => reviews.set(approval.id, resolve));
  let decided: (() => void) | null = null;
  const onApprove = () =>
    new Promise<void>((resolve) => {
      decided = resolve;
    });
  let pending = approvals(3);
  const view = await renderComponent(approvalTimeline(events, pending, loadReview, onApprove));
  try {
    await flush(50);
    await act(async () => reviews.get("approval-0")?.(review("approval-0")));
    await flush(20);
    expect(following(view.container)).toBe("true");

    for (let round = 0; round < 2; round += 1) {
      await press(button(view.container, "Create draft"));
      await flush(20);
      // Pressing the card's button is not reading the conversation.
      expect(following(view.container)).toBe("true");

      // The decision lands; the next card mounts, takes focus, then loads.
      pending = pending.slice(1);
      await act(async () => decided?.());
      await view.rerender(approvalTimeline(events, pending, loadReview, onApprove));
      await flush(50);
      expect(view.container.ownerDocument.activeElement?.tagName).toBe("H3");
      expect(following(view.container)).toBe("true");
      await act(async () => reviews.get(pending[0]!.id)?.(review(pending[0]!.id)));
      await flush(20);
      expect(following(view.container)).toBe("true");
    }

    // The agent continues below the last answered card: still following.
    await view.rerender(
      approvalTimeline([...events, ...continuation()], pending, loadReview, onApprove),
    );
    await flush(50);
    expect(view.container.textContent).toContain("All drafts are in Gmail.");
    expect(following(view.container)).toBe("true");
  } finally {
    await view.unmount();
  }
});

test("a person who scrolled up stays put while approvals resolve and content arrives", async () => {
  const events = conversation();
  let pending = approvals(2);
  const loadReview = async (approval: PendingApproval) => review(approval.id);
  const onApprove = async () => {};
  const view = await renderComponent(approvalTimeline(events, pending, loadReview, onApprove));
  try {
    await flush(50);
    expect(following(view.container)).toBe("true");
    await scrollUpWithWheel(view.container);
    await flush(20);
    expect(following(view.container)).toBe("false");

    await press(button(view.container, "Create draft"));
    pending = pending.slice(1);
    await view.rerender(approvalTimeline(events, pending, loadReview, onApprove));
    await flush(50);
    await view.rerender(
      approvalTimeline([...events, ...continuation()], pending, loadReview, onApprove),
    );
    await flush(50);
    expect(following(view.container)).toBe("false");
  } finally {
    await view.unmount();
  }
});

test("focus and dialog openers never unpin; selection and in-place disclosures still do", async () => {
  const events = [...conversation(), event("turn.completed", { output: "Done." })];
  const view = await renderComponent(
    <MessageTimeline
      events={events}
      turnSummary={{ rolling: true }}
      trailingState={
        <div>
          <button type="button">Copy</button>
          <button type="button" aria-haspopup="dialog" aria-expanded="false">
            Open setup
          </button>
          <button type="button" aria-expanded="false">
            Show more
          </button>
          <p data-testid="prose">Some text to select.</p>
        </div>
      }
    />,
  );
  try {
    await flush(50);
    expect(following(view.container)).toBe("true");
    await press(button(view.container, "Copy"));
    await flush(20);
    expect(following(view.container)).toBe("true");
    // A later commit with focus still inside the conversation keeps following.
    await view.rerender(
      <MessageTimeline
        events={[...events, event("user.message", { text: "Thanks!" }, null)]}
        turnSummary={{ rolling: true }}
        trailingState={
          <div>
            <button type="button">Copy</button>
            <button type="button" aria-haspopup="dialog" aria-expanded="false">
              Open setup
            </button>
            <button type="button" aria-expanded="false">
              Show more
            </button>
            <p data-testid="prose">Some text to select.</p>
          </div>
        }
      />,
    );
    await flush(20);
    expect(following(view.container)).toBe("true");
    await press(button(view.container, "Open setup"));
    await flush(20);
    expect(following(view.container)).toBe("true");

    // An in-place disclosure keeps its toggle where the reader left it.
    await press(button(view.container, "Show more"));
    await flush(20);
    expect(following(view.container)).toBe("false");
  } finally {
    await view.unmount();
  }
});

test("selecting text in the conversation hands the view to the reader", async () => {
  const view = await renderComponent(
    <MessageTimeline
      events={conversation()}
      turnSummary={{ rolling: true }}
      trailingState={<p data-testid="prose">Some text to select.</p>}
    />,
  );
  try {
    await flush(50);
    expect(following(view.container)).toBe("true");
    const prose = view.container.querySelector('[data-testid="prose"]')!;
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(prose);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await flush(20);
    expect(following(view.container)).toBe("false");
  } finally {
    document.getSelection()?.removeAllRanges();
    await view.unmount();
  }
});

function capabilityConversation(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Can you read my notes?" }, null),
    event("turn.started", {}),
    event("tool.auth_needed", {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: "notes.example",
      reason: "not_connected",
      capability: {
        id: "mcp:notes",
        name: "Notes",
        kind: "mcp",
        source: "built_in",
        action: "connect",
        rationale: "Read your notes.",
        requiredVariables: [],
      },
    }),
    event("turn.completed", { output: "Connect Notes to continue." }),
  ];
}

function capabilityTimeline(events: SessionEvent[], complete: boolean): ReactElement {
  return (
    <MessageTimeline
      events={events}
      turnSummary={{ rolling: true }}
      renderAuthNeeded={() => (
        <SessionCapabilityFrame
          name="Notes"
          subtitle="Your notes"
          logo={null}
          typeLabel="App"
          description="Read your notes."
          skill={false}
          expanded={false}
          complete={complete}
          actionLabel="Connect Notes"
          note=""
          onOpen={() => {}}
          onClose={() => {}}
        >
          <button type="button">Continue</button>
        </SessionCapabilityFrame>
      )}
    />
  );
}

function capabilityContinuation(): SessionEvent[] {
  return [
    event("turn.started", {}, "turn-2"),
    event(
      "agent.message.delta",
      { text: "Here are your notes.", messageId: "answer", phase: "final_answer" },
      "turn-2",
    ),
  ];
}

test("finishing a connect card keeps following, and never pulls back a reader who scrolled up", async () => {
  const events = capabilityConversation();
  const view = await renderComponent(capabilityTimeline(events, false));
  try {
    await flush(50);
    expect(following(view.container)).toBe("true");
    await press(button(view.container, "Connect Notes"));
    await flush(20);
    expect(following(view.container)).toBe("true");
    await view.rerender(capabilityTimeline(events, true));
    await flush(50);
    const card = view.container.querySelector<HTMLElement>(".og-session-capability-shell")!;
    await act(async () => card.focus());
    const continued = [...events, ...capabilityContinuation()];
    await view.rerender(capabilityTimeline(continued, true));
    await flush(50);
    expect(view.container.textContent).toContain("Here are your notes.");
    expect(following(view.container)).toBe("true");
  } finally {
    await view.unmount();
  }

  const scrolled = await renderComponent(capabilityTimeline(capabilityConversation(), false));
  try {
    await flush(50);
    await scrollUpWithWheel(scrolled.container);
    await flush(20);
    expect(following(scrolled.container)).toBe("false");
    await scrolled.rerender(capabilityTimeline(capabilityConversation(), true));
    await flush(50);
    await scrolled.rerender(
      capabilityTimeline([...capabilityConversation(), ...capabilityContinuation()], true),
    );
    await flush(50);
    expect(following(scrolled.container)).toBe("false");
  } finally {
    await scrolled.unmount();
  }
});
