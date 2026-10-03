import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync, type Node } from "oxc-parser";

const pairs = [
  {
    name: "tool metadata",
    file: "tool-environment.ts",
    functionName: "prepareTurnToolRuntime",
    bindings: ["skillConfiguration", "sharedSkillDescriptors"],
    readers: ["getWorkspaceVideoGenerationPolicy", "listSkillDescriptors"],
  },
  {
    name: "agent metadata",
    file: "agent-build.ts",
    functionName: "buildTurnAgent",
    bindings: ["sessionInstructions", "videoGenerationPolicy"],
    readers: ["recoveryAwareSessionInstructions", "getWorkspaceVideoGenerationPolicy"],
  },
] as const;

function readPair(pair: (typeof pairs)[number]) {
  const source = readFileSync(
    new URL(`../src/activities/agent-turn/${pair.file}`, import.meta.url),
    "utf8",
  );
  const parsed = parseSync(pair.file, source);
  expect(parsed.errors).toEqual([]);
  const exported = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === pair.functionName,
  );
  if (
    exported?.type !== "ExportNamedDeclaration" ||
    exported.declaration?.type !== "FunctionDeclaration"
  ) {
    throw new Error(`Missing ${pair.functionName}`);
  }
  const body = exported.declaration.body!.body;
  const statements = body.filter(
    (statement) =>
      statement.type === "VariableDeclaration" &&
      statement.declarations.some((declaration) => {
        const ids =
          declaration.id.type === "ArrayPattern" ? declaration.id.elements : [declaration.id];
        return ids.some(
          (id) => id?.type === "Identifier" && pair.bindings.some((name) => name === id.name),
        );
      }),
  );
  expect(statements.length).toBeGreaterThan(0);
  const reads = statements.map((statement) => source.slice(statement.start, statement.end));
  // Execute the actual production declarations, not a handwritten equivalent.
  // The placement contract below pins the surrounding authority/write order.
  const execute = new Function(
    "ports",
    "db",
    "input",
    "session",
    "deps",
    "afterReads",
    `return (async () => {
      const { ${pair.readers.join(", ")} } = ports;
      ${reads.join("\n")}
      await afterReads();
      return { ${pair.bindings.join(", ")} };
    })();`,
  ) as (
    ports: Record<string, (...args: unknown[]) => Promise<unknown>>,
    db: object,
    input: { accountId: string; workspaceId: string },
    session: object,
    deps: { fileAuthoritySubjectId: string },
    afterReads: () => void,
  ) => Promise<Record<string, unknown>>;
  return { source, body, statements, execute };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A held test read can be rejected even if a regressed serial path has not
  // invoked it yet. Keep that negative control out of unhandled-rejection noise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function fixture(pair: (typeof pairs)[number]) {
  const reads = [deferred(), deferred()];
  const calls: { name: string; args: unknown[] }[] = [];
  const db = {};
  const input = { accountId: "account", workspaceId: "workspace" };
  const session = { id: "session", instructions: "Retain recovery truth" };
  const deps = { fileAuthoritySubjectId: "human" };
  let writes = 0;
  const ports = Object.fromEntries(
    pair.readers.map((name, index) => [
      name,
      (...args: unknown[]) => {
        calls.push({ name, args });
        return reads[index]!.promise;
      },
    ]),
  );
  const running = readPair(pair).execute(ports, db, input, session, deps, () => {
    writes++;
  });
  void running.catch(() => undefined);
  return { reads, calls, db, input, session, deps, running, writes: () => writes };
}

