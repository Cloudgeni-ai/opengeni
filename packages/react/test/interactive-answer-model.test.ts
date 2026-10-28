import { expect, test } from "bun:test";
import {
  bestInteractiveItems,
  formatInteractiveValue,
  interactiveAnswerKey,
  interactiveFilterOptions,
  interactiveSelectionMessage,
  interactiveSelectionWasSent,
  nextInteractiveSort,
  parseInteractiveAnswer,
  parsePartialJson,
  toggleInteractiveSelection,
  visibleInteractiveItems,
  EMPTY_INTERACTIVE_ANSWER_STATE,
  type InteractiveAnswerSpec,
} from "../src/interactive-answer-model";

const BODY = {
  title: "Laptops",
  fields: [
    { key: "price", label: "Price", unit: "kr", better: "lower" },
    { key: "battery", label: "Battery", unit: "h", better: "higher" },
    { key: "os", label: "System", filter: true },
  ],
  chart: "price",
  select: { max: 2, action: "Compare these" },
  items: [
    { id: "air", title: "MacBook Air", values: { price: 13990, battery: 18, os: "macOS" } },
    { id: "x1", title: "ThinkPad X1", values: { price: 19990, battery: 15, os: "Windows" } },
    { id: "fw", title: "Framework 13", values: { price: 12490, os: "Linux" } },
  ],
};
const SOURCE = JSON.stringify(BODY, null, 2);

function spec(body: unknown = BODY): InteractiveAnswerSpec {
  const parsed = parseInteractiveAnswer(JSON.stringify(body));
  if (parsed.status !== "ok") throw new Error(`not ok: ${JSON.stringify(parsed)}`);
  return parsed.spec;
}

test("a complete body parses into options, fields, chart and selection", () => {
  const answer = spec();
  expect(answer.items.map((item) => item.id)).toEqual(["air", "x1", "fw"]);
  expect(answer.fields.map((field) => field.key)).toEqual(["price", "battery", "os"]);
  expect(answer.chart).toBe("price");
  expect(answer.select).toEqual({ max: 2, action: "Compare these" });
  expect(answer.view).toBe("cards");
});

test("unreadable or empty bodies are invalid, and other answer types are unsupported", () => {
  expect(parseInteractiveAnswer("{ items: [ oops ] }")).toEqual({
    status: "invalid",
    reason: "json",
  });
  expect(parseInteractiveAnswer('{"items": []}')).toEqual({ status: "invalid", reason: "shape" });
  expect(parseInteractiveAnswer('{"type": "map", "items": [{"title": "A"}]}')).toEqual({
    status: "invalid",
    reason: "unsupported",
  });
});

test("a streaming body yields the options that have arrived, growing as it streams", () => {
  const cut = SOURCE.slice(0, SOURCE.indexOf('"id": "x1"') + 20);
  const partial = parseInteractiveAnswer(cut, { partial: true });
  expect(partial.status).toBe("partial");
  if (partial.status !== "partial") return;
  // The second option has an id but no title yet, so it waits.
  expect(partial.spec?.items.map((item) => item.id)).toEqual(["air"]);
  const later = parseInteractiveAnswer(SOURCE.slice(0, SOURCE.indexOf('"id": "fw"')), {
    partial: true,
  });
  expect(later.status === "partial" && later.spec?.items.map((item) => item.id)).toEqual([
    "air",
    "x1",
  ]);
  expect(parseInteractiveAnswer("", { partial: true })).toEqual({ status: "partial", spec: null });
});

test("partial JSON closes open strings and brackets and drops half-written keys", () => {
  expect(parsePartialJson('{"a": [1, 2')).toEqual({ a: [1, 2] });
  expect(parsePartialJson('{"a": "hel')).toEqual({ a: "hel" });
  expect(parsePartialJson('{"a": 1, "b')).toEqual({ a: 1 });
  expect(parsePartialJson('{"a": 1, "b":')).toEqual({ a: 1 });
  expect(parsePartialJson('{"a": tr')).toEqual({});
  expect(parsePartialJson('{"a": "x\\')).toEqual({ a: "x" });
});

test("options without a title are skipped and duplicate ids stay distinct", () => {
  const answer = spec({
    items: [
      { id: "a", title: "One" },
      { id: "a", title: "Two" },
      { id: "b" },
      "x",
      { title: "Three" },
    ],
  });
  expect(answer.items.map((item) => item.id)).toEqual(["a", "a-2", "option-5"]);
});

