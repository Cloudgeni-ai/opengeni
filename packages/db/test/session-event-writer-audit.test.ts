import { describe, expect, test } from "bun:test";
import { parse } from "@babel/parser";
import * as babel from "@babel/types";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type LockContract = "canonical" | "turn_attempt_fence" | "owned_suffix";

type ExpectedWriter = {
  inserts: number;
  contract: LockContract;
  requiresControlRevalidation?: boolean;
};

const repoRoot = resolve(import.meta.dir, "../../..");

const expectedWriters: Record<string, ExpectedWriter> = {
  "packages/db/src/index.ts#armCodexCapacityWait": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#supersedeCodexCapacityWaitInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
  },
  "packages/db/src/index.ts#reconcileCodexCapacityWait": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
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
  "packages/db/src/index.ts#clearSessionGoal": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#upsertSessionGoalWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#updateSessionGoalWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#setSessionGoalStatusWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#materializeGoalContinuation": {
    inserts: 2,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#initializeSessionStartAtomically": {
    inserts: 2,
    contract: "canonical",
  },
  "packages/db/src/index.ts#claimSessionWorkForAttempt": {
    inserts: 4,
    contract: "canonical",
  },
  "packages/db/src/index.ts#markSessionAttemptQuiesced": {
    inserts: 1,
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
  "packages/db/src/index.ts#acceptSessionHumanInputResponse": {
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
  "packages/db/src/session-queue-commands.ts#supersedeSessionCurrentDirectionInTransaction": {
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

const genericControlWriters = new Set([
  "packages/db/src/index.ts#acceptSessionApprovalDecision",
  "packages/db/src/index.ts#acceptSessionHumanInputResponse",
  "packages/db/src/index.ts#appendSessionEvents",
  "packages/db/src/index.ts#appendSessionEventsAndUpdateSession",
  "packages/db/src/index.ts#appendSessionEventToSandboxGroup",
]);

const callerOwnedControlWriters = new Set([
  "packages/db/src/session-queue-commands.ts#supersedeSessionCurrentDirectionInTransaction",
]);

const expectedOwnedSuffixCallers: Record<string, string[]> = {
  supersedeCodexCapacityWaitInTransaction: ["reconcileCodexCapacityWait"],
  supersedeSessionCurrentDirectionInTransaction: [
    "steerAgentSessionInTransaction",
    "steerQueuedTurnInTransaction",
    "submitHumanPromptInTransaction",
  ],
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

const expectedOutboxWriters: Record<
  string,
  { inserts: number; contract: "child_lifecycle" | "owned_child_lifecycle" | "canonical_pair" }
> = {
  "packages/db/src/index.ts#settleSessionIdleWithParentOutbox": {
    inserts: 1,
    contract: "child_lifecycle",
  },
  "packages/db/src/index.ts#enqueueFailedChildOutboxForTurnTx": {
    inserts: 1,
    contract: "owned_child_lifecycle",
  },
  "packages/db/src/index.ts#getOrCreateSessionSystemUpdateOutbox": {
    inserts: 1,
    contract: "canonical_pair",
  },
};

const expectedFailedChildOutboxCallers = ["applySessionTurnSettlement", "recoverSessionDispatch"];

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

type AstNode = babel.Node;
type FunctionLike =
  | babel.FunctionDeclaration
  | babel.FunctionExpression
  | babel.ArrowFunctionExpression;
type ParsedSource = {
  ast: babel.File;
  source: string;
};

const parentNodes = new WeakMap<AstNode, AstNode>();

function isAstNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === "object" && "type" in value);
}

function forEachAstChild(node: AstNode, visit: (child: AstNode) => void): void {
  for (const key of babel.VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) visit(child);
      }
    } else if (isAstNode(value)) {
      visit(value);
    }
  }
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  forEachAstChild(node, (child) => walkAst(child, visit));
}

function parseTypeScriptSource(source: string): ParsedSource {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx", "decorators-legacy", "importAttributes"],
  });
  walkAst(ast, (node) => {
    forEachAstChild(node, (child) => parentNodes.set(child, node));
  });
  return { ast, source };
}

function nodeStart(node: AstNode): number {
  return node.start ?? 0;
}

function nodeLine(node: AstNode): number {
  return node.loc?.start.line ?? 1;
}

