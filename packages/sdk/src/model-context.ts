export type ModelContextInstructionLayerId =
  | "operational_contract"
  | "persona_and_core"
  | "workspace_governance"
  | "session_instructions"
  | "workspace_memory"
  | "codemode"
  | "git_bindings"
  | "genesis_title"
  | "sdk_capability_instructions"
  | "sandbox_preamble"
  | "sandbox_filesystem"
  | "sent_system_instructions";

export type ModelContextInstructionLayer = {
  id: ModelContextInstructionLayerId;
  title: string;
  content: string;
  utf8Bytes: number;
  estimatedTokens: number;
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
