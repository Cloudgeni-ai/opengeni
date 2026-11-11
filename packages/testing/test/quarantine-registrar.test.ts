import { afterAll, expect, test as bunTest } from "bun:test";
import { quarantineTest } from "../src/quarantine";

// The real bun:test `test`, rebound the way quarantined files rebind it. Its
// members are native getters and methods that check their receiver; each one
// must keep working, or every test in a file that rebinds `test` breaks at load.
const test = quarantineTest(bunTest, import.meta.path);
const ran: string[] = [];

test("a plain test runs", () => {
  ran.push("plain");
});
test.skip("test.skip registers a skipped test", () => {
  ran.push("skip");
});
test.todo("test.todo registers a todo");
test.each([1, 2])("test.each runs case %p", (value) => {
  ran.push(`each ${value}`);
});
test.if(true)("test.if runs when true", () => {
  ran.push("if");
});
test.skipIf(true)("test.skipIf skips when true", () => {
  ran.push("skipIf");
});
test.failing("test.failing expects a failure", () => {
  throw new Error("expected");
});
test.skip.each([1])("test.skip.each skips case %p", () => {
  ran.push("skip.each");
});

afterAll(() => {
  expect([...ran].sort()).toEqual(["each 1", "each 2", "if", "plain"]);
});
