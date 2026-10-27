import { expect, test } from "bun:test";
import { toolReviewDetails, toolReviewFields } from "../src/tool-action-review";

const rows = (args: unknown, context?: Parameters<typeof toolReviewFields>[1]) =>
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
  const { fields } = toolReviewFields(draft, undefined, "api_tool");
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
    ["Attendees", "K <k@example.com>"],
    ["Starts", "2026-10-28 10:00 (Europe/Oslo)"],
    ["Ends", "2026-10-28 10:30 (Europe/Oslo)"],
    ["Location", "Room 4"],
  ]);
});

test("protected values stay hidden at any depth, and unknown privacy keeps the plain envelope", () => {
  const { fields } = toolReviewFields(
    { body: { subject: "Hi", credentials: { password: "x" } } },
    { kind: "generic", protectedFields: ["credentials"] },
    "api_tool",
  );
  expect(fields.find((field) => field.path === "/body/credentials")).toMatchObject({
    protected: true,
    preview: "[Protected value]",
  });
  expect(rows(draft, { kind: "generic", protectedFields: ["*"] }).map(([label]) => label)).toEqual([
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