test("only http links are kept, and a chart needs a numeric field", () => {
  const answer = spec({
    chart: "os",
    fields: ["os"],
    items: [
      { title: "A", url: "javascript:alert(1)", values: { os: "x" } },
      { title: "B", url: "https://example.com/b" },
    ],
  });
  expect(answer.items.map((item) => item.url)).toEqual([undefined, "https://example.com/b"]);
  expect(answer.chart).toBeUndefined();
});

test("select: true lets the person pick any number", () => {
  expect(spec({ select: true, items: [{ title: "A" }, { title: "B" }] }).select).toEqual({
    max: 2,
  });
});

test("values read with their unit and the caller's words", () => {
  const words = { yes: "Yes", no: "No", empty: "—" };
  const kr = { key: "p", label: "Price", unit: "kr" };
  expect(formatInteractiveValue(kr, 13990, words, "en")).toBe("13,990\u00a0kr");
  expect(formatInteractiveValue({ key: "p", label: "P", unit: "$" }, 5, words, "en")).toBe("$5");
  expect(formatInteractiveValue({ key: "p", label: "P", unit: "%" }, 12.5, words, "en")).toBe(
    "12.5%",
  );
  expect(formatInteractiveValue(undefined, true, words)).toBe("Yes");
  expect(formatInteractiveValue(kr, null, words)).toBe("—");
});

test("the best value of each field marks its options, and ties with everyone mark none", () => {
  const answer = spec();
  const best = bestInteractiveItems(answer, answer.items);
  expect([...(best.get("price") ?? [])]).toEqual(["fw"]);
  expect([...(best.get("battery") ?? [])]).toEqual(["air"]);
  const same = spec({
    fields: [{ key: "n", better: "higher" }],
    items: [
      { title: "A", values: { n: 1 } },
      { title: "B", values: { n: 1 } },
    ],
  });
  expect(bestInteractiveItems(same, same.items).has("n")).toBe(false);
});

test("filters narrow the options and sorting keeps empty values last", () => {
  const answer = spec();
  const os = answer.fields.find((field) => field.key === "os")!;
  expect(interactiveFilterOptions(os, answer.items)).toEqual(["macOS", "Windows", "Linux"]);
  const state = { ...EMPTY_INTERACTIVE_ANSWER_STATE, filters: { os: ["Windows", "Linux"] } };
  expect(visibleInteractiveItems(answer, state).map((item) => item.id)).toEqual(["x1", "fw"]);
  const battery = answer.fields.find((field) => field.key === "battery")!;
  const first = nextInteractiveSort(null, "battery", battery);
  expect(first).toEqual({ key: "battery", direction: "desc" });
  expect(
    visibleInteractiveItems(answer, { filters: {}, sort: first }).map((item) => item.id),
  ).toEqual(["air", "x1", "fw"]);
  const second = nextInteractiveSort(first, "battery", battery);
  expect(
    visibleInteractiveItems(answer, { filters: {}, sort: second }).map((item) => item.id),
  ).toEqual(["x1", "air", "fw"]);
  expect(nextInteractiveSort(second, "battery", battery)).toBeNull();
});

test("a single pick replaces and a full multi-pick ignores new options", () => {
  expect(toggleInteractiveSelection(["a"], "b", 1)).toEqual(["b"]);
  expect(toggleInteractiveSelection(["a", "b"], "c", 2)).toEqual(["a", "b"]);
  expect(toggleInteractiveSelection(["a", "b"], "a", 2)).toEqual(["b"]);
});

test("the sent message names the picks in the agent's order with its action words", () => {
  const answer = spec();
  expect(interactiveSelectionMessage(answer, ["fw", "air"], "Continue with these", "en")).toBe(
    "Compare these: MacBook Air and Framework 13",
  );
  const plain = spec({
    select: { max: 1 },
    items: [
      { title: "Tuesday", subtitle: "10:00" },
      { title: "Tuesday", subtitle: "14:00" },
    ],
  });
  expect(interactiveSelectionMessage(plain, ["option-2"], "Continue with this", "en")).toBe(
    "Continue with this: Tuesday (14:00)",
  );
});

test("the card knows when the current pick is what was sent", () => {
  const sent = { ...EMPTY_INTERACTIVE_ANSWER_STATE, selected: ["b", "a"], sent: ["a", "b"] };
  expect(interactiveSelectionWasSent(sent)).toBe(true);
  expect(interactiveSelectionWasSent({ ...sent, selected: ["a"] })).toBe(false);
});

test("answer keys are stable per body and differ between bodies", () => {
  expect(interactiveAnswerKey(SOURCE)).toBe(interactiveAnswerKey(SOURCE));
  expect(interactiveAnswerKey(SOURCE)).not.toBe(interactiveAnswerKey(`${SOURCE} `));
});
