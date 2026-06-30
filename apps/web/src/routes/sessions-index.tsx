// The sessions index: the centered "Start a session" composer. The form is
// organised top-down — (A) message → (B) WHERE SHOULD THIS RUN? (the promoted
// top-level compute target) → (C) the compute-dependent band it gates → (D) the
// compute-independent optional band (goal, OpenGeni tool permissions).
//
// "Where should this run?" is a first-class segmented control with two kinds:
// Managed Sandbox (ephemeral, platform-owned — clones repos, injects env) vs
// Connected Machine (a user-owned enrolled machine — its own checkout & git
// auth, a working folder, no clone, no env injection). The kind gates the band
// below it; invalid states ("clone my repo onto a machine") are unreachable by
// construction.
//
// The Connected Machine path is OPT-IN: with an empty self-hosted fleet and no
// explicit opt-in, the segmented control is not rendered at all and the composer
// collapses to the clean sandbox-only flow (just the managed sandbox fields). The
// control appears once machines exist, or once the user reveals it via a
// lightweight local opt-in.
import { useEnvironments, useMachines, type ComposerState, type MachineView } from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, BoxIcon, CheckIcon, ChevronDownIcon, FlagIcon, FolderIcon, GitBranchIcon, MonitorOffIcon, ServerIcon, ShieldIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConsoleComposer, useDraftAttachments } from "@/components/Composer";
import { PermissionGroupPicker } from "@/components/permission-picker";
import {
  EnabledMcpToolPicker,
  ModelPicker,
} from "@/components/pickers";
import { RepositoryContextPicker } from "@/components/repository-picker";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppContext } from "@/context";
import { useCodexModels } from "@/lib/use-codex-models";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import { sessionMcpPermissionGroups } from "@/lib/permissions";
import {
  emptySessionDraft,
  isSessionDraftComputeReady,
  managedBackendOptions,
  selfhostedCapabilityChips,
  submissionFromSessionDraft,
  type ConnectedMachineTarget,
  type ManagedSandboxTarget,
  type SessionDraft,
} from "@/lib/session-create";
import { cn } from "@/lib/utils";
import type { SandboxBackend } from "@/types";

const examples = [
  "Inspect the repository and summarize the infrastructure layout.",
  "Run Terraform and Checkov checks, then propose the smallest safe fix.",
  "Create a focused GitHub PR for the failing policy check.",
] as const;

const BACKEND_OPTIONS = managedBackendOptions();

export function SessionsIndexRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const attachments = useDraftAttachments(workspaceId);
  const [message, setMessage] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draft, setDraft] = useState<SessionDraft>(() => emptySessionDraft());

  useEffect(() => {
    context.resetSessionView();
  }, [workspaceId]);

  const computeReady = isSessionDraftComputeReady(draft);

  // The session does not exist yet, so this surface cannot use `useComposer`
  // (that hook sends to a session). It still renders the package ChatComposer
  // by implementing the same `ComposerState` contract over session creation.
  const createComposer: ComposerState = {
    value: message,
    setValue: setMessage,
    sending: context.busy,
    canSend: message.trim().length > 0 && !context.busy && !attachments.uploading && computeReady,
    // Queue-vs-steer is meaningless before the session exists.
    mode: "queue",
    setMode: () => {},
    interrupt: async () => {},
    interrupting: false,
    error: null,
    clearError: () => {},
    send: async () => {
      const text = message.trim();
      if (!text || context.busy || attachments.uploading || !computeReady) {
        return false;
      }
      const submission = submissionFromSessionDraft(draft);
      const created = await context.startSession(
        workspaceId,
        {
          text,
          resources: attachments.readyResources,
          ...submission.extras,
        },
        {
          targetSandboxId: submission.options.targetSandboxId,
          workingDir: submission.options.workingDir,
          omitWorkspaceResources: submission.omitWorkspaceResources,
        },
      );
      if (!created) {
        return false;
      }
      setMessage("");
      attachments.clear();
      await navigate({ to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId: created.id } });
      return true;
    },
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
      <section className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          What should the agent do?
        </h1>
        <p className="max-w-md text-sm text-[color:var(--color-fg-muted)]">
          It runs in a live sandbox you can watch and steer.
        </p>
      </section>

      <div className="mt-8">
        <ConsoleComposer
          composer={createComposer}
          attachments={attachments}
          autoFocus
          fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
          placeholder="Describe a task for the agent..."
          controls={<SessionControlStrip workspaceId={workspaceId} />}
        />

        {message.trim().length === 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setMessage(example)}
                disabled={context.busy}
                className={cn(
                  "max-w-full truncate rounded-full border px-3 py-1 text-left text-xs",
                  "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/50",
                  "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
                  "hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)]",
                  "transition-colors active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {example}
              </button>
            ))}
          </div>
        ) : null}

        <ComputeTargetControl
          workspaceId={workspaceId}
          draft={draft}
          onChange={setDraft}
          disabled={context.busy}
        />

        <OptionalSessionOptions
          open={optionsOpen}
          onOpenChange={setOptionsOpen}
          draft={draft}
          onChange={setDraft}
          disabled={context.busy}
        />
      </div>
    </div>
  );
}

