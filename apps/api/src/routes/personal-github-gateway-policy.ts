import { UNATTENDED_APPROVAL_REFUSAL_TEXT } from "@opengeni/contracts";
import type { ToolReviewContext } from "@opengeni/contracts";
import {
  beginConnectorActionExecution,
  completeConnectorActionExecution,
  type ConnectorActionAttemptIdentity,
  githubGatewayApprovalForRequest,
  resolveAttemptConnectorToolDecision,
  type Database,
  type ResolvedConnectorActionPolicy,
} from "@opengeni/db";
import {
  GITHUB_SENSITIVE_REQUEST_POLICY_NAME,
  githubSensitiveRequestDecision,
} from "@opengeni/core";
import type { PersonalGitHubGitBrokerClaims } from "@opengeni/github";
import { createHash } from "node:crypto";
import {
  ZERO_OID,
  packBoundary,
  parseReceivePackRequest,
  readPackCommits,
  receivePackRejection,
  type ReceivePackCommand,
} from "../integrations/git-receive-pack";
import {
  refRewriteFollowsPolicy,
  type GitHubGatewayAction,
} from "../integrations/github-gateway-requests";

/** The policy actions of `gh` and Git requests are the `github_personal` tools' own. */
export const PERSONAL_GITHUB_POLICY_SERVER_ID = "github_personal";

/** A request the gateway runs without a matching policy action. */
const UNMAPPED_REQUEST_TOOL = "github_request";

export type GatewayDecisionIdentity = {
  claims: PersonalGitHubGitBrokerClaims;
  initiator: ConnectorActionAttemptIdentity["initiator"];
  unattended: boolean;
};

export type GatewayDecision =
  | { kind: "allow" }
  | { kind: "run"; requestId: string }
  | { kind: "refuse"; status: 403 | 409; message: string; waiting: boolean };

export type GatewayDecisionInput = {
  action: Extract<GitHubGatewayAction, { kind: "write" }>;
  /** Binds an approval to this exact request. */
  digest: string;
  /** What the approval card shows (stored with the request). */
  reviewArguments: Record<string, unknown>;
  title: string;
};

export type GatewayDecider = (
  identity: GatewayDecisionIdentity,
  input: GatewayDecisionInput,
) => Promise<GatewayDecision>;

export type GatewayCompleter = (
  identity: GatewayDecisionIdentity,
  requestId: string,
  outcome: "completed" | "uncertain" | "not_executed",
) => Promise<void>;

const DECISION_RANK = { allow: 0, ask: 1, block: 2 } as const;

function connectorIdentity(identity: GatewayDecisionIdentity): ConnectorActionAttemptIdentity {
  const { claims } = identity;
  return {
    accountId: claims.accountId,
    workspaceId: claims.workspaceId,
    sessionId: claims.sessionId,
    turnId: claims.turnId,
    attemptId: claims.attemptId,
    executionGeneration: claims.executionGeneration,
    initiator: identity.initiator,
  };
}

export function waitingForApprovalMessage(title: string): string {
  return `Waiting for approval: ${title}. End your turn now; after the person approves, run the same command again.`;
}

/** How one policy action of a gateway request resolves against the person's policies. */
export type GatewayPolicyLookup = (input: {
  toolName: string;
  defaultDecision: "allow" | "ask";
  decide?: (resolved: ResolvedConnectorActionPolicy) => "allow" | "ask" | "block";
}) => Promise<"allow" | "ask" | "block">;

/**
 * The strictest decision of a write's policy actions, and the policy action
 * an approval records. A sensitive write adds the Settings and deletions
 * action, which asks without an explicit choice for it. A write whose
 * repositories the gateway can't confirm (`unscoped`) asks even when every
 * policy allows it; Block still wins.
 *
 * The recorded action doesn't depend on the decisions, so an approved request
 * still matches its approval when it runs again after a policy change.
 */
