import { expect, test } from "bun:test";
import { matchAtOffset, selectedFormattedMessage } from "./search-markdown-highlight";

const text = `A **bold** result.\n\n| Day | Time |\n|---|---|\n| Tue | 09:00 |`;
const match = {
  eventId: "event-1",
  sequence: 7,
  role: "assistant" as const,
  messageMatchOffset: text.indexOf("09:00"),
};
const event = {
  id: "event-1",
  sequence: 7,
  type: "agent.message.completed",
  payload: { text, modelContext: "never render this" },
};

test("exact authorized match can render the whole table source", () => {
  expect(selectedFormattedMessage([event], match, "09:00")).toBe(text);
  expect(matchAtOffset("😀 K", "k", 3)).toBe(3);
  expect(matchAtOffset(text, "09:00", match.messageMatchOffset)).toBe(match.messageMatchOffset);
});

test("stale identity, different role, or changed source offset keeps the excerpt", () => {
  expect(selectedFormattedMessage([{ ...event, id: "other" }], match, "09:00")).toBeNull();
  expect(selectedFormattedMessage([{ ...event, sequence: 8 }], match, "09:00")).toBeNull();
  expect(selectedFormattedMessage([{ ...event, type: "user.message" }], match, "09:00")).toBeNull();
  expect(
    selectedFormattedMessage([event], { ...match, messageMatchOffset: 0 }, "09:00"),
  ).toBeNull();
  expect(selectedFormattedMessage([event], match, "09:01")).toBeNull();
});

test("large or invalid messages remain bounded to the search excerpt", () => {
  const huge = "x".repeat(12_000) + "09:00";
  expect(
    selectedFormattedMessage(
      [{ ...event, payload: { text: huge } }],
      { ...match, messageMatchOffset: 12_000 },
      "09:00",
    ),
  ).toBeNull();
  expect(
    selectedFormattedMessage([{ ...event, payload: { modelContext: text } }], match, "09:00"),
  ).toBeNull();
});
