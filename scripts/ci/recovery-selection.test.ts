import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as t from "oxc-parser";
import { parse } from "yaml";

const worker = "test/integration/worker-activity.integration.ts";
const compaction = "apps/worker/test/context-compaction-activity.test.ts";
const incidents = new Map([
  [worker, /\bmcp\b.*checkpoints once.*recovers the same turn/],
  [compaction, /forced overflow compaction.*active history.*not stale input tokens/],
]);

// Resolve the authored Bun declarations, including static test.each tables.
// Comments and skipped declarations cannot stand in for executable coverage.
function activeTestNames(source: string): string[] {
  const file = t.parseSync("fixture.ts", source);
  if (file.errors.length) throw new Error("Invalid recovery test source");
  const names: string[] = [];
  const visit = (node: t.Node): void => {
    if (node.type === "CallExpression") {
      const call = node.callee;
      if (
        call.type === "MemberExpression" &&
        !call.computed &&
        call.object.type === "Identifier" &&
        call.object.name === "describe" &&
        call.property.type === "Identifier" &&
        ["skip", "todo"].includes(call.property.name)
      ) {
        return;
      }
      const title = node.arguments[0];
      if (title?.type === "Literal" && typeof title.value === "string") {
        if (call.type === "Identifier" && ["test", "it"].includes(call.name)) {
          names.push(title.value);
        } else if (
          call.type === "CallExpression" &&
          call.callee.type === "MemberExpression" &&
          !call.callee.computed &&
          call.callee.object.type === "Identifier" &&
          ["test", "it"].includes(call.callee.object.name) &&
          call.callee.property.type === "Identifier" &&
          call.callee.property.name === "each"
        ) {
          let table = call.arguments[0];
          while (table?.type === "TSAsExpression") {
            table = table.expression;
          }
          if (table?.type === "ArrayExpression") {
            for (const value of table.elements) {
              if (value?.type === "Literal" && typeof value.value === "string") {
                names.push(title.value.replace("%s", value.value));
              }
            }
          }
        }
      }
    }
    const record = node as unknown as Record<string, unknown>;
    for (const key of t.visitorKeys[node.type] ?? []) {
      const value = record[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && "type" in child) visit(child as t.Node);
      }
    }
  };
  visit(file.program);
  return names;
}

function selectedIncidents(run: string, sources: ReadonlyMap<string, string>): string[] {
  const commands = run
    .replace(/\\\r?\n/g, " ")
    .trim()
    .split("\n");
  if (commands.length !== incidents.size) throw new Error("Both recovery gates are required");
  const covered = new Set<string>();
  return commands.map((command) => {
    const args = [...command.matchAll(/'([^']*)'|"([^"]*)"|([^\s]+)/g)].map(
      (match) => match[1] ?? match[2] ?? match[3]!,
    );
    const path = args.at(-1)?.replace(/^\.\//, "") ?? "";
    const incident = incidents.get(path);
    const source = sources.get(path);
    const patternIndex = args.indexOf("--test-name-pattern");
    if (
      args[0] !== "bun" ||
      args[1] !== "test" ||
      patternIndex < 0 ||
      !incident ||
      source === undefined ||
      covered.has(path)
    ) {
      throw new Error("Invalid or duplicate recovery gate");
    }
    covered.add(path);
    const pattern = new RegExp(args[patternIndex + 1]!);
    const selected = activeTestNames(source).filter((name) => pattern.test(name));
    if (selected.length !== 1 || !incident.test(selected[0]!)) {
      throw new Error(`Recovery gate must select exactly its active incident: ${path}`);
    }
    return selected[0]!;
  });
}

const mcpTitle =
  "a %s failure after successful tool output checkpoints once and recovers the same turn";
const overflowTitle =
  "forced overflow compaction proves shrink against active history, not stale input tokens";
const fixtureSources = new Map([
  [worker, `test.each(["mcp", "model"] as const)("${mcpTitle}", async (kind) => {});`],
  [compaction, `test("${overflowTitle}", async () => {});`],
]);
const fixtureRun = (pattern = mcpTitle.replace("%s", "mcp")) =>
  `bun test --timeout 30000 --test-name-pattern '${pattern}' ./${worker}\n` +
  `bun test --timeout 180000 --test-name-pattern '${overflowTitle}' ./${compaction}`;

describe("recovery incident selection", () => {
  test("CI executes exactly the active MCP checkpoint and real-history overflow incidents", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const step = workflow.jobs["test-suite"].steps.find(
      (item: { name?: string }) => item.name === "Recovery integration regressions",
    );
    const sources = new Map(
      [...incidents.keys()].map((path) => [path, readFileSync(path, "utf8")]),
    );
    const [guard, ...commands] = step.run.trim().split("\n");
    expect(guard).toBe("bun test scripts/ci/recovery-selection.test.ts");
    expect(selectedIncidents(commands.join("\n"), sources)).toHaveLength(2);
  });

  test("expands parameterized MCP coverage without selecting the model variant", () => {
    expect(selectedIncidents(fixtureRun(), fixtureSources)).toEqual([
      mcpTitle.replace("%s", "mcp"),
      overflowTitle,
    ]);
  });

  test.each([
    "an MCP stream timeout after a successful tool output checkpoints once and recovers the same turn",
    mcpTitle.replace("%s", "model"),
    "after successful tool output checkpoints once and recovers the same turn",
  ])("rejects a missing, wrong-boundary or broadened selector: %s", (pattern) => {
    expect(() => selectedIncidents(fixtureRun(pattern), fixtureSources)).toThrow();
  });

  test.each(["test.skip.each", "test.todo.each"])("rejects retired coverage: %s", (declaration) => {
    const sources = new Map(fixtureSources);
    sources.set(worker, sources.get(worker)!.replace("test.each", declaration));
    expect(() => selectedIncidents(fixtureRun(), sources)).toThrow();
  });

  test("requires the overflow gate and rejects duplicate incident declarations", () => {
    expect(() => selectedIncidents(fixtureRun().split("\n")[0]!, fixtureSources)).toThrow();
    const sources = new Map(fixtureSources);
    sources.set(worker, sources.get(worker)!.replace('"mcp", "model"', '"mcp", "mcp"'));
    expect(() => selectedIncidents(fixtureRun(), sources)).toThrow();
  });

  test("comments and a skipped suite cannot masquerade as active incident coverage", () => {
    for (const source of [
      `// ${fixtureSources.get(worker)}`,
      `describe.skip("retired", () => { ${fixtureSources.get(worker)} });`,
    ]) {
      const sources = new Map(fixtureSources);
      sources.set(worker, source);
      expect(() => selectedIncidents(fixtureRun(), sources)).toThrow();
    }
  });
});
