import { describe, expect, test } from "bun:test";
import type { App } from "@microsoft/teams.apps";
import {
  teamsAiGeneratedEntity,
  teamsCommand,
  teamsConnectText,
  teamsConversationOffText,
  teamsEventUuid,
  teamsHelp,
  teamsMarkdown,
  teamsMarkdownParts,
  teamsNoticeCard,
  teamsPlainPreview,
  teamsAccountReply,
  teamsNotLinkedReply,
  teamsWelcome,
  TEAMS_CONNECT_REMINDER_TEXT,
  TEAMS_SHARED_CONNECT_TEXT,
  TEAMS_WORK_ACCOUNT_TEXT,
  type TeamsExperienceState,
} from "../src/integrations/teams-experience";
import {
  normalizeTeamsFeedback,
  normalizeTeamsMessage,
  teamsPersonalInstall,
  teamsUnreadablePersonalMessage,
} from "../src/integrations/teams-protocol";
import {
  keepTeamsTyping,
  sendTeamsReply,
  type TeamsTypingLoop,
  teamsNoticeActivity,
} from "../src/integrations/teams-bot";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";

const states: TeamsExperienceState[] = [true, false].flatMap((personal) =>
  (["active", "unavailable"] as const).flatMap((installation) =>
    [true, false].map((linked) => ({ personal, installation, linked })),
  ),
);

describe("Teams commands", () => {
  test("only a whole-message command counts", () => {
    expect(teamsCommand("help")).toBe("help");
    expect(teamsCommand("  Help! ")).toBe("help");
    expect(teamsCommand("/help")).toBe("help");
    expect(teamsCommand("unlink")).toBe("unlink");
    expect(teamsCommand("Disconnect")).toBe("unlink");
    expect(teamsCommand("unlink  confirm")).toBe("unlink_confirm");
    expect(teamsCommand("Link")).toBe("link");
    expect(teamsCommand("help me write a plan")).toBeNull();
    expect(teamsCommand(`help${" ".repeat(100)}`)).toBeNull();
    expect(teamsCommand("how do I unlink my account?")).toBeNull();
  });
});

