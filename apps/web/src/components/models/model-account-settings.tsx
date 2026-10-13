import type {
  ModelAccountSettingSource,
  ModelAccountSettingValues,
  ModelAccountSettingsOverview,
  UpdateOrganizationModelAccountSettingsRequest,
  UpdateWorkspaceModelAccountSettingsRequest,
  WorkspaceModelAccountSettings,
} from "@opengeni/sdk";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import { SettingRow, SettingRowGroup, SettingRowLink } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FallbackOrderControl, RotationControl } from "./model-account-policy-controls";

/* ----------------------------------------------------------------------------
   Account rules: how the organization's model accounts are used. The
   organization sets each rule; a shared workspace can change a rule for
   itself unless the organization locked it. Every value is resolved by the
   server (`subscription_effective_settings`); this file only shows what it
   returns and where each value comes from.
   -------------------------------------------------------------------------- */

/** The rules on these pages, in order. `providers` is changed on each provider's own page. */
export type AccountRule =
  | "rotation"
  | "personalConnectionsAllowed"
  | "personalFallbackAllowed"
  | "crossProviderFailover";

type SwitchRule = Exclude<AccountRule, "rotation">;

const RULES: Record<AccountRule, { label: string; column: string; description: string }> = {
  rotation: {
    label: "Sharing work between accounts",
    column: "Sharing work",
    description: "Keep work on a primary account or share it across eligible accounts.",
  },
  personalConnectionsAllowed: {
    label: "Personal accounts",
    column: "Personal accounts",
    description: "People can connect their own subscriptions for their own chats.",
  },
  personalFallbackAllowed: {
    label: "Fall back to personal accounts",
    column: "Personal fallback",
    description: "Allow people to opt in to using their own account when shared accounts run out.",
  },
  crossProviderFailover: {
    label: "Switch provider when accounts run out",
    column: "Failover",
    description: "Continue on the next model in the fallback order.",
  },
};

const ORDER: AccountRule[] = [
  "rotation",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
  "crossProviderFailover",
];

/** "Spread work", "Primary only" or "Mixed" across providers. */
export function rotationSummary(rotation: ModelAccountSettingValues["rotation"]): string {
  const modes = new Set(Object.values(rotation).map((entry) => entry.mode));
  if (modes.size > 1) return "Mixed";
  return modes.has("primary_first") ? "Primary only" : "Spread work";
}

function ruleValue(rule: AccountRule, values: ModelAccountSettingValues): string {
  if (rule === "rotation") return rotationSummary(values.rotation);
  return values[rule] ? "On" : "Off";
}

const modelId = (id: string) => id;

/** "Opus → Sonnet → GPT-6.1 Sol"; one line per preferred model. */
function fallbackLines(
  order: Record<string, string[]>,
  modelLabel: (id: string) => string,
): string[] {
  return Object.entries(order).map(([model, fallbacks]) =>
    [model, ...fallbacks].map(modelLabel).join(" → "),
  );
}

function failureMessage(caught: unknown): string {
  const details = (caught as { details?: { reason?: unknown } } | null)?.details;
  if (details?.reason === "setting_locked") return "Your organization locked this setting.";
  if (details?.reason === "version_conflict")
    return "Someone else changed this. Reload and try again.";
  return caught instanceof Error ? caught.message : "Couldn’t save the change.";
}

/* ----------------------------------------------------------------------------
   Organization: its rules with locks, and every workspace's effective rules.
   -------------------------------------------------------------------------- */

export type ModelAccountSettingsOverviewState = {
  overview: ModelAccountSettingsOverview | null;
  loading: boolean;
  error: Error | null;
  /** The rule being saved, if any. */
  saving: string | null;
  reload: () => Promise<void>;
  update: (key: string, request: UpdateOrganizationModelAccountSettingsRequest) => Promise<void>;
  loadingMore?: boolean;
  loadMore?: () => Promise<void>;
};

