import type { ModelAccountPreferences } from "@opengeni/sdk";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { RowButton } from "@/components/ui/page-actions";
import { ModelPicker } from "@/components/pickers";
import { Section } from "@/components/ui/section";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";

/** Edit one exact preferred-model mapping. Never infer model equivalence. */
export function FallbackOrderControl({
  order,
  modelLabel,
  disabled = false,
  saving,
  onSave,
  onReset,
}: {
  order: Record<string, string[]>;
  modelLabel: (id: string) => string;
  disabled?: boolean;
  saving: boolean;
  onSave: (model: string, fallbackIds: string[]) => Promise<void>;
  onReset?: ((model: string) => Promise<void>) | undefined;
}) {
  const catalog = useAppContext().clientConfig?.models ?? [];
  const labels = new Map(catalog.map((model) => [model.id, model.label]));
  const ids = [
    ...new Set([
      ...catalog.map((model) => model.id),
      ...Object.keys(order),
      ...Object.values(order).flat(),
    ]),
  ];
  const label = (id: string) => labels.get(id) ?? modelLabel(id);
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(Object.keys(order)[0] ?? ids[0] ?? "");
  const [draft, setDraft] = useState<string[]>(order[model] ?? []);
  const saved = JSON.stringify(order[model] ?? []);
  useEffect(() => setDraft(JSON.parse(saved) as string[]), [model, saved]);
  const busy = disabled || saving;
  const move = (index: number, delta: number) =>
    setDraft((previous) => {
      const next = [...previous];
      [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
      return next;
    });
  if (!editing)
    return (
      <RowButton disabled={busy} onClick={() => setEditing(true)}>
        Edit order
      </RowButton>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="text-xs text-fg-muted">Preferred model</span>
      <ModelPicker
        models={catalog}
        model={model}
        effort="none"
        latencyMode="standard"
        disabled={busy}
        triggerStyle="field"
        allowLatencyMode={false}
        allowModelOptions={false}
        collapseScopes={false}
        onModelChange={setModel}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />
      <ol aria-label="Fallback order" className="m-0 list-none space-y-2 p-0">
        {draft.map((id, index) => (
          <li key={id} className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-sm" title={label(id)}>
              {index + 1}. {label(id)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${label(id)} up`}
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${label(id)} down`}
              disabled={busy || index === draft.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label(id)}`}
              disabled={busy}
              onClick={() => setDraft((previous) => previous.filter((each) => each !== id))}
            >
              <XIcon className="size-4" />
            </Button>
          </li>
        ))}
      </ol>
      {draft.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No fallback for this model.</p>
      ) : null}
      <span className="text-xs text-fg-muted">Add a fallback model</span>
      <ModelPicker
        models={catalog.filter((entry) => entry.id !== model && !draft.includes(entry.id))}
        model=""
        effort="none"
        latencyMode="standard"
        disabled={busy || !model}
        triggerStyle="field"
        allowLatencyMode={false}
        allowModelOptions={false}
        collapseScopes={false}
        onModelChange={(id) =>
          setDraft((previous) =>
            previous.includes(id) || id === model ? previous : [...previous, id],
          )
        }
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />
      <div className="flex flex-wrap items-center gap-2">
        <RowButton
          disabled={
            busy || !model || (Object.hasOwn(order, model) && JSON.stringify(draft) === saved)
          }
          onClick={() => void onSave(model, draft)}
        >
          Save order
        </RowButton>
        {onReset ? (
          <RowButton disabled={busy || !model} onClick={() => void onReset(model)}>
            Use organization order
          </RowButton>
        ) : null}
        <RowButton
          disabled={saving}
          onClick={() => {
            setDraft(JSON.parse(saved) as string[]);
            setEditing(false);
          }}
        >
          Close
        </RowButton>
      </div>
    </div>
  );
}

/** A person's opt-in is separate from organization permission and account choice. */
export function PersonalFallbackPreference(props: {
  organizationId: string | undefined;
  allowed: boolean;
}) {
  const subject = useAppContext().authSession?.user.id;
  // Organization service credentials never stand in for a person's preference.
  return subject ? (
    <HumanPersonalFallbackPreference key={`${subject}:${props.organizationId}`} {...props} />
  ) : null;
}

function HumanPersonalFallbackPreference({
  organizationId,
  allowed,
}: {
  organizationId: string | undefined;
  allowed: boolean;
}) {
  const { client } = useAppContext();
  const [loaded, setLoaded] = useState<{
    organizationId: string;
    value: ModelAccountPreferences;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    savingRef.current = false;
    setSaving(false);
    setLoaded(null);
    setError(null);
    if (organizationId)
      void client.getModelAccountPreferences(organizationId).then(
        (value) => {
          if (current === generation.current) setLoaded({ organizationId, value });
        },
        () => {
          if (current === generation.current) setError("Couldn’t load your account preference.");
        },
      );
    return () => {
      generation.current += 1;
    };
  }, [client, organizationId, reload]);
  if (!organizationId) return null;
  const value = loaded?.organizationId === organizationId ? loaded.value : null;
  const save = async (personalFallbackOptIn: boolean) => {
    if (!value || (personalFallbackOptIn && !allowed) || savingRef.current) return;
    const current = generation.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await client.updateModelAccountPreferences(organizationId, {
        personalFallbackOptIn,
        expectedVersion: value.version,
      });
      if (current === generation.current) setLoaded({ organizationId, value: saved });
    } catch {
      if (current !== generation.current) return;
      toast.error("Couldn’t save your account preference. Reload and try again.");
      setReload((previous) => previous + 1);
    } finally {
      if (current === generation.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };
  return (
    <Section title="Your account preference">
      {error ? (
        <ErrorMessage
          title={error}
          action={
            <RowButton onClick={() => setReload((previous) => previous + 1)}>Try again</RowButton>
          }
        />
      ) : (
        <SettingRowGroup>
          <SettingRow
            label="Fall back to my account"
            description="Use an eligible account of yours when shared accounts run out. Applies wherever this organization allows personal fallback."
            controlWidth="compact"
            control={
              <Switch
                checked={value?.personalFallbackOptIn ?? false}
                pending={saving}
                disabled={!value || (!allowed && !value.personalFallbackOptIn) || saving}
                disabledReason={
                  !allowed && !value?.personalFallbackOptIn
                    ? "Personal fallback is not allowed here."
                    : !value
                      ? "Loading your preference."
                      : undefined
                }
                onCheckedChange={(checked) => void save(checked)}
              />
            }
          />
        </SettingRowGroup>
      )}
    </Section>
  );
}
