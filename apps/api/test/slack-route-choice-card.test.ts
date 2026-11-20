// The "Who should answer in #channel?" picker must say which options are
// agents and which are workspaces, and show each agent recognisably.
import { describe, expect, test } from "bun:test";
import {
  SlackBotOperationConflictError,
  slackMessageWireBlocks,
  type SlackMessageBlock,
} from "../src/integrations/slack-bot";
import {
  legacySlackRouteChoiceWithAgentsBlocks,
  postSlackRouteChoiceWithAgentsCard,
  slackRouteChoiceWithAgentsBlocks,
  type SlackRouteChoiceCardOption,
} from "../src/integrations/slack-route-choice-card";

const agent = (id: string, name: string): SlackRouteChoiceCardOption => ({
  id,
  candidateLabel: name,
  candidateSlackAgentId: `agent-${id}`,
});
const workspace = (id: string, name: string): SlackRouteChoiceCardOption => ({
  id,
  candidateLabel: name,
  candidateSlackAgentId: null,
});

const OPTIONS = [
  agent("o1", "analytics"),
  agent("o2", "Meeting <prep>"),
  workspace("o3", "Analytics"),
  workspace("o4", "Cloudgeni"),
];

const DETAILS = new Map([
  [
    "agent-o1",
    { iconUrl: "https://app.example.test/a1.png", description: "Answers revenue questions." },
  ],
  ["agent-o2", { iconUrl: null, description: "Prepares   briefs." }],
]);

const base = {
  channel: "<#C123>",
  cancelValue: "o1",
  settingsUrl: "https://app.example.test/workspaces/w1",
};

function button(id: string, text: string) {
  return {
    type: "button",
    action_id: "opengeni.route.select",
    value: id,
    text: { type: "plain_text", text },
  };
}

const cancel = {
  type: "actions",
  block_id: "opengeni-route-choice-cancel",
  elements: [
    {
      type: "button",
      action_id: "opengeni.route.cancel",
      value: "o1",
      text: { type: "plain_text", text: "Not now" },
    },
  ],
};

const footer = {
  type: "context",
  elements: [
    {
      type: "mrkdwn",
      text: "Remembered for <#C123>. Change it in <https://app.example.test/workspaces/w1|Opengeni> under Capabilities, then Slack.",
    },
  ],
};

