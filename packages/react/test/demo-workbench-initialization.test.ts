import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

describe("production demo workbench peer initialization", () => {
  for (const entrypoint of [
    "main.tsx",
    "terminal-harness.tsx",
    "workbench-harness.tsx",
    "workbench-dock-harness.tsx",
    "workbench-embed-harness.tsx",
  ]) {
    test(`${entrypoint} calls setup explicitly instead of relying on a tree-shaken bare import`, () => {
      const source = readFileSync(new URL(`../demo/${entrypoint}`, import.meta.url), "utf8");
      const { program, errors } = parseSync(entrypoint, source);
      expect(errors).toEqual([]);
      const setupImport = program.body.find(
        (node) => node.type === "ImportDeclaration" && node.source.value === "./workbench-peers",
      );
      expect(setupImport?.type).toBe("ImportDeclaration");
      if (setupImport?.type !== "ImportDeclaration") throw new Error("missing demo setup import");
      expect(
        setupImport.specifiers.some(
          (specifier) => specifier.local.name === "enableWorkbenchDemoPeers",
        ),
      ).toBe(true);
      expect(
        program.body.some(
          (node) =>
            node.type === "ExpressionStatement" &&
            node.expression.type === "CallExpression" &&
            node.expression.callee.type === "Identifier" &&
            node.expression.callee.name === "enableWorkbenchDemoPeers",
        ),
      ).toBe(true);
    });
  }
});
