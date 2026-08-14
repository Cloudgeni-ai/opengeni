import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/contracts";
import {
  buildSlackAppHomeAccessBlocks,
  buildSlackAppHomeBlocks,
  isSlackAppHomeLinkAction,
  slackAppHomeOpenedEvent,
} from "../src/integrations/slack-app-home";

describe("Slack App Home projection", () => {
  test("accepts only bounded home-tab event callbacks", () => {
    expect(
      slackAppHomeOpenedEvent({
        type: "event_callback",
        team_id: "T_WORKSPACE",
        event_id: "Ev_OPENED",
        event: { type: "app_home_opened", user: "U_VIEWER", tab: "home" },
      }),
    ).toEqual({
      eventId: "Ev_OPENED",
      slackTeamId: "T_WORKSPACE",
      slackUserId: "U_VIEWER",
    });
    expect(
      slackAppHomeOpenedEvent({
        type: "event_callback",
        team_id: "T_WORKSPACE",
        event_id: "Ev_MESSAGES",
        event: { type: "app_home_opened", user: "U_VIEWER", tab: "messages" },
      }),
    ).toBeNull();
    expect(
      slackAppHomeOpenedEvent({
        type: "event_callback",
        team_id: "T_WORKSPACE",
        event_id: "x".repeat(257),
        event: { type: "app_home_opened", user: "U_VIEWER", tab: "home" },
      }),
    ).toBeNull();
  });

  test("recognizes only inert App Home URL controls", () => {
    expect(
      isSlackAppHomeLinkAction({
        type: "block_actions",
        actions: [{ action_id: "opengeni.home.open.00000000-0000-4000-8000-000000000001" }],
      }),
    ).toBe(true);
    expect(
      isSlackAppHomeLinkAction({
        type: "block_actions",
        actions: [{ action_id: "opengeni.approval.approve" }],
      }),
    ).toBe(false);
    expect(
      isSlackAppHomeLinkAction({
        type: "block_actions",
        actions: [{ action_id: "opengeni.home.open_all" }, { action_id: "opengeni.home.connect" }],
      }),
    ).toBe(false);
  });

  test("groups, bounds, deduplicates, and escapes authorized task rows", () => {
    const sessions = [
      session("00000000-0000-4000-8000-000000000001", "requires_action", "Approve <prod>"),
      session("00000000-0000-4000-8000-000000000002", "running", "Ship & verify"),
      session("00000000-0000-4000-8000-000000000003", "idle", "Completed task"),
      session("00000000-0000-4000-8000-000000000002", "running", "duplicate"),
      session("00000000-0000-4000-8000-000000000004", "failed", "Review failure"),
    ];
    const blocks = buildSlackAppHomeBlocks({
      sessions,
      workspaceUrl: "https://app.example.test/workspaces/workspace",
      sessionUrl: (id) => `https://app.example.test/workspaces/workspace/sessions/${id}`,
      nowMs: Date.parse("2026-08-14T12:00:00.000Z"),
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Needs your input");
    expect(serialized).toContain("Active");
    expect(serialized).toContain("Recent");
    expect(serialized).toContain("Approve <prod>");
    expect(serialized).toContain("Ship & verify");
    expect(
      blocks
        .filter((block) => block.type === "section")
        .filter((block) => block.block_id?.startsWith("opengeni_home_session_"))
        .every((block) => block.text.type === "plain_text"),
    ).toBe(true);
    expect(serialized).not.toContain("duplicate");
    expect(blocks.filter((block) => block.type === "section")).toHaveLength(7);
    expect(blocks.at(-1)).toMatchObject({ type: "actions", block_id: "opengeni_home_actions" });
  });

  test("access views contain no stale task content", () => {
    const blocks = buildSlackAppHomeAccessBlocks({
      title: "OpenGeni access changed",
      message: "Reconnect before tasks are shown here.",
      actionLabel: "Reconnect OpenGeni",
      actionUrl: "https://app.example.test/workspaces/workspace/capabilities#slack_link=signed",
    });
    expect(JSON.stringify(blocks)).toContain("Reconnect OpenGeni");
    expect(JSON.stringify(blocks)).not.toContain("Your OpenGeni tasks");
  });
});

function session(id: string, status: Session["status"], title: string): Session {
  return {
    id,
    status,
    title,
    initialMessage: title,
    updatedAt: "2026-08-14T11:30:00.000Z",
  } as Session;
}
