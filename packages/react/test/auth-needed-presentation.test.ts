import { describe, expect, test } from "bun:test";
import { authNeededPresentation, providerLabel } from "../src/auth-needed-presentation";
import {
  approvalAnswerLabels,
  APP_ACTION_TOOL_NAME,
  formatApprovalToolName,
  pendingApprovalReview,
} from "../src/approval-review-model";
import { createOpenGeniText } from "../src/messages/runtime";
import type { AuthNeededItem } from "../src/timeline";

const t = createOpenGeniText();

function item(overrides: Partial<AuthNeededItem> = {}): AuthNeededItem {
  return {
    kind: "auth-needed",
    id: "auth-1",
    turnId: "turn-1",
    serverId: null,
    providerDomain: "linear.app",
    connectionId: null,
    reason: "expired",
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
    occurredAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("authNeededPresentation", () => {
  test("a lapsed connection asks to reconnect", () => {
    const view = authNeededPresentation(t, item({ connectionId: "conn-1" }));
    expect(view.provider).toBe("Linear");
    expect(view.actionLabel).toBe("Reconnect");
    expect(view.missing).toBe(false);
    expect(view.canRecover).toBe(true);
  });

  test("a first-time connection never says reconnect", () => {
    const view = authNeededPresentation(t, item({ reason: "missing_connection" }));
    expect(view.actionLabel).toBe("Connect");
    expect(view.missing).toBe(true);
    expect(`${view.title} ${view.footnote} ${view.startFailed}`).not.toMatch(/reconnect/i);
  });

  test("an agent's catalog request is a first connection named after the capability", () => {
    const view = authNeededPresentation(
      t,
      item({
        source: "capability",
        providerDomain: "calendar.google.com",
        capability: {
          capabilityId: "google-calendar",
          name: "Google Calendar",
          action: "connect",
          rationale: "To read your calendar for this week.",
          requiredVariables: [],
        } as unknown as NonNullable<AuthNeededItem["capability"]>,
      }),
    );
    expect(view.title).toBe("Connect Google Calendar");
    expect(view.actionLabel).toBe("Connect");
    expect(view.reasonLine).toBe("To read your calendar for this week.");
    expect(`${view.title} ${view.footnote} ${view.startFailed}`).not.toMatch(/reconnect/i);
  });

  test("tools that cannot run here offer no action", () => {
    const view = authNeededPresentation(t, item({ reason: "unsupported_auth" }));
    expect(view.unavailable).toBe(true);
    expect(view.canRecover).toBe(false);
    expect(view.footnote).toBeNull();
  });

  test("a plugin is installed, not connected, and says who can install it", () => {
    const view = authNeededPresentation(
      t,
      item({
        reason: "missing_connection",
        providerDomain: "sentry.io",
        capability: {
          id: "plugin:marketplace/anthropic/sentry",
          name: "Sentry",
          kind: "plugin",
          action: "enable",
          rationale: "To triage this morning's errors.",
          requiredVariables: [],
        } as unknown as NonNullable<AuthNeededItem["capability"]>,
      }),
      { setupUnavailable: true },
    );
    expect(view.title).toBe("Install Sentry");
    expect(view.footnote).toBe(
      "Installing Sentry needs permission to manage this workspace's plugins. Ask a workspace admin to install it.",
    );
    expect(`${view.title} ${view.footnote}`).not.toMatch(/connect/i);
  });

  test("provider labels are calm names, not raw domains", () => {
    expect(providerLabel(t, "https://www.notion.so/path")).toBe("Notion");
    expect(providerLabel(t, "")).toBe(t("messageTimeline.thisService"));
    expect(providerLabel(t, "gmailmcp.googleapis.com")).toBe("Gmail");
  });

  test("a connected account that needs more access is asked to allow it, in plain words", () => {
    const view = authNeededPresentation(
      t,
      item({
        providerDomain: "gmailmcp.googleapis.com",
        connectionId: "conn-1",
        reason: "insufficient_scope",
        scopes: ["https://www.googleapis.com/auth/gmail.compose"],
        toolName: "send_message",
      }),
    );
    expect(view.title).toBe("Give Gmail more access");
    expect(view.actionLabel).toBe("Allow");
    expect(view.reasonLine).toBe(
      "It needs your permission to draft and send email. Everything it can already do stays the same.",
    );
    expect(view.footnote).toBe("After you allow it, the agent carries on where it stopped.");
    expect(view.canRecover).toBe(true);
    expect(`${view.title} ${view.footnote}`).not.toMatch(/reconnect/i);
    // Unknown access keeps the generic line; the button still says Allow.
    const generic = authNeededPresentation(
      t,
      item({ connectionId: "conn-1", reason: "insufficient_scope", scopes: ["write"] }),
    );
    expect(generic.title).toBe("Give Linear more access");
    expect(generic.reasonLine).toBe("It needs additional access to continue.");
  });
});

describe("approval review model", () => {
  test("app actions answer their question with Allow and Cancel", () => {
    expect(approvalAnswerLabels(t, APP_ACTION_TOOL_NAME)).toEqual({
      approve: "Allow",
      reject: "Cancel",
    });
    expect(approvalAnswerLabels(t, "send_email")).toBeNull();
  });

  test("tool names read as actions", () => {
    expect(formatApprovalToolName(t, "batch_modify_messages")).toBe("Modify messages");
  });

  test("a pending approval's review lists its arguments as fields", () => {
    const review = pendingApprovalReview(
      {
        id: "call-1",
        name: "send_email",
        arguments: { to: "anna@example.com", subject: "Hello" },
      } as never,
      { formatToolName: (name) => formatApprovalToolName(t, name), approveLabel: "Approve" },
    );
    expect(review.approveLabel).toBe("Approve");
    expect(review.availableActions).toEqual(["approve", "reject"]);
    expect(review.fields.map((field) => field.path)).toContain("/to");
  });
});
