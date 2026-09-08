import type { ReasoningEffort, TurnSubmission } from "@/types";
export {
  ARTIFACT_CREATE_PERMISSIONS,
  ARTIFACT_EDIT_PERMISSIONS,
  ARTIFACT_CREATE_TOOLS,
  ARTIFACT_EDIT_TOOLS,
  artifactCreateOpeningMessage,
  artifactCreateInstructions,
  artifactEditOpeningMessage,
  artifactEditInstructions,
} from "@opengeni/sdk";

/** Apply the actor's durable new-session model preference without replacing an explicit choice. */
export function applyNewSessionModelPreference(
  submission: TurnSubmission,
  preference: { model: string; reasoningEffort: ReasoningEffort },
): TurnSubmission {
  return {
    ...submission,
    model: submission.model ?? preference.model,
    reasoningEffort: submission.reasoningEffort ?? preference.reasoningEffort,
  };
}