describe("Slack route picker with agents", () => {
  test("groups agents and workspaces, showing each agent's avatar and description", () => {
    expect(
      slackRouteChoiceWithAgentsBlocks({ ...base, options: OPTIONS, agentDetails: DETAILS }),
    ).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Who should answer in <#C123>?" } },
      { type: "section", text: { type: "mrkdwn", text: "*Agents*" } },
      {
        type: "context",
        elements: [
          { type: "image", image_url: "https://app.example.test/a1.png", alt_text: "analytics" },
          { type: "mrkdwn", text: "*analytics*  Answers revenue questions." },
        ],
      },
      {
        type: "actions",
        block_id: "opengeni-route-choice-o1",
        elements: [button("o1", "Choose")],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "*Meeting &lt;prep&gt;*  Prepares briefs." }],
      },
      {
        type: "actions",
        block_id: "opengeni-route-choice-o2",
        elements: [button("o2", "Choose")],
      },
      { type: "section", text: { type: "mrkdwn", text: "*Workspaces*" } },
      {
        type: "actions",
        block_id: "opengeni-route-choice-workspaces",
        elements: [button("o3", "Analytics"), button("o4", "Cloudgeni")],
      },
      { type: "divider" },
      cancel,
      footer,
    ]);
  });

  test("an agent without details is a plain button, and a long description is cut", () => {
    const blocks = slackRouteChoiceWithAgentsBlocks({
      ...base,
      options: [agent("o1", "analytics"), agent("o2", "Ops")],
      agentDetails: new Map([["agent-o2", { iconUrl: null, description: "x".repeat(300) }]]),
    });
    expect(blocks[2]).toEqual({
      type: "actions",
      block_id: "opengeni-route-choice-o1",
      elements: [button("o1", "analytics")],
    });
    const described = blocks[3] as { elements: Array<{ text: string }> };
    expect([...described.elements[0]!.text]).toHaveLength("*Ops*  ".length + 120);
    expect(described.elements[0]!.text.endsWith("…")).toBe(true);
  });

  test("leaves out an empty group and keeps Not now on its own", () => {
    const blocks = slackRouteChoiceWithAgentsBlocks({
      ...base,
      options: [agent("o1", "analytics")],
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("*Agents*");
    expect(text).not.toContain("*Workspaces*");
    expect(text).not.toContain("Opengeni in");
    expect(blocks.slice(-3, -1)).toEqual([{ type: "divider" }, cancel]);

    const onlyWorkspaces = JSON.stringify(
      slackRouteChoiceWithAgentsBlocks({ ...base, options: [workspace("o3", "Analytics")] }),
    );
    expect(onlyWorkspaces).toContain("*Workspaces*");
    expect(onlyWorkspaces).not.toContain("*Agents*");
  });

  test("keeps each group's rows together and valid on the Slack wire", () => {
    const wire = slackMessageWireBlocks(
      slackRouteChoiceWithAgentsBlocks({ ...base, options: OPTIONS, agentDetails: DETAILS }),
    )!;
    const rows = wire.map((block) =>
      block.type === "section"
        ? block.text.text
        : block.type === "actions"
          ? block.elements.map((element) => element.text.text).join(",")
          : block.type,
    );
    expect(rows).toEqual([
      "Who should answer in <#C123>?",
      "*Agents*",
      "context",
      "Choose",
      "context",
      "Choose",
      "*Workspaces*",
      "Analytics",
      "Cloudgeni",
      "divider",
      "Not now",
      "context",
    ]);
    const blockIds = wire.flatMap((block) =>
      "block_id" in block && block.block_id ? [block.block_id] : [],
    );
    expect(new Set(blockIds).size).toBe(blockIds.length);
  });

  function poster(failures: number) {
    const posted: Array<{ operationId: string; blocks: SlackMessageBlock[] }> = [];
    let remaining = failures;
    return {
      posted,
      client: {
        async postMessage(input: { operationId: string; blocks: SlackMessageBlock[] }) {
          if (remaining > 0) {
            remaining -= 1;
            throw new SlackBotOperationConflictError("post");
          }
          posted.push({ operationId: input.operationId, blocks: input.blocks });
          return {};
        },
      },
    };
  }

  const post = {
    ...base,
    options: OPTIONS,
    agentDetails: DETAILS,
    operationId: "op-1",
    userId: "U1",
    text: "Who should answer in <#C123>?",
    boundLabel: (label: string) => label,
  };

  test("re-sends the flat card under the same operation when an earlier release bound it", async () => {
    const { posted, client } = poster(1);
    await postSlackRouteChoiceWithAgentsCard(client, {
      ...post,
      alreadyPosted: async () => false,
    });
    expect(posted).toEqual([
      { operationId: "op-1", blocks: legacySlackRouteChoiceWithAgentsBlocks(post) },
    ]);
    expect(JSON.stringify(posted[0]!.blocks)).toContain("Opengeni in Analytics");
  });

  test("posts nothing more when the card is already up", async () => {
    const { posted, client } = poster(1);
    await postSlackRouteChoiceWithAgentsCard(client, { ...post, alreadyPosted: async () => true });
    expect(posted).toEqual([]);
  });

  test("does not swallow other post failures", async () => {
    await expect(
      postSlackRouteChoiceWithAgentsCard(
        {
          async postMessage() {
            throw new Error("boom");
          },
        },
        { ...post, alreadyPosted: async () => false },
      ),
    ).rejects.toThrow("boom");
  });
});