// The composer's inline strip: compute-INDEPENDENT controls only (model + tools).
// Repository context now lives in the compute-dependent band below (it only makes
// sense once a managed sandbox is the target), not as an always-visible pill.
function SessionControlStrip({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const codexModels = useCodexModels(workspaceId);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ModelPicker
        config={context.clientConfig}
        model={context.model}
        effort={context.reasoningEffort}
        disabled={context.busy}
        extraModels={codexModels}
        onModelChange={context.setModel}
        onEffortChange={context.setReasoningEffort}
      />
      <EnabledMcpToolPicker
        servers={context.toolMcpServers}
        selectedIds={context.selectedCapabilityToolIds}
        disabled={context.busy}
        onChange={context.setSelectedCapabilityToolIds}
      />
    </div>
  );
}

// The workspace repository picker, wired to the cross-route selection in context.
// Reused in both compute kinds: the primary clone source on a managed sandbox,
// and grayed/disabled on a connected machine (which uses its own checkout).
function WorkspaceRepositoryPicker({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const context = useAppContext();
  return (
    <RepositoryContextPicker
      configured={context.githubStatus?.configured === true}
      installUrl={context.githubStatus?.installUrl ?? null}
      repositories={context.githubRepos}
      groups={context.repositoryGroups}
      selectedRepoIds={context.selectedRepoIds}
      selectedRepoRefs={context.selectedRepoRefs}
      selectedInstallationId={context.selectedInstallationId}
      manualRepos={context.manualRepos}
      manualOpen={context.manualReposOpen}
      githubAppOpen={context.githubAppOpen}
      org={context.githubOrg}
      pending={context.busy || disabled}
      repoBusy={context.repoBusy}
      githubAppBusy={context.githubAppBusy}
      onRefresh={() => context.refreshGitHub(workspaceId, undefined, { sync: true })}
      onToggleRepo={context.toggleGitHubRepository}
      onRefChange={(repoId, ref) => context.setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref }))}
      onManualOpenChange={context.setManualReposOpen}
      onManualAdd={context.addManualRepository}
      onManualUpdate={(id, patch) => context.setManualRepos((current) => current.map((repo) => repo.id === id ? { ...repo, ...patch } : repo))}
      onManualRemove={(id) => context.setManualRepos((current) => current.filter((repo) => repo.id !== id))}
      onGitHubAppOpenChange={context.setGithubAppOpen}
      onOrgChange={context.setGithubOrg}
      onStartGitHubApp={() => void context.startGitHubAppManifestFlow(workspaceId)}
    />
  );
}

