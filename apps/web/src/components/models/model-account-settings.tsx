import type {
  ModelAccountSettingValues,
  ModelAccountSettingsOverview,
  ModelAccountRotationMode,
  UpdateOrganizationModelAccountSettingsRequest,
  UpdateWorkspaceModelAccountSettingsRequest,
  WorkspaceModelAccountSettings,
} from "@opengeni/sdk";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import {
  SettingNavRow,
  SettingRow,
  SettingRowGroup,
  SettingRowLink,
} from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FallbackOrderControl } from "./model-account-policy-controls";

/* ----------------------------------------------------------------------------
   Account rules: how the organization's model accounts are used. The
   organization sets each rule; a shared workspace can change a rule for
   itself unless the organization locked it. Every value is resolved by the
   server (`subscription_effective_settings`); this file only shows what it
   returns and where each value comes from. The rules live on their own page
   (`?view=account-rules`), opened from a row under Defaults.
   -------------------------------------------------------------------------- */

/** The rules on these pages, in order. `providers` is changed on each provider's own page. */
export type AccountRule =
  | "rotation"
  | "personalConnectionsAllowed"
  | "personalFallbackAllowed"
  | "crossProviderFailover";

const RULES: Record<AccountRule, { label: string; column: string; description: string }> = {
  rotation: {
    label: "Share work between accounts",
    column: "Sharing work",
    description:
      "New work goes to the account with the most usage left. Off keeps work on the primary account.",
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

const PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  xai: "SuperGrok",
};

/** "Spread work", "Primary only" or "Mixed" across providers. */
export function rotationSummary(rotation: ModelAccountSettingValues["rotation"]): string {
  const modes = new Set(Object.values(rotation).map((entry) => entry.mode));
  if (modes.size > 1) return "Mixed";
  return modes.has("primary_first") ? "Primary only" : "Spread work";
}

/** Sharing work is one switch: on when every provider spreads work. */
function rotationOn(rotation: ModelAccountSettingValues["rotation"]): boolean {
  const entries = Object.values(rotation);
  return entries.length > 0 && entries.every((entry) => entry.mode === "spread");
}

/** The switch sets every provider at once. */
function everyProvider(
  rotation: ModelAccountSettingValues["rotation"],
  mode: ModelAccountRotationMode,
): Record<string, { mode: ModelAccountRotationMode }> {
  return Object.fromEntries(Object.keys(rotation).map((provider) => [provider, { mode }]));
}

/** "On for Codex, off for Claude." when providers differ; nothing otherwise. */
function mixedRotationNote(rotation: ModelAccountSettingValues["rotation"]): string | null {
  if (rotationSummary(rotation) !== "Mixed") return null;
  const parts = Object.entries(rotation).map(
    ([provider, entry]) =>
      `${entry.mode === "spread" ? "on" : "off"} for ${PROVIDER_NAMES[provider] ?? provider}`,
  );
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function rotationDescription(rotation: ModelAccountSettingValues["rotation"]): ReactNode {
  const mixed = mixedRotationNote(rotation);
  return mixed ? (
    <>
      {RULES.rotation.description}
      <span className="block text-fg-subtle">{mixed}</span>
    </>
  ) : (
    RULES.rotation.description
  );
}

function ruleValue(rule: AccountRule, values: ModelAccountSettingValues): string {
  if (rule === "rotation") {
    const summary = rotationSummary(values.rotation);
    return summary === "Mixed" ? "Mixed" : summary === "Spread work" ? "On" : "Off";
  }
  return values[rule] ? "On" : "Off";
}

type RulesView = Pick<
  ModelAccountSettingsOverview["workspaces"][number],
  "values" | "sources" | "entrySources"
>;

/** What a workspace changed for itself, in words: "Sharing work: Off", "Own fallback order". */
export function workspaceRuleChanges(view: RulesView): string[] {
  const changed = (key: keyof RulesView["sources"]) =>
    view.sources[key] === "workspace" ||
    (view.sources[key] !== "locked" &&
      key in view.entrySources &&
      Object.values(view.entrySources[key as keyof RulesView["entrySources"]]).includes(
        "workspace",
      ));
  return [
    ...ORDER.filter((rule) => changed(rule)).map(
      (rule) => `${RULES[rule].column}: ${ruleValue(rule, view.values)}`,
    ),
    ...(changed("fallbackOrder") ? ["Own fallback order"] : []),
    ...(changed("providers") ? ["Own provider settings"] : []),
  ];
}

/** A lock is a toggle: pressed keeps the rule the same in every workspace. */
function LockToggle({
  locked,
  label,
  disabled,
  onToggle,
}: {
  locked: boolean;
  /** The rule's name, for people using a screen reader. */
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-pressed={locked}
      aria-label={`Lock for every workspace: ${label}`}
      title={locked ? "Locked: workspaces can’t change this" : "Lock for every workspace"}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "rounded-full px-2 text-fg-subtle hover:text-fg pointer-coarse:h-9",
        locked && "bg-surface-3 text-fg hover:bg-surface-3",
      )}
    >
      {locked ? <LockIcon aria-hidden="true" /> : <LockOpenIcon aria-hidden="true" />}
      {locked ? "Locked" : "Lock"}
    </Button>
  );
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

/** "2 locked" for the row that opens the rules; nothing while none are locked. */
export function organizationRulesSummary(state: ModelAccountSettingsOverviewState): string {
  const locked = state.overview?.organization.locked.filter((key) => key !== "providers").length;
  return locked ? `${locked} locked` : "";
}

/** The row under Defaults that opens the account rules page. */
export function AccountRulesRow({ value, onOpen }: { value: string; onOpen: () => void }) {
  return (
    <SettingNavRow
      label="Account rules"
      description="Sharing work between accounts, personal accounts and fallback."
      value={value}
      onOpen={onOpen}
    />
  );
}

/** The organization's rules. Each has one switch, and a lock for every workspace. */
export function OrganizationAccountRulesSection({
  organizationName,
  state,
  modelLabel = modelId,
  title = "Account rules",
}: {
  organizationName: string;
  state: ModelAccountSettingsOverviewState;
  /** A model's name, for the fallback order. */
  modelLabel?: (id: string) => string;
  title?: string;
}) {
  const organization = state.overview?.organization;
  return (
    <Section
      title={title}
      description="Workspaces follow these unless their admins change them. Lock a rule to keep it the same everywhere."
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
          {[...ORDER, "fallbackOrder" as const].map((rule) => {
            const locked = organization.locked.includes(rule);
            const lock = (
              <LockToggle
                locked={locked}
                label={rule === "fallbackOrder" ? "Fallback order" : RULES[rule].label}
                disabled={state.saving !== null}
                onToggle={() =>
                  void state.update(`lock:${rule}`, {
                    locked: locked
                      ? organization.locked.filter((key) => key !== rule)
                      : [...organization.locked, rule],
                  })
                }
              />
            );
            if (rule === "fallbackOrder") {
              return (
                <SettingRow
                  key={rule}
                  label="Fallback order"
                  description="The exact models to try, in order."
                  hint={
                    // The editor opens here, under the text, so the lock stays in line.
                    <FallbackOrderControl
                      order={organization.values.fallbackOrder}
                      modelLabel={modelLabel}
                      saving={state.saving !== null}
                      onSave={(model, fallbacks) =>
                        state.update("fallbackOrder", {
                          fallbackOrder: {
                            ...organization.values.fallbackOrder,
                            [model]: fallbacks,
                          },
                        })
                      }
                    />
                  }
                  controlWidth="compact"
                  control={
                    // The empty switch-wide slot keeps this lock in line with the others.
                    <span className="flex items-center gap-3">
                      {lock}
                      <span aria-hidden="true" className="w-9" />
                    </span>
                  }
                />
              );
            }
            const rotation = organization.values.rotation;
            // No provider shares accounts yet, so there is nothing to share work between.
            if (rule === "rotation" && Object.keys(rotation).length === 0) return null;
            const checked = rule === "rotation" ? rotationOn(rotation) : organization.values[rule];
            const lines =
              rule === "crossProviderFailover"
                ? fallbackLines(organization.values.fallbackOrder, modelLabel)
                : [];
            const description =
              rule === "rotation" ? (
                rotationDescription(rotation)
              ) : rule !== "crossProviderFailover" ? (
                RULES[rule].description
              ) : lines.length > 0 ? (
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
              );
            return (
              <SettingRow
                key={rule}
                label={RULES[rule].label}
                description={description}
                controlWidth="compact"
                control={
                  <span className="flex items-center gap-3">
                    {lock}
                    <Switch
                      checked={checked}
                      pending={state.saving === rule}
                      disabled={state.saving !== null && state.saving !== rule}
                      onCheckedChange={(next) =>
                        void state.update(
                          rule,
                          rule === "rotation"
                            ? {
                                rotation: everyProvider(
                                  rotation,
                                  next ? "spread" : "primary_first",
                                ),
                              }
                            : { [rule]: next },
                        )
                      }
                    />
                  </span>
                }
              />
            );
          })}
        </SettingRowGroup>
      )}
    </Section>
  );
}