/** The organization's rules and the first page of its workspaces. Owners and admins only. */
export function useModelAccountSettingsOverview(
  organizationId: string | undefined,
  enabled: boolean,
): ModelAccountSettingsOverviewState {
  const client = useAppContext().client;
  const [overview, setOverview] = useState<ModelAccountSettingsOverview | null>(null);
  const [loading, setLoading] = useState(enabled && Boolean(organizationId));
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const generation = useRef(0);
  const contextGeneration = useRef(0);
  const savingRef = useRef(false);
  const pagingRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    pagingRef.current = false;
    setLoadingMore(false);
    if (!enabled || !organizationId) {
      setOverview(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loaded = await client.getModelAccountSettingsOverview(organizationId);
      if (current === generation.current) setOverview(loaded);
    } catch (caught) {
      if (current === generation.current) {
        setOverview(null);
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, enabled, organizationId]);

  useEffect(() => {
    contextGeneration.current += 1;
    setOverview(null);
    savingRef.current = false;
    setSaving(null);
    void reload();
    return () => {
      generation.current += 1;
      contextGeneration.current += 1;
    };
  }, [reload]);

  const loadMore = useCallback(async () => {
    const after = overview?.nextCursor;
    if (!enabled || !organizationId || !after || pagingRef.current || savingRef.current) return;
    const current = generation.current;
    pagingRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await client.getModelAccountSettingsOverview(organizationId, { after });
      if (current !== generation.current) return;
      // An organization policy change invalidates the whole mixed-page view.
      if (page.organization.version !== overview.organization.version) {
        await reload();
        return;
      }
      setOverview((previous) =>
        previous?.nextCursor === after
          ? {
              ...previous,
              workspaces: [
                ...new Map(
                  [...previous.workspaces, ...page.workspaces].map((row) => [row.workspaceId, row]),
                ).values(),
              ],
              nextCursor: page.nextCursor,
            }
          : previous,
      );
    } catch (caught) {
      if (current === generation.current)
        setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (current === generation.current) {
        pagingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [client, enabled, organizationId, overview, reload]);

  const update = useCallback(
    async (key: string, request: UpdateOrganizationModelAccountSettingsRequest) => {
      if (!enabled || !organizationId || !overview || savingRef.current) return;
      const current = generation.current;
      const context = contextGeneration.current;
      savingRef.current = true;
      setSaving(key);
      try {
        await client.updateOrganizationModelAccountSettings(organizationId, {
          ...request,
          expectedVersion: overview.organization.version,
        });
        // Locking clears workspace overrides: re-read every workspace.
        if (current === generation.current) await reload();
      } catch (caught) {
        if (current === generation.current) toast.error(failureMessage(caught));
      } finally {
        if (context === contextGeneration.current) {
          savingRef.current = false;
          setSaving(null);
        }
      }
    },
    [client, enabled, organizationId, overview, reload],
  );

  return { overview, loading, error, saving, reload, update, loadingMore, loadMore };
}

/** The organization's rules, each with its lock. */
export function OrganizationAccountRulesSection({
  organizationName,
  state,
  modelLabel = modelId,
}: {
  organizationName: string;
  state: ModelAccountSettingsOverviewState;
  /** A model's name, for the fallback order. */
  modelLabel?: (id: string) => string;
}) {
  const organization = state.overview?.organization;
  return (
    <Section
      title="Account rules"
      description="Workspaces follow these unless their admins change them. Locked rules can’t be changed."
    >
      {state.error && !organization ? (
        <ErrorMessage
          title={`Couldn’t load ${organizationName}’s account rules.`}
          action={<RowButton onClick={() => void state.reload()}>Try again</RowButton>}
        >
          Nothing was changed.
        </ErrorMessage>
      ) : !organization ? (
        <RowList label="Account rules" flush>
          <ListRowSkeleton count={3} />
        </RowList>
      ) : (
        <SettingRowGroup>
          {ORDER.map((rule) => {
            const locked = organization.locked.includes(rule);
            const toggleLock = () =>
              void state.update(`lock:${rule}`, {
                locked: locked
                  ? organization.locked.filter((key) => key !== rule)
                  : [...organization.locked, rule],
              });
            const lockHint = (
              <SettingRowLink disabled={state.saving !== null} onClick={toggleLock}>
                {locked ? <LockIcon aria-hidden="true" className="size-3" /> : null}
                {locked ? "Locked · Unlock" : "Lock for every workspace"}
              </SettingRowLink>
            );
            if (rule === "rotation") {
              return (
                <SettingRow
                  key={rule}
                  label={RULES.rotation.label}
                  description={RULES.rotation.description}
                  hint={lockHint}
                  control={
                    <RotationControl
                      rotation={organization.values.rotation}
                      disabled={state.saving !== null}
                      onSave={(provider, mode) =>
                        state.update("rotation", { rotation: { [provider]: { mode } } })
                      }
                    />
                  }
                />
              );
            }
            const row = (
              <SettingRow
                key={rule}
                label={RULES[rule].label}
                description={RULES[rule].description}
                hint={lockHint}
                controlWidth="compact"
                control={
                  <Switch
                    checked={organization.values[rule]}
                    pending={state.saving === rule}
                    disabled={state.saving !== null && state.saving !== rule}
                    onCheckedChange={(checked) => void state.update(rule, { [rule]: checked })}
                  />
                }
              />
            );
            if (rule !== "crossProviderFailover") return row;
            const lines = fallbackLines(organization.values.fallbackOrder, modelLabel);
            return (
              <SettingRow
                key={rule}
                label={RULES[rule].label}
                description={
                  lines.length > 0 ? (
                    <>
                      {RULES[rule].description}
                      {lines.map((line) => (
                        <span key={line} className="block text-fg-subtle">
                          {line}
                        </span>
                      ))}
                    </>
                  ) : (
                    "No fallback order yet, so work waits for an account of the same provider."
                  )
                }
                hint={lockHint}
                controlWidth="compact"
                control={
                  <Switch
                    checked={organization.values.crossProviderFailover}
                    pending={state.saving === rule}
                    disabled={state.saving !== null && state.saving !== rule}
                    onCheckedChange={(checked) =>
                      void state.update(rule, { crossProviderFailover: checked })
                    }
                  />
                }
              />
            );
          })}
          <SettingRow
            label="Fallback order"
            description="Choose the exact models to try, in order."
            hint={
              <SettingRowLink
                disabled={state.saving !== null}
                onClick={() =>
                  void state.update("lock:fallbackOrder", {
                    locked: organization.locked.includes("fallbackOrder")
                      ? organization.locked.filter((key) => key !== "fallbackOrder")
                      : [...organization.locked, "fallbackOrder"],
                  })
                }
              >
                {organization.locked.includes("fallbackOrder")
                  ? "Locked · Unlock"
                  : "Lock for every workspace"}
              </SettingRowLink>
            }
            control={
              <FallbackOrderControl
                order={organization.values.fallbackOrder}
                modelLabel={modelLabel}
                saving={state.saving !== null}
                onSave={(model, fallbacks) =>
                  state.update("fallbackOrder", {
                    fallbackOrder: { ...organization.values.fallbackOrder, [model]: fallbacks },
                  })
                }
              />
            }
          />
        </SettingRowGroup>
      )}
    </Section>
  );
}

/** Wide lists: name, one column per rule, then the chevron. Narrow lists stack the rules two by two. */
const OVERVIEW_GRID =
  "grid grid-cols-2 gap-x-3 gap-y-2 @[640px]/rules:grid-cols-[minmax(0,1fr)_repeat(4,7.5rem)_1rem] @[640px]/rules:items-center";

function SourcedValue({
  value,
  source,
  organizationName,
}: {
  value: string;
  source: ModelAccountSettingSource;
  organizationName: string;
}) {
  if (source === "locked") {
    return (
      <span className="inline-flex items-center gap-1">
        {value}
        <LockIcon aria-hidden="true" className="size-3 text-fg-subtle" />
        <span className="sr-only">{`, locked by ${organizationName}`}</span>
      </span>
    );
  }
  if (source === "workspace") {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-fg">
        {value}
        <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
        <span className="sr-only">, set by this workspace</span>
      </span>
    );
  }
  return (
    <span className="text-fg-muted">
      {value}
      <span className="sr-only">{`, follows ${organizationName}`}</span>
    </span>
  );
}

/** Every shared workspace with each effective rule and where it comes from. */
export function AccountRulesOverviewSection({
  organizationName,
  state,
  onOpenWorkspace,
  modelLabel = modelId,
}: {
  organizationName: string;
  state: ModelAccountSettingsOverviewState;
  onOpenWorkspace: (workspaceId: string) => void;
  modelLabel?: (id: string) => string;
}) {
  const overview = state.overview;
  if (!overview) return null;
  return (
    <Section title="Account rules by workspace">
      <div className="@container/rules -mx-3 min-w-0">
        <div
          aria-hidden="true"
          className={cn(
            OVERVIEW_GRID,
            "hidden border-b border-border px-3 pb-2 text-xs leading-4 font-medium text-fg-subtle @[640px]/rules:grid",
          )}
        >
          <span>Workspace</span>
          {ORDER.map((rule) => (
            <span key={rule}>{RULES[rule].column}</span>
          ))}
          <span />
        </div>
        <ul
          aria-label="Account rules by workspace"
          className="m-0 list-none divide-y divide-border p-0"
        >
          {overview.workspaces.map((workspace) => (
            <li key={workspace.workspaceId}>
              <button
                type="button"
                onClick={() => onOpenWorkspace(workspace.workspaceId)}
                className={cn(
                  OVERVIEW_GRID,
                  "w-full cursor-pointer rounded-[10px] px-3 py-3 text-left text-sm leading-5 transition-colors duration-[120ms] hover:bg-hover focus-visible:outline-2 focus-visible:outline-brand/55",
                )}
              >
                <span className="col-span-2 min-w-0 truncate font-medium text-fg @[640px]/rules:col-span-1">
                  {workspace.name}
                </span>
                {ORDER.map((rule) => (
                  <span key={rule} className="flex min-w-0 flex-col">
                    <span className="text-xs leading-4 text-fg-subtle @[640px]/rules:sr-only">
                      {RULES[rule].column}
                    </span>
                    <SourcedValue
                      value={ruleValue(rule, workspace.values)}
                      source={workspace.sources[rule]}
                      organizationName={organizationName}
                    />
                  </span>
                ))}
                <ChevronRightIcon
                  aria-hidden="true"
                  className="hidden size-4 text-fg-subtle @[640px]/rules:block"
                />
                <span className="col-span-full grid min-w-0 gap-1 text-xs leading-5">
                  {(["rotation", "providers", "fallbackOrder"] as const).flatMap((key) =>
                    Object.entries(workspace.values[key]).map(([id, value]) => {
                      const description =
                        key === "fallbackOrder"
                          ? `${modelLabel(id)}: ${(value as string[]).map(modelLabel).join(" → ") || "No fallback"}`
                          : key === "rotation"
                            ? `${id}: ${(value as { mode: string }).mode === "primary_first" ? "Primary only" : "Spread work"}`
                            : `${id}: ${(value as { enabled: boolean }).enabled ? "On" : "Off"}, ${(value as { useOrganizationAccounts: boolean }).useOrganizationAccounts ? "organization accounts allowed" : "organization accounts off"}${(value as { inferenceSource?: string }).inferenceSource ? `, ${(value as { inferenceSource: string }).inferenceSource}` : ""}`;
                      return (
                        <span key={`${key}:${id}`} className="break-words">
                          <SourcedValue
                            value={description}
                            source={
                              workspace.sources[key] === "locked"
                                ? "locked"
                                : (workspace.entrySources[key][id] ?? workspace.sources[key])
                            }
                            organizationName={organizationName}
                          />
                        </span>
                      );
                    }),
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-fg-muted">
          Couldn’t load more workspaces. Try again.
        </p>
      ) : null}
      {overview.nextCursor && state.loadMore ? (
        <RowButton
          disabled={state.loadingMore || state.saving !== null}
          onClick={() => void state.loadMore?.()}
        >
          {state.loadingMore ? "Loading…" : "Show more workspaces"}
        </RowButton>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 pb-3 text-xs leading-5 text-fg-muted">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
          Changed by the workspace
        </span>
        <span className="inline-flex items-center gap-1">
          <LockIcon aria-hidden="true" className="size-3" />
          Locked
        </span>
        <span>{`Others follow ${organizationName}`}</span>
      </p>
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   Workspace: its effective rules, each changeable unless locked, with a
   one-step return to the organization's value.
   -------------------------------------------------------------------------- */

export type WorkspaceModelAccountSettingsState = {
  settings: WorkspaceModelAccountSettings | null;
  error: Error | null;
  saving: string | null;
  reload: () => Promise<void>;
  update: (key: string, request: UpdateWorkspaceModelAccountSettingsRequest) => Promise<void>;
};

export function useWorkspaceModelAccountSettings(
  workspaceId: string,
  enabled: boolean,
): WorkspaceModelAccountSettingsState {
  const client = useAppContext().client;
  const [settings, setSettings] = useState<WorkspaceModelAccountSettings | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const generation = useRef(0);
  const savingRef = useRef(false);
  const contextGeneration = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!enabled) {
      setSettings(null);
      return;
    }
    setError(null);
    try {
      const loaded = await client.getWorkspaceModelAccountSettings(workspaceId);
      if (current === generation.current) setSettings(loaded);
    } catch (caught) {
      if (current === generation.current) {
        setSettings(null);
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
  }, [client, enabled, workspaceId]);

  useEffect(() => {
    contextGeneration.current += 1;
    setSettings(null);
    savingRef.current = false;
    setSaving(null);
    void reload();
    return () => {
      generation.current += 1;
      contextGeneration.current += 1;
    };
  }, [reload]);

  const update = useCallback(
    async (key: string, request: UpdateWorkspaceModelAccountSettingsRequest) => {
      if (!enabled || !settings || savingRef.current) return;
      const context = contextGeneration.current;
      savingRef.current = true;
      setSaving(key);
      try {
        const saved = await client.updateWorkspaceModelAccountSettings(workspaceId, {
          ...request,
          expectedVersion: settings.version,
        });
        if (context === contextGeneration.current) {
          generation.current += 1;
          setSettings(saved);
        }
      } catch (caught) {
        if (context === contextGeneration.current) {
          toast.error(failureMessage(caught));
          void reload();
        }
      } finally {
        if (context === contextGeneration.current) {
          savingRef.current = false;
          setSaving(null);
        }
      }
    },
    [client, enabled, reload, settings, workspaceId],
  );

  return { settings, error, saving, reload, update };
}

export function WorkspaceAccountRulesSection({
  organizationName,
  state,
}: {
  organizationName: string;
  state: WorkspaceModelAccountSettingsState;
}) {
  const catalog = useAppContext().clientConfig?.models ?? [];
  const modelLabel = (id: string) => catalog.find((model) => model.id === id)?.label ?? id;
  const settings = state.settings;
  if (!settings) {
    return state.error ? (
      <Section title="Account rules">
        <ErrorMessage
          title="Couldn’t load this workspace’s account rules."
          action={<RowButton onClick={() => void state.reload()}>Try again</RowButton>}
        >
          Nothing was changed.
        </ErrorMessage>
      </Section>
    ) : null;
  }
  const lockedReason = `Locked by ${organizationName}.`;
  const readOnlyReason = `Only admins of this workspace or ${organizationName} can change this.`;
  return (
    <Section
      title="Account rules"
      description={
        settings.canEdit
          ? `This workspace follows ${organizationName} unless you change a rule here.`
          : `This workspace follows ${organizationName} unless its admins change a rule here.`
      }
    >
      <SettingRowGroup>
        {ORDER.map((rule) => {
          const source = settings.sources[rule];
          const reset =
            source !== "workspace" ? null : settings.canEdit ? (
              <SettingRowLink
                disabled={state.saving !== null}
                onClick={() =>
                  void state.update(`reset:${rule}`, {
                    [rule]: null,
                  } as UpdateWorkspaceModelAccountSettingsRequest)
                }
              >
                {`Use ${organizationName}’s setting`}
              </SettingRowLink>
            ) : (
              <span className="text-xs text-fg-subtle">Set for this workspace.</span>
            );
          const hint: ReactNode =
            source === "locked" ? (
              <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
                <LockIcon aria-hidden="true" className="size-3" />
                {lockedReason}
              </span>
            ) : (
              reset
            );
          if (rule === "rotation") {
            return (
              <SettingRow
                key={rule}
                label={RULES.rotation.label}
                description={RULES.rotation.description}
                hint={hint}
                control={
                  <RotationControl
                    rotation={settings.values.rotation}
                    disabled={!settings.canEdit || source === "locked" || state.saving !== null}
                    onSave={(provider, mode) =>
                      state.update("rotation", { rotation: { [provider]: { mode } } })
                    }
                  />
                }
              />
            );
          }
          const switchRule: SwitchRule = rule;
          const disabledReason =
            source === "locked" ? lockedReason : settings.canEdit ? undefined : readOnlyReason;
          return (
            <SettingRow
              key={rule}
              label={RULES[switchRule].label}
              description={RULES[switchRule].description}
              hint={hint}
              controlWidth="compact"
              control={
                <Switch
                  checked={settings.values[switchRule]}
                  pending={state.saving === switchRule}
                  disabled={disabledReason !== undefined || state.saving !== null}
                  disabledReason={disabledReason}
                  onCheckedChange={(checked) =>
                    void state.update(switchRule, { [switchRule]: checked })
                  }
                />
              }
            />
          );
        })}
        <SettingRow
          label="Fallback order"
          description={
            fallbackLines(settings.values.fallbackOrder, modelLabel).join("; ") ||
            "No fallback order set."
          }
          hint={
            settings.sources.fallbackOrder === "locked"
              ? lockedReason
              : settings.sources.fallbackOrder === "workspace"
                ? "Set by this workspace."
                : `Follows ${organizationName}.`
          }
          control={
            <FallbackOrderControl
              order={settings.values.fallbackOrder}
              modelLabel={modelLabel}
              saving={state.saving !== null}
              disabled={!settings.canEdit || settings.sources.fallbackOrder === "locked"}
              onSave={(model, fallbacks) =>
                state.update("fallbackOrder", { fallbackOrder: { [model]: fallbacks } })
              }
              onReset={(model) =>
                state.update("reset:fallbackOrder", { fallbackOrder: { [model]: null } })
              }
            />
          }
        />
      </SettingRowGroup>
    </Section>
  );
}