// Local opt-in flag for the Connected Machine path. The DEFAULT (no machines, no
// opt-in) is the clean sandbox-only composer; this lets a user reveal the machine
// option before/while enrolling their first machine. Mirrors the rail's
// localStorage pattern (safe under SSR / private mode).
// TODO(settings): promote this localStorage flag into a real persisted setting on
// the Settings surface (workspace- or account-scoped) and surface the toggle there.
const CONNECTED_MACHINES_OPTIN_KEY = "opengeni.composer.connectedMachines";

function readConnectedMachinesOptIn(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(CONNECTED_MACHINES_OPTIN_KEY) === "true";
  } catch {
    return false;
  }
}

function persistConnectedMachinesOptIn(value: boolean): void {
  try {
    window.localStorage.setItem(CONNECTED_MACHINES_OPTIN_KEY, String(value));
  } catch {
    // localStorage may be unavailable (private mode); keep the in-memory value.
  }
}

// ── The promoted top-level compute target (the parent that gates the band) ────

function ComputeTargetControl(props: {
  workspaceId: string;
  draft: SessionDraft;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft, onChange } = props;
  // The workspace fleet (no sessionId → no swap; just the picker source). Degrades
  // gracefully: when selfhosted is disabled the API 404s → `machines` is empty and
  // the Connected Machine kind is offered only as a disabled "enroll a machine"
  // affordance, never blocking session creation.
  const fleet = useMachines({ pollIntervalMs: 10000 });
  const machines = fleet.machines.filter((machine) => machine.kind === "selfhosted");
  const fleetEmpty = machines.length === 0;
  // Preserve the last managed backend override across kind toggles (lossless) so
  // toggling machine→sandbox returns to the prior choice, not a forced reset.
  const lastBackend = useRef<SandboxBackend | "">(draft.compute.kind === "sandbox" ? draft.compute.backend : "");
  if (draft.compute.kind === "sandbox") {
    lastBackend.current = draft.compute.backend;
  }

  // The Connected Machine path is OPT-IN. With an EMPTY self-hosted fleet and no
  // explicit opt-in, the segmented control is not rendered at all — the composer
  // shows the clean sandbox-only flow (byte-identical submission to before this
  // redesign). Once machines exist, the control is always shown. A lightweight
  // local opt-in lets a user reveal the option before/while enrolling.
  const [optedIn, setOptedIn] = useState<boolean>(() => readConnectedMachinesOptIn());
  const revealConnectedMachines = () => {
    setOptedIn(true);
    persistConnectedMachinesOptIn(true);
  };
  const showComputeTarget = !fleetEmpty || optedIn;

  // Defensive: if the segmented control is hidden (clean flow) while a stale draft
  // still points at a machine (e.g. the last machine just left the fleet), fall
  // back to the managed sandbox so a hidden machine target can never be submitted.
  useEffect(() => {
    if (!showComputeTarget && draft.compute.kind === "machine") {
      onChange({ ...draft, compute: { kind: "sandbox", backend: lastBackend.current } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showComputeTarget, draft.compute.kind]);

  const selectKind = (kind: ComputeKind) => {
    if (kind === draft.compute.kind) {
      return;
    }
    if (kind === "sandbox") {
      onChange({ ...draft, compute: { kind: "sandbox", backend: lastBackend.current } });
      return;
    }
    // Auto-pick the first selectable machine so the common single-machine case is
    // submit-ready immediately; otherwise leave it unpicked (submit stays blocked).
    const firstSelectable = machines.find((machine) => isMachineComputeSelectable(machine.state)) ?? null;
    onChange({ ...draft, compute: { kind: "machine", sandboxId: firstSelectable?.sandboxId ?? null, folder: { kind: "root" } } });
  };

  // Clean sandbox-only default: no "Where should this run?" header, no segmented
  // control, no machine clutter — just the managed sandbox fields, plus a subtle
  // opt-in link to reveal the Connected Machine path. The sandbox compute is
  // narrowed defensively (the normalization effect keeps the draft in sync).
  if (!showComputeTarget) {
    const sandboxCompute: ManagedSandboxTarget =
      draft.compute.kind === "sandbox" ? draft.compute : { kind: "sandbox", backend: lastBackend.current };
    return (
      <section className="mt-5 grid gap-2">
        <ManagedSandboxFields
          workspaceId={props.workspaceId}
          draft={draft}
          compute={sandboxCompute}
          onChange={onChange}
          disabled={props.disabled}
        />
        <RevealConnectedMachinesButton onClick={revealConnectedMachines} disabled={props.disabled} />
      </section>
    );
  }

  return (
    <section className="mt-5 grid gap-3">
      <p className="px-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--color-fg-subtle)]">
        Where should this run?
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <ComputeKindButton
          selected={draft.compute.kind === "sandbox"}
          disabled={props.disabled}
          icon={<BoxIcon className="size-4 shrink-0" />}
          title="Managed Sandbox"
          subtitle="A fresh box, set up for you"
          onClick={() => selectKind("sandbox")}
        />
        <ComputeKindButton
          selected={draft.compute.kind === "machine"}
          disabled={props.disabled || fleetEmpty}
          icon={<ServerIcon className="size-4 shrink-0" />}
          title="Connected Machine"
          subtitle={fleetEmpty ? "Connect one to use it" : "Run on your own machine"}
          onClick={() => selectKind("machine")}
        />
      </div>

      {draft.compute.kind === "sandbox" ? (
        <ManagedSandboxFields
          workspaceId={props.workspaceId}
          draft={draft}
          compute={draft.compute}
          onChange={onChange}
          disabled={props.disabled}
        />
      ) : (
        <ConnectedMachineFields
          workspaceId={props.workspaceId}
          draft={draft}
          compute={draft.compute}
          machines={machines}
          onChange={onChange}
          disabled={props.disabled}
        />
      )}
    </section>
  );
}

type ComputeKind = SessionDraft["compute"]["kind"];

function ComputeKindButton(props: {
  selected: boolean;
  disabled: boolean;
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "group flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-[color,background-color,border-color,box-shadow]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        props.selected
          ? "border-[color:var(--color-brand)]/60 bg-[color:var(--color-brand)]/[0.08] ring-1 ring-inset ring-[color:var(--color-brand)]/20"
          : "border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)]/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 transition-colors",
          props.selected ? "text-[color:var(--color-brand)]" : "text-[color:var(--color-fg-subtle)] group-hover:text-[color:var(--color-fg-muted)]",
        )}
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[color:var(--color-fg)]">{props.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[color:var(--color-fg-subtle)]">{props.subtitle}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full transition-all",
          props.selected
            ? "scale-100 bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]"
            : "scale-90 border border-[color:var(--color-border-strong)] opacity-0 group-hover:opacity-60",
        )}
      >
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    </button>
  );
}

