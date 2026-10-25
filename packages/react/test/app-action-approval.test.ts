import { afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { appActionConfirmationTitle } from "@opengeni/contracts/app-actions";
import {
  toolReviewAction,
  toolReviewFields,
  type SessionEvent,
  type ToolActionReview,
} from "@opengeni/sdk";
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

const args = {
  id: "createOrganizationInvitation",
  pathParameters: { organizationId: "org-1" },
  body: { email: "anna@example.com", role: "member" },
};
const title = appActionConfirmationTitle(args, { workspaceId: "ws-1", sessionId: "chat-1" });

/** The pending approval as the worker emits it for an app action that needs a confirmation. */
function pending(): PendingApproval[] {
  const events = [
    {
      type: "session.requiresAction",
      turnId: "turn-1",
      payload: {
        approvals: [
          {
            id: "call-invite",
            name: "opengeni__admin_action_call",
            arguments: JSON.stringify(args),
            display: { toolName: "admin_action_call", title },
          },
        ],
      },
    },
  ] as SessionEvent[];
  return projectPendingApprovals(events);
}

function buttons() {
  return [...mounted!.container.querySelectorAll("button")];
}

test.each(["from the event", "from the saved review"] as const)(
  "an embed shows an app action as one plain question with Allow and Cancel (%s)",
  async (source) => {
    const approved: string[] = [];
    const review: ToolActionReview = {
      version: 1,
      id: "call-invite",
      actionDigest: "a".repeat(64),
      revision: "1",
      status: "pending",
      ...toolReviewAction("admin_action_call", args, { kind: "generic", title }),
      ...toolReviewFields(args, undefined, "admin_action_call"),
      reason: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      availableActions: ["approve", "reject"],
      detailsAvailable: true,
    };
    mounted = await renderComponent(
      createElement(ApprovalSurface, {
        approvals: pending(),
        ...(source === "from the saved review" ? { loadReview: async () => review } : {}),
        onApprove: (approval) => {
          approved.push(approval.id);
        },
        onReject: () => undefined,
      }),
    );
    await act(async () => undefined);
    expect(mounted.container.querySelector("h3")?.textContent).toBe(
      "Invite anna@example.com to your organization?",
    );
    // One readable line of what it does; the raw arguments wait behind Details.
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Email: anna@example.com · Role: member");
    expect(text).not.toContain("createOrganizationInvitation");
    expect(text).not.toContain("Path parameters");
    const labels = buttons().map((button) => button.textContent);
    expect(labels).toContain("Allow");
    expect(labels).toContain("Cancel");
    // The raw call is one click away; a host that loads saved reviews opens it its own way.
    if (source === "from the event") expect(labels).toContain("Details");
    expect(labels).not.toContain("Approve action");
    expect(labels).not.toContain("Decline");
    await act(async () =>
      buttons()
        .find((button) => button.textContent === "Allow")!
        .click(),
    );
    expect(approved).toEqual(["call-invite"]);
  },
);

test("the card's answers come from the host's messages", async () => {
  const { OpenGeniMessagesProvider } = await import("../src/messages/runtime");
  mounted = await renderComponent(
    createElement(
      OpenGeniMessagesProvider,
      { messages: { "approvalSurface.allow": "Tillat", "approvalSurface.cancel": "Avbryt" } },
      createElement(ApprovalSurface, {
        approvals: pending(),
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    ),
  );
  await act(async () => undefined);
  const labels = buttons().map((button) => button.textContent);
  expect(labels).toContain("Tillat");
  expect(labels).toContain("Avbryt");
});