describe("Teams welcome and help", () => {
  test.each(states)(
    "welcome says what Opengeni is, that it is AI, its requirements and how to get help (%o)",
    (state) => {
      const { text } = teamsWelcome(state);
      expect(text).toContain("Opengeni is an AI agent");
      expect(text).toContain("AI-generated");
      expect(text).toContain("You need an Opengeni account");
      expect(text).toContain("Microsoft Teams");
      expect(text).toContain("Files and images");
      expect(text).toContain("**help**");
      expect(text).toContain("**unlink**");
      expect(text).not.toMatch(/https?:/);
    },
  );
  test.each(states)("help is fixed text that stays in Teams (%o)", (state) => {
    const reply = teamsHelp(state);
    expect(reply.text).toContain("**Opengeni help**");
    expect(reply.text).toContain("**unlink**");
    expect(reply.text).toContain("thumbs up or down");
    expect(reply.text).toContain("open Opengeni in your web browser");
    expect(reply.text).not.toMatch(/https?:/);
    expect(teamsHelp(state)).toEqual(reply);
  });
  test("help in a 1:1 chat mentions group chats only when the organization has one enabled", () => {
    const tip = "In a group chat or channel where Opengeni is enabled";
    const personal = { personal: true, installation: "active", linked: true } as const;
    expect(teamsHelp(personal).text).not.toContain(tip);
    expect(teamsHelp({ ...personal, sharedConversations: true }).text).toContain(tip);
    const shared = { ...personal, personal: false, sharedConversations: true };
    expect(teamsHelp(shared).text).toContain("Mention me in this conversation");
    expect(teamsHelp(shared).text).not.toContain(tip);
  });
  test("the welcome, help and notices name the bot by the configured app name", () => {
    const appName = "Opengeni Assistant";
    const state = { personal: true, installation: "active", linked: false, appName } as const;
    const welcome = teamsWelcome(state).text;
    expect(welcome.startsWith(`**Welcome to ${appName}**\n\n${appName} is an AI agent`)).toBe(true);
    const help = teamsHelp({ ...state, sharedConversations: true }).text;
    expect(help.startsWith(`**${appName} help**\n\n${appName} is an AI agent`)).toBe(true);
    expect(help).toContain(`In a group chat or channel where ${appName} is enabled`);
    // The service and accounts keep their own name.
    for (const text of [welcome, help]) {
      expect(text).toContain("You need an Opengeni account");
      expect(text).toContain("Link your Opengeni account to start.");
    }
    expect(
      teamsHelp({
        personal: true,
        installation: "unavailable",
        linked: false,
        setup: "connect",
        appName,
      }).text,
    ).toContain(`ask your admin to message ${appName} in Teams and connect it.`);
    expect(teamsConnectText()).toContain("ask your admin to message Opengeni in Teams");
    expect(teamsConversationOffText(appName)).toBe(
      `${appName} isn't turned on in this conversation. Send me a direct message to give me a task instead.`,
    );
    expect(
      teamsWelcome({ personal: true, installation: "active", linked: false }).text,
    ).toStartWith("**Welcome to Opengeni**");
    expect(teamsConversationOffText()).toStartWith("Opengeni isn't turned on");
  });
  test("only an unlinked person in a connected organization's 1:1 chat gets a link button", () => {
    for (const state of states) {
      const action = teamsHelp(state).action;
      const welcome = teamsWelcome(state).action;
      if (state.personal && state.installation === "active" && !state.linked) {
        expect(action).toEqual({ kind: "link", title: "Link account" });
        // A welcome may be read much later, so it asks for a fresh link.
        expect(welcome).toEqual({ kind: "command", title: "Link account", command: "link" });
      } else {
        expect(action).toBeUndefined();
        expect(welcome).toBeUndefined();
      }
    }
    expect(teamsHelp({ personal: false, installation: "active", linked: false }).text).toContain(
      "Send me a direct message to link your Opengeni account",
    );
  });
  test("unlink asks for confirmation with a button that sends the confirm command", () => {
    expect(teamsAccountReply("confirm").action).toEqual({
      kind: "command",
      title: "Unlink account",
      command: "unlink confirm",
    });
    expect(teamsCommand("unlink confirm")).toBe("unlink_confirm");
  });
  test("in an organization that isn't connected, help and unlink carry the way to connect it", () => {
    const unconnected = { personal: true, installation: "unavailable", linked: false } as const;
    const connect = { ...unconnected, setup: "connect" } as const;
    expect(teamsHelp(connect).text).toContain(teamsConnectText());
    expect(teamsHelp(connect).action).toEqual({ kind: "link", title: "Connect your organization" });
    expect(teamsNotLinkedReply(connect)).toEqual({
      text: `Your Teams account isn't linked to Opengeni.\n\n${teamsConnectText()}`,
      action: { kind: "link", title: "Connect your organization" },
    });
    // A welcome may be read much later, so it points to help for a fresh link.
    expect(teamsWelcome(connect).text).toContain(TEAMS_CONNECT_REMINDER_TEXT);
    expect(teamsWelcome(connect).action).toBeUndefined();
    const personalAccount = { ...unconnected, setup: "work_account" } as const;
    expect(teamsHelp(personalAccount).text).toContain(TEAMS_WORK_ACCOUNT_TEXT);
    expect(teamsNotLinkedReply(personalAccount).text).toContain(TEAMS_WORK_ACCOUNT_TEXT);
    expect(teamsHelp(personalAccount).action).toBeUndefined();
    // Without self-serve setup, the operator's support address is the way forward.
    expect(teamsHelp({ ...unconnected, supportEmail: "support@example.test" }).text).toContain(
      "your Microsoft 365 or Teams admin can contact support@example.test",
    );
    expect(teamsHelp(unconnected).action).toBeUndefined();
    // A group chat never gets the button, only where to go.
    const shared = { ...connect, personal: false };
    expect(teamsHelp(shared).text).toContain(TEAMS_SHARED_CONNECT_TEXT);
    expect(teamsHelp(shared).action).toBeUndefined();
  });
  test("unlink from someone not linked in a connected organization offers linking", () => {
    expect(teamsNotLinkedReply({ personal: true, installation: "active", linked: true })).toEqual({
      text: "Your Teams account isn't linked to Opengeni.\n\nLink your Opengeni account to start.",
      action: { kind: "link", title: "Link account" },
    });
  });
  test("help's section headings are spaced from the paragraph above them", () => {
    const { text } = teamsHelp({ personal: true, installation: "active", linked: true });
    // Teams leaves no gap between paragraphs; a list already has one after it.
    expect(text).toContain("done.\n\n<br>\n\n**Commands**\n- **help**");
    expect(text).toContain(
      "unlink**: disconnect your Teams account from Opengeni\n\n**Good to know**",
    );
    expect(text.startsWith("**Opengeni help**\n\n")).toBe(true);
  });
});

