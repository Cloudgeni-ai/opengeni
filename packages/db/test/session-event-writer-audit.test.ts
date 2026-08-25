import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as t from "oxc-parser";

type FunctionLikeDeclaration = t.Function | t.ArrowFunctionExpression;

type SourceFile = {
  program: t.Program;
  source: string;
};

type LockContract = "canonical" | "turn_attempt_fence" | "owned_suffix";

type ExpectedWriter = {
  inserts: number;
  contract: LockContract;
  requiresControlRevalidation?: boolean;
};

const repoRoot = resolve(import.meta.dir, "../../..");
const parentNodes = new WeakMap<t.Node, t.Node>();

function nodeStart(node: t.Node): number {
  return node.start;
}

function lineNumber(source: string, node: t.Node): number {
  return source.slice(0, nodeStart(node)).split("\n").length;
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function isArrowFunctionExpression(node: t.Node | undefined): node is t.ArrowFunctionExpression {
  return node?.type === "ArrowFunctionExpression";
}

function isCallExpression(node: t.Node | undefined): node is t.CallExpression {
  return node?.type === "CallExpression";
}

function isFunctionDeclaration(node: t.Node | undefined): node is t.Function {
  return node?.type === "FunctionDeclaration";
}

function isFunctionExpression(node: t.Node | undefined): node is t.Function {
  return node?.type === "FunctionExpression";
}

function isIdentifier(node: t.Node | undefined): node is Extract<t.Node, { type: "Identifier" }> {
  return node?.type === "Identifier";
}

function isMemberExpression(node: t.Node | undefined): node is t.MemberExpression {
  return node?.type === "MemberExpression";
}

function isObjectExpression(node: t.Node | undefined): node is t.ObjectExpression {
  return node?.type === "ObjectExpression";
}

function isObjectProperty(node: t.Node | undefined): node is t.ObjectProperty {
  return node?.type === "Property";
}

function isStringLiteral(node: t.Node | undefined): node is t.StringLiteral {
  return node?.type === "Literal" && typeof node.value === "string";
}

function isTaggedTemplateExpression(node: t.Node | undefined): node is t.TaggedTemplateExpression {
  return node?.type === "TaggedTemplateExpression";
}

function isVariableDeclarator(node: t.Node | undefined): node is t.VariableDeclarator {
  return node?.type === "VariableDeclarator";
}

function forEachChild(node: t.Node, visit: (child: t.Node) => void): void {
  const record = node as unknown as Record<string, unknown>;
  for (const key of t.visitorKeys[node.type] ?? []) {
    const value = record[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!isNode(child)) continue;
      parentNodes.set(child, node);
      visit(child);
    }
  }
}

