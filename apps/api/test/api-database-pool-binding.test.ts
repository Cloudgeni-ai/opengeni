import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

function source(path: string) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const parsed = parseSync(path, text);
  expect(parsed.errors).toEqual([]);
  const nodes: any[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.type === "string") nodes.push(node);
    for (const child of Object.values(node)) visit(child);
  }
  visit(parsed.program);
  return { text, nodes };
}

function calls(nodes: any[], name: string) {
  return nodes.filter(
    (node) =>
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === name,
  );
}

test("API binds the configured application pool and preserves shared readiness and RLS", () => {
  const { text, nodes } = source("../src/index.ts");
  const dbCalls = calls(nodes, "createDb");
  expect(dbCalls).toHaveLength(1);
  const options = dbCalls[0].arguments[1];
  expect(options.type).toBe("ObjectExpression");
  const max = options.properties.find((property: any) => property.key?.name === "max");
  expect(text.slice(max.value.start, max.value.end)).toBe("settings.apiDatabasePoolMax");
  const rls = options.properties.find((property: any) => property.key?.name === "rlsStrategy");
  expect(text.slice(rls.value.start, rls.value.end)).toBe("settings.rlsStrategy");
  expect(options.properties.some((property: any) => property.type === "SpreadElement")).toBe(true);
  const readiness = calls(nodes, "runtimeDatabaseReadyCheck");
  expect(readiness).toHaveLength(1);
  const handle = readiness[0].arguments[0];
  expect(text.slice(handle.start, handle.end)).toBe("dbClient.db");
});

test("managed auth retains its independent ten-connection pool", () => {
  const { nodes } = source("../src/auth/managed-auth.ts");
  let options = nodes.find(
    (node) =>
      node.type === "VariableDeclarator" && node.id?.name === "MANAGED_AUTH_DATABASE_POOL_OPTIONS",
  )?.init;
  while (options && ["TSAsExpression", "TSSatisfiesExpression"].includes(options.type)) {
    options = options.expression;
  }
  expect(options?.type).toBe("ObjectExpression");
  const max = options?.properties.find((property: any) => property.key?.name === "max");
  expect(max?.value.value).toBe(10);
});
