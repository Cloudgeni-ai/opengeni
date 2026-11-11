import { expect, test } from "bun:test";
import { toolReviewDetails, toolReviewFields } from "../src/tool-action-review";

const api = { kind: "api" } as const;
const rows = (args: unknown, context: Parameters<typeof toolReviewFields>[1] = api) =>
  toolReviewFields(args, context, "api_tool").fields.map((field) => [field.label, field.preview]);

const draft = {
  path: { "mailFolder-id": "drafts" },
  body: {
    subject: "Q3 report summary",
    body: { contentType: "Text", content: "Hi Kari,\n\nHere is the summary.\n\nOla" },
    toRecipients: [{ emailAddress: { address: "kari@example.com", name: "Kari Nordmann" } }],
    ccRecipients: [],
  },
};

test("an API request reads as the message it sends: recipients, subject and text first", () => {
  expect(rows(draft)).toEqual([
    ["To", "Kari Nordmann <kari@example.com>"],
    ["Subject", "Q3 report summary"],
    ["Message", "Hi Kari,\n\nHere is the summary.\n\nOla"],
    ["Mail folder ID", "drafts"],
  ]);
});

test("each plain reading still opens its exact structure in Details", () => {
  const { fields } = toolReviewFields(draft, api, "api_tool");
  const to = fields.find((field) => field.label === "To")!;
  expect(to).toMatchObject({ path: "/body/toRecipients", truncated: false, count: 1 });
  const details = toolReviewDetails(draft, undefined, to.path, 0);
  expect(details.total).toBe(1);
  const message = fields.find((field) => field.label === "Message")!;
  expect(toolReviewDetails(draft, undefined, message.path, 0).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: "Content type", value: "Text" })]),
  );
});

test("a wrapped message, HTML text, events and places read plainly", () => {
  expect(
    rows({
      body: {
        message: {
          subject: "Hello",
          body: {
            contentType: "HTML",
            content: "<p>Hello <b>there</b> &amp; welcome</p><p>Bye</p>",
          },
          toRecipients: [{ emailAddress: { address: "a@example.com" } }],
        },
        saveToSentItems: true,
      },
    }),
  ).toEqual([
    ["To", "a@example.com"],
    ["Subject", "Hello"],
    ["Message", "Hello there & welcome\n\nBye"],
    ["Save to sent items", "Yes"],
  ]);
  expect(
    rows({
      body: {
        subject: "Sync",
        start: { dateTime: "2026-10-28T10:00:00.0000000", timeZone: "Europe/Oslo" },
        end: { dateTime: "2026-10-28T10:30:00", timeZone: "Europe/Oslo" },
        location: { displayName: "Room 4" },
        attendees: [{ emailAddress: { address: "k@example.com", name: "K" }, type: "required" }],
      },
    }),
  ).toEqual([
    ["Subject", "Sync"],
    ["Starts", "2026-10-28 10:00 (Europe/Oslo)"],
    ["Ends", "2026-10-28 10:30 (Europe/Oslo)"],
    ["Location", "Room 4"],
    ["Attendees", "K <k@example.com>"],
  ]);
});

test("protected values stay hidden at any depth, and unknown privacy keeps the plain envelope", () => {
  const { fields } = toolReviewFields(
    { body: { subject: "Hi", credentials: { password: "x" } } },
    { kind: "api", protectedFields: ["credentials"] },
    "api_tool",
  );
  expect(fields.find((field) => field.path === "/body/credentials")).toMatchObject({
    protected: true,
    preview: "[Protected value]",
  });
  expect(rows(draft, { kind: "api", protectedFields: ["*"] }).map(([label]) => label)).toEqual([
    "Path",
    "Body",
  ]);
});

test("arguments that are not an HTTP request keep their usual fields", () => {
  expect(rows({ path: "/tmp/notes.txt", body: "text" })).toEqual([
    ["Path", "/tmp/notes.txt"],
    ["Body", "text"],
  ]);
  expect(rows({ query: "status:open", limit: 5 })).toEqual([
    ["Query", "status:open"],
    ["Limit", "5"],
  ]);
});

