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
    ["Message", "Hello there & welcome\nBye"],
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
      "Pay on our usual portal (https://pay.example.net/i/42) — it's due Friday…\nQuestions? kari@example.com or top.",
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
