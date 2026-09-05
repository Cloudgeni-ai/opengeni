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
} from "@opengeni/runtime/github-rest-mcp";

export const GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES = {
  routine: GITHUB_REST_WRITE_TOOL_NAMES.filter(
    (toolName) => toolName !== "pull_request_review_submit" && toolName !== "pull_request_merge",
  ),
  review: ["pull_request_review_submit"],
  merge: ["pull_request_merge"],
} as const satisfies Record<GitHubActionPolicyGroup, readonly string[]>;

const groupedToolNames = Object.values(GITHUB_ACTION_POLICY_GROUP_TOOL_NAMES).flat();
if (
  groupedToolNames.length !== new Set(groupedToolNames).size ||
  GITHUB_REST_WRITE_TOOL_NAMES.some((toolName) => !groupedToolNames.includes(toolName))
) {
  throw new Error("GitHub action policy groups must cover every write tool exactly once");
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
  if (!resolved.managed) return "ask";
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
        groups,
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
    label: input.accountLogin ? `OpenGeni bot on ${input.accountLogin}` : "OpenGeni bot",
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
