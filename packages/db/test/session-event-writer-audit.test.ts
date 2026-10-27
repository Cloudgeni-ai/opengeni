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
  "packages/db/src/unstarted-queue-retirement.ts#retireUnstartedSessionQueue": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/empty-session-queue.ts#repairEmptyQueuedSessionProjection": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/archived-session-imports.ts#appendTimeline": {
    inserts: 1,
    contract: "owned_suffix",
  },
  // Provider-neutral account choice uses the same preference-write lock contract.
  "packages/db/src/subscription-core/session-choice.ts#chooseOnce": {
    inserts: 1,
    contract: "canonical",
  },
  // The shared-core waiter (M3 PR 2a; any provider since SuperGrok X1b)
  // mirrors the legacy Codex arm, reconcile and supersession lock contracts
  // exactly.
  "packages/db/src/index.ts#armSubscriptionCoreCapacityWait": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#supersedeSubscriptionCoreCodexCapacityWaitInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
  },
  "packages/db/src/index.ts#reconcileSubscriptionCoreCapacityWait": {
    inserts: 2,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#reconcileCompletedSandboxSetup": {
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
  "packages/db/src/index.ts#updateSessionTitleWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#recordSessionGoalProgressWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#waitForSessionInputWithEvent": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#settleSessionInputWaitInActivity": {
    inserts: 2,
    contract: "canonical",
  },
  "packages/db/src/index.ts#backgroundCommandTerminalMutation": {
    inserts: 3,
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
    inserts: 6,
    contract: "canonical",
  },
  "packages/db/src/index.ts#claimSessionWorkForAttempt": {
    inserts: 5,
    contract: "canonical",
  },
  "packages/db/src/index.ts#failScheduledGeneratedSessionRoute": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#settleSessionWorkBeforeAttemptClaim": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#recordRetiredChildNotice": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#recoverSessionWorkFailedBeforeAttemptClaim": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#recordSessionAttemptQuiescenceInTransaction": {
    inserts: 1,
    contract: "owned_suffix",
  },
  "packages/db/src/index.ts#projectPausedRecovery": {
    inserts: 1,
    contract: "owned_suffix",
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
  "packages/db/src/index.ts#requestSessionTurnRecovery": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#blockSessionWorkBeforeAttemptClaim": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#recoverSessionOwner": {
    inserts: 3,
    contract: "canonical",
    requiresControlRevalidation: true,
  },
  "packages/db/src/index.ts#addSessionSystemUpdateWithSourceMutation": {
    // pending event, producer-side supersession event, consumed-on-arrival
    // cancellation, goal.resumed
    inserts: 4,
    contract: "canonical",
  },
  "packages/db/src/index.ts#appendSessionEvents": { inserts: 1, contract: "canonical" },
  "packages/db/src/index.ts#acceptSessionApprovalDecision": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#acceptSessionHumanInputResponse": {
    inserts: 2,
    contract: "canonical",
  },
  // Opengeni's own secret approval card: the answer event, appended in the
  // decision update's source mutation.
  "packages/db/src/index.ts#acceptSecretUseApprovalCardResponse": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/index.ts#persist": {
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
  "packages/db/src/session-command-output.ts#appendSessionCommandOutput": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-control.ts#mutateSessionControlInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-model-settings.ts#setSessionModelInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  "packages/db/src/session-retry.ts#retryFailedSessionInTransaction": {
    inserts: 1,
    contract: "canonical",
  },
  // A person's or host's change to a root's usage limit records
  // session.usage_limit.updated under the canonical control-share locks.
  "packages/db/src/session-usage-limits.ts#setSessionUsageLimitInTransaction": {
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
  // A Steer that waited for the next model step replaces an ownerless wait
  // (approval, question or capacity) right after the worker settles it.
  "packages/db/src/session-queue-commands.ts#resolveWaitingSteerInTransaction": {
    inserts: 1,
    contract: "canonical",
    requiresControlRevalidation: true,
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
  // The visibility settlement's local append helper; its enclosing settlement
  // takes the canonical event-write locks before any call.
  "packages/db/src/session-visibility-work.ts#insertEvents": {
    inserts: 1,
    contract: "owned_suffix",
  },
};

const genericControlWriters = new Set([
  // Preference changes do not admit inference; waiter reconciliation rechecks Pause.
  "packages/db/src/subscription-core/session-choice.ts#chooseOnce",
  "packages/db/src/index.ts#acceptSessionApprovalDecision",
  "packages/db/src/index.ts#acceptSessionHumanInputResponse",
  "packages/db/src/index.ts#appendSessionEvents",
  "packages/db/src/index.ts#appendSessionEventsAndUpdateSession",
  "packages/db/src/index.ts#appendSessionEventToSandboxGroup",
  "packages/db/src/index.ts#updateSessionTitleWithEvent",
]);

const callerOwnedControlWriters = new Set([
  "packages/db/src/session-queue-commands.ts#supersedeSessionCurrentDirectionInTransaction",
]);

const expectedOwnedSuffixCallers: Record<string, string[]> = {
  appendTimeline: ["importArchivedSession", "appendArchivedSessionEvents"],
  cancelSessionSubtreeInTransaction: ["mutateSessionControlInTransaction"],
  supersedeSubscriptionCoreCodexCapacityWaitInTransaction: [
    "reconcileSubscriptionCoreCapacityWait",
  ],
  projectPausedRecovery: ["commitSessionAttemptQuiescence"],
  recordSessionAttemptQuiescenceInTransaction: [
    "commitSessionAttemptQuiescence",
    "recoverSessionOwner",
  ],
  supersedeSessionCurrentDirectionInTransaction: [
    "resolveWaitingSteerInTransaction",
    "steerAgentSessionInTransaction",
    "steerQueuedTurnInTransaction",
    "submitHumanPromptInTransaction",
  ],
  insertEvents: ["settleSessionVisibilityWorkInTransaction"],
  closePendingSessionToolCallsInTransaction: [
    "armSubscriptionCoreCapacityWait",
    "cancelSessionSubtreeInTransaction",
    "settleSessionWorkBeforeAttemptClaim",
    "supersedeSessionCurrentDirectionInTransaction",
    "settleSessionAttemptInterruptions",
    "applySessionTurnSettlement",
    "requestSessionTurnRecovery",
    "recoverSessionOwner",
    "settleSessionVisibilityWorkInTransaction",
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
  // arm owns the canonical child-lifecycle prefix (including parent session)
  // before atomically emitting a false-capacity-recovery terminal boundary.
  "armSubscriptionCoreCapacityWait",
  "settleSessionWorkBeforeAttemptClaim",
  "recoverSessionOwner",
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
    "settleSessionWorkBeforeAttemptClaim",
  ],
  enqueueChildWaitingCapacityOutboxTx: ["armSubscriptionCoreCapacityWait"],
  enqueueChildProgressOutboxTx: ["recordSessionGoalProgressWithEvent"],
};
const expectedControlPlaneChildOutboxWrappers: Record<string, string[]> = {
  enqueueCancelledChildOutboxInTransaction: ["cancelSessionSubtreeInTransaction"],
  enqueueChildPausedOutboxInTransaction: ["mutateSessionControlInTransaction"],
  enqueueCancelledChildRequiresActionResolvedOutboxInTransaction: [
    "cancelSessionSubtreeInTransaction",
  ],
};

const DEV_SEED_PATH = "scripts/dev-seed-design-preview.ts";
const DEV_SEED_CONVERSATION_WRITER = `${DEV_SEED_PATH}#seedConversations`;
// Links finished preview sessions to their seeded schedule runs (metadata only).

// A benchmark that seeds a disposable local fixture database, never a deployment.

// Benchmarks that seed raw tool-call events into their own shared-harness test
// database, keyed by the harness name each one must acquire.
const DISPOSABLE_BENCH_EVENT_WRITERS: Record<string, string> = {
  "scripts/operator/bench-event-metadata.ts": "event-metadata-benchmark",
  "scripts/operator/bench-tool-name-pages.ts": "tool-name-pages-benchmark",
};

/** Inert imports have no turns/attempts. Only these two activity-gated callers
 * may delegate a timeline write after owning the workspace/session/cursor prefix. */

/** The DEV-only seed may only write to this worktree's loopback dev stack. */
function expectDevSeedGuards(source: string): void {
  expect(source).toContain('if (!flag("--yes"))');
  expect(source).toContain("if (!LOOPBACK.has(url.hostname)) fail(");
  expect(source).toContain("if (url.port !== runtime.OPENGENI_API_PORT)");
  expect(source).toContain("set_config('opengeni.session_activity_gate_state', 'finalized', true)");
}

/** The benchmark may only seed a shared-harness database on a loopback test cluster. */

/** The event benchmark only seeds the shared-harness database it acquires itself. */
function expectDisposableBenchEventGuards(source: string, harness: string): void {
  expect(source).toContain(
    'import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";',
  );
  expect(source).toContain(`await acquireSharedTestDatabase("${harness}")`);
  expect(source).toContain('throw Error("Real PostgreSQL required");');
  expect(source).toContain("const client = createDb(shared.appUrl, { max: 1 });");
  expect(source).not.toContain("OPENGENI_DATABASE_URL");
  expect(source).not.toContain("process.env");
}

function productionTypeScriptFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (["node_modules", "dist", "coverage", "test", "tests", "__tests__"].includes(entry.name) ||
          entry.name.startsWith(".native-closure-"))
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

function namedEnclosingFunction(
  node: t.Node,
  outermost = false,
): { name: string; node: FunctionLikeDeclaration } | null {
  let current: t.Node | undefined = node;
  let result: { name: string; node: FunctionLikeDeclaration } | null = null;
  while (current) {
    if (isFunctionDeclaration(current) && current.id) {
      result = { name: current.id.name, node: current };
      if (!outermost) return result;
    } else if (
      (isArrowFunctionExpression(current) || isFunctionExpression(current)) &&
      isVariableDeclarator(parentNodes.get(current))
    ) {
      const parent = parentNodes.get(current);
      if (isVariableDeclarator(parent) && isIdentifier(parent.id)) {
        result = { name: parent.id.name, node: current };
        if (!outermost) return result;
      }
    }
    current = parentNodes.get(current);
  }
  return result;
}

function isNamedFunctionNode(node: t.Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    ((isArrowFunctionExpression(node) || isFunctionExpression(node)) &&
      isVariableDeclarator(parentNodes.get(node)))
  );
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

const sessionActivityGateWrappers = [
  "withSessionActivityRlsContext",
  "withRestoredSessionActivityRlsContext",
  "withWorkspaceSessionActivityRls",
  "withWorkspaceSubjectSessionActivityRls",
  "retrySessionActivityRls",
  "withWorkspaceSessionEventActivityRls",
  "retryWorkspaceSessionEventActivityPersistence",
  "withSessionCodexCapacityMutation",
  "withScopedCapacityWaiterRls",
];

function expectScopedCapacityWaiterActivityBoundary(source: string): string {
  const sourceFile = parseSourceFile("capacity-waiter.ts", source);
  const wrappers: t.Function[] = [];
  const visit = (node: t.Node): void => {
    if (isFunctionDeclaration(node) && node.id?.name === "withScopedCapacityWaiterRls") {
      wrappers.push(node);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile.program);
  expect(wrappers).toHaveLength(1);
  const wrapper = wrappers[0]!;
  expect(namedEnclosingFunction(wrapper, true)?.name).toBe(
    "createScopedSubscriptionCapacityWaiters",
  );
  expect(source.slice(wrapper.start, wrapper.body!.start)).toContain(
    "fn: (db: SessionActivityDatabase) => Promise<T>",
  );
  expect(wrapper.body!.body).toHaveLength(2);
  const [guard, dispatch] = wrapper.body!.body;
  expect(guard).toMatchObject({
    type: "IfStatement",
    test: {
      type: "UnaryExpression",
      operator: "!",
      argument: {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "subjectId" },
          property: { type: "Identifier", name: "trim" },
        },
        arguments: [],
      },
    },
    consequent: { type: "BlockStatement", body: [{ type: "ThrowStatement" }] },
    alternate: null,
  });
  const gatedBranch = (name: string, args: string[]) => ({
    type: "AwaitExpression",
    argument: {
      type: "CallExpression",
      callee: { type: "Identifier", name },
      arguments: args.map((argument) => ({ type: "Identifier", name: argument })),
    },
  });
  expect(dispatch).toMatchObject({
    type: "ReturnStatement",
    argument: {
      type: "ConditionalExpression",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "snapshot" },
          property: { type: "Identifier", name: "scope" },
        },
        right: { type: "Literal", value: "user" },
      },
      consequent: gatedBranch("withWorkspaceSubjectSessionActivityRls", [
        "db",
        "workspaceId",
        "subjectId",
        "fn",
      ]),
      alternate: gatedBranch("withWorkspaceSessionActivityRls", ["db", "workspaceId", "fn"]),
    },
  });
  return source.slice(wrapper.start, wrapper.end);
}

