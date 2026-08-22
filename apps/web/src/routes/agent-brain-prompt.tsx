import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { useAppContext } from "@/context";
import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";

type AgentBrainPromptKind = "company_profile" | "preference" | "workspace_instructions";

function promptCopy(kind: AgentBrainPromptKind): {
  label: string;
  placeholder: string;
  button: string;
  openingMessage: (request: string) => string;
  instructions: string;
} {
  if (kind === "company_profile") {
    return {
      label: "Tell OpenGeni about your company and goals",
      placeholder:
        "For example: We build OpenGeni for teams that want dependable autonomous agents. Our current goal is to make the agent brain simple and useful.",
      button: "Create with OpenGeni",
      openingMessage: (request) =>
        `Help me create or update our organization-wide company profile and goals.\n\nWhat I want agents to know:\n${request}`,
      instructions:
        "Help the user create concise organization-wide company context covering only useful identity, mission, products, customers, goals, and critical constraints. Ask only essential follow-up questions. Show the proposed profile before applying it. After explicit confirmation, use the canonical durable-learning company-profile authority tool if available. Do not save this as ordinary Memory, Documents, workspace policy, or a preference. If the write tool is unavailable, say so briefly and leave the final proposal ready for the manual editor.",
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
        "Help the user turn a natural-language request into concise global workspace instructions. Ask only essential follow-up questions. Show the proposed instructions before applying them. After explicit confirmation, use the canonical durable-learning or workspace instruction-policy tool if one is available. Never use ordinary Memory as a substitute. If the write tool is unavailable, say so briefly and leave the final proposed text ready for the manual editor.",
    };
  }
  return {
    label: "Tell OpenGeni what you want it to remember",
    placeholder:
      "For example: When giving me progress updates, lead with the outcome and keep the explanation short.",
    button: "Create with OpenGeni",
    openingMessage: (request) =>
      `Help me turn this into a reusable preference for OpenGeni agents.\n\nWhat I want:\n${request}`,
    instructions:
      "Help the user create one reusable preference. Determine whether it should be personal, workspace-wide, or organization-wide; ask only when scope is genuinely ambiguous. Propose a clear name, a short always-visible summary, and focused full instructions. Show the proposal before applying it. After explicit confirmation, use the canonical durable-learning preference tool if one is available. Never save the preference as ordinary Memory. If the write tool is unavailable, say so briefly and leave the structured proposal ready for the manual editor.",
  };
}

export function AgentBrainPrompt({
  kind,
  workspaceId,
}: {
  kind: AgentBrainPromptKind;
  workspaceId: string;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const copy = promptCopy(kind);
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const catalogSelection = useMemo(
    () =>
      resolveAgentBrainPromptModel(modelCatalog.rows, {
        model: context.model,
        reasoningEffort: context.reasoningEffort,
        latencyMode: context.latencyMode,
      }),
    [modelCatalog.rows, context.model, context.reasoningEffort, context.latencyMode],
  );
  // When the catalog fetch itself failed there is no policy verdict to act on,
  // so fall back to the context defaults (the pre-catalog behaviour) rather than
  // blocking the form; only a loaded catalog with no selectable row fails closed.
  const catalogFailed = !modelCatalog.loading && modelCatalog.error !== null;
  const modelSelection =
    catalogSelection ??
    (catalogFailed
      ? {
          model: context.model,
          reasoningEffort: context.reasoningEffort,
          latencyMode: context.latencyMode,
        }
      : null);
  const noModelAvailable = !modelCatalog.loading && !catalogFailed && catalogSelection === null;
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
        OpenGeni will ask questions if needed and show you the result before saving it.
      </p>
      {noModelAvailable ? (
        <p className="text-xs leading-5 text-status-error" role="status">
          No model is available for this workspace. Check the workspace model policy and provider
          credentials.
        </p>
      ) : null}
      {catalogFailed ? (
        <p className="flex flex-wrap items-center gap-2 text-xs leading-5 text-fg-subtle">
          <span>Could not load the workspace model catalog: {modelCatalog.error}</span>
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