export async function strictestGatewayPolicy(
  action: GatewayDecisionInput["action"],
  lookup: GatewayPolicyLookup,
): Promise<{ decision: "allow" | "ask" | "block"; toolName: string }> {
  const tools = [
    ...(action.tools.length > 0 ? action.tools : [UNMAPPED_REQUEST_TOOL]),
    ...(action.sensitive ? [GITHUB_SENSITIVE_REQUEST_POLICY_NAME] : []),
  ];
  let strictest: "allow" | "ask" | "block" = "allow";
  for (const toolName of tools) {
    const decision =
      toolName === GITHUB_SENSITIVE_REQUEST_POLICY_NAME
        ? await lookup({ toolName, defaultDecision: "ask", decide: githubSensitiveRequestDecision })
        : await lookup({ toolName, defaultDecision: "allow" });
    if (DECISION_RANK[decision] > DECISION_RANK[strictest]) strictest = decision;
  }
  if (action.unscoped && strictest === "allow") strictest = "ask";
  return {
    decision: strictest,
    toolName: action.sensitive ? GITHUB_SENSITIVE_REQUEST_POLICY_NAME : tools[0]!,
  };
}

/**
 * Decide one write from the strictest of its actions' policies, plus the
 * person's Settings and deletions policy (Ask without a choice) for a
 * sensitive request: Block wins, Ask opens the normal approval card,
 * otherwise it runs. An approved request runs once when the same request is
 * sent again in the turn.
 */
export function databaseGatewayDecider(db: Database): GatewayDecider {
  return async (identity, input) => {
    const ledgerIdentity = connectorIdentity(identity);
    const { decision: strictest, toolName: decidingTool } = await strictestGatewayPolicy(
      input.action,
      (lookup) =>
        resolveAttemptConnectorToolDecision(db, ledgerIdentity, {
          connectionId: identity.claims.connectionId,
          serverId: PERSONAL_GITHUB_POLICY_SERVER_ID,
          ...lookup,
        }),
    );
    if (strictest === "block") {
      return {
        kind: "refuse",
        status: 403,
        waiting: false,
        message: `Blocked by the person's GitHub action settings: ${input.title}.`,
      };
    }
    if (strictest === "allow") return { kind: "allow" };
    // A request run again after its approval keeps the action it was recorded
    // under, even if the gateway now classifies it differently.
    const recorded = await githubGatewayApprovalForRequest(db, ledgerIdentity, input.digest);
    const approvalId = recorded.approvalId;
    const approvalTool = recorded.toolName ?? decidingTool;
    const reviewContext: ToolReviewContext = {
      kind: "api",
      title: input.title.slice(0, 256),
    };
    if (identity.unattended) {
      return {
        kind: "refuse",
        status: 403,
        waiting: false,
        message: UNATTENDED_APPROVAL_REFUSAL_TEXT,
      };
    }
    const begun = await beginConnectorActionExecution(db, ledgerIdentity, {
      approvalId,
      connectionId: identity.claims.connectionId,
      serverId: PERSONAL_GITHUB_POLICY_SERVER_ID,
      toolName: approvalTool,
      actionName: approvalTool,
      arguments: input.reviewArguments,
      reviewContext,
      defaultDecision: "ask",
      minimumDecision: "ask",
    });
    if (begun.allowed) {
      return begun.managed ? { kind: "run", requestId: begun.requestId } : { kind: "allow" };
    }
    switch (begun.reason) {
      case "approval_required":
        return {
          kind: "refuse",
          status: 403,
          waiting: true,
          message: waitingForApprovalMessage(input.title),
        };
      case "rejected":
        return {
          kind: "refuse",
          status: 403,
          waiting: false,
          message: `Declined by the person: ${input.title}. Do not retry it.`,
        };
      case "blocked":
        return {
          kind: "refuse",
          status: 403,
          waiting: false,
          message: `Blocked by the person's GitHub action settings: ${input.title}.`,
        };
      default:
        return {
          kind: "refuse",
          status: 409,
          waiting: false,
          message: `This exact request already started and its outcome is unknown: ${input.title}. Check GitHub before trying again.`,
        };
    }
  };
}

export function databaseGatewayCompleter(db: Database): GatewayCompleter {
  return async (identity, requestId, outcome) => {
    await completeConnectorActionExecution(db, {
      accountId: identity.claims.accountId,
      workspaceId: identity.claims.workspaceId,
      requestId,
      attemptId: identity.claims.attemptId,
      outcome,
    });
  };
}

