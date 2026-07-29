import { describe, expect, test } from "bun:test";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
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
    inserts: 3,
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
  "packages/db/src/session-realtime.ts#appendRealtimeLifecycleEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-realtime-ledger.ts#admitRealtimeDelegationInTransaction": {
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

type FunctionNode = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;

function parseTypeScript(fileName: string, source: string): t.File {
  return parse(source, {
    sourceFilename: fileName,
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
  });
}

function visitNode(
  node: t.Node,
  visitor: (node: t.Node) => void,
  parentByNode?: WeakMap<t.Node, t.Node>,
): void {
  visitor(node);
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (!entry || typeof entry !== "object" || !("type" in entry)) continue;
        const childNode = entry as t.Node;
        parentByNode?.set(childNode, node);
        visitNode(childNode, visitor, parentByNode);
      }
    } else if (child && typeof child === "object" && "type" in child) {
      const childNode = child as t.Node;
      parentByNode?.set(childNode, node);
      visitNode(childNode, visitor, parentByNode);
    }
  }
}

function nodeStart(node: t.Node): number {
  return node.start ?? 0;
}

function nodeLine(node: t.Node): number {
  return node.loc?.start.line ?? 1;
}

function namedTopLevelFunction(
  node: t.Node,
  parentByNode: WeakMap<t.Node, t.Node>,
): { name: string; node: FunctionNode } | null {
  let current: t.Node | undefined = node;
  let result: { name: string; node: FunctionNode } | null = null;
  while (current) {
    if (t.isFunctionDeclaration(current) && t.isIdentifier(current.id)) {
      result = { name: current.id.name, node: current };
    } else if (
      (t.isArrowFunctionExpression(current) || t.isFunctionExpression(current)) &&
      t.isVariableDeclarator(parentByNode.get(current)) &&
      t.isIdentifier(
        parentByNode.get(current)?.type === "VariableDeclarator"
          ? (parentByNode.get(current) as t.VariableDeclarator).id
          : null,
      )
    ) {
      result = {
        name: ((parentByNode.get(current) as t.VariableDeclarator).id as t.Identifier).name,
        node: current,
      };
    }
    current = parentByNode.get(current);
  }
  return result;
}

function callName(node: t.CallExpression): string | null {
  if (t.isIdentifier(node.callee)) return node.callee.name;
  if (t.isMemberExpression(node.callee) && !node.callee.computed) {
    return t.isIdentifier(node.callee.property) ? node.callee.property.name : null;
  }
  return null;
}

function insertsTable(node: t.CallExpression, tableName: string): boolean {
  if (
    !t.isMemberExpression(node.callee) ||
    node.callee.computed ||
    !t.isIdentifier(node.callee.property, { name: "insert" })
  ) {
    return false;
  }
  const table = node.arguments[0];
  return Boolean(
    table &&
    !t.isSpreadElement(table) &&
    !t.isJSXNamespacedName(table) &&
    ((t.isMemberExpression(table) &&
      !table.computed &&
      t.isIdentifier(table.property, { name: tableName })) ||
      t.isIdentifier(table, { name: tableName })),
  );
}

function insertsSessionEvents(node: t.CallExpression): boolean {
  return insertsTable(node, "sessionEvents");
}

function insertsSessionSystemUpdateOutbox(node: t.CallExpression): boolean {
  return insertsTable(node, "sessionSystemUpdateOutbox");
}

function functionCalls(functionNode: FunctionNode, expectedName: string): boolean {
  let found = false;
  visitNode(functionNode, (node) => {
    if (!found && t.isCallExpression(node) && callName(node) === expectedName) found = true;
  });
  return found;
}

