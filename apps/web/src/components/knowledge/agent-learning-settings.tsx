import type {
  AgentLearningCategory,
  AgentLearningContext,
  AgentLearningMode,
  AgentLearningSettingsRecord,
  AgentLearningOverrides,
} from "@opengeni/sdk";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";

export const LEARNING_MODE_LABEL: Record<AgentLearningMode, string> = {
  automatic: "Automatic",
  review_first: "Review first",
  off: "Off",
};
const UPDATE_PERMISSION_LABEL: Record<AgentLearningMode, string> = {
  automatic: "Allow updates",
  review_first: "Review first",
  off: "Don’t allow updates",
};

const UPDATE_PERMISSION_HELP =
  "Allow updates applies changes automatically. Review first requires approval. Don’t allow updates prevents agent changes.";

function LearningModeSelect(props: {
  id: string;
  value: AgentLearningMode | "inherit";
  defaultMode?: AgentLearningMode;
  allowInherit: boolean;
  compact?: boolean;
  describedBy?: string;
  onChange: (mode: AgentLearningMode | "inherit") => void;
}) {
  const labels = props.compact ? UPDATE_PERMISSION_LABEL : LEARNING_MODE_LABEL;
  const effectiveMode = props.value === "inherit" ? props.defaultMode : props.value;
  return (
    <Select
      id={props.id}
      aria-describedby={props.describedBy}
      value={props.value}
      className={props.compact ? "w-[174px]" : undefined}
      displayValue={
        props.compact ? (effectiveMode ? labels[effectiveMode] : "Use default") : undefined
      }
      onChange={(event) => props.onChange(event.target.value as AgentLearningMode | "inherit")}
    >
      {props.allowInherit ? (
        <option value="inherit">
          Use default{props.defaultMode ? ` (${labels[props.defaultMode]})` : ""}
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
    label: "Workspace instructions",
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
  const [record, setRecord] = useState<AgentLearningSettingsRecord | null>(null);
  const [defaults, setDefaults] = useState<AgentLearningSettingsRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const sourceKind = props.source?.kind;
  const sourceId = props.source?.id;
  useEffect(() => {
    let current = true;
    setRecord(null);
    setError(null);
    setSaved(false);
    const source = sourceKind && sourceId ? { kind: sourceKind, id: sourceId } : undefined;
    void Promise.all([
      context.client.getAgentLearningSettings(props.workspaceId, props.scope, source),
      context.client.getAgentLearningSettings(props.workspaceId, props.scope),
    ])
      .then(([value, base]) => {
        if (current) {
          setRecord(value);
          setDefaults(base);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      current = false;
    };
  }, [context.client, props.workspaceId, props.scope, sourceKind, sourceId, reload]);

  async function save(category: AgentLearningCategory, mode: AgentLearningMode | "inherit") {
    if (!record || saving || props.canEdit === false) return;
    const invocation = context.captureWorkspaceInvocation(props.workspaceId);
    if (!invocation) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await context.client.saveAgentLearningSettings(props.workspaceId, {
        scope: props.scope,
        ...(props.source ? { source: props.source } : {}),
        operationId: crypto.randomUUID(),
        expectedVersion: record.version,
        settings: props.source ? { [category]: mode } : { ...record.settings, [category]: mode },
      });
      if (active.current && context.ownsWorkspaceInvocation(props.workspaceId, invocation)) {
        setRecord(next);
        setSaved(true);
        props.onSaved?.();
      }
    } catch (reason) {
      if (active.current && context.ownsWorkspaceInvocation(props.workspaceId, invocation)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (active.current) setSaving(false);
    }
  }

  if (!record)
    return error ? (
      <div role="alert" className="text-sm text-status-error">
        {error}
        <Button variant="ghost" onClick={() => setReload((n) => n + 1)}>
          Retry
        </Button>
      </div>
    ) : (
      <p role="status" className="text-sm text-fg-muted">
        Loading Agent learning…
      </p>
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
      <fieldset disabled={saving || props.canEdit === false} className="divide-y divide-border">
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
              defaultMode={defaults?.settings[key] ?? "review_first"}
              onChange={(mode) => void save(key, mode)}
            />
          </div>
        ))}
      </fieldset>
      {props.compact ? (
        <p className="text-xs text-fg-muted">
          Agents can still use these resources when updates are off.
        </p>
      ) : null}
      {props.canEdit === false ? (
        <p className="text-xs text-fg-muted">
          A workspace administrator can change these defaults.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      ) : null}
      <p role="status" className={saving || saved ? "text-xs text-fg-muted" : "sr-only"}>
        {saving ? "Saving…" : saved ? "Saved. Applies from the next agent run." : ""}
      </p>
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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setDefaults(null);
    setError(null);
    setError(null);
    void client
      .getAgentLearningSettings(props.workspaceId, props.scope)
      .then((value) => {
        if (current) setDefaults(value);
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
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
          Agents can still use these resources when updates are off.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-status-error">
          Couldn't load defaults: {error}
        </p>
      ) : null}
    </fieldset>
  );
}
