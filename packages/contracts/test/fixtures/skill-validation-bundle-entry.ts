import { SkillArtifactDefinition, SessionSkill } from "../../src/index";

export const validatePackSkill = (input: unknown) => SkillArtifactDefinition.parse(input);
export const validateSessionSkill = (input: unknown) => SessionSkill.parse(input);