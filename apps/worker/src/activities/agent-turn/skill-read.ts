import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  loadSkillManagementSkill,
  readSkillFiles,
  SKILL_READ_MAX_PATHS,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

export const SKILL_READ_TOOL_NAME = "skill_read";

/** A first-party gateway definition, not a sandbox capability or second backend. */
export function createSkillReadAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (skill: string) => Promise<readonly SkillTextFile[]>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: SKILL_READ_TOOL_NAME },
    modelName: SKILL_READ_TOOL_NAME,
    codemodePath: ["opengeni", SKILL_READ_TOOL_NAME],
    title: "Read Skill files",
    description:
      "Read Skill text without starting a sandbox. Omit paths to read SKILL.md; provide relative paths to read exactly those files, never implicitly adding SKILL.md. Read opengeni-skills to learn how to discover and use lazy Skill management tools.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1, maxLength: 512 },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: SKILL_READ_MAX_PATHS,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: {
      title: "Read Skill files",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      if (
        typeof args.skill !== "string" ||
        !args.skill ||
        (args.paths !== undefined &&
          (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== "string")))
      ) {
        throw new Error("skill_read requires a Skill identifier and optional relative paths.");
      }
      await input.authorize();
      const files =
        args.skill === "opengeni-skills" || args.skill === "builtin:opengeni-skills"
          ? loadSkillManagementSkill().files
          : await input.load(args.skill);
      const output = readSkillFiles(files, args.paths as string[] | undefined);
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
