// Agents write Markdown for the OpenGeni console, and the Slack bot posts the
// same reply to a thread. These examples are shaped like real Slack-task
// replies: headings, bold, links and bullets must turn into Slack syntax, while
// anything inside code must reach Slack byte for byte.
import { describe, expect, test } from "bun:test";
import {
  slackMrkdwnFromMarkdown,
  stripProviderCitationMarkers,
} from "../src/integrations/slack-mrkdwn";

describe("slackMrkdwnFromMarkdown", () => {
  test("rewrites a typical agent reply into Slack formatting", () => {
    const reply = [
      "## Deploy check",
      "**Status:** healthy in every region. See [the runbook](https://example.com/runbook) for rollback steps.",
      "",
      "### Next steps",
      "- Watch the error rate for **30 minutes**",
      "  * Page on-call if it passes __2%__",
      "- ~~Roll back~~ Not needed",
      "1. Close the incident",
    ].join("\n");

    expect(slackMrkdwnFromMarkdown(reply)).toBe(
      [
        "*Deploy check*",
        "*Status:* healthy in every region. See <https://example.com/runbook|the runbook> for rollback steps.",
        "",
        "*Next steps*",
        "• Watch the error rate for *30 minutes*",
        "  • Page on-call if it passes *2%*",
        "• ~Roll back~ Not needed",
        "1. Close the incident",
      ].join("\n"),
    );
  });

  test("keeps every line inside a code fence exactly as written", () => {
    const body = [
      "# install first, this is a shell comment",
      "echo **not bold** [not](https://a.link) __kept__ ~~kept~~",
      "- not a bullet",
      "  indented `code` stays",
    ];
    const reply = ["Run this:", "", "```bash", ...body, "```", "", "Then **restart**."].join("\n");

    expect(slackMrkdwnFromMarkdown(reply)).toBe(
      ["Run this:", "", "```", ...body, "```", "", "Then *restart*."].join("\n"),
    );
  });

  test("normalises fences Slack does not understand and closes an unclosed one", () => {
    expect(slackMrkdwnFromMarkdown("~~~python\nprint('**x**')\n~~~")).toBe(
      "```\nprint('**x**')\n```",
    );
    // A longer fence is closed only by a fence at least as long.
    expect(slackMrkdwnFromMarkdown("````md\n```\n**inner**\n````\n**after**")).toBe(
      "```\n```\n**inner**\n```\n*after*",
    );
    expect(slackMrkdwnFromMarkdown("Output was cut:\n```\nline **one**")).toBe(
      "Output was cut:\n```\nline **one**\n```",
    );
  });

  test("leaves inline code alone and treats a one-line triple-backtick span as text", () => {
    expect(slackMrkdwnFromMarkdown("Run `bun run **build**` and `[a](https://b.c)` first.")).toBe(
      "Run `bun run **build**` and `[a](https://b.c)` first.",
    );
    expect(slackMrkdwnFromMarkdown("```echo **x**``` then **done**")).toBe(
      "```echo **x**``` then *done*",
    );
  });

  test("turns web and mail links into Slack links", () => {
    expect(
      slackMrkdwnFromMarkdown(
        [
          "Read [Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar)).",
          'Ask [support](mailto:support@example.com "Email us").',
          "Screenshot: ![dashboard](https://example.com/dash.png)",
          "Raw: [https://example.com](https://example.com)",
          "Code label: [`bun test`](https://example.com/ci)",
          "**See [the PR](https://github.com/org/repo/pull/12)**",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Read <https://en.wikipedia.org/wiki/Foo_(bar)|Foo (bar)>.",
        "Ask <mailto:support@example.com|support>.",
        "Screenshot: <https://example.com/dash.png|dashboard>",
        "Raw: <https://example.com>",
        "Code label: <https://example.com/ci|bun test>",
        "*See <https://github.com/org/repo/pull/12|the PR>*",
      ].join("\n"),
    );
  });

  test("escapes Slack control characters in link labels", () => {
    expect(slackMrkdwnFromMarkdown("[R&D <team>](https://example.com/rd)")).toBe(
      "<https://example.com/rd|R&amp;D &lt;team&gt;>",
    );
  });

  test("leaves links Slack cannot open as written", () => {
    const text = "Open [the report](artifact:3f2a) or [the file](sandbox:/workspace/out.md).";
    expect(slackMrkdwnFromMarkdown(text)).toBe(text);
  });

  test("turns every heading level into one bold line without nested emphasis", () => {
    expect(
      slackMrkdwnFromMarkdown(
        [
          "# Summary",
          "###### Deep",
          "## **Already bold** and *emphasised* ##",
          "## Links [stay](https://example.com) and `code` stays",
          "#hashtag is not a heading",
          "#",
        ].join("\n"),
      ),
    ).toBe(
      [
        "*Summary*",
        "*Deep*",
        "*Already bold and emphasised*",
        "*Links <https://example.com|stay> and `code` stays*",
        "#hashtag is not a heading",
        "#",
      ].join("\n"),
    );
  });

  test("leaves text that is already Slack formatting unchanged", () => {
    const slack = [
      "<@U0123ABC> *Done.* _Details_ are in <https://example.com/run|the run>.",
      "> Quoted note",
      "2. Second step",
      "Identifiers like my__var__name and https://example.com/a__b__c stay.",
      "* * *",
      "---",
      "Plain sentence with 3 * 4 = 12.",
    ].join("\n");
    expect(slackMrkdwnFromMarkdown(slack)).toBe(slack);
  });

  test("converts bold inside a block quote", () => {
    expect(slackMrkdwnFromMarkdown("> **Note:** the deploy is paused.")).toBe(
      "> *Note:* the deploy is paused.",
    );
  });

  test("removes provider citation handles before posting", () => {
    // Shaped like a Codex web-search answer that reached a Slack task: the
    // handles have no annotation table, so a Slack reader sees only noise.
    const answer =
      "The **v2 API** is deprecated citeturn1search3turn2view0 and ends in March.citeturn0search1\nUse [v3](https://example.com/v3) instead.";

    expect(slackMrkdwnFromMarkdown(answer)).toBe(
      "The *v2 API* is deprecated and ends in March.\nUse <https://example.com/v3|v3> instead.",
    );
  });
});

describe("stripProviderCitationMarkers", () => {
  test("removes file citations and stray delimiters but keeps the words around them", () => {
    expect(
      stripProviderCitationMarkers("See the notes fileciteturn3file0. Cut short: citeturn4"),
    ).toBe("See the notes. Cut short: citeturn4");
  });

  test("keeps line breaks next to a citation", () => {
    expect(stripProviderCitationMarkers("First.\nciteturn1search0\nSecond.")).toBe(
      "First.\n\nSecond.",
    );
  });
});
