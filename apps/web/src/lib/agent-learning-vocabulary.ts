/* ----------------------------------------------------------------------------
   Agent learning in one vocabulary: Automatic, Review first, Off. Every
   surface that shows or changes whether agent changes apply right away or
   wait for an OK uses these words, including the organization identity's
   agent policy, whose stored values stay what they are (Review first is
   `suggest`).
   -------------------------------------------------------------------------- */
import type { AgentLearningMode } from "@opengeni/sdk";

import type { CompanyProfileAgentPolicyMode } from "@/types";

export const AGENT_LEARNING_TITLE = "Agent learning";

export const LEARNING_MODE_LABEL: Record<AgentLearningMode, string> = {
  automatic: "Automatic",
  review_first: "Review first",
  off: "Off",
};

export const IDENTITY_POLICY_MODE: Record<CompanyProfileAgentPolicyMode, AgentLearningMode> = {
  off: "off",
  suggest: "review_first",
  automatic: "automatic",
};

export const IDENTITY_POLICY_VALUE: Record<AgentLearningMode, CompanyProfileAgentPolicyMode> = {
  off: "off",
  review_first: "suggest",
  automatic: "automatic",
};
