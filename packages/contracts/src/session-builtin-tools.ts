import { z } from "zod";

/**
 * Built-in agent tools a session (or scheduled agent config) can switch off.
 * This only narrows: the workspace settings (`agentHumanInputEnabled`,
 * `agentWebSearchEnabled`), the deployment, and the resolved model can still
 * withhold a tool a session did not disable, and nothing here can enable one.
 */
export const DisabledBuiltinTool = z.enum(["human_input", "web_search"]);
export type DisabledBuiltinTool = z.infer<typeof DisabledBuiltinTool>;

export const DisabledBuiltinTools = z
  .array(DisabledBuiltinTool)
  .max(DisabledBuiltinTool.options.length)
  .refine((ids) => new Set(ids).size === ids.length, "disabled built-in tools must be unique")
  .transform((ids) => [...ids].sort());

/** A child keeps every parent opt-out; its own request can only add more. */
export function resolveDisabledBuiltinTools(
  requested: readonly DisabledBuiltinTool[] | undefined,
  parent: readonly DisabledBuiltinTool[] | undefined,
): DisabledBuiltinTool[] | undefined {
  if (requested === undefined && parent === undefined) return undefined;
  return DisabledBuiltinTools.parse([...new Set([...(parent ?? []), ...(requested ?? [])])]);
}

// Immutable session configuration beside the bundled-Skill selection, in the
// same reserved create-identity metadata convention. Create admission always
// replaces a caller-supplied value for this key.
const DISABLED_BUILTIN_TOOLS_KEY = "_opengeni_disabled_builtin_tools_v1";

export function withDisabledBuiltinToolsMetadata(
  metadata: Record<string, unknown>,
  disabled: readonly DisabledBuiltinTool[] | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next[DISABLED_BUILTIN_TOOLS_KEY];
  if (disabled !== undefined && disabled.length > 0)
    next[DISABLED_BUILTIN_TOOLS_KEY] = DisabledBuiltinTools.parse(disabled);
  return next;
}

/** Exact stored value for keyed create replay identity. */
export function storedDisabledBuiltinToolsIdentity(metadata: Record<string, unknown>): unknown {
  return metadata[DISABLED_BUILTIN_TOOLS_KEY];
}

/**
 * Tolerant stored read: an unknown name written by a newer release is kept
 * out of the known set but can only have disabled something, never enabled.
 */
export function disabledBuiltinToolsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): DisabledBuiltinTool[] {
  const value = metadata?.[DISABLED_BUILTIN_TOOLS_KEY];
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(DisabledBuiltinTool.options);
  return [...new Set(value.filter((id): id is DisabledBuiltinTool => known.has(id)))].sort();
}
