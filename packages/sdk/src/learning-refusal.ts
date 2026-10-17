/**
 * Browser-safe reader for the learning-refusal fact: a refused Skill,
 * workspace instruction, or Knowledge change carries it on its tool result
 * so a timeline can tell the person it was not saved and why.
 */
export {
  LEARNING_REFUSAL_DESTINATIONS,
  LEARNING_REFUSAL_META_KEY,
  LEARNING_REFUSAL_REASONS,
  learningRefusalFromToolOutput,
  type LearningRefusal,
  type LearningRefusalDestination,
  type LearningRefusalReason,
} from "@opengeni/contracts/learning-refusal";