function memberName(node: babel.MemberExpression | babel.OptionalMemberExpression): string | null {
  if (!node.computed && babel.isIdentifier(node.property)) return node.property.name;
  if (node.computed && babel.isStringLiteral(node.property)) return node.property.value;
  return null;
}

function propertyName(node: babel.ObjectProperty | babel.ObjectMethod): string | null {
  if (!node.computed && babel.isIdentifier(node.key)) return node.key.name;
  if (babel.isStringLiteral(node.key)) return node.key.value;
  return null;
}

function namedTopLevelFunction(node: AstNode): { name: string; node: FunctionLike } | null {
  let current: AstNode | undefined = node;
  let result: { name: string; node: FunctionLike } | null = null;
  while (current) {
    if (babel.isFunctionDeclaration(current) && current.id) {
      result = { name: current.id.name, node: current };
    } else if (babel.isArrowFunctionExpression(current) || babel.isFunctionExpression(current)) {
      const parent = parentNodes.get(current);
      if (babel.isVariableDeclarator(parent) && babel.isIdentifier(parent.id)) {
        result = { name: parent.id.name, node: current };
      }
    }
    current = parentNodes.get(current);
  }
  return result;
}

function callName(node: babel.CallExpression): string | null {
  if (babel.isIdentifier(node.callee)) return node.callee.name;
  if (babel.isMemberExpression(node.callee) || babel.isOptionalMemberExpression(node.callee)) {
    return memberName(node.callee);
  }
  return null;
}

function isNamedReference(node: babel.Node | null | undefined, expectedName: string): boolean {
  return (
    (babel.isIdentifier(node) && node.name === expectedName) ||
    ((babel.isMemberExpression(node) || babel.isOptionalMemberExpression(node)) &&
      memberName(node) === expectedName)
  );
}

function insertsSessionEvents(node: babel.CallExpression): boolean {
  if (
    (!babel.isMemberExpression(node.callee) && !babel.isOptionalMemberExpression(node.callee)) ||
    memberName(node.callee) !== "insert"
  ) {
    return false;
  }
  return isNamedReference(node.arguments[0], "sessionEvents");
}

function insertsSessionSystemUpdateOutbox(node: babel.CallExpression): boolean {
  if (
    (!babel.isMemberExpression(node.callee) && !babel.isOptionalMemberExpression(node.callee)) ||
    memberName(node.callee) !== "insert"
  ) {
    return false;
  }
  return isNamedReference(node.arguments[0], "sessionSystemUpdateOutbox");
}

function functionCalls(functionNode: FunctionLike, expectedName: string): boolean {
  let found = false;
  forEachAstChild(functionNode, (child) =>
    walkAst(child, (node) => {
      if (babel.isCallExpression(node) && callName(node) === expectedName) found = true;
    }),
  );
  return found;
}

function callHasProperty(node: babel.CallExpression, expectedPropertyName: string): boolean {
  return node.arguments.some(
    (argument) =>
      babel.isObjectExpression(argument) &&
      argument.properties.some(
        (property) =>
          babel.isObjectProperty(property) && propertyName(property) === expectedPropertyName,
      ),
  );
}

function callPositionsWithStringProperty(
  functionNode: FunctionLike,
  expectedName: string,
  expectedPropertyName: string,
  propertyValue: string,
): number[] {
  const positions: number[] = [];
  forEachAstChild(functionNode, (child) =>
    walkAst(child, (node) => {
      if (
        babel.isCallExpression(node) &&
        callName(node) === expectedName &&
        node.arguments.some(
          (argument) =>
            babel.isObjectExpression(argument) &&
            argument.properties.some(
              (property) =>
                babel.isObjectProperty(property) &&
                propertyName(property) === expectedPropertyName &&
                babel.isStringLiteral(property.value) &&
                property.value.value === propertyValue,
            ),
        )
      ) {
        positions.push(nodeStart(node));
      }
    }),
  );
  return positions.sort((left, right) => left - right);
}

function callPositionsWithStringArgument(
  functionNode: FunctionLike,
  expectedName: string,
  argumentIndex: number,
  argumentValue: string,
): number[] {
  const positions: number[] = [];
  forEachAstChild(functionNode, (child) =>
    walkAst(child, (node) => {
      if (babel.isCallExpression(node) && callName(node) === expectedName) {
        const argument = node.arguments[argumentIndex];
        if (babel.isStringLiteral(argument) && argument.value === argumentValue) {
          positions.push(nodeStart(node));
        }
      }
    }),
  );
  return positions.sort((left, right) => left - right);
}

