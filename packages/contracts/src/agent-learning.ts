import { z } from "zod";

/** Review controls publication. It never grants content or external-action authority. */
export const AgentLearningMode = z.enum(["automatic", "review_first", "off"]);
export type AgentLearningMode = z.infer<typeof AgentLearningMode>;

export const AgentLearningCategory = z.enum(["knowledge", "instructions", "skills"]);
export type AgentLearningCategory = z.infer<typeof AgentLearningCategory>;

export const AgentLearningDefaults = z
  .object({
    knowledge: AgentLearningMode,
    instructions: AgentLearningMode,
    skills: AgentLearningMode,
  })
  .strict();
export type AgentLearningDefaults = z.infer<typeof AgentLearningDefaults>;

export const DEFAULT_AGENT_LEARNING: Readonly<AgentLearningDefaults> = Object.freeze({
  knowledge: "automatic",
  instructions: "review_first",
  skills: "review_first",
});

/** An absent category inherits. `inherit` is a reset request, not persisted policy. */
export const AgentLearningOverrides = AgentLearningDefaults.partial();
export type AgentLearningOverrides = z.infer<typeof AgentLearningOverrides>;

export const AgentLearningOverridePatch = z
  .object({
    knowledge: AgentLearningMode.or(z.literal("inherit")).optional(),
    instructions: AgentLearningMode.or(z.literal("inherit")).optional(),
    skills: AgentLearningMode.or(z.literal("inherit")).optional(),
  })
  .strict();
export type AgentLearningOverridePatch = z.infer<typeof AgentLearningOverridePatch>;

export const AgentLearningContext = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), id: z.uuid() }).strict(),
  z.object({ kind: z.literal("scheduled_task"), id: z.uuid() }).strict(),
]);
export type AgentLearningContext = z.infer<typeof AgentLearningContext>;

export const AgentLearningOwner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: z.uuid() }).strict(),
  z.object({ kind: z.literal("personal"), subjectId: z.string().min(1).max(1024) }).strict(),
]);
export type AgentLearningOwner = z.infer<typeof AgentLearningOwner>;

export const AgentLearningSettings = z
  .object({
    owner: AgentLearningOwner,
    version: z.number().int().nonnegative(),
    defaults: AgentLearningDefaults,
  })
  .strict();
export type AgentLearningSettings = z.infer<typeof AgentLearningSettings>;

export const AgentLearningContextSettings = z
  .object({
    context: AgentLearningContext,
    version: z.number().int().nonnegative(),
    overrides: AgentLearningOverrides,
  })
  .strict();
export type AgentLearningContextSettings = z.infer<typeof AgentLearningContextSettings>;

/** Versioned settings returned by both central and contextual editors. */
export const AgentLearningSettingsRecord = z.object({
  ownerKey: z.string(),
  contextKey: z.string(),
  version: z.number().int().nonnegative(),
  settings: AgentLearningOverrides,
});
export type AgentLearningSettingsRecord = z.infer<typeof AgentLearningSettingsRecord>;
export const AgentLearningOverrideRecord = z.object({
  contextKey: z.string(),
  version: z.number().int().positive(),
  settings: AgentLearningOverrides,
  updatedAt: z.string(),
  label: z.string(),
});
export type AgentLearningOverrideRecord = z.infer<typeof AgentLearningOverrideRecord>;
export type SaveAgentLearningSettingsRequest = {
  scope: "workspace" | "personal";
  source?: AgentLearningContext;
  operationId: string;
  expectedVersion: number;
  settings: AgentLearningOverridePatch;
};

export const AgentLearningEffectiveCategory = z
  .object({
    mode: AgentLearningMode,
    inherited: z.boolean(),
  })
  .strict();
export const AgentLearningEffectivePolicy = z
  .object({
    knowledge: AgentLearningEffectiveCategory,
    instructions: AgentLearningEffectiveCategory,
    skills: AgentLearningEffectiveCategory,
  })
  .strict();
export type AgentLearningEffectivePolicy = z.infer<typeof AgentLearningEffectivePolicy>;

/** Apply only at an authorized settings boundary; this function confers no authority. */
export function patchAgentLearningOverrides(
  current: AgentLearningOverrides,
  patch: AgentLearningOverridePatch,
): AgentLearningOverrides {
  const result = AgentLearningOverrides.parse(current);
  const changes = AgentLearningOverridePatch.parse(patch);
  for (const category of AgentLearningCategory.options) {
    const value = changes[category];
    if (value === "inherit") delete result[category];
    else if (value !== undefined) result[category] = value;
  }
  return result;
}

/** Pure resolution over accepted settings. Runtime callers persist the resulting snapshot. */
export function resolveAgentLearningPolicy(
  defaults: AgentLearningDefaults,
  overrides: AgentLearningOverrides,
): AgentLearningEffectivePolicy {
  const base = AgentLearningDefaults.parse(defaults);
  const context = AgentLearningOverrides.parse(overrides);
  return Object.fromEntries(
    AgentLearningCategory.options.map((category) => [
      category,
      { mode: context[category] ?? base[category], inherited: context[category] === undefined },
    ]),
  ) as AgentLearningEffectivePolicy;
}

/** Migration adapter preserves explicit opt-outs and existing instruction/Skill choices. */
export function agentLearningDefaultsFromLegacy(input: {
  memoryEnabled?: boolean;
  workspaceMode?: "off" | "suggest" | "automatic";
}): AgentLearningDefaults {
  const parsed = z
    .object({
      memoryEnabled: z.boolean().optional(),
      workspaceMode: z.enum(["off", "suggest", "automatic"]).optional(),
    })
    .strict()
    .parse(input);
  const behavior = parsed.workspaceMode ?? "suggest";
  return {
    knowledge: parsed.memoryEnabled === false ? "off" : "automatic",
    instructions: behavior === "suggest" ? "review_first" : behavior,
    skills: behavior === "suggest" ? "review_first" : behavior,
  };
}

/** Existing instruction and Skill lifecycles retain their native mode vocabulary. */
export function agentLearningDestinationMode(mode: AgentLearningMode) {
  const parsed = AgentLearningMode.parse(mode);
  return parsed === "review_first" ? ("suggest" as const) : parsed;
}
