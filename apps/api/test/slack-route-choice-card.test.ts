// The "Who should answer in #channel?" picker must say which options are
// agents and which are workspaces.
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
  agent("o2", "Meeting preparation"),
  workspace("o3", "Analytics"),
  workspace("o4", "Cloudgeni"),
];

const base = {
  channel: "<#C123>",
  cancelValue: "o1",
  settingsUrl: "https://app.example.test/workspaces/w1",
};

const cancel = {
  type: "button",
  action_id: "opengeni.route.cancel",
  value: "o1",
  text: { type: "plain_text", text: "Not now" },
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

const option = (value: string, text: string) => ({
  text: { type: "plain_text", text, emoji: true },
  value,
});

function menuGroups(blocks: SlackMessageBlock[]) {
  const actions = blocks.find((block) => block.type === "actions");
  const menu = actions?.type === "actions" ? actions.elements[0] : undefined;
  return menu?.type === "static_select"
    ? menu.option_groups.map((group) => [group.label.text, group.options.map((o) => o.text.text)])
    : null;
}

describe("Slack route picker with agents", () => {
  test("offers one menu with an Agents group and a Workspaces group, and Not now beside it", () => {
    expect(
      slackRouteChoiceWithAgentsBlocks({
        ...base,
        options: OPTIONS,
        agentEmoji: new Map([["agent-o1", "📊"]]),
      }),
    ).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Who should answer in <#C123>?" } },
      {
        type: "actions",
        block_id: "opengeni-route-choice",
        elements: [
          {
            type: "static_select",
            action_id: "opengeni.route.select",
            placeholder: { type: "plain_text", text: "Choose who answers" },
            option_groups: [
              {
                label: { type: "plain_text", text: "Agents" },
                options: [option("o1", "📊 analytics"), option("o2", "Meeting preparation")],
              },
              {
                label: { type: "plain_text", text: "Workspaces" },
                options: [option("o3", "Analytics"), option("o4", "Cloudgeni")],
              },
            ],
          },
          cancel,
        ],
      },
      footer,
    ]);
  });

  test("leaves out an empty group and never says Opengeni in", () => {
    const agentsOnly = slackRouteChoiceWithAgentsBlocks({
      ...base,
      options: [agent("o1", "analytics")],
    });
    expect(menuGroups(agentsOnly)).toEqual([["Agents", ["analytics"]]]);
    expect(JSON.stringify(agentsOnly)).not.toContain("Opengeni in");
    const workspacesOnly = slackRouteChoiceWithAgentsBlocks({
      ...base,
      options: [workspace("o3", "Analytics")],
    });
    expect(menuGroups(workspacesOnly)).toEqual([["Workspaces", ["Analytics"]]]);
  });

  test("keeps option text within Slack's limit, dropping the emoji first", () => {
    const long = "x".repeat(74);
    const blocks = slackRouteChoiceWithAgentsBlocks({
      ...base,
      options: [agent("o1", long), agent("o2", "y".repeat(90))],
      agentEmoji: new Map([
        ["agent-o1", "📊"],
        ["agent-o2", "📊"],
      ]),
    });
    const [[, texts]] = menuGroups(blocks) as [[string, string[]]];
    expect(texts[0]).toBe(long);
    expect([...texts[1]!]).toHaveLength(75);
    expect(texts[1]!.endsWith("…")).toBe(true);
  });

  test("goes to Slack as one row: the menu and Not now are not split apart", () => {
    const blocks = slackRouteChoiceWithAgentsBlocks({ ...base, options: OPTIONS });
    expect(slackMessageWireBlocks(blocks)).toEqual(blocks);
  });

  test("the repair card is byte-for-byte the card earlier releases posted", () => {
    // Literal copy of the flat card main rendered before this change; the
    // ledger digest of an already-bound operation is over exactly these bytes.
    const legacyButton = (value: string, text: string) => ({
      type: "button",
      action_id: "opengeni.route.select",
      value,
      text: { type: "plain_text", text },
    });
    expect(
      JSON.stringify(
        legacySlackRouteChoiceWithAgentsBlocks({
          ...base,
          options: OPTIONS,
          agentEmoji: new Map([["agent-o1", "📊"]]),
          boundLabel: (label) => label,
        }),
      ),
    ).toBe(
      JSON.stringify([
        { type: "section", text: { type: "mrkdwn", text: "Who should answer in <#C123>?" } },
        {
          type: "actions",
          block_id: "opengeni-route-choice",
          elements: [
            legacyButton("o1", "analytics"),
            legacyButton("o2", "Meeting preparation"),
            legacyButton("o3", "Opengeni in Analytics"),
            legacyButton("o4", "Opengeni in Cloudgeni"),
            cancel,
          ],
        },
        footer,
      ]),
    );
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
    operationId: "op-1",
    userId: "U1",
    text: "Who should answer in <#C123>?",
    boundLabel: (label: string) => label,
  };

  test("re-sends the flat card under the same operation when an earlier release bound it", async () => {
    const { posted, client } = poster(1);
    await postSlackRouteChoiceWithAgentsCard(client, { ...post, alreadyPosted: async () => false });
    expect(posted).toEqual([
      { operationId: "op-1", blocks: legacySlackRouteChoiceWithAgentsBlocks(post) },
    ]);
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