/**
 * The workspaces that changed a rule for themselves, each with what it
 * changed. Every other workspace follows the organization, so it isn't listed.
 */
export function AccountRulesOverviewSection({
  organizationName,
  state,
  onOpenWorkspace,
}: {
  organizationName: string;
  state: ModelAccountSettingsOverviewState;
  onOpenWorkspace: (workspaceId: string) => void;
  /** Kept for callers; the list names changes, not models. */
  modelLabel?: (id: string) => string;
}) {
  const overview = state.overview;
  if (!overview) return null;
  const changed = overview.workspaces.flatMap((workspace) => {
    const changes = workspaceRuleChanges(workspace);
    return changes.length > 0 ? [{ workspace, changes }] : [];
  });
  return (
    <Section
      title="Workspaces with their own rules"
      description={changed.length > 0 ? `Every other workspace follows ${organizationName}.` : null}
    >
      {changed.length > 0 ? (
        <RowList label="Workspaces with their own rules" flush>
          {changed.map(({ workspace, changes }) => (
            <ListRow
              key={workspace.workspaceId}
              leading={<LogoTile name={workspace.name} />}
              title={workspace.name}
              meta={changes}
              indicator="open"
              onOpen={() => onOpenWorkspace(workspace.workspaceId)}
            />
          ))}
        </RowList>
      ) : overview.nextCursor ? null : (
        <p className="m-0 pt-2 pb-3 text-sm leading-5 text-fg-muted">
          {`No workspace has changed a rule. All follow ${organizationName}.`}
        </p>
      )}
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

/** "Follows Acme" or "2 changed here", for the row that opens the rules. */
export function workspaceRulesSummary(
  settings: WorkspaceModelAccountSettings | null,
  organizationName: string,
): string {
  if (!settings) return "";
  const changes = workspaceRuleChanges(settings).length;
  return changes > 0 ? `${changes} changed here` : `Follows ${organizationName}`;
}

export function WorkspaceAccountRulesSection({
  organizationName,
  state,
  title = "Account rules",
}: {
  organizationName: string;
  state: WorkspaceModelAccountSettingsState;
  title?: string;
}) {
  const catalog = useAppContext().clientConfig?.models ?? [];
  const modelLabel = (id: string) => catalog.find((model) => model.id === id)?.label ?? id;
  const settings = state.settings;
  if (!settings) {
    return state.error ? (
      <Section title={title}>
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
  const rotation = settings.values.rotation;
  return (
    <Section
      title={title}
      description={
        settings.canEdit
          ? `This workspace follows ${organizationName} unless you change a rule here.`
          : `This workspace follows ${organizationName} unless its admins change a rule here.`
      }
    >
      <SettingRowGroup>
        {ORDER.map((rule) => {
          // No provider shares accounts yet, so there is nothing to share work between.
          if (rule === "rotation" && Object.keys(rotation).length === 0) return null;
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
          const disabledReason =
            source === "locked" ? lockedReason : settings.canEdit ? undefined : readOnlyReason;
          return (
            <SettingRow
              key={rule}
              label={RULES[rule].label}
              description={
                rule === "rotation" ? rotationDescription(rotation) : RULES[rule].description
              }
              hint={hint}
              controlWidth="compact"
              control={
                <Switch
                  checked={rule === "rotation" ? rotationOn(rotation) : settings.values[rule]}
                  pending={state.saving === rule}
                  disabled={disabledReason !== undefined || state.saving !== null}
                  disabledReason={disabledReason}
                  onCheckedChange={(checked) =>
                    void state.update(
                      rule,
                      rule === "rotation"
                        ? {
                            rotation: everyProvider(rotation, checked ? "spread" : "primary_first"),
                          }
                        : { [rule]: checked },
                    )
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
