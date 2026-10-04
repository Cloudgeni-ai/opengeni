import { expect, test } from "bun:test";
import {
  toolReviewAction,
  toolReviewFields,
  toolReviewDetails,
  toolReviewContextFromSchema,
} from "../src/tool-action-review";

test("Gmail review counts exact unique IDs and exposes every label effect", () => {
  const args = {
    messageIds: ["one", "two", "one"],
    addLabelIds: ["TRASH", "STARRED"],
    removeLabelIds: ["INBOX", "Label_example"],
  };
  expect(toolReviewAction("batch_modify_messages", args, { kind: "gmail" })).toMatchObject({
    title: "Move 2 messages to Trash",
    selectionCount: 2,
    approveLabel: "Move to Trash",
    effects: ["Move to Trash", "Add star", "Remove from Inbox", "Remove label Label_example"],
  });
  expect(
    toolReviewAction("batch_modify_messages", args, { kind: "generic" }).selectionCount,
  ).toBeUndefined();
});

test("generic review decodes once, bounds arrays and redacts nested credentials", () => {
  const args = {
    recipients: Array.from({ length: 600 }, (_, i) => `recipient-${i}@example.test`),
    authorization: "secret-canary",
    config: { nested: { apiKey: "hidden-canary", label: "example" } },
  };
  const fields = toolReviewFields(JSON.stringify(args));
  expect(fields.fields[0]).toMatchObject({ preview: "600 items", count: 600, truncated: true });
  expect(JSON.stringify(fields)).not.toContain("canary");
  const page = toolReviewDetails(JSON.stringify(args), undefined, "/recipients", 575);
  expect(page.total).toBe(600);
  expect(page.items).toHaveLength(25);
  expect(page.nextOffset).toBeNull();
  expect(page.items[24]!.value).toBe("recipient-599@example.test");
  const nested = toolReviewDetails(args, undefined, "/config", 0);
  expect(JSON.stringify(nested)).not.toContain("hidden-canary");
  expect(toolReviewFields(JSON.stringify(JSON.stringify(args))).fields).toEqual([]);
  expect(() => toolReviewDetails(args, undefined, "/__proto__", 0)).toThrow();
});

test("schema labels are presentation only and write-only fields stay protected", () => {
  const context = toolReviewContextFromSchema(
    {
      properties: {
        value: { title: "Access key", writeOnly: true },
        customer: { title: "Customer" },
      },
    },
    { kind: "generic" },
  );
  expect(
    toolReviewFields({ value: "private-canary", customer: "Synthetic account" }, context).fields[0],
  ).toMatchObject({ label: "Access key", preview: "[Protected value]", protected: true });
  expect(toolReviewDetails({ value: "private-canary" }, context, "/value", 0).items[0]!.value).toBe(
    "[Protected value]",
  );
});

