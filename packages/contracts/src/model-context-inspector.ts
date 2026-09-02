import { z } from "zod";

export const MODEL_CONTEXT_SNAPSHOT_VERSION = 1 as const;
export const MODEL_CONTEXT_INSTRUCTIONS_MAX_UTF8_BYTES = 8 * 1024 * 1024;
export const MODEL_CONTEXT_SNAPSHOT_MAX_UTF8_BYTES = 16 * 1024 * 1024;
export const MODEL_CONTEXT_LAYER_MAX_COUNT = 16;
export const MODEL_CONTEXT_TOOL_MAX_COUNT = 2_048;
export const MODEL_CONTEXT_SKILL_MAX_COUNT = 1_024;

export const ModelContextInstructionLayerId = z.enum([
  "operational_contract",
  "persona_and_core",
  "workspace_governance",
  "session_instructions",
  "workspace_memory",
  "codemode",
  "git_bindings",
  "genesis_title",
  "sdk_capability_instructions",
]);
export type ModelContextInstructionLayerId = z.infer<typeof ModelContextInstructionLayerId>;

export const ModelContextInstructionLayer = z
  .object({
    id: ModelContextInstructionLayerId,
    title: z.string().min(1).max(120),
    content: z.string(),
    utf8Bytes: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
  })
  .strict();
export type ModelContextInstructionLayer = z.infer<typeof ModelContextInstructionLayer>;

export const ModelContextToolVisibility = z.enum(["eager", "searchable"]);
export type ModelContextToolVisibility = z.infer<typeof ModelContextToolVisibility>;

export const ModelContextTool = z
  .object({
    name: z.string().min(1).max(256),
    type: z.string().min(1).max(64),
    visibility: ModelContextToolVisibility,
    description: z.string().max(16_384).optional(),
    namespace: z.string().max(256).optional(),
    schema: z.unknown().optional(),
    utf8Bytes: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
  })
  .strict();
export type ModelContextTool = z.infer<typeof ModelContextTool>;

export const ModelContextSkillKind = z.enum([
  "preference_descriptor",
  "runtime_skill",
  "native_tool_skill",
]);
export type ModelContextSkillKind = z.infer<typeof ModelContextSkillKind>;

export const ModelContextSkill = z
  .object({
    kind: ModelContextSkillKind,
    name: z.string().min(1).max(128),
    description: z.string().max(8_192),
    source: z.string().max(64).optional(),
    path: z.string().max(1_024).optional(),
  })
  .strict();
export type ModelContextSkill = z.infer<typeof ModelContextSkill>;

export const ModelContextTokenCounts = z
  .object({
    instructions: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    prefix: z.number().int().nonnegative(),
  })
  .strict();
export type ModelContextTokenCounts = z.infer<typeof ModelContextTokenCounts>;

export const ModelContextSnapshot = z
  .object({
    version: z.literal(MODEL_CONTEXT_SNAPSHOT_VERSION),
    capturedAt: z.string().datetime(),
    source: z.literal("model_request"),
    requestIndex: z.number().int().nonnegative(),
    instructions: z.string(),
    layers: z.array(ModelContextInstructionLayer).max(MODEL_CONTEXT_LAYER_MAX_COUNT),
    tools: z.array(ModelContextTool).max(MODEL_CONTEXT_TOOL_MAX_COUNT),
    skills: z.array(ModelContextSkill).max(MODEL_CONTEXT_SKILL_MAX_COUNT),
    tokens: ModelContextTokenCounts,
  })
  .strict();
export type ModelContextSnapshot = z.infer<typeof ModelContextSnapshot>;

export const SessionModelContextResponse = z
  .object({
    sessionId: z.string().uuid(),
    attemptId: z.string().uuid().nullable(),
    turnId: z.string().uuid().nullable(),
    snapshot: ModelContextSnapshot.nullable(),
  })
  .strict();
export type SessionModelContextResponse = z.infer<typeof SessionModelContextResponse>;
