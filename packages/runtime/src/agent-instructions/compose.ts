import type {
  ModelContextInstructionLayerId,
  ModelContextInstructionModule,
  ResolvedAgentCapabilities,
  AgentRenderer,
} from "@opengeni/contracts";
import { renderBaseBehavior } from "./base-behavior";
import { renderRuntimeMechanics } from "./runtime-mechanics";
import { adminModule } from "./modules/admin";
import { artifactsModule } from "./modules/artifacts";
import { attachmentsModule } from "./modules/attachments";
import { rigModule, workspaceEnvironmentModule } from "./modules/environment";
import { goalsModule } from "./modules/goals";
import { knowledgeModule } from "./modules/knowledge";
import { connectedMachineModule } from "./modules/machines";
import { mediaModule } from "./modules/media";
import { rendererMarkdownModule } from "./modules/renderer-markdown";
import { repositoriesModule } from "./modules/repositories";
import { sandboxModule } from "./modules/sandbox";
import { skillsModule } from "./modules/skills";
import { subagentsModule } from "./modules/subagents";
import type {
  AgentPromptContext,
  AgentPromptModule,
  AgentPromptResources,
  AgentPromptToolAvailability,
} from "./types";

/**
 * Conditional modules in composition order. Session-stable modules first;
 * `attachments` (per turn) last so a file attachment changes as little of the
 * cached prefix as possible.
 */
export const AGENT_PROMPT_MODULES: readonly AgentPromptModule[] = [
  rendererMarkdownModule,
  sandboxModule,
  connectedMachineModule,
  repositoriesModule,
  workspaceEnvironmentModule,
  rigModule,
  artifactsModule,
  mediaModule,
  goalsModule,
  subagentsModule,
  knowledgeModule,
  skillsModule,
  adminModule,
  attachmentsModule,
];

export type ModularInstructionLayer = {
  id: ModelContextInstructionLayerId;
  title: string;
  content: string;
  modules?: readonly ModelContextInstructionModule[];
  /** Separator placed before this layer when layers are joined. */
  joinBefore: string;
};

export type ComposeModularAgentInstructionsInput = {
  capabilities: ResolvedAgentCapabilities;
  renderer: AgentRenderer;
  /** The resolved identity (see `resolveAgentIdentity`). */
  identity: string;
  resources: AgentPromptResources;
  /**
   * Frozen per-attempt tool availability (a rendering input, never authority).
   * Omitted keeps every tool-specific clause, byte for byte.
   */
  toolAvailability?: AgentPromptToolAvailability | undefined;
  /** Per-attempt runtime directives, each already gated by its caller. */
  codemode?: string | undefined;
  codeSearch?: string | undefined;
  gitBindings?: string | undefined;
  /** Rendered Skill index, only when it is not delivered in conversation history. */
  skillCatalog?: string | undefined;
  workspaceGovernance?: string | undefined;
  workspaceMemory?: string | undefined;
  sessionInstructions?: string | undefined;
  /**
   * Experiment (OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT): render the
   * workspace- and turn-specific contract modules last and return the
   * session-independent `stablePrefix` so a provider can cache it on its own.
   */
  stablePrefix?: boolean | undefined;
};

export const MODULAR_LAYER_SEPARATOR = "\n\n";

/**
 * Contract modules whose text depends on the workspace (environment name,
 * variables, sandbox environment) or the turn (attachments). Under the
 * stable-prefix experiment they follow every other module.
 */
const VOLATILE_CONTRACT_MODULE_IDS: ReadonlySet<AgentPromptModule["id"]> = new Set([
  "workspace_environment",
  "rig",
  "attachments",
]);

/**
 * Heads the session instructions so the precedence rule has a concrete target
 * right where the instructions are, at the end of the prompt.
 */
export const SESSION_INSTRUCTIONS_PREAMBLE =
  "# Session instructions\n\nThese instructions were set for this session. Follow them over the default behavior above, such as tone, length, and format.\n\n";

/**
 * The operational contract for a session with an agent configuration: base
 * behavior and runtime mechanics (always), then every module whose capability
 * or resource is present. Pure and deterministic: the same configuration and
 * resources always produce the same bytes.
 */
