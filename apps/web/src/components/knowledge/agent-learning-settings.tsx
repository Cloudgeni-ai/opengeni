import { DEFAULT_AGENT_LEARNING } from "@opengeni/contracts";
import type {
  AgentLearningCategory,
  AgentLearningContext,
  AgentLearningMode,
  AgentLearningSettingsRecord,
  AgentLearningOverrides,
} from "@opengeni/sdk";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import {
  apiErrorAdvice,
  apiErrorDetails,
  isPermissionDenied,
  userErrorText,
} from "@/lib/api-error";

export const LEARNING_MODE_LABEL: Record<AgentLearningMode, string> = {
  automatic: "Automatic",
  review_first: "Review first",
  off: "Off",
};
const UPDATE_PERMISSION_HELP =
  "Automatic applies agent changes right away. Review first waits for your OK in Knowledge › Review. Off stops agent changes.";

function LearningModeSelect(props: {
  id: string;
  value: AgentLearningMode | "inherit";
  defaultMode?: AgentLearningMode;
  allowInherit: boolean;
  compact?: boolean;
  describedBy?: string;
  onChange: (mode: AgentLearningMode | "inherit") => void;
}) {
  // One vocabulary everywhere: Automatic, Review first, Off. An inherited
  // value says so, so an override is never mistaken for the default.
  const labels = LEARNING_MODE_LABEL;
  return (
    <Select
      id={props.id}
      aria-describedby={props.describedBy}
      value={props.value}
      className={props.compact ? "w-[174px]" : undefined}
      displayValue={
        props.compact
          ? props.value === "inherit"
            ? props.defaultMode
              ? `Default (${labels[props.defaultMode]})`
              : "Default"
            : labels[props.value]
          : undefined
      }
      onChange={(event) => props.onChange(event.target.value as AgentLearningMode | "inherit")}
    >
      {props.allowInherit ? (
        <option value="inherit">
          Default{props.defaultMode ? ` (${labels[props.defaultMode]})` : ""}
        </option>
      ) : null}
      {Object.entries(labels).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </Select>
  );
}
const CATEGORIES: { key: AgentLearningCategory; label: string; description: string }[] = [
  {
    key: "knowledge",
    label: "Knowledge",
    description: "Retained sources, facts, decisions and useful findings.",
  },
  {
    key: "instructions",
    label: "Instructions",
    description: "Standing guidance that shapes how agents work.",
  },
  { key: "skills", label: "Skills", description: "Reusable procedures agents create or improve." },
];

/** Shared editor: defaults and sparse chat/task overrides use the same authority. */
type AgentLearningSettingsEditorProps = {
  workspaceId: string;
  scope: "workspace" | "personal";
  source?: AgentLearningContext;
  canEdit?: boolean;
  onSaved?: () => void;
  compact?: boolean;
};
export function AgentLearningSettingsEditor(props: AgentLearningSettingsEditorProps) {
  const identity = JSON.stringify([
    props.workspaceId,
    props.scope,
    props.source?.kind,
    props.source?.id,
  ]);
  return <AgentLearningSettingsFields key={identity} {...props} />;
}
/**
 * The last settings read per caller and scope. Chat settings in the composer
 * opens straight onto them and refreshes in place, instead of loading.
 */
const settingsCache = new WeakMap<
  object,
  Map<string, { record: AgentLearningSettingsRecord; defaults: AgentLearningSettingsRecord }>
>();
function settingsCacheKey(props: AgentLearningSettingsEditorProps) {
  return `${props.workspaceId}|${props.scope}|${props.source?.kind ?? ""}:${props.source?.id ?? ""}`;
}

/** Reads a chat's settings into the cache before its menu opens. Never throws. */
export function prefetchAgentLearningSettings(
  client: ReturnType<typeof useAppContext>["client"],
  props: AgentLearningSettingsEditorProps,
): void {
  const key = settingsCacheKey(props);
  if (settingsCache.get(client)?.has(key)) return;
  void Promise.all([
    client.getAgentLearningSettings(props.workspaceId, props.scope, props.source),
    client.getAgentLearningSettings(props.workspaceId, props.scope),
  ])
    .then(([record, defaults]) => {
      let byKey = settingsCache.get(client);
      if (!byKey) {
        byKey = new Map();
        settingsCache.set(client, byKey);
      }
      if (!byKey.has(key)) byKey.set(key, { record, defaults });
    })
    .catch(() => undefined);
}

function AgentLearningSettingsFields(props: AgentLearningSettingsEditorProps) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const context = useAppContext();
  const fieldId = useId();
  const cacheKey = settingsCacheKey(props);
  const cached = settingsCache.get(context.client)?.get(cacheKey) ?? null;
  const [record, setRecord] = useState<AgentLearningSettingsRecord | null>(
    () => cached?.record ?? null,
  );
  const [defaults, setDefaults] = useState<AgentLearningSettingsRecord | null>(
    () => cached?.defaults ?? null,
  );
  // A failed read and a failed save are different problems with different fixes.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  // Cached rows show while the read refreshes them, but a save waits for it:
  // it must go against the current version, not the cached one.
  const [refreshing, setRefreshing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const sourceKind = props.source?.kind;
  const sourceId = props.source?.id;
  useEffect(() => {
    let current = true;
    if (!settingsCache.get(context.client)?.has(cacheKey)) setRecord(null);
    setLoadError(null);
    setSaveError(null);
    setRefreshing(true);
    setSaved(false);
    const source = sourceKind && sourceId ? { kind: sourceKind, id: sourceId } : undefined;
    void Promise.all([
      context.client.getAgentLearningSettings(props.workspaceId, props.scope, source),
      context.client.getAgentLearningSettings(props.workspaceId, props.scope),
    ])
      .then(([value, base]) => {
        let byKey = settingsCache.get(context.client);
        if (!byKey) {
          byKey = new Map();
          settingsCache.set(context.client, byKey);
        }
        byKey.set(cacheKey, { record: value, defaults: base });
        if (current) {
          setRecord(value);
          setDefaults(base);
          setRefreshing(false);
        }
      })
      .catch((reason: unknown) => {
        if (current) {
          setLoadError(reason);
          setRefreshing(false);
        }
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheKey is derived from these
  }, [context.client, props.workspaceId, props.scope, sourceKind, sourceId, reload]);

  async function save(category: AgentLearningCategory, mode: AgentLearningMode | "inherit") {
    if (!record || saving || refreshing || props.canEdit === false) return;
    const invocation = context.captureWorkspaceInvocation(props.workspaceId);
    if (!invocation) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const next = await context.client.saveAgentLearningSettings(props.workspaceId, {
        scope: props.scope,
        ...(props.source ? { source: props.source } : {}),
        operationId: crypto.randomUUID(),
        expectedVersion: record.version,
        settings: props.source ? { [category]: mode } : { ...record.settings, [category]: mode },
      });
      const entry = settingsCache.get(context.client)?.get(cacheKey);
      if (entry) entry.record = next;
      if (active.current && context.ownsWorkspaceInvocation(props.workspaceId, invocation)) {
        setRecord(next);
        setSaved(true);
        props.onSaved?.();
      }
    } catch (reason) {
      if (active.current && context.ownsWorkspaceInvocation(props.workspaceId, invocation)) {
        setSaveError(reason);
      }
    } finally {
      if (active.current) setSaving(false);
    }
  }

  const retryLoad = () => setReload((n) => n + 1);
  if (!record)
    return loadError ? (
      isPermissionDenied(loadError) ? (
        <p className="text-sm text-fg-muted">
          You can't see Agent learning here. Ask a workspace admin for access.
        </p>
      ) : (
        <ErrorMessage
          variant="inline"
          title="Couldn't load Agent learning."
          announce
          action={
            <Button variant="ghost" size="sm" onClick={retryLoad}>
              Try again
            </Button>
          }
          {...apiErrorDetails(loadError)}
        >
          {apiErrorAdvice(loadError)}
        </ErrorMessage>
      )
    ) : (
      <AgentLearningSkeleton compact={props.compact} />
    );

  return (
    <div className="grid gap-3">
      {!props.compact ? (
        <p className="text-xs leading-5 text-fg-muted">
          Automatic saves become available immediately. Review first saves a proposal and lets the
          agent continue. Off stops agent changes; existing knowledge and skills remain available.
        </p>
      ) : (
        <p id={`${fieldId}-permissions`} className="sr-only">
          {UPDATE_PERMISSION_HELP}
        </p>
      )}
      <fieldset
        disabled={saving || refreshing || props.canEdit === false}
        aria-busy={refreshing || undefined}
        className="divide-y divide-border"
      >
        <legend className="sr-only">{props.compact ? "Agent updates" : "Agent learning"}</legend>
        {CATEGORIES.map(({ key, label, description }) => (
          <div key={key} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={`${fieldId}-${key}`} className="text-sm font-medium">
                {label}
              </label>
              {!props.compact ? (
                <p id={`${fieldId}-${key}-help`} className="mt-1 text-xs text-fg-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <LearningModeSelect
              id={`${fieldId}-${key}`}
              describedBy={props.compact ? `${fieldId}-permissions` : `${fieldId}-${key}-help`}
              value={record.settings[key] ?? "inherit"}
              compact={props.compact}
              allowInherit={!!props.source}
              defaultMode={defaults?.settings[key] ?? DEFAULT_AGENT_LEARNING[key]}
              onChange={(mode) => void save(key, mode)}
            />
          </div>
        ))}
      </fieldset>
      {props.compact ? (
        <p className="text-xs text-fg-muted">
          Off stops agent changes. Agents still use what's already there.
        </p>
      ) : null}
      {props.canEdit === false ? (
        <p className="text-xs text-fg-muted">
          A workspace administrator can change these defaults.
        </p>
      ) : null}
      {loadError ? (
        // The rows are the last ones read; say they may be out of date.
        <ErrorMessage
          variant="inline"
          title="Couldn't refresh Agent learning."
          action={
            isPermissionDenied(loadError) ? undefined : (
              <Button variant="ghost" size="sm" onClick={retryLoad}>
                Try again
              </Button>
            )
          }
          {...apiErrorDetails(loadError)}
        >
          {apiErrorAdvice(loadError)}
        </ErrorMessage>
      ) : null}
      {saveError ? (
        <p role="alert" className="text-xs text-status-error">
          Couldn't save that. {userErrorText(saveError)}
        </p>
      ) : null}
      <p role="status" className={saving || saved ? "text-xs text-fg-muted" : "sr-only"}>
        {saving ? "Saving…" : saved ? "Saved. Applies from the next agent run." : ""}
      </p>
    </div>
  );
}

/**
 * The editor's rows while its settings load: the same rows and heights, so a
 * menu or page that opens onto it never jumps when they arrive.
 */
export function AgentLearningSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div role="status" aria-label="Loading Agent learning" className="grid gap-3">
      <div aria-hidden="true" className="divide-y divide-border">
        {CATEGORIES.map(({ key }) => (
          <div key={key} className="flex items-center justify-between gap-3 py-3">
            <span className="h-3 w-24 animate-pulse rounded bg-surface-2" />
            <span className="h-8 w-36 animate-pulse rounded-md bg-surface-2" />
          </div>
        ))}
      </div>
      {compact ? <span aria-hidden="true" className="h-4" /> : null}
    </div>
  );
}

/** Draft choices are committed atomically with creation, before a schedule can run. */
export function AgentLearningDraftEditor(props: {
  workspaceId: string;
  scope: "workspace" | "personal";
  value: AgentLearningOverrides;
  onChange: (value: AgentLearningOverrides) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { client } = useAppContext();
  const id = useId();
  const [defaults, setDefaults] = useState<AgentLearningSettingsRecord | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let current = true;
    setDefaults(null);
    setError(null);
    void client
      .getAgentLearningSettings(props.workspaceId, props.scope)
      .then((value) => {
        if (current) setDefaults(value);
      })
      .catch((reason: unknown) => {
        if (current) setError(reason);
      });
    return () => {
      current = false;
    };
  }, [client, props.workspaceId, props.scope]);
  return (
    <fieldset disabled={props.disabled} className={props.compact ? "min-w-0" : "grid gap-3"}>
      <legend className={props.compact ? "sr-only" : "mb-2 text-sm font-medium"}>
        {props.compact ? "Agent updates" : "Agent learning"}
      </legend>
      {!props.compact ? (
        <p className="text-xs text-fg-muted">
          Override the defaults here. Review first saves proposals without pausing the agent.
        </p>
      ) : (
        <p id={`${id}-permissions`} className="sr-only">
          {UPDATE_PERMISSION_HELP}
        </p>
      )}
      <div className={props.compact ? "divide-y divide-border" : "grid gap-3"}>
        {CATEGORIES.map(({ key, label }) => (
          <div
            key={key}
            className={
              props.compact
                ? "flex flex-wrap items-center justify-between gap-3 py-3"
                : "flex flex-wrap items-center justify-between gap-2"
            }
          >
            <label
              htmlFor={`${id}-${key}`}
              className={props.compact ? "min-w-0 flex-1 text-sm font-medium" : "text-sm"}
            >
              {label}
            </label>
            <LearningModeSelect
              id={`${id}-${key}`}
              value={props.value[key] ?? "inherit"}
              compact={props.compact}
              describedBy={props.compact ? `${id}-permissions` : undefined}
              defaultMode={defaults?.settings[key]}
              allowInherit
              onChange={(value) => {
                const next = { ...props.value };
                if (value === "inherit") delete next[key];
                else next[key] = value as AgentLearningMode;
                props.onChange(next);
              }}
            />
          </div>
        ))}
      </div>
      {props.compact ? (
        <p className="mt-3 text-xs text-fg-muted">
          Off stops agent changes. Agents still use what's already there.
        </p>
      ) : null}
      {error ? (
        isPermissionDenied(error) ? (
          <p className="text-xs text-fg-muted">
            The workspace defaults aren't visible to you. A workspace admin can see them.
          </p>
        ) : (
          <p role="alert" className="text-xs text-status-error">
            Couldn't load the defaults. {userErrorText(error)}
          </p>
        )
      ) : null}
    </fieldset>
  );
}
