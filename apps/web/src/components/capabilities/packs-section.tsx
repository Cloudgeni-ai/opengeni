// Packs are the heaviest, workspace-runtime-altering capability (a sandbox
// image + skills + tools + connectors + knowledge + schedule templates that
// enable as one unit), so they keep a first-class surface with
// register/enable-with-variable-set/disable/unregister. Restyled flat for the
// I3 redesign: one card border per pack, dividers and whitespace instead of
// nested bordered boxes.
import type { usePacks } from "@opengeni/react";
import {
  ChevronDownIcon,
  Loader2Icon,
  PackageIcon,
  PlusIcon,
  SparkleIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { MetaChip } from "@/components/ui/meta-chip";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listViewState } from "@/lib/load-state";
import { scheduleLabel } from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type { CapabilityPack, PackInstallation } from "@/types";

export function PacksSection(props: {
  packs: ReturnType<typeof usePacks>;
  variableSets: Array<{ id: string; name: string }>;
  busyPackId: string | null;
  onRegister: (manifestDraft: string) => Promise<boolean>;
  onEnable: (pack: CapabilityPack, variableSetId: string | undefined) => void;
  onDisable: (pack: CapabilityPack) => void;
  onUnregister: (pack: CapabilityPack) => Promise<boolean>;
}) {
  const { packs } = props;
  const [registerOpen, setRegisterOpen] = useState(false);
  const [manifestDraft, setManifestDraft] = useState("");
  // Registration runs through a direct client call (not the packs hook), so this
  // local flag owns the button's pending/disabled state and blocks double-submits.
  const [registering, setRegistering] = useState(false);
  const packsView = listViewState({ loading: packs.loading, error: packs.error, count: packs.packs.length });

  async function register() {
    if (registering) return;
    setRegistering(true);
    try {
      const registered = await props.onRegister(manifestDraft);
      if (registered) {
        setRegisterOpen(false);
        setManifestDraft("");
      }
    } finally {
      setRegistering(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">Packs</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">
            Complete agent capabilities — a sandbox image, skills, tools, connectors, knowledge, and schedule templates that enable as one unit.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setRegisterOpen((open) => !open)}>
          <PlusIcon />
          Add manifest
        </Button>
      </div>

      {registerOpen ? (
        <div className="grid gap-2 rounded-xl border border-border bg-surface/50 p-4">
          <p className="text-xs leading-5 text-fg-subtle">
            Paste a pack manifest as JSON. It registers a workspace-scoped pack you can then enable.
          </p>
          <textarea
            value={manifestDraft}
            onChange={(event) => setManifestDraft(event.target.value)}
            placeholder='{"id": "my-pack", "name": "My pack", "version": "1.0.0", …}'
            className="min-h-40 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            aria-label="Pack manifest JSON"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setRegisterOpen(false)}>Cancel</Button>
            <Button type="button" size="sm" disabled={registering || !manifestDraft.trim()} onClick={() => void register()}>
              {registering ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Register pack
            </Button>
          </div>
        </div>
      ) : null}

      {packsView === "loading" ? (
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      ) : packsView === "error" ? (
        <LoadErrorState title="Couldn't load packs" error={packs.error} onRetry={() => void packs.refresh()} />
      ) : packsView === "empty" ? (
        <EmptyState
          icon={<PackageIcon className="size-4" />}
          title="No packs yet"
          description="Register a pack manifest to add a complete agent capability to this workspace."
          action={(
            <Button type="button" size="sm" onClick={() => setRegisterOpen(true)}>
              <PlusIcon />
              Add manifest
            </Button>
          )}
        />
      ) : (
        <div className="grid gap-3">
          {packs.packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              installation={packs.installationFor(pack.id)}
              variableSets={props.variableSets}
              busy={props.busyPackId === pack.id}
              onEnable={(variableSetId) => props.onEnable(pack, variableSetId)}
              onDisable={() => props.onDisable(pack)}
              onUnregister={() => props.onUnregister(pack)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PackCard(props: {
  pack: CapabilityPack;
  installation: PackInstallation | null;
  variableSets: Array<{ id: string; name: string }>;
  busy: boolean;
  onEnable: (variableSetId: string | undefined) => void;
  onDisable: () => void;
  onUnregister: () => Promise<boolean>;
}) {
  const { pack, installation } = props;
  const enabled = installation?.status === "active";
  const [expanded, setExpanded] = useState(false);
  const [variableSetId, setVariableSetId] = useState("");
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const needsVariableSet = pack.variableSet?.required === true;

  return (
    <article className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2/70 text-brand">
              <PackageIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-medium">{pack.name}</h3>
                <MetaChip className="font-mono">v{pack.version}</MetaChip>
                {enabled ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium text-status-idle">
                    <span className="size-1.5 rounded-full bg-status-idle" />
                    Enabled
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-fg-subtle">
                <span>{pack.role}</span>
                <span aria-hidden className="text-fg-subtle/50">·</span>
                <span>{pack.category}</span>
              </div>
            </div>
          </div>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-fg-muted">{pack.description}</p>
          {pack.skills.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pack.skills.map((skill) => (
                <MetaChip key={skill.name} title={skill.description}>
                  <SparkleIcon className="size-3 shrink-0" />
                  {skill.name}
                </MetaChip>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
              Contents
            </Button>
            {enabled ? (
              <Button type="button" variant="outline" size="sm" className="min-w-24" disabled={props.busy} onClick={props.onDisable}>
                {props.busy ? <Loader2Icon className="animate-spin" /> : <XIcon />}
                Disable
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="min-w-24"
                disabled={props.busy || (needsVariableSet && !variableSetId)}
                title={needsVariableSet && !variableSetId ? "This pack needs a variableSet attached first" : undefined}
                onClick={() => props.onEnable(variableSetId || undefined)}
              >
                {props.busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
                Enable
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Unregister ${pack.name}`}
              className="text-fg-subtle hover:text-status-failed"
              disabled={props.busy}
              title="Unregister this pack (built-ins can't be removed)"
              onClick={() => setConfirmUnregister(true)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
          {pack.variableSet ? (
            <Select
              value={variableSetId}
              onChange={(event) => setVariableSetId(event.target.value)}
              aria-label={`Variable set for ${pack.name}`}
              className="h-8 text-xs"
            >
              <option value="">{needsVariableSet ? "Choose variableSet (required)" : "No variableSet"}</option>
              {props.variableSets.map((variableSet) => (
                <option key={variableSet.id} value={variableSet.id}>{variableSet.name}</option>
              ))}
            </Select>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2">
          <PackSection title="Tools">
            {pack.tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {pack.tools.map((tool) => (
                  <MetaChip key={`${tool.kind}:${tool.id}`} className="font-mono">{tool.id}</MetaChip>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Skills">
            {pack.skills.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.skills.map((skill) => (
                  <div key={skill.name} className="min-w-0">
                    <div className="truncate text-xs font-medium">{skill.name}</div>
                    <div className="text-2xs text-fg-subtle">
                      {skill.description ?? "No description"} · {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
                    </div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Connectors">
            {pack.connectors.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.connectors.map((connector) => (
                  <div key={connector.id} className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{connector.name}</span>
                      {connector.required ? <MetaChip dot="waiting">Required</MetaChip> : null}
                    </div>
                    <div className="text-2xs text-fg-subtle">
                      {[connector.authModel, connector.providers.join(", "), connector.scopes.length ? `${connector.scopes.length} scopes` : null].filter(Boolean).join(" / ")}
                    </div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Knowledge">
            {pack.knowledge.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.knowledge.map((knowledge) => (
                  <div key={knowledge.id} className="min-w-0">
                    <div className="truncate text-xs font-medium">{knowledge.name}</div>
                    {knowledge.description ? <div className="line-clamp-2 text-2xs text-fg-subtle">{knowledge.description}</div> : null}
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Schedule templates">
            {pack.scheduledTaskTemplates.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.scheduledTaskTemplates.map((template) => (
                  <div key={template.id} className="min-w-0">
                    <div className="truncate text-xs font-medium">{template.name}</div>
                    <div className="text-2xs text-fg-subtle">{scheduleLabel(template.defaultSchedule)}</div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          {pack.variableSet ? (
            <PackSection title="Variable set">
              <div className="text-2xs text-fg-subtle">{pack.variableSet.description}</div>
              {pack.variableSet.requiredVariables.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {pack.variableSet.requiredVariables.map((name) => (
                    <MetaChip key={name} className="font-mono">{name}</MetaChip>
                  ))}
                </div>
              ) : null}
            </PackSection>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmUnregister}
        onOpenChange={setConfirmUnregister}
        title={`Unregister ${pack.name}?`}
        description={enabled
          ? "This pack is enabled. Unregistering removes it from the workspace and disables it for every session."
          : "This removes the pack from the workspace. You can register its manifest again later."}
        confirmLabel="Unregister pack"
        onConfirm={props.onUnregister}
      />
    </article>
  );
}

function PackSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</div>
      {children}
    </section>
  );
}

function PackNone() {
  return <div className="text-2xs text-fg-subtle">None declared</div>;
}