export function composeOperationalContract(
  context: AgentPromptContext,
  options: { volatileModulesLast?: boolean } = {},
): {
  content: string;
  modules: ModelContextInstructionModule[];
  /** With `volatileModulesLast`: the content before the first volatile module. */
  stableContent?: string;
} {
  const sections: Array<{ id: ModelContextInstructionModule["id"]; text: string }> = [
    { id: "base_behavior", text: renderBaseBehavior(context) },
    { id: "runtime_mechanics", text: renderRuntimeMechanics(context) },
  ];
  const volatile: typeof sections = [];
  for (const module of AGENT_PROMPT_MODULES) {
    if (!module.applies(context)) continue;
    const text = module.render(context).trim();
    if (!text) continue;
    if (options.volatileModulesLast && VOLATILE_CONTRACT_MODULE_IDS.has(module.id))
      volatile.push({ id: module.id, text });
    else sections.push({ id: module.id, text });
  }
  const join = (parts: typeof sections) =>
    parts.map((section) => section.text).join(MODULAR_LAYER_SEPARATOR);
  const all = [...sections, ...volatile];
  return {
    content: join(all),
    modules: all.map((section) => ({ id: section.id, chars: section.text.length })),
    ...(options.volatileModulesLast ? { stableContent: join(sections) } : {}),
  };
}

/**
 * Layer order: identity → operational contract (base, mechanics, modules) →
 * attempt directives → Skill index → workspace governance → historical memory →
 * session instructions. Everything up to the directives is the stable,
 * cache-friendly prefix; governance and session text follow it, and session
 * instructions come last so they refine everything above.
 */
export function composeModularAgentInstructions(input: ComposeModularAgentInstructionsInput): {
  layers: ModularInstructionLayer[];
  composed: string;
  /**
   * Only with `input.stablePrefix`: the leading part of `composed` that holds
   * no workspace-, session- or turn-specific text (identity, the contract's
   * session-independent modules, then the Codemode/code-search directives when
   * no volatile module sits between). Undefined when it would be empty.
   */
  stablePrefix?: string;
} {
  const contract = composeOperationalContract(
    {
      capabilities: input.capabilities,
      renderer: input.renderer,
      resources: input.resources,
      ...(input.toolAvailability ? { toolAvailability: input.toolAvailability } : {}),
    },
    { volatileModulesLast: input.stablePrefix === true },
  );
  const layers: ModularInstructionLayer[] = [
    { id: "identity", title: "Identity", content: input.identity.trim(), joinBefore: "" },
    {
      id: "operational_contract",
      title: "Operational contract",
      content: contract.content,
      modules: contract.modules,
      joinBefore: MODULAR_LAYER_SEPARATOR,
    },
  ];
  const push = (id: ModelContextInstructionLayerId, title: string, content?: string) => {
    const trimmed = content?.trim();
    if (!trimmed) return;
    layers.push({ id, title, content: trimmed, joinBefore: MODULAR_LAYER_SEPARATOR });
  };
  push("codemode", "Codemode", input.codemode);
  push("code_search", "Code search", input.codeSearch);
  push("git_bindings", "Git credential bindings", input.gitBindings);
  push("skill_catalog", "Skills", input.skillCatalog);
  push("workspace_governance", "Workspace governance", input.workspaceGovernance);
  push("workspace_memory", "Workspace memory", input.workspaceMemory);
  const session = input.sessionInstructions?.trim();
  if (session) {
    push(
      "session_instructions",
      "Session instructions",
      `${SESSION_INSTRUCTIONS_PREAMBLE}${session}`,
    );
  }
  const composed = layers.map((layer) => `${layer.joinBefore}${layer.content}`).join("");
  if (contract.stableContent === undefined) return { layers, composed };
  let stablePrefix = `${layers[0]!.content}${MODULAR_LAYER_SEPARATOR}${contract.stableContent}`;
  if (contract.stableContent === contract.content) {
    // Deployment-level directives whose presence follows the agent configuration.
    for (const layer of layers.slice(2)) {
      if (layer.id !== "codemode" && layer.id !== "code_search") break;
      stablePrefix += `${layer.joinBefore}${layer.content}`;
    }
  }
  return composed.startsWith(stablePrefix) && stablePrefix.trim()
    ? { layers, composed, stablePrefix }
    : { layers, composed };
}
