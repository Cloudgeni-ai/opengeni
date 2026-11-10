import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import type { SessionQueueSnapshot, ToolActionReview } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom({ clock: "virtual" });

/*
 * A programmatic (Code Mode) tool call that needs review pauses the turn with
 * an approval that carries no arguments: they stay on the server, in the
 * action's saved review. The conversation must read that review, so a fresh
 * request can be approved instead of reading as an older one whose details
 * were lost.
 */

const OPERATION_ID = "8f3a1c52-6d0e-4b7a-9c21-5e4d3b2a1f00";

const effectiveControl = {
  state: "active",
  controlVersion: 1,
  controlEtag: "control-1",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
} as const;

function savedReview(): ToolActionReview {
  return {
    version: 1,
    id: OPERATION_ID,
    actionDigest: "a".repeat(64),
    revision: "revision-1",
    status: "pending",
    title: "Delete a calendar event",
    effects: [],
    fields: [{ path: "path", label: "Event", preview: "event-1", truncated: false }],
    moreFields: 0,
    reason: "This action asks first by default.",
    createdAt: "2026-11-05T08:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
    approveLabel: "Approve action",
    availableActions: ["approve", "reject"],
    detailsAvailable: true,
  };
}

function codeModeClient() {
  const reads: string[] = [];
  const client = fakeClient({
    listEvents: async () =>
      [
        {
          id: "33333333-3333-4333-8333-333333333334",
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          sequence: 1,
          type: "session.requiresAction",
          turnId: "44444444-4444-4444-8444-444444444444",
          occurredAt: "2026-11-05T08:00:00Z",
          // As the runtime emits a Code Mode approval: no arguments.
          payload: {
            approvals: [
              {
                id: OPERATION_ID,
                name: "calendar_delete_event",
                source: "codemode",
                arguments: null,
                requestId: "5b0e7d9c-1a2b-4c3d-8e4f-a1b2c3d4e5f6",
                operationId: OPERATION_ID,
              },
            ],
          },
        },
      ] as never,
    getSession: async () =>
      ({ id: SESSION_ID, status: "requires_action", effectiveControl }) as never,
    getQueue: async () =>
      ({
        version: 1,
        effectiveControl,
        activePersonalConnections: [],
        stoppingPreviousAttempt: false,
        items: [],
        pendingInputs: [],
        pendingInputAttachment: null,
      }) as unknown as SessionQueueSnapshot,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
  Object.assign(client, {
    getGoal: async () => null,
    getToolActionReview: async (workspaceId: string, sessionId: string, approvalId: string) => {
      expect([workspaceId, sessionId]).toEqual([WORKSPACE_ID, SESSION_ID]);
      reads.push(approvalId);
      return savedReview();
    },
    getToolReviewDetails: async () => {
      throw new Error("details are not opened in these tests");
    },
  });
  return { client, reads };
}

const buttons = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((node) => node.textContent?.trim());

async function mount(approvalProps?: ComponentProps<typeof SessionConversation>["approvalProps"]) {
  const { client, reads } = codeModeClient();
  const view = await renderComponent(
    <SessionConversation
      sessionId={SESSION_ID}
      client={client}
      workspaceId={WORKSPACE_ID}
      agentSignals={false}
      {...(approvalProps ? { approvalProps } : {})}
    />,
  );
  await flush(200);
  return { view, reads };
}

test("a Code Mode approval shows its saved review and can be approved", async () => {
  const { view, reads } = await mount();
  try {
    expect(reads).toEqual([OPERATION_ID]);
    expect(view.container.textContent).toContain("Delete a calendar event");
    expect(view.container.textContent).not.toContain("couldn't be recovered");
    expect(buttons(view.container)).toContain("Approve action");
  } finally {
    await view.unmount();
  }
});

test("a host review that leaves the approval to the standard card falls back to the saved review", async () => {
  const hostReads: string[] = [];
  const { view, reads } = await mount({
    // A host with reviews only for its own tools, as products write them.
    loadReview: async (approval) => {
      hostReads.push(approval.id);
      return null;
    },
  });
  try {
    expect(hostReads).toEqual([OPERATION_ID]);
    expect(reads).toEqual([OPERATION_ID]);
    expect(view.container.textContent).not.toContain("couldn't be recovered");
    expect(buttons(view.container)).toContain("Approve action");
  } finally {
    await view.unmount();
  }
});

test("the host's own review still wins without reading the saved one", async () => {
  const { view, reads } = await mount({
    loadReview: async (approval) => ({
      ...savedReview(),
      id: approval.id,
      actionDigest: "",
      revision: "legacy",
      title: "Remove the test appointment",
      fields: [],
      detailsAvailable: false,
    }),
  });
  try {
    expect(reads).toEqual([]);
    expect(view.container.textContent).toContain("Remove the test appointment");
    expect(buttons(view.container)).toContain("Approve action");
  } finally {
    await view.unmount();
  }
});
