export {
  AGENT_PROMPT_MODULES,
  MODULAR_LAYER_SEPARATOR,
  SESSION_INSTRUCTIONS_PREAMBLE,
  composeModularAgentInstructions,
  composeOperationalContract,
  type ComposeModularAgentInstructionsInput,
  type ModularInstructionLayer,
} from "./compose";
export { INSTRUCTION_PRECEDENCE, renderBaseBehavior } from "./base-behavior";
export { renderRuntimeMechanics } from "./runtime-mechanics";
export {
  DEFAULT_AGENT_IDENTITY,
  identityFromLegacyTemplate,
  resolveAgentIdentity,
} from "./identity";
export { rigInstructions, workspaceEnvironmentInstructions } from "./modules/environment";
export {
  deriveAgentPromptToolAvailability,
  type AgentPromptToolAvailabilityInput,
} from "./tool-availability";
export type {
  AgentPromptContext,
  AgentPromptModule,
  AgentPromptResources,
  AgentPromptToolAvailability,
  RigInstructionsContext,
  WorkspaceEnvironmentContext,
} from "./types";
