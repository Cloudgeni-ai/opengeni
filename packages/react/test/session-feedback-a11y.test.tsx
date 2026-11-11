import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionFeedback } from "../src/app/components/feedback";

const client = {
  listOwnFeedback: async () => ({ items: [] }),
} as unknown as Parameters<typeof SessionFeedback>[0]["client"];

function containerTag(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<div[^>]*aria-label="${label}"[^>]*>`));
  if (!match) throw new Error(`no labelled container for ${label}`);
  return match[0];
}

describe("SessionFeedback accessibility", () => {
  test("names the reply feedback controls as a group", () => {
    const markup = renderToStaticMarkup(
      <SessionFeedback
        client={client}
        workspaceId="w"
        sessionId="s"
        turnId="t"
        savedSentiment={null}
      />,
    );
    expect(containerTag(markup, "Reply feedback")).toContain('role="group"');
  });

  test("names the session feedback controls as a group", () => {
    const markup = renderToStaticMarkup(
      <SessionFeedback client={client} workspaceId="w" sessionId="s" savedSentiment={null} />,
    );
    expect(containerTag(markup, "Session feedback")).toContain('role="group"');
  });
});