// ── Managed Sandbox kind: repo+branch (clone source), env, Advanced backend ───

function ManagedSandboxFields(props: {
  workspaceId: string;
  draft: SessionDraft;
  compute: ManagedSandboxTarget;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft, compute, onChange } = props;
  const environments = useEnvironments();
  const selectedBackend = BACKEND_OPTIONS.find((option) => option.value === compute.backend) ?? BACKEND_OPTIONS[0];
  const backendSummary = [selectedBackend?.label, ...(selectedBackend?.chips ?? [])].filter(Boolean).join(" · ");

  return (
    <div className="grid gap-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 p-3.5">
      <div className="grid gap-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <GitBranchIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
          Repository + branch
        </Label>
        <div>
          <WorkspaceRepositoryPicker workspaceId={props.workspaceId} disabled={props.disabled} />
        </div>
        <p className="flex items-center gap-1.5 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
          <FolderIcon className="size-3 shrink-0" />
          Cloned into <span className="font-mono text-[color:var(--color-fg-muted)]">/workspace</span>, the fixed sandbox root.
        </p>
      </div>

      <div className="grid gap-2 border-t border-[color:var(--color-border)] pt-4">
        <Label className="flex items-center gap-1.5 text-xs">
          <BoxIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
          Environment
        </Label>
        <select
          className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 text-sm transition-colors hover:border-[color:var(--color-border-strong)] focus-visible:border-[color:var(--color-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          value={draft.environmentId}
          disabled={props.disabled}
          onChange={(event) => onChange({ ...draft, environmentId: event.target.value })}
        >
          <option value="">No environment</option>
          {environments.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name} ({environment.variables.length} vars)
            </option>
          ))}
        </select>
        <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
          Variables are set in the sandbox at start. Their values stay write-only.
        </p>
      </div>

      {/* Low-level sandbox backend override — demoted into this kind's Advanced
          detail, descriptor-driven from CAPABILITY_DESCRIPTORS. */}
      <details className="group rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/30 transition-colors open:bg-[color:var(--color-surface)]/50">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[11px] text-[color:var(--color-fg-subtle)] transition-colors hover:text-[color:var(--color-fg-muted)]">
          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
          <span>Advanced</span>
          <span className="text-[color:var(--color-fg-subtle)]/70">·</span>
          <span className="truncate">backend {backendSummary}</span>
        </summary>
        <div className="grid gap-2 px-3 pb-3">
          <select
            className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 text-sm transition-colors hover:border-[color:var(--color-border-strong)] focus-visible:border-[color:var(--color-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            value={compute.backend}
            disabled={props.disabled}
            onChange={(event) => onChange({ ...draft, compute: { kind: "sandbox", backend: event.target.value as SandboxBackend | "" } })}
          >
            {BACKEND_OPTIONS.map((option) => (
              <option key={option.value || "default"} value={option.value}>
                {option.label}
                {option.chips.length > 0 ? ` · ${option.chips.join(" · ")}` : ""}
              </option>
            ))}
          </select>
          <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
            Forces the underlying sandbox type. Leave on the deployment default unless you need a specific backend.
          </p>
        </div>
      </details>
    </div>
  );
}

// ── Connected Machine kind: machine picker, folder, grayed repos, env note ────

function ConnectedMachineFields(props: {
  workspaceId: string;
  draft: SessionDraft;
  compute: ConnectedMachineTarget;
  machines: MachineView[];
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft, compute, onChange, machines } = props;
  const setCompute = (next: ConnectedMachineTarget) => onChange({ ...draft, compute: next });
  const pickedMachine = compute.sandboxId
    ? machines.find((machine) => machine.sandboxId === compute.sandboxId) ?? null
    : null;
  const customPath = compute.folder.kind === "path" ? compute.folder.path : "";
  const capabilityChips = selfhostedCapabilityChips(pickedMachine);

  return (
    <div className="grid gap-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 p-3.5">
      <div className="grid gap-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <ServerIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
          Machine
        </Label>
        <select
          className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 text-sm transition-colors hover:border-[color:var(--color-border-strong)] focus-visible:border-[color:var(--color-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          value={compute.sandboxId ?? ""}
          disabled={props.disabled}
          onChange={(event) => setCompute({ ...compute, sandboxId: event.target.value || null })}
        >
          <option value="" disabled>
            Choose a machine…
          </option>
          {machines.map((machine) => (
            <option key={machine.sandboxId} value={machine.sandboxId} disabled={!isMachineComputeSelectable(machine.state)}>
              {machine.name}
              {machine.os ? ` · ${machine.os}/${machine.arch}` : ""}
              {machine.state !== "online" ? ` (${machine.state})` : ""}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap items-center gap-1.5">
          {capabilityChips.map((chip) => (
            <CapabilityChip key={chip}>{chip}</CapabilityChip>
          ))}
          {pickedMachine && !pickedMachine.hasDisplay ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-[color:var(--color-border-strong)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-fg-subtle)]">
              <MonitorOffIcon className="size-3 shrink-0" />
              No display
            </span>
          ) : null}
        </div>
        {compute.sandboxId === null ? (
          <p className="text-[11px] leading-4 text-[color:var(--color-fg-muted)]">
            Pick a machine to run on.
          </p>
        ) : null}
      </div>

      {/* Project / folder — the agent's working directory on the machine (D4/D5,
          functional via Stage A's workingDir for root + custom path). */}
      <div className="grid gap-2.5 border-t border-[color:var(--color-border)] pt-4">
        <Label className="flex items-center gap-1.5 text-xs">
          <FolderIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
          Project / folder
        </Label>
        <div className="grid gap-2">
          <FolderRadio
            checked={compute.folder.kind === "root"}
            disabled={props.disabled}
            onSelect={() => setCompute({ ...compute, folder: { kind: "root" } })}
            label="Machine root"
            hint="the agent's launch directory"
          />
          <FolderRadio
            checked={false}
            disabled
            onSelect={() => {}}
            label="Project"
            hint="a named path"
            badge="Soon"
          />
          <FolderRadio
            checked={compute.folder.kind === "path"}
            disabled={props.disabled}
            onSelect={() => setCompute({ ...compute, folder: { kind: "path", path: customPath } })}
            label="Custom path"
            hint="absolute, or relative to the launch root"
          />
          {compute.folder.kind === "path" ? (
            <Input
              value={customPath}
              disabled={props.disabled}
              onChange={(event) => setCompute({ ...compute, folder: { kind: "path", path: event.target.value } })}
              placeholder="e.g. ~/repos/myproject or packages/runtime"
              aria-label="Custom working directory"
              className="ml-[1.375rem] h-9 w-[calc(100%_-_1.375rem)] text-sm"
            />
          ) : null}
        </div>
        <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
          Where the agent, terminal, and file dock open. Defaults to the machine&apos;s workspace root.
        </p>
      </div>

      {/* Repositories — grayed: a connected machine uses its own checkout & git
          auth (D3), so the workspace repo selection is never cloned onto it. */}
      <div className="grid gap-2 border-t border-[color:var(--color-border)] pt-4">
        <Label className="flex items-center justify-between gap-1.5 text-xs text-[color:var(--color-fg-subtle)]">
          <span className="flex items-center gap-1.5">
            <GitBranchIcon className="size-3 shrink-0" />
            Repositories
          </span>
          <span className="rounded border border-[color:var(--color-border)] px-1.5 py-px text-[10px] font-normal text-[color:var(--color-fg-subtle)]">
            Not cloned here
          </span>
        </Label>
        <div className="pointer-events-none select-none opacity-45">
          <WorkspaceRepositoryPicker workspaceId={props.workspaceId} disabled />
        </div>
        <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
          This machine uses its own checkout &amp; git auth, so your selected repositories aren&apos;t cloned onto it.
        </p>
      </div>

      {/* Environment injection — hidden on a connected machine (D2). */}
      <div className="grid gap-1 border-t border-[color:var(--color-border)] pt-4">
        <p className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg-subtle)]">
          <BoxIcon className="size-3 shrink-0" />
          No environment is injected here.
        </p>
        <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
          The machine&apos;s own environment &amp; git credentials apply.
        </p>
      </div>
    </div>
  );
}

function CapabilityChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-fg-muted)]">
      {children}
    </span>
  );
}

