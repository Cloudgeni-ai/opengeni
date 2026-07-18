import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

type LockContract = "canonical" | "turn_attempt_fence" | "owned_suffix";

type ExpectedWriter = {
  inserts: number;
  contract: LockContract;
};

const repoRoot = resolve(import.meta.dir, "../../..");

const expectedWriters: Record<string, ExpectedWriter> = {
  "packages/db/src/index.ts#armCodexCapacityWait": { inserts: 1, contract: "canonical" },
  "packages/db/src/index.ts#supersedeCodexCapacityWaitInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
  },
  "packages/db/src/index.ts#reconcileCodexCapacityWait": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#applyContextCompaction": {
    inserts: 1,
    contract: "turn_attempt_fence",
  },
  "packages/db/src/index.ts#recordSkippedContextCompaction": {
    inserts: 1,
    contract: "turn_attempt_fence",
  },
  "packages/db/src/index.ts#commitWorkspaceCaptureRevision": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#clearSessionGoal": { inserts: 1, contract: "canonical" },
  "packages/db/src/index.ts#initializeSessionStartAtomically": {
    inserts: 2,
    contract: "canonical",
  },
  "packages/db/src/index.ts#claimSessionWorkForAttempt": {
    inserts: 3,
    contract: "canonical",
  },
  "packages/db/src/index.ts#settleSessionAttemptInterruptions": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#settleSessionIdleWithParentOutbox": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#applySessionTurnSettlement": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#settleCodexCredentialLeaseLoss": {
    inserts: 2,
    contract: "canonical",
  },
  "packages/db/src/index.ts#settleCodexCredentialFailover": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#requestSessionTurnRecovery": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#recoverSessionDispatch": { inserts: 2, contract: "canonical" },
  "packages/db/src/index.ts#addSessionSystemUpdateWithSourceMutation": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#appendSessionEvents": { inserts: 1, contract: "canonical" },
  "packages/db/src/index.ts#acceptSessionApprovalDecision": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#appendSessionEventsForTurnAttempt": {
    inserts: 1,
    contract: "turn_attempt_fence",
  },
  "packages/db/src/index.ts#appendSessionEventToSandboxGroup": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#appendSessionEventsAndUpdateSession": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#appendSessionEventsWithLockedSessionUpdate": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-control.ts#mutateSessionControlInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#moveQueuedTurnInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#deleteSessionQueueItemInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#editQueuedTurnInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#steerQueuedTurnInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#submitHumanPromptInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#sendAgentMessageInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-queue-commands.ts#steerAgentSessionInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-tool-call-settlement.ts#closePendingSessionToolCallsInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
  },
};

const expectedOwnedSuffixCallers: Record<string, string[]> = {
  supersedeCodexCapacityWaitInTransaction: ["reconcileCodexCapacityWait"],
  closePendingSessionToolCallsInTransaction: [
    "armCodexCapacityWait",
    "supersedeSessionCurrentDirectionInTransaction",
    "settleSessionAttemptInterruptions",
    "applySessionTurnSettlement",
    "settleCodexCredentialLeaseLoss",
    "settleCodexCredentialFailover",
    "requestSessionTurnRecovery",
    "recoverSessionDispatch",
  ],
};

function productionTypeScriptFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ["node_modules", "dist", "coverage", "test", "tests", "__tests__"].includes(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of ["packages", "apps", "scripts"]) visit(join(repoRoot, root));
  return files.sort();
}

function namedTopLevelFunction(
  node: ts.Node,
): { name: string; node: ts.FunctionLikeDeclaration } | null {
  let current: ts.Node | undefined = node;
  let result: { name: string; node: ts.FunctionLikeDeclaration } | null = null;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      result = { name: current.name.text, node: current };
    } else if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      result = { name: current.parent.name.text, node: current };
    }
    current = current.parent;
  }
  return result;
}

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function insertsSessionEvents(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "insert") {
    return false;
  }
  const table = node.arguments[0];
  return Boolean(
    table &&
    ((ts.isPropertyAccessExpression(table) && table.name.text === "sessionEvents") ||
      (ts.isIdentifier(table) && table.text === "sessionEvents")),
  );
}

function functionCalls(functionNode: ts.FunctionLikeDeclaration, expectedName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callName(node) === expectedName) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(functionNode, visit);
  return found;
}