test("only an API integration's arguments read as an HTTP request", () => {
  expect(rows({ body: { subject: "Hi" } }, { kind: "generic" })).toEqual([["Body", "1 field"]]);
  expect(
    toolReviewFields({ query: { q: "x" } }, undefined, "search").fields.map((field) => [
      field.label,
      field.preview,
    ]),
  ).toEqual([["Query", "1 field"]]);
});

test("times keep their minutes, with seconds only when they matter", () => {
  const at = (dateTime: string, timeZone?: string) =>
    rows({ body: { start: { dateTime, ...(timeZone ? { timeZone } : {}) } } })[0]![1];
  expect(at("2026-10-28T10:00", "Europe/Oslo")).toBe("2026-10-28 10:00 (Europe/Oslo)");
  expect(at("2026-10-28T00:00:00.0000000", "UTC")).toBe("2026-10-28 00:00 (UTC)");
  expect(at("2026-10-28T09:15:30")).toBe("2026-10-28 09:15:30");
  expect(at("2026-10-28T09:15:00Z")).toBe("2026-10-28 09:15 UTC");
  expect(at("2026-10-28T23:30:15Z", "UTC")).toBe("2026-10-28 23:30:15 UTC");
});

test("a link always shows where it goes, closed or not, and only its real href counts", () => {
  const message = (content: string) =>
    rows({ body: { body: { contentType: "HTML", content } } })[0]![1];
  expect(
    message(
      '<a data-href="https://bank.example" href="https://evil.example">https://bank.example</a>',
    ),
  ).toBe("https://bank.example (https://evil.example)");
  expect(message('<p><a href="https://evil.example/login">sign in here</p><p>Thanks</p>')).toBe(
    "sign in here (https://evil.example/login)\n\nThanks (https://evil.example/login)",
  );
  expect(
    message('<a href="https://x.example/a">outer <a href="https://y.example">inner</a></a>'),
  ).toBe("outer (https://x.example/a) inner (https://y.example)");
  // Decoded once: "&amp;#64;" is the text "&#64;", not "@".
  expect(
    message('<a href="https://bank.example&amp;#64;evil.example">bank</a> a &amp;#64; b'),
  ).toBe("bank (https://bank.example&#64;evil.example) a &#64; b");
  // A ">" inside an attribute stays inside the tag.
  expect(message('<span title="a > b">Hi</span> <img alt="x"> 1 < 2')).toBe("Hi 1 < 2");
  expect(message('<a href="https://img.example"><img src="logo.png"></a>')).toBe(
    "https://img.example",
  );
});

test("every link target a browser would make clickable shows, however the HTML is written", () => {
  const message = (content: string) =>
    rows({ body: { body: { contentType: "HTML", content } } })[0]![1];
  const pay = "pay (https://e.example)";
  // Script and style end at their first literal closing tag, quoted or not.
  expect(message('<script>var s = "</script>";</script><a href="https://e.example">pay</a>')).toBe(
    `";${pay}`,
  );
  expect(
    message('<style>a::after{content:"</style>"}</style><a href=https://e.example>pay</a>'),
  ).toBe(`"}${pay}`);
  // A head that is never closed hides nothing.
  expect(message("<head><p>Please <a href=https://e.example>pay</a>")).toBe(`Please ${pay}`);
  // Every comment ending browsers accept.
  expect(message("<!-->Hi <a href=https://e.example>pay</a>")).toBe(`Hi ${pay}`);
  expect(message("<!--->Hi <a href=https://e.example>pay</a>")).toBe(`Hi ${pay}`);
  expect(message("<!-- x --!>Hi <a href=https://e.example>pay</a>")).toBe(`Hi ${pay}`);
  // A stray quote in an unquoted value, of either kind.
  expect(message("<i class=a'b>Hi</i> <a href=https://e.example>pay</a>")).toBe(`Hi ${pay}`);
  expect(message('<i class=a"b>Hi</i> <a href=https://e.example>pay</a>')).toBe(`Hi ${pay}`);
  // SVG links, and "<!--" inside an attribute value.
  expect(message('<svg><a xlink:href="https://e.example"><text>pay</text></a></svg>')).toBe(pay);
  expect(message('<a title="<!--" href="https://e.example">pay</a> <!-- x -->')).toBe(pay);
  // An empty link before another doesn't run into its text.
  expect(
    message('<a href="https://evil.example/pay"><a href="https://good.example">good.example</a>'),
  ).toBe("https://evil.example/pay good.example (https://good.example)");
  // Fail-safe: a target the text doesn't show is listed first.
  expect(message('<map><area href="https://map.example"></map><p>Hello</p>')).toBe(
    "Links: https://map.example\n\nHello",
  );
});

