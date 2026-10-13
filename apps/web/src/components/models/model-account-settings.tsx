import type {
  ModelAccountRotationMode,
  ModelAccountSettingKey,
  ModelAccountSettingValues,
  ModelAccountSettingsOverview,
  UpdateOrganizationModelAccountSettingsRequest,
  UpdateWorkspaceModelAccountSettingsRequest,
  WorkspaceModelAccountSettings,
} from "@opengeni/sdk";
import { LockIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField, FieldStack } from "@/components/ui/field";
import { ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  SettingNavRow,
  SettingRow,
  SettingRowGroup,
  SettingRowLink,
} from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { FallbackOrderControl } from "./model-account-policy-controls";
import { ModelsFormPage } from "./models-ui";

/* ----------------------------------------------------------------------------
   How accounts are used: the organization's rules for its model accounts.
   The organization sets each rule; a shared workspace can change a rule for
   itself unless the organization keeps it the same everywhere ("What
   workspaces can change"). Every value is resolved by the server
   (`subscription_effective_settings`); this file only shows what it returns
   and where each value comes from.

   One row per provider says how new chats share that provider's accounts.
   A rule that only matters while another is on (personal fallback, the
   fallback order) is indented under it and shown only then.
   -------------------------------------------------------------------------- */

/** The rules on these pages, in order. `providers` is changed on each provider's own page. */
export type AccountRule =
  | "rotation"
  | "personalConnectionsAllowed"
  | "personalFallbackAllowed"
  | "crossProviderFailover"
  | "fallbackOrder";

type SwitchRule =
  | "personalConnectionsAllowed"
  | "personalFallbackAllowed"
  | "crossProviderFailover";

export const ACCOUNT_RULES: readonly AccountRule[] = [
  "rotation",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
  "crossProviderFailover",
  "fallbackOrder",
];

const RULES: Record<AccountRule, { label: string; description: string }> = {
  rotation: {
    label: "Sharing work between accounts",
    description: "Spread new chats across a provider’s accounts, or keep them on its primary one.",
  },
  personalConnectionsAllowed: {
    label: "Personal subscriptions",
    description: "People can connect their own subscriptions and use them in their own chats.",
  },
  personalFallbackAllowed: {
    label: "Fall back to personal subscriptions",
    description: "When shared accounts run out, people who opt in continue on their own.",
  },
  crossProviderFailover: {
    label: "Switch models when accounts run out",
    description: "Continue on the next model in the fallback order instead of waiting.",
  },
  fallbackOrder: {
    label: "Fallback order",
    description: "The models to try next, in order.",
  },
};

const PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  xai: "SuperGrok",
};
const PROVIDER_ORDER = ["codex", "claude", "xai"];

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** Providers with a rotation rule, Codex, Claude, SuperGrok first. */
function rotationProviders(rotation: ModelAccountSettingValues["rotation"]): string[] {
  const rank = (provider: string) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };
  return Object.keys(rotation).sort(
    (left, right) => rank(left) - rank(right) || left.localeCompare(right),
  );
}