/** Stable JSON: object keys sorted, so the same request always has the same digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function requestDigest(parts: unknown[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    if (part instanceof Uint8Array) hash.update(part);
    else hash.update(canonicalJson(part));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 40);
}

/**
 * Read a request body up to `maxBytes`. Returns the bytes read and, when the
 * body is longer, a stream that replays them followed by the rest.
 */
export async function readBodyPrefix(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; complete: boolean; stream: ReadableStream<Uint8Array> | null }> {
  if (!body) return { bytes: new Uint8Array(), complete: true, stream: null };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      const prefix = Buffer.concat(chunks);
      let replayed = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!replayed) {
            replayed = true;
            controller.enqueue(prefix);
            return;
          }
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => undefined);
        },
      });
      return { bytes: prefix, complete: false, stream };
    }
  }
  return { bytes: Buffer.concat(chunks), complete: true, stream: null };
}

export const PUSH_INSPECTION_MAX_BYTES = 64 * 1024 * 1024;

/** Whether `base` is an ancestor of (or equal to) `head` on GitHub; null when unknown. */
export type GitHubAncestryCheck = (base: string, head: string) => Promise<boolean | null>;

export type PushInspection =
  | { kind: "forward"; body: Uint8Array | ReadableStream<Uint8Array>; requestId: string | null }
  | { kind: "respond"; response: Response };

