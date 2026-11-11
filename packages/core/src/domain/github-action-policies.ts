import type {
  GitHubActionPolicyActor,
  GitHubActionPolicyActorState,
  GitHubActionPolicyDecision,
  GitHubActionPolicyEffectiveDecision,
  GitHubActionPolicyGroup,
} from "@opengeni/contracts";
import {
  listConnectorActionPolicies,
  resolveConnectorActionPolicy,
  upsertConnectorActionPolicies,
  type ConnectorActionPolicySnapshotEntry,
  type Database,
} from "@opengeni/db";
import {
  GITHUB_REST_MCP_APP_SERVER_ID,
  GITHUB_REST_MCP_PERSONAL_SERVER_ID,
  GITHUB_REST_WRITE_TOOL_NAMES,
  GITHUB_SENSITIVE_REQUEST_POLICY_NAME,
} from "@opengeni/runtime/github-rest-mcp";

export const GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES = {
  routine: GITHUB_REST_WRITE_TOOL_NAMES.filter(
    (toolName) => toolName !== "pull_request_review_submit" && toolName !== "pull_request_merge",
  ),
  review: ["pull_request_review_submit"],
  merge: ["pull_request_merge"],
  sensitive: [GITHUB_SENSITIVE_REQUEST_POLICY_NAME],
} as const satisfies Record<GitHubActionPolicyGroup, readonly string[]>;

const groupedToolNames = Object.values(GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES).flat();
if (
  groupedToolNames.length !== new Set(groupedToolNames).size ||
  GITHUB_REST_WRITE_TOOL_NAMES.some((toolName) => !groupedToolNames.includes(toolName))
) {
  throw new Error("GitHub action policy groups must cover every write tool exactly once");
}

/** Settings and deletions exists only for Your GitHub: the workspace app has no gateway. */
export function githubActionPolicyGroupApplies(
  actor: GitHubActionPolicyActor,
  group: GitHubActionPolicyGroup,
): boolean {
  return group !== "sensitive" || actor.kind === "personal";
}

export class GitHubActionPolicyGroupNotApplicableError extends Error {
  constructor() {
    super("Settings and deletions applies only to Your GitHub");
  }
}

/**
 * The Settings and deletions decision as the `gh` and Git gateway applies it:
 * an explicit choice for it, else Ask. A connection-wide Allow for every tool
 * does not cover it (it was set before this choice existed), but a
 * connection-wide Block does.
 */
export function githubSensitiveRequestDecision(
  resolved: ReturnType<typeof resolveConnectorActionPolicy>,
): GitHubActionPolicyDecision {
  if (!resolved.managed) return "ask";
  if (!resolved.entry) return resolved.decision;
  if (
    resolved.entry.toolName !== GITHUB_SENSITIVE_REQUEST_POLICY_NAME &&
    resolved.entry.policy !== "block"
  ) {
    return "ask";
  }
  return resolved.entry.policy;
}

export type GitHubActionPolicyActorBinding = {
  actor: GitHubActionPolicyActor;
  label: string;
  connectionId: string;
  serverId: typeof GITHUB_REST_MCP_APP_SERVER_ID | typeof GITHUB_REST_MCP_PERSONAL_SERVER_ID;
};

function effectiveToolDecision(
  policies: readonly ConnectorActionPolicySnapshotEntry[],
  actor: GitHubActionPolicyActorBinding,
  toolName: string,
): GitHubActionPolicyDecision {
  const resolved = resolveConnectorActionPolicy(policies, {
    connectionId: actor.connectionId,
    serverId: actor.serverId,
    toolName,
    actionName: toolName,
  });
  if (toolName === GITHUB_SENSITIVE_REQUEST_POLICY_NAME) {
    return githubSensitiveRequestDecision(resolved);
  }
  // Match connector_write admission: absent policy inherits repository capability.
  // This is a policy projection, not a grant of repository or provider access.
  if (!resolved.managed) return "allow";
  if (resolved.entry) return resolved.entry.policy;
  return resolved.decision;
}

function effectiveGroupDecision(
  policies: readonly ConnectorActionPolicySnapshotEntry[],
  actor: GitHubActionPolicyActorBinding,
  group: GitHubActionPolicyGroup,
): GitHubActionPolicyEffectiveDecision {
  const decisions = new Set(
    GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES[group].map((toolName) =>
      effectiveToolDecision(policies, actor, toolName),
    ),
  );
  return decisions.size === 1 ? decisions.values().next().value! : "mixed";
}

export function projectGitHubActionPolicyActor(
  policies: readonly ConnectorActionPolicySnapshotEntry[],
  binding: GitHubActionPolicyActorBinding,
): GitHubActionPolicyActorState {
  const groups = {
    routine: effectiveGroupDecision(policies, binding, "routine"),
    review: effectiveGroupDecision(policies, binding, "review"),
    merge: effectiveGroupDecision(policies, binding, "merge"),
  };
  return binding.actor.kind === "workspace_app"
    ? {
        kind: "workspace_app",
        installationId: binding.actor.installationId,
        label: binding.label,
        groups,
      }
    : {
        kind: "personal",
        connectionId: binding.actor.connectionId,
        label: binding.label,
        groups: { ...groups, sensitive: effectiveGroupDecision(policies, binding, "sensitive") },
      };
}

export async function listGitHubActionPolicyActors(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actors: readonly GitHubActionPolicyActorBinding[];
  },
): Promise<GitHubActionPolicyActorState[]> {
  const policies = await listConnectorActionPolicies(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    connectionIds: input.actors.map((actor) => actor.connectionId),
  });
  return input.actors.map((actor) => projectGitHubActionPolicyActor(policies, actor));
}

export async function updateGitHubActionPolicyGroup(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    actor: GitHubActionPolicyActorBinding;
    group: GitHubActionPolicyGroup;
    decision: GitHubActionPolicyDecision;
  },
): Promise<GitHubActionPolicyActorState> {
  if (!githubActionPolicyGroupApplies(input.actor.actor, input.group)) {
    throw new GitHubActionPolicyGroupNotApplicableError();
  }
  await upsertConnectorActionPolicies(
    db,
    GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES[input.group].map((toolName) => ({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      connectionId: input.actor.connectionId,
      serverId: input.actor.serverId,
      toolName,
      actionName: toolName,
      policy: input.decision,
    })),
  );
  const policies = await listConnectorActionPolicies(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    connectionIds: [input.actor.connectionId],
  });
  return projectGitHubActionPolicyActor(policies, input.actor);
}

export function githubAppActionPolicyActor(input: {
  installationId: number;
  accountLogin: string | null;
}): GitHubActionPolicyActorBinding {
  return {
    actor: { kind: "workspace_app", installationId: input.installationId },
    label: input.accountLogin ? `Opengeni bot on ${input.accountLogin}` : "Opengeni bot",
    connectionId: `github-app:${input.installationId}`,
    serverId: GITHUB_REST_MCP_APP_SERVER_ID,
  };
}

export function personalGitHubActionPolicyActor(input: {
  connectionId: string;
  githubLogin: string;
}): GitHubActionPolicyActorBinding {
  return {
    actor: { kind: "personal", connectionId: input.connectionId },
    label: `@${input.githubLogin}`,
    connectionId: input.connectionId,
    serverId: GITHUB_REST_MCP_PERSONAL_SERVER_ID,
  };
}
