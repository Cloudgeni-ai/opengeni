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

function childAuthorityErrors(source: string, helperSource: string): string[] {
  const producer = t.parseSync("producer.ts", source);
  const helper = t.parseSync("helper.ts", helperSource);
  if (producer.errors.length || helper.errors.length) return ["invalid source"];
  const imported = new Set<string>();
  const authorities = new Set<string>();
  for (const node of producer.program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "./child-outbox-authority")
      continue;
    for (const specifier of node.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "parentOutboxAuthorityTx"
      )
        imported.add(specifier.local.name);
    }
  }
  walk(producer.program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "AwaitExpression" &&
      node.init.argument.type === "CallExpression" &&
      node.init.argument.callee.type === "Identifier" &&
      imported.has(node.init.argument.callee.name)
    ) {
      authorities.add(node.id.name);
    }
  });
  let helperReturnsBoth = false;
  walk(helper.program, (node) => {
    if (node.type !== "FunctionDeclaration" || node.id?.name !== "parentOutboxAuthorityTx") return;
    walk(node, (child) => {
      if (child.type !== "ReturnStatement" || child.argument?.type !== "ObjectExpression") return;
      const names = child.argument.properties.flatMap((property) =>
        property.type === "Property" && property.key.type === "Identifier"
          ? [property.key.name]
          : [],
      );
      if (names.includes("personalConnectionDelegations") && names.includes("mcpAccountBindings"))
        helperReturnsBoth = true;
    });
  });
  let carriers = 0;
  const errors: string[] = [];
  walk(producer.program, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      node.callee.property.type !== "Identifier" ||
      node.callee.property.name !== "values"
    )
      return;
    const insert = node.callee.object;
    if (
      insert.type !== "CallExpression" ||
      insert.callee.type !== "MemberExpression" ||
      insert.callee.property.type !== "Identifier" ||
      insert.callee.property.name !== "insert"
    )
      return;
    const table = insert.arguments[0];
    if (
      table?.type !== "MemberExpression" ||
      table.property.type !== "Identifier" ||
      table.property.name !== "sessionSystemUpdateOutbox"
    )
      return;
    walk(node, (object) => {
      if (object.type !== "ObjectExpression") return;
      const properties = object.properties.filter((property) => property.type === "Property");
      const names = properties.flatMap((property) =>
        property.key.type === "Identifier" ? [property.key.name] : [],
      );
      if (!names.includes("sourceSessionId") || !names.includes("targetSessionId")) return;
      let usesAuthority = false;
      walk(object, (child) => {
        if (
          child.type === "MemberExpression" &&
          child.object.type === "Identifier" &&
          authorities.has(child.object.name)
        )
          usesAuthority = true;
        if (
          child.type === "SpreadElement" &&
          child.argument.type === "Identifier" &&
          authorities.has(child.argument.name)
        )
          usesAuthority = true;
      });
      if (!usesAuthority) return;
      carriers++;
      const spread = object.properties.some(
        (property) =>
          property.type === "SpreadElement" &&
          property.argument.type === "Identifier" &&
          authorities.has(property.argument.name),
      );
      const copied = ["personalConnectionDelegations", "mcpAccountBindings"].every((name) =>
        properties.some(
          (property) =>
            property.key.type === "Identifier" &&
            property.key.name === name &&
            property.value.type === "MemberExpression" &&
            property.value.object.type === "Identifier" &&
            authorities.has(property.value.object.name) &&
            property.value.property.type === "Identifier" &&
            property.value.property.name === name,
        ),
      );
      if (!spread && !copied) errors.push("outbox lost accepted authority");
    });
  });
  if (!authorities.size) errors.push("missing accepted authority helper call");
  if (!carriers) errors.push("missing child outbox carrier");
  if (!helperReturnsBoth) errors.push("helper lost paired authority snapshots");
  return errors;
}

function removeNode(source: string, predicate: (node: t.Node) => boolean): string {
  const parsed = t.parseSync("mutation.ts", source);
  let selected: t.Node | undefined;
  walk(parsed.program, (node) => {
    if (!selected && predicate(node)) selected = node;
  });
  if (!selected) throw new Error("mutation target not found");
  const end = source[selected.end] === "," ? selected.end + 1 : selected.end;
  return source.slice(0, selected.start) + source.slice(end);
}

// Account routes and personal sender proof have different authority semantics,
// but every accepted-work carrier must copy both. This structural guard covers
// producers outside the SQL fixture: queue edits, child notices, goal and
// background-command continuations, outbox delivery/replay, and realtime leases
// through live delegation and transcript handoff.
for (const filename of [
  "index.ts",
  "session-queue-commands.ts",
  "session-control.ts",
  "session-realtime.ts",
  "session-realtime-context.ts",
  "session-realtime-ledger.ts",
]) {
  test(`${filename} never drops account bindings while copying accepted personal authority`, async () => {
    const source = await readFile(new URL(`../src/${filename}`, import.meta.url), "utf8");
    if (filename === "session-control.ts") {
      const helper = await readFile(
        new URL("../src/child-outbox-authority.ts", import.meta.url),
        "utf8",
      );
      expect(childAuthorityErrors(source, helper)).toEqual([]);
      return;
    }
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

test("both child outbox producers retain the helper snapshots and reject dropped propagation", async () => {
  const helper = await readFile(
    new URL("../src/child-outbox-authority.ts", import.meta.url),
    "utf8",
  );
  const withoutBindings = removeNode(
    helper,
    (node) =>
      node.type === "Property" &&
      node.key.type === "Identifier" &&
      node.key.name === "mcpAccountBindings",
  );
  for (const filename of ["index.ts", "session-control.ts"]) {
    const source = await readFile(new URL(`../src/${filename}`, import.meta.url), "utf8");
    expect(childAuthorityErrors(source, helper)).toEqual([]);
    expect(childAuthorityErrors(source, withoutBindings)).toContain(
      "helper lost paired authority snapshots",
    );
  }
  const source = await readFile(new URL("../src/session-control.ts", import.meta.url), "utf8");
  const withoutAuthority = removeNode(
    source,
    (node) =>
      node.type === "SpreadElement" &&
      node.argument.type === "Identifier" &&
      node.argument.name === "authority",
  );
  expect(childAuthorityErrors(withoutAuthority, helper)).toContain(
    "outbox lost accepted authority",
  );
});

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
    "mcp_account_bindings",
  ]);
});