function refLabel(ref: string): string {
  return ref.replace(/^refs\/heads\//u, "").replace(/^refs\/tags\//u, "tag ");
}

/**
 * Inspect a `git-receive-pack` request. Deleting or force-pushing a branch
 * other than the default branch follows the person's `ref_create` policy;
 * the default branch, a tag or any other ref also follows their Settings and
 * deletions policy, as does a push this reader cannot read. Any other push is
 * unchanged. A refused push gets Git's own per-ref rejection with Opengeni's
 * reason.
 */
export async function inspectPersonalGitHubPush(input: {
  body: ReadableStream<Uint8Array> | null;
  gzip: boolean;
  repositoryFullName: string;
  /** The repository's default branch; null (or absent) when unknown, so every rewrite is sensitive. */
  defaultBranch?: string | null;
  isAncestor: GitHubAncestryCheck;
  identity: GatewayDecisionIdentity;
  decide: GatewayDecider;
}): Promise<PushInspection> {
  const prefix = await readBodyPrefix(input.body, PUSH_INSPECTION_MAX_BYTES);
  const forwardBody = prefix.stream ?? prefix.bytes;
  let raw: Uint8Array | null = prefix.bytes;
  if (input.gzip) {
    try {
      raw = prefix.complete ? (await import("node:zlib")).gunzipSync(prefix.bytes) : null;
    } catch {
      raw = null;
    }
  }
  const request = raw ? parseReceivePackRequest(raw) : null;
  // A body with nothing to push (a flush) goes on as before.
  if (request && request.commands.length === 0) {
    return { kind: "forward", body: forwardBody, requestId: null };
  }
  // A push this reader cannot read (compressed past the inspection limit, a
  // push certificate, ...): the person decides.
  if (!request || !raw) {
    if (prefix.bytes.byteLength === 0) {
      return { kind: "forward", body: forwardBody, requestId: null };
    }
    const title = `Push to ${input.repositoryFullName}`.slice(0, 240);
    const decision = await input.decide(input.identity, {
      action: { kind: "write", tools: ["ref_create"], sensitive: true, title },
      digest: requestDigest(["git-push-raw", input.repositoryFullName.toLowerCase(), prefix.bytes]),
      reviewArguments: { repository: input.repositoryFullName, bytes: prefix.bytes.byteLength },
      title,
    });
    if (decision.kind === "allow") return { kind: "forward", body: forwardBody, requestId: null };
    if (decision.kind === "run") {
      return { kind: "forward", body: forwardBody, requestId: decision.requestId };
    }
    await prefix.stream?.cancel().catch(() => undefined);
    // Git shows a side-band error (band 3) as `remote: ...`; without
    // side-band an `ERR` packet ends the push with the same text. The
    // capabilities are on the first command line, so a compressed push is
    // inflated only as far as its first bytes.
    let head: Uint8Array = raw ?? prefix.bytes;
    if (input.gzip && !raw) {
      try {
        const zlib = await import("node:zlib");
        head = zlib.gunzipSync(prefix.bytes.subarray(0, 64 * 1024), {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
        });
      } catch {
        head = new Uint8Array();
      }
    }
    const sideBand = Buffer.from(head.subarray(0, 4096)).includes("side-band");
    const line = Buffer.from(
      `${sideBand ? "\u0003" : "ERR "}GitHub gateway: ${decision.message}\n`,
      "utf8",
    );
    const packet = Buffer.concat([
      Buffer.from((line.byteLength + 4).toString(16).padStart(4, "0"), "ascii"),
      line,
    ]);
    return {
      kind: "respond",
      response: new Response(packet as unknown as BodyInit, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/x-git-receive-pack-result",
          "x-content-type-options": "nosniff",
        },
      }),
    };
  }
  const deletions: ReceivePackCommand[] = [];
  const updates: ReceivePackCommand[] = [];
  for (const command of request.commands) {
    if (command.newOid === ZERO_OID) deletions.push(command);
    else if (command.oldOid !== ZERO_OID) updates.push(command);
  }
  const forced: ReceivePackCommand[] = [];
  if (updates.length > 0) {
    // Past the inspection limit the commits before the cut still count.
    const pack =
      request.packOffset < raw.length ? readPackCommits(raw.subarray(request.packOffset)) : null;
    for (const update of updates) {
      const fastForward = await isFastForward(update, pack?.commits ?? null, input.isAncestor);
      if (!fastForward) forced.push(update);
    }
  }
  if (deletions.length === 0 && forced.length === 0) {
    return { kind: "forward", body: forwardBody, requestId: null };
  }
  const parts = [
    ...deletions.map((command) => `delete ${refLabel(command.ref)}`),
    ...forced.map((command) => `force-push ${refLabel(command.ref)}`),
  ];
  const title = `${capitalize(parts.join(", "))} on ${input.repositoryFullName}`.slice(0, 240);
  const sensitive = [...deletions, ...forced].some(
    (command) => !refRewriteFollowsPolicy(command.ref, input.defaultBranch ?? null),
  );
  const decision = await input.decide(input.identity, {
    action: { kind: "write", tools: ["ref_create"], sensitive, title },
    digest: requestDigest([
      "git-push",
      input.repositoryFullName.toLowerCase(),
      request.commands.map((command) => [command.oldOid, command.newOid, command.ref]),
    ]),
    reviewArguments: {
      repository: input.repositoryFullName,
      updates: [
        ...deletions.map((command) => ({
          ref: command.ref,
          change: "delete",
          from: command.oldOid,
        })),
        ...forced.map((command) => ({
          ref: command.ref,
          change: "force-push",
          from: command.oldOid,
          to: command.newOid,
        })),
      ],
    },
    title,
  });
  if (decision.kind === "allow") return { kind: "forward", body: forwardBody, requestId: null };
  if (decision.kind === "run") {
    return { kind: "forward", body: forwardBody, requestId: decision.requestId };
  }
  const asked = new Set([...deletions, ...forced].map((command) => command.ref));
  const reasons = new Map(
    request.commands.map((command) => [
      command.ref,
      asked.has(command.ref)
        ? decision.waiting
          ? "waiting for approval"
          : "refused by the GitHub gateway"
        : "not pushed: another ref in this push needs approval",
    ]),
  );
  return {
    kind: "respond",
    response: new Response(
      receivePackRejection(request, reasons, "refused by the GitHub gateway", [
        `GitHub gateway: ${decision.message}`,
      ]) as unknown as BodyInit,
      {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/x-git-receive-pack-result",
          "x-content-type-options": "nosniff",
        },
      },
    ),
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function isFastForward(
  update: ReceivePackCommand,
  commits: Map<string, string[]> | null,
  isAncestor: GitHubAncestryCheck,
): Promise<boolean> {
  if (commits?.has(update.newOid)) {
    const walk = packBoundary(commits, update.newOid, update.oldOid);
    if (walk.reachedOld) return true;
    // The new history joins existing history at these commits; the old tip
    // must be an ancestor of one of them.
    for (const boundary of walk.boundary.slice(0, 8)) {
      if ((await isAncestor(update.oldOid, boundary)) === true) return true;
    }
    return false;
  }
  // Moving a ref to a commit GitHub already has (no new objects).
  return (await isAncestor(update.oldOid, update.newOid)) === true;
}