for (const pair of pairs) {
  describe(pair.name, () => {
    for (const firstCompleted of [0, 1]) {
      test(`starts both held reads before either settles; completion order ${firstCompleted}`, async () => {
        const f = fixture(pair);
        try {
          expect(f.calls.map((call) => call.name)).toEqual([...pair.readers]);
          expect(f.writes()).toBe(0);
          f.reads[firstCompleted]!.resolve(`value-${firstCompleted}`);
          await Promise.resolve();
          await Promise.resolve();
          expect(f.writes()).toBe(0);
          f.reads[1 - firstCompleted]!.resolve(`value-${1 - firstCompleted}`);
          expect(await f.running).toEqual({
            [pair.bindings[0]]: "value-0",
            [pair.bindings[1]]: "value-1",
          });
          expect(f.writes()).toBe(1);
          expect(f.calls[0]!.args).toEqual(
            pair.name === "agent metadata"
              ? [f.db, f.input.workspaceId, f.session]
              : [f.db, f.input.workspaceId],
          );
          expect(f.calls[1]!.args).toEqual(
            pair.name === "agent metadata"
              ? [f.db, f.input.workspaceId]
              : [
                  f.db,
                  {
                    accountId: f.input.accountId,
                    workspaceId: f.input.workspaceId,
                    subjectId: f.deps.fileAuthoritySubjectId,
                  },
                ],
          );
        } finally {
          for (const [index, read] of f.reads.entries()) read.resolve(`value-${index}`);
          await f.running;
        }
      });
    }

    for (const failedRead of [0, 1]) {
      test(`read ${failedRead} failure prevents writes even after the sibling finishes`, async () => {
        const f = fixture(pair);
        const failure = new Error(`metadata read ${failedRead} failed`);
        try {
          expect(f.calls.map((call) => call.name)).toEqual([...pair.readers]);
          f.reads[failedRead]!.reject(failure);
          await expect(f.running).rejects.toBe(failure);
          expect(f.writes()).toBe(0);
          f.reads[1 - failedRead]!.resolve("late sibling result");
          await Promise.resolve();
          await Promise.resolve();
          expect(f.writes()).toBe(0);
        } finally {
          for (const read of f.reads) read.resolve("cleanup");
          await f.running.catch(() => undefined);
        }
      });
    }
  });
}

function callOffsets(node: Node, name: string): number[] {
  const offsets: number[] = [];
  const visit = (current: Node): void => {
    if (
      current.type === "CallExpression" &&
      current.callee.type === "Identifier" &&
      current.callee.name === name
    ) {
      offsets.push(current.start);
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) visit(child as Node);
        }
      } else if (value && typeof value === "object" && "type" in value) {
        visit(value as Node);
      }
    }
  };
  visit(node);
  return offsets;
}

test("paired reads retain authority placement, separate live video reads and fenced catalog ordering", () => {
  const tools = readPair(pairs[0]);
  const agent = readPair(pairs[1]);
  const toolNode = { type: "BlockStatement", body: tools.body } as Node;
  const agentNode = { type: "BlockStatement", body: agent.body } as Node;
  const toolRead = callOffsets(toolNode, "getWorkspaceVideoGenerationPolicy");
  const agentRead = callOffsets(agentNode, "getWorkspaceVideoGenerationPolicy");
  expect(toolRead).toHaveLength(1);
  expect(agentRead).toHaveLength(1);
  expect(callOffsets(toolNode, "getExternalLinkTurnAuthorization")[0]!).toBeLessThan(toolRead[0]!);
  const linkedGuard = tools.body.find(
    (statement) =>
      statement.type === "IfStatement" &&
      statement.consequent.type === "ThrowStatement" &&
      tools.source.slice(statement.test.start, statement.test.end).includes("linkedAuthority"),
  );
  expect(linkedGuard).toBeDefined();
  expect(linkedGuard!.end).toBeLessThan(tools.statements[0]!.start);
  expect(callOffsets(agentNode, "recoveryAwareSessionInstructions")).toHaveLength(1);
  expect(callOffsets(agentNode, "ensureSessionSkillCatalog")[0]!).toBeGreaterThan(
    agent.statements.at(-1)!.end,
  );
  expect(callOffsets(agentNode, "getExternalLinkTurnAuthorization")[0]!).toBeGreaterThan(
    callOffsets(agentNode, "ensureSessionSkillCatalog")[0]!,
  );
  expect(callOffsets(agentNode, "sessionHasToolRouterHistory")[0]!).toBeGreaterThan(
    callOffsets(agentNode, "getExternalLinkTurnAuthorization")[0]!,
  );
});
