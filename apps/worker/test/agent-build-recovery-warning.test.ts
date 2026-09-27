import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync, type Node } from "oxc-parser";

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
    (node) => node.id.type === "Identifier" && node.id.name === "sessionInstructions",
  );
  // Top-level, unconditional and awaited: neither context history nor a
  // compaction branch can suppress the receipt read. Real-DB tests separately
  // prove persistence across reconstruction in a new database client.
  if (warning?.init?.type !== "AwaitExpression" || warning.init.argument.type !== "CallExpression")
    throw new Error("Recovery read must be unconditionally awaited");
  const read = warning.init.argument;
  expect(source.slice(read.callee.start, read.callee.end)).toBe("recoveryAwareSessionInstructions");
  expect(read.arguments.map((argument) => source.slice(argument.start, argument.end))).toEqual([
    "db",
    "input.workspaceId",
    "session",
  ]);
  const buildBody = source.slice(build.start, build.end);
  expect(buildBody.indexOf("recoveryAwareSessionInstructions(")).toBeLessThan(
    buildBody.indexOf("runtime.buildAgent("),
  );
  expect(buildBody).toContain("...(sessionInstructions ? { sessionInstructions } : {})");
});

test("both worker claim and same-attempt attachment opt into the warning-aware module", () => {
  const claim = readFileSync(
    new URL("../src/activities/agent-turn/claim.ts", import.meta.url),
    "utf8",
  );
  expect(
    claim.match(/filesystemDiscontinuityProtocol: FILESYSTEM_DISCONTINUITY_PROTOCOL/g),
  ).toHaveLength(2);
  const warning = readFileSync(
    new URL("../src/activities/agent-turn/recovery-warning.ts", import.meta.url),
    "utf8",
  );
  expect(warning).toContain("getSandboxRecoveryDiscontinuity");
  expect(warning).toContain("await readDiscontinuity(");
  expect(warning).toContain("[session.instructions, filesystemDiscontinuity]");
  const database = readFileSync(
    new URL("../../../packages/db/src/database.ts", import.meta.url),
    "utf8",
  );
  expect(database).not.toContain("filesystem_discontinuity_protocol_v1");
});

test("all six ordinary/recovery/continuation claim returns pass the same INSERT boundary", () => {
  const source = readFileSync(
    new URL("../../../packages/db/src/index.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseSync("index.ts", source);
  const claim = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "claimSessionWorkForAttempt",
  );
  if (claim?.type !== "ExportNamedDeclaration" || claim.declaration?.type !== "FunctionDeclaration")
    throw new Error("Missing canonical claim");
  let paths = 0;
  const visit = (node: Node): void => {
    if (node.type === "BlockStatement") {
      node.body.forEach((statement, index) => {
        if (statement.type !== "ReturnStatement" || statement.argument?.type !== "ObjectExpression")
          return;
        if (
          !statement.argument.properties.some(
            (property) =>
              property.type === "Property" &&
              property.key.type === "Identifier" &&
              property.key.name === "action" &&
              property.value.type === "Literal" &&
              property.value.value === "claimed",
          )
        )
          return;
        const registered = node.body
          .slice(0, index)
          .some(
            (previous) =>
              previous.type === "ExpressionStatement" &&
              previous.expression.type === "AwaitExpression" &&
              previous.expression.argument.type === "CallExpression" &&
              source.slice(
                previous.expression.argument.callee.start,
                previous.expression.argument.callee.end,
              ) === "registerAttempt",
          );
        expect(registered).toBe(true);
        paths++;
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) visit(child as Node);
        }
      else if (value && typeof value === "object" && "type" in value) visit(value as Node);
    }
  };
  visit(claim.declaration);
  expect(paths).toBe(6);
});
