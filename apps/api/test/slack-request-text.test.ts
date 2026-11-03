import { describe, expect, test } from "bun:test";
import {
  slackMentionedUserIds,
  slackReadableRequestText,
} from "../src/integrations/slack-request-text";

const BOT = "U0BRWGKM41K";

describe("the request text a Slack chat shows", () => {
  test("drops the leading mention of Opengeni", () => {
    expect(slackReadableRequestText(`<@${BOT}> do you work?`, BOT, new Map())).toEqual({
      text: "do you work?",
      modelContext: null,
    });
    expect(slackReadableRequestText(`<@${BOT}|opengeni>, do you work?`, BOT, new Map()).text).toBe(
      "do you work?",
    );
  });

  test("shows other people by name and tells the model who they are", () => {
    const names = new Map([["U0SAM", "Sam"]]);
    expect(slackMentionedUserIds(`<@${BOT}> ask <@U0SAM> and <@U0SAM>`, BOT)).toEqual(["U0SAM"]);
    expect(slackReadableRequestText(`<@${BOT}> ask <@U0SAM> about it`, BOT, names)).toEqual({
      text: "ask @Sam about it",
      modelContext:
        "People mentioned in this Slack message, shown by name; mention them in Slack with the id:\n- @Sam is <@U0SAM>",
    });
  });

  test("uses the label in a mention, keeps unknown people and names Opengeni later in the text", () => {
    expect(
      slackReadableRequestText(`ping <@U0ANA|ana> and <@U0X>; <@${BOT}> help`, BOT, new Map()),
    ).toMatchObject({ text: "ping @ana and <@U0X>; @Opengeni help" });
  });

  test("keeps people with the same name apart", () => {
    const names = new Map([
      ["U0SAM", "Sam"],
      ["U0SAM2", "Sam"],
    ]);
    expect(slackReadableRequestText("ask <@U0SAM> and <@U0SAM2>", BOT, names)).toEqual({
      text: "ask <@U0SAM> and <@U0SAM2>",
      modelContext: null,
    });
  });

  test("keeps text that would otherwise be empty", () => {
    expect(slackReadableRequestText(`<@${BOT}>`, BOT, new Map()).text).toBe(`<@${BOT}>`);
    expect(slackReadableRequestText("plain text", null, new Map()).text).toBe("plain text");
  });
});
