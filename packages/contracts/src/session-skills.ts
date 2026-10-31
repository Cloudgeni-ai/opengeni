import { z } from "zod";
import { defineSchema } from "./define-schema";
import { string as contractString } from "./primitives";
import { isSafeSkillRelativePath, validateSkillTextFiles, SKILL_MAX_FILES, SKILL_MAX_FILE_BYTES } from "./skill-files";
import { readSkillMetadata } from "./skill-metadata";

function defineSkillContractSchema<Schema>(factory: () => Schema): Schema {
  return factory();
}

export const SkillArtifactFile = defineSchema(() =>
  z.object({
    path: z.string().min(1).max(512).refine(isSafeSkillRelativePath, {
      message: "skill file path must be a safe relative POSIX path without '..' segments",
    }),
    content: contractString.max(SKILL_MAX_FILE_BYTES),
  }),
);
export type SkillArtifactFile = z.infer<typeof SkillArtifactFile>;

export const SkillArtifactDefinition = defineSkillContractSchema(() =>
  z
    .object({
      name: z.string().min(1).max(64).optional(),
      description: z.string().min(1).max(1024).optional(),
      activationMode: z.enum(["workspace_managed", "session_selected"]).optional(),
      files: z.array(SkillArtifactFile).min(1).max(SKILL_MAX_FILES),
    })
    .transform((skill, ctx) => {
      const main = skill.files.find((file) => file.path === "SKILL.md");
      if (!main) {
        ctx.addIssue({ code: "custom", message: "skill must include a top-level SKILL.md file", path: ["files"] });
        return z.NEVER;
      }
      try {
        validateSkillTextFiles(skill.files);
        const metadata = readSkillMetadata(main.content);
        for (const key of ["name", "description"] as const) {
          if (skill[key] !== undefined && skill[key] !== metadata[key])
            ctx.addIssue({ code: "custom", message: `Skill ${key} must match SKILL.md frontmatter`, path: [key] });
        }
        return { ...skill, ...metadata };
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid Skill frontmatter", path: ["files"] });
        return z.NEVER;
      }
    }),
);
export type SkillArtifactDefinition = z.infer<typeof SkillArtifactDefinition>;
export type SkillArtifactDefinitionInput = z.input<typeof SkillArtifactDefinition>;

export const SessionSkill = defineSkillContractSchema(() =>
  SkillArtifactDefinition.transform(({ activationMode: _activationMode, ...skill }) => skill),
);
export type SessionSkill = z.infer<typeof SessionSkill>;
export type SessionSkillInput = z.input<typeof SessionSkill>;

export const SessionSkills = defineSkillContractSchema(() =>
  z.array(SessionSkill).max(32).transform((skills, ctx) => {
    const selected = new Map<string, { fingerprint: string; skill: SessionSkill }>();
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      const fingerprint = JSON.stringify({
        description: skill.description ?? null,
        files: [...skill.files].sort((left, right) => left.path.localeCompare(right.path)).map(({ path, content }) => ({ path, content })),
      });
      const existing = selected.get(key);
      if (!existing) selected.set(key, { fingerprint, skill });
      else if (existing.fingerprint !== fingerprint) ctx.addIssue({ code: "custom", message: `conflicting session skill definitions: ${skill.name}` });
    }
    return [...selected.values()].map(({ skill }) => skill);
  }),
);

