import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as t from "oxc-parser";
import { parseAcceptedMcpAccountBindings } from "../src/mcp-account-bindings";

test("historical NULL and accepted empty lists remain distinct through parsing and replay keys", () => {
  expect(parseAcceptedMcpAccountBindings(null)).toBeNull();
  expect(parseAcceptedMcpAccountBindings(undefined)).toBeNull();
  expect(parseAcceptedMcpAccountBindings([])).toEqual([]);
  expect(JSON.stringify(parseAcceptedMcpAccountBindings(null))).not.toBe(
    JSON.stringify(parseAcceptedMcpAccountBindings([])),
  );
  for (const invalid of [{}, false, "[]", [null]]) {
    expect(() => parseAcceptedMcpAccountBindings(invalid)).toThrow();
  }
});

test("accepted identity and labels round-trip without looking up mutable connection metadata", () => {
  const connectionId = "10000000-0000-4000-8000-000000000001";
  const connectionRef = {
    connectionId,
    subjectScope: "workspace" as const,
    providerDomain: "mail.test",
    kind: "oauth2" as const,
  };
  const binding = {
    serverId: `account-${"a".repeat(64)}`,
    canonicalServerId: "mail",
    connectionId,
    originWorkspaceId: "10000000-0000-4000-8000-000000000002",
    subjectScope: "workspace" as const,
    ownerSubjectId: null,
    accountLabel: "Accepted team account",
    providerDomain: "mail.test",
    kind: "oauth2" as const,
    connectionRef,
    connectionAuthorityGeneration: 3,
  };
  expect(parseAcceptedMcpAccountBindings(JSON.parse(JSON.stringify([binding])))).toEqual([binding]);
  expect(() =>
    parseAcceptedMcpAccountBindings([{ ...binding, ownerSubjectId: "user:teammate" }]),
  ).toThrow();
  expect(() => parseAcceptedMcpAccountBindings([binding, binding])).toThrow();
});

function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node);
  const record = node as unknown as Record<string, unknown>;
  for (const key of t.visitorKeys[node.type] ?? []) {
    const value = record[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && "type" in child) walk(child as t.Node, visit);
    }
  }
}

// Account routes and personal sender proof have different authority semantics,
// but every accepted-work carrier must copy both. This structural guard covers
// producers outside the SQL fixture: queue edits, child notices, goal and
// background-command continuations, and outbox delivery/replay.
for (const filename of ["index.ts", "session-queue-commands.ts", "session-control.ts"]) {
  test(`${filename} never drops account bindings while copying accepted personal authority`, async () => {
    const source = await readFile(new URL(`../src/${filename}`, import.meta.url), "utf8");
    const tree = t.parseSync(filename, source);
    expect(tree.errors).toEqual([]);
    const missing: string[] = [];
    let checked = 0;
    walk(tree.program, (node) => {
      if (node.type === "ObjectExpression") {
        const names = new Set(
          node.properties.flatMap((property) => {
            if (property.type !== "Property") return [];
            return property.key.type === "Identifier"
              ? [property.key.name]
              : property.key.type === "Literal" && typeof property.key.value === "string"
                ? [property.key.value]
                : [];
          }),
        );
        for (const [personal, accounts] of [
          ["personalConnectionDelegations", "mcpAccountBindings"],
          ["initialPersonalConnectionDelegations", "initialMcpAccountBindings"],
        ] as const) {
          if (!names.has(personal)) continue;
          checked++;
          if (!names.has(accounts)) {
            const line = source.slice(0, node.start).split("\n").length;
            missing.push(`${filename}:${line} lacks ${accounts}`);
          }
        }
      }
    });
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
}

test("account binding columns stay separate from personal delegation ownership", async () => {
  const source = await readFile(new URL("../src/schema.ts", import.meta.url), "utf8");
  const tree = t.parseSync("schema.ts", source);
  expect(tree.errors).toEqual([]);
  const columns: string[] = [];
  walk(tree.program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "jsonb"
    ) {
      const name = node.arguments[0];
      if (
        name?.type === "Literal" &&
        typeof name.value === "string" &&
        /mcp_account_bindings$/u.test(name.value)
      )
        columns.push(name.value);
    }
  });
  expect(columns).toEqual([
    "initial_mcp_account_bindings",
    "mcp_account_bindings",
    "mcp_account_bindings",
    "mcp_account_bindings",
  ]);
});
