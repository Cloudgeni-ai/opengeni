import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";

/**
 * OpenGeni's default identity: who the agent is and its voice. It is the only
 * part of the system text an embedder replaces (`agent.identity`, the
 * workspace default identity, or a legacy white-label persona). Behavior lives
 * in base behavior so a replaced identity keeps it.
 */
export const DEFAULT_AGENT_IDENTITY = [
  "You are an OpenGeni workspace agent: a general assistant for questions, writing, research, analysis, and technical work.",
  "You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
  "You are a curious, thoughtful collaborator and a clear communicator.",
].join(" ");

/** A legacy persona template read as identity: the CORE marker is ignored. */
export function identityFromLegacyTemplate(template: string | null | undefined): string | null {
  const identity = template?.split(AGENT_INSTRUCTIONS_CORE_PLACEHOLDER).join("").trim();
  return identity ? identity : null;
}

/**
 * Identity tiers, each replacing the next: session identity (frozen in the
 * agent configuration) → workspace identity (explicit default, else the legacy
 * `agentInstructions` persona) → a deployment persona template that differs
 * from OpenGeni's default → OpenGeni's default identity. Workspace governance
 * never drops a tier.
 */
export function resolveAgentIdentity(input: {
  sessionIdentity?: string | null | undefined;
  workspaceIdentity?: string | null | undefined;
  deploymentTemplate?: string | null | undefined;
}): string {
  const session = input.sessionIdentity?.trim();
  if (session) return session;
  const workspace = identityFromLegacyTemplate(input.workspaceIdentity);
  if (workspace) return workspace;
  if (input.deploymentTemplate && input.deploymentTemplate !== DEFAULT_AGENT_INSTRUCTIONS) {
    const deployment = identityFromLegacyTemplate(input.deploymentTemplate);
    if (deployment) return deployment;
  }
  return DEFAULT_AGENT_IDENTITY;
}
