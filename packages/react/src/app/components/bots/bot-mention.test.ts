import { describe, expect, test } from "bun:test";

import { botMentionContext, mentionedBots, type MentionedBot } from "./bot-mention";

function bot(name: string, description: string | null = null): MentionedBot {
  return { sessionId: crypto.randomUUID(), name, description };
}

describe("bot mentions", () => {
  test("finds whole-name mentions of picked bots in order", () => {
    const sre = bot("SRE bot", "Watches production");
    const annie = bot("Annie");
    expect(
      mentionedBots("ask @annie, then @SRE bot; not @Annies or @SRE botty", [sre, annie]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Annie", "SRE bot"]);
    expect(mentionedBots("@Annie", [annie, annie])).toHaveLength(1);
    expect(botMentionContext("no mentions here", [annie])).toBeUndefined();
    // A picked bot whose mention was deleted before sending is not sent.
    expect(botMentionContext("never mind", [sre])).toBeUndefined();
  });

  test("routes the request to each bot's chat, or to this chat when it is the bot", () => {
    const sre = bot("SRE bot", "Watches production");
    const annie = bot("Annie");
    const context = botMentionContext("@SRE bot check the alerts and @Annie review #12", [
      sre,
      annie,
    ]);
    expect(context).toContain(`- @SRE bot: sessionId=${sre.sessionId} (Watches production)`);
    expect(context).toContain(`- @Annie: sessionId=${annie.sessionId}\n`);
    expect(context).toContain("session_send_message");

    const inOwnChat = botMentionContext("@Annie review #12", [annie], annie.sessionId);
    expect(inOwnChat).toContain("- @Annie: this chat (do the work here)");
    expect(inOwnChat).not.toContain(`sessionId=${annie.sessionId}`);
  });
});