describe("Teams notices", () => {
  test("a notice's plain preview drops Markdown marks and link targets and stays short", () => {
    expect(
      teamsPlainPreview("Send **help** or `unlink`.\n\nSee [the guide](https://example.test/g)."),
    ).toBe("Send help or unlink. See the guide.");
    const long = teamsPlainPreview("word ".repeat(100), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
    expect(teamsPlainPreview("## Started\n\nDone.")).toBe("Started Done.");
    // An emoji at the cut is kept whole or dropped, never split.
    const emoji = teamsPlainPreview(`${"a".repeat(8)}😀😀😀`, 10);
    expect(emoji).toBe(`${"a".repeat(8)}😀…`);
    expect(emoji.isWellFormed()).toBe(true);
  });
  test("a notice is a card with its paragraphs and a labelled button, not a bare URL", () => {
    const card = teamsNoticeCard(
      "Started. Follow progress or approve requests in Opengeni.\n\nSend **help** for tips.",
      { title: "Open in Opengeni", url: "https://app.example.test/workspaces/w/sessions/s" },
    );
    expect(card).toEqual({
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.2",
      fallbackText: "Started. Follow progress or approve requests in Opengeni. Send help for tips.",
      body: [
        {
          type: "TextBlock",
          text: "Started. Follow progress or approve requests in Opengeni.",
          wrap: true,
        },
        { type: "TextBlock", text: "Send **help** for tips.", wrap: true },
      ],
      actions: [
        {
          type: "Action.OpenUrl",
          title: "Open in Opengeni",
          url: "https://app.example.test/workspaces/w/sessions/s",
        },
      ],
    });
    expect(JSON.stringify(card.body)).not.toContain("https:");
  });
  test("a notice card's message carries a plain summary for clients that can't show cards", () => {
    const link = { title: "Open in Opengeni", url: "https://app.example.test/s" };
    const activity = teamsNoticeActivity("Started. Send **help** for tips.", link, "thread-1");
    expect(activity).toMatchObject({
      type: "message",
      summary: "Started. Send help for tips.",
      replyToId: "thread-1",
    });
    expect(activity.attachments[0]!.content.fallbackText).toBe("Started. Send help for tips.");
    expect(teamsNoticeActivity("Started.", link, null)).not.toHaveProperty("replyToId");
  });
});

describe("Teams messages the bot can't read", () => {
  const base = {
    type: "message",
    id: "message-1",
    timestamp: "2026-11-06T10:00:00Z",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    from: { id: "29:human", aadObjectId: actorId },
    recipient: { id: "28:bot" },
    conversation: { id: "a:personal", conversationType: "personal", tenantId },
    channelData: { tenant: { id: tenantId } },
    text: "Summarize this",
  };
  const image = { contentType: "image/png", contentUrl: "https://example.test/a.png" };
  test("a 1:1 message with a file or image, or no text, names its sender, chat and activity", () => {
    for (const body of [
      { ...base, attachments: [image] },
      { ...base, text: "  " },
    ])
      expect(teamsUnreadablePersonalMessage(body)).toEqual({
        tenantId,
        actorId,
        conversationId: "a:personal",
        serviceUrl: "https://smba.trafficmanager.net/emea/",
        botId: "28:bot",
        eventId: "message-1",
        personal: true,
        threadId: null,
      });
  });
  test("readable messages, shared conversations, bots and untrusted service URLs are not", () => {
    expect(normalizeTeamsMessage(base)).not.toBeNull();
    for (const body of [
      base,
      {
        ...base,
        attachments: [{ contentType: "text/html", content: "<p>Summarize this</p>" }],
      },
      {
        ...base,
        attachments: [image],
        conversation: { id: "19:group", conversationType: "groupChat", tenantId },
      },
      { ...base, attachments: [image], from: { ...base.from, role: "bot" } },
      { ...base, attachments: [image], serviceUrl: "https://untrusted.example.test/" },
      {
        ...base,
        attachments: [image],
        conversation: { ...base.conversation, tenantId: "20000000-0000-4000-8000-000000000002" },
      },
    ])
      expect(teamsUnreadablePersonalMessage(body)).toBeNull();
  });
});

describe("Teams Markdown", () => {
  test("tables become nested lists, deep headings bold lines, images links; rules are dropped", () => {
    const input = [
      "# Title",
      "#### Detail",
      "",
      "| Name | Status |",
      "| --- | :---: |",
      "| API | **up** |",
      "| Web | |",
      "",
      "---",
      "![diagram](https://example.test/a.png)",
      "- [ ] todo",
      "- [x] done",
    ].join("\n");
    expect(teamsMarkdown(input)).toBe(
      [
        "# Title",
        "**Detail**",
        "",
        "- **API**",
        "  - Status: **up**",
        "- **Web**",
        "",
        "",
        "[diagram](https://example.test/a.png)",
        "- ☐ todo",
        "- ☑ done",
      ].join("\n"),
    );
  });
  test("each table cell gets its own line, so sentence cells don't run together", () => {
    const input = [
      "| Step | Why it matters | Owner |",
      "| --- | --- | --- |",
      "| Kickoff | Aligns goals. | PM |",
      "| **Train** | Builds confidence. | |",
      "| | Unnamed row. | Ops |",
      "| Solo | | |",
    ].join("\n");
    expect(teamsMarkdown(input)).toBe(
      [
        "- **Kickoff**",
        "  - Why it matters: Aligns goals.",
        "  - Owner: PM",
        "- **Train**",
        "  - Why it matters: Builds confidence.",
        "- Why it matters: Unnamed row.",
        "  - Owner: Ops",
        "- **Solo**",
      ].join("\n"),
    );
    expect(teamsMarkdown(input)).not.toContain(";");
    // A one-column table is a plain list.
    expect(teamsMarkdown("| Item |\n| --- |\n| one |\n| two |")).toBe("- one\n- two");
  });
  test("headings after a paragraph get a gap; bold heading lines stand on their own line", () => {
    expect(
      teamsMarkdown(
        [
          "**Headline:** Support improved.",
          "**Highlights**",
          "- Volume down",
          "",
          "**Risks to watch**",
          "Watch quality.",
          "",
          "### Next steps",
          "Agree owners.",
          "#### Detail",
          "",
          "Closing",
          "---",
        ].join("\n"),
      ),
    ).toBe(
      [
        "**Headline:** Support improved.",
        "",
        "<br>",
        "",
        "**Highlights**",
        "- Volume down",
        "",
        // After a list Teams already leaves a gap.
        "**Risks to watch**",
        "",
        "Watch quality.",
        "",
        "<br>",
        "",
        "### Next steps",
        "Agree owners.",
        "",
        "<br>",
        "",
        "**Detail**",
        "",
        "## Closing",
      ].join("\n"),
    );
    // The first line, a line under a heading, and bold inside a sentence need no gap.
    expect(teamsMarkdown("**Summary**\n- one")).toBe("**Summary**\n- one");
    expect(teamsMarkdown("# Title\n**Sub**")).toBe("# Title\n**Sub**");
    expect(teamsMarkdown("Text with **bold** words.\n**a** and **b**")).toBe(
      "Text with **bold** words.\n**a** and **b**",
    );
    expect(teamsMarkdown("```\ncode\n```\n## After code")).toBe("```\ncode\n```\n## After code");
  });
  test("bold lines in list items, under setext underlines and in a row keep their structure", () => {
    // An indented bold line inside a list item stays in the item.
    expect(teamsMarkdown("- Item one\n  **Note**\n  continued text")).toBe(
      "- Item one\n  **Note**\n  continued text",
    );
    // A bold line underlined with = or - is a heading, not a stray underline.
    expect(teamsMarkdown("**Title**\n===\nBody")).toBe("# **Title**\nBody");
    expect(teamsMarkdown("Intro\n**Title**\n---\nBody")).toBe(
      "Intro\n\n<br>\n\n## **Title**\nBody",
    );
    // Consecutive bold lines each stand on their own line.
    expect(teamsMarkdown("Para\n**A**\n**B**\nText")).toBe(
      "Para\n\n<br>\n\n**A**\n\n**B**\n\nText",
    );
  });
  test("a part never ends on the gap before a heading that starts the next part", () => {
    const text = teamsMarkdown(`${"Paragraph text.\n".repeat(60)}## Next\nMore`);
    const gap = text.indexOf("\n\n<br>\n\n## Next");
    expect(gap).toBeGreaterThan(0);
    // Split exactly where the heading starts.
    const parts = teamsMarkdownParts(text, gap + "\n\n<br>\n\n".length);
    expect(parts.length).toBe(2);
    expect(parts[0]!.endsWith("Paragraph text.\n")).toBe(true);
    expect(parts[0]).not.toContain("<br>");
    expect(parts[1]!.startsWith("## Next")).toBe(true);
  });
  test("leaves code blocks, links, emphasis and lists as written", () => {
    const input = [
      "**Bold** and _italic_ with [a link](https://example.test).",
      "",
      "1. one",
      "2. two",
      "",
      "```md",
      "| a | b |",
      "| - | - |",
      "#### not a heading",
      "---",
      "```",
      "> quoted",
    ].join("\n");
    expect(teamsMarkdown(input)).toBe(input);
  });
  test("tag-like text is escaped outside code so Teams shows it", () => {
    expect(teamsMarkdown("Use List<string> or <name>, see <https://example.test> and `a<b>`")).toBe(
      "Use List\\<string> or \\<name>, see <https://example.test> and `a<b>`",
    );
    expect(teamsMarkdown("1 < 2 and a<br>b")).toBe("1 < 2 and a<br>b");
    expect(teamsMarkdown("```\nList<string>\n```")).toBe("```\nList<string>\n```");
    // Link targets keep their URL; long lines are escaped too.
    expect(teamsMarkdown("[docs](https://x.test/<id>) <b>")).toBe(
      "[docs](https://x.test/<id>) \\<b>",
    );
    const long = `${"word ".repeat(1000)}List<string>`;
    expect(teamsMarkdown(long)).toBe(long.replace("<", "\\<"));
    // Images in code spans stay as written.
    expect(teamsMarkdown("`![a](b.png)` and ![c](d.png)")).toBe("`![a](b.png)` and [c](d.png)");
  });
  test("indented code, and code nested in a list item, is left as written", () => {
    const indented = "Example:\n\n    List<string> xs\n\n    xs.Add(<a>)\n\nList<b>";
    expect(teamsMarkdown(indented)).toBe(
      "Example:\n\n    List<string> xs\n\n    xs.Add(<a>)\n\nList\\<b>",
    );
    const nested = "1. Build:\n\n    ```cpp\n    #include <vector>\n    ```\n2. Run <it>";
    expect(teamsMarkdown(nested)).toBe(
      "1. Build:\n\n    ```cpp\n    #include <vector>\n    ```\n2. Run \\<it>",
    );
    // An indented line continuing a paragraph or a list item is text.
    expect(teamsMarkdown("Text\n    and <b>")).toBe("Text\n    and \\<b>");
    expect(teamsMarkdown("- item\n\n    more <b>")).toBe("- item\n\n    more \\<b>");
  });
  test("only real tables are converted", () => {
    // Indented code and a setext heading containing pipes stay as written.
    const code = "    ls | wc\n    ---";
    expect(teamsMarkdown(code)).toBe(code);
    expect(teamsMarkdown("a | b\n---")).toBe("## a | b");
    expect(teamsMarkdown("Title\n===\n\n---\n- item\n---")).toBe("# Title\n\n\n- item\n");
    // The delimiter row must have one cell per header cell.
    expect(teamsMarkdown("| a | b |\n| --- |\n| 1 | 2 |")).toBe("| a | b |\n| --- |\n| 1 | 2 |");
  });
  test("headings drop their closing sequence", () => {
    expect(teamsMarkdown("## Title ##")).toBe("## Title");
    expect(teamsMarkdown("##### Deep #####")).toBe("**Deep**");
    expect(teamsMarkdown("### C#")).toBe("### C#");
  });
  test("long lines are handled in linear time", () => {
    const inputs = [
      `# ${" ".repeat(40_000)}x`,
      `|${" -".repeat(20_000)}`,
      `a | b\n|${" -".repeat(20_000)}`,
      `![${"[".repeat(40_000)}`,
      `![a](${"x".repeat(40_000)}`,
      `${"<a".repeat(2000)}`,
      `${"`".repeat(1500)}x${"` ".repeat(1000)}<a`,
    ];
    const started = performance.now();
    for (const input of inputs) teamsMarkdownParts(teamsMarkdown(input));
    expect(performance.now() - started).toBeLessThan(1500);
    // Many lines just under the structure limit cost no more than one each.
    for (const separator of ["\u2028", "\u2029"]) {
      const lines = `#${" \t".repeat(2000)}${separator}\n`.repeat(100);
      const begun = performance.now();
      teamsMarkdownParts(teamsMarkdown(lines));
      expect(performance.now() - begun).toBeLessThan(500);
    }
    // Long lines are escaped in one pass, whatever links or backticks they hold.
    let runs = "";
    for (let length = 1; runs.length < 400_000; length += 1) runs += `${"`".repeat(length)}<a `;
    for (const line of ["<a](".repeat(100_000), runs, "![".repeat(200_000)]) {
      const begun = performance.now();
      teamsMarkdown(line);
      expect(performance.now() - begun).toBeLessThan(500);
    }
  });
  test("a plain split is lossless and within the limit, including multibyte text", () => {
    const text = "🦉 hello\n".repeat(5000);
    const parts = teamsMarkdownParts(text, 2000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => Buffer.byteLength(part) <= 2000)).toBe(true);
    // Parts end at line breaks when lines allow it.
    expect(parts.slice(0, -1).every((part) => part.endsWith("\n"))).toBe(true);
  });
  test("a code block cut between parts is closed and reopened", () => {
    const text = `Intro\n\`\`\`ts\n${"const x = 1;\n".repeat(400)}\`\`\`\nAfter`;
    const parts = teamsMarkdownParts(text, 1000);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(1000);
      expect((part.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(parts[1]!.startsWith("```ts\n")).toBe(true);
    expect(parts.at(-1)!.endsWith("```\nAfter")).toBe(true);
  });
  test("a long fence opening line never makes parts oversized or numerous", () => {
    const text = `\`\`\`${"x".repeat(25_000)}\n${"code line\n".repeat(5_000)}\`\`\`\nAfter`;
    const parts = teamsMarkdownParts(text);
    expect(parts.every((part) => Buffer.byteLength(part) <= 20_000)).toBe(true);
    expect(parts.length).toBeLessThanOrEqual(Math.ceil(Buffer.byteLength(text) / 19_000) + 1);
    // The reopening line carries only the fence and its language.
    const info = `\`\`\`python ${"y".repeat(500)}\n${"print(1)\n".repeat(5_000)}\`\`\``;
    const split = teamsMarkdownParts(info);
    expect(split.length).toBeGreaterThan(1);
    expect(split[1]!.startsWith("```python\nprint(1)")).toBe(true);
  });
  test("room for the closing fence is kept when the opening line fills a part", () => {
    const open = `\`\`\`${"z".repeat(995)}\n`;
    const text = `${open}body\n\`\`\``;
    for (const part of teamsMarkdownParts(text, 1000))
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(1000);
  });
  test("every split stays within the limit and close to the minimum part count", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pieces = ["```ts\n", "```\n", "~~~~\n", "word ", "🦉", "\n", "| a |\n", "x".repeat(300)];
    for (let round = 0; round < 200; round += 1) {
      let text = "";
      const length = Math.floor(random() * 400);
      for (let index = 0; index < length; index += 1)
        text += pieces[Math.floor(random() * pieces.length)];
      const limit = 200 + Math.floor(random() * 2000);
      const parts = teamsMarkdownParts(text, limit);
      for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(limit);
      expect(parts.length).toBeLessThanOrEqual(
        Math.ceil((Buffer.byteLength(text) * 2) / limit) + 2,
      );
    }
  });
});

describe("Teams activities", () => {
  const install = (overrides: Record<string, unknown> = {}) => ({
    type: "conversationUpdate",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    from: { id: "29:person", aadObjectId: actorId.toUpperCase() },
    recipient: { id: "28:bot" },
    conversation: { id: "a:personal", conversationType: "personal", tenantId },
    channelData: { tenant: { id: tenantId } },
    membersAdded: [{ id: "28:bot" }],
    ...overrides,
  });
  test("a personal install names the bot and the person", () => {
    expect(teamsPersonalInstall(install())).toEqual({
      tenantId,
      actorId,
      conversationId: "a:personal",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      botId: "28:bot",
    });
    expect(teamsPersonalInstall(install({ membersAdded: [{ id: "29:person" }] }))).toBeNull();
    expect(
      teamsPersonalInstall(
        install({ conversation: { id: "19:g", conversationType: "groupChat", tenantId } }),
      ),
    ).toBeNull();
    expect(
      teamsPersonalInstall(install({ serviceUrl: "https://attacker.example.test/" })),
    ).toBeNull();
    expect(
      teamsPersonalInstall(
        install({
          conversation: {
            id: "a:personal",
            conversationType: "personal",
            tenantId: "10000000-0000-4000-8000-000000000009",
          },
        }),
      ),
    ).toBeNull();
  });
  const feedback = (overrides: Record<string, unknown> = {}) => ({
    type: "invoke",
    name: "message/submitAction",
    id: "invoke-1",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    from: { id: "29:person", aadObjectId: actorId },
    recipient: { id: "28:bot" },
    conversation: { id: "a:personal", conversationType: "personal", tenantId },
    channelData: { tenant: { id: tenantId } },
    replyToId: "bot-message-1",
    value: {
      actionName: "feedback",
      actionValue: { reaction: "dislike", feedback: JSON.stringify({ feedbackText: " Wrong " }) },
    },
    ...overrides,
  });
  test("feedback reads the reaction and the written comment", () => {
    expect(normalizeTeamsFeedback(feedback())).toEqual({
      tenantId,
      actorId,
      conversationId: "a:personal",
      personal: true,
      groupChat: false,
      channelId: null,
      replyToId: "bot-message-1",
      eventId: "invoke-1",
      sentiment: "negative",
      comment: "Wrong",
      botId: "28:bot",
    });
    expect(
      normalizeTeamsFeedback(
        feedback({
          value: { actionName: "feedback", actionValue: { reaction: "like", feedback: "{bad" } },
        }),
      ),
    ).toMatchObject({ sentiment: "positive", comment: null });
  });
  test("long feedback text is kept, shortened", () => {
    const long = normalizeTeamsFeedback(
      feedback({
        value: {
          actionName: "feedback",
          actionValue: {
            reaction: "dislike",
            feedback: JSON.stringify({ feedbackText: "w".repeat(20_000) }),
          },
        },
      }),
    );
    expect(long?.comment).toHaveLength(4000);
    // The limit is in UTF-16 code units, and a surrogate pair is never split.
    const emoji = normalizeTeamsFeedback(
      feedback({
        value: {
          actionName: "feedback",
          actionValue: {
            reaction: "dislike",
            feedback: JSON.stringify({ feedbackText: `x${"🦉".repeat(5000)}` }),
          },
        },
      }),
    );
    expect(emoji?.comment?.length).toBe(3999);
    expect(emoji?.comment?.endsWith("🦉")).toBe(true);
  });
  test("channel feedback names its channel", () => {
    expect(
      normalizeTeamsFeedback(
        feedback({
          conversation: { id: "19:c;messageid=1", conversationType: "channel", tenantId },
          channelData: { tenant: { id: tenantId }, channel: { id: "19:c" } },
        }),
      ),
    ).toMatchObject({ personal: false, groupChat: false, channelId: "19:c" });
    expect(
      normalizeTeamsFeedback(
        feedback({ conversation: { id: "19:c", conversationType: "channel", tenantId } }),
      ),
    ).toBeNull();
  });
  test("feedback refuses other invokes, bots and mismatched tenants", () => {
    expect(normalizeTeamsFeedback(feedback({ name: "adaptiveCard/action" }))).toBeNull();
    expect(normalizeTeamsFeedback(feedback({ replyToId: undefined }))).toBeNull();
    expect(
      normalizeTeamsFeedback(feedback({ from: { id: "28:bot", aadObjectId: actorId } })),
    ).toBeNull();
    expect(
      normalizeTeamsFeedback(
        feedback({
          conversation: {
            id: "a:personal",
            conversationType: "personal",
            tenantId: "10000000-0000-4000-8000-000000000009",
          },
        }),
      ),
    ).toBeNull();
  });
  test("the stable event UUID is a valid, repeatable UUID", () => {
    const id = teamsEventUuid("teams-feedback", "a");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(teamsEventUuid("teams-feedback", "a")).toBe(id);
    expect(teamsEventUuid("teams-feedback", "b")).not.toBe(id);
  });
});

function transport() {
  const calls: Array<{ conversationId: string; activity: Record<string, unknown> }> = [];
  const app = {
    api: {
      fromServiceUrl: () => ({
        conversations: {
          createActivity: async (conversationId: string, activity: Record<string, unknown>) => {
            calls.push({ conversationId, activity });
            return { id: `sent-${calls.length}` };
          },
        },
      }),
    },
  } as unknown as App;
  return { app, calls };
}

describe("Teams deterministic replies", () => {
  const target = {
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    conversationId: "a:personal",
    threadId: null,
    botId: "28:bot",
  };
  test("a link button goes only to a personal chat", async () => {
    const { app, calls } = transport();
    const reply = teamsHelp({ personal: true, installation: "active", linked: false });
    await sendTeamsReply(app, { ...target, personal: true }, reply, () => "https://app.test/#x");
    await sendTeamsReply(app, { ...target, personal: false }, reply, () => "https://app.test/#x");
    expect(calls[0]!.activity).toMatchObject({
      type: "message",
      text: reply.text,
      textFormat: "markdown",
      attachments: [
        {
          content: {
            actions: [
              { type: "Action.OpenUrl", title: "Link account", url: "https://app.test/#x" },
            ],
          },
        },
      ],
    });
    expect(calls[1]!.activity.attachments).toBeUndefined();
    expect(JSON.stringify(calls[1])).not.toContain("app.test");
    // Deterministic replies are not AI-generated.
    expect(calls[0]!.activity.entities).toBeUndefined();
  });
  test("the unlink confirmation button sends the confirm command back as the person", async () => {
    const { app, calls } = transport();
    await sendTeamsReply(app, { ...target, personal: true }, teamsAccountReply("confirm"));
    expect(calls[0]!.activity).toMatchObject({
      attachments: [
        {
          content: {
            actions: [
              {
                type: "Action.Submit",
                title: "Unlink account",
                data: { msteams: { type: "imBack", value: "unlink confirm" } },
              },
            ],
          },
        },
      ],
    });
  });
  test("the AI label entity is the documented schema.org message", () => {
    expect(teamsAiGeneratedEntity()).toEqual({
      type: "https://schema.org/Message",
      "@type": "Message",
      "@context": "https://schema.org",
      "@id": "",
      additionalType: ["AIGeneratedContent"],
    });
  });
});

describe("Teams typing indicator", () => {
  test("repeats while the reply is pending and stops when it is ready", async () => {
    const loops = new Map<string, TeamsTypingLoop>();
    let sent = 0;
    let checks = 0;
    await keepTeamsTyping({
      loops,
      key: "route",
      eventId: "event-1",
      send: async () => {
        sent += 1;
      },
      pending: async () => ++checks < 3,
      intervalMs: 1,
    });
    expect(sent).toBe(3);
    expect(loops.size).toBe(0);
  });
  test("a newer message in the same chat takes over the running loop", async () => {
    const loops = new Map<string, TeamsTypingLoop>();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = keepTeamsTyping({
      loops,
      key: "route",
      eventId: "event-1",
      send: () => gate,
      pending: async () => {
        seen.push("event-1");
        return true;
      },
      intervalMs: 1,
    });
    await keepTeamsTyping({
      loops,
      key: "route",
      eventId: "event-2",
      send: async () => {
        throw new Error("a second loop must not start");
      },
      pending: async () => {
        seen.push("event-2");
        return false;
      },
    });
    expect(loops.get("route")?.eventId).toBe("event-2");
    release();
    await first;
    expect(seen).toEqual(["event-2"]);
  });
  test("a takeover while the previous message is checked keeps the loop going", async () => {
    const loops = new Map<string, TeamsTypingLoop>();
    let sent = 0;
    let secondChecks = 0;
    await keepTeamsTyping({
      loops,
      key: "route",
      eventId: "event-1",
      send: async () => {
        sent += 1;
      },
      pending: async () => {
        // The earlier message is answered, but a newer one arrives meanwhile.
        await keepTeamsTyping({
          loops,
          key: "route",
          eventId: "event-2",
          send: async () => {},
          pending: async () => ++secondChecks < 2,
        });
        return false;
      },
      intervalMs: 1,
    });
    expect(secondChecks).toBe(2);
    expect(sent).toBe(3);
    expect(loops.size).toBe(0);
  });
  test("a takeover restarts the time limit", async () => {
    const loops = new Map<string, TeamsTypingLoop>();
    const first = keepTeamsTyping({
      loops,
      key: "route",
      eventId: "event-1",
      send: async () => {},
      pending: async () => true,
      intervalMs: 2,
      maxMs: 30,
    });
    const before = loops.get("route")!.deadline;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await keepTeamsTyping({
      loops,
      key: "route",
      eventId: "event-2",
      send: async () => {},
      pending: async () => true,
      maxMs: 30,
    });
    expect(loops.get("route")!.deadline).toBeGreaterThan(before);
    await first;
  });
  test("stops at the time limit even while the reply is pending", async () => {
    let sent = 0;
    await keepTeamsTyping({
      loops: new Map(),
      key: "route",
      eventId: "event-1",
      send: async () => {
        sent += 1;
      },
      pending: async () => true,
      intervalMs: 5,
      maxMs: 20,
    });
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(10);
  });
});