test("a huge or broken HTML message still builds its card quickly", () => {
  const started = performance.now();
  const content = `${"<a ".repeat(100_000)}<a href="https://e.example">pay</a>`;
  const preview = rows({ body: { body: { contentType: "HTML", content } } })[0]![1];
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(preview).toContain("https://e.example");
});

test("header values show on the card, and cookies show as protected", () => {
  expect(
    rows({ path: { id: "7" }, header: { "If-Match": "*" }, cookie: { theme: "dark" } }),
  ).toEqual([
    ["ID", "7"],
    ["If match", "*"],
    ["Theme", "[Protected value]"],
  ]);
});

test("an HTML message shows where its links go, with entities and comments read plainly", () => {
  const html = [
    "<html><head><title>Invoice</title><style>p{}</style></head><body>",
    "<!-- tracking -->",
    '<p>Pay on <a href="https://pay.example.net/i/42">our usual portal</a> &mdash; it&#x27;s due Friday&#8230;</p>',
    "<p>Questions? <a href='mailto:kari@example.com'>kari@example.com</a> or <a href=\"#top\">top</a>.</p>",
    "</body></html>",
  ].join("");
  expect(rows({ body: { body: { contentType: "HTML", content: html } } })).toEqual([
    [
      "Message",
      "Pay on our usual portal (https://pay.example.net/i/42) — it's due Friday…\n\nQuestions? kari@example.com or top.",
    ],
  ]);
});

test("attachments read as file names, optional attendees say so, and the text stays near the top", () => {
  const to = [{ emailAddress: { address: "a@example.com" } }];
  expect(
    rows({
      body: {
        ccRecipients: to,
        bccRecipients: to,
        from: to[0],
        replyTo: to,
        body: { contentType: "Text", content: "Hello" },
        subject: "Report",
        toRecipients: to,
        attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: "Q3.docx" }],
        attendees: [
          { emailAddress: { address: "o@example.com" }, type: "optional" },
          { emailAddress: { address: "r@example.com" }, type: "required" },
        ],
      },
      contentType: "application/json",
    }).map(([label, preview]) => `${label}: ${preview}`),
  ).toEqual([
    "To: a@example.com",
    "Subject: Report",
    "Message: Hello",
    "Cc: a@example.com",
    "Bcc: a@example.com",
    "From: a@example.com",
    "Reply to: a@example.com",
    "Attendees: o@example.com (optional), r@example.com",
    "Attachments: Q3.docx",
    "Content type: application/json",
  ]);
});

const htmlMessage = (content: string) =>
  toolReviewFields({ body: { body: { contentType: "HTML", content } } }, api, "api_tool")
    .fields[0]!;

