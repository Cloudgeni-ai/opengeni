import {
  BellRingIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CirclePauseIcon,
  Link2Icon,
  Loader2Icon,
  RefreshCwIcon,
  SendIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { useEffect, useMemo, useState, type ComponentType, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  ApiIntegrationInstallationSummary,
  IntegrationFeatureBindingSummary,
  IntegrationFeatureDefinitionSummary,
  IntegrationInstanceFeaturesResponse,
} from "@/types";

type FeatureEntry = IntegrationInstanceFeaturesResponse["features"][number];
type FormValue = string | boolean;
type FeatureFormState = Record<string, FormValue>;

const KIND_DETAILS: Record<
  IntegrationFeatureDefinitionSummary["kind"],
  {
    label: string;
    description: string;
    icon: ComponentType<{ className?: string }>;
  }
> = {
  knowledge_source: {
    label: "Knowledge source",
    description: "Choose what this account contributes to searchable workspace knowledge.",
    icon: BookOpenIcon,
  },
  inbound_trigger: {
    label: "Inbound trigger",
    description: "Choose what OpenGeni watches for new work from this account.",
    icon: BellRingIcon,
  },
  delivery_destination: {
    label: "Delivery destination",
    description: "Control how OpenGeni can deliver through this account.",
    icon: SendIcon,
  },
  identity_link: {
    label: "Identity link",
    description: "Make the connected provider identity available to authorized workflows.",
    icon: Link2Icon,
  },
};

export function IntegrationFeaturesPanel({
  client,
  workspaceId,
  instance,
  featureCount,
  canManage,
}: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  instance: ApiIntegrationInstallationSummary;
  featureCount: number;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<IntegrationInstanceFeaturesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyFeatureKey, setBusyFeatureKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<FeatureEntry | null>(null);
  const [form, setForm] = useState<FeatureFormState>({});
  const [removeTarget, setRemoveTarget] = useState<FeatureEntry | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    setOpen(false);
  }, [instance.capabilityId, instance.instanceKey, instance.instanceVersion]);

  useEffect(() => {
    if (open && data === null && !loading) void load();
    // load is deliberately scoped to this instance identity; retries call it directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (featureCount === 0) return null;

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setData(
        await client.listIntegrationFeatures(
          workspaceId,
          instance.capabilityId,
          instance.instanceKey,
        ),
      );
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  function edit(entry: FeatureEntry): void {
    setEditor(entry);
    setForm(featureFormState(entry.definition, entry.binding));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor) return;
    setBusyFeatureKey(editor.definition.featureKey);
    try {
      await client.configureIntegrationFeature(
        workspaceId,
        data!.capabilityId,
        data!.instanceKey,
        editor.definition.featureKey,
        {
          displayName: `${instance.displayName} — ${featureTitle(editor.definition)}`,
          config: featureConfigFromForm(editor.definition, form),
          ...(editor.binding ? { expectedVersion: editor.binding.version } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setEditor(null);
      await load();
      toast.success(`${featureTitle(editor.definition)} configured`, {
        description: `This setting applies only to ${instance.displayName}.`,
      });
    } catch (saveError) {
      toast.error("Couldn't save this feature", {
        description: saveError instanceof Error ? saveError.message : String(saveError),
      });
    } finally {
      setBusyFeatureKey(null);
    }
  }

  async function changeLifecycle(entry: FeatureEntry, action: "pause" | "resume"): Promise<void> {
    if (!entry.binding) return;
    setBusyFeatureKey(entry.definition.featureKey);
    try {
      const request = {
        expectedVersion: entry.binding.version,
        idempotencyKey: crypto.randomUUID(),
      };
      if (action === "pause") {
        await client.pauseIntegrationFeature(
          workspaceId,
          data!.capabilityId,
          data!.instanceKey,
          entry.definition.featureKey,
          request,
        );
      } else {
        await client.resumeIntegrationFeature(
          workspaceId,
          data!.capabilityId,
          data!.instanceKey,
          entry.definition.featureKey,
          request,
        );
      }
      await load();
      toast.success(
        `${featureTitle(entry.definition)} ${action === "pause" ? "paused" : "resumed"}`,
      );
    } catch (lifecycleError) {
      toast.error(`Couldn't ${action} this feature`, {
        description:
          lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError),
      });
    } finally {
      setBusyFeatureKey(null);
    }
  }

  async function remove(): Promise<boolean> {
    if (!removeTarget?.binding || !data) return false;
    setBusyFeatureKey(removeTarget.definition.featureKey);
    try {
      await client.removeIntegrationFeature(
        workspaceId,
        data.capabilityId,
        data.instanceKey,
        removeTarget.definition.featureKey,
        {
          expectedVersion: removeTarget.binding.version,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setRemoveTarget(null);
      await load();
      toast.success(`${featureTitle(removeTarget.definition)} removed`, {
        description: `${instance.displayName} and its Connection remain intact.`,
      });
      return true;
    } catch (removeError) {
      toast.error("Couldn't remove this feature", {
        description: removeError instanceof Error ? removeError.message : String(removeError),
      });
      return false;
    } finally {
      setBusyFeatureKey(null);
    }
  }

  const activeCount =
    data?.features.filter((entry) => entry.binding?.status === "active").length ?? 0;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-1 w-full justify-between"
            aria-label={`Manage features for ${instance.displayName}`}
          >
            <span className="flex items-center gap-1.5">
              <SlidersHorizontalIcon />
              Features
              {data ? (
                <span className="text-fg-subtle">
                  {activeCount}/{data.features.length}
                </span>
              ) : null}
            </span>
            {loading ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            className="mt-2 grid gap-2 border-t border-border/70 pt-3"
            data-integration-features={instance.instanceKey}
          >
            {error ? (
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="text-2xs leading-5 text-fg-muted">{error}</p>
                <Button type="button" variant="ghost" size="xs" onClick={() => void load()}>
                  <RefreshCwIcon />
                  Retry
                </Button>
              </div>
            ) : data ? (
              data.features.map((entry) => (
                <FeatureRow
                  key={entry.definition.featureKey}
                  entry={entry}
                  busy={busyFeatureKey === entry.definition.featureKey}
                  canManage={canManage}
                  onEdit={() => edit(entry)}
                  onPause={() => void changeLifecycle(entry, "pause")}
                  onResume={() => void changeLifecycle(entry, "resume")}
                  onRemove={() => setRemoveTarget(entry)}
                />
              ))
            ) : loading ? (
              <p className="py-3 text-center text-2xs text-fg-subtle">Loading features…</p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <FeatureEditorDialog
        entry={editor}
        form={form}
        busy={editor ? busyFeatureKey === editor.definition.featureKey : false}
        onFormChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
        onClose={() => setEditor(null)}
        onSubmit={save}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(next) => !next && setRemoveTarget(null)}
        title={
          removeTarget ? `Remove ${featureTitle(removeTarget.definition)}?` : "Remove feature?"
        }
        description={`This removes only this feature from ${instance.displayName}. The account, Connection, tools, and sibling features remain intact.`}
        confirmLabel="Remove feature"
        destructive
        onConfirm={remove}
      />
    </>
  );
}

function FeatureRow({
  entry,
  busy,
  canManage,
  onEdit,
  onPause,
  onResume,
  onRemove,
}: {
  entry: FeatureEntry;
  busy: boolean;
  canManage: boolean;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  const detail = KIND_DETAILS[entry.definition.kind];
  const Icon = detail.icon;
  const binding = entry.binding;
  const configured = binding !== null && binding.status !== "disabled";
  return (
    <article
      className="rounded-lg border border-border bg-bg p-3"
      data-integration-feature={entry.definition.featureKey}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/5 text-brand">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-semibold text-fg">{featureTitle(entry.definition)}</p>
            <FeatureStatusBadge binding={binding} />
          </div>
          <p className="mt-1 text-2xs leading-4 text-fg-muted">{detail.description}</p>
        </div>
        {busy ? <Loader2Icon className="size-3.5 animate-spin text-brand" /> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!canManage || busy}
          onClick={onEdit}
        >
          {configured ? "Edit" : entry.definition.kind === "identity_link" ? "Enable" : "Configure"}
        </Button>
        {binding?.status === "active" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!canManage || busy}
            onClick={onPause}
          >
            <CirclePauseIcon />
            Pause
          </Button>
        ) : binding?.status === "paused" || binding?.status === "needs_attention" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!canManage || busy}
            onClick={onResume}
          >
            <CheckCircle2Icon />
            Resume
          </Button>
        ) : null}
        {configured ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!canManage || busy}
            onClick={onRemove}
          >
            <Trash2Icon />
            Remove
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function FeatureStatusBadge({ binding }: { binding: IntegrationFeatureBindingSummary | null }) {
  const status = binding?.status ?? "not_configured";
  const label =
    status === "active"
      ? "Active"
      : status === "paused"
        ? "Paused"
        : status === "needs_attention"
          ? "Needs attention"
          : "Not configured";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-2xs",
        status === "active"
          ? "border-success/30 bg-success/5 text-success"
          : status === "needs_attention"
            ? "border-warning/30 text-warning"
            : "text-fg-subtle",
      )}
    >
      {label}
    </Badge>
  );
}

function FeatureEditorDialog({
  entry,
  form,
  busy,
  onFormChange,
  onClose,
  onSubmit,
}: {
  entry: FeatureEntry | null;
  form: FeatureFormState;
  busy: boolean;
  onFormChange: (key: string, value: FormValue) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const fields = useMemo(() => (entry ? featureFields(entry.definition) : []), [entry]);
  return (
    <Dialog open={entry !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? featureTitle(entry.definition) : "Configure feature"}</DialogTitle>
          <DialogDescription>
            {entry ? KIND_DETAILS[entry.definition.kind].description : "Configure this feature."}
          </DialogDescription>
        </DialogHeader>
        {entry ? (
          <form className="grid gap-4" onSubmit={onSubmit}>
            {fields.length === 0 ? (
              <div className="rounded-lg border border-brand/20 bg-brand/5 p-4 text-sm leading-6 text-fg-muted">
                This feature uses the connected account as-is. No additional setup is required.
              </div>
            ) : (
              fields.map((field) => (
                <FeatureField
                  key={field.key}
                  field={field}
                  value={form[field.key]}
                  onChange={(value) => onFormChange(field.key, value)}
                />
              ))
            )}
            <p className="text-2xs leading-5 text-fg-subtle">
              Provider credentials and sync cursors stay private. Changes apply only to this named
              account.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !requiredFieldsComplete(entry.definition, form)}
              >
                {busy ? <Loader2Icon className="animate-spin" /> : null}
                {entry.binding && entry.binding.status !== "disabled"
                  ? "Save changes"
                  : "Enable feature"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type FeatureFieldDefinition = {
  key: string;
  label: string;
  type: "string" | "boolean" | "integer" | "number";
  required: boolean;
  options: string[];
  min?: number;
  max?: number;
};

function FeatureField({
  field,
  value,
  onChange,
}: {
  field: FeatureFieldDefinition;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
}) {
  const id = `integration-feature-${field.key}`;
  if (field.type === "boolean") {
    return (
      <label htmlFor={id} className="flex items-start gap-3 rounded-lg border border-border p-3">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 accent-brand"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium text-fg">{field.label}</span>
          <span className="mt-0.5 block text-2xs text-fg-subtle">Optional account behavior</span>
        </span>
      </label>
    );
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? " *" : ""}
      </Label>
      {field.options.length > 0 ? (
        <Select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {!field.required ? <option value="">Use provider default</option> : null}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {humanize(option)}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === "integer" || field.type === "number" ? "number" : "text"}
          required={field.required}
          min={field.min}
          max={field.max}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

export function featureFields(
  definition: IntegrationFeatureDefinitionSummary,
): FeatureFieldDefinition[] {
  const schema = definition.configSchema;
  const properties = objectValue(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  return Object.entries(properties).flatMap(([key, raw]): FeatureFieldDefinition[] => {
    const property = objectValue(raw);
    const type = property.type;
    if (type !== "string" && type !== "boolean" && type !== "integer" && type !== "number") {
      return [];
    }
    return [
      {
        key,
        label: humanize(key),
        type,
        required: required.has(key),
        options: Array.isArray(property.enum)
          ? property.enum.filter((entry): entry is string => typeof entry === "string")
          : [],
        ...(typeof property.minimum === "number" ? { min: property.minimum } : {}),
        ...(typeof property.maximum === "number" ? { max: property.maximum } : {}),
      },
    ];
  });
}

export function featureFormState(
  definition: IntegrationFeatureDefinitionSummary,
  binding: IntegrationFeatureBindingSummary | null,
): FeatureFormState {
  const fields = featureFields(definition);
  const config = binding?.config ?? {};
  return Object.fromEntries(
    fields.map((field) => {
      const current = config[field.key];
      if (field.type === "boolean") return [field.key, current === true];
      if (typeof current === "number") return [field.key, String(current)];
      if (typeof current === "string") return [field.key, current];
      return [field.key, field.required && field.options.length > 0 ? field.options[0]! : ""];
    }),
  );
}

export function featureConfigFromForm(
  definition: IntegrationFeatureDefinitionSummary,
  form: FeatureFormState,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of featureFields(definition)) {
    const value = form[field.key];
    if (field.type === "boolean") {
      config[field.key] = value === true;
    } else if (typeof value === "string" && value.trim()) {
      config[field.key] =
        field.type === "integer" || field.type === "number" ? Number(value) : value.trim();
    }
  }
  return config;
}

function requiredFieldsComplete(
  definition: IntegrationFeatureDefinitionSummary,
  form: FeatureFormState,
): boolean {
  return featureFields(definition).every(
    (field) => !field.required || field.type === "boolean" || String(form[field.key] ?? "").trim(),
  );
}

function featureTitle(definition: IntegrationFeatureDefinitionSummary): string {
  const specific = humanize(definition.featureKey);
  const generic = KIND_DETAILS[definition.kind].label;
  return specific.toLowerCase() === generic.toLowerCase() ? generic : specific;
}

function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_]/g, " ")
    .trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
