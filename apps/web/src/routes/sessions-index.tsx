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
import { FILE_ONLY_MESSAGE_TEXT, useEnvironments, useWorkspaceSessions, type ComposerState } from "@opengeni/react";
import { useMachines, type MachineView } from "@opengeni/react/machines";
import { OpenGeniApiError } from "@opengeni/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import { BoxIcon, CheckIcon, ChevronDownIcon, FlagIcon, FolderIcon, GitBranchIcon, MonitorOffIcon, ServerIcon, ShieldIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useAppContext } from "@/context";
import { groupSessionsForRail, relativeTimeLabel } from "@/lib/sessions-group";
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
import type { SandboxBackend, Session } from "@/types";

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
    // Mirrors useComposer's gate: a ready attachment with no typed draft is a
    // sendable file-only message (the API requires non-empty text, so send()
    // substitutes FILE_ONLY_MESSAGE_TEXT).
    canSend:
      (message.trim().length > 0 || attachments.readyResources.length > 0) &&
      !context.busy && !attachments.uploading && computeReady,
    // Queue-vs-steer is meaningless before the session exists.
    mode: "queue",
    setMode: () => {},
    interrupt: async () => {},
    interrupting: false,
    error: null,
    clearError: () => {},
    send: async () => {
      const text = message.trim() || (attachments.readyResources.length > 0 ? FILE_ONLY_MESSAGE_TEXT : "");
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
    // The canvas parent is overflow-hidden, so this route owns its scrolling —
    // without it the page clips (recent sessions were unreachable below the fold).
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
      <section className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          What should the agent do?
        </h1>
      </section>

      <div className="mt-8">
        <ConsoleComposer
          composer={createComposer}
          attachments={attachments}
          autoFocus
          fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
          placeholder="Describe a task for the agent…"
          controls={<SessionControlStrip workspaceId={workspaceId} />}
        />


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

      <RecentSessions workspaceId={workspaceId} />
      </div>
    </div>
  );
}

// ── Recent sessions — the quiet main-canvas browser the rail can't be (D4.2) ──
// A calm section below the composer: the most recent sessions as compact rows
// (status dot, title, repo/model meta, relative time), linking straight in. It
// reuses the same useWorkspaceSessions hook the rail runs on and renders only
// when sessions exist, so the hero stays the composer.
function RecentSessions({ workspaceId }: { workspaceId: string }) {
  const { sessions } = useWorkspaceSessions({ limit: 12, pollIntervalMs: 30_000 });
  const recent = useMemo(() => {
    const { running, grouped } = groupSessionsForRail(sessions);
    return [...running, ...grouped.flatMap((bucket) => bucket.sessions)].slice(0, 6);
  }, [sessions]);

  if (recent.length === 0) {
    return null;
  }

  return (
    <section className="mt-12">
      <h2 className="mb-2 px-0.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Recent sessions
      </h2>
      {/* flex-col, not grid: a grid auto track grows to a nowrap row's full
          min-content width, defeating truncate and overflowing the page. */}
      <ul className="flex min-w-0 flex-col gap-1">
        {recent.map((session) => (
          <RecentSessionRow key={session.id} workspaceId={workspaceId} session={session} />
        ))}
      </ul>
    </section>
  );
}

const SESSION_STATUS_TONE: Record<Session["status"], StatusTone> = {
  queued: "queued",
  running: "running",
  requires_action: "waiting",
  idle: "idle",
  failed: "failed",
  cancelled: "cancelled",
};

/** A short `owner/repo` label from the session's first repository resource. */
function sessionRepoLabel(session: Session): string | null {
  const repo = session.resources.find((resource) => resource.kind === "repository");
  if (!repo || repo.kind !== "repository") {
    return null;
  }
  const parts = repo.uri.replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : parts.at(-1) ?? null;
}

