// Packs: complete agent capabilities (sandbox image + skills + tools +
// connectors + knowledge + schedule templates) registered per workspace.
// Built-ins ship with the platform; custom packs register via manifest.
// Disable goes through the capability installation (pack:{id}); unregister
// removes a workspace-scoped manifest entirely.
import { usePacks } from "@opengeni/react";
import { useEnvironments } from "@opengeni/react";
import {
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  ContainerIcon,
  FileCode2Icon,
  Loader2Icon,
  PackageIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SparkleIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAppContext } from "@/context";
import { capabilityErrorToast } from "@/lib/capabilities";
import { scheduleLabel } from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type { CapabilityPack, PackInstallation } from "@/types";

export function PacksRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const packs = usePacks();
  const environments = useEnvironments();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [manifestDraft, setManifestDraft] = useState("");
  const [busyPackId, setBusyPackId] = useState<string | null>(null);

  async function registerManifest() {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestDraft);
    } catch {
      toast.error("Manifest must be valid JSON");
      return;
    }
    const registered = await packs.register(manifest as Parameters<typeof packs.register>[0]);
    if (registered) {
      setRegisterOpen(false);
      setManifestDraft("");
      toast.success(`Pack ${registered.pack.id}@${registered.pack.version} registered`);
    } else if (packs.mutationError) {
      const copy = capabilityErrorToast(packs.mutationError, "Failed to register pack");
      toast.error(copy.title, { description: copy.description });
    }
  }

  async function enablePack(pack: CapabilityPack, environmentId: string | undefined) {
    setBusyPackId(pack.id);
    try {
      const installation = await packs.enable(pack.id, environmentId ? { environmentId } : {});
      if (installation) {
        toast.success(`Pack ${pack.name} enabled`);
        void context.refreshWorkspaceMcpServers(workspaceId);
      } else if (packs.mutationError) {
        const copy = capabilityErrorToast(packs.mutationError, "Failed to enable pack");
        toast.error(copy.title, { description: copy.description });
        packs.clearMutationError();
      }
    } finally {
      setBusyPackId(null);
    }
  }

  async function disablePack(pack: CapabilityPack) {
    setBusyPackId(pack.id);
    try {
      // Pack enable/disable rides the capability installation (pack:{id}).
      await context.client.disableCapability(workspaceId, `pack:${pack.id}`);
      await packs.refresh();
      void context.refreshWorkspaceMcpServers(workspaceId);
      toast.success(`Pack ${pack.name} disabled`);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to disable pack");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyPackId(null);
    }
  }

  async function unregisterPack(pack: CapabilityPack) {
    setBusyPackId(pack.id);
    try {
      const removed = await packs.remove(pack.id);
      if (removed) {
        toast.success(`Pack ${pack.id} unregistered`);
      } else if (packs.mutationError) {
        const copy = capabilityErrorToast(packs.mutationError, "Failed to unregister pack");
        toast.error(copy.title, { description: copy.description });
        packs.clearMutationError();
      }
    } finally {
      setBusyPackId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={<PackageIcon className="size-4" />}
        title="Packs"
        description="Complete agent capabilities: a sandbox image, skills, tools, connectors, knowledge, and schedule templates that enable as one unit."
        actions={(
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => void packs.refresh()} disabled={packs.loading} className="h-9">
              <RefreshCwIcon className={cn("size-3.5", packs.loading && "animate-spin")} />
              Refresh
            </Button>
            <Button type="button" size="sm" onClick={() => setRegisterOpen((open) => !open)} className="h-9">
              <PlusIcon className="size-3.5" />
              Register manifest
            </Button>
          </>
        )}
      />

      {registerOpen ? (
        <div className="mt-4 grid gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
          <textarea
            value={manifestDraft}
            onChange={(event) => setManifestDraft(event.target.value)}
            placeholder='{"id": "my-pack", "name": "My pack", "description": "...", "role": "...", "category": "...", "version": "1.0.0", ...}'
            className="min-h-40 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 font-mono text-xs leading-5"
            aria-label="Pack manifest JSON"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setRegisterOpen(false)}>Cancel</Button>
            <Button type="button" size="sm" disabled={packs.mutating || !manifestDraft.trim()} onClick={() => void registerManifest()}>
              {packs.mutating ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
              Register
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        {packs.loading && packs.packs.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-4 text-sm text-[color:var(--color-fg-muted)]">
            <Loader2Icon className="size-4 animate-spin" />
            Loading packs
          </div>
        ) : packs.packs.length === 0 ? (
          <EmptyState>No packs are available to this workspace.</EmptyState>
        ) : (
          packs.packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              installation={packs.installationFor(pack.id)}
              environments={environments.environments.map((environment) => ({ id: environment.id, name: environment.name }))}
              busy={busyPackId === pack.id}
              onEnable={(environmentId) => void enablePack(pack, environmentId)}
              onDisable={() => void disablePack(pack)}
              onUnregister={() => void unregisterPack(pack)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PackCard(props: {
  pack: CapabilityPack;
  installation: PackInstallation | null;
  environments: Array<{ id: string; name: string }>;
  busy: boolean;
  onEnable: (environmentId: string | undefined) => void;
  onDisable: () => void;
  onUnregister: () => void;
}) {
  const { pack, installation } = props;
  const enabled = installation?.status === "active";
  const [expanded, setExpanded] = useState(false);
  const [environmentId, setEnvironmentId] = useState("");
  const needsEnvironment = pack.environment?.required === true;

  return (
    <article className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium">{pack.name}</h3>
            <span className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">v{pack.version}</span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                enabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-fg-subtle)]",
              )}
            >
              {enabled ? "enabled" : installation ? "disabled" : "available"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-[color:var(--color-fg-muted)]">{pack.description}</p>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--color-fg-subtle)]">
            <span>{pack.role}</span>
            <span>{pack.category}</span>
            {pack.sandboxImage ? (
              <span className="flex min-w-0 items-center gap-1" title={pack.sandboxImage}>
                <ContainerIcon className="size-3 shrink-0" />
                <span className="max-w-72 truncate font-mono text-[10px]">{pack.sandboxImage}</span>
              </span>
            ) : null}
          </div>
          {pack.skills.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pack.skills.map((skill) => (
                <span key={skill.name} title={skill.description} className="inline-flex items-center gap-1 rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">
                  <SparkleIcon className="size-3" />
                  {skill.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              Contents
            </Button>
            {enabled ? (
              <Button type="button" variant="secondary" size="sm" className="h-8 min-w-24 text-xs" disabled={props.busy} onClick={props.onDisable}>
                {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                Disable
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="h-8 min-w-24 text-xs"
                disabled={props.busy || (needsEnvironment && !environmentId)}
                title={needsEnvironment && !environmentId ? "This pack requires an environment attachment" : undefined}
                onClick={() => props.onEnable(environmentId || undefined)}
              >
                {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                Enable
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Unregister pack ${pack.id}`}
              className="hover:text-red-300"
              disabled={props.busy}
              title="Unregister this workspace pack (built-ins cannot be removed)"
              onClick={props.onUnregister}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
          {pack.environment ? (
            <div className="flex items-center gap-1.5">
              <select
                value={environmentId}
                onChange={(event) => setEnvironmentId(event.target.value)}
                aria-label={`Environment for ${pack.name}`}
                className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs"
              >
                <option value="">{needsEnvironment ? "Choose environment (required)" : "No environment"}</option>
                {props.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>{environment.name}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 grid gap-3 border-t border-[color:var(--color-border)] pt-3 md:grid-cols-2">
          <PackSection title="Tools" icon={<PlugIcon className="size-3" />}>
            {pack.tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {pack.tools.map((tool) => (
                  <span key={`${tool.kind}:${tool.id}`} className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{tool.id}</span>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Skills" icon={<FileCode2Icon className="size-3" />}>
            {pack.skills.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.skills.map((skill) => (
                  <div key={skill.name} className="min-w-0">
                    <div className="truncate text-xs font-medium">{skill.name}</div>
                    <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
                      {skill.description ?? "No description"} · {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
                    </div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Connectors" icon={<PlugIcon className="size-3" />}>
            {pack.connectors.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.connectors.map((connector) => (
                  <div key={connector.id} className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{connector.name}</span>
                      {connector.required ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-300">required</span> : null}
                    </div>
                    <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
                      {[connector.authModel, connector.providers.join(", "), connector.scopes.length ? `${connector.scopes.length} scopes` : null].filter(Boolean).join(" / ")}
                    </div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Knowledge" icon={<FileCode2Icon className="size-3" />}>
            {pack.knowledge.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.knowledge.map((knowledge) => (
                  <div key={knowledge.id} className="min-w-0">
                    <div className="truncate text-xs font-medium">{knowledge.name}</div>
                    {knowledge.description ? <div className="line-clamp-2 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{knowledge.description}</div> : null}
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Schedule templates" icon={<CalendarClockIcon className="size-3" />}>
            {pack.scheduledTaskTemplates.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.scheduledTaskTemplates.map((template) => (
                  <div key={template.id} className="min-w-0">
                    <div className="truncate text-xs font-medium">{template.name}</div>
                    <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{scheduleLabel(template.defaultSchedule)}</div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          {pack.environment ? (
            <PackSection title="Environment" icon={<ContainerIcon className="size-3" />}>
              <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{pack.environment.description}</div>
              {pack.environment.requiredVariables.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {pack.environment.requiredVariables.map((name) => (
                    <span key={name} className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{name}</span>
                  ))}
                </div>
              ) : null}
            </PackSection>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function PackSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[color:var(--color-fg-subtle)]">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function PackNone() {
  return <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">None declared.</div>;
}
