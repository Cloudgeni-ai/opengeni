export type ModelContextInstructionLayerId =
  | "operational_contract"
  | "persona_and_core"
  | "workspace_governance"
  | "session_instructions"
  | "workspace_memory"
  | "skill_catalog"
  | "codemode"
  | "code_search"
  | "git_bindings"
  | "builtin_skills"
  | "genesis_title"
  | "sdk_capability_instructions"
  | "sandbox_preamble"
  | "sandbox_filesystem"
  | "sent_system_instructions"
  | "identity";

/** Sections of a modular operational contract, in composition order. */
export type AgentPromptModuleId =
  | "base_behavior"
  | "runtime_mechanics"
  | "renderer_markdown"
  | "sandbox"
  | "connected_machine"
  | "repositories"
  | "workspace_environment"
  | "rig"
  | "artifacts"
  | "goals"
  | "subagents"
  | "knowledge"
  | "skills"
  | "admin"
  | "attachments";

export type ModelContextInstructionModule = {
  id: AgentPromptModuleId;
  chars: number;
};

export type ModelContextInstructionLayer = {
  id: ModelContextInstructionLayerId;
  title: string;
  content: string;
  utf8Bytes: number;
  estimatedTokens: number;
  /** Present on the operational contract of sessions with an agent configuration. */
  modules?: ModelContextInstructionModule[] | undefined;
};

export type ModelContextToolVisibility = "eager" | "searchable";

export type ModelContextTool = {
  name: string;
  type: string;
  visibility: ModelContextToolVisibility;
  description?: string | undefined;
  namespace?: string | undefined;
  schema?: unknown | undefined;
  utf8Bytes: number;
  estimatedTokens: number;
};

export type ModelContextSkillKind = "preference_descriptor" | "runtime_skill" | "native_tool_skill";

export type ModelContextSkill = {
  kind: ModelContextSkillKind;
  name: string;
  description: string;
  source?: string | undefined;
  path?: string | undefined;
};

export type ModelContextTokenCounts = {
  instructions: number;
  tools: number;
  prefix: number;
};

export type ModelContextSnapshot = {
  providerRequest?:
    | {
        provider: string;
        body: string | null;
        unavailableReason?: string | undefined;
        parts: {
          key: string;
          estimatedTokens: number | null;
          utf8Bytes: number;
          itemEstimatedTokens?: (number | null)[] | undefined;
        }[];
      }
    | undefined;
  version: 1;
  capturedAt: string;
  source: "model_request";
  requestIndex: number;
  instructions: string;
  layers: ModelContextInstructionLayer[];
  tools: ModelContextTool[];
  skills: ModelContextSkill[];
  tokens: ModelContextTokenCounts;
};

export type SessionModelContextResponse = {
  sessionId: string;
  attemptId: string | null;
  turnId: string | null;
  snapshot: ModelContextSnapshot | null;
};