function controlAwarePrefixPositions(functionNode: FunctionLike): number[] {
  return [
    ...callPositionsWithStringProperty(
      functionNode,
      "lockSessionEventWriteRows",
      "controlLock",
      "share",
    ),
    ...callPositionsWithStringProperty(
      functionNode,
      "lockSessionEventWriteRows",
      "controlLock",
      "update",
    ),
    ...callPositionsWithStringArgument(functionNode, "lockWorkspaceInferenceControl", 2, "share"),
    ...callPositionsWithStringArgument(functionNode, "lockWorkspaceInferenceControl", 2, "update"),
    ...callPositions(functionNode, "lockChildLifecycleOutboxWriteRowsTx"),
  ].sort((left, right) => left - right);
}

function genericPrefixPositions(functionNode: FunctionLike): number[] {
  return callPositionsWithStringProperty(
    functionNode,
    "lockSessionEventWriteRows",
    "controlLock",
    "none",
  );
}

function callPositions(functionNode: FunctionLike, expectedName: string): number[] {
  const positions: number[] = [];
  forEachAstChild(functionNode, (child) =>
    walkAst(child, (node) => {
      if (babel.isCallExpression(node) && callName(node) === expectedName) {
        positions.push(nodeStart(node));
      }
    }),
  );
  return positions.sort((left, right) => left - right);
}

function insertPositions(functionNode: FunctionLike): number[] {
  const positions: number[] = [];
  forEachAstChild(functionNode, (child) =>
    walkAst(child, (node) => {
      if (babel.isCallExpression(node) && insertsSessionEvents(node)) {
        positions.push(nodeStart(node));
      }
    }),
  );
  return positions.sort((left, right) => left - right);
}