// The opt-in affordance that reveals the Connected Machine path from the clean
// sandbox-only flow. A quiet secondary action, tied to the compute area, with a
// reveal-arrow on hover.
function RevealConnectedMachinesButton(props: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "group inline-flex items-center gap-2 justify-self-start rounded-md px-1.5 py-1 text-[11px] transition-colors",
        "text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/50 text-[color:var(--color-fg-subtle)] transition-colors group-hover:border-[color:var(--color-border-strong)] group-hover:text-[color:var(--color-fg-muted)]">
        <ServerIcon className="size-3" />
      </span>
      <span>Run on your own connected machine</span>
      <ArrowRightIcon className="size-3 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
    </button>
  );
}

function FolderRadio(props: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onSelect}
      className="group flex items-center gap-2 rounded-md text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
          props.checked
            ? "border-[color:var(--color-brand)]"
            : "border-[color:var(--color-border-strong)] group-hover:border-[color:var(--color-fg-subtle)]",
        )}
      >
        {props.checked ? <span className="size-1.5 rounded-full bg-[color:var(--color-brand-strong)]" /> : null}
      </span>
      <span className="font-medium text-[color:var(--color-fg)]">{props.label}</span>
      {props.badge ? (
        <span className="rounded border border-[color:var(--color-border)] px-1 py-px text-[9px] font-medium uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
          {props.badge}
        </span>
      ) : null}
      <span className="text-[11px] text-[color:var(--color-fg-subtle)]">— {props.hint}</span>
    </button>
  );
}

