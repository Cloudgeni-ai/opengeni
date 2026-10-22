import type { RigInstructionsContext } from "../types";
import { blocks, sentences, toolAvailable, type AgentPromptModule } from "../types";

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

/**
 * The rig lines naming rig tools appear only when workspace admin tools are
 * available and the attempt has not proved the named tool absent.
 */
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
        context.capabilities.workspaceAdmin &&
          toolAvailable(context, "rig_propose_change") &&
          propose,
        context.capabilities.workspaceAdmin && toolAvailable(context, "rig_get") && consult,
      ),
    );
  },
};
