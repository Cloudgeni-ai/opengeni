import { afterEach, expect, test } from "bun:test";
import type { ToolActionReview } from "@opengeni/sdk";
import { pendingApprovalReview } from "../src/approval-review-model";
import {
  createOpenGeniText,
  OpenGeniMessagesProvider,
  type OpenGeniMessages,
} from "../src/messages/runtime";
import { toolDisplayName } from "../src/timeline/tool-display-name";
import { wordedToolActionReview } from "../src/tool-action-wording";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

// Radix picks its layout-effect implementation at import time: load after the DOM exists.
const { ToolActionReviewCard } = await import("../src/components/tool-action-review");

// One host's words, in its own language: the catalog's keys plus its names
// for one connector action and its fields.
const NORWEGIAN: OpenGeniMessages = {
  "approvalSurface.approveAction": "Godkjenn handlingen",
  "toolActionReview.reason.asksByDefault": "Denne handlingen spør først som standard.",
  "toolAction.me_calendar_createevents.title": "Opprett en kalenderavtale",
  "toolAction.me_calendar_createevents.field.start": "Starter",
  "toolField.subject": "Emne",
  "toolField.isReminderOn": "Påminnelse",
  "toolActionReview.yes": "Ja",
};

const saved: ToolActionReview = {
  version: 1,
  id: "approval-1",
  actionDigest: "digest",
  revision: "revision-1",
  status: "pending",
  title: "Create a calendar event",
  toolName: "me_calendar_createevents",
  accountLabel: "kari@example.test",
  effects: [],
  fields: [
    {
      path: "/body/subject",
      key: "subject",
      label: "Subject",
      preview: "Planning",
      truncated: false,
    },
    {
      path: "/body/start",
      key: "start",
      label: "Starts",
      preview: "12 Nov 09:00",
      truncated: false,
    },
    {
      path: "/body/isReminderOn",
      key: "isReminderOn",
      label: "Is reminder on",
      preview: "Yes",
      booleanValue: true,
      truncated: false,
    },
    { path: "/body/showAs", key: "showAs", label: "Show as", preview: "busy", truncated: false },
  ],
  moreFields: 0,
  reason: "This action asks first by default.",
  reasonCode: "asks_by_default",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  approveLabel: "Approve action",
  approveLabelCode: "approve_action",
  availableActions: ["approve", "reject"],
  detailsAvailable: true,
};

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

async function render(messages?: OpenGeniMessages): Promise<string> {
  const card = (
    <ToolActionReviewCard review={saved} onApprove={() => undefined} onReject={() => undefined} />
  );
  mounted = await renderComponent(
    messages ? (
      <OpenGeniMessagesProvider messages={messages}>{card}</OpenGeniMessagesProvider>
    ) : (
      card
    ),
  );
  await flush();
  return mounted.container.textContent ?? "";
}

test("a saved review reads in the host's words: title, fields, reason and button", async () => {
  const text = await render(NORWEGIAN);
  for (const own of [
    "Opprett en kalenderavtale",
    "Emne",
    "Starter",
    "Påminnelse",
    "Ja",
    "Denne handlingen spør først som standard.",
    "Godkjenn handlingen",
  ])
    expect(text).toContain(own);
  for (const english of [
    "Create a calendar event",
    "Subject",
    "Starts",
    "Is reminder on",
    "asks first by default",
    "Approve action",
  ])
    expect(text).not.toContain(english);
  // A field the host did not name keeps the server's label.
  expect(text).toContain("Show as");
});

test("without host words the card reads as the server wrote it", async () => {
  const text = await render();
  for (const english of [
    "Create a calendar event",
    "Subject",
    "Starts",
    "This action asks first by default.",
    "Approve action",
  ])
    expect(text).toContain(english);
});

test("a label that names the action and a reason without a code stay as saved", () => {
  const t = createOpenGeniText({ messages: NORWEGIAN });
  const named = wordedToolActionReview(
    {
      ...saved,
      toolName: "trash_message",
      approveLabel: "Move to Trash",
      approveLabelCode: undefined,
      reason: "Saved before codes",
      reasonCode: undefined,
    } as ToolActionReview,
    t,
  );
  expect(named.approveLabel).toBe("Move to Trash");
  expect(named.reason).toBe("Saved before codes");
  expect(named.title).toBe("Create a calendar event");
});

test("the same host title names the step in the chat and the pending approval", () => {
  const t = createOpenGeniText({ messages: NORWEGIAN });
  const display = {
    toolName: "me_calendar_createevents",
    title: "Create a calendar event",
    connector: "Outlook Calendar",
  };
  expect(toolDisplayName(t, "mcp_calendar__me_calendar_createevents", display)).toBe(
    "Opprett en kalenderavtale",
  );
  // Without display facts the step falls back to the tool's own name, which the host names too.
  expect(toolDisplayName(t, "mcp_calendar__me_calendar_createevents")).toBe(
    "Opprett en kalenderavtale",
  );
  expect(toolDisplayName(createOpenGeniText(), "mcp_calendar__me_calendar_createevents")).toBe(
    "Me calendar createevents",
  );
  const pending = wordedToolActionReview(
    pendingApprovalReview(
      {
        id: "approval-1",
        name: "mcp_calendar__me_calendar_createevents",
        display,
        arguments: { body: { subject: "Planning" } },
      },
      { formatToolName: (name) => toolDisplayName(t, name), approveLabel: "Godkjenn" },
    ),
    t,
  );
  expect(pending.title).toBe("Opprett en kalenderavtale");
  // The approval list gives its own approve word; it is kept.
  expect(pending.approveLabel).toBe("Godkjenn");
  expect(pending.fields.map((field) => field.label)).toEqual(["Body"]);
});