function objectPropertyName(property: t.ObjectProperty | t.ObjectMethod): string | null {
  if (property.computed) return null;
  if (t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

function callHasProperty(node: t.CallExpression, propertyName: string): boolean {
  return node.arguments.some(
    (argument) =>
      t.isObjectExpression(argument) &&
      argument.properties.some((property) =>
        t.isObjectProperty(property) ? objectPropertyName(property) === propertyName : false,
      ),
  );
}

function callPositionsWithStringProperty(
  functionNode: FunctionNode,
  expectedName: string,
  propertyName: string,
  propertyValue: string,
): number[] {
  const positions: number[] = [];
  visitNode(functionNode, (node) => {
    if (
      t.isCallExpression(node) &&
      callName(node) === expectedName &&
      node.arguments.some(
        (argument) =>
          t.isObjectExpression(argument) &&
          argument.properties.some(
            (property) =>
              t.isObjectProperty(property) &&
              objectPropertyName(property) === propertyName &&
              t.isStringLiteral(property.value, { value: propertyValue }),
          ),
      )
    ) {
      positions.push(nodeStart(node));
    }
  });
  return positions.sort((left, right) => left - right);
}

function callPositionsWithStringArgument(
  functionNode: FunctionNode,
  expectedName: string,
  argumentIndex: number,
  argumentValue: string,
): number[] {
  const positions: number[] = [];
  visitNode(functionNode, (node) => {
    if (t.isCallExpression(node) && callName(node) === expectedName) {
      const argument = node.arguments[argumentIndex];
      if (argument !== undefined && t.isStringLiteral(argument, { value: argumentValue })) {
        positions.push(nodeStart(node));
      }
    }
  });
  return positions.sort((left, right) => left - right);
}

function controlAwarePrefixPositions(functionNode: FunctionNode): number[] {
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

function genericPrefixPositions(functionNode: FunctionNode): number[] {
  return callPositionsWithStringProperty(
    functionNode,
    "lockSessionEventWriteRows",
    "controlLock",
    "none",
  );
}

function callPositions(functionNode: FunctionNode, expectedName: string): number[] {
  const positions: number[] = [];
  visitNode(functionNode, (node) => {
    if (t.isCallExpression(node) && callName(node) === expectedName) {
      positions.push(nodeStart(node));
    }
  });
  return positions.sort((left, right) => left - right);
}

function insertPositions(functionNode: FunctionNode): number[] {
  const positions: number[] = [];
  visitNode(functionNode, (node) => {
    if (t.isCallExpression(node) && insertsSessionEvents(node)) {
      positions.push(nodeStart(node));
    }
  });
  return positions.sort((left, right) => left - right);
}

describe("session_events writer inventory", () => {
  test("every production insert has an explicit canonical or caller-owned lock contract", () => {
    const writers = new Map<
      string,
      { count: number; sourceFile: t.File; functionNode: FunctionNode }
    >();
    const rawSqlWriters: string[] = [];
    const implicitControlLockCalls: string[] = [];
    const functionDefinitions = new Map<
      string,
      Array<{ sourceFile: t.File; functionNode: FunctionNode }>
    >();
    const ownedSuffixCallers = new Map<string, Set<string>>(
      Object.keys(expectedOwnedSuffixCallers).map((name) => [name, new Set()]),
    );
    const outboxWriters = new Map<
      string,
      { count: number; sourceFile: t.File; functionNode: FunctionNode }
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
      const sourceFile = parseTypeScript(path, source);
      const parentByNode = new WeakMap<t.Node, t.Node>();
      visitNode(
        sourceFile,
        (node) => {
          if (t.isFunctionDeclaration(node) && t.isIdentifier(node.id)) {
            const definitions = functionDefinitions.get(node.id.name) ?? [];
            definitions.push({ sourceFile, functionNode: node });
            functionDefinitions.set(node.id.name, definitions);
          }
          if (t.isCallExpression(node)) {
            const enclosing = namedTopLevelFunction(node, parentByNode);
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
          if (t.isTaggedTemplateExpression(node)) {
            const sqlText = node.quasi.quasis.map((quasi) => quasi.value.raw).join("");
            if (/\binsert\s+into\s+(?:[a-z_]+\.)?session_events\b/i.test(sqlText)) {
              rawSqlWriters.push(`${file}:${nodeLine(node)}`);
            }
          }
        },
        parentByNode,
      );
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
      const sourceFile = parseTypeScript(path, readFileSync(path, "utf8"));
      const definitions = new Map<string, t.FunctionDeclaration>();
      visitNode(sourceFile, (node) => {
        if (t.isFunctionDeclaration(node) && t.isIdentifier(node.id)) {
          definitions.set(node.id.name, node);
        }
      });
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
