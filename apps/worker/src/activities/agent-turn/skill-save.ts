import type { AttemptToolDefinition } from "@opengeni/codemode";
import { z } from "zod";
import {
  applySkillFileChanges,
  buildPortableSkillArtifact,
  PORTABLE_SKILL_MAX_FILES,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

export type SkillSaveRequest = {
  operationId: string;
  skillId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  files: readonly SkillTextFile[];
  reason: string;
};

export type SkillSaveReceipt = {
  operationId: string;
  skillId: string;
  revisionId: string;
  outcome: "applied" | "pending" | "preserved";
  replayed: boolean;
};

const skillSaveArguments = z
  .object({
    operationId: z.uuid(),
    skillId: z.uuid(),
    expectedRevisionId: z.uuid().nullable(),
    expectedScopeVersion: z.number().int().nonnegative(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            content: z.string(),
          })
          .strict(),
      )
      .max(PORTABLE_SKILL_MAX_FILES),
    deletions: z.array(z.string().min(1).max(1024)).max(PORTABLE_SKILL_MAX_FILES).optional(),
    reason: z.string().min(1).max(2000),
  })
  .strict();

/** Persistence owns mode enforcement, replay, and the final compare-and-swap. */
export function createSkillSaveAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (
    skillId: string,
    revisionId: string,
  ) => Promise<{
    revisionId: string;
    files: readonly SkillTextFile[];
  }>;
  save: (request: SkillSaveRequest) => Promise<SkillSaveReceipt>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_save" },
    modelName: "skill_save",
    codemodePath: ["opengeni", "skill_save"],
    title: "Save Skill text",
    description:
      "Create or edit a Skill for reusable procedures or context-specific and personal behavioral preferences, not retrieval-only facts. Put its applicability in the SKILL.md description so the prompt index can guide skill_read; the full body is loaded when relevant. Short always-on workspace rules use instruction_policy_save. Supply only changed UTF-8 text files and explicit deletions; omitted files are preserved. No sandbox is needed. Use the revision and scope version returned by Skill discovery for stale-write protection. For creation choose a new UUID, set expectedRevisionId to null and expectedScopeVersion to 1. The effective Skills setting governs publication: Automatic publishes, Review first saves a pending revision in Knowledge > Needs review while the task continues, and Off prevents agent authoring. Report the actual receipt without asking an approval question. Private chats save personal Skills; shared chats save workspace Skills. Preserve the intended scope; another destination is not a workaround for unavailable scope or learning restrictions.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string", format: "uuid" },
        skillId: { type: "string", format: "uuid" },
        expectedRevisionId: { type: ["string", "null"], format: "uuid" },
        expectedScopeVersion: { type: "integer", minimum: 0 },
        files: {
          type: "array",
          maxItems: PORTABLE_SKILL_MAX_FILES,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1, maxLength: 1024 },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        deletions: {
          type: "array",
          maxItems: PORTABLE_SKILL_MAX_FILES,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 1024 },
        },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: [
        "operationId",
        "skillId",
        "expectedRevisionId",
        "expectedScopeVersion",
        "files",
        "reason",
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Save Skill text",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await input.authorize();
      // Some model calls stringify JSON null. Normalize only this nullable
      // creation sentinel, then validate before any revision lookup or write.
      // Missing, empty and malformed IDs must not silently become creation.
      const request = skillSaveArguments.parse({
        ...args,
        expectedRevisionId: args.expectedRevisionId === "null" ? null : args.expectedRevisionId,
      });
      const { skillId, expectedRevisionId } = request;
      // Expand the edit against its immutable base, not today's head. The
      // lifecycle can then replay an already committed operation before CAS.
      const current =
        expectedRevisionId === null ? null : await input.load(skillId, expectedRevisionId);
      if (current && current.revisionId !== expectedRevisionId) {
        throw new Error("Skill edit base did not match the requested revision.");
      }
      const files = applySkillFileChanges(
        current?.files ?? [],
        request.files,
        request.deletions ?? [],
      );
      const artifact = buildPortableSkillArtifact(files);
      const output = await input.save({
        operationId: request.operationId,
        skillId,
        expectedRevisionId,
        expectedScopeVersion: request.expectedScopeVersion,
        files: artifact.files,
        reason: request.reason,
      });
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