/** "3 connected. Each new chat goes to the account with the most usage left." */
function rotationDescription(mode: ModelAccountRotationMode, count: number | undefined): string {
  const outcome =
    mode === "primary_first"
      ? "New chats use the primary account."
      : "Each new chat goes to the account with the most usage left.";
  return count === undefined ? outcome : `${count} connected. ${outcome}`;
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

function FallbackSummary({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <>No fallback models yet, so work waits for an account.</>;
  return (
    <>
      {lines.map((line) => (
        <span key={line} className="block break-words">
          {line}
        </span>
      ))}
    </>
  );
}

function failureMessage(caught: unknown): string {
  const details = (caught as { details?: { reason?: unknown } } | null)?.details;
  if (details?.reason === "setting_locked") return "Your organization locked this setting.";
  if (details?.reason === "version_conflict")
    return "Someone else changed this. Reload and try again.";
  return caught instanceof Error ? caught.message : "Couldn’t save the change.";
}

/** A change to the rules shown here, for the organization or one workspace. */
type RuleChange = {
  rotation?: Record<string, { mode: ModelAccountRotationMode }>;
  personalConnectionsAllowed?: boolean;
  personalFallbackAllowed?: boolean;
  crossProviderFailover?: boolean;
};

const NO_HINTS: Readonly<Record<string, ReactNode>> = {};

/**
 * The rule rows, shared by the organization's page and a workspace's. The
 * caller says which rules can't change here and why, and adds the quiet
 * line under each (locked, or a way back to the organization's setting).
 */
function AccountRuleRows({
  values,
  saving,
  accountCounts,
  blocked,
  hints = NO_HINTS,
  providerHints = NO_HINTS,
  onChange,
  fallbackOrder,
  modelLabel,
}: {
  values: ModelAccountSettingValues;
  saving: string | null;
  /** How many accounts each provider has, when known; a provider with fewer than two has no row. */
  accountCounts?: Readonly<Record<string, number>> | undefined;
  /** Why a rule can't change here, or undefined when it can. */
  blocked: (rule: AccountRule) => string | undefined;
  /** The quiet line under a rule: locked, or a way back to the organization's setting. */
  hints?: Partial<Record<AccountRule, ReactNode>> | undefined;
  /** The same for one provider's row; falls back to the rotation rule's. */
  providerHints?: Readonly<Record<string, ReactNode>> | undefined;
  onChange: (key: string, change: RuleChange) => void;
  /** The fallback order editor. */
  fallbackOrder: ReactNode;
  modelLabel: (id: string) => string;
}) {
  const providers = rotationProviders(values.rotation).filter(
    (provider) => accountCounts === undefined || (accountCounts[provider] ?? 0) >= 2,
  );
  const rotationBlocked = blocked("rotation");
  const switchRow = (rule: SwitchRule, children?: ReactNode) => {
    const reason = blocked(rule);
    return (
      <SettingRow
        key={rule}
        label={RULES[rule].label}
        description={RULES[rule].description}
        hint={hints[rule]}
        controlWidth="compact"
        control={
          <Switch
            checked={values[rule]}
            pending={saving === rule}
            disabled={reason !== undefined || (saving !== null && saving !== rule)}
            disabledReason={reason}
            onCheckedChange={(checked) => onChange(rule, { [rule]: checked })}
          />
        }
      >
        {children}
      </SettingRow>
    );
  };
  return (
    <>
      {providers.map((provider) => {
        const mode = values.rotation[provider]?.mode ?? "spread";
        const key = `rotation:${provider}`;
        return (
          <SettingRow
            key={key}
            label={`${providerName(provider)} accounts`}
            description={rotationDescription(mode, accountCounts?.[provider])}
            hint={providerHints[provider] ?? hints.rotation}
            controlWidth="auto"
            control={
              <SegmentedControl<ModelAccountRotationMode>
                size="sm"
                value={mode}
                pending={saving === key}
                disabled={rotationBlocked !== undefined || (saving !== null && saving !== key)}
                onValueChange={(next) =>
                  onChange(key, { rotation: { [provider]: { mode: next } } })
                }
                options={[
                  { value: "spread", label: "Spread work" },
                  { value: "primary_first", label: "Primary only" },
                ]}
              />
            }
          />
        );
      })}
      {switchRow(
        "personalConnectionsAllowed",
        values.personalConnectionsAllowed ? switchRow("personalFallbackAllowed") : null,
      )}
      {switchRow(
        "crossProviderFailover",
        values.crossProviderFailover ? (
          <SettingRow
            label={RULES.fallbackOrder.label}
            description={
              <FallbackSummary lines={fallbackLines(values.fallbackOrder, modelLabel)} />
            }
            hint={hints.fallbackOrder}
            control={fallbackOrder}
          />
        ) : null,
      )}
    </>
  );
}

/* ----------------------------------------------------------------------------
   Organization: its rules, and which of them workspaces can change.
   -------------------------------------------------------------------------- */

export type ModelAccountSettingsOverviewState = {
  overview: ModelAccountSettingsOverview | null;
  loading: boolean;
  error: Error | null;
  /** The rule being saved, if any. */
  saving: string | null;
  reload: () => Promise<void>;
  /** Saves a change; true once it's saved and read again. */
  update: (key: string, request: UpdateOrganizationModelAccountSettingsRequest) => Promise<boolean>;
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

  const reload = useCallback(async () => {
    const current = ++generation.current;
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

  const update = useCallback(
    async (key: string, request: UpdateOrganizationModelAccountSettingsRequest) => {
      if (!enabled || !organizationId || !overview || savingRef.current) return false;
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
        return true;
      } catch (caught) {
        if (current === generation.current) toast.error(failureMessage(caught));
        return false;
      } finally {
        if (context === contextGeneration.current) {
          savingRef.current = false;
          setSaving(null);
        }
      }
    },
    [client, enabled, organizationId, overview, reload],
  );

  return { overview, loading, error, saving, reload, update };
}

/** "Every rule", "3 of 5 rules" or "Nothing": what workspaces can change for themselves. */
export function changeableRulesSummary(locked: readonly string[]): string {
  const open = ACCOUNT_RULES.filter((rule) => !locked.includes(rule)).length;
  if (open === ACCOUNT_RULES.length) return "Every rule";
  if (open === 0) return "Nothing";
  return `${open} of ${ACCOUNT_RULES.length} rules`;
}

/** The organization's rules, and a row to the page that says which ones workspaces can change. */
export function OrganizationAccountRulesSection({
  organizationName,
  state,
  accountCounts,
  modelLabel = modelId,
  onEditLocks,
}: {
  organizationName: string;
  state: ModelAccountSettingsOverviewState;
  /** How many accounts the organization has per provider, once they're read. */
  accountCounts?: Readonly<Record<string, number>> | undefined;
  /** A model's name, for the fallback order. */
  modelLabel?: (id: string) => string;
  /** Opens "What workspaces can change". */
  onEditLocks: () => void;
}) {
  const organization = state.overview?.organization;
  return (
    <Section
      title="How accounts are used"
      description="Every workspace follows these unless its admins change them."
    >
      {state.error && !organization ? (
        <ErrorMessage
          title={`Couldn’t load how ${organizationName} uses its accounts.`}
          action={<RowButton onClick={() => void state.reload()}>Try again</RowButton>}
        >
          Nothing was changed.
        </ErrorMessage>
      ) : !organization ? (
        <RowList label="How accounts are used" flush>
          <ListRowSkeleton count={3} />
        </RowList>
      ) : (
        <SettingRowGroup>
          <AccountRuleRows
            values={organization.values}
            saving={state.saving}
            accountCounts={accountCounts}
            blocked={() => undefined}
            hints={Object.fromEntries(
              ACCOUNT_RULES.filter((rule) => organization.locked.includes(rule)).map((rule) => [
                rule,
                <span key={rule} className="inline-flex items-center gap-1 text-xs text-fg-subtle">
                  <LockIcon aria-hidden="true" className="size-3" />
                  Same in every workspace
                </span>,
              ]),
            )}
            onChange={(key, change) => void state.update(key, change)}
            modelLabel={modelLabel}
            fallbackOrder={
              <FallbackOrderControl
                order={organization.values.fallbackOrder}
                modelLabel={modelLabel}
                saving={state.saving !== null}
                onSave={async (model, fallbacks) => {
                  await state.update("fallbackOrder", {
                    fallbackOrder: { ...organization.values.fallbackOrder, [model]: fallbacks },
                  });
                }}
              />
            }
          />
          <SettingNavRow
            label="What workspaces can change"
            description="Rules a workspace’s admins can set differently for their workspace."
            value={changeableRulesSummary(organization.locked)}
            onOpen={onEditLocks}
          />
        </SettingRowGroup>
      )}
    </Section>
  );
}

/**
 * Which rules workspaces can change. Turning one off keeps the
 * organization's setting in every workspace and replaces their changes.
 */
export function AccountRuleLocksPage({
  organizationName,
  state,
  onClose,
}: {
  organizationName: string;
  state: ModelAccountSettingsOverviewState;
  onClose: () => void;
}) {
  const organization = state.overview?.organization;
  const saved = organization?.locked ?? [];
  const [draft, setDraft] = useState<readonly string[] | null>(null);
  const locked = draft ?? saved;
  const changed =
    draft !== null && ACCOUNT_RULES.some((rule) => draft.includes(rule) !== saved.includes(rule));
  // Which workspaces changed each rule, when every workspace is on the first page.
  const workspaces = state.overview?.nextCursor === null ? state.overview.workspaces : null;
  const changedIn = (rule: AccountRule) =>
    workspaces?.filter((workspace) => workspace.sources[rule] === "workspace").map((w) => w.name) ??
    [];
  return (
    <ModelsFormPage
      title="What workspaces can change"
      description={`Workspace admins can set these rules differently for their workspace. Anything you turn off stays as ${organizationName} sets it, everywhere.`}
      submitLabel="Save"
      pendingLabel="Saving…"
      loading={!organization && !state.error}
      loadingFields={5}
      submitDisabled={!changed}
      error={
        state.error && !organization
          ? `Couldn’t load ${organizationName}’s rules. Reload the page.`
          : null
      }
      onClose={onClose}
      onSubmit={async () => {
        const next = [
          ...saved.filter((key) => !ACCOUNT_RULES.includes(key as AccountRule)),
          ...ACCOUNT_RULES.filter((rule) => locked.includes(rule)),
        ] as ModelAccountSettingKey[];
        return state.update("locks", { locked: next });
      }}
      onSubmitted={onClose}
    >
      <FieldStack>
        {ACCOUNT_RULES.map((rule) => {
          const names = changedIn(rule);
          const replacing = names.length > 0 && locked.includes(rule) && !saved.includes(rule);
          return (
            <CheckboxField
              key={rule}
              label={RULES[rule].label}
              description={
                replacing
                  ? `${names.join(", ")} will go back to ${organizationName}’s setting.`
                  : names.length > 0
                    ? `Changed in ${names.join(", ")}.`
                    : RULES[rule].description
              }
              checked={!locked.includes(rule)}
              onCheckedChange={(open) =>
                setDraft(
                  open
                    ? locked.filter((key) => key !== rule)
                    : [...locked.filter((key) => key !== rule), rule],
                )
              }
            />
          );
        })}
      </FieldStack>
    </ModelsFormPage>
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

const onOff = (value: boolean) => (value ? "On" : "Off");

/**
 * What a workspace set for itself instead of following the organization, in
 * words: "Claude: Primary only", "Switch models: On", "Own fallback order".
 * A locked rule is the organization's, so it is never a change.
 */
export function accountRuleChanges(
  settings: Pick<WorkspaceModelAccountSettings, "values" | "sources" | "entrySources">,
): string[] {
  const own = (rule: AccountRule) => settings.sources[rule] === "workspace";
  const { values } = settings;
  return [
    ...(own("rotation")
      ? rotationProviders(values.rotation)
          .filter((provider) => settings.entrySources.rotation[provider] === "workspace")
          .map(
            (provider) =>
              `${providerName(provider)}: ${
                values.rotation[provider]?.mode === "primary_first" ? "Primary only" : "Spread work"
              }`,
          )
      : []),
    ...(own("personalConnectionsAllowed")
      ? [`Personal subscriptions: ${onOff(values.personalConnectionsAllowed)}`]
      : []),
    ...(own("personalFallbackAllowed")
      ? [`Personal fallback: ${onOff(values.personalFallbackAllowed)}`]
      : []),
    ...(own("crossProviderFailover")
      ? [`Switch models: ${onOff(values.crossProviderFailover)}`]
      : []),
    ...(own("fallbackOrder") ? ["Own fallback order"] : []),
  ];
}

/** "This workspace follows Acme’s rules." or "2 rules changed here. The rest follow Acme." */
function workspaceRulesSummary(
  changes: number,
  organizationName: string,
  canEdit: boolean,
): string {
  if (changes > 0) {
    return `${changes === 1 ? "1 rule" : `${changes} rules`} changed here. The rest follow ${organizationName}.`;
  }
  return canEdit
    ? `This workspace follows ${organizationName}’s rules. Change one here to set it for this workspace only.`
    : `This workspace follows ${organizationName}’s rules.`;
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
      <Section title="How accounts are used">
        <ErrorMessage
          title="Couldn’t load how this workspace uses its accounts."
          action={<RowButton onClick={() => void state.reload()}>Try again</RowButton>}
        >
          Nothing was changed.
        </ErrorMessage>
      </Section>
    ) : null;
  }
  const lockedReason = `${organizationName} keeps this the same in every workspace.`;
  const readOnlyReason = `Only admins of this workspace or ${organizationName} can change this.`;
  const lockHint = (
    <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
      <LockIcon aria-hidden="true" className="size-3" />
      {lockedReason}
    </span>
  );
  const resetLink = (key: string, request: UpdateWorkspaceModelAccountSettingsRequest) =>
    settings.canEdit ? (
      <SettingRowLink
        disabled={state.saving !== null}
        onClick={() => void state.update(key, request)}
      >
        {`Use ${organizationName}’s setting`}
      </SettingRowLink>
    ) : (
      <span className="text-xs text-fg-subtle">Set for this workspace.</span>
    );
  return (
    <Section
      title="How accounts are used"
      description={workspaceRulesSummary(
        accountRuleChanges(settings).length,
        organizationName,
        settings.canEdit,
      )}
    >
      <SettingRowGroup>
        <AccountRuleRows
          values={settings.values}
          saving={state.saving}
          blocked={(rule) =>
            settings.sources[rule] === "locked"
              ? lockedReason
              : settings.canEdit
                ? undefined
                : readOnlyReason
          }
          hints={Object.fromEntries(
            ACCOUNT_RULES.map((rule) => [
              rule,
              settings.sources[rule] === "locked"
                ? lockHint
                : settings.sources[rule] === "workspace" && rule !== "rotation"
                  ? resetLink(`reset:${rule}`, {
                      [rule]: null,
                    } as UpdateWorkspaceModelAccountSettingsRequest)
                  : null,
            ]),
          )}
          providerHints={Object.fromEntries(
            Object.keys(settings.values.rotation).map((provider) => [
              provider,
              settings.sources.rotation === "locked"
                ? lockHint
                : settings.entrySources.rotation[provider] === "workspace"
                  ? resetLink(`reset:rotation:${provider}`, { rotation: { [provider]: null } })
                  : null,
            ]),
          )}
          onChange={(key, change) => void state.update(key, change)}
          modelLabel={modelLabel}
          fallbackOrder={
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
