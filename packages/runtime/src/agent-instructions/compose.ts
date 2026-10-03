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
import type { AgentPromptContext, AgentPromptModule, AgentPromptResources } from "./types";

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
  /** Per-attempt runtime directives, each already gated by its caller. */
  codemode?: string | undefined;
  codeSearch?: string | undefined;
  gitBindings?: string | undefined;
  /** Rendered Skill index, only when it is not delivered in conversation history. */
  skillCatalog?: string | undefined;
  workspaceGovernance?: string | undefined;
  workspaceMemory?: string | undefined;
  sessionInstructions?: string | undefined;
};

export const MODULAR_LAYER_SEPARATOR = "\n\n";

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
export function composeOperationalContract(context: AgentPromptContext): {
  content: string;
  modules: ModelContextInstructionModule[];
} {
  const sections: Array<{ id: ModelContextInstructionModule["id"]; text: string }> = [
    { id: "base_behavior", text: renderBaseBehavior(context) },
    { id: "runtime_mechanics", text: renderRuntimeMechanics(context) },
  ];
  for (const module of AGENT_PROMPT_MODULES) {
    if (!module.applies(context)) continue;
    const text = module.render(context).trim();
    if (text) sections.push({ id: module.id, text });
  }
  return {
    content: sections.map((section) => section.text).join(MODULAR_LAYER_SEPARATOR),
    modules: sections.map((section) => ({ id: section.id, chars: section.text.length })),
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
} {
  const contract = composeOperationalContract({
    capabilities: input.capabilities,
    renderer: input.renderer,
    resources: input.resources,
  });
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
  return {
    layers,
    composed: layers.map((layer) => `${layer.joinBefore}${layer.content}`).join(""),
  };
}