test("all Gmail label and thread effects remain visible and unknown labels cannot inherit object members", () => {
  expect(
    toolReviewAction(
      "modify_thread",
      { threadId: "synthetic", addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
      { kind: "gmail" },
    ),
  ).toMatchObject({
    title: "Update 1 conversation",
    selectionKind: "threads",
    effects: ["Add star", "Mark as read"],
  });
  expect(
    toolReviewAction(
      "unlabel_message",
      { messageId: "synthetic", labelIds: ["INBOX", "constructor"] },
      { kind: "gmail" },
    ).effects,
  ).toEqual(["Remove from Inbox", "Remove label constructor"]);
  expect(
    toolReviewAction("restore_message", { messageId: "synthetic" }, { kind: "gmail" }).title,
  ).toBe("Remove 1 message from Trash");
});
test("large review facts stay compact, and complete nested values are navigable without expanding all siblings", () => {
  const args = {
    messageIds: Array.from({ length: 10000 }, (_, i) => `synthetic-${i}`),
    nested: { deeper: { text: "x".repeat(20000), authorization: "hidden-canary" } },
  };
  expect(JSON.stringify(toolReviewFields(args)).length).toBeLessThan(32768);
  const root = toolReviewDetails(args, undefined, "", 0);
  expect(root.items[0]).toMatchObject({
    value: "10,000 items",
    path: "/messageIds",
    truncated: true,
  });
  expect(JSON.stringify(root)).not.toContain("hidden-canary");
  expect(toolReviewDetails(args, undefined, "/messageIds", 9975).items.at(-1)!.value).toBe(
    "synthetic-9999",
  );
  expect(
    toolReviewDetails(args, undefined, "/nested/deeper/text", 0)
      .items.map((item) => item.value)
      .join(""),
  ).toBe(args.nested.deeper.text);
});
test("long saved field names have bounded previews and complete authenticated navigation", () => {
  const key = "long-field-".repeat(2000),
    args = { [key]: "exact synthetic value" };
  const fields = toolReviewFields(args);
  expect(JSON.stringify(fields).length).toBeLessThan(1024);
  const root = toolReviewDetails(args, undefined, "", 0);
  expect(root.items[0]!.path).toBe("/~20");
  const selected = toolReviewDetails(args, undefined, root.items[0]!.path!, 0);
  expect(selected.items.find((item) => item.label === "Value")!.value).toBe(
    "exact synthetic value",
  );
  const name = toolReviewDetails(args, undefined, "/~20/fieldName", 0);
  expect(name.items.map((item) => item.value).join("")).toBe(key);
});

test("schema privacy preserves exact long names and every protected property beyond 128", () => {
  const longName = "field".repeat(100);
  const names = [...Array.from({ length: 150 }, (_, index) => `field_${index}`), longName];
  const context = toolReviewContextFromSchema(
    { properties: Object.fromEntries(names.map((name) => [name, { writeOnly: true }])) },
    { kind: "generic" },
  );
  const args = Object.fromEntries(names.map((name) => [name, "SCHEMA_PRIVATE_CANARY"]));
  expect(context.protectedFields).toHaveLength(151);
  expect(context.protectedFields).toContain(longName);
  expect(JSON.stringify(toolReviewFields(args, context))).not.toContain("CANARY");
  for (let offset = 0; offset < names.length; offset += 25)
    expect(JSON.stringify(toolReviewDetails(args, context, "", offset))).not.toContain("CANARY");
  expect(JSON.stringify(toolReviewDetails(args, context, "/~2150", 0))).not.toContain("CANARY");
  expect(
    JSON.stringify(toolReviewFields({ [longName]: "LONG_PRIVATE_CANARY" }, context)),
  ).not.toContain("CANARY");
});

test("nested, array, composition and local-reference write-only values cannot escape review navigation", () => {
  const context = toolReviewContextFromSchema(
    {
      properties: {
        config: { properties: { value: { writeOnly: true } } },
        entries: {
          items: { properties: { hidden: { anyOf: [{ type: "string", writeOnly: true }] } } },
        },
        referenced: { $ref: "#/$defs/privateValue" },
        privateList: { items: { type: "string", writeOnly: true } },
        child: { $ref: "#" },
      },
      $defs: { privateValue: { writeOnly: true, type: "string" } },
    },
    { kind: "generic" },
  );
  const args = {
    config: { value: "NESTED_CANARY", label: "Visible" },
    entries: [{ hidden: "ARRAY_CANARY", label: "Visible" }],
    referenced: "REF_CANARY",
    privateList: ["ITEM_CANARY"],
  };
  for (const path of [
    "",
    "/config",
    "/config/value",
    "/entries",
    "/entries/0",
    "/entries/0/hidden",
    "/referenced",
    "/privateList",
    "/privateList/0",
  ])
    expect(JSON.stringify(toolReviewDetails(args, context, path, 0))).not.toContain("CANARY");
  expect(toolReviewDetails(args, context, "/config/label", 0).items[0]!.value).toBe("Visible");
});

test("encoded content schemas protect the entire saved string without decoding it", () => {
  const context = toolReviewContextFromSchema(
    {
      properties: {
        document: {
          type: "string",
          contentMediaType: "application/json",
          contentSchema: { properties: { value: { writeOnly: true } } },
        },
        entries: {
          items: { properties: { encoded: { type: "string", contentSchema: true } } },
        },
      },
    },
    { kind: "generic" },
  );
  const args = {
    document: '{"value":"CONTENT_SCHEMA_CANARY"}',
    entries: [{ encoded: "OPAQUE_CONTENT_CANARY" }],
    description: "Visible",
  };
  expect(context.protectedFields).toEqual(["document", "encoded"]);
  expect(JSON.stringify(toolReviewFields(args, context))).not.toContain("CANARY");
  for (const path of ["", "/document", "/entries", "/entries/0", "/entries/0/encoded"])
    expect(JSON.stringify(toolReviewDetails(args, context, path, 0))).not.toContain("CANARY");
  expect(toolReviewDetails(args, context, "/description", 0).items[0]!.value).toBe("Visible");
});

test.each([
  { properties: { value: { $ref: "https://schema.example.test/private" } } },
  { properties: { value: { $dynamicRef: "#private" } } },
  { properties: { value: { $id: "#private", $ref: "#/properties/value" } } },
])(
  "unresolved schema privacy protects all values without altering execution policy (%j)",
  (schema) => {
    const context = toolReviewContextFromSchema(schema, { kind: "generic" });
    expect(context.protectedFields).toEqual(["*"]);
    const args = { value: "UNRESOLVED_CANARY", nested: { anything: "NESTED_CANARY" } };
    expect(JSON.stringify(toolReviewFields(args, context))).not.toContain("CANARY");
    for (const path of ["", "/value", "/nested", "/nested/anything"])
      expect(JSON.stringify(toolReviewDetails(args, context, path, 0))).not.toContain("CANARY");
  },
);