function RecentSessionRow({ workspaceId, session }: { workspaceId: string; session: Session }) {
  const title = session.title?.trim() || session.initialMessage?.trim() || "Untitled session";
  const meta = [session.model, sessionRepoLabel(session)].filter(Boolean).join(" · ");
  return (
    <li className="min-w-0">
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ workspaceId, sessionId: session.id }}
        className="group flex items-center gap-3 rounded-lg border border-border bg-surface/40 px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-surface-2/60"
      >
        <StatusDot tone={SESSION_STATUS_TONE[session.status]} pulse={session.status === "running"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{title}</span>
          {meta ? <span className="mt-0.5 block truncate text-2xs text-fg-subtle">{meta}</span> : null}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-fg-subtle">{relativeTimeLabel(session.updatedAt)}</span>
      </Link>
    </li>
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
  // A 404 is the expected "self-hosted machines are disabled here" signal, not a
  // failure — only a genuine load error (network/5xx) is surfaced, so the machine
  // option isn't silently swallowed by a transient outage (states #4).
  const fleetLoadFailed =
    fleet.error != null && !(fleet.error instanceof OpenGeniApiError && fleet.error.status === 404);
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
  // No teaser for absent hardware: the segmented control exists only when the
  // fleet has machines. Discovery lives on the Machines page, not the composer.
  const showComputeTarget = !fleetEmpty;

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
        {fleetLoadFailed ? <FleetErrorNotice onRetry={() => void fleet.refresh()} /> : null}
      </section>
    );
  }

  return (
    <section className="mt-5 grid gap-3">
      <p className="px-0.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-subtle">
        Where should this run?
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <ComputeKindButton
          selected={draft.compute.kind === "sandbox"}
          disabled={props.disabled}
          icon={<BoxIcon className="size-4 shrink-0" />}
          title="Managed sandbox"
          subtitle="A fresh sandbox, set up for you"
          onClick={() => selectKind("sandbox")}
        />
        <ComputeKindButton
          selected={draft.compute.kind === "machine"}
          disabled={props.disabled || fleetEmpty}
          icon={<ServerIcon className="size-4 shrink-0" />}
          title="Connected machine"
          subtitle={fleetLoadFailed ? "Couldn't load machines" : fleetEmpty ? "Connect one to use it" : "Run on your own machine"}
          onClick={() => selectKind("machine")}
        />
      </div>

      {fleetLoadFailed ? <FleetErrorNotice onRetry={() => void fleet.refresh()} /> : null}

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
          ? "border-brand/60 bg-brand/[0.08] ring-1 ring-inset ring-brand/20"
          : "border-border bg-surface/40 hover:border-border-strong hover:bg-surface-2/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 transition-colors",
          props.selected ? "text-brand" : "text-fg-subtle group-hover:text-fg-muted",
        )}
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{props.title}</span>
        <span className="mt-0.5 block truncate text-2xs text-fg-subtle">{props.subtitle}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full transition-all",
          props.selected
            ? "scale-100 bg-brand text-brand-fg"
            : "scale-90 border border-border-strong opacity-0 group-hover:opacity-60",
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
    // One flat card: hairline-separated rows, controls right-aligned, no
    // nested boxes and no restating helper text — the controls speak.
    <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <Label className="flex shrink-0 items-center gap-1.5 text-xs">
          <GitBranchIcon className="size-3 shrink-0 text-fg-subtle" />
          Repository
        </Label>
        <div className="flex min-w-0 justify-end">
          <WorkspaceRepositoryPicker workspaceId={props.workspaceId} disabled={props.disabled} />
        </div>
      </div>

      {/* Offer environments only when some exist — configuration UI for
          resources you don't have is clutter (same rule as machines). */}
      {environments.environments.length > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/70 px-3 py-2">
          <Label className="flex shrink-0 items-center gap-1.5 text-xs">
            <BoxIcon className="size-3 shrink-0 text-fg-subtle" />
            Environment
          </Label>
          <Select
            value={draft.environmentId}
            disabled={props.disabled}
            onChange={(event) => onChange({ ...draft, environmentId: event.target.value })}
            className="h-8 w-auto max-w-56 text-xs"
          >
            <option value="">No environment</option>
            {environments.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name} ({environment.variables.length} vars)
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {/* Low-level sandbox backend override — a quiet in-card disclosure row,
          descriptor-driven from CAPABILITY_DESCRIPTORS. */}
      <details className="group border-t border-border/70">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
          <span>Advanced</span>
          <span className="text-fg-subtle/70">·</span>
          <span className="truncate">backend: {backendSummary}</span>
        </summary>
        <div className="grid gap-1.5 px-3 pb-2.5">
          <Select
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
          </Select>
          <p className="text-2xs text-fg-subtle">
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
    <div className="grid gap-4 rounded-lg border border-border bg-surface/40 p-3.5">
      <div className="grid gap-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <ServerIcon className="size-3 shrink-0 text-fg-subtle" />
          Machine
        </Label>
        <Select
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
        </Select>
        <div className="flex flex-wrap items-center gap-1.5">
          {capabilityChips.map((chip) => (
            <CapabilityChip key={chip}>{chip}</CapabilityChip>
          ))}
          {pickedMachine && !pickedMachine.hasDisplay ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong px-1.5 py-0.5 text-2xs font-medium text-fg-subtle">
              <MonitorOffIcon className="size-3 shrink-0" />
              No display
            </span>
          ) : null}
        </div>
        {compute.sandboxId === null ? (
          <p className="text-2xs text-fg-muted">
            Pick a machine to run on.
          </p>
        ) : null}
      </div>

      {/* Project / folder — the agent's working directory on the machine (D4/D5,
          functional via Stage A's workingDir for root + custom path). */}
      <div className="grid gap-2.5 border-t border-border pt-4">
        <Label className="flex items-center gap-1.5 text-xs">
          <FolderIcon className="size-3 shrink-0 text-fg-subtle" />
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
        <p className="text-2xs text-fg-subtle">
          Where the agent, terminal, and file dock open. Defaults to the machine&apos;s workspace root.
        </p>
      </div>

      {/* Repositories — grayed: a connected machine uses its own checkout & git
          auth (D3), so the workspace repo selection is never cloned onto it. */}
      <div className="grid gap-2 border-t border-border pt-4">
        <Label className="flex items-center justify-between gap-1.5 text-xs text-fg-subtle">
          <span className="flex items-center gap-1.5">
            <GitBranchIcon className="size-3 shrink-0" />
            Repositories
          </span>
          <span className="rounded border border-border px-1.5 py-px text-2xs font-normal text-fg-subtle">
            Not cloned here
          </span>
        </Label>
        <div className="pointer-events-none select-none opacity-45">
          <WorkspaceRepositoryPicker workspaceId={props.workspaceId} disabled />
        </div>
        <p className="text-2xs text-fg-subtle">
          This machine uses its own checkout &amp; git auth, so your selected repositories aren&apos;t cloned onto it.
        </p>
      </div>

      {/* Environment injection — hidden on a connected machine (D2). */}
      <div className="grid gap-1 border-t border-border pt-4">
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <BoxIcon className="size-3 shrink-0" />
          No environment is injected here.
        </p>
        <p className="text-2xs text-fg-subtle">
          The machine&apos;s own environment &amp; git credentials apply.
        </p>
      </div>
    </div>
  );
}

function CapabilityChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-surface-2/60 px-1.5 py-0.5 text-2xs font-medium text-fg-muted">
      {children}
    </span>
  );
}

// A genuine fleet-load failure (not the expected selfhosted-disabled 404): a
// calm, retryable note so the machine option is never silently swallowed.
function FleetErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <Notice
      tone="muted"
      className="p-2.5 text-xs"
      action={
        <button type="button" onClick={onRetry} className="text-xs font-medium text-fg-muted underline underline-offset-2 hover:text-fg">
          Retry
        </button>
      }
    >
      Couldn&apos;t load your connected machines.
    </Notice>
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
            ? "border-brand"
            : "border-border-strong group-hover:border-fg-subtle",
        )}
      >
        {props.checked ? <span className="size-1.5 rounded-full bg-brand-strong" /> : null}
      </span>
      <span className="font-medium text-fg">{props.label}</span>
      {props.badge ? (
        <span className="rounded border border-border px-1 py-px text-2xs font-medium uppercase tracking-wide text-fg-subtle">
          {props.badge}
        </span>
      ) : null}
      <span className="text-2xs text-fg-subtle">— {props.hint}</span>
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
    <Collapsible open={props.open} onOpenChange={props.onOpenChange} className="mt-2">
      <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2/40 hover:text-fg"
        >
          <SlidersHorizontalIcon className="size-3.5 shrink-0 text-fg-subtle" />
          <span className="font-medium">Goal &amp; tool permissions</span>
          <span className="min-w-0 flex-1 truncate text-2xs text-fg-subtle">
            {summary.length > 0 ? summary.join(" · ") : "Optional"}
          </span>
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", props.open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-border/70 px-3 pb-3 pt-2.5">
          <div className="grid gap-2">
            <Label className="flex items-center gap-1.5 text-xs">
              <FlagIcon className="size-3 shrink-0 text-fg-subtle" />
              Goal (optional)
            </Label>
            <textarea
              value={draft.goalText}
              disabled={props.disabled}
              onChange={(event) => update({ goalText: event.target.value })}
              placeholder="Keep the session working on its own between your messages…"
              className="min-h-12 rounded-md border border-border bg-bg px-3 py-2 text-sm transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={draft.customMcpPermissions}
                disabled={props.disabled}
                onChange={(event) => update({ customMcpPermissions: event.target.checked })}
                className="size-3.5 accent-brand-strong"
              />
              <ShieldIcon className="size-3 shrink-0 text-fg-subtle" />
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
              <p className="text-2xs text-fg-subtle">
                By default this session can use OpenGeni tools on your behalf in this workspace.
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