test("a long message still shows every link target, even one past the preview's cut", () => {
  const paragraphs = Array.from(
    { length: 30 },
    (_, index) => `<p>Paragraph ${index + 1} of the quarterly update, nothing to click here.</p>`,
  ).join("\r\n");
  const content = `${paragraphs}<p>Pay on <a href="https://evil.example/pay">https://bank.example</a></p>`;
  const message = htmlMessage(content);
  expect(message.truncated).toBe(true);
  expect(message.preview.startsWith("Links: https://evil.example/pay\n\nParagraph 1 of")).toBe(
    true,
  );
  expect(message.preview.endsWith("…")).toBe(true);
  // A target cut part way is not shown: "https://evil.example/pa…" names another address.
  const cut = "x".repeat(1000 - "Pay on https://bank.example (https://evil.example/pa".length);
  const partly = htmlMessage(
    `${cut}Pay on <a href="https://evil.example/pay">https://bank.example</a>`,
  );
  expect(partly.preview.startsWith("Links: https://evil.example/pay\n\n")).toBe(true);
  // A target the preview shows whole is not repeated.
  const short = htmlMessage('<p>Pay on <a href="https://evil.example/pay">our portal</a>.</p>');
  expect(short).toMatchObject({
    preview: "Pay on our portal (https://evil.example/pay).",
    truncated: false,
  });
  // Links beyond the part of the HTML that is read are listed too.
  const huge = htmlMessage(
    `${"<p>filler</p>".repeat(20_000)}<a href="https://late.example">ok</a>`,
  );
  expect(huge.preview.startsWith("Links: https://late.example\n\n")).toBe(true);
});

test("a very long list of link targets points to Details, which lists every one", () => {
  const content = Array.from(
    { length: 400 },
    (_, index) => `<area href="https://link-${index}.example/some/longer/path">`,
  ).join("");
  const args = { body: { body: { contentType: "HTML", content } } };
  const message = htmlMessage(content);
  expect(message.preview).toMatch(/^Links: https:\/\/link-0\.example\/some\/longer\/path, /);
  expect(message.preview).toMatch(/, and \d+ more\. Details lists every link\.\n\n$/);
  expect(message.truncated).toBe(true);
  // The message's Details lead with all 400 targets, page by page, then its fields.
  const first = toolReviewDetails(args, undefined, message.path, 0);
  expect(first.total).toBe(402);
  expect(first.items[0]).toEqual({
    label: "Link 1",
    value: "https://link-0.example/some/longer/path",
  });
  const last = toolReviewDetails(args, undefined, message.path, 380);
  expect(last.items.map((item) => item.label).slice(-3)).toEqual([
    "Link 400",
    "Content type",
    "Content",
  ]);
  expect(last.items.at(-1)).toMatchObject({ path: `${message.path}/content`, truncated: true });
  expect(last.nextOffset).toBeNull();
  // A message without links keeps its plain fields.
  const plain = toolReviewDetails(
    { body: { body: { contentType: "HTML", content: "<p>Hi</p>" } } },
    undefined,
    message.path,
    0,
  );
  expect(plain.items.map((item) => item.label)).toEqual(["Content type", "Content"]);
});

test("link targets decode exactly as a browser decodes them, and form destinations show", () => {
  const target = (href: string) =>
    htmlMessage(`<a href="${href}">bank.example</a>`).preview.replace(
      /^bank\.example \((.*)\)$/,
      "$1",
    );
  // Numeric references without a semicolon, and any named reference.
  expect(target("https://bank.example&#64evil.example")).toBe("https://bank.example@evil.example");
  expect(target("https://bank.example&commat;evil.example")).toBe(
    "https://bank.example@evil.example",
  );
  expect(target("https://bank.example&period;evil.example")).toBe(
    "https://bank.example.evil.example",
  );
  // In an attribute, a legacy reference followed by "=" stays as written.
  expect(target("https://e.example/?a=1&copy=2")).toBe("https://e.example/?a=1&copy=2");
  expect(
    htmlMessage('<form action="https://collect.example/post"><button>Send</button></form>').preview,
  ).toBe("Links: https://collect.example/post\n\nSend");
});

test("blocks break lines the way a browser lays them out", () => {
  expect(htmlMessage("<p>One<p>Two<div>Three</div>Four").preview).toBe("One\n\nTwo\nThree\nFour");
  expect(htmlMessage("<ul><li>a</li><li>b</li></ul>after").preview).toBe("a\nb\nafter");
  expect(htmlMessage("a<br>b<br><br>c<br><br><br>d").preview).toBe("a\nb\n\nc\n\nd");
  expect(htmlMessage("Hello\r\n  there&nbsp;you&shy;r").preview).toBe("Hello there your");
});
