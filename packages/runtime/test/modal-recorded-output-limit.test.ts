import { expect, test } from "bun:test";
import {
  MODAL_COMMAND_RECORDED_OUTPUT_LIMIT_BYTES as LIMIT,
  recordedOutputText,
} from "../src/sandbox/providers/modal-command-control";

test("output below the recording limit is recorded unchanged", () => {
  expect(recordedOutputText("stdout", 0, 5, "hello")).toBe("hello");
  expect(recordedOutputText("stderr", LIMIT - 5, LIMIT, "tail!")).toBe("tail!");
});

test("the page that crosses the limit is recorded with one explicit marker", () => {
  const text = recordedOutputText("stdout", LIMIT - 3, LIMIT + 7, "0123456789");
  expect(text.startsWith("0123456789\n")).toBe(true);
  expect(text).toContain("stopped recording stdout after 16 MiB");
  expect(text).toContain("its exit is still reported");
});

test("output past the limit is drained but not recorded", () => {
  expect(recordedOutputText("stdout", LIMIT, LIMIT + 1024, "x".repeat(1024))).toBe("");
  expect(recordedOutputText("stderr", LIMIT + 1, LIMIT + 2, "y")).toBe("");
});
