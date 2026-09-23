import { describe, expect, test } from "bun:test";
import { slackMessageWireBlocks, type SlackMessageBlock } from "../src/integrations/slack-bot";

describe("Slack action block wire serialization", () => {
  test("partitions repeated actions while preserving the logical receipt and exact handles", () => {
    const blocks: SlackMessageBlock[] = [
      {
        type: "actions",
        block_id: "choose-workspace",
        elements: ["workspace-a", "workspace-b"].map((value) => ({
          type: "button",
          action_id: "opengeni.route.select",
          value,
          text: { type: "plain_text", text: value },
        })),
      },
    ];
    const before = JSON.stringify(blocks);
    const wire = slackMessageWireBlocks(blocks)!;
    expect(wire).toHaveLength(2);
    expect(JSON.stringify(blocks)).toBe(before);
    expect(wire).toEqual(slackMessageWireBlocks(blocks));
    expect(new Set(wire.map((b) => ("block_id" in b ? b.block_id : null))).size).toBe(2);
    expect(wire.flatMap((b) => (b.type === "actions" ? b.elements : []))).toEqual(
      blocks[0]!.type === "actions" ? blocks[0].elements : [],
    );
  });
  test("leaves valid existing cards unchanged and bounds the expanded wire payload", () => {
    const block: SlackMessageBlock = {
      type: "actions",
      block_id: "status",
      elements: [
        {
          type: "button",
          action_id: "status",
          value: "handle",
          text: { type: "plain_text", text: "Status" },
        },
      ],
    };
    expect(slackMessageWireBlocks([block])).toEqual([block]);
    expect(slackMessageWireBlocks(undefined)).toBeUndefined();
    expect(() =>
      slackMessageWireBlocks([
        { ...block, elements: Array.from({ length: 51 }, () => block.elements[0]!) },
      ]),
    ).toThrow("count");
  });
});
