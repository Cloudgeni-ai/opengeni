import { CapabilityPackSkill, SessionSkill } from "../../src/index";

export const validatePackSkill = (input: unknown) => CapabilityPackSkill.parse(input);
export const validateSessionSkill = (input: unknown) => SessionSkill.parse(input);