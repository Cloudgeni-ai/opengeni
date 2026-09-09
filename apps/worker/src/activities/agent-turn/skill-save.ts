import type { AttemptToolDefinition } from "@opengeni/codemode";
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
      "Create or edit a workspace Skill without a sandbox. Supply only changed UTF-8 text files and explicit deletions; omitted files are preserved. Use the revision and scope version returned by Skill discovery for stale-write protection. For creation choose a new UUID, set expectedRevisionId to null and expectedScopeVersion to 1. Learning mode determines whether the change is live, pending approval, or refused. If humanInput is returned, call request_human_input verbatim, Save activates the exact reviewed revision as the answer is accepted. Do not ask for a second review or call a separate activation tool.",
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
      const skillId = args.skillId as string;
      const expectedRevisionId = args.expectedRevisionId as string | null;
      // Expand the edit against its immutable base, not today's head. The
      // lifecycle can then replay an already committed operation before CAS.
      const current =
        expectedRevisionId === null ? null : await input.load(skillId, expectedRevisionId);
      if (current && current.revisionId !== expectedRevisionId) {
        throw new Error("Skill edit base did not match the requested revision.");
      }
      const files = applySkillFileChanges(
        current?.files ?? [],
        args.files as SkillTextFile[],
        (args.deletions ?? []) as string[],
      );
      const artifact = buildPortableSkillArtifact(files);
      const output = await input.save({
        operationId: args.operationId as string,
        skillId,
        expectedRevisionId,
        expectedScopeVersion: args.expectedScopeVersion as number,
        files: artifact.files,
        reason: args.reason as string,
      });
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
