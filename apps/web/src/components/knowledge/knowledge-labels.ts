import type { KnowledgeEntryKind, KnowledgeEntryScope } from "@opengeni/sdk";
import { BookOpenIcon, FileTextIcon, FolderIcon, type LucideIcon } from "lucide-react";

export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeEntryKind, string> = {
  source: "File",
  fact: "Fact",
  decision: "Decision",
  requirement: "Requirement",
  incident: "Incident",
  note: "General",
  group: "Collection",
};

/**
 * The tile marks the kind of object: a collection, a file, or an entry. Types
 * of entry (Fact, Decision, Incident) share the entry tile and are a quiet
 * word in the meta line, never an icon each.
 */
export function knowledgeKindIcon(kind: KnowledgeEntryKind): LucideIcon {
  if (kind === "group") return FolderIcon;
  if (kind === "source") return FileTextIcon;
  return BookOpenIcon;
}

/** The types people pick when they add or edit an entry, most common first. */
export const KNOWLEDGE_PICKABLE_KINDS = [
  "note",
  "fact",
  "decision",
  "requirement",
  "incident",
] as const satisfies readonly KnowledgeEntryKind[];

export const KNOWLEDGE_KIND_HELP: Record<KnowledgeEntryKind, string> = {
  source: "Saved original text, such as a contract passage or Slack conversation.",
  fact: "A specific detail, such as a customer's renewal date.",
  decision: "A choice that was made, with its reasoning when available.",
  requirement: "Something a customer, product, or system needs to do.",
  incident: "A problem or failure, including its cause, fix, and outcome when known.",
  note: "Useful context that does not need a more specific type.",
  group:
    "Related knowledge collected around a customer, product, system, or subject. Entries can appear in several collections without being copied.",
};

export const KNOWLEDGE_SCOPE_LABEL: Record<KnowledgeEntryScope, string> = {
  workspace: "Workspace",
  personal: "Only me",
  organization: "Organization",
};

export const KNOWLEDGE_SOURCE_LABEL: Record<string, string> = {
  file: "File",
  slack: "Slack",
  conversation: "Chat",
  repository: "Codebase",
  web: "Web",
  connector: "Connected source",
  manual: "Added directly",
  task_note: "Task note",
};
