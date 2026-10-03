import { expect, test } from "bun:test";
import {
  RECORDED_COMMAND_OUTPUT_LIMIT_BYTES as LIMIT,
  recordedCommandOutput,
} from "../src/retained-provider-commands";

test("output below the recording limit is recorded unchanged", () => {
  expect(recordedCommandOutput("stdout", 0, 5, false, "hello")).toBe("hello");
  expect(recordedCommandOutput("stderr", LIMIT - 5, LIMIT, false, "tail!")).toBe("tail!");
});

test("the page that crosses the limit is recorded with one marker", () => {
  expect(recordedCommandOutput("stdout", LIMIT - 3, LIMIT + 7, false, "0123456789")).toBe(
    "0123456789\n[OpenGeni stopped recording stdout after 16 MiB; the final part will still be recorded.]\n",
  );
  expect(recordedCommandOutput("stdout", LIMIT - 3, LIMIT + 7, false, "line\n")).toBe(
    "line\n[OpenGeni stopped recording stdout after 16 MiB; the final part will still be recorded.]\n",
  );
});

test("a page that starts exactly at the limit records only the marker", () => {
  expect(recordedCommandOutput("stderr", LIMIT, LIMIT + 1024, false, "x".repeat(1024))).toBe(
    "[OpenGeni stopped recording stderr after 16 MiB; the final part will still be recorded.]\n",
  );
});

test("the middle past the limit is not recorded", () => {
  expect(recordedCommandOutput("stdout", LIMIT + 1, LIMIT + 1024, false, "x".repeat(1023))).toBe(
    "",
  );
});

test("the final page is always recorded so a trailing error survives", () => {
  expect(recordedCommandOutput("stdout", LIMIT + 100, LIMIT + 120, true, "FATAL: step 42\n")).toBe(
    "[OpenGeni did not record part of this stdout after 16 MiB; its final 20 bytes follow.]\nFATAL: step 42\n",
  );
  expect(recordedCommandOutput("stdout", LIMIT - 3, LIMIT + 7, true, "0123456789")).toBe(
    "0123456789",
  );
  expect(recordedCommandOutput("stdout", LIMIT, LIMIT + 4, true, "done")).toBe("done");
});
