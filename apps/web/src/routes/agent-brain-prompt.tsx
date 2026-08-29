import { useNavigate } from "@tanstack/react-router";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { SparklesIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "@/context";
import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";

type AgentKnowledgePromptKind = "company_profile" | "skill" | "workspace_instructions";

function promptCopy(
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
        "For example: OpenGeni builds infrastructure for teams running dependable autonomous agents. We exist to make capable agents safe and practical to operate.",
      button: "Create with OpenGeni",
      openingMessage: (request) =>
        `Help me create or update our organization identity.\n\nWho we are and why we exist:\n${request}`,
      instructions:
        "Help the user create a concise organization identity containing only identity (who the organization is) and mission (why it exists). Ask only essential follow-up questions. Products, customers, goals, constraints, strategy, and changing facts belong in organization-scoped Documents and are retrieved when relevant. Show the complete identity and mission before applying it. Use company_profile_propose, pass its humanInput payload verbatim to request_human_input, and only after the organization owner confirms Activate call company_profile_confirm. This explicit administration path is independent of workspace learning policy. Do not save identity or mission as ordinary Memory, Documents, workspace policy, or a Skill. If either company-profile tool is unavailable, say so briefly and leave the final proposal ready for an authorized governance client.",
    };
  }
  if (kind === "workspace_instructions") {
    return {
      label: "Tell OpenGeni how agents should work",
      placeholder:
        "For example: Keep updates concise, explain important decisions, and surface blockers early.",
      button: "Create with OpenGeni",
      openingMessage: (request) =>
        `Help me create or update the instructions for agents working in this workspace.\n\nWhat I want:\n${request}`,
      instructions:
        "Help the user turn a natural-language request into the shortest complete global workspace instruction: one imperative rule, normally 1–3 sentences and no more than 600 characters. Include only behavior that should apply to nearly every agent task. Remove rationale, examples, repeated defaults, and procedural detail; split unrelated rules and route conditional procedures or reusable how-to guidance to focused Skills. Route facts, decisions, incidents, bug fixes, and outcomes to retrievable Memory. Ask only essential follow-up questions and show the complete proposed instruction before applying it. When the user agrees, call remember with lane=instruction_policy and scope=workspace. Under Autonomous it may activate immediately; if it returns confirmation_required, pass its humanInput payload verbatim to request_human_input and then call remember_confirm with the returned request id. Do not duplicate the content in Memory or Skills. If the remember tools are unavailable, say so briefly and leave the final proposed text ready for the manual editor.",
    };
  }
  if (personalWorkspace) {
    return {
      label: "Describe a personal skill",
      placeholder:
        "For example: When preparing a release update, lead with the outcome, then list decisions, blockers, and the next action.",
      button: "Draft with OpenGeni",
      openingMessage: (request) =>
        `Help me draft a personal Skill for OpenGeni agents.\n\nWhat I want:\n${request}`,
      instructions:
        "Help the user draft one personal Skill: a conditional procedure or how-to that should follow this user across workspaces in the organization. Do not turn a fact, decision, incident, bug fix, or outcome into a Skill; those belong in retrievable Memory. Do not turn a universal always-on rule into a Skill; that belongs in a concise workspace instruction. Propose a clear name, a stable key, a one-sentence always-visible summary, and focused full instructions. The current agent write path is workspace-scoped and cannot safely activate a user-scoped Skill, so do not call remember or claim that you saved it. Leave the complete structured proposal ready for the user to paste into the personal manual editor on the page.",
    };
  }
  return {
    label: "Describe a reusable skill",
    placeholder:
      "For example: When preparing a release update, lead with the outcome, then list decisions, blockers, and the next action.",
    button: "Create with OpenGeni",
    openingMessage: (request) =>
      `Help me turn this into a reusable Skill for OpenGeni agents.\n\nWhat I want:\n${request}`,
    instructions:
      "Help the user create one focused reusable Skill for this workspace: a conditional procedure or how-to agents fetch when relevant. Give it a clear name, stable key, one-sentence always-visible summary, and concise full instructions with one trigger and outcome. Include only necessary prerequisites, executable steps, verification, and important failure handling; omit background, repetition, generic advice, and decorative examples, and split unrelated workflows into separate Skills. Facts, decisions, incidents, bug fixes, and outcomes belong in retrievable Memory; universal always-on rules belong in the shortest possible workspace instruction. Ask only essential follow-up questions and show the complete proposal before applying it. When the user agrees, call remember with lane=preference and scope=workspace. Under Autonomous it may activate immediately; if it returns confirmation_required, pass its humanInput payload verbatim to request_human_input and then call remember_confirm with the returned request id. The current agent path cannot activate personal or organization Skills; direct those scopes to the manual editor instead of claiming they were saved. Do not duplicate the content in Memory or workspace instructions.",
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
function useAgentBrainPromptCatalog(workspaceId: string): CatalogState & {
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

export function AgentKnowledgePrompt({
  kind,
  workspaceId,
  personalWorkspace = false,
}: {
  kind: AgentKnowledgePromptKind;
  workspaceId: string;
  personalWorkspace?: boolean;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const copy = promptCopy(kind, personalWorkspace);
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);
  const modelCatalog = useAgentBrainPromptCatalog(workspaceId);
  const modelSelection = useMemo(
    () =>
      modelCatalog.loading || modelCatalog.error
        ? null
        : resolveAgentBrainPromptModel(modelCatalog.models, {
            model: context.model,
            reasoningEffort: context.reasoningEffort,
            latencyMode: context.latencyMode,
          }),
    [
      modelCatalog.loading,
      modelCatalog.error,
      modelCatalog.models,
      context.model,
      context.reasoningEffort,
      context.latencyMode,
    ],
  );
  const noModelAvailable =
    !modelCatalog.loading && modelCatalog.error === null && modelSelection === null;
  const canSubmit =
    Boolean(request.trim()) &&
    !starting &&
    !context.busy &&
    !modelCatalog.loading &&
    modelSelection !== null;

  const start = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = request.trim();
    if (!trimmed || starting || context.busy || modelCatalog.loading || !modelSelection) return;
    setStarting(true);
    try {
      const created = await context.startSession(
        workspaceId,
        {
          text: copy.openingMessage(trimmed),
          model: modelSelection.model,
          reasoningEffort: modelSelection.reasoningEffort,
          latencyMode: modelSelection.latencyMode,
        },
        { instructions: copy.instructions },
      );
      if (created) {
        await navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId: created.id },
        });
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-surface p-4"
      onSubmit={(event) => void start(event)}
    >
      <label className="grid gap-2 text-sm font-medium text-fg">
        <span className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-brand" />
          {copy.label}
        </span>
        <textarea
          className="min-h-28 rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 text-fg outline-none focus:border-brand"
          value={request}
          placeholder={copy.placeholder}
          onChange={(event) => setRequest(event.target.value)}
        />
      </label>
      <p className="text-xs leading-5 text-fg-subtle">
        {kind === "skill" && personalWorkspace
          ? "OpenGeni will prepare the Skill; use the personal manual editor below to save it."
          : "OpenGeni will ask questions if needed and show you the result before saving it."}
      </p>
      {modelSelection ? (
        <p className="text-xs leading-5 text-fg-subtle" role="status">
          Model: <span className="font-medium text-fg">{modelSelection.label}</span>
          {" · "}
          {modelSelection.paymentSource}
        </p>
      ) : null}
      {noModelAvailable ? (
        <p className="text-xs leading-5 text-status-error" role="status">
          No model is available for this workspace. Check the workspace model policy and provider
          credentials.
        </p>
      ) : null}
      {modelCatalog.error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs leading-5 text-fg-subtle">
          <span>
            Could not resolve an allowed workspace model: {modelCatalog.error}. Retry before
            creating with OpenGeni.
          </span>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-fg hover:bg-surface-muted"
            onClick={() => void modelCatalog.refresh()}
          >
            Retry
          </button>
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!canSubmit}
        >
          {starting ? "Starting…" : copy.button}
        </button>
      </div>
    </form>
  );
}
