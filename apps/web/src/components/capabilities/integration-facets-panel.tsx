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
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from "react";
import { toast } from "sonner";

import type { GoogleDriveKnowledgeSourceDialogProps } from "@/components/capabilities/google-drive-knowledge-source-dialog";
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
  IntegrationFacetBindingSummary,
  IntegrationFacetDefinitionSummary,
  IntegrationInstanceFacetsResponse,
} from "@/types";

type FacetEntry = IntegrationInstanceFacetsResponse["facets"][number];
type FormValue = string | boolean;
type FacetFormState = Record<string, FormValue>;
type FacetMutationToken = {
  facetKey: string;
  generation: number;
  sequence: number;
};
type GoogleDriveDialogProps = GoogleDriveKnowledgeSourceDialogProps;

const KIND_DETAILS: Record<
  IntegrationFacetDefinitionSummary["kind"],
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

export function IntegrationFacetsPanel({
  client,
  workspaceId,
  instance,
  facetCount,
  canManage,
  canManagePersonalDestination,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  refreshRevision,
  GoogleDriveDialog,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  instance: ApiIntegrationInstallationSummary;
  facetCount: number;
  canManage: boolean;
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  refreshRevision: number;
  GoogleDriveDialog: ComponentType<GoogleDriveDialogProps>;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<IntegrationInstanceFacetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyFacetKeys, setBusyFacetKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [editor, setEditor] = useState<FacetEntry | null>(null);
  const [googleDriveEditor, setGoogleDriveEditor] = useState<FacetEntry | null>(null);
  const [form, setForm] = useState<FacetFormState>({});
  const [removeTarget, setRemoveTarget] = useState<FacetEntry | null>(null);
  const operationGeneration = useRef(0);
  const nextMutationSequence = useRef(0);
  const mutationSequenceByFacet = useRef(new Map<string, number>());
  const loadPromise = useRef<Promise<void> | null>(null);
  const seenRefreshRevision = useRef(refreshRevision);
  const panelIdentity = useRef({
    client,
    workspaceId,
    capabilityId: instance.capabilityId,
    instanceKey: instance.instanceKey,
    instanceVersion: instance.instanceVersion,
  });

  useEffect(() => {
    const previousIdentity = panelIdentity.current;
    const identityChanged =
      previousIdentity.client !== client ||
      previousIdentity.workspaceId !== workspaceId ||
      previousIdentity.capabilityId !== instance.capabilityId ||
      previousIdentity.instanceKey !== instance.instanceKey ||
      previousIdentity.instanceVersion !== instance.instanceVersion;
    panelIdentity.current = {
      client,
      workspaceId,
      capabilityId: instance.capabilityId,
      instanceKey: instance.instanceKey,
      instanceVersion: instance.instanceVersion,
    };
    if (identityChanged) {
      ++operationGeneration.current;
      mutationSequenceByFacet.current.clear();
      loadPromise.current = null;
      setData(null);
      setLoading(false);
      setError(null);
      setBusyFacetKeys(new Set());
      setOpen(false);
      setEditor(null);
      setGoogleDriveEditor(null);
      setRemoveTarget(null);
      seenRefreshRevision.current = refreshRevision;
    }
    const operationGenerationRef = operationGeneration;
    const mutationSequences = mutationSequenceByFacet.current;
    const loadPromiseRef = loadPromise;
    return () => {
      ++operationGenerationRef.current;
      mutationSequences.clear();
      loadPromiseRef.current = null;
    };
  }, [
    client,
    instance.capabilityId,
    instance.instanceKey,
    instance.instanceVersion,
    refreshRevision,
    workspaceId,
  ]);

  useEffect(() => {
    if (seenRefreshRevision.current === refreshRevision) return;
    seenRefreshRevision.current = refreshRevision;
    ++operationGeneration.current;
    mutationSequenceByFacet.current.clear();
    loadPromise.current = null;
    setData(null);
    setLoading(false);
    setError(null);
    setBusyFacetKeys(new Set());
    setEditor(null);
    setGoogleDriveEditor(null);
    setRemoveTarget(null);
    if (open) void load();
    // load is deliberately scoped to the current exact panel identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRevision]);

  useEffect(() => {
    if (open && data === null && !loading) void load();
    // load is deliberately scoped to this instance identity; retries call it directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (facetCount === 0) return null;

  async function load(): Promise<void> {
    if (loadPromise.current) return await loadPromise.current;
    const generation = ++operationGeneration.current;
    mutationSequenceByFacet.current.clear();
    setBusyFacetKeys(new Set());
    const pending = (async () => {
      setLoading(true);
      try {
        const response = await client.listIntegrationFacets(
          workspaceId,
          instance.capabilityId,
          instance.instanceKey,
        );
        if (generation !== operationGeneration.current) return;
        setData(response);
        setError(null);
      } catch (loadError) {
        if (generation !== operationGeneration.current) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (generation === operationGeneration.current) setLoading(false);
      }
    })();
    loadPromise.current = pending;
    try {
      await pending;
    } finally {
      if (loadPromise.current === pending) loadPromise.current = null;
    }
  }

  function edit(entry: FacetEntry): void {
    if (isGoogleDriveKnowledgeSource(entry)) {
      setGoogleDriveEditor(entry);
      return;
    }
    setEditor(entry);
    setForm(facetFormState(entry.definition, entry.binding));
  }

  function beginMutation(facetKey: string): FacetMutationToken {
    const token = {
      facetKey,
      generation: operationGeneration.current,
      sequence: ++nextMutationSequence.current,
    };
    mutationSequenceByFacet.current.set(facetKey, token.sequence);
    setBusyFacetKeys((current) => new Set(current).add(facetKey));
    return token;
  }

  function isCurrentMutation(token: FacetMutationToken): boolean {
    return (
      token.generation === operationGeneration.current &&
      mutationSequenceByFacet.current.get(token.facetKey) === token.sequence
    );
  }

  function applyMutationBinding(
    token: FacetMutationToken,
    binding: IntegrationFacetBindingSummary | null,
  ): boolean {
    if (!isCurrentMutation(token)) return false;
    setData((current) =>
      current ? replaceIntegrationFacetBinding(current, token.facetKey, binding) : current,
    );
    return true;
  }

  function finishMutation(token: FacetMutationToken): void {
    if (!isCurrentMutation(token)) return;
    mutationSequenceByFacet.current.delete(token.facetKey);
    setBusyFacetKeys((current) => {
      const next = new Set(current);
      next.delete(token.facetKey);
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor || !data) return;
    const target = editor;
    const currentData = data;
    const token = beginMutation(target.definition.facetKey);
    try {
      const configured = await client.configureIntegrationFacet(
        workspaceId,
        currentData.capabilityId,
        currentData.instanceKey,
        target.definition.facetKey,
        {
          displayName: `${instance.displayName} — ${facetTitle(target.definition)}`,
          config: facetConfigFromForm(target.definition, form),
          ...(target.binding ? { expectedVersion: target.binding.version } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (!applyMutationBinding(token, configured.binding)) return;
      setEditor(null);
      toast.success(`${facetTitle(target.definition)} configured`, {
        description: `This setting applies only to ${instance.displayName}.`,
      });
    } catch (saveError) {
      if (!isCurrentMutation(token)) return;
      toast.error("Couldn't save this facet", {
        description: saveError instanceof Error ? saveError.message : String(saveError),
      });
    } finally {
      finishMutation(token);
    }
  }

  async function changeLifecycle(entry: FacetEntry, action: "pause" | "resume"): Promise<void> {
    if (!entry.binding || !data) return;
    const currentData = data;
    const token = beginMutation(entry.definition.facetKey);
    try {
      const request = {
        expectedVersion: entry.binding.version,
        idempotencyKey: crypto.randomUUID(),
      };
      const result =
        action === "pause"
          ? await client.pauseIntegrationFacet(
              workspaceId,
              currentData.capabilityId,
              currentData.instanceKey,
              entry.definition.facetKey,
              request,
            )
          : await client.resumeIntegrationFacet(
              workspaceId,
              currentData.capabilityId,
              currentData.instanceKey,
              entry.definition.facetKey,
              request,
            );
      if (!applyMutationBinding(token, result.binding)) return;
      toast.success(`${facetTitle(entry.definition)} ${action === "pause" ? "paused" : "resumed"}`);
    } catch (lifecycleError) {
      if (!isCurrentMutation(token)) return;
      toast.error(`Couldn't ${action} this facet`, {
        description:
          lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError),
      });
    } finally {
      finishMutation(token);
    }
  }

  async function remove(): Promise<boolean> {
    if (!removeTarget?.binding || !data) return false;
    const target = removeTarget;
    const targetBinding = removeTarget.binding;
    const currentData = data;
    const token = beginMutation(target.definition.facetKey);
    try {
      const result = await client.removeIntegrationFacet(
        workspaceId,
        currentData.capabilityId,
        currentData.instanceKey,
        target.definition.facetKey,
        {
          expectedVersion: targetBinding.version,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (!applyMutationBinding(token, result.binding)) return false;
      setRemoveTarget(null);
      if (result.status === "retained_by_other_owners") {
        toast.success(`${facetTitle(target.definition)} direct control removed`, {
          description: `The facet remains active because ${facetOwnerSummary(result.remainingOwners)} still owns it.`,
        });
      } else if (result.status === "not_configured") {
        toast.info(`${facetTitle(target.definition)} was already managed elsewhere`, {
          description: `No direct facet control was removed from ${instance.displayName}.`,
        });
      } else {
        toast.success(`${facetTitle(target.definition)} removed`, {
          description: `${instance.displayName} and its Connection remain intact.`,
        });
      }
      return true;
    } catch (removeError) {
      if (!isCurrentMutation(token)) return false;
      toast.error("Couldn't remove this facet", {
        description: removeError instanceof Error ? removeError.message : String(removeError),
      });
      return false;
    } finally {
      finishMutation(token);
    }
  }

  const activeCount =
    data?.facets.filter((entry) => entry.binding?.status === "active").length ?? 0;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-1 w-full justify-between"
            aria-label={`Manage facets for ${instance.displayName}`}
          >
            <span className="flex items-center gap-1.5">
              <SlidersHorizontalIcon />
              Facets
              {data ? (
                <span className="text-fg-subtle">
                  {activeCount}/{data.facets.length}
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
            data-integration-facets={instance.instanceKey}
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
              data.facets.map((entry) => (
                <FacetRow
                  key={entry.definition.facetKey}
                  entry={entry}
                  busy={busyFacetKeys.has(entry.definition.facetKey)}
                  canManage={canManage}
                  onEdit={() => edit(entry)}
                  onPause={() => void changeLifecycle(entry, "pause")}
                  onResume={() => void changeLifecycle(entry, "resume")}
                  onRemove={() => setRemoveTarget(entry)}
                />
              ))
            ) : loading ? (
              <p className="py-3 text-center text-2xs text-fg-subtle">Loading facets…</p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <FacetEditorDialog
        entry={editor}
        form={form}
        busy={editor ? busyFacetKeys.has(editor.definition.facetKey) : false}
        onFormChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
        onClose={() => setEditor(null)}
        onSubmit={save}
      />

      {googleDriveEditor ? (
        <GoogleDriveDialog
          client={client}
          workspaceId={workspaceId}
          instance={instance}
          entry={googleDriveEditor}
          canManage={canManage}
          canManagePersonalDestination={canManagePersonalDestination}
          canManageWorkspaceDestination={canManageWorkspaceDestination}
          canManageOrganizationDestination={canManageOrganizationDestination}
          onClose={() =>
            setGoogleDriveEditor((current) => (current === googleDriveEditor ? null : current))
          }
          onMutationStart={() => {
            const token = beginMutation(googleDriveEditor.definition.facetKey);
            return {
              apply: (binding) => applyMutationBinding(token, binding),
              isCurrent: () => isCurrentMutation(token),
              finish: () => finishMutation(token),
            };
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(next) => !next && setRemoveTarget(null)}
        title={removeTarget ? `Remove ${facetTitle(removeTarget.definition)}?` : "Remove facet?"}
        description={
          removeTarget && otherFacetOwners(removeTarget.binding).length > 0
            ? `This removes direct control from ${instance.displayName}. The facet remains active because ${facetOwnerSummary(otherFacetOwners(removeTarget.binding))} also owns it.`
            : `This removes only this facet from ${instance.displayName}. The account, Connection, tools, and sibling facets remain intact.`
        }
        confirmLabel={
          removeTarget && otherFacetOwners(removeTarget.binding).length > 0
            ? "Remove direct control"
            : "Remove facet"
        }
        destructive
        onConfirm={remove}
      />
    </>
  );
}

export function replaceIntegrationFacetBinding(
  data: IntegrationInstanceFacetsResponse,
  facetKey: string,
  binding: IntegrationFacetBindingSummary | null,
): IntegrationInstanceFacetsResponse {
  return {
    ...data,
    facets: data.facets.map((entry) =>
      entry.definition.facetKey === facetKey ? { ...entry, binding } : entry,
    ),
  };
}

function FacetRow({
  entry,
  busy,
  canManage,
  onEdit,
  onPause,
  onResume,
  onRemove,
}: {
  entry: FacetEntry;
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
  const directlyOwned = binding?.directlyOwned === true;
  const otherOwners = otherFacetOwners(binding);
  const externallyManaged = configured && !directlyOwned;
  const independentlyMutable = directlyOwned && otherOwners.length === 0;
  const canConfigure = !configured && otherOwners.length === 0;
  return (
    <article
      className="rounded-lg border border-border bg-bg p-3"
      data-integration-facet={entry.definition.facetKey}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/5 text-brand">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-semibold text-fg">{facetTitle(entry.definition)}</p>
            <FacetStatusBadge binding={binding} />
            {otherOwners.length > 0 || externallyManaged ? (
              <Badge variant="outline" className="text-2xs text-fg-subtle">
                {otherOwners.length > 0 ? "Shared" : "Managed"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-2xs leading-4 text-fg-muted">{detail.description}</p>
          {otherOwners.length > 0 ? (
            <p className="mt-1 text-2xs leading-4 text-fg-subtle">
              Managed by {facetOwnerSummary(otherOwners)}. Shared configuration and lifecycle are
              read-only here.
            </p>
          ) : externallyManaged ? (
            <p className="mt-1 text-2xs leading-4 text-fg-subtle">
              Managed outside this direct installation. Configuration and lifecycle are read-only
              here.
            </p>
          ) : null}
        </div>
        {busy ? <Loader2Icon className="size-3.5 animate-spin text-brand" /> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!canManage || busy || (!canConfigure && !independentlyMutable)}
          onClick={onEdit}
        >
          {configured ? "Edit" : entry.definition.kind === "identity_link" ? "Enable" : "Configure"}
        </Button>
        {binding?.status === "active" && independentlyMutable ? (
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
        ) : (binding?.status === "paused" || binding?.status === "needs_attention") &&
          independentlyMutable ? (
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
        {configured && directlyOwned ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!canManage || busy}
            onClick={onRemove}
          >
            <Trash2Icon />
            {otherOwners.length > 0 ? "Remove direct control" : "Remove"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function FacetStatusBadge({ binding }: { binding: IntegrationFacetBindingSummary | null }) {
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

function otherFacetOwners(
  binding: IntegrationFacetBindingSummary | null,
): IntegrationFacetBindingSummary["owners"] {
  if (!binding) return [];
  let excludedCurrentDirectOwner = !binding.directlyOwned;
  return binding.owners.filter((owner) => {
    if (owner.kind === "direct" && !excludedCurrentDirectOwner) {
      excludedCurrentDirectOwner = true;
      return false;
    }
    return true;
  });
}

function facetOwnerSummary(owners: IntegrationFacetBindingSummary["owners"]): string {
  const kinds = new Set(owners.map((owner) => owner.kind));
  const labels = [
    kinds.has("plugin") ? "another Plugin" : null,
    kinds.has("pack") ? "another Pack" : null,
    kinds.has("migration") ? "migration authority" : null,
    kinds.has("direct") ? "another direct installation" : null,
  ].filter((label): label is string => label !== null);
  if (labels.length === 0) return "another owner";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function FacetEditorDialog({
  entry,
  form,
  busy,
  onFormChange,
  onClose,
  onSubmit,
}: {
  entry: FacetEntry | null;
  form: FacetFormState;
  busy: boolean;
  onFormChange: (key: string, value: FormValue) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const fields = useMemo(() => (entry ? facetFields(entry.definition) : []), [entry]);
  const unsupportedRequiredFields = useMemo(
    () => (entry ? unsupportedRequiredFacetFields(entry.definition) : []),
    [entry],
  );
  return (
    <Dialog open={entry !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? facetTitle(entry.definition) : "Configure facet"}</DialogTitle>
          <DialogDescription>
            {entry ? KIND_DETAILS[entry.definition.kind].description : "Configure this facet."}
          </DialogDescription>
        </DialogHeader>
        {entry ? (
          <form className="grid gap-4" onSubmit={onSubmit}>
            {fields.length === 0 ? (
              unsupportedRequiredFields.length > 0 ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm leading-6 text-fg-muted">
                  This provider needs a dedicated setup flow for:{" "}
                  {unsupportedRequiredFields.join(", ")}. The generic editor will not submit an
                  incomplete configuration.
                </div>
              ) : (
                <div className="rounded-lg border border-brand/20 bg-brand/5 p-4 text-sm leading-6 text-fg-muted">
                  This facet uses the connected account as-is. No additional setup is required.
                </div>
              )
            ) : (
              fields.map((field) => (
                <FacetField
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
                disabled={
                  busy ||
                  unsupportedRequiredFields.length > 0 ||
                  !requiredFieldsComplete(entry.definition, form)
                }
              >
                {busy ? <Loader2Icon className="animate-spin" /> : null}
                {entry.binding && entry.binding.status !== "disabled"
                  ? "Save changes"
                  : "Enable facet"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type FacetFieldDefinition = {
  key: string;
  label: string;
  type: "string" | "boolean" | "integer" | "number";
  required: boolean;
  options: string[];
  min?: number;
  max?: number;
};

function FacetField({
  field,
  value,
  onChange,
}: {
  field: FacetFieldDefinition;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
}) {
  const id = `integration-facet-${field.key}`;
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

export function facetFields(definition: IntegrationFacetDefinitionSummary): FacetFieldDefinition[] {
  const schema = definition.configSchema;
  const properties = objectValue(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  return Object.entries(properties).flatMap(([key, raw]): FacetFieldDefinition[] => {
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

export function unsupportedRequiredFacetFields(
  definition: IntegrationFacetDefinitionSummary,
): string[] {
  const schema = definition.configSchema;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const supported = new Set(facetFields(definition).map((field) => field.key));
  return required.filter((key) => !supported.has(key));
}

export function facetFormState(
  definition: IntegrationFacetDefinitionSummary,
  binding: IntegrationFacetBindingSummary | null,
): FacetFormState {
  const fields = facetFields(definition);
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

export function facetConfigFromForm(
  definition: IntegrationFacetDefinitionSummary,
  form: FacetFormState,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of facetFields(definition)) {
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
  definition: IntegrationFacetDefinitionSummary,
  form: FacetFormState,
): boolean {
  return facetFields(definition).every(
    (field) => !field.required || field.type === "boolean" || String(form[field.key] ?? "").trim(),
  );
}

function facetTitle(definition: IntegrationFacetDefinitionSummary): string {
  const specific = humanize(definition.facetKey);
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

function isGoogleDriveKnowledgeSource(entry: FacetEntry): boolean {
  return (
    entry.definition.facetKey === "drive-content" &&
    entry.definition.kind === "knowledge_source" &&
    entry.definition.capabilities.provider === "google-drive"
  );
}