// ── Compute-independent optional band: goal + OpenGeni tool permissions ───────

function OptionalSessionOptions(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: SessionDraft;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft } = props;
  const update = (patch: Partial<SessionDraft>) => props.onChange({ ...draft, ...patch });
  const summary = [
    draft.goalText.trim() ? "goal set" : null,
    draft.customMcpPermissions ? `${draft.mcpPermissions.size} MCP scopes` : null,
  ].filter(Boolean);

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange} className="mt-3">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 px-3 py-2.5 text-left text-xs text-[color:var(--color-fg-muted)] transition-colors hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)]/60 hover:text-[color:var(--color-fg)]"
        >
          <SlidersHorizontalIcon className="size-3.5 shrink-0 text-[color:var(--color-fg-subtle)]" />
          <span className="font-medium">Goal &amp; tool permissions</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--color-fg-subtle)]">
            {summary.length > 0 ? summary.join(" · ") : "Optional — run toward a goal, limit tool access"}
          </span>
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", props.open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 grid gap-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 p-3.5">
          <div className="grid gap-2">
            <Label className="flex items-center gap-1.5 text-xs">
              <FlagIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
              Goal (optional)
            </Label>
            <textarea
              value={draft.goalText}
              disabled={props.disabled}
              onChange={(event) => update({ goalText: event.target.value })}
              placeholder="Keep the session working on its own between your messages…"
              className="min-h-14 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm transition-colors placeholder:text-[color:var(--color-fg-subtle)] hover:border-[color:var(--color-border-strong)] focus-visible:border-[color:var(--color-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Input
                value={draft.goalSuccessCriteria}
                disabled={props.disabled || !draft.goalText.trim()}
                onChange={(event) => update({ goalSuccessCriteria: event.target.value })}
                placeholder="Success criteria (optional)"
                className="h-9 text-sm"
              />
              <Input
                value={draft.goalMaxAutoContinuations}
                disabled={props.disabled || !draft.goalText.trim()}
                onChange={(event) => update({ goalMaxAutoContinuations: event.target.value })}
                placeholder="Max continuations"
                inputMode="numeric"
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={draft.customMcpPermissions}
                disabled={props.disabled}
                onChange={(event) => update({ customMcpPermissions: event.target.checked })}
                className="size-3.5 accent-[color:var(--color-brand-strong)]"
              />
              <ShieldIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
              Restrict this session&apos;s OpenGeni tool permissions
            </label>
            {draft.customMcpPermissions ? (
              <PermissionGroupPicker
                groups={sessionMcpPermissionGroups}
                selected={draft.mcpPermissions}
                disabled={props.disabled}
                onToggle={(permission) => {
                  const next = new Set(draft.mcpPermissions);
                  if (next.has(permission)) {
                    next.delete(permission);
                  } else {
                    next.add(permission);
                  }
                  update({ mcpPermissions: next });
                }}
              />
            ) : (
              <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
                By default the session&apos;s OpenGeni MCP tool can use the platform on your behalf inside this workspace.
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
