import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "@/context";

export type AgentKnowledgePromptKind = "company_profile" | "skill" | "workspace_instructions";

export function promptCopy(
  kind: AgentKnowledgePromptKind,
  personalWorkspace: boolean,
): {
  label: string;
  placeholder: string;
  button: string;
  openingMessage: (request: string) => string;
  instructions: string;
} {
  if (kind === "company_profile") {
    return {
      label: "Describe your organization",
      placeholder:
        "For example: Opengeni builds infrastructure for teams running dependable autonomous agents. We exist to make capable agents safe and practical to operate.",
      button: "Create with Opengeni",
      openingMessage: (request) =>
        `Help me create or update our organization identity.\n\nWho we are and why we exist:\n${request}`,
      instructions:
        "Help the user create a concise organization identity containing only identity (who the organization is) and mission (why it exists). Ask only essential follow-up questions. Products, customers, goals, constraints, strategy, and changing facts belong in organization Knowledge and are retrieved when relevant. Show the complete identity and mission before applying it. Use company_profile_propose. If it returns activated, report the applied change without asking again. If it returns confirmation_required, pass its humanInput payload verbatim to request_human_input and only after the organization owner confirms Activate call company_profile_confirm. This explicit administration path follows the organization-level Agent-managed identity mode and is independent of workspace learning policy. Do not save identity or mission as ordinary Knowledge, workspace policy, or a Skill. If the company-profile tools are unavailable, say so briefly and leave the final proposal ready for an authorized governance client.",
    };
  }
  if (kind === "workspace_instructions") {
    return {
      label: "Tell Opengeni how agents should work",
      placeholder:
        "For example: Keep updates concise, explain important decisions, and surface blockers early.",
      button: "Create with Opengeni",
      openingMessage: (request) =>
        `Help me create or update the instructions for agents working in this workspace.\n\nWhat I want:\n${request}`,
      instructions:
        "Help the user turn a natural-language request into the shortest useful global workspace instruction: one imperative rule, normally 1–3 sentences. Use the same size limit as the manual editor. Include only behavior that should apply to nearly every agent task. Remove rationale, examples, repeated defaults, and procedural detail; split unrelated rules and route conditional procedures or reusable how-to guidance to focused Skills. Route facts, decisions, incidents, bug fixes, and outcomes to retrievable Knowledge. Ask only essential follow-up questions. Before every change, read the current instruction and activation version with instruction_policy_get. Preserve every unrelated existing command exactly: use instruction_policy_save with editMode=append for a new rule, or edit with one localized exact oldText match for an update or removal. Agents cannot replace the complete instruction; direct a whole-policy rewrite to the manual editor. Use the exact baseline returned by the read. Agent learning settings govern publication: Automatic activates it, Review first saves a pending revision without interrupting the chat, and Off prevents agent changes. Report the actual receipt and direct pending changes to Knowledge > Review. Do not ask a second approval question. Do not duplicate the content in Knowledge or Skills. If the instruction tools are unavailable, say so briefly and leave the final proposed text ready for the manual editor.",
    };
  }
  if (personalWorkspace) {
    return {
      label: "Describe a personal skill",
      placeholder:
        "For example: When preparing a release update, lead with the outcome, then list decisions, blockers, and the next action.",
      button: "Create with Opengeni",
      openingMessage: (request) =>
        `Help me create or update a personal Skill for Opengeni agents.\n\nWhat I want:\n${request}`,
      instructions:
        "Help the user draft one personal Skill: a conditional procedure or how-to that should follow this user across workspaces in the organization. Do not turn a fact, decision, incident, bug fix, or outcome into a Skill; those belong in retrievable Knowledge. Do not turn a universal always-on rule into a Skill; that belongs in a concise workspace instruction. Propose a clear name, a stable key, a one-sentence always-visible summary, and focused full instructions. Use skill_read and skill_save in this personal workspace to save the Skill for the initiating user. Its name and description belong in SKILL.md frontmatter. Follow the effective Skills setting: Automatic publishes, Review first retains a pending revision in Knowledge > Review while the chat continues, and Off prevents agent authoring. Report the actual saved or pending receipt without asking another approval question.",
    };
  }
  return {
    label: "Describe a reusable skill",
    placeholder:
      "For example: When preparing a release update, lead with the outcome, then list decisions, blockers, and the next action.",
    button: "Create with Opengeni",
    openingMessage: (request) =>
      `Help me turn this into a reusable Skill for Opengeni agents.\n\nWhat I want:\n${request}`,
    instructions:
      "Help the user create one focused reusable Skill for this workspace: a conditional procedure or how-to agents fetch when relevant. A Skill is a folder containing SKILL.md and optional supporting text files. Give it a clear name, stable key, one-sentence always-visible summary, and concise full instructions with one trigger and outcome. Include only necessary prerequisites, executable steps, verification, and important failure handling; omit background, repetition, generic advice, and decorative examples, and split unrelated workflows into separate Skills. Facts, decisions, incidents, bug fixes, and outcomes belong in retrievable Knowledge; universal always-on rules belong in the shortest possible workspace instruction. Use skill_read for existing content and discover the lazy skill_save tool to create or update files without a sandbox. Read opengeni-skills when it is listed for the detailed workflow. Agent learning settings govern the write: Automatic publishes a valid authorized change, Review first leaves it pending in Knowledge > Review while the chat continues, and Off prevents agent authoring. Report the actual receipt; do not call remember, remember_confirm, or a confirmation-question tool for Skill writes, and do not treat a user request as a settings override. A private chat or personal workspace saves personal Skills for its initiating user; a shared chat saves workspace Skills. Organization Skill administration remains in its authorized manual editor. Do not duplicate the content in Knowledge or workspace instructions.",
  };
}

type CatalogState = {
  workspaceId: string;
  models: WorkspaceModelCatalogModel[];
  loading: boolean;
  error: string | null;
};

/**
 * Workspace model catalog for the prompt. This deliberately calls the SDK
 * client directly instead of reusing the shared `useWorkspaceModelCatalog`
 * hook: that hook imports the model-policy picker helpers, and a new edge to
 * them from this lazy route re-buckets rolldown's entry-aware session chunks
 * and drags the composer stack into the startup graph.
 */
export function useAgentBrainPromptCatalog(workspaceId: string): CatalogState & {
  refresh: () => Promise<void>;
} {
  const client = useAppContext().client;
  const [state, setState] = useState<CatalogState>({
    workspaceId,
    models: [],
    loading: true,
    error: null,
  });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ workspaceId, models: [], loading: true, error: null });
    void (async () => {
      try {
        const response = await client.getWorkspaceModelCatalog(workspaceId);
        if (!cancelled) {
          setState({ workspaceId, models: response.models, loading: false, error: null });
        }
      } catch (caught) {
        if (!cancelled) {
          setState({
            workspaceId,
            models: [],
            loading: false,
            error: caught instanceof Error ? caught.message : String(caught),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, refreshToken]);

  const refresh = useCallback(async () => {
    setRefreshToken((token) => token + 1);
  }, []);

  return state.workspaceId === workspaceId
    ? { ...state, refresh }
    : { workspaceId, models: [], loading: true, error: null, refresh };
}
