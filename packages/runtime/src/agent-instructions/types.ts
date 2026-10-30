import type {
  AgentPromptModuleId,
  AgentRenderer,
  FirstPartyMcpToolName,
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
 * Which GitHub identity one mounted repository acts as. `personal` is the
 * person's own account (Git through the personal broker, github_personal__*
 * tools); `app` is the workspace Opengeni GitHub App bot.
 */
export type AgentPromptRepositoryIdentity = {
  /** Mount path relative to the workspace, e.g. repos/github.com/acme/web. */
  path: string;
  identity: "personal" | "app";
  /** The person's GitHub login, when known (personal only). */
  login?: string | undefined;
};

/**
 * What the session is attached to, as far as its instructions care. Every flag
 * must be derived from session-level facts so the composed prefix only changes
 * when they change. Per-turn resources (file attachments) must never appear
 * here: they are described by the turn's own notice at the end of the input.
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
  /**
   * The runtime resolves `{{secret:…}}` references for this attempt. Gates
   * the secrets prompt module; omitted keeps prompts unchanged.
   */
  secretReferences?: boolean | undefined;
  /**
   * No person will see or answer a question until the task ends (frozen at
   * session create). Gates the unattended module; omitted keeps prompts unchanged.
   */
  unattended?: boolean | undefined;
  /**
   * Personal GitHub sign-in ("Your GitHub") is enabled on this deployment.
   * Gates personal-identity guidance; omitted keeps prompts unchanged.
   */
  personalGitHub?: boolean | undefined;
  workspaceEnvironment?: WorkspaceEnvironmentContext | undefined;
  rig?: RigInstructionsContext | undefined;
  /**
   * GitHub identity per mounted GitHub repository (session-level). Omitted
   * keeps the repositories module unchanged.
   */
  repositoryIdentities?: readonly AgentPromptRepositoryIdentity[] | undefined;
};

/** Everything a prompt module may read. Pure data; no settings, no clock. */
export type AgentPromptContext = {
  capabilities: ResolvedAgentCapabilities;
  renderer: AgentRenderer;
  resources: AgentPromptResources;
  /**
   * Frozen per-attempt tool availability. Omitted means unknown: every
   * tool-specific clause renders exactly as before.
   */
  toolAvailability?: AgentPromptToolAvailability | undefined;
  /** Deployment prompt experiments; omitted renders the default prompt byte for byte. */
  experiments?: AgentPromptExperiments | undefined;
};

/** Opt-in prompt variants for A/B evaluation, set from deployment settings. */
export type AgentPromptExperiments = {
  /** OPENGENI_EXPERIMENT_KNOWLEDGE_RETRIEVAL_GUIDANCE */
  knowledgeRetrievalGuidance?: boolean | undefined;
};

/**
 * Which tool-specific instruction clauses may render for one attempt. A
 * rendering input only: it never grants, withholds, defers or reorders a tool.
 *
 * `unavailable` lists only tool names proven absent for the attempt (see
 * `deriveAgentPromptToolAvailability`). Every other name — deferred or lazily
 * disclosed, external MCP, provider-hosted, local adapter, or unknown — counts
 * as available, so its guidance stays.
 */
export type AgentPromptToolAvailability = {
  readonly unavailable: readonly FirstPartyMcpToolName[];
};

/** False only when the attempt proved the named tool absent. */
export function toolAvailable(context: AgentPromptContext, name: FirstPartyMcpToolName): boolean {
  return !context.toolAvailability?.unavailable.includes(name);
}

/** True when none of the named tools was proven absent. */
export function toolsAvailable(
  context: AgentPromptContext,
  names: readonly FirstPartyMcpToolName[],
): boolean {
  return names.every((name) => toolAvailable(context, name));
}

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
