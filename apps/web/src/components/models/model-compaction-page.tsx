import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { TextInput } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import {
  filterModelGroups,
  groupModelsByProvider,
  ModelGroup,
  MODEL_LIST_SEARCH_AT,
  ModelSearchField,
} from "./model-list";
import { ModelsFormPage } from "./models-ui";
import type { OrganizationModelDefaultsState } from "./use-organization-model-defaults";

/* ----------------------------------------------------------------------------
   Context & compaction: per model, how long a chat may get before its earlier
   messages are summarized. One row per usable model, grouped like Allowed
   models. The organization sets limits once for every workspace; an empty
   field there follows the model's default. In a workspace, an empty field
   follows the organization's limit (or the model's default when it sets
   none); a number is that workspace's own limit. Choosing a limit never
   changes a chat's model.
   -------------------------------------------------------------------------- */

type CompactionPolicy = NonNullable<WorkspaceModelCatalogModel["compactionPolicy"]>;
type CompactionModel = WorkspaceModelCatalogModel & { compactionPolicy: CompactionPolicy };
/** Edits by model ID: the typed text, or null to follow the default again. */
type Draft = Record<string, string | null>;

const tokens = (value: number) => value.toLocaleString("en-US");

/** "300000", "300,000", "300 000" and "300k" all read as 300,000. */
export function parseTokenLimit(text: string): number | null {
  const compact = text
    .trim()
    .replace(/[\s,_']/g, "")
    .toLowerCase();
  const thousands = /^(\d+(?:\.\d+)?)k$/.exec(compact);
  const value = thousands
    ? Math.round(Number(thousands[1]) * 1000)
    : /^\d+$/.test(compact)
      ? Number(compact)
      : Number.NaN;
  return Number.isSafeInteger(value) ? value : null;
}

/** Why this text can't be saved as the model's limit, or null when it can. */
export function compactionLimitError(text: string, policy: CompactionPolicy): string | null {
  const value = parseTokenLimit(text);
  const minimum = Math.max(16_000, policy.minimumTokens);
  return value === null || value < minimum || value > policy.maximumTokens
    ? `Use a number from ${tokens(minimum)} to ${tokens(policy.maximumTokens)}.`
    : null;
}

/** The saved choice an edit is compared with: a number, or null for the default. */
function editedValue(text: string | null): number | null {
  return text === null ? null : parseTokenLimit(text);
}

/** What an empty field means for this model on this page, and whose value it is. */
export function inheritedLimit(
  policy: CompactionPolicy,
  organizationScope: boolean,
): { tokens: number; fromOrganization: boolean } {
  const organizationTokens = organizationScope ? null : (policy.organizationTokens ?? null);
  return organizationTokens === null
    ? { tokens: policy.defaultTokens, fromOrganization: false }
    : { tokens: organizationTokens, fromOrganization: true };
}

export function ModelCompactionPage({
  workspaceId,
  canManage,
  onClose,
  organizationName,
  organizationDefaults,
}: {
  /** The workspace whose limits this edits, or whose models the organization's limits list. */
  workspaceId: string;
  canManage: boolean;
  onClose: () => void;
  /** Names the organization whose limits a workspace follows. */
  organizationName?: string | undefined;
  /** Edit the organization's limits for every workspace instead of one workspace's. */
  organizationDefaults?: OrganizationModelDefaultsState | undefined;
}) {
  const context = useAppContext();
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const organizationScope = Boolean(organizationDefaults);
  const organizationLabel = organizationName ?? "your organization";
  // The value this page owns for a model: the organization's limit on the
  // organization's page, the workspace's own limit on a workspace's.
  const own = (model: CompactionModel): number | null =>
    organizationDefaults
      ? (organizationDefaults.defaults?.modelCompactionThresholds[model.id] ?? null)
      : model.compactionPolicy.overrideTokens;
  const [draft, setDraft] = useState<Draft>({});
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const models = useMemo(
    () =>
      catalog.models.filter(
        (model): model is CompactionModel =>
          model.compactionPolicy !== undefined && model.credentialReadiness.status === "ready",
      ),
    [catalog.models],
  );
  const groups = useMemo(() => groupModelsByProvider(models), [models]);
  const shown = filterModelGroups(groups, query);
  const changes = models.filter(
    (model) => Object.hasOwn(draft, model.id) && editedValue(draft[model.id]!) !== own(model),
  );
  const invalid = changes.some((model) => {
    const text = draft[model.id]!;
    return text !== null && compactionLimitError(text, model.compactionPolicy) !== null;
  });
  const unsupported =
    !catalog.loading &&
    catalog.models.length > 0 &&
    catalog.models.every((model) => model.compactionPolicy === undefined);
  const edit = (modelId: string, text: string | null) =>
    setDraft((current) => ({ ...current, [modelId]: text }));

  let body;
  if (organizationDefaults?.error) {
    body = (
      <ErrorMessage
        title={`Couldn’t load ${organizationLabel}’s limits.`}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void organizationDefaults.reload()}
          >
            Try again
          </Button>
        }
      >
        Nothing was changed.
      </ErrorMessage>
    );
  } else if (catalog.error) {
    body = (
      <ErrorMessage
        title="Couldn’t load this workspace’s models."
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void catalog.refresh()}>
            Try again
          </Button>
        }
      >
        Nothing was changed.
      </ErrorMessage>
    );
  } else if (unsupported) {
    body = (
      <Notice tone="waiting" title="Not available on this server yet">
        Compaction limits can be changed once this Opengeni server is updated. Until then each model
        uses its default.
      </Notice>
    );
  } else if (models.length === 0) {
    body = (
      <p className="m-0 text-sm text-fg-muted">
        Connect a subscription or API key to set limits for its models.
      </p>
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-5">
        {canManage ? null : (
          <p className="m-0 text-sm text-fg-muted">
            {organizationScope
              ? "Only organization owners and admins can change these limits."
              : "Only workspace admins can change compaction limits. Ask a workspace admin."}
          </p>
        )}
        {models.length >= MODEL_LIST_SEARCH_AT ? (
          <ModelSearchField value={query} onChange={setQuery} />
        ) : null}
        {shown.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">No models match “{query.trim()}”.</p>
        ) : (
          shown.map(([providerLabel, providerModels]) => (
            <ModelGroup key={providerLabel} label={providerLabel}>
              {providerModels.map((model) => (
                <CompactionRow
                  key={model.id}
                  model={model}
                  text={
                    Object.hasOwn(draft, model.id)
                      ? draft[model.id]!
                      : own(model) === null
                        ? null
                        : tokens(own(model)!)
                  }
                  saved={own(model)}
                  inherited={inheritedLimit(model.compactionPolicy, organizationScope)}
                  organizationLabel={organizationLabel}
                  edited={Object.hasOwn(draft, model.id)}
                  disabled={!canManage || saving}
                  onEdit={(text) => edit(model.id, text)}
                />
              ))}
            </ModelGroup>
          ))
        )}
        <p className="m-0 text-xs leading-4.5 text-fg-muted">
          {organizationScope
            ? "Changes apply from the next message in every chat, in every workspace that doesn’t set its own limit."
            : "Changes apply from the next message in every chat in this workspace."}{" "}
          The limit is checked between steps, so a single step can go past it.
        </p>
      </div>
    );
  }

  return (
    <ModelsFormPage
      title="Context & compaction"
      description={
        organizationScope
          ? "When a chat reaches a model’s limit, its earlier messages are summarized so the model can keep going. These limits apply in every workspace unless it sets its own."
          : "When a chat reaches a model’s limit, its earlier messages are summarized so the model can keep going. A lower limit costs less per message; a higher one keeps more detail."
      }
      onClose={onClose}
      loading={catalog.loading || Boolean(organizationDefaults?.loading)}
      loadingFields={4}
      submitLabel="Save"
      pendingLabel="Saving…"
      pending={saving}
      submitDisabled={!canManage || saving || changes.length === 0 || invalid}
      // Cancel and Save show only once something changed.
      className={canManage && changes.length > 0 ? undefined : "[&>form>footer]:hidden"}
      footerStart={`${changes.length} ${changes.length === 1 ? "model" : "models"} changed`}
      onSubmit={async () => {
        if (!canManage || changes.length === 0 || invalid) return false;
        const thresholds = Object.fromEntries(
          changes.map((model) => [model.id, editedValue(draft[model.id]!)]),
        );
        if (organizationDefaults) {
          setSaving(true);
          try {
            await organizationDefaults.update({ modelCompactionThresholds: thresholds });
            return true;
          } finally {
            setSaving(false);
          }
        }
        const transition = context.captureWorkspaceInvocation(workspaceId);
        if (!transition) return false;
        setSaving(true);
        try {
          const updated = await context.updateWorkspaceSettings(workspaceId, {
            modelCompactionThresholds: thresholds,
          });
          if (!context.ownsWorkspaceInvocation(workspaceId, transition)) return false;
          if (!updated)
            throw new Error(
              "Couldn’t confirm the save. Your edits are kept; reload to check the saved limits before trying again.",
            );
          return true;
        } finally {
          setSaving(false);
        }
      }}
      onSubmitted={onClose}
    >
      {body}
    </ModelsFormPage>
  );
}