describe("session_events writer inventory", () => {
  test("every production insert has an explicit canonical or caller-owned lock contract", () => {
    const writers = new Map<
      string,
      { count: number; sourceFile: ParsedSource; functionNode: FunctionLike }
    >();
    const rawSqlWriters: string[] = [];
    const implicitControlLockCalls: string[] = [];
    const functionDefinitions = new Map<
      string,
      Array<{ sourceFile: ParsedSource; functionNode: FunctionLike }>
    >();
    const ownedSuffixCallers = new Map<string, Set<string>>(
      Object.keys(expectedOwnedSuffixCallers).map((name) => [name, new Set()]),
    );
    const outboxWriters = new Map<
      string,
      { count: number; sourceFile: ParsedSource; functionNode: FunctionLike }
    >();
    const failedChildOutboxCallers = new Set<string>();

    for (const path of productionTypeScriptFiles()) {
      const source = readFileSync(path, "utf8");
      if (
        !source.includes("sessionEvents") &&
        !source.includes("session_events") &&
        !source.includes("sessionSystemUpdateOutbox") &&
        !source.includes("session_system_update_outbox")
      ) {
        continue;
      }
      const file = relative(repoRoot, path).replaceAll("\\", "/");
      const sourceFile = parseTypeScriptSource(source);
      const visit = (node: AstNode): void => {
        if (babel.isFunctionDeclaration(node) && node.id) {
          const definitions = functionDefinitions.get(node.id.name) ?? [];
          definitions.push({ sourceFile, functionNode: node });
          functionDefinitions.set(node.id.name, definitions);
        }
        if (babel.isCallExpression(node)) {
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
          if (insertsSessionSystemUpdateOutbox(node)) {
            if (!enclosing)
              throw new Error(`Unnamed session-system-update outbox writer in ${file}`);
            const key = `${file}#${enclosing.name}`;
            const existing = outboxWriters.get(key);
            outboxWriters.set(key, {
              count: (existing?.count ?? 0) + 1,
              sourceFile,
              functionNode: enclosing.node,
            });
          }
          const called = callName(node);
          if (called === "lockSessionEventWriteRows" && !callHasProperty(node, "controlLock")) {
            implicitControlLockCalls.push(`${file}:${nodeLine(node)}`);
          }
          if (called && ownedSuffixCallers.has(called) && enclosing) {
            ownedSuffixCallers.get(called)!.add(enclosing.name);
          }
          if (called === "enqueueFailedChildOutboxForTurnTx" && enclosing) {
            failedChildOutboxCallers.add(enclosing.name);
          }
        }
        if (babel.isTaggedTemplateExpression(node)) {
          const sqlText = sourceFile.source.slice(node.quasi.start ?? 0, node.quasi.end ?? 0);
          if (/\binsert\s+into\s+(?:[a-z_]+\.)?session_events\b/i.test(sqlText)) {
            rawSqlWriters.push(`${file}:${nodeLine(node)}`);
          }
        }
      };
      walkAst(sourceFile.ast, visit);
    }

    expect(rawSqlWriters).toEqual([]);
    expect(implicitControlLockCalls).toEqual([]);
    expect(Object.fromEntries([...writers].map(([key, value]) => [key, value.count]))).toEqual(
      Object.fromEntries(
        Object.entries(expectedWriters).map(([key, value]) => [key, value.inserts]),
      ),
    );

    for (const [key, expected] of Object.entries(expectedWriters)) {
      const writer = writers.get(key)!;
      if (expected.contract === "canonical") {
        const canonicalLocks = [
          ...callPositions(writer.functionNode, "lockSessionEventWriteRows"),
          ...callPositions(writer.functionNode, "lockChildLifecycleOutboxWriteRowsTx"),
        ].sort((left, right) => left - right);
        expect(canonicalLocks.length).toBeGreaterThan(0);
        const firstLock = canonicalLocks[0];
        const firstInsert = insertPositions(writer.functionNode)[0]!;
        expect(firstLock).toBeLessThan(firstInsert);
        if (genericControlWriters.has(key)) {
          const prefixes = genericPrefixPositions(writer.functionNode);
          expect(prefixes.length).toBeGreaterThan(0);
          expect(prefixes[0]).toBeLessThan(firstInsert);
        } else if (callerOwnedControlWriters.has(key)) {
          const writerName = key.slice(key.lastIndexOf("#") + 1);
          expect(Object.hasOwn(expectedOwnedSuffixCallers, writerName)).toBe(true);
        } else {
          const prefixes = controlAwarePrefixPositions(writer.functionNode);
          expect(prefixes.length).toBeGreaterThan(0);
          expect(prefixes[0]).toBeLessThan(firstInsert);
        }
        if (expected.requiresControlRevalidation) {
          expect(functionCalls(writer.functionNode, "evaluateSessionControl")).toBe(true);
        }
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
        const canonicalLocks = [
          ...callPositions(callerNode, "lockSessionEventWriteRows"),
          ...callPositions(callerNode, "lockChildLifecycleOutboxWriteRowsTx"),
        ].sort((left, right) => left - right);
        expect(canonicalLocks.length).toBeGreaterThan(0);
        expect(
          controlAwarePrefixPositions(callerNode).length > 0 ||
            genericPrefixPositions(callerNode).length > 0 ||
            Object.hasOwn(expectedOwnedSuffixCallers, caller),
        ).toBe(true);
        const firstLock = canonicalLocks[0];
        const delegatedCalls = [...ownedSuffixCallers.keys()].flatMap((ownedWriter) =>
          callPositions(callerNode, ownedWriter),
        );
        expect(firstLock).toBeLessThan(Math.min(...delegatedCalls));
      }
    }

    expect(
      Object.fromEntries([...outboxWriters].map(([key, value]) => [key, value.count])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(expectedOutboxWriters).map(([key, value]) => [key, value.inserts]),
      ),
    );
    expect([...failedChildOutboxCallers].sort()).toEqual(
      [...expectedFailedChildOutboxCallers].sort(),
    );
    for (const [key, expected] of Object.entries(expectedOutboxWriters)) {
      const writer = outboxWriters.get(key)!;
      if (expected.contract === "child_lifecycle") {
        expect(functionCalls(writer.functionNode, "lockChildLifecycleOutboxWriteRowsTx")).toBe(
          true,
        );
        expect(functionCalls(writer.functionNode, "retryWorkspacePersistence")).toBe(true);
      } else if (expected.contract === "canonical_pair") {
        expect(functionCalls(writer.functionNode, "lockSessionEventWriteRows")).toBe(true);
        expect(functionCalls(writer.functionNode, "retryRlsPersistence")).toBe(true);
        const firstLock = callPositions(writer.functionNode, "lockSessionEventWriteRows")[0];
        expect(firstLock).toBeLessThan(callPositions(writer.functionNode, "insert")[0]!);
        const genericPrefixes = genericPrefixPositions(writer.functionNode);
        expect(genericPrefixes.length).toBeGreaterThan(0);
        expect(genericPrefixes[0]).toBeLessThan(callPositions(writer.functionNode, "insert")[0]!);
      }
    }
    for (const caller of expectedFailedChildOutboxCallers) {
      const definitions = functionDefinitions.get(caller) ?? [];
      expect(definitions).toHaveLength(1);
      const callerNode = definitions[0]!.functionNode;
      expect(functionCalls(callerNode, "lockChildLifecycleOutboxWriteRowsTx")).toBe(true);
      expect(functionCalls(callerNode, "retryWorkspacePersistence")).toBe(true);
      const firstLock = callPositions(callerNode, "lockChildLifecycleOutboxWriteRowsTx")[0];
      const enqueue = callPositions(callerNode, "enqueueFailedChildOutboxForTurnTx")[0];
      expect(firstLock).toBeLessThan(enqueue!);
    }

    const turnAttemptFence = functionDefinitions.get("lockTurnAttemptWriteFenceTx") ?? [];
    expect(turnAttemptFence).toHaveLength(1);
    expect(controlAwarePrefixPositions(turnAttemptFence[0]!.functionNode).length).toBeGreaterThan(
      0,
    );

    const childLifecyclePrefix =
      functionDefinitions.get("lockChildLifecycleOutboxWriteRowsTx") ?? [];
    expect(childLifecyclePrefix).toHaveLength(1);
    expect(
      controlAwarePrefixPositions(childLifecyclePrefix[0]!.functionNode).length,
    ).toBeGreaterThan(0);
  });

  test("generic append and Agent commands keep external effects outside bounded retry", () => {
    const definitionsFor = (relativePath: string) => {
      const path = join(repoRoot, relativePath);
      const sourceFile = parseTypeScriptSource(readFileSync(path, "utf8"));
      const definitions = new Map<string, babel.FunctionDeclaration>();
      const visit = (node: AstNode): void => {
        if (babel.isFunctionDeclaration(node) && node.id) {
          definitions.set(node.id.name, node);
        }
      };
      walkAst(sourceFile.ast, visit);
      return definitions;
    };

    const dbDefinitions = definitionsFor("packages/db/src/index.ts");
    const genericAppend = dbDefinitions.get("appendSessionEvents");
    expect(genericAppend).toBeDefined();
    expect(functionCalls(genericAppend!, "retryWorkspacePersistence")).toBe(true);
    expect(callPositions(genericAppend!, "retryWorkspacePersistence")[0]).toBeLessThan(
      insertPositions(genericAppend!)[0]!,
    );

    const commandDefinitions = definitionsFor("packages/core/src/application/session-commands.ts");
    const retryHelper = commandDefinitions.get("runAgentCommandPersistenceTransaction");
    expect(retryHelper).toBeDefined();
    expect(functionCalls(retryHelper!, "runIdempotentPersistenceTransaction")).toBe(true);
    expect(functionCalls(retryHelper!, "withWorkspaceRls")).toBe(true);
    expect(functionCalls(retryHelper!, "publishAndWakeAgentCommand")).toBe(false);
    expect(functionCalls(retryHelper!, "publishWorkspaceControlEvent")).toBe(false);

    for (const commandName of ["sendAgentSessionMessage", "steerAgentSession"] as const) {
      const command = commandDefinitions.get(commandName);
      expect(command).toBeDefined();
      expect(functionCalls(command!, "runAgentCommandPersistenceTransaction")).toBe(true);
      const persistence = callPositions(command!, "runAgentCommandPersistenceTransaction")[0]!;
      const publishAndWake = callPositions(command!, "publishAndWakeAgentCommand")[0]!;
      const publishControl = callPositions(command!, "publishWorkspaceControlEvent")[0]!;
      expect(persistence).toBeLessThan(publishAndWake);
      expect(persistence).toBeLessThan(publishControl);
    }
  });
});
