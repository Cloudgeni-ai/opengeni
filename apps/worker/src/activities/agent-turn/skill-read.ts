import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  listSkillPaths,
  PORTABLE_SKILL_MAX_FILES,
  readSkillFiles,
  SKILL_READ_MAX_PATHS,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";

export const SKILL_READ_TOOL_NAME = "skill_read";

export type SkillReadContent = Readonly<{
  files: readonly SkillTextFile[];
  skillId: string;
  revisionId: string;
  scopeVersion: number;
  installationVersion?: number;
}>;

/** A first-party gateway definition, not a sandbox capability or second backend. */
export function createSkillReadAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  load: (skill: string) => Promise<readonly SkillTextFile[] | SkillReadContent>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: SKILL_READ_TOOL_NAME },
    modelName: SKILL_READ_TOOL_NAME,
    codemodePath: ["opengeni", SKILL_READ_TOOL_NAME],
    title: "Read Skill files",
    description:
      "Read Skill text without starting a sandbox. Omit paths to read SKILL.md; provide relative paths to read exactly those files, never implicitly adding SKILL.md. Set listFiles:true without paths to list relative paths and available revision identity only, with no file bodies. Use an id or name from the Skill index or skill_search. Management tools are lazy; when listed, opengeni-skills explains how to use them.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1, maxLength: 512 },
        listFiles: { type: "boolean" },
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
        (args.listFiles !== undefined && typeof args.listFiles !== "boolean") ||
        (args.paths !== undefined &&
          (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== "string")))
      ) {
        throw new Error("skill_read requires a Skill identifier and optional relative paths.");
      }
      if (args.listFiles === true && args.paths !== undefined) {
        throw new Error("skill_read listFiles:true cannot be combined with paths.");
      }
      await input.authorize();
      const loaded = await input.load(args.skill);
      const metadata = "files" in loaded ? loaded : null;
      const files = metadata ? metadata.files : (loaded as readonly SkillTextFile[]);
      const selected =
        args.listFiles === true
          ? listSkillPaths(files, PORTABLE_SKILL_MAX_FILES)
          : readSkillFiles(files, args.paths as string[] | undefined);
      const output = {
        ...(metadata
          ? {
              skillId: metadata.skillId,
              revisionId: metadata.revisionId,
              scopeVersion: metadata.scopeVersion,
              ...(metadata.installationVersion !== undefined
                ? { installationVersion: metadata.installationVersion }
                : {}),
            }
          : {}),
        ...selected,
      };
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
