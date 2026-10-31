import { describe, expect, test } from "bun:test";
import {
  buildSlackAskFormView,
  parseSlackAskSubmission,
  slackAskShortcutText,
} from "../src/integrations/slack-ask-form";

const agentId = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
const metadata = {
  v: 1 as const,
  src: "command" as const,
  c: "11111111-2222-4333-8444-555555555555",
  t: "T1",
  ch: "C1",
  f: null,
};

function submission(overrides: { metadata?: unknown; agent?: string; request?: unknown } = {}) {
  return {
    type: "view_submission",
    team: { id: "T1" },
    user: { id: "U1" },
    view: {
      id: "V1",
      callback_id: "opengeni.ask",
      private_metadata: JSON.stringify(overrides.metadata ?? metadata),
      state: {
        values: {
          opengeni_ask_agent: {
            agent: { selected_option: { value: overrides.agent ?? agentId } },
          },
          opengeni_ask_request: { request: { value: overrides.request ?? "  revenue?  " } },
        },
      },
    },
  };
}

describe("Slack Ask form", () => {
  test("lists Opengeni first and preselects an agent only when asked", () => {
    const agents = [{ id: agentId, name: "Analytics", description: "Revenue." }];
    const plain = buildSlackAskFormView({ agents, metadata }) as {
      blocks: { block_id: string; element?: Record<string, unknown> }[];
    };
    const picker = plain.blocks.find((block) => block.block_id === "opengeni_ask_agent")!;
    expect(picker.element).toMatchObject({
      options: [{ value: "opengeni" }, { value: agentId, description: { text: "Revenue." } }],
      initial_option: { value: "opengeni" },
    });
    const chosen = buildSlackAskFormView({ agents, metadata, preselectedAgentId: agentId }) as {
      blocks: { block_id: string; element?: { initial_option?: { value: string } } }[];
    };
    expect(
      chosen.blocks.find((block) => block.block_id === "opengeni_ask_agent")!.element!
        .initial_option!.value,
    ).toBe(agentId);
    expect(JSON.parse(String((plain as Record<string, unknown>).private_metadata))).toEqual(
      metadata,
    );
  });

  test("reads a submission and rejects malformed ones", () => {
    expect(parseSlackAskSubmission(submission())).toEqual({
      viewId: "V1",
      slackTeamId: "T1",
      slackUserId: "U1",
      metadata,
      agentId,
      request: "revenue?",
    });
    expect(parseSlackAskSubmission(submission({ agent: "opengeni" }))?.agentId).toBeNull();
    expect(parseSlackAskSubmission(submission({ agent: "not-an-agent" }))).toBeNull();
    expect(parseSlackAskSubmission(submission({ metadata: { ...metadata, v: 2 } }))).toBeNull();
    expect(
      parseSlackAskSubmission(submission({ metadata: { ...metadata, extra: true } })),
    ).toBeNull();
    expect(parseSlackAskSubmission({ ...submission(), type: "block_actions" })).toBeNull();
    expect(parseSlackAskSubmission(submission({ request: 42 }))?.request).toBe("");
  });

  test("puts what the person added before the shortcut's message", () => {
    expect(slackAskShortcutText("the message", "  ")).toBe("the message");
    expect(slackAskShortcutText("the message", "why?")).toBe("why?\n\nMessage:\nthe message");
  });
});
