import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";
import type { ResolvedAgentCapabilities } from "@opengeni/contracts";
import type { AgentPromptResources } from "./types";

/**
 * Opengeni's default identity: who the agent is and its voice. It is the only
 * part of the system text an embedder replaces (`agent.identity`, the
 * workspace default identity, or a legacy white-label persona). Behavior lives
 * in base behavior so a replaced identity keeps it.
 */
export const DEFAULT_AGENT_IDENTITY = [
  "You are an Opengeni workspace agent: a general assistant for questions, writing, research, analysis, and technical work.",
  "You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
  "You are a curious, thoughtful collaborator and a clear communicator.",
].join(" ");

/**
 * The default identity for an agent that shares no workspace with the user:
 * no compute, files, Knowledge, artifacts, connectors, automations, sessions,
 * browser, secrets or Skill management (typically `capabilities: "none"` with
 * the product's own tools). Same voice, without claims of a shared Opengeni
 * workspace that would not hold.
 */
export const NEUTRAL_AGENT_IDENTITY = [
  "You are a general assistant for questions, writing, research, analysis, and technical work.",
  "Your job is to collaborate with the user until their goal is genuinely handled.",
  "You are a curious, thoughtful collaborator and a clear communicator.",
].join(" ");

/** Whether the agent works in a workspace it shares with the user. */
export function agentSharesWorkspace(
  capabilities: ResolvedAgentCapabilities,
  resources: Pick<AgentPromptResources, "managedSandbox" | "connectedMachine">,
): boolean {
  return (
    resources.managedSandbox ||
    resources.connectedMachine ||
    capabilities.knowledge ||
    capabilities.workspaceFiles ||
    capabilities.workspaceConnectors ||
    capabilities.workspaceAdmin ||
    capabilities.artifacts ||
    capabilities.schedules ||
    capabilities.subagents ||
    capabilities.browser ||
    capabilities.secrets ||
    capabilities.skills === "manage"
  );
}

/** A legacy persona template read as identity: the CORE marker is ignored. */
export function identityFromLegacyTemplate(template: string | null | undefined): string | null {
  const identity = template?.split(AGENT_INSTRUCTIONS_CORE_PLACEHOLDER).join("").trim();
  return identity ? identity : null;
}

/**
 * Identity tiers, each replacing the next: session identity (frozen in the
 * agent configuration) → workspace identity (explicit default, else the legacy
 * `agentInstructions` persona) → a deployment persona template that differs
 * from Opengeni's default → Opengeni's default identity. Workspace governance
 * never drops a tier.
 */
export function resolveAgentIdentity(input: {
  sessionIdentity?: string | null | undefined;
  workspaceIdentity?: string | null | undefined;
  deploymentTemplate?: string | null | undefined;
  /** The last tier; Opengeni's default identity when omitted. */
  defaultIdentity?: string | undefined;
}): string {
  const session = input.sessionIdentity?.trim();
  if (session) return session;
  const workspace = identityFromLegacyTemplate(input.workspaceIdentity);
  if (workspace) return workspace;
  if (input.deploymentTemplate && input.deploymentTemplate !== DEFAULT_AGENT_INSTRUCTIONS) {
    const deployment = identityFromLegacyTemplate(input.deploymentTemplate);
    if (deployment) return deployment;
  }
  return input.defaultIdentity ?? DEFAULT_AGENT_IDENTITY;
}
