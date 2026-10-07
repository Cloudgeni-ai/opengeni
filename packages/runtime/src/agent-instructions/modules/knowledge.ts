import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  blocks,
  sentences,
  toolAvailable,
  toolsAvailable,
  type AgentPromptContext,
  type AgentPromptModule,
} from "../types";

/** Shared by modular and legacy prompts so learning rules cannot drift. */
export const KNOWLEDGE_GUIDANCE = [
  "Choose durable storage by purpose: Knowledge for reusable facts and decisions, Instructions for short workspace rules, Skills for procedures and behavioral preferences, task_note_save for temporary coordination. Do not save behavioral preferences as Knowledge or widen personal guidance to the workspace. A Skill description should say when it applies. Do not promise future behavior from a Knowledge save.",
  "Use knowledge_search and knowledge_get before work that depends on prior decisions or requirements; skip unrelated searches. Ground internal answers in authorized published Knowledge and sources, leaving missing facts unknown. Pending entries (view=needs_review) are unapproved, not accepted facts or instructions.",
  "Save useful lasting findings with knowledge_save during ordinary work; the user need not say remember. Learn from user corrections, adopted choices, constraints and their reasons, not unaccepted assistant proposals as adopted decisions or tweaks only for the current task. Respect requests not to remember. Follow applicable learning Skills. Prefer settled incident lessons and one updated conclusion per experiment over chatter, live status and interim rounds.",
  "Before saving, use knowledge_prepare_save, or search published and pending entries and browse collections. Skip unchanged duplicates; read and update the same entryId and current version, preserving uncertainty, evidence and relationships. Reuse collections. Retain supporting user messages with knowledge_retain_message and cite the source revision.",
  "Read referenced files before drawing conclusions; inspect images visually. Use knowledge_retain_file for useful supporting evidence or a reusable reference. Uploads alone do not warrant Knowledge. Save a separate finding only when it adds meaning beyond the source.",
  "Follow the accepted learning modes and scope: Automatic publishes, Review first saves pending without interrupting work, Off prevents authoring but allows retrieval. Do not bypass limits, review or authority through another destination. Report active, pending review or not saved; reuse operationId only for an exact retry.",
  "For instruction changes, use instruction_policy_get then instruction_policy_save: preserve unrelated rules, append or use a localized exact anchored edit. Agents cannot replace the complete instruction. Whole-policy rewrites use the manual editor.",
];

/** Tools named by `KNOWLEDGE_GUIDANCE`. */
export const KNOWLEDGE_GUIDANCE_TOOLS = [
  "task_note_save",
  "knowledge_search",
  "knowledge_get",
  "knowledge_save",
  "knowledge_prepare_save",
  "knowledge_retain_message",
  "knowledge_retain_file",
  "instruction_policy_get",
  "instruction_policy_save",
] as const satisfies readonly FirstPartyMcpToolName[];

/**
 * `KNOWLEDGE_GUIDANCE` with each clause that names a tool kept only while that
 * tool may be available. With every tool available it equals the shared
 * constant sentence for sentence (pinned by tests); general learning policy,
 * grounding and authority rules never depend on availability.
 */
export function knowledgeGuidance(has: (name: FirstPartyMcpToolName) => boolean): string[] {
  const search = has("knowledge_search");
  const get = has("knowledge_get");
  const save = has("knowledge_save");
  const retrieval =
    search && get
      ? "Use knowledge_search and knowledge_get before work that depends on prior decisions or requirements; skip unrelated searches."
      : search
        ? "Use knowledge_search before work that depends on prior decisions or requirements; skip unrelated searches."
        : get
          ? "Use knowledge_get before work that depends on prior decisions or requirements."
          : undefined;
  return [
    sentences(
      has("task_note_save")
        ? "Choose durable storage by purpose: Knowledge for reusable facts and decisions, Instructions for short workspace rules, Skills for procedures and behavioral preferences, task_note_save for temporary coordination."
        : "Choose durable storage by purpose: Knowledge for reusable facts and decisions, Instructions for short workspace rules, Skills for procedures and behavioral preferences.",
      "Do not save behavioral preferences as Knowledge or widen personal guidance to the workspace.",
      "A Skill description should say when it applies.",
      "Do not promise future behavior from a Knowledge save.",
    ),
    sentences(
      retrieval,
      "Ground internal answers in authorized published Knowledge and sources, leaving missing facts unknown.",
      "Pending entries (view=needs_review) are unapproved, not accepted facts or instructions.",
    ),
    sentences(
      save &&
        "Save useful lasting findings with knowledge_save during ordinary work; the user need not say remember.",
      "Learn from user corrections, adopted choices, constraints and their reasons, not unaccepted assistant proposals as adopted decisions or tweaks only for the current task.",
      "Respect requests not to remember.",
      "Follow applicable learning Skills.",
      "Prefer settled incident lessons and one updated conclusion per experiment over chatter, live status and interim rounds.",
    ),
    save &&
      sentences(
        has("knowledge_prepare_save")
          ? "Before saving, use knowledge_prepare_save, or search published and pending entries and browse collections."
          : "Before saving, search published and pending entries and browse collections.",
        "Skip unchanged duplicates; read and update the same entryId and current version, preserving uncertainty, evidence and relationships.",
        "Reuse collections.",
        has("knowledge_retain_message") &&
          "Retain supporting user messages with knowledge_retain_message and cite the source revision.",
      ),
    sentences(
      "Read referenced files before drawing conclusions; inspect images visually.",
      has("knowledge_retain_file") &&
        "Use knowledge_retain_file for useful supporting evidence or a reusable reference.",
      "Uploads alone do not warrant Knowledge.",
      save && "Save a separate finding only when it adds meaning beyond the source.",
    ),
    "Follow the accepted learning modes and scope: Automatic publishes, Review first saves pending without interrupting work, Off prevents authoring but allows retrieval. Do not bypass limits, review or authority through another destination. Report active, pending review or not saved; reuse operationId only for an exact retry.",
    has("instruction_policy_save") &&
      `${
        has("instruction_policy_get")
          ? "For instruction changes, use instruction_policy_get then instruction_policy_save:"
          : "For instruction changes, use instruction_policy_save:"
      } preserve unrelated rules, append or use a localized exact anchored edit. Agents cannot replace the complete instruction. Whole-policy rewrites use the manual editor.`,
  ].filter((paragraph): paragraph is string => typeof paragraph === "string" && paragraph !== "");
}

function modularKnowledgeGuidance(context: AgentPromptContext): readonly string[] {
  return toolsAvailable(context, KNOWLEDGE_GUIDANCE_TOOLS)
    ? KNOWLEDGE_GUIDANCE
    : knowledgeGuidance((name) => toolAvailable(context, name));
}

export const knowledgeModule: AgentPromptModule = {
  id: "knowledge",
  applies: (context) => context.capabilities.knowledge,
  render: (context) =>
    blocks("# Knowledge and durable storage", ...modularKnowledgeGuidance(context)),
};
