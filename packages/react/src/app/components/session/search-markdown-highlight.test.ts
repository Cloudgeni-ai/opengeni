import { expect, test } from "bun:test";
import { matchAtOffset, selectedFormattedMessage } from "./search-markdown-highlight";

const text = `A **bold** result.\n\n| Day | Time |\n|---|---|\n| Tue | 09:00 |`;
const match = {
  eventId: "event-1",
  sequence: 7,
  role: "assistant" as const,
  messageMatchOffset: text.indexOf("09:00"),
};
const available = { status: "available" as const, text };

test("exact authorized match can render the whole table source", () => {
  expect(selectedFormattedMessage(available, match, "09:00")).toBe(text);
  const longer = `${"context\n".repeat(600)}${text}`;
  expect(
    selectedFormattedMessage(
      { status: "available", text: longer },
      { messageMatchOffset: longer.indexOf("09:00") },
      "09:00",
    ),
  ).toBe(longer);
  expect(matchAtOffset("😀 K", "k", 3)).toBe(3);
  expect(matchAtOffset(text, "09:00", match.messageMatchOffset)).toBe(match.messageMatchOffset);
});

test("unavailable preview or changed source offset keeps the excerpt", () => {
  expect(selectedFormattedMessage({ status: "unavailable" }, match, "09:00")).toBeNull();
  expect(
    selectedFormattedMessage(available, { ...match, messageMatchOffset: 0 }, "09:00"),
  ).toBeNull();
  expect(selectedFormattedMessage(available, match, "09:01")).toBeNull();
});

test("large or invalid messages remain bounded to the search excerpt", () => {
  const huge = "x".repeat(12_000) + "09:00";
  expect(
    selectedFormattedMessage(
      { status: "available", text: huge },
      { ...match, messageMatchOffset: 12_000 },
      "09:00",
    ),
  ).toBeNull();
  expect(
    selectedFormattedMessage({ status: "available", text: "wrong message" }, match, "09:00"),
  ).toBeNull();
});
