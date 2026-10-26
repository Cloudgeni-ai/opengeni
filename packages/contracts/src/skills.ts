import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { SKILL_MAX_FILES } from "./skill-files";
export { parseSkillFrontmatter, readSkillMetadata } from "./skill-metadata";
export * from "./skill-files";

/** Files are UTF-8 text, relative to the Skill root. No executable authority. */
export const SkillFile = /* @__PURE__ */ defineSchema(() =>
  z.object({ path: z.string().min(1).max(512), content: primitives.string }),
);
export type SkillFile = z.infer<typeof SkillFile>;
export const SkillActor = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("service"),
      subjectId: primitives.nonEmptyString,
      principalKind: z.enum(["service", "api_key", "configured_key"]),
    }),
    z.object({
      kind: z.literal("human"),
      subjectId: primitives.nonEmptyString,
      principalKind: z.literal("human_session"),
    }),
    z.object({
      kind: z.literal("agent"),
      sessionId: z.uuid(),
      turnId: z.uuid(),
      attemptId: z.uuid(),
      executionGeneration: primitives.positiveInteger,
    }),
  ]),
);
export type SkillActor = z.infer<typeof SkillActor>;
export type SkillScope = "workspace" | "organization" | "user";

/** Save a personal, workspace or organization Skill folder (`saveWorkspaceSkill`). */
export const SaveWorkspaceSkillRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: z.uuid(),
      skillId: z.uuid(),
      expectedRevisionId: z.uuid().nullable(),
      expectedScopeVersion: z.number().int().nonnegative(),
      scope: z.enum(["workspace", "organization", "user"]).default("workspace"),
      stableKey: z.string().min(1).max(96),
      files: z.array(SkillFile).max(SKILL_MAX_FILES),
      deletions: z.array(z.string().min(1).max(512)).max(SKILL_MAX_FILES).default([]),
      reason: z.string().min(1).max(2000),
    })
    .strict(),
);
export type SaveWorkspaceSkillRequest = z.infer<typeof SaveWorkspaceSkillRequest>;

/** Approve, reject or restore one Skill revision. */
export const ApplyWorkspaceSkillRevisionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      removalOperationId: z.uuid().optional(),
      operationId: z.uuid(),
      revisionId: z.uuid(),
      expectedRevisionId: z.uuid().nullable(),
      expectedScopeVersion: z.number().int().nonnegative(),
      reason: z.string().min(1).max(2000),
    })
    .strict(),
);
export type ApplyWorkspaceSkillRevisionRequest = z.infer<typeof ApplyWorkspaceSkillRevisionRequest>;

/** Permanently remove a Skill and all its saved revisions. */
export const RemoveWorkspaceSkillRequest = /* @__PURE__ */ defineSchema(() =>
  ApplyWorkspaceSkillRevisionRequest.omit({ revisionId: true, removalOperationId: true }),
);
export type RemoveWorkspaceSkillRequest = z.infer<typeof RemoveWorkspaceSkillRequest>;

export type SkillWriteContext = { accountId: string; workspaceId: string; actor: SkillActor };
export type SkillSaveInput = SkillWriteContext & {
  operationId: string;
  skillId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  stableKey: string;
  files: SkillFile[];
  scope?: SkillScope;
  reason: string;
};
export type SkillRevisionInput = SkillWriteContext & {
  removalOperationId?: string | undefined;
  operationId: string;
  skillId: string;
  revisionId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  reason: string;
};
export type SkillRemoveInput = SkillWriteContext & {
  operationId: string;
  skillId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  reason: string;
};
export type SkillInstallInput = SkillWriteContext & {
  operationId: string;
  skillFacetId: string;
  reason: string;
};
export const SkillReviewReference = /* @__PURE__ */ defineSchema(() =>
  z.object({
    removalOperationId: z.uuid().optional(),
    sourceOperationId: z.uuid(),
    skillId: z.uuid(),
    revisionId: z.uuid(),
    expectedRevisionId: z.uuid().nullable(),
    expectedScopeVersion: primitives.positiveInteger,
  }),
);
export type SkillReviewReference = z.infer<typeof SkillReviewReference>;
export function skillReviewHumanInput(skillReview: SkillReviewReference) {
  const removing = Boolean(skillReview.removalOperationId);
  return {
    questions: [
      {
        id: `skill:${skillReview.revisionId}`,
        kind: "single_select" as const,
        label: removing ? "Permanently delete this Skill?" : "Save this Skill?",
        prompt: removing
          ? "Permanently delete this Skill and all its stored revisions?"
          : "Save this exact Skill revision for this workspace?",
        helpText: removing
          ? "This cannot be undone. All stored Skill revisions will be deleted; conversations remain unchanged."
          : "Review the complete files before saving. Saving activates this revision immediately.",
        options: [
          { id: "save", label: removing ? "Permanently delete" : "Save" },
          { id: "skip", label: removing ? "Keep Skill" : "Don't save" },
        ],
        required: true,
        allowOther: false,
        skillReview,
      },
    ],
  };
}
export const SkillWriteReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    removed: primitives.optionalBoolean,
    operationId: z.uuid(),
    skillId: z.uuid(),
    revisionId: z.uuid(),
    outcome: z.enum(["applied", "pending", "preserved"]),
    decision: z.literal("rejected").optional(),
    pendingReason: z.enum(["approval", "source_finalization"]).optional(),
    skillReview: SkillReviewReference.optional(),
    replayed: primitives.boolean,
  }),
);
export type SkillWriteReceipt = z.infer<typeof SkillWriteReceipt>;
export const SkillPublicationReceipt = /* @__PURE__ */ defineSchema(() =>
  SkillWriteReceipt.extend({
    sourceOperationId: z.uuid(),
    activationEventId: z.uuid().nullable(),
  }),
);
export type SkillPublicationReceipt = z.infer<typeof SkillPublicationReceipt>;
export const SkillSourceReleaseReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    skillId: z.uuid(),
    revisionId: z.uuid().nullable(),
    disposition: z.enum(["deactivated", "preserved", "inactive"]),
    eventId: z.uuid().nullable(),
    warning: primitives.nullableString,
  }),
);
export type SkillSourceReleaseReceipt = z.infer<typeof SkillSourceReleaseReceipt>;
export type SkillRecord = {
  removalOperationId?: string | null;
  activationMode: "workspace_managed" | "session_selected";
  pendingRevisionIds: string[];
  id: string;
  stableKey: string;
  scope: SkillScope;
  scopeVersion: number;
  status: string;
  activeRevisionId: string | null;
  revisionId: string | null;
  title: string | null;
  description: string | null;
  contentHash: string | null;
  files: SkillFile[];
  source: { pluginId: string; facetKey: string; skillFacetId: string } | null;
};
