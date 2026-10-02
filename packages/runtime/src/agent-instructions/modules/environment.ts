import type { RigInstructionsContext, WorkspaceEnvironmentContext } from "../types";
import { blocks, sentences, type AgentPromptModule } from "../types";

/**
 * Rig doctrine lines. Shared with the legacy CORE, whose bytes they keep.
 */
export function rigInstructions(rig: RigInstructionsContext): string[] {
  return [
    `This session uses sandbox environment "${rig.name}" (active version v${rig.version}) — a versioned definition of custom sandbox setup and health checks.`,
    "Your sandbox is an EPHEMERAL FORK of this environment. You may install tools here, but local changes do not update the environment definition or other sessions.",
    "To make a verified setup change available to future sessions using this environment, call rig_propose_change with the exact command that already worked here. Never assume an unverified change propagates.",
    "If tooling you expect is missing, consult rig_get to see the sandbox environment's current setup and checks before reinstalling.",
  ];
}

/** Workspace environment lines (metadata only). Shared with the legacy CORE. */
export function workspaceEnvironmentInstructions(
  environment: WorkspaceEnvironmentContext,
): string[] {
  const lines = [
    `A workspace environment named "${environment.name}" is attached to this session; its variables are exported in the sandbox shell environment.`,
  ];
  const variableNames = (environment.variableNames ?? []).filter((name) => name.length > 0);
  if (variableNames.length > 0) {
    lines.push(`Exported environment variables: ${[...variableNames].sort().join(", ")}.`);
  }
  const description = environment.description?.trim();
  if (description) {
    lines.push(`Environment notes from the operator: ${description}`);
  }
  return lines;
}

export const workspaceEnvironmentModule: AgentPromptModule = {
  id: "workspace_environment",
  applies: (context) => context.resources.workspaceEnvironment !== undefined,
  render: (context) =>
    blocks(
      "# Workspace environment",
      sentences(...workspaceEnvironmentInstructions(context.resources.workspaceEnvironment!)),
    ),
};

/** The rig lines naming rig tools appear only when workspace admin tools are available. */
export const rigModule: AgentPromptModule = {
  id: "rig",
  applies: (context) => context.resources.rig !== undefined,
  render: (context) => {
    const [identity, fork, propose, consult] = rigInstructions(context.resources.rig!);
    return blocks(
      "# Sandbox environment",
      sentences(
        identity,
        fork,
        context.capabilities.workspaceAdmin && propose,
        context.capabilities.workspaceAdmin && consult,
      ),
    );
  },
};
