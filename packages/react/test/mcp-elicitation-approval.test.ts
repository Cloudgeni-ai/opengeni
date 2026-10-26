import { afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { SessionEvent } from "@opengeni/sdk";
// The entry points an embedding product imports.
import { ApprovalSurface } from "../src/session-ui";
import { projectPendingApprovals, type PendingApproval } from "../src/session";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  const current = mounted;
  mounted = null;
  await current?.unmount();
});

function pending(elicitation: unknown): PendingApproval[] {
  return projectPendingApprovals([
    {
      type: "session.requiresAction",
      turnId: "turn-1",
      payload: {
        approvals: [
          {
            id: "call-1",
            name: "calendar__book_meeting",
            arguments: JSON.stringify({ topic: "Planning" }),
            display: { toolName: "book_meeting", title: "Book meeting" },
            elicitation,
          },
        ],
      },
    },
  ] as SessionEvent[]);
}

const details = {
  server: "Calendar",
  requests: [
    {
      id: "details",
      message: "Who should come, and where?",
      requestedSchema: {
        type: "object",
        properties: {
          room: {
            type: "string",
            title: "Room",
            oneOf: [
              { const: "small", title: "Small room" },
              { const: "large", title: "Large room" },
            ],
            default: "small",
          },
          attendees: { type: "integer", title: "People", minimum: 1, maximum: 20 },
          note: { type: "string", title: "Note", maxLength: 200 },
        },
        required: ["room", "attendees"],
      },
    },
  ],
};

function buttons() {
  return [...mounted!.container.querySelectorAll("button")];
}

function button(label: string) {
  const found = buttons().find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** happy-dom's input events do not reach React, so call its change handler as the browser would. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    (
      input as unknown as Record<
        string,
        { onChange: (event: { target: HTMLInputElement }) => void }
      >
    )[propsKey]!.onChange({ target: input });
  });
}

async function submit() {
  await act(async () => {
    mounted!.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function render(
  approvals: PendingApproval[],
  decisions: Array<{ decision: string; content?: unknown }>,
) {
  return renderComponent(
    createElement(ApprovalSurface, {
      approvals,
      onApprove: (_approval, answer) => {
        decisions.push({ decision: "approve", ...(answer ? { content: answer.content } : {}) });
      },
      onReject: () => {
        decisions.push({ decision: "reject" });
      },
    }),
  );
}

test("the projection keeps a valid question and drops a malformed one", () => {
  expect(pending(details)[0]?.elicitation).toEqual(details as never);
  expect(pending({ server: "Calendar", requests: [] })[0]?.elicitation).toBeUndefined();
});

test("a confirmation shows the server's question with Allow and Decline", async () => {
  const decisions: Array<{ decision: string; content?: unknown }> = [];
  mounted = await render(
    pending({
      server: "Chat",
      requests: [
        {
          id: "confirm",
          message: "Send “hi” to team?",
          requestedSchema: { type: "object", properties: {} },
        },
      ],
    }),
    decisions,
  );
  await act(async () => undefined);
  const text = mounted.container.textContent ?? "";
  expect(text).toContain("Chat asks");
  expect(text).toContain("Book meeting");
  expect(text).toContain("Send “hi” to team?");
  const labels = buttons().map((candidate) => candidate.textContent);
  expect(labels).toContain("Allow");
  expect(labels).toContain("Decline");
  expect(labels).toContain("Details");
  await submit();
  expect(decisions).toEqual([{ decision: "approve", content: { confirm: {} } }]);
});

test("a form is prefilled with the server's defaults and sends what the person entered", async () => {
  const decisions: Array<{ decision: string; content?: unknown }> = [];
  mounted = await render(pending(details), decisions);
  await act(async () => undefined);
  expect(button("Send answer")).toBeTruthy();
  const room = mounted.container.querySelector<HTMLInputElement>('input[value="small"]')!;
  expect(room.checked).toBe(true);
  const text = mounted.container.textContent ?? "";
  expect(text).toContain("Who should come, and where?");
  expect(text).toContain("Optional");

  // People is required: the form does not send without it.
  await submit();
  expect(decisions).toEqual([]);

  await type(mounted.container.querySelector<HTMLInputElement>('input[type="number"]')!, "3");
  await act(async () => {
    mounted!.container.querySelector<HTMLInputElement>('input[value="large"]')!.click();
  });
  await submit();
  expect(decisions).toEqual([
    { decision: "approve", content: { details: { room: "large", attendees: 3 } } },
  ]);
});

test("Decline rejects without an answer", async () => {
  const decisions: Array<{ decision: string; content?: unknown }> = [];
  mounted = await render(pending(details), decisions);
  await act(async () => undefined);
  await act(async () => button("Decline").click());
  expect(decisions).toEqual([{ decision: "reject" }]);
});
