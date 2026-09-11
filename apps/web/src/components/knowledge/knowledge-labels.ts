import type { KnowledgeEntryKind } from "@opengeni/sdk";

export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeEntryKind, string> = {
  source: "Source text",
  fact: "Fact",
  decision: "Decision",
  requirement: "Requirement",
  incident: "Incident",
  note: "General knowledge",
  group: "Collection",
};

export const KNOWLEDGE_KIND_HELP: Record<KnowledgeEntryKind, string> = {
  source: "Saved original text, such as a contract passage or Slack conversation.",
  fact: "A specific claim, such as a customer's renewal date. This label does not mean it has been verified.",
  decision: "A choice that was made, with its reasoning when available.",
  requirement: "Something a customer, product, or system needs to do.",
  incident: "A problem or failure, including its cause, fix, and outcome when known.",
  note: "Useful context that does not need a more specific type.",
  group:
    "Related knowledge collected around a customer, product, system, or subject. Entries can appear in several collections without being copied.",
};

export const KNOWLEDGE_SOURCE_LABEL: Record<string, string> = {
  file: "File",
  slack: "Slack",
  conversation: "Conversation",
  repository: "Codebase",
  web: "Web",
  connector: "Connected source",
  manual: "Added directly",
  task_note: "Task note",
};
