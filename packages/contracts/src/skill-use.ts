import { z } from "zod";

/**
 * `_meta` key of the content-free Skill-use fact on a model `skill_read`
 * result. MCP `_meta` never reaches the model: it survives only into the
 * `agent.toolCall.output` event projection, never into model history.
 */
export const SKILL_USE_META_KEY = "opengeni/skillUse" as const;

/** Where the Skill a read resolved to comes from. `personal` is a user-scope Skill. */
export const SkillUseSource = z.enum([
  "builtin",
  "session",
  "workspace",
  "organization",
  "personal",
]);
export type SkillUseSource = z.infer<typeof SkillUseSource>;

/**
 * What a `skill_read` returned: `full` is the default SKILL.md read, `files`
 * explicit paths, `list` a path inventory, and `already_in_context` the short
 * repeat receipt. `refused` means the read returned an error instead of Skill
 * text; it has no result, so it appears only in metrics.
 */
export const SkillReadKind = z.enum(["full", "already_in_context", "files", "list", "refused"]);
export type SkillReadKind = z.infer<typeof SkillReadKind>;

const skillUseFields = {
  id: z.string().min(1).max(512),
  source: SkillUseSource,
  label: z.string().min(1).max(128).optional(),
  /** Whole-artifact digest, for a Skill without a ledger revision. */
  contentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  /** Ledger revision of a workspace, organization, or personal Skill. */
  revisionId: z.string().min(1).max(128).optional(),
  kind: SkillReadKind.exclude(["refused"]),
  /** UTF-8 bytes of the result text the read returned, before model tool-output truncation. */
  bytes: z.number().int().nonnegative(),
  /** The Skill appeared in the Skill index the model saw this turn. */
  inIndex: z.boolean(),
  /** skill_search returned this Skill earlier in the same turn attempt. */
  searchedThisTurn: z.boolean(),
};
const oneProvenance = (use: {
  contentSha256?: string | undefined;
  revisionId?: string | undefined;
}) => use.contentSha256 === undefined || use.revisionId === undefined;
const oneProvenanceMessage = {
  message: "A Skill use carries a content digest or a revision, not both",
};

/**
 * Ids, digests, and counts only. Never Skill text, user text, or a Skill's
 * title or description. `label` is reserved for a platform display label of a
 * built-in; user-authored Skills never set it. This is the writer's closed
 * shape: an unknown field fails the parse, so nothing else can be attached.
 */
export const SkillUse = z.strictObject(skillUseFields).refine(oneProvenance, oneProvenanceMessage);
export type SkillUse = z.infer<typeof SkillUse>;

// Stored events outlive the worker that wrote them. A reader drops fields a
// newer writer added instead of dropping the whole fact, and what it returns
// still holds only the known, content-free fields.
const StoredSkillUse = z.object(skillUseFields).refine(oneProvenance, oneProvenanceMessage);

/** The Skill-use fact on a tool result or its event projection, when present and valid. */
export function skillUseFromToolOutput(output: unknown): SkillUse | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const meta = (output as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const parsed = StoredSkillUse.safeParse((meta as Record<string, unknown>)[SKILL_USE_META_KEY]);
  return parsed.success ? parsed.data : null;
}
