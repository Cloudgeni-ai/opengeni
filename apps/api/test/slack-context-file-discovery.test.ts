import { expect, test } from "bun:test";
import {
  slackInvocationModelContext,
  slackReactionTaskText,
} from "../src/integrations/slack-interactions";

test("a design-system reply exposes the earlier PDF's exact Slack identity without claiming an import", () => {
  const prompt = slackInvocationModelContext(
    "1.2",
    {
      kind: "thread",
      nextCursor: null,
      messages: [
        {
          timestamp: "1.1",
          threadTimestamp: "1.1",
          userId: "U_DESIGNER",
          botId: "",
          text: "The updated guide",
          files: [
            {
              id: "F_DESIGN_GUIDE",
              name: "design-system.pdf",
              title: "New design system",
              mimetype: "application/pdf",
              filetype: "pdf",
              mode: "hosted",
              size: 1024,
              originatingHuddleId: "",
              huddleTranscriptFileId: "",
            },
          ],
        },
        {
          timestamp: "1.2",
          threadTimestamp: "1.1",
          userId: "U_OWNER",
          botId: "",
          text: "<@U_BOT> This is the new design system",
          files: [],
        },
      ],
    },
    "C_DESIGN",
  );
  expect(prompt).toContain("New design system (Slack file ID: F_DESIGN_GUIDE)");
  expect(prompt).toContain("Slack channel ID for authorized file reads: C_DESIGN");
  expect(prompt).toContain("not imported workspace files");
  expect(prompt).toContain("do not infer contents from filenames");
  expect(prompt).toContain("ask the user to attach the file to this chat");
  expect(prompt).not.toContain("Imported invocation attachments");
  expect(prompt).not.toContain("<@U_BOT>");
});

test("a reaction carries the trusted channel ID needed to read earlier files", () => {
  const reactedMessage = {
    timestamp: "1.2",
    threadTimestamp: "1.1",
    userId: "U_OWNER",
    botId: "",
    text: "Use this design system",
    files: [],
  };
  const prompt = slackReactionTaskText(
    {
      reactedMessage,
      messages: [
        {
          ...reactedMessage,
          timestamp: "1.1",
          text: "The earlier guide",
          files: [{ id: "F_EARLIER", name: "guide.md", title: "Design guide" }],
        },
      ],
      truncated: false,
    } as never,
    undefined,
    "C_DESIGN",
  );
  expect(prompt).toContain("Slack channel ID for authorized file reads: C_DESIGN");
  expect(prompt).toContain("Design guide (Slack file ID: F_EARLIER)");
  expect(prompt).toContain("not imported workspace files");
  expect(prompt).not.toContain("Imported reacted-message attachments");
});
