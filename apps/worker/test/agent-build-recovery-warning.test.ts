import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

test("every agent reconstruction reads durable recovery truth before building inference instructions", () => {
  const source = readFileSync(
    new URL("../src/activities/agent-turn/agent-build.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseSync("agent-build.ts", source);
  expect(parsed.errors).toEqual([]);
  const exported = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "buildTurnAgent",
  );
  if (
    exported?.type !== "ExportNamedDeclaration" ||
    exported.declaration?.type !== "FunctionDeclaration"
  )
    throw new Error("Missing agent build");
  const build = exported.declaration;
  const variables = build.body!.body.flatMap((statement) =>
    statement.type === "VariableDeclaration" ? statement.declarations : [],
  );
  const warning = variables.find(
    (node) => node.id.type === "Identifier" && node.id.name === "filesystemDiscontinuity",
  );
  // Top-level, unconditional and awaited: neither context history nor a
  // compaction branch can suppress the receipt read. Real-DB tests separately
  // prove persistence across reconstruction in a new database client.
  if (warning?.init?.type !== "AwaitExpression" || warning.init.argument.type !== "CallExpression")
    throw new Error("Recovery read must be unconditionally awaited");
  const read = warning.init.argument;
  expect(source.slice(read.callee.start, read.callee.end)).toBe("getSandboxRecoveryDiscontinuity");
  expect(read.arguments.map((argument) => source.slice(argument.start, argument.end))).toEqual([
    "db",
    "input.workspaceId",
    "session.id",
  ]);
  const instructions = variables.find(
    (node) => node.id.type === "Identifier" && node.id.name === "sessionInstructions",
  );
  expect(source.slice(instructions!.start, instructions!.end)).toContain("filesystemDiscontinuity");
  const buildBody = source.slice(build.start, build.end);
  expect(buildBody.indexOf("getSandboxRecoveryDiscontinuity(")).toBeLessThan(
    buildBody.indexOf("runtime.buildAgent("),
  );
  expect(buildBody).toContain("...(sessionInstructions ? { sessionInstructions } : {})");
});