function parseSourceFile(path: string, source: string): SourceFile {
  const result = t.parseSync(path, source, { sourceType: "unambiguous" });
  if (result.errors.length > 0) {
    throw new Error(
      `Could not parse ${path}: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return {
    source,
    program: result.program,
  };
}

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
  "packages/db/src/index.ts#armXaiCapacityWait": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#supersedeXaiCapacityWaitInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
  },
  "packages/db/src/index.ts#reconcileXaiCapacityWait": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#applyContextCompaction": {
    inserts: 1,
    contract: "turn_attempt_fence",
  },
  "packages/db/src/index.ts#recordStartedContextCompaction": {
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
  "packages/db/src/index.ts#upsertScheduledSessionGoalForRun": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#updateSessionGoalWithEvent": {
    inserts: 3,
    contract: "canonical",
  },
  "packages/db/src/index.ts#recordSessionGoalProgressWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#holdSessionGoalContinuationWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#rejectSessionGoalRevisionWithEvent": {
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
    inserts: 4,
    contract: "canonical",
  },
  "packages/db/src/index.ts#claimSessionWorkForAttempt": {
    inserts: 4,
    contract: "canonical",
  },
  "packages/db/src/index.ts#failSessionWorkBeforeAttemptClaim": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#commitSessionAttemptQuiescence": {
    inserts: 2,
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
    // pending event, producer-side supersession event, goal.resumed
    inserts: 3,
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
  "packages/db/src/index.ts#mutateAndAppendSessionEventsForTurnAttempt": {
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
  "packages/db/src/session-control.ts#cancelSessionSubtreeInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
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
  cancelSessionSubtreeInTransaction: ["mutateSessionControlInTransaction"],
  supersedeCodexCapacityWaitInTransaction: ["reconcileCodexCapacityWait"],
  supersedeXaiCapacityWaitInTransaction: ["reconcileXaiCapacityWait"],
  supersedeSessionCurrentDirectionInTransaction: [
    "steerAgentSessionInTransaction",
    "steerQueuedTurnInTransaction",
    "submitHumanPromptInTransaction",
  ],
  closePendingSessionToolCallsInTransaction: [
    "armCodexCapacityWait",
    "armXaiCapacityWait",
    "cancelSessionSubtreeInTransaction",
    "failSessionWorkBeforeAttemptClaim",
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
  // The one child -> parent outbox writer in index.ts; every notice kind
  // (terminal idle/failed, requires_action, resolved, capacity wait, progress)
  // routes through it under a caller-owned child-lifecycle prefix.
  "packages/db/src/index.ts#enqueueChildLifecycleNoticeOutboxTx": {
    inserts: 1,
    contract: "owned_child_lifecycle",
  },
  // The one control-plane child -> parent outbox writer (terminal cancel,
  // direct Pause, cancelled human-input resolutions).
  "packages/db/src/session-control.ts#insertChildOutboxRowInTransaction": {
    inserts: 1,
    contract: "owned_child_lifecycle",
  },
  "packages/db/src/index.ts#getOrCreateSessionSystemUpdateOutbox": {
    inserts: 1,
    contract: "canonical_pair",
  },
};

const expectedFailedChildOutboxCallers = [
  "applySessionTurnSettlement",
  "failSessionWorkBeforeAttemptClaim",
  "recoverSessionDispatch",
];
const expectedSharedFailedChildOutboxCallers = [
  "enqueueFailedChildOutboxForTurnTx",
  "enqueueFailedChildOutboxWithoutTurnTx",
];
const expectedCancelledChildOutboxCallers = ["cancelSessionSubtreeInTransaction"];

/**
 * Typed child-lifecycle notice wrappers over the one index.ts outbox writer,
 * and the lifecycle producers that call them. Every producer must take a
 * canonical lock (the child-lifecycle prefix, or the generic prefix with the
 * parent included in its UUID-ordered session set) before the first wrapper
 * call, so the parent row is always held when its outbox row is inserted.
 */
const expectedChildLifecycleNoticeWrappers = [
  "settleSessionIdleWithParentOutbox",
  "enqueueFailedChildOutboxTx",
  "enqueueChildRequiresActionOutboxTx",
  "enqueueChildRequiresActionResolvedOutboxTx",
  "enqueueChildWaitingCapacityOutboxTx",
  "enqueueChildProgressOutboxTx",
];
const expectedChildLifecycleNoticeProducers: Record<string, string[]> = {
  enqueueChildRequiresActionOutboxTx: ["applySessionTurnSettlement"],
  enqueueChildRequiresActionResolvedOutboxTx: [
    "acceptSessionApprovalDecision",
    "acceptSessionHumanInputResponse",
    "applySessionTurnSettlement",
    "failSessionWorkBeforeAttemptClaim",
  ],
  enqueueChildWaitingCapacityOutboxTx: ["armCodexCapacityWait", "armXaiCapacityWait"],
  enqueueChildProgressOutboxTx: ["recordSessionGoalProgressWithEvent"],
};
const expectedControlPlaneChildOutboxWrappers: Record<string, string[]> = {
  enqueueCancelledChildOutboxInTransaction: ["cancelSessionSubtreeInTransaction"],
  enqueueChildPausedOutboxInTransaction: ["mutateSessionControlInTransaction"],
  enqueueCancelledChildRequiresActionResolvedOutboxInTransaction: [
    "cancelSessionSubtreeInTransaction",
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
  node: t.Node,
): { name: string; node: FunctionLikeDeclaration } | null {
  let current: t.Node | undefined = node;
  let result: { name: string; node: FunctionLikeDeclaration } | null = null;
  while (current) {
    if (isFunctionDeclaration(current) && current.id) {
      result = { name: current.id.name, node: current };
    } else if (
      (isArrowFunctionExpression(current) || isFunctionExpression(current)) &&
      isVariableDeclarator(parentNodes.get(current))
    ) {
      const parent = parentNodes.get(current);
      if (isVariableDeclarator(parent) && isIdentifier(parent.id)) {
        result = { name: parent.id.name, node: current };
      }
    }
    current = parentNodes.get(current);
  }
  return result;
}

function callName(node: t.CallExpression): string | null {
  if (isIdentifier(node.callee)) return node.callee.name;
  if (isMemberExpression(node.callee) && isIdentifier(node.callee.property)) {
    return node.callee.property.name;
  }
  return null;
}

function insertsSessionEvents(node: t.CallExpression): boolean {
  if (!isMemberExpression(node.callee) || callName(node) !== "insert") {
    return false;
  }
  const table = node.arguments[0];
  return Boolean(
    table &&
    ((isMemberExpression(table) &&
      isIdentifier(table.property) &&
      table.property.name === "sessionEvents") ||
      (isIdentifier(table) && table.name === "sessionEvents")),
  );
}

function writesSessions(node: t.CallExpression): boolean {
  if (!isMemberExpression(node.callee)) return false;
  const method = callName(node);
  if (method !== "insert" && method !== "update") return false;
  const table = node.arguments[0];
  return Boolean(
    table &&
    ((isMemberExpression(table) &&
      isIdentifier(table.property) &&
      table.property.name === "sessions") ||
      (isIdentifier(table) && table.name === "sessions")),
  );
}

const tenancyQuiescenceTables = {
  sessions: "sessions",
  sessionTurns: "session_turns",
  sessionTurnAttempts: "session_turn_attempts",
  sessionAttemptInterruptions: "session_attempt_interruptions",
  sessionSystemUpdates: "session_system_updates",
  sessionHumanInputRequests: "session_human_input_requests",
  sessionPendingToolCalls: "session_pending_tool_calls",
  agentRunStates: "agent_run_states",
  sessionGoals: "session_goals",
  codexCapacityWaiters: "codex_capacity_waiters",
  xaiCapacityWaiters: "xai_capacity_waiters",
  sessionRealtimeModes: "session_realtime_modes",
  sessionRealtimeConnections: "session_realtime_connections",
  scheduledTasks: "scheduled_tasks",
  sandboxWorkspaceMutationAdmissions: "sandbox_workspace_mutation_admissions",
  sandboxRetainedProcesses: "sandbox_retained_processes",
  sandboxLeaseHolders: "sandbox_lease_holders",
} as const;

const tenancyCascadeRootTables = {
  managedAccounts: "managed_accounts",
  workspaces: "workspaces",
  sandboxLeases: "sandbox_leases",
} as const;

const expectedTenancyCascadeRootDeletes: Record<string, string[]> = {
  "packages/db/src/index.ts#deleteSessionTreeIfQuiescent": ["sandbox_leases"],
  "packages/db/src/index.ts#deleteWorkspace": ["workspaces"],
  "packages/db/src/index.ts#deleteWorkspaceIfQuiescent": ["workspaces"],
  "scripts/operator/turn-density-profile.ts#deleteDensityProfileAccount": ["managed_accounts"],
};

const expectedTenancyCascadeRootFenceCalls: Record<string, string> = {
  "packages/db/src/index.ts#deleteSessionTreeIfQuiescent": "withWorkspaceSubjectRls",
  "packages/db/src/index.ts#deleteWorkspaceIfQuiescent": "withRlsContext",
  "scripts/operator/turn-density-profile.ts#deleteDensityProfileAccount": "withWorkspaceRls",
};

function writesTenancyQuiescenceTable(node: t.CallExpression): boolean {
  if (!isMemberExpression(node.callee)) return false;
  const method = callName(node);
  if (method !== "insert" && method !== "update" && method !== "delete") return false;
  const table = node.arguments[0];
  return Boolean(
    table &&
    isMemberExpression(table) &&
    isIdentifier(table.property) &&
    table.property.name in tenancyQuiescenceTables,
  );
}

function deletedTenancyCascadeRoot(node: t.CallExpression): string | null {
  if (!isMemberExpression(node.callee) || callName(node) !== "delete") return null;
  const table = node.arguments[0];
  const tableName =
    table && isMemberExpression(table) && isIdentifier(table.property)
      ? table.property.name
      : table && isIdentifier(table)
        ? table.name
        : null;
  if (!tableName) return null;
  return tenancyCascadeRootTables[tableName as keyof typeof tenancyCascadeRootTables] ?? null;
}

function insertsSessionSystemUpdateOutbox(node: t.CallExpression): boolean {
  if (!isMemberExpression(node.callee) || callName(node) !== "insert") {
    return false;
  }
  const table = node.arguments[0];
  return Boolean(
    table &&
    ((isMemberExpression(table) &&
      isIdentifier(table.property) &&
      table.property.name === "sessionSystemUpdateOutbox") ||
      (isIdentifier(table) && table.name === "sessionSystemUpdateOutbox")),
  );
}

function functionCalls(functionNode: FunctionLikeDeclaration, expectedName: string): boolean {
  let found = false;
  const visit = (node: t.Node): void => {
    if (isCallExpression(node) && callName(node) === expectedName) found = true;
    if (!found) forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return found;
}

function callHasProperty(node: t.CallExpression, propertyName: string): boolean {
  return node.arguments.some(
    (argument) =>
      isObjectExpression(argument) &&
      argument.properties.some(
        (property) =>
          isObjectProperty(property) &&
          ((isIdentifier(property.key) && property.key.name === propertyName) ||
            (isStringLiteral(property.key) && property.key.value === propertyName)),
      ),
  );
}

function callPositionsWithStringProperty(
  functionNode: FunctionLikeDeclaration,
  expectedName: string,
  propertyName: string,
  propertyValue: string,
): number[] {
  const positions: number[] = [];
  const visit = (node: t.Node): void => {
    if (
      isCallExpression(node) &&
      callName(node) === expectedName &&
      node.arguments.some(
        (argument) =>
          isObjectExpression(argument) &&
          argument.properties.some(
            (property) =>
              isObjectProperty(property) &&
              ((isIdentifier(property.key) && property.key.name === propertyName) ||
                (isStringLiteral(property.key) && property.key.value === propertyName)) &&
              isStringLiteral(property.value) &&
              property.value.value === propertyValue,
          ),
      )
    ) {
      positions.push(nodeStart(node));
    }
    forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

function callPositionsWithStringArgument(
  functionNode: FunctionLikeDeclaration,
  expectedName: string,
  argumentIndex: number,
  argumentValue: string,
): number[] {
  const positions: number[] = [];
  const visit = (node: t.Node): void => {
    if (isCallExpression(node) && callName(node) === expectedName) {
      const argument = node.arguments[argumentIndex];
      if (argument !== undefined && isStringLiteral(argument) && argument.value === argumentValue) {
        positions.push(nodeStart(node));
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

function controlAwarePrefixPositions(functionNode: FunctionLikeDeclaration): number[] {
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
    // Send/Steer admission: shared prefix for an active branch, exclusive for a
    // paused one, decided inside the helper before any other lock.
    ...callPositions(functionNode, "lockWorkspaceInferenceControlForAdmission"),
    ...callPositions(functionNode, "lockChildLifecycleOutboxWriteRowsTx"),
  ].sort((left, right) => left - right);
}

function genericPrefixPositions(functionNode: FunctionLikeDeclaration): number[] {
  return callPositionsWithStringProperty(
    functionNode,
    "lockSessionEventWriteRows",
    "controlLock",
    "none",
  );
}

function callPositions(functionNode: FunctionLikeDeclaration, expectedName: string): number[] {
  const positions: number[] = [];
  const visit = (node: t.Node): void => {
    if (isCallExpression(node) && callName(node) === expectedName) {
      positions.push(nodeStart(node));
    }
    forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

function insertPositions(functionNode: FunctionLikeDeclaration): number[] {
  const positions: number[] = [];
  const visit = (node: t.Node): void => {
    if (isCallExpression(node) && insertsSessionEvents(node)) {
      positions.push(nodeStart(node));
    }
    forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

describe("session_events writer inventory", () => {
  test("pins all 17 tenancy-quiescence mutation surfaces behind workspace RLS entry", () => {
    const discovered = new Set<string>();
    const writers = new Set<string>();
    const sqlTables = Object.values(tenancyQuiescenceTables).join("|");
    const rawMutation = new RegExp(
      `\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:[a-z_]+\\.)?(?:${sqlTables})\\b`,
      "i",
    );
    for (const path of productionTypeScriptFiles()) {
      const source = readFileSync(path, "utf8");
      if (
        !Object.keys(tenancyQuiescenceTables).some((name) => source.includes(name)) &&
        !Object.values(tenancyQuiescenceTables).some((name) => source.includes(name))
      )
        continue;
      const file = relative(repoRoot, path).replaceAll("\\", "/");
      const sourceFile = parseSourceFile(path, source);
      const recordWriter = (node: t.Node, table: string): void => {
        discovered.add(table);
        const enclosing = namedTopLevelFunction(node);
        writers.add(
          enclosing ? `${file}#${enclosing.name}` : `${file}:${lineNumber(source, node)}`,
        );
      };
      const visit = (node: t.Node): void => {
        if (isCallExpression(node) && writesTenancyQuiescenceTable(node)) {
          const table = node.arguments[0];
          if (table && isMemberExpression(table) && isIdentifier(table.property)) {
            recordWriter(
              node,
              tenancyQuiescenceTables[table.property.name as keyof typeof tenancyQuiescenceTables],
            );
          }
        }
        if (isTaggedTemplateExpression(node)) {
          const sqlText = source.slice(nodeStart(node.quasi), node.quasi.end);
          if (rawMutation.test(sqlText)) {
            for (const table of Object.values(tenancyQuiescenceTables)) {
              if (new RegExp(`\\b${table}\\b`, "i").test(sqlText)) recordWriter(node, table);
            }
          }
        }
        forEachChild(node, visit);
      };
      visit(sourceFile.program);
    }
    expect([...discovered].sort()).toEqual([...Object.values(tenancyQuiescenceTables)].sort());
    expect(writers.size).toBeGreaterThanOrEqual(61);
    const database = readFileSync(join(repoRoot, "packages/db/src/database.ts"), "utf8");
    expect(database).toMatch(
      /withRlsContext[\s\S]*?setRlsContext[\s\S]*?pg_advisory_xact_lock_shared[\s\S]*?const value = await fn/u,
    );
    const migration = readFileSync(
      join(repoRoot, "packages/db/drizzle/0345_tenant_scoped_session_tenancy_fence.sql"),
      "utf8",
    );
    const declaration = migration.slice(
      migration.indexOf("hot_tables constant text[]"),
      migration.indexOf("];", migration.indexOf("hot_tables constant text[]")),
    );
    const guardedTables = [...declaration.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
    expect(guardedTables.sort()).toEqual([...Object.values(tenancyQuiescenceTables)].sort());
    expect(migration).toMatch(
      /BEFORE INSERT OR UPDATE OR DELETE[\s\S]*?require_session_tenancy_fence/u,
    );
    expect(migration).toContain("session tenancy mutation requires the workspace fence");
  });

  test("pins every production TypeScript delete of a session-tenancy cascade root", () => {
    const writers = new Map<
      string,
      {
        roots: Set<string>;
        sourceFile: SourceFile;
        functionNode: FunctionLikeDeclaration;
      }
    >();
    for (const path of productionTypeScriptFiles()) {
      const source = readFileSync(path, "utf8");
      if (
        !Object.keys(tenancyCascadeRootTables).some((table) => source.includes(table)) &&
        !Object.values(tenancyCascadeRootTables).some((table) => source.includes(table))
      )
        continue;
      const file = relative(repoRoot, path).replaceAll("\\", "/");
      const sourceFile = parseSourceFile(path, source);
      const recordDelete = (node: t.Node, root: string): void => {
        const enclosing = namedTopLevelFunction(node);
        if (!enclosing) throw new Error(`Unnamed ${root} delete in ${file}`);
        const key = `${file}#${enclosing.name}`;
        const writer = writers.get(key) ?? {
          roots: new Set<string>(),
          sourceFile,
          functionNode: enclosing.node,
        };
        writer.roots.add(root);
        writers.set(key, writer);
      };
      const visit = (node: t.Node): void => {
        if (isCallExpression(node)) {
          const root = deletedTenancyCascadeRoot(node);
          if (root) recordDelete(node, root);
        }
        if (isTaggedTemplateExpression(node)) {
          const sqlText = source.slice(nodeStart(node.quasi), node.quasi.end);
          for (const root of Object.values(tenancyCascadeRootTables)) {
            if (new RegExp(`\\bdelete\\s+from\\s+(?:[a-z_]+\\.)?${root}\\b`, "i").test(sqlText)) {
              recordDelete(node, root);
            }
          }
        }
        forEachChild(node, visit);
      };
      visit(sourceFile.program);
    }

    expect(
      Object.fromEntries(
        [...writers]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, writer]) => [key, [...writer.roots].sort()]),
      ),
    ).toEqual(expectedTenancyCascadeRootDeletes);

    for (const [key, fenceCall] of Object.entries(expectedTenancyCascadeRootFenceCalls)) {
      const writer = writers.get(key)!;
      const firstFence = callPositions(writer.functionNode, fenceCall)[0];
      const deletes = callPositions(writer.functionNode, "delete");
      expect(firstFence, key).toBeLessThan(Math.min(...deletes));
    }
    const directWorkspaceDelete = writers.get("packages/db/src/index.ts#deleteWorkspace")!;
    const directSource = directWorkspaceDelete.sourceFile.source.slice(
      directWorkspaceDelete.functionNode.start,
      directWorkspaceDelete.functionNode.end,
    );
    expect(directSource.indexOf("pg_advisory_xact_lock_shared"), "deleteWorkspace").toBeLessThan(
      directSource.indexOf(".delete(schema.workspaces)"),
    );
  });

  test("every production session-row writer requires the explicit activity gate", () => {
    const violations: string[] = [];
    const gateWrappers = [
      "withSessionActivityRlsContext",
      "withRestoredSessionActivityRlsContext",
      "withWorkspaceSessionActivityRls",
      "withWorkspaceSubjectSessionActivityRls",
      "retrySessionActivityRls",
      "withWorkspaceSessionEventActivityRls",
      "retryWorkspaceSessionEventActivityPersistence",
    ];

    for (const path of productionTypeScriptFiles()) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("sessions")) continue;
      const file = relative(repoRoot, path).replaceAll("\\", "/");
      const sourceFile = parseSourceFile(path, source);
      const checked = new Set<string>();
      const checkWriter = (node: t.Node): void => {
        let ancestor = parentNodes.get(node);
        while (ancestor) {
          if (isCallExpression(ancestor) && gateWrappers.includes(callName(ancestor) ?? "")) {
            return;
          }
          ancestor = parentNodes.get(ancestor);
        }
        const enclosing = namedTopLevelFunction(node);
        if (!enclosing) {
          violations.push(`${file}:${lineNumber(source, node)} unnamed session writer`);
          return;
        }
        const key = `${file}#${enclosing.name}`;
        if (checked.has(key)) return;
        checked.add(key);
        const body = enclosing.node.body;
        if (!body) {
          violations.push(`${key} has no function body`);
          return;
        }
        const signature = source.slice(enclosing.node.start, body.start);
        if (!/\bSessionActivityDatabase\b/.test(signature)) {
          violations.push(`${key} has no activity-gated handle or wrapper`);
        }
      };
      const visit = (node: t.Node): void => {
        if (isCallExpression(node) && writesSessions(node)) checkWriter(node);
        if (isTaggedTemplateExpression(node)) {
          const sqlText = source.slice(nodeStart(node.quasi), node.quasi.end);
          if (/\b(?:insert\s+into|update)\s+(?:[a-z_]+\.)?sessions\b/i.test(sqlText)) {
            checkWriter(node);
          }
        }
        forEachChild(node, visit);
      };
      visit(sourceFile.program);
    }

    expect(violations).toEqual([]);
  });

  test("session activity gate GUCs have one application owner", () => {
    const violations = productionTypeScriptFiles()
      .filter(
        (path) => relative(repoRoot, path).replaceAll("\\", "/") !== "packages/db/src/database.ts",
      )
      .filter((path) => readFileSync(path, "utf8").includes("opengeni.session_activity_gate_"))
      .map((path) => relative(repoRoot, path).replaceAll("\\", "/"));
    expect(violations).toEqual([]);
  });

  test("session activity gate branding has one trusted runtime owner", () => {
    const violations = productionTypeScriptFiles()
      .filter(
        (path) => relative(repoRoot, path).replaceAll("\\", "/") !== "packages/db/src/database.ts",
      )
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return /as\s+(?:unknown\s+as\s+)?SessionActivityDatabase\b/.test(source);
      })
      .map((path) => relative(repoRoot, path).replaceAll("\\", "/"));
    expect(violations).toEqual([]);
  });

  test("session discovery keeps created-order clocks outside repeatable-read fencing", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/index.ts"), "utf8");
    const start = source.indexOf("export async function listSessionDiscoverySummaries");
    const end = source.indexOf("export type SessionDiscoveryAncestor", start);
    const discovery = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(discovery).toContain("transaction_timestamp()");
    expect(discovery).not.toContain("statement_timestamp()");
    expect(discovery).toContain('orderBy === "updatedAt"');
    expect(discovery).toContain('isolationLevel: "repeatable read"');
    expect(discovery).toContain('isolationLevel: "read committed"');
  });

  test("every production insert has an explicit canonical or caller-owned lock contract", () => {
    const writers = new Map<
      string,
      { count: number; sourceFile: SourceFile; functionNode: FunctionLikeDeclaration }
    >();
    const rawSqlWriters: string[] = [];
    const implicitControlLockCalls: string[] = [];
    const functionDefinitions = new Map<
      string,
      Array<{ sourceFile: SourceFile; functionNode: FunctionLikeDeclaration }>
    >();
    const ownedSuffixCallers = new Map<string, Set<string>>(
      Object.keys(expectedOwnedSuffixCallers).map((name) => [name, new Set()]),
    );
    const outboxWriters = new Map<
      string,
      { count: number; sourceFile: SourceFile; functionNode: FunctionLikeDeclaration }
    >();
    const failedChildOutboxCallers = new Set<string>();
    const sharedFailedChildOutboxCallers = new Set<string>();
    const cancelledChildOutboxCallers = new Set<string>();

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
      const sourceFile = parseSourceFile(path, source);
      const visit = (node: t.Node): void => {
        if (isFunctionDeclaration(node) && node.id) {
          const definitions = functionDefinitions.get(node.id.name) ?? [];
          definitions.push({ sourceFile, functionNode: node });
          functionDefinitions.set(node.id.name, definitions);
        }
        if (isCallExpression(node)) {
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
            implicitControlLockCalls.push(`${file}:${lineNumber(sourceFile.source, node)}`);
          }
          if (called && ownedSuffixCallers.has(called) && enclosing) {
            ownedSuffixCallers.get(called)!.add(enclosing.name);
          }
          if (
            (called === "enqueueFailedChildOutboxForTurnTx" ||
              called === "enqueueFailedChildOutboxWithoutTurnTx") &&
            enclosing
          ) {
            failedChildOutboxCallers.add(enclosing.name);
          }
          if (called === "enqueueFailedChildOutboxTx" && enclosing) {
            sharedFailedChildOutboxCallers.add(enclosing.name);
          }
          if (called === "enqueueCancelledChildOutboxInTransaction" && enclosing) {
            cancelledChildOutboxCallers.add(enclosing.name);
          }
        }
        if (isTaggedTemplateExpression(node)) {
          const sqlText = sourceFile.source.slice(nodeStart(node.quasi), node.quasi.end);
          if (/\binsert\s+into\s+(?:[a-z_]+\.)?session_events\b/i.test(sqlText)) {
            rawSqlWriters.push(`${file}:${lineNumber(sourceFile.source, node)}`);
          }
        }
        forEachChild(node, visit);
      };
      visit(sourceFile.program);
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
    expect([...sharedFailedChildOutboxCallers].sort()).toEqual(
      [...expectedSharedFailedChildOutboxCallers].sort(),
    );
    expect([...cancelledChildOutboxCallers].sort()).toEqual(
      [...expectedCancelledChildOutboxCallers].sort(),
    );
    for (const [key, expected] of Object.entries(expectedOutboxWriters)) {
      const writer = outboxWriters.get(key)!;
      if (expected.contract === "child_lifecycle") {
        expect(functionCalls(writer.functionNode, "lockChildLifecycleOutboxWriteRowsTx")).toBe(
          true,
        );
        expect(functionCalls(writer.functionNode, "retrySessionActivityRls")).toBe(true);
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
      expect(functionCalls(callerNode, "retrySessionActivityRls")).toBe(true);
      const firstLock = callPositions(callerNode, "lockChildLifecycleOutboxWriteRowsTx")[0];
      const enqueue = Math.min(
        ...callPositions(callerNode, "enqueueFailedChildOutboxForTurnTx"),
        ...callPositions(callerNode, "enqueueFailedChildOutboxWithoutTurnTx"),
      );
      expect(Number.isFinite(enqueue)).toBe(true);
      expect(firstLock).toBeLessThan(enqueue);
    }
    for (const caller of expectedSharedFailedChildOutboxCallers) {
      const definitions = functionDefinitions.get(caller) ?? [];
      expect(definitions).toHaveLength(1);
      expect(
        callPositions(definitions[0]!.functionNode, "enqueueFailedChildOutboxTx"),
      ).toHaveLength(1);
    }
    for (const caller of expectedCancelledChildOutboxCallers) {
      const definitions = functionDefinitions.get(caller) ?? [];
      expect(definitions).toHaveLength(1);
      const callerNode = definitions[0]!.functionNode;
      expect(functionCalls(callerNode, "lockSessionEventWriteRows")).toBe(true);
      const firstLock = callPositions(callerNode, "lockSessionEventWriteRows")[0];
      const enqueue = callPositions(callerNode, "enqueueCancelledChildOutboxInTransaction")[0];
      expect(firstLock).toBeLessThan(enqueue!);
    }

    // Child-lifecycle notices: every typed wrapper routes through the one
    // index.ts outbox writer exactly once, and every lifecycle producer takes
    // a canonical lock before its first wrapper call (the parent session row
    // joins that lock set, so the outbox insert never runs without it).
    const noticeWriterCallers = new Map<string, Set<string>>();
    for (const [name, definitions] of functionDefinitions) {
      const definition = definitions[0];
      if (!definition) continue;
      for (const writer of [
        "enqueueChildLifecycleNoticeOutboxTx",
        "insertChildOutboxRowInTransaction",
      ]) {
        if (name === writer) continue;
        if (callPositions(definition.functionNode, writer).length > 0) {
          const callers = noticeWriterCallers.get(writer) ?? new Set<string>();
          callers.add(name);
          noticeWriterCallers.set(writer, callers);
        }
      }
    }
    expect(
      [...(noticeWriterCallers.get("enqueueChildLifecycleNoticeOutboxTx") ?? [])].sort(),
    ).toEqual([...expectedChildLifecycleNoticeWrappers].sort());
    expect(
      [...(noticeWriterCallers.get("insertChildOutboxRowInTransaction") ?? [])].sort(),
    ).toEqual(Object.keys(expectedControlPlaneChildOutboxWrappers).sort());
    for (const wrapper of expectedChildLifecycleNoticeWrappers) {
      const definitions = functionDefinitions.get(wrapper) ?? [];
      expect(definitions).toHaveLength(1);
      expect(
        callPositions(definitions[0]!.functionNode, "enqueueChildLifecycleNoticeOutboxTx"),
      ).toHaveLength(1);
    }
    for (const [wrapper, expectedProducers] of Object.entries(
      expectedChildLifecycleNoticeProducers,
    )) {
      const producers = [...functionDefinitions]
        .filter(
          ([name, definitions]) =>
            name !== wrapper &&
            definitions.some(
              (definition) => callPositions(definition.functionNode, wrapper).length > 0,
            ),
        )
        .map(([name]) => name)
        .sort();
      expect(producers).toEqual([...expectedProducers].sort());
      for (const producer of producers) {
        const definitions = functionDefinitions.get(producer) ?? [];
        expect(definitions).toHaveLength(1);
        const producerNode = definitions[0]!.functionNode;
        const canonicalLocks = [
          ...callPositions(producerNode, "lockSessionEventWriteRows"),
          ...callPositions(producerNode, "lockChildLifecycleOutboxWriteRowsTx"),
        ].sort((left, right) => left - right);
        expect(canonicalLocks.length).toBeGreaterThan(0);
        expect(canonicalLocks[0]).toBeLessThan(Math.min(...callPositions(producerNode, wrapper)));
      }
    }
    for (const [wrapper, expectedProducers] of Object.entries(
      expectedControlPlaneChildOutboxWrappers,
    )) {
      const producers = [...functionDefinitions]
        .filter(
          ([name, definitions]) =>
            name !== wrapper &&
            definitions.some(
              (definition) => callPositions(definition.functionNode, wrapper).length > 0,
            ),
        )
        .map(([name]) => name)
        .sort();
      expect(producers).toEqual([...expectedProducers].sort());
      for (const producer of producers) {
        const producerNode = functionDefinitions.get(producer)![0]!.functionNode;
        const firstLock = callPositions(producerNode, "lockSessionEventWriteRows")[0];
        expect(firstLock).toBeLessThan(Math.min(...callPositions(producerNode, wrapper)));
      }
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

  test("generic append and session commands keep external effects outside bounded retry", () => {
    const definitionsFor = (relativePath: string) => {
      const path = join(repoRoot, relativePath);
      const sourceFile = parseSourceFile(path, readFileSync(path, "utf8"));
      const definitions = new Map<string, t.Function>();
      const visit = (node: t.Node): void => {
        if (isFunctionDeclaration(node) && node.id) {
          definitions.set(node.id.name, node);
        }
        forEachChild(node, visit);
      };
      visit(sourceFile.program);
      return definitions;
    };

    const dbDefinitions = definitionsFor("packages/db/src/index.ts");
    const genericAppend = dbDefinitions.get("appendSessionEvents");
    expect(genericAppend).toBeDefined();
    expect(functionCalls(genericAppend!, "retryWorkspaceSessionEventActivityPersistence")).toBe(
      true,
    );
    expect(
      callPositions(genericAppend!, "retryWorkspaceSessionEventActivityPersistence")[0],
    ).toBeLessThan(insertPositions(genericAppend!)[0]!);

    const commandDefinitions = definitionsFor("packages/core/src/application/session-commands.ts");
    const retryHelper = commandDefinitions.get("runSessionCommandPersistenceTransaction");
    expect(retryHelper).toBeDefined();
    expect(functionCalls(retryHelper!, "runIdempotentPersistenceTransaction")).toBe(true);
    expect(functionCalls(retryHelper!, "withWorkspaceSessionActivityRls")).toBe(true);
    expect(functionCalls(retryHelper!, "withWorkspaceSubjectSessionActivityRls")).toBe(true);
    expect(functionCalls(retryHelper!, "publishAndWakeAgentCommand")).toBe(false);
    expect(functionCalls(retryHelper!, "publishWorkspaceControlEvent")).toBe(false);
    expect(functionCalls(retryHelper!, "publishSessionEventIds")).toBe(false);
    expect(functionCalls(retryHelper!, "requestControlWakeDispatch")).toBe(false);

    for (const commandName of [
      "sendAgentSessionMessage",
      "steerAgentSession",
      "controlAgentSessionWorkstream",
      "moveHumanQueuePrompt",
      "deleteHumanQueuePrompt",
      "editHumanQueuePrompt",
      "steerHumanQueuePrompt",
      "controlHumanSessionWorkstreamWithOutcome",
    ] as const) {
      const command = commandDefinitions.get(commandName);
      expect(command).toBeDefined();
      expect(functionCalls(command!, "runSessionCommandPersistenceTransaction")).toBe(true);
      const persistence = callPositions(command!, "runSessionCommandPersistenceTransaction")[0]!;
      for (const externalEffect of [
        "publishAndWakeAgentCommand",
        "publishWorkspaceControlEvent",
        "publishSessionEventIds",
        "requestControlWakeDispatch",
      ]) {
        for (const effect of callPositions(command!, externalEffect)) {
          expect(persistence).toBeLessThan(effect);
        }
      }
    }
  });
});