function hasSessionActivityBoundary(node: t.Node, source: string): boolean {
  let ancestor = parentNodes.get(node);
  while (ancestor) {
    if (
      isCallExpression(ancestor) &&
      sessionActivityGateWrappers.includes(callName(ancestor) ?? "")
    ) {
      return true;
    }
    ancestor = parentNodes.get(ancestor);
  }
  const enclosing = namedEnclosingFunction(node);
  return Boolean(
    enclosing?.node.body &&
    /\bSessionActivityDatabase\b/.test(
      source.slice(enclosing.node.start, enclosing.node.body.start),
    ),
  );
}

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

/** Resolve the actual table object, not the provider label or a guessed table name. */

function parameterizedWaiterMutationTables(
  node: t.CallExpression,
  bindings: Map<string, string[]>,
): string[] {
  if (
    !isMemberExpression(node.callee) ||
    !["insert", "update", "delete"].includes(callName(node) ?? "")
  ) {
    return [];
  }
  const table = node.arguments[0];
  if (
    !table ||
    !isMemberExpression(table) ||
    !isIdentifier(table.object) ||
    table.object.name !== "tables" ||
    !isIdentifier(table.property) ||
    table.property.name !== "capacityWaiters"
  )
    return [];
  let ancestor: t.Node | undefined = node;
  while (ancestor) {
    if (isFunctionDeclaration(ancestor) && ancestor.id && bindings.has(ancestor.id.name)) {
      return bindings.get(ancestor.id.name)!;
    }
    ancestor = parentNodes.get(ancestor);
  }
  throw new Error("Unresolved parameterized capacity-waiter writer");
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

function functionCalls(
  functionNode: FunctionLikeDeclaration,
  expectedName: string,
  recursive = false,
): boolean {
  let found = false;
  const visit = (node: t.Node): void => {
    if (!recursive && isNamedFunctionNode(node)) return;
    if (isCallExpression(node) && callName(node) === expectedName) found = true;
    if (!found) forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return found;
}

function functionCallHasProperty(
  functionNode: FunctionLikeDeclaration,
  expectedName: string,
  propertyName: string,
): boolean {
  let found = false;
  const visit = (node: t.Node): void => {
    if (isNamedFunctionNode(node)) return;
    if (
      isCallExpression(node) &&
      callName(node) === expectedName &&
      callHasProperty(node, propertyName)
    ) {
      found = true;
    }
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
    if (isNamedFunctionNode(node)) return;
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
    if (isNamedFunctionNode(node)) return;
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

const VISIBILITY_SETTLEMENT = "settleSessionVisibilityWorkInTransaction";

/**
 * The visibility settlement locks its event-write rows with controlLock
 * "already_locked": each caller first runs lockSessionForVisibilityWork, which
 * takes the workspace control share before the canonical event-write rows. Pin
 * that exact chain and its closed caller set instead of widening the generic
 * prefix rule.
 */
function visibilitySettlementPrefixIsPinned(): boolean {
  const callers = new Set<string>();
  const definitions = new Map<string, FunctionLikeDeclaration[]>();
  for (const path of productionTypeScriptFiles()) {
    const source = readFileSync(path, "utf8");
    if (!source.includes(VISIBILITY_SETTLEMENT)) continue;
    const visit = (node: t.Node): void => {
      if (isNamedFunctionNode(node)) {
        const named = namedEnclosingFunction(node);
        if (named)
          definitions.set(named.name, [...(definitions.get(named.name) ?? []), named.node]);
      }
      if (isCallExpression(node) && callName(node) === VISIBILITY_SETTLEMENT) {
        const enclosing = namedEnclosingFunction(node);
        if (enclosing) callers.add(enclosing.name);
      }
      forEachChild(node, visit);
    };
    visit(parseSourceFile(path, source).program);
  }
  const only = (name: string): FunctionLikeDeclaration => {
    const found = definitions.get(name) ?? [];
    expect(found, name).toHaveLength(1);
    return found[0]!;
  };
  const lock = only("lockSessionForVisibilityWork");
  const controlShare = callPositionsWithStringArgument(
    lock,
    "lockWorkspaceInferenceControl",
    2,
    "share",
  )[0];
  expect(controlShare).toBeDefined();
  expect(controlShare!).toBeLessThan(callPositions(lock, "lockSessionEventWriteRows")[0]!);
  expect([...callers].sort()).toEqual([
    "settleWorkBeforePrivateTransition",
    "stopSessionWorkForVisibilityChange",
  ]);
  for (const caller of callers) {
    const node = only(caller);
    const prefix = callPositions(node, "lockSessionForVisibilityWork")[0];
    expect(prefix, caller).toBeDefined();
    expect(prefix!, caller).toBeLessThan(callPositions(node, VISIBILITY_SETTLEMENT)[0]!);
  }
  return true;
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

function callPositions(
  functionNode: FunctionLikeDeclaration,
  expectedName: string,
  recursive = false,
): number[] {
  const positions: number[] = [];
  const visit = (node: t.Node): void => {
    if (!recursive && isNamedFunctionNode(node)) return;
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
    if (isNamedFunctionNode(node)) return;
    if (isCallExpression(node) && insertsSessionEvents(node)) {
      positions.push(nodeStart(node));
    }
    forEachChild(node, visit);
  };
  forEachChild(functionNode, visit);
  return positions.sort((left, right) => left - right);
}

describe("session_events writer inventory", () => {
  test("the historical scoped-waiter fixture proves activity-gate detection in both branches", () => {
    const source = readFileSync(
      join(repoRoot, "packages/db/test/fixtures/legacy-codex.ts"),
      "utf8",
    );
    const wrapper = expectScopedCapacityWaiterActivityBoundary(source);
    const fixture = `function createScopedSubscriptionCapacityWaiters() { ${wrapper} }`;
    for (const [gated, ungated] of [
      ["withWorkspaceSubjectSessionActivityRls", "withWorkspaceSubjectRls"],
      ["withWorkspaceSessionActivityRls", "withWorkspaceRls"],
    ]) {
      expect(() =>
        expectScopedCapacityWaiterActivityBoundary(fixture.replaceAll(gated!, ungated!)),
      ).toThrow();
    }
    expect(() =>
      expectScopedCapacityWaiterActivityBoundary(
        fixture.replace("if (!subjectId.trim())", "if (false)"),
      ),
    ).toThrow();
  });

  test("nested factory writers cannot borrow sibling lock or gate evidence", () => {
    const sourceFile = parseSourceFile(
      "factory.ts",
      `
      function createScopedSubscriptionCapacityWaiters() {
        function protectedWriter(tx: SessionActivityDatabase) {
          lockSessionEventWriteRows(tx, { controlLock: "share" });
          tx.insert(schema.sessionEvents);
          tx.insert(tables.capacityWaiters);
          tx.update(schema.sessions);
        }
        const unprotectedWriter = (tx: Database) => {
          tx.insert(schema.sessionEvents);
          tx.insert(tables.capacityWaiters);
          tx.update(schema.sessions);
        };
        return { protectedWriter, unprotectedWriter };
      }
    `,
    );
    const writers: Array<{ name: string; node: FunctionLikeDeclaration }> = [];
    const violations: string[] = [];
    const aliasedWriters: Record<string, string[]> = {};
    const bindings = new Map([
      ["createScopedSubscriptionCapacityWaiters", ["xai_capacity_waiters"]],
    ]);
    const visit = (node: t.Node): void => {
      if (isCallExpression(node) && insertsSessionEvents(node)) {
        writers.push(namedEnclosingFunction(node)!);
      }
      if (isCallExpression(node)) {
        const tables = parameterizedWaiterMutationTables(node, bindings);
        if (tables.length) aliasedWriters[namedEnclosingFunction(node)!.name] = tables;
        if (writesSessions(node) && !hasSessionActivityBoundary(node, sourceFile.source)) {
          violations.push(namedEnclosingFunction(node)!.name);
        }
      }
      forEachChild(node, visit);
    };
    visit(sourceFile.program);
    expect(violations).toEqual(["unprotectedWriter"]);
    expect(aliasedWriters).toEqual({
      protectedWriter: ["xai_capacity_waiters"],
      unprotectedWriter: ["xai_capacity_waiters"],
    });
    expect(writers.map((writer) => writer.name)).toEqual(["protectedWriter", "unprotectedWriter"]);
    const factory = sourceFile.program.body[0]!;
    expect(isFunctionDeclaration(factory)).toBe(true);
    if (!isFunctionDeclaration(factory)) throw new Error("Expected a factory declaration");
    expect(callPositions(factory, "lockSessionEventWriteRows")).toEqual([]);
    expect(insertPositions(factory)).toEqual([]);
    expect(controlAwarePrefixPositions(writers[0]!.node)).toHaveLength(1);
    expect(insertPositions(writers[0]!.node)).toHaveLength(1);
    expect(controlAwarePrefixPositions(writers[1]!.node)).toEqual([]);
    expect(functionCalls(writers[1]!.node, "lockSessionEventWriteRows")).toBe(false);
    expect(insertPositions(writers[1]!.node)).toHaveLength(1);
    expect(
      sourceFile.source.slice(writers[1]!.node.start, writers[1]!.node.body!.start),
    ).not.toContain("SessionActivityDatabase");
  });

  test("forbidden effects inside invoked named retry callbacks remain visible", () => {
    const sourceFile = parseSourceFile(
      "retry.ts",
      `
      function command() {
        function retryCallback() { publishSessionEventIds(); }
        return runSessionCommandPersistenceTransaction(retryCallback);
      }
    `,
    );
    const visit = (node: t.Node): void => {
      forEachChild(node, visit);
    };
    visit(sourceFile.program);
    const command = sourceFile.program.body[0]!;
    if (!isFunctionDeclaration(command)) throw new Error("Expected a command declaration");
    expect(functionCalls(command, "runSessionCommandPersistenceTransaction")).toBe(true);
    // Scope-local positive evidence cannot certify the sibling callback, while
    // recursive forbidden-effect checks must still reject its publication.
    expect(functionCalls(command, "publishSessionEventIds")).toBe(false);
    expect(functionCalls(command, "publishSessionEventIds", true)).toBe(true);
    const persistence = callPositions(command, "runSessionCommandPersistenceTransaction")[0]!;
    const forbidden = callPositions(command, "publishSessionEventIds", true);
    expect(forbidden).toHaveLength(1);
    expect(forbidden[0]).toBeLessThan(persistence);
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
        const enclosing = namedEnclosingFunction(node);
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

  test("session activity gate GUCs have one application owner", () => {
    const violations = productionTypeScriptFiles()
      .filter(
        (path) => relative(repoRoot, path).replaceAll("\\", "/") !== "packages/db/src/database.ts",
      )
      .filter((path) => readFileSync(path, "utf8").includes("opengeni.session_activity_gate_"))
      .map((path) => relative(repoRoot, path).replaceAll("\\", "/"))
      // The DEV-only seed's pinned exception; see DEV_SEED_CONVERSATION_WRITER.
      .filter((path) => path !== DEV_SEED_PATH);
    expectDevSeedGuards(readFileSync(join(repoRoot, DEV_SEED_PATH), "utf8"));
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
      const file = relative(repoRoot, path).replaceAll("\\", "/");
      if (
        file !== "packages/db/src/session-attempt-fence.ts" &&
        !source.includes("sessionEvents") &&
        !source.includes("session_events") &&
        !source.includes("sessionSystemUpdateOutbox") &&
        !source.includes("session_system_update_outbox")
      ) {
        continue;
      }
      const sourceFile = parseSourceFile(path, source);
      const visit = (node: t.Node): void => {
        if (isNamedFunctionNode(node)) {
          const enclosing = namedEnclosingFunction(node);
          if (enclosing) {
            const definitions = functionDefinitions.get(enclosing.name) ?? [];
            definitions.push({ sourceFile, functionNode: enclosing.node });
            functionDefinitions.set(enclosing.name, definitions);
          }
        }
        if (isCallExpression(node)) {
          const enclosing = namedEnclosingFunction(node);
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
            const outer = namedEnclosingFunction(node, true);
            if (`${file}#${outer?.name}` === DEV_SEED_CONVERSATION_WRITER) {
              // The DEV-only seed's pinned exception; see DEV_SEED_CONVERSATION_WRITER.
            } else if (DISPOSABLE_BENCH_EVENT_WRITERS[file] && !outer) {
              // Top-level fixture seeding in the benchmark's own shared-harness
              // database; pin its guards and do not exempt any other writer.
              expectDisposableBenchEventGuards(
                sourceFile.source,
                DISPOSABLE_BENCH_EVENT_WRITERS[file],
              );
            } else {
              rawSqlWriters.push(`${file}:${lineNumber(sourceFile.source, node)}`);
            }
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
          expect(
            functionCallHasProperty(writer.functionNode, "lockSessionEventWriteRows", "sessionIds"),
          ).toBe(true);
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
            Object.hasOwn(expectedOwnedSuffixCallers, caller) ||
            (caller === VISIBILITY_SETTLEMENT && visibilitySettlementPrefixIsPinned()),
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
    expect(functionCalls(retryHelper!, "publishAndWakeAgentCommand", true)).toBe(false);
    expect(functionCalls(retryHelper!, "publishWorkspaceControlEvent", true)).toBe(false);
    expect(functionCalls(retryHelper!, "publishSessionEventIds", true)).toBe(false);
    expect(functionCalls(retryHelper!, "requestControlWakeDispatch", true)).toBe(false);

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
        for (const effect of callPositions(command!, externalEffect, true)) {
          expect(persistence).toBeLessThan(effect);
        }
      }
    }
  });
});