/**
 * One model: its name, then the limit field. An empty field shows what it
 * follows (the organization's limit or the model's default) as its
 * placeholder; a number is this page's own limit, with what it replaces and a
 * way back to it underneath.
 */
function CompactionRow({
  model,
  text,
  saved,
  inherited,
  organizationLabel,
  edited,
  disabled,
  onEdit,
}: {
  model: CompactionModel;
  /** What the field holds: typed or saved text, or null to follow the inherited value. */
  text: string | null;
  /** This page's saved limit for the model, or null. */
  saved: number | null;
  /** What an empty field follows. */
  inherited: { tokens: number; fromOrganization: boolean };
  organizationLabel: string;
  edited: boolean;
  disabled: boolean;
  onEdit: (text: string | null) => void;
}) {
  const id = useId();
  const policy = model.compactionPolicy;
  const error = edited && text !== null ? compactionLimitError(text, policy) : null;
  const clamped =
    !edited &&
    saved !== null &&
    saved !== Math.max(0, Math.min(policy.maximumTokens, Math.floor(saved)));
  const custom = text !== null;
  const inheritedName = inherited.fromOrganization ? organizationLabel : "Default";
  return (
    <li className="flex min-h-14 min-w-0 items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={`${id}-limit`} className="block truncate text-sm text-fg" title={model.id}>
          {model.label}
          <span className="sr-only"> compaction limit in tokens</span>
        </label>
        {error ? (
          <p id={`${id}-note`} className="m-0 text-xs leading-4.5 text-danger">
            {error}
          </p>
        ) : custom ? (
          <p id={`${id}-note`} className="m-0 text-xs leading-4.5 text-fg-muted">
            {clamped
              ? `Above this model’s maximum, so ${tokens(policy.maximumTokens)} is used`
              : `${inheritedName} ${tokens(inherited.tokens)}`}
            {disabled ? null : (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => onEdit(null)}
                  className="rounded-sm font-medium text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/55"
                >
                  {inherited.fromOrganization ? `Use ${organizationLabel}’s` : "Use default"}
                  <span className="sr-only"> for {model.label}</span>
                </button>
              </>
            )}
          </p>
        ) : inherited.fromOrganization ? (
          <p id={`${id}-note`} className="m-0 text-xs leading-4.5 text-fg-muted">
            {organizationLabel}’s limit
          </p>
        ) : (
          <p id={`${id}-note`} className="sr-only">
            Follows the model’s default.
          </p>
        )}
      </div>
      <div className="relative w-36 shrink-0">
        <TextInput
          id={`${id}-limit`}
          inputMode="numeric"
          suppressAutofill
          value={text ?? ""}
          placeholder={tokens(inherited.tokens)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-note`}
          onChange={(event) => onEdit(event.target.value.trim() === "" ? null : event.target.value)}
          onBlur={() => {
            const value = text === null ? null : parseTokenLimit(text);
            if (value !== null && !error) onEdit(tokens(value));
          }}
          className="pr-14 text-right tabular-nums"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-fg-subtle"
        >
          tokens
        </span>
      </div>
    </li>
  );
}

/**
 * The Context & compaction row's value, counting the models that page lists:
 * "Model defaults", "Acme's limits" or "2 custom limits". On the
 * organization's row (`organizationLimits`), its own limits are counted.
 * Nothing until the catalog is known.
 */
export function compactionSummary(
  models: readonly WorkspaceModelCatalogModel[],
  options: {
    /** Names the organization a workspace follows. */
    organizationName?: string | undefined;
    /** The organization's own limits, for the organization's row. */
    organizationLimits?: Readonly<Record<string, number>> | undefined;
  } = {},
): string | undefined {
  const listed = models.filter(
    (model) => model.compactionPolicy && model.credentialReadiness.status === "ready",
  );
  if (listed.length === 0) return undefined;
  const limits = (count: number) => `${count} ${count === 1 ? "limit" : "limits"}`;
  if (options.organizationLimits) {
    const set = listed.filter((model) => Object.hasOwn(options.organizationLimits!, model.id));
    return set.length === 0 ? "Model defaults" : limits(set.length);
  }
  const custom = listed.filter((model) => model.compactionPolicy!.overrideTokens !== null).length;
  if (custom > 0) return `${custom} custom ${custom === 1 ? "limit" : "limits"}`;
  const followed = listed.some(
    (model) => (model.compactionPolicy!.organizationTokens ?? null) !== null,
  );
  return followed && options.organizationName
    ? `${options.organizationName}’s limits`
    : "Model defaults";
}
