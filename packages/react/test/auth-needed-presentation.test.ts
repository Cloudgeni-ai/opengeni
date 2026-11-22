import { describe, expect, test } from "bun:test";
import {
  authNeededPresentation,
  capabilityReconnectConnectionId,
  providerLabel,
} from "../src/auth-needed-presentation";
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

  test("an agent's card for an account that stopped working reconnects that account", () => {
    const capability = {
      id: "mcp:gmail",
      name: "Gmail",
      action: "connect",
      rationale: "Your Gmail stopped working on 2026-10-29.",
      requiredVariables: [],
    } as unknown as NonNullable<AuthNeededItem["capability"]>;
    const lapsed = item({
      source: "capability",
      providerDomain: "gmailmcp.googleapis.com",
      reason: "refresh_failed",
      connectionId: "conn-1",
      capability,
    });
    expect(capabilityReconnectConnectionId(lapsed)).toBe("conn-1");
    const view = authNeededPresentation(t, lapsed);
    expect(view.title).toBe("Reconnect Gmail");
    expect(view.actionLabel).toBe("Reconnect");
    expect(view.missing).toBe(false);
    expect(view.reasonLine).toBe("Your Gmail stopped working on 2026-10-29.");
    // The same card without a lapsed connection is still a first connection.
    const first = item({ source: "capability", reason: "missing_connection", capability });
    expect(capabilityReconnectConnectionId(first)).toBeUndefined();
    expect(authNeededPresentation(t, first).actionLabel).toBe("Connect");
    // A failed tool call's own reconnect row is not an agent's card.
    expect(capabilityReconnectConnectionId(item({ connectionId: "conn-1" }))).toBeUndefined();
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

  test("a connected account that needs more access names the action it allows", () => {
    const view = authNeededPresentation(
      t,
      item({
        providerDomain: "gmailmcp.googleapis.com",
        connectionId: "conn-1",
        reason: "insufficient_scope",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        toolName: "batch_modify_messages",
      }),
    );
    expect(view.moreAccess).toBe(true);
    // The title is the action, never "give the service access" (which reads
    // as connecting it to this chat).
    expect(view.title).toBe("Allow Opengeni to organize your Gmail");
    expect(view.reasonLine).toBe(
      "This includes marking mail as read, labeling and archiving it. Your approval settings still decide what runs without asking.",
    );
    // The button says where it goes: Google's consent page.
    expect(view.actionLabel).toBe("Allow in Google");
    expect(view.pendingLabel).toBe("Waiting for Google…");
    expect(view.doneLabel).toBe("Allowed");
    expect(view.footnote).toBe("After you allow it, the agent carries on where it stopped.");
    expect(view.canRecover).toBe(true);
    expect(`${view.title} ${view.reasonLine} ${view.footnote}`).not.toMatch(/reconnect|connect/i);
    // The host's product name, not Opengeni's, in an embedding product.
    const hosted = authNeededPresentation(
      createOpenGeniText({ productName: "Acme" }),
      item({
        providerDomain: "gmailmcp.googleapis.com",
        connectionId: "conn-1",
        reason: "insufficient_scope",
        scopes: ["https://www.googleapis.com/auth/gmail.compose"],
      }),
    );
    expect(hosted.title).toBe("Allow Acme to write and send email from your Gmail");
    expect(hosted.reasonLine).toStartWith("This includes writing drafts and sending mail as you.");
    // Unknown access still says it is one more kind of action, for this
    // account, and the button names the provider it opens.
    const generic = authNeededPresentation(
      t,
      item({ connectionId: "conn-1", reason: "insufficient_scope", scopes: ["write"] }),
    );
    expect(generic.title).toBe("Allow Opengeni more access to Linear");
    expect(generic.reasonLine).toBe(
      "Linear will ask you for one more kind of access. Your approval settings still decide what runs without asking.",
    );
    expect(generic.actionLabel).toBe("Allow in Linear");
    // Other cards keep their own words and are not step-ups.
    const lapsed = authNeededPresentation(t, item({ connectionId: "conn-1" }));
    expect(lapsed.moreAccess).toBe(false);
    expect(lapsed.pendingLabel).toBe("Opening…");
    expect(lapsed.doneLabel).toBe("Reconnected");
    expect(authNeededPresentation(t, item({ reason: "missing_connection" })).doneLabel).toBe(
      "Connected",
    );
  });

  test("a fixed-access account says it can't do this, with no step-up or other action", () => {
    const view = authNeededPresentation(
      t,
      item({
        providerDomain: "nango:gmail",
        connectionId: "conn-nango",
        reason: "account_scope_fixed",
        scopes: ["https://www.googleapis.com/auth/gmail.compose"],
        toolName: "create_draft",
      }),
    );
    expect(view.title).toBe("Gmail can't do this with the connected account");
    expect(view.reasonLine).toBe(
      "The connected account doesn't include this access, and it can't be added here.",
    );
    expect(view.unavailable).toBe(true);
    expect(view.canRecover).toBe(false);
    expect(view.footnote).toBeNull();
    expect(view.authorizationUrl).toBeNull();
    // The legacy-safe reason older clients read is unavailable too.
    const legacy = authNeededPresentation(
      t,
      item({ connectionId: "conn-nango", reason: "unsupported_auth" }),
    );
    expect(legacy.canRecover).toBe(false);
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
