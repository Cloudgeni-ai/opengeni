import type { LearningRefusal } from "@opengeni/sdk/learning-refusal";
import type { OpenGeniText } from "../messages/runtime";

/** Where the notice links: the item, its list, or Agent learning settings. */
export type LearningRefusalPlace =
  | { kind: "skill"; skillId: string }
  | { kind: "skills" }
  | { kind: "instructions" }
  | { kind: "knowledge" }
  | { kind: "learning-settings" };

export function learningRefusalTitle(t: OpenGeniText, refusal: LearningRefusal): string {
  return refusal.destination === "skill"
    ? t("timeline.learningRefusal.notSavedToSkills")
    : refusal.destination === "instruction"
      ? t("timeline.learningRefusal.notSavedToWorkspaceInstructions")
      : t("timeline.learningRefusal.notSavedToKnowledge");
}

/** Why it was not saved and what would make it work, in plain words. */
export function learningRefusalBody(t: OpenGeniText, refusal: LearningRefusal): string {
  if (refusal.reason === "site_agent") return t("timeline.learningRefusal.siteAgent");
  const off = refusal.reason === "learning_off";
  switch (refusal.destination) {
    case "skill":
      return off
        ? t("timeline.learningRefusal.skillLearningOff")
        : t("timeline.learningRefusal.skillNotPermitted");
    case "instruction":
      return off
        ? t("timeline.learningRefusal.instructionLearningOff")
        : t("timeline.learningRefusal.instructionNotPermitted");
    case "knowledge":
      return off
        ? t("timeline.learningRefusal.knowledgeLearningOff")
        : t("timeline.learningRefusal.knowledgeNotPermitted");
  }
}

/** The canonical plain-text sentence for consumers without the structured row. */
export function learningRefusalText(t: OpenGeniText, refusal: LearningRefusal): string {
  return `${learningRefusalTitle(t, refusal)}. ${learningRefusalBody(t, refusal)}`;
}

/** The one place the row links to, or null when no person can act on it. */
export function learningRefusalPlace(refusal: LearningRefusal): LearningRefusalPlace | null {
  if (refusal.reason === "site_agent") return null;
  if (refusal.reason === "learning_off") return { kind: "learning-settings" };
  if (refusal.destination === "instruction") return { kind: "instructions" };
  if (refusal.destination === "knowledge") return { kind: "knowledge" };
  return refusal.skillId ? { kind: "skill", skillId: refusal.skillId } : { kind: "skills" };
}

export function learningRefusalPlaceLabel(t: OpenGeniText, place: LearningRefusalPlace): string {
  switch (place.kind) {
    case "skill":
      return t("timeline.learningRefusal.openSkill");
    case "skills":
      return t("timeline.learningRefusal.openSkills");
    case "instructions":
      return t("timeline.learningRefusal.openWorkspaceInstructions");
    case "knowledge":
      return t("timeline.learningRefusal.openKnowledge");
    case "learning-settings":
      return t("timeline.learningRefusal.agentLearningSettings");
  }
}
