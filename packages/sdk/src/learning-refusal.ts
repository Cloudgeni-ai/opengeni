/**
 * Browser-safe reader for the learning-refusal fact: a refused Skill,
 * workspace instruction, or Knowledge change carries it on its tool result
 * so a timeline can tell the person it was not saved and why.
 */
export {
  learningRefusalFromToolOutput,
  type LearningRefusal,
} from "@opengeni/contracts/learning-refusal";
