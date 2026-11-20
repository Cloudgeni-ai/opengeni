// The "Who should answer in #channel?" picker must say which buttons are
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
  test("groups agents and workspaces under their own labels, with plain names", () => {
    expect(slackRouteChoiceWithAgentsBlocks({ ...base, options: OPTIONS })).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Who should answer in <#C123>?" },
      },
      { type: "section", text: { type: "mrkdwn", text: "*Agents*" } },
      {
        type: "actions",
        block_id: "opengeni-route-choice-agents",
        elements: [button("o1", "analytics"), button("o2", "Meeting preparation")],
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
      slackRouteChoiceWithAgentsBlocks({
        ...base,
        options: [workspace("o3", "Analytics")],
      }),
    );
    expect(onlyWorkspaces).toContain("*Workspaces*");
    expect(onlyWorkspaces).not.toContain("*Agents*");
  });

  test("keeps the group label above its buttons on the Slack wire", () => {
    const wire = slackMessageWireBlocks(
      slackRouteChoiceWithAgentsBlocks({ ...base, options: OPTIONS }),
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
      "analytics",
      "Meeting preparation",
      "*Workspaces*",
      "Analytics",
      "Cloudgeni",
      "divider",
      "Not now",
      "context",
    ]);
  });

  test("re-sends the flat card under the same operation when an earlier release bound it", async () => {
    const posted: Array<{ operationId: string; blocks: SlackMessageBlock[] }> = [];
    let first = true;
    await postSlackRouteChoiceWithAgentsCard(
      {
        async postMessage(input) {
          if (first) {
            first = false;
            throw new SlackBotOperationConflictError("post");
          }
          posted.push(input);
          return {};
        },
      },
      {
        ...base,
        options: OPTIONS,
        operationId: "op-1",
        userId: "U1",
        text: "Who should answer in <#C123>?",
        boundLabel: (label) => label,
      },
    );
    expect(posted).toEqual([
      {
        operationId: "op-1",
        blocks: legacySlackRouteChoiceWithAgentsBlocks({
          ...base,
          options: OPTIONS,
          boundLabel: (label) => label,
        }),
        userId: "U1",
        text: "Who should answer in <#C123>?",
      } as never,
    ]);
    expect(JSON.stringify(posted[0]!.blocks)).toContain("Opengeni in Analytics");
  });

  test("does not swallow other post failures", async () => {
    await expect(
      postSlackRouteChoiceWithAgentsCard(
        {
          async postMessage() {
            throw new Error("boom");
          },
        },
        {
          ...base,
          options: OPTIONS,
          operationId: "op-1",
          userId: "U1",
          text: "q",
          boundLabel: (label) => label,
        },
      ),
    ).rejects.toThrow("boom");
  });
});
