import type {
  AgentPromptModuleId,
  AgentRenderer,
  ResolvedAgentCapabilities,
} from "@opengeni/contracts";

/**
 * Metadata about the workspace environment attached to a run. Surfaced
 * verbatim in the agent instructions: the description is where operators
 * document how the exported credentials are meant to be used. Only metadata
 * belongs here — never variable values.
 */
export type WorkspaceEnvironmentContext = {
  name: string;
  description?: string | null;
  variableNames?: string[];
};

/** The rig (versioned sandbox environment) a session rides. */
export type RigInstructionsContext = {
  name: string;
  version: number;
};

/**
 * What the session is attached to, as far as its instructions care. Every flag
 * must be derived from session-level facts (or the exact turn's resources for
 * attachments) so the composed prefix only changes when they change.
 */
export type AgentPromptResources = {
  /** A managed (provisioned) sandbox is the active compute. */
  managedSandbox: boolean;
  /** A Connected Machine is the active compute. */
  connectedMachine: boolean;
  /** Repository resources are mounted in the workspace. */
  repositories: boolean;
  /** Git provider credentials were delivered to the sandbox. */
  gitCredentials: boolean;
  /** Files are attached (mounted) for this turn. */
  attachments: boolean;
  workspaceEnvironment?: WorkspaceEnvironmentContext | undefined;
  rig?: RigInstructionsContext | undefined;
};

/** Everything a prompt module may read. Pure data; no settings, no clock. */
export type AgentPromptContext = {
  capabilities: ResolvedAgentCapabilities;
  renderer: AgentRenderer;
  resources: AgentPromptResources;
};

/** One conditional section of the operational contract. */
export type AgentPromptModule = {
  id: AgentPromptModuleId;
  applies: (context: AgentPromptContext) => boolean;
  render: (context: AgentPromptContext) => string;
};

export function hasSandbox(context: AgentPromptContext): boolean {
  return context.resources.managedSandbox || context.resources.connectedMachine;
}

/** Joins non-empty blocks with blank lines. */
export function blocks(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
}

/** Joins non-empty sentences with single spaces. */
export function sentences(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

/** Renders a Markdown bullet list from non-empty items. */
export function bullets(...items: ReadonlyArray<string | false | null | undefined>): string {
  return items
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => `- ${item}`)
    .join("\n");
}
