import type { LatencyMode, ReasoningEffort, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "@/context";

type OrganizationKnowledgeModelSelection = {
  model: string;
  label: string;
  paymentSource: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

function paymentSourceFor(model: WorkspaceModelCatalogModel): string {
  if (model.source === "codex") return "Codex subscription";
  if (model.source === "supergrok") return "SuperGrok subscription";
  if (model.source === "workspace_gateway") return "Workspace AI Gateway";
  if (model.source === "opengeni" || model.billing?.metering === "opengeni_credits") {
    return "OpenGeni credits";
  }
  if (model.billing?.upstreamPayer === "connected_subscription") {
    return model.credentialSource?.kind === "connected_subscription" &&
      model.credentialSource.provider === "xai"
      ? "SuperGrok subscription"
      : "Codex subscription";
  }
  if (model.billing?.upstreamPayer === "workspace") return "Workspace AI Gateway";
  return "External provider";
}

/** Kept route-local so organization settings cannot re-bucket the session chunk graph. */
function resolveOrganizationKnowledgeModel(
  models: WorkspaceModelCatalogModel[],
  preferred: {
    model: string;
    reasoningEffort: ReasoningEffort;
    latencyMode: LatencyMode;
  },
): OrganizationKnowledgeModelSelection | null {
  const preferredModel = models.find((model) => model.id === preferred.model);
  const model = preferredModel?.availability.selectable
    ? preferredModel
    : models.find((candidate) => candidate.availability.selectable);
  if (!model) return null;

  const configuredEfforts = model.capabilities?.reasoning.efforts;
  const efforts: ReasoningEffort[] =
    configuredEfforts && configuredEfforts.length > 0 ? configuredEfforts : ["low"];
  const configuredDefault = model.capabilities?.reasoning.defaultEffort;
  const reasoningEffort = efforts.includes(preferred.reasoningEffort)
    ? preferred.reasoningEffort
    : configuredDefault && efforts.includes(configuredDefault)
      ? configuredDefault
      : (efforts[0] ?? "low");
  const latencyMode: LatencyMode =
    preferred.latencyMode !== "standard" &&
    (model.capabilities?.latencyModes ?? []).some(
      (mode) => mode.id === preferred.latencyMode && mode.runnable,
    )
      ? preferred.latencyMode
      : "standard";

  return {
    model: model.id,
    label: model.label,
    paymentSource: paymentSourceFor(model),
    reasoningEffort,
    latencyMode,
  };
}

type CatalogState = {
  models: WorkspaceModelCatalogModel[];
  loading: boolean;
  error: string | null;
};

function useOrganizationKnowledgeCatalog(workspaceId: string): CatalogState & {
  refresh: () => void;
} {
  const client = useAppContext().client;
  const [state, setState] = useState<CatalogState>({ models: [], loading: true, error: null });
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ models: [], loading: true, error: null });
    void client
      .getWorkspaceModelCatalog(workspaceId)
      .then((response) => {
        if (!cancelled) setState({ models: response.models, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            models: [],
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, refreshToken, workspaceId]);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);
  return { ...state, refresh };
}

export function OrganizationKnowledgePrompt({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const catalog = useOrganizationKnowledgeCatalog(workspaceId);
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);
  const modelSelection = useMemo(
    () =>
      catalog.loading || catalog.error
        ? null
        : resolveOrganizationKnowledgeModel(catalog.models, {
            model: context.model,
            reasoningEffort: context.reasoningEffort,
            latencyMode: context.latencyMode,
          }),
    [
      catalog.error,
      catalog.loading,
      catalog.models,
      context.latencyMode,
      context.model,
      context.reasoningEffort,
    ],
  );
  const noModelAvailable = !catalog.loading && catalog.error === null && modelSelection === null;
  const canSubmit =
    Boolean(request.trim()) && !starting && !context.busy && modelSelection !== null;

  const start = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = request.trim();
    if (!trimmed || !modelSelection || starting || context.busy) return;
    setStarting(true);
    try {
      const created = await context.startSession(
        workspaceId,
        {
          text: `Help me create or update our organization identity.\n\nWho we are and why we exist:\n${trimmed}`,
          model: modelSelection.model,
          reasoningEffort: modelSelection.reasoningEffort,
          latencyMode: modelSelection.latencyMode,
        },
        {
          instructions:
            "Help the user create a concise organization identity containing only identity (who the organization is) and mission (why it exists). Ask only essential follow-up questions and do not expand this into products, customers, goals, constraints, strategy, procedures, or a general company summary. Those changing or detailed facts belong in organization-scoped Documents and should be retrieved when relevant, not injected into every agent prompt. Show the complete proposed identity and mission before applying it. Use company_profile_propose, pass its humanInput payload verbatim to request_human_input, and only after the organization owner confirms Activate call company_profile_confirm. This explicit administration path is independent of workspace learning policy. Do not save identity or mission as ordinary Memory, Documents, workspace policy, or a Skill. If either company-profile tool is unavailable, say so briefly and leave the final proposal ready for an authorized governance client.",
        },
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
          Describe your organization
        </span>
        <textarea
          className="min-h-28 rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 text-fg outline-none focus:border-brand"
          value={request}
          placeholder="For example: OpenGeni builds infrastructure for teams running dependable autonomous agents. We exist to make capable agents safe and practical to operate."
          onChange={(event) => setRequest(event.target.value)}
        />
      </label>
      <p className="text-xs leading-5 text-fg-subtle">
        OpenGeni will keep this to identity and mission, ask questions only if needed, and show you
        the complete version before saving it.
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
      {catalog.error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs leading-5 text-fg-subtle">
          <span>Could not resolve an allowed workspace model: {catalog.error}.</span>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-fg hover:bg-surface-muted"
            onClick={catalog.refresh}
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
          {starting ? "Starting…" : "Create with OpenGeni"}
        </button>
      </div>
    </form>
  );
}