function callPositions(functionNode: ts.FunctionLikeDeclaration, expectedName: string): number[] {
  const positions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callName(node) === expectedName) {
      positions.push(node.getStart());
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

function insertPositions(functionNode: ts.FunctionLikeDeclaration): number[] {
  const positions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && insertsSessionEvents(node)) {
      positions.push(node.getStart());
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

describe("session_events writer inventory", () => {
  test("every production insert has an explicit canonical or caller-owned lock contract", () => {
    const writers = new Map<
      string,
      { count: number; sourceFile: ts.SourceFile; functionNode: ts.FunctionLikeDeclaration }
    >();
    const rawSqlWriters: string[] = [];
    const functionDefinitions = new Map<
      string,
      Array<{ sourceFile: ts.SourceFile; functionNode: ts.FunctionLikeDeclaration }>
    >();
    const ownedSuffixCallers = new Map<string, Set<string>>(
      Object.keys(expectedOwnedSuffixCallers).map((name) => [name, new Set()]),
    );

    for (const path of productionTypeScriptFiles()) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("sessionEvents") && !source.includes("session_events")) continue;
      const file = relative(repoRoot, path).replaceAll("\\", "/");
      const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const definitions = functionDefinitions.get(node.name.text) ?? [];
          definitions.push({ sourceFile, functionNode: node });
          functionDefinitions.set(node.name.text, definitions);
        }
        if (ts.isCallExpression(node)) {
          const enclosing = namedTopLevelFunction(node);
          if (insertsSessionEvents(node)) {
            if (!enclosing) throw new Error(`Unnamed session_events writer in ${file}`);
            const key = `${file}#${enclosing.name}`;
            const existing = writers.get(key);
            writers.set(key, {
              count: (existing?.count ?? 0) + 1,
              sourceFile,
              functionNode: enclosing.node,
            });
          }
          const called = callName(node);
          if (called && ownedSuffixCallers.has(called) && enclosing) {
            ownedSuffixCallers.get(called)!.add(enclosing.name);
          }
        }
        if (ts.isTaggedTemplateExpression(node)) {
          const sqlText = node.template.getText(sourceFile);
          if (/\binsert\s+into\s+(?:[a-z_]+\.)?session_events\b/i.test(sqlText)) {
            rawSqlWriters.push(
              `${file}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(rawSqlWriters).toEqual([]);
    expect(Object.fromEntries([...writers].map(([key, value]) => [key, value.count]))).toEqual(
      Object.fromEntries(
        Object.entries(expectedWriters).map(([key, value]) => [key, value.inserts]),
      ),
    );

    for (const [key, expected] of Object.entries(expectedWriters)) {
      const writer = writers.get(key)!;
      if (expected.contract === "canonical") {
        expect(functionCalls(writer.functionNode, "lockSessionEventWriteRows")).toBe(true);
        const firstLock = callPositions(writer.functionNode, "lockSessionEventWriteRows")[0];
        expect(firstLock).toBeLessThan(insertPositions(writer.functionNode)[0]!);
      } else if (expected.contract === "turn_attempt_fence") {
        expect(functionCalls(writer.functionNode, "lockTurnAttemptWriteFenceTx")).toBe(true);
        const firstFence = callPositions(writer.functionNode, "lockTurnAttemptWriteFenceTx")[0];
        expect(firstFence).toBeLessThan(insertPositions(writer.functionNode)[0]!);
      }
    }

    expect(
      Object.fromEntries(
        [...ownedSuffixCallers].map(([name, callers]) => [name, [...callers].sort()]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(expectedOwnedSuffixCallers).map(([name, callers]) => [
          name,
          [...callers].sort(),
        ]),
      ),
    );

    for (const callers of ownedSuffixCallers.values()) {
      for (const caller of callers) {
        const definitions = functionDefinitions.get(caller) ?? [];
        expect(definitions).toHaveLength(1);
        const callerNode = definitions[0]!.functionNode;
        expect(functionCalls(callerNode, "lockSessionEventWriteRows")).toBe(true);
        const firstLock = callPositions(callerNode, "lockSessionEventWriteRows")[0];
        const delegatedCalls = [...ownedSuffixCallers.keys()].flatMap((ownedWriter) =>
          callPositions(callerNode, ownedWriter),
        );
        expect(firstLock).toBeLessThan(Math.min(...delegatedCalls));
      }
    }
  });
});
