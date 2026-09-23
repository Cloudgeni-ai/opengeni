import { expect, test } from "bun:test";
import { ToolDisplayMetadata } from "@opengeni/contracts";
import { parseToolDisplayMetadata } from "../src/tool-display-metadata";

test("browser/native display parsing matches the server contract without a runtime schema import", () => {
  for (const value of [
    null,
    [],
    "tool",
    {},
    { toolName: "" },
    { toolName: "bad\nname" },
    { toolName: "x".repeat(513) },
    { toolName: "x", title: "" },
    { toolName: "x", accountLabel: "x".repeat(1025) },
    { toolName: "x", title: 4 },
    { toolName: "x", accountLabel: null },
    { toolName: "x", extra: true },
    { toolName: "update_record" },
    { toolName: "update_record", title: "Update record", accountLabel: "Documents — Personal" },
    { toolName: "x".repeat(512), title: "x".repeat(512), accountLabel: "x".repeat(1024) },
    { toolName: "x", title: undefined, accountLabel: undefined },
  ]) {
    const expected = ToolDisplayMetadata.safeParse(value);
    expect(parseToolDisplayMetadata(value)).toEqual(expected.success ? expected.data : undefined);
  }
});
