import { expect, test } from "bun:test";
import {
  validateRouterOutputAdvance,
  type RetainedRouterOutputPage,
} from "../src/retained-provider-commands";

function page(): RetainedRouterOutputPage {
  const expected = {
    kind: "modal-router-v1" as const,
    sandboxId: "sb-test",
    taskId: "task-test",
    execId: "792e06b2-03c7-40f0-baa7-a51cf4bddaf8",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null as number | null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null as number | null },
    },
  };
  return { expected, command: structuredClone(expected), stdout: "", stderr: "" };
}

test("router capture permits byte advancement and delayed exit after EOF", () => {
  const value = page();
  value.command.streams.stdout.byteOffset = 5;
  value.stdout = "hello";
  expect(() => validateRouterOutputAdvance(value)).not.toThrow();
  value.expected = structuredClone(value.command);
  value.stdout = "";
  value.expected.streams.stdout.eof = true;
  value.command.streams.stdout.eof = true;
  value.command.streams.stdout.exitCode = 0;
  expect(() => validateRouterOutputAdvance(value)).not.toThrow();
});

test("first EOF may flush a split invalid UTF-8 suffix without new bytes", () => {
  const value = page();
  value.expected.streams.stdout.utf8Remainder = "4g==";
  value.command.streams.stdout.eof = true;
  value.stdout = "�";
  expect(() => validateRouterOutputAdvance(value)).not.toThrow();
});

test("cursor regression and identity changes fail closed", () => {
  const value = page();
  value.expected.streams.stdout.byteOffset = 20;
  expect(() => validateRouterOutputAdvance(value)).toThrow();
  value.command.streams.stdout.byteOffset = 20;
  value.command.taskId = "other-task";
  expect(() => validateRouterOutputAdvance(value)).toThrow("identity");
});

test("EOF and terminal evidence cannot be rewritten", () => {
  const value = page();
  value.expected.streams.stdout.eof = true;
  expect(() => validateRouterOutputAdvance(value)).toThrow();
  value.command.streams.stdout.eof = true;
  value.expected.streams.stdout.exitCode = 0;
  value.command.streams.stdout.exitCode = 1;
  expect(() => validateRouterOutputAdvance(value)).toThrow();
});

test("output without advancement and terminal output without EOF are invalid", () => {
  const value = page();
  value.stdout = "invented";
  expect(() => validateRouterOutputAdvance(value)).toThrow("advancement");
  value.stdout = "";
  value.command.streams.stdout.exitCode = 0;
  expect(() => validateRouterOutputAdvance(value)).toThrow("EOF");
});
