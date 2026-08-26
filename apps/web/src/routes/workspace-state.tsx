import {
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  OpenGeniApiError,
  type CompanyProfileContent,
  type CompanyProfileRevision,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  normalizeWorkspaceInstructionPolicyRoleKey,
  type WorkspaceInstructionPolicyKind,
  type WorkspaceInstructionPolicyOnboardingProposal,
  type WorkspaceInstructionPolicyScope,
  type WorkspaceStateGovernanceDriftStatus,
  type WorkspaceStateResponse,
} from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, BrainCircuitIcon, ChevronDownIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { activeGlobalWorkspaceInstructionHead } from "@/lib/workspace-instructions";

import { BrainOverview } from "./agent-brain-overview";
import { AgentKnowledgePrompt } from "./agent-brain-prompt";
import {
  useCompanyProfileInventory,
  useWorkspaceInstructionPolicyOnboardingProposals,
  useWorkspaceStateInventory,
} from "./workspace-state-loader";
import { PreferenceRegistryAdministration } from "./preference-registry-admin";

function formatDate(value: string | null): string {
  if (!value) return "No activity";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

const GOVERNANCE_DRIFT_EXPLANATIONS: Record<WorkspaceStateGovernanceDriftStatus, string> = {
  identical: "Frozen and current stable identities match exactly.",
  superseded: "The same targets remain, but one or more active revisions changed.",
  changed: "The current target or descriptor set added or removed an entry.",
  missing: "The accepted attempt has no immutable snapshot row for this authority.",
  truncated: "A snapshot or current preference bound prevents an exact equality claim.",
  unavailable: "The comparison is unavailable under the accepted-attempt authorization fence.",
};

type OnboardingProposalReviewSummary = {
  status: "loading" | "unavailable" | "ready";
  pendingCount: number;
  staleCount: number;
  partial: boolean;
};

const LOADING_PROPOSAL_REVIEW: OnboardingProposalReviewSummary = {
  status: "loading",
  pendingCount: 0,
  staleCount: 0,
  partial: false,
};

type WorkspaceReviewSummary<T> = {
  workspaceId: string;
  summary: T;
};

export function reviewSummaryForWorkspace<T>(
  workspaceId: string,
  review: WorkspaceReviewSummary<T>,
  loading: T,
): T {
  return review.workspaceId === workspaceId ? review.summary : loading;
}

function comparisonHash(value: string | null): ReactNode {
  return value ? <code className="break-all text-2xs">sha256:{value}</code> : "Unavailable";
}

function comparisonCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function StateCard(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-fg">{props.title}</h2>
      {props.description ? (
        <p className="mt-1 text-xs leading-5 text-fg-muted">{props.description}</p>
      ) : null}
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-border/70 bg-surface-2/40 p-3">
      <div className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-fg">{value}</div>
    </div>
  );
}

function WorkspaceStateLoading() {
  return (
    <div aria-label="Loading Agent Knowledge" className="grid gap-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export function CompanyProfileContentView({ profile }: { profile: CompanyProfileContent }) {
  const hasRetiredStructuredDetails =
    profile.products.length > 0 ||
    profile.customers.length > 0 ||
    profile.goals.length > 0 ||
    profile.constraints.length > 0;
  return (
    <div className="grid gap-3 rounded-md border border-border bg-surface-2/30 p-3 text-xs leading-5 text-fg-muted">
      {profile.identity ? (
        <div>
          <strong className="text-fg">Identity:</strong> {profile.identity}
        </div>
      ) : null}
      {profile.mission ? (
        <div>
          <strong className="text-fg">Mission:</strong> {profile.mission}
        </div>
      ) : null}
      {hasRetiredStructuredDetails ? (
        <p className="text-fg-subtle">
          This historical revision contains retired structured details. They remain available to
          agents for compatibility until an organization owner replaces this revision.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One route-level company-profile inventory is shared by the pending-proposals
 * card and the manual editor/history so an activation from either keeps the
 * other's head and CAS values in sync.
 */
export type CompanyProfileInventoryHandle = Pick<
  ReturnType<typeof useCompanyProfileInventory>,
  "response" | "reload" | "loading" | "error"
>;

export function pendingCompanyProfileProposals(
  response: CompanyProfileInventoryHandle["response"],
): CompanyProfileRevision[] {
  if (!response) return [];
  const activated = new Set(
    response.activationEvents.flatMap((event) => (event.newRevision ? [event.newRevision.id] : [])),
  );
  return response.revisions
    .filter((revision) => revision.intent === "proposal" && !activated.has(revision.id))
    .sort((left, right) => right.revision - left.revision);
}

export function CompanyProfilePendingProposals({
  workspaceId,
  canManage,
  inventory,
}: {
  workspaceId: string;
  canManage: boolean;
  inventory: Pick<CompanyProfileInventoryHandle, "response" | "reload">;
}) {
  const { client } = useAppContext();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = pendingCompanyProfileProposals(inventory.response);
  if (pending.length === 0) return null;

  const activate = async (revisionId: string): Promise<void> => {
    if (!canManage || !inventory.response || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.activateCompanyProfileRevision(workspaceId, revisionId, {
        operationId: crypto.randomUUID(),
        expectedCurrentRevisionId: inventory.response.current?.revisionId ?? null,
        expectedActivationVersion: inventory.response.current?.activationVersion ?? 0,
        reason: "Activate reviewed company-profile proposal",
      });
    } catch (activationError) {
      setError(
        activationError instanceof Error ? activationError.message : String(activationError),
      );
    } finally {
      // Reload even on failure so a COMPANY_PROFILE_CONFLICT re-syncs the
      // shared head and CAS values before the next action.
      await inventory.reload();
      setSubmitting(false);
    }
  };

  return (
    <StateCard
      title="Pending proposals"
      description="Proposed company profiles waiting for review. Activating one replaces the active profile for every workspace in the organization."
    >
      <ul aria-label="Pending company profile proposals" className="grid gap-3">
        {pending.map((revision) => (
          <li
            key={revision.id}
            className="grid gap-2 rounded-md border border-border p-3"
            data-revision-id={revision.id}
          >
            <div className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
              <div className="text-fg-muted">
                <span className="font-medium text-fg">r{revision.revision}</span> · Proposed{" "}
                {formatDate(revision.createdAt)} · {humanize(revision.provenance.source)}
              </div>
              {canManage ? (
                <button
                  className="w-fit rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  type="button"
                  disabled={submitting}
                  onClick={() => void activate(revision.id)}
                >
                  Activate
                </button>
              ) : (
                <span className="text-fg-subtle">
                  Only an organization owner or admin can activate this proposal.
                </span>
              )}
            </div>
            <CompanyProfileContentView profile={revision.profile} />
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-xs text-status-danger">{error}</p> : null}
    </StateCard>
  );
}

export function CompanyProfileInventory({
  workspaceId,
  inventory,
}: {
  workspaceId: string;
  inventory: CompanyProfileInventoryHandle;
}) {
  const context = useAppContext();
  const { client } = context;
  const workspaceGrant = context.accessContext.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManage = Boolean(
    workspaceGrant?.accountId &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const currentRevision = inventory.response?.activeRevision ?? null;
  const [identity, setIdentity] = useState("");
  const [mission, setMission] = useState("");
  const [reason, setReason] = useState("Update organization identity");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIdentity(currentRevision?.profile.identity ?? "");
    setMission(currentRevision?.profile.mission ?? "");
  }, [currentRevision]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canManage || submitting || !inventory.response) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.updateCompanyProfile(workspaceId, {
        operationId: crypto.randomUUID(),
        profile: {
          identity: identity.trim() || null,
          mission: mission.trim() || null,
          products: [],
          customers: [],
          goals: [],
          constraints: [],
        },
        expectedCurrentRevisionId: inventory.response.current?.revisionId ?? null,
        expectedActivationVersion: inventory.response.current?.activationVersion ?? 0,
        reason,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      await inventory.reload();
      setSubmitting(false);
    }
  };

  const activate = async (revisionId: string): Promise<void> => {
    if (!canManage || !inventory.response || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.activateCompanyProfileRevision(workspaceId, revisionId, {
        operationId: crypto.randomUUID(),
        expectedCurrentRevisionId: inventory.response.current?.revisionId ?? null,
        expectedActivationVersion: inventory.response.current?.activationVersion ?? 0,
        reason: "Activate reviewed company-profile proposal",
      });
    } catch (activationError) {
      setError(
        activationError instanceof Error ? activationError.message : String(activationError),
      );
    } finally {
      await inventory.reload();
      setSubmitting(false);
    }
  };

  const rollback = async (revisionId: string): Promise<void> => {
    const current = inventory.response?.current;
    if (!canManage || !current || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.rollbackCompanyProfile(workspaceId, {
        operationId: crypto.randomUUID(),
        targetRevisionId: revisionId,
        expectedCurrentRevisionId: current.revisionId,
        expectedActivationVersion: current.activationVersion,
        reason: "Restore a previously active company profile",
      });
    } catch (rollbackError) {
      setError(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    } finally {
      await inventory.reload();
      setSubmitting(false);
    }
  };

  return (
    <StateCard
      title="Organization identity"
      description="Small, stable context shared across the organization: who it is and why it exists. Other company knowledge stays in Documents and is retrieved when relevant."
    >
      {inventory.loading && !inventory.response ? <Skeleton className="h-40 w-full" /> : null}
      {inventory.error && !inventory.response ? (
        <LoadErrorState
          title="Couldn't load the company profile"
          error={inventory.error}
          onRetry={() => void inventory.reload()}
        />
      ) : null}
      {inventory.response ? (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="Current revision"
              value={
                inventory.response.current ? `r${inventory.response.current.revision}` : "None"
              }
            />
            <Metric
              label="Activation version"
              value={inventory.response.current?.activationVersion ?? 0}
            />
            <Metric label="History" value={inventory.response.revisions.length} />
          </div>
          {currentRevision ? (
            <CompanyProfileContentView profile={currentRevision.profile} />
          ) : (
            <EmptyState>No organization company profile is active.</EmptyState>
          )}

          {canManage ? (
            <form
              aria-label="Edit organization identity"
              className="grid gap-3 rounded-md border border-border p-3"
              onSubmit={(event) => void save(event)}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-xs font-medium text-fg-muted">
                  Identity
                  <textarea
                    className="min-h-20 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                    maxLength={COMPANY_PROFILE_SCALAR_MAX_CHARS}
                    value={identity}
                    onChange={(event) => setIdentity(event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-xs font-medium text-fg-muted">
                  Mission
                  <textarea
                    className="min-h-20 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                    maxLength={COMPANY_PROFILE_SCALAR_MAX_CHARS}
                    value={mission}
                    onChange={(event) => setMission(event.target.value)}
                  />
                </label>
              </div>
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Audit reason
                <input
                  className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                  value={reason}
                  maxLength={4096}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {error ? <p className="text-xs text-status-danger">{error}</p> : null}
              <button
                className="w-fit rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                type="submit"
                disabled={submitting}
              >
                Save and activate new revision
              </button>
            </form>
          ) : (
            <p className="text-xs text-fg-muted">
              Only organization owners and admins can edit or activate the organization identity.
              You can still ask OpenGeni to draft a proposal above.
            </p>
          )}

          <div className="divide-y divide-border rounded-md border border-border">
            {inventory.response.revisions.map((revision) => {
              const active = revision.id === inventory.response?.current?.revisionId;
              const previouslyActive = inventory.response?.activationEvents.some(
                (activationEvent) => activationEvent.newRevision?.id === revision.id,
              );
              return (
                <div
                  key={revision.id}
                  className="flex flex-col gap-2 p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <span className="font-medium text-fg">r{revision.revision}</span> ·{" "}
                    {humanize(revision.intent)} · {humanize(revision.provenance.source)} ·{" "}
                    {formatDate(revision.createdAt)}
                  </div>
                  {canManage && !active ? (
                    <div className="flex gap-2">
                      {revision.intent === "proposal" ? (
                        <button
                          className="text-brand hover:underline"
                          type="button"
                          disabled={submitting}
                          onClick={() => void activate(revision.id)}
                        >
                          Activate
                        </button>
                      ) : null}
                      {previouslyActive ? (
                        <button
                          className="text-brand hover:underline"
                          type="button"
                          disabled={submitting}
                          onClick={() => void rollback(revision.id)}
                        >
                          Rollback
                        </button>
                      ) : null}
                    </div>
                  ) : active ? (
                    <span className="font-medium text-status-success">Active</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </StateCard>
  );
}

function onboardingProposalTargetLabel(
  target: Pick<WorkspaceInstructionPolicyOnboardingProposal, "kind" | "scope" | "roleKey">,
): string {
  if (target.kind === "charter") return "Workspace charter";
  return target.scope === "role" ? `Role policy · ${target.roleKey}` : "Global policy";
}

function onboardingProposalErrorMessage(error: unknown): string {
  if (error instanceof OpenGeniApiError) {
    switch (error.code) {
      case "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY":
        return "Enter proposal content before creating the draft.";
      case "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED":
        return "The proposal is larger than the instruction-policy draft limit.";
      case "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE":
        return "The active policy changed. Refresh Agent Knowledge and review the new baseline.";
      case "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT":
        return "That source version already proposed a draft for this policy target.";
      case "WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED":
        return "The proposal operation was already used with different input.";
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function OnboardingProposalInventory({
  state,
  workspaceId,
  onWorkspaceStateReload,
  onReviewSummary,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  onWorkspaceStateReload: () => Promise<void>;
  onReviewSummary?: (summary: OnboardingProposalReviewSummary) => void;
}) {
  const context = useAppContext();
  const { client } = context;
  const canCreate = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const proposals = useWorkspaceInstructionPolicyOnboardingProposals(client, workspaceId);
  const [kind, setKind] = useState<WorkspaceInstructionPolicyKind>("charter");
  const [scope, setScope] = useState<WorkspaceInstructionPolicyScope>("global");
  const [roleKey, setRoleKey] = useState("");
  const [sourceId, setSourceId] = useState("guided-onboarding");
  const [sourceVersion, setSourceVersion] = useState("v1");
  const [confidencePercent, setConfidencePercent] = useState("90");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdProposalId, setCreatedProposalId] = useState<string | null>(null);

  useEffect(() => {
    if (!onReviewSummary) return;
    if (proposals.loading) {
      onReviewSummary(LOADING_PROPOSAL_REVIEW);
      return;
    }
    if (proposals.error || !proposals.response) {
      onReviewSummary({
        status: "unavailable",
        pendingCount: 0,
        staleCount: 0,
        partial: false,
      });
      return;
    }
    let staleCount = 0;
    let baselineCoveragePartial = false;
    for (const proposal of proposals.response.proposals) {
      const head = state.policy.activeHeads.find(
        (candidate) =>
          candidate.kind === proposal.kind &&
          candidate.scope === proposal.scope &&
          candidate.roleKey === proposal.roleKey,
      );
      if (!head && state.policy.activeHeadsTruncated) {
        baselineCoveragePartial = true;
      } else if (
        (head?.revisionId ?? null) !== (proposal.baseline?.revisionId ?? null) ||
        (head?.activationVersion ?? 0) !== (proposal.baseline?.activationVersion ?? 0)
      ) {
        staleCount += 1;
      }
    }
    onReviewSummary({
      status: "ready",
      pendingCount: proposals.response.proposals.length,
      staleCount,
      partial: proposals.response.truncated || baselineCoveragePartial,
    });
  }, [
    onReviewSummary,
    proposals.error,
    proposals.loading,
    proposals.response,
    state.policy.activeHeads,
    state.policy.activeHeadsTruncated,
  ]);

  const effectiveScope: WorkspaceInstructionPolicyScope = kind === "charter" ? "global" : scope;
  const normalizedRoleKey =
    effectiveScope === "role" && roleKey.trim()
      ? normalizeWorkspaceInstructionPolicyRoleKey(roleKey)
      : null;
  const baseline = state.policy.activeHeads.find(
    (head) =>
      head.kind === kind && head.scope === effectiveScope && head.roleKey === normalizedRoleKey,
  );

  const createProposal = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canCreate || submitting) return;
    if (effectiveScope === "role" && !normalizedRoleKey) {
      setSubmitError("Enter a role key for a role policy proposal.");
      return;
    }
    const confidence = Number(confidencePercent);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      setSubmitError("Confidence must be between 0 and 100 percent.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setCreatedProposalId(null);
    try {
      const created = await client.createWorkspaceInstructionPolicyOnboardingProposal(workspaceId, {
        operationId: crypto.randomUUID(),
        kind,
        scope: effectiveScope,
        roleKey: normalizedRoleKey,
        content,
        sourceId,
        sourceVersion,
        confidenceBps: Math.round(confidence * 100),
        expectedCurrentRevisionId: baseline?.revisionId ?? null,
        expectedActivationVersion: baseline?.activationVersion ?? 0,
      });
      setContent("");
      setCreatedProposalId(created.id);
      await Promise.all([proposals.reload(), onWorkspaceStateReload()]);
    } catch (error) {
      setSubmitError(onboardingProposalErrorMessage(error));
      if (
        error instanceof OpenGeniApiError &&
        error.code === "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE"
      ) {
        await onWorkspaceStateReload().catch(() => undefined);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StateCard
      title="Onboarding proposals"
      description="Create provenance-linked instruction-policy drafts only. Proposals never activate themselves and do not promote Documents or Memory into prompt authority."
    >
      {canCreate ? (
        <form
          aria-label="Create onboarding proposal"
          className="grid gap-3 rounded-md border border-border bg-surface-2/30 p-3"
          onSubmit={(event) => void createProposal(event)}
        >
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Target kind
              <select
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                value={kind}
                onChange={(event) => {
                  const nextKind = event.target.value as WorkspaceInstructionPolicyKind;
                  setKind(nextKind);
                  if (nextKind === "charter") setScope("global");
                }}
              >
                <option value="charter">Workspace charter</option>
                <option value="policy">Policy</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Policy scope
              <select
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg disabled:opacity-60"
                value={effectiveScope}
                disabled={kind === "charter"}
                onChange={(event) =>
                  setScope(event.target.value as WorkspaceInstructionPolicyScope)
                }
              >
                <option value="global">Global</option>
                <option value="role">Role</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Source ID
              <input
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                value={sourceId}
                maxLength={512}
                required
                onChange={(event) => setSourceId(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Source version
              <input
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                value={sourceVersion}
                maxLength={256}
                required
                onChange={(event) => setSourceVersion(event.target.value)}
              />
            </label>
          </div>
          {effectiveScope === "role" ? (
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Role key
              <input
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                placeholder="incident-responder"
                value={roleKey}
                maxLength={64}
                required
                onChange={(event) => setRoleKey(event.target.value)}
              />
            </label>
          ) : null}
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem]">
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Draft content
              <textarea
                className="min-h-36 rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 text-fg"
                value={content}
                maxLength={WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS}
                required
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <div className="grid content-start gap-3">
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Confidence (%)
                <input
                  className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={confidencePercent}
                  required
                  onChange={(event) => setConfidencePercent(event.target.value)}
                />
              </label>
              <div className="rounded-md border border-border bg-surface p-3 text-xs leading-5 text-fg-muted">
                <div className="font-medium text-fg">Exact baseline</div>
                {baseline ? (
                  <>
                    <div>Revision r{baseline.revision}</div>
                    <div>Activation v{baseline.activationVersion}</div>
                  </>
                ) : (
                  <div>No active target</div>
                )}
              </div>
            </div>
          </div>
          {state.policy.activeHeadsTruncated && !baseline ? (
            <p className="text-xs text-status-waiting">
              Active heads are truncated. The server will reject this proposal as stale if the
              selected target has an undisplayed active head.
            </p>
          ) : null}
          {submitError ? (
            <div role="alert" className="text-xs text-status-error">
              {submitError}
            </div>
          ) : null}
          {createdProposalId ? (
            <div role="status" className="text-xs text-status-success">
              Draft-only proposal created. No policy activation occurred.
            </div>
          ) : null}
          <div>
            <button
              type="submit"
              className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitting}
            >
              {submitting ? "Creating draft…" : "Create draft proposal"}
            </button>
          </div>
        </form>
      ) : (
        <div className="rounded-md border border-border bg-surface-2/30 p-3 text-xs leading-5 text-fg-muted">
          Workspace admin permission is required to create onboarding proposals. Existing proposal
          evidence remains readable with workspace access.
        </div>
      )}

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Recent proposal evidence
          </h3>
          <button
            type="button"
            className="text-xs font-medium text-brand hover:underline disabled:opacity-60"
            disabled={proposals.loading}
            onClick={() => void proposals.reload()}
          >
            Refresh
          </button>
        </div>
        {proposals.loading && !proposals.response ? (
          <Skeleton aria-label="Loading onboarding proposals" className="h-24 w-full" />
        ) : null}
        {proposals.error && !proposals.response ? (
          <LoadErrorState
            title="Couldn't load onboarding proposals"
            error={proposals.error}
            onRetry={() => void proposals.reload()}
          />
        ) : null}
        {proposals.response?.proposals.length === 0 ? (
          <EmptyState>No onboarding proposals exist yet.</EmptyState>
        ) : null}
        {proposals.response?.proposals.length ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {proposals.response.proposals.map((proposal) => (
              <div key={proposal.id} className="grid gap-2 p-3 text-xs text-fg-muted">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-fg">
                    {onboardingProposalTargetLabel(proposal)} · draft r{proposal.draft.revision}
                  </div>
                  <span className="rounded-full border border-status-waiting/50 px-2 py-1 text-status-waiting">
                    Inactive proposal
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    Source {proposal.source.id}@{proposal.source.version}
                  </span>
                  <span>Confidence {(proposal.source.confidenceBps / 100).toFixed(2)}%</span>
                  <span>
                    Baseline {proposal.baseline ? `r${proposal.baseline.revision}` : "none"}
                  </span>
                  <span>Created {formatDate(proposal.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words leading-5 text-fg">
                  {proposal.draft.content}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        {proposals.error && proposals.response ? (
          <p className="mt-2 text-xs text-status-error">
            Refresh failed: {proposals.error.message}
          </p>
        ) : null}
        {proposals.response?.truncated ? (
          <p className="mt-2 text-xs text-status-waiting">
            Only the newest 50 onboarding proposals are shown.
          </p>
        ) : null}
      </div>
    </StateCard>
  );
}

export function AttemptGovernanceInventory({
  state,
  attemptInput,
  onAttemptInput,
  onInspect,
  onClear,
}: {
  state: WorkspaceStateResponse;
  attemptInput: string;
  onAttemptInput: (value: string) => void;
  onInspect: (event: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
}) {
  const governance = state.truth.attemptGovernance;
  return (
    <StateCard
      title="Accepted-attempt governance"
      description="Inspect immutable policy and structured-preference metadata for an attempt you initiated. Hidden prompt text and preference values are never returned."
    >
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={onInspect}>
        <input
          aria-label="Attempt ID"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand"
          placeholder="Attempt UUID"
          value={attemptInput}
          onChange={(event) => onAttemptInput(event.target.value)}
          pattern="[0-9a-fA-F-]{36}"
          required
        />
        <button
          type="submit"
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90"
        >
          Inspect
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2"
          onClick={onClear}
        >
          Clear
        </button>
      </form>

      {governance.status === "not_requested" ? (
        <div className="mt-4">
          <EmptyState>Enter an accepted attempt ID to inspect its frozen governance.</EmptyState>
        </div>
      ) : null}
      {governance.status === "unavailable" ? (
        <div className="mt-4">
          <EmptyState>
            That attempt is unavailable or was not initiated by your authenticated subject. No
            attempt metadata was disclosed.
          </EmptyState>
        </div>
      ) : null}
      {governance.status === "available" ? (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Metric label="Overall drift" value={humanize(governance.drift.overall)} />
            <Metric label="Policy drift" value={humanize(governance.drift.policy.status)} />
            <Metric
              label="Preference drift"
              value={humanize(governance.drift.preferences.status)}
            />
            <Metric label="Accepted" value={formatDate(governance.acceptedAt)} />
          </div>
          <div className="rounded-md border border-border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Current versus snapshot
            </h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              Deterministic drift compares stable IDs, revisions, content hashes, and activation
              versions. Policy and preference bodies are never returned.
            </p>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {[
                {
                  key: "policy",
                  title: "Instruction policy",
                  status: governance.drift.policy.status,
                  snapshotCount: governance.drift.policy.snapshotTargetCount,
                  currentCount: governance.drift.policy.currentTargetCount,
                  snapshotHash: governance.drift.policy.snapshotHash,
                  currentHash: governance.drift.policy.currentHash,
                  snapshotNoun: "frozen target",
                  currentNoun: "current target",
                  snapshotCoverage: null,
                  currentCoverage: null,
                },
                {
                  key: "preferences",
                  title: "Structured preferences",
                  status: governance.drift.preferences.status,
                  snapshotCount: governance.drift.preferences.snapshotDescriptorCount,
                  currentCount: governance.drift.preferences.currentDescriptorCount,
                  snapshotHash: governance.drift.preferences.snapshotHash,
                  currentHash: governance.drift.preferences.currentHash,
                  snapshotNoun: "frozen descriptor",
                  currentNoun: "current descriptor",
                  snapshotCoverage: governance.drift.preferences.snapshotTruncated
                    ? "truncated"
                    : "complete",
                  currentCoverage: governance.drift.preferences.currentTruncated
                    ? "truncated"
                    : "complete",
                },
              ].map((comparison) => (
                <section
                  key={comparison.key}
                  aria-label={`${comparison.title} governance comparison`}
                  className="rounded-md border border-border/70 bg-surface-2/30 p-3 text-xs text-fg-muted"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-medium text-fg">{comparison.title}</h4>
                    <span className="rounded-full border border-border px-2 py-1 font-medium text-fg">
                      {humanize(comparison.status)}
                    </span>
                  </div>
                  <p className="mt-2 leading-5">
                    {GOVERNANCE_DRIFT_EXPLANATIONS[comparison.status]}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="rounded border border-border bg-surface p-2">
                      <div className="font-medium text-fg">Accepted snapshot</div>
                      <div className="mt-1">
                        {comparisonCount(comparison.snapshotCount, comparison.snapshotNoun)}
                      </div>
                      {comparison.snapshotCoverage ? (
                        <div className="mt-1">Coverage: {comparison.snapshotCoverage}</div>
                      ) : null}
                      <div className="mt-1">{comparisonHash(comparison.snapshotHash)}</div>
                    </div>
                    <div className="rounded border border-border bg-surface p-2">
                      <div className="font-medium text-fg">Current authority</div>
                      <div className="mt-1">
                        {comparisonCount(comparison.currentCount, comparison.currentNoun)}
                      </div>
                      {comparison.currentCoverage ? (
                        <div className="mt-1">Coverage: {comparison.currentCoverage}</div>
                      ) : null}
                      <div className="mt-1">{comparisonHash(comparison.currentHash)}</div>
                    </div>
                  </div>
                </section>
              ))}
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-border p-3 text-xs text-fg-muted">
              <div className="font-medium text-fg">Instruction policy snapshot</div>
              {governance.policySnapshot.status === "missing" ? (
                <p className="mt-2">No immutable policy snapshot row exists for this attempt.</p>
              ) : (
                <div className="mt-2 grid gap-1">
                  <span>{governance.policySnapshot.entries.length} frozen target(s)</span>
                  <span>Role: {governance.policySnapshot.policyRole ?? "none"}</span>
                  <span>Captured {formatDate(governance.policySnapshot.createdAt)}</span>
                  <code className="break-all text-2xs">
                    sha256:{governance.policySnapshot.entryHash}
                  </code>
                </div>
              )}
            </div>
            <div className="rounded-md border border-border p-3 text-xs text-fg-muted">
              <div className="font-medium text-fg">Structured preference snapshot</div>
              {governance.preferenceSnapshot.status === "missing" ? (
                <p className="mt-2">
                  No immutable preference snapshot row exists for this attempt.
                </p>
              ) : (
                <div className="mt-2 grid gap-1">
                  <span>{governance.preferenceSnapshot.descriptorCount} frozen descriptor(s)</span>
                  <span>
                    Coverage: {governance.preferenceSnapshot.truncated ? "truncated" : "complete"}
                  </span>
                  <span>Captured {formatDate(governance.preferenceSnapshot.createdAt)}</span>
                  <code className="break-all text-2xs">
                    sha256:{governance.preferenceSnapshot.descriptorHash}
                  </code>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </StateCard>
  );
}

function FocusedInstructions({
  state,
  workspaceId,
  personalWorkspace,
  onWorkspaceStateReload,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  personalWorkspace: boolean;
  onWorkspaceStateReload: () => Promise<void>;
}) {
  const context = useAppContext();
  const { client } = context;
  const canEdit = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const activeHead = activeGlobalWorkspaceInstructionHead(state);
  const activeRevisionId = activeHead?.revisionId ?? null;
  const instructionConfigured =
    activeRevisionId !== null || state.policy.legacyRuntime.workspaceOverrideConfigured;
  const [content, setContent] = useState("");
  const [loadingContent, setLoadingContent] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingContent(true);
    setContent("");
    setMessage(null);
    setEditorError(null);
    void (async () => {
      try {
        const nextContent = activeRevisionId
          ? (await client.getWorkspaceInstructionPolicyRevision(workspaceId, activeRevisionId))
              .content
          : state.policy.legacyRuntime.workspaceOverrideConfigured
            ? ((await client.getWorkspace(workspaceId)).agentInstructions ?? "")
            : "";
        if (!cancelled) setContent(nextContent);
      } catch (error) {
        if (!cancelled) {
          setEditorError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setLoadingContent(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeRevisionId,
    client,
    state.policy.legacyRuntime.workspaceOverrideConfigured,
    workspaceId,
  ]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canEdit || saving || !content.trim()) return;
    setSaving(true);
    setMessage(null);
    setEditorError(null);
    try {
      const draft = await client.createWorkspaceInstructionPolicyDraft(workspaceId, {
        operationId: crypto.randomUUID(),
        kind: "policy",
        scope: "global",
        roleKey: null,
        content,
        provenanceSource: "human",
        provenanceSourceId: null,
        supersedesRevisionId: activeHead?.revisionId ?? null,
      });
      await client.activateWorkspaceInstructionPolicyRevision(workspaceId, draft.id, {
        operationId: crypto.randomUUID(),
        expectedCurrentRevisionId: activeHead?.revisionId ?? null,
        expectedActivationVersion: activeHead?.activationVersion ?? 0,
        reason: "Updated by a workspace admin from Agent Knowledge",
      });
      await onWorkspaceStateReload();
      setMessage("Saved. New agent turns will use these workspace instructions.");
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section
        aria-labelledby="current-workspace-instruction-heading"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="current-workspace-instruction-heading" className="text-sm font-medium text-fg">
            {personalWorkspace ? "Current personal workspace instruction" : "Current instruction"}
          </h2>
          <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-fg-muted">
            {instructionConfigured ? "Active" : "Not set"}
          </span>
        </div>
        {loadingContent ? (
          <Skeleton aria-label="Loading current instruction" className="mt-3 h-16 w-full" />
        ) : editorError && !content.trim() ? (
          <p role="alert" className="mt-3 text-xs text-status-error">
            {editorError}
          </p>
        ) : content.trim() ? (
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-fg-muted">{content}</p>
        ) : (
          <p className="mt-3 text-xs leading-5 text-fg-muted">
            No workspace instruction is active yet. Tell OpenGeni what agents should always do, or
            add a concise instruction manually below.
          </p>
        )}
      </section>
      {canEdit ? (
        <>
          <AgentKnowledgePrompt kind="workspace_instructions" workspaceId={workspaceId} />
          <details className="group rounded-lg border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
              {instructionConfigured ? "Edit manually" : "Add manually"}
              <ChevronDownIcon className="size-4 text-fg-muted transition-transform group-open:rotate-180" />
            </summary>
            <form
              className="grid gap-3 border-t border-border p-4"
              onSubmit={(event) => void save(event)}
            >
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                {personalWorkspace
                  ? "Instructions for your personal workspace"
                  : "Instructions for this workspace"}
                <textarea
                  className="min-h-48 rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 text-fg outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-60"
                  value={content}
                  maxLength={WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS}
                  disabled={!canEdit || loadingContent || saving}
                  placeholder="For example: Keep updates concise, explain important decisions, and surface blockers early."
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
              <p className="text-xs leading-5 text-fg-subtle">
                {personalWorkspace
                  ? "These instructions are included automatically only for agents working in your personal workspace."
                  : "These instructions are included automatically for agents working in this workspace."}{" "}
                Changes are versioned and can be audited or rolled back.
              </p>
              {!canEdit ? (
                <p className="text-xs text-status-waiting">
                  Workspace admin access is required to edit.
                </p>
              ) : null}
              {editorError ? (
                <p role="alert" className="text-xs text-status-error">
                  {editorError}
                </p>
              ) : null}
              {message ? (
                <p role="status" className="text-xs text-status-success">
                  {message}
                </p>
              ) : null}
              <div>
                <button
                  type="submit"
                  className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!canEdit || loadingContent || saving || !content.trim()}
                >
                  {saving ? "Saving…" : "Save instructions"}
                </button>
              </div>
            </form>
          </details>
        </>
      ) : (
        <Notice
          tone="info"
          title={
            personalWorkspace
              ? "Personal instruction editing is not available yet"
              : "Workspace instructions are read-only for you"
          }
        >
          {personalWorkspace
            ? "You can see the instruction currently applied here. Personal Skills, Documents, and Memory are available now; editing this personal instruction needs the upcoming personal-policy authority."
            : "You can see the instruction currently applied here. A workspace administrator can change it."}
        </Notice>
      )}
    </div>
  );
}

export function WorkspaceStateRoute({
  workspaceId,
  view,
}: {
  workspaceId: string;
  view?: "instructions" | "skills";
}) {
  const context = useAppContext();
  const { client } = context;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const personalWorkspace = isPersonalWorkspace(workspace, context.managedSelfContext);
  const { state, error, loading, reload } = useWorkspaceStateInventory(client, workspaceId);

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BrainCircuitIcon className="size-4" />}
        title={
          view === "instructions"
            ? personalWorkspace
              ? "Personal workspace instructions"
              : "Workspace instructions"
            : view === "skills"
              ? personalWorkspace
                ? "Your Skills"
                : "Skills"
              : personalWorkspace
                ? "Your Agent Knowledge"
                : "Agent Knowledge"
        }
        description={
          view === "instructions"
            ? personalWorkspace
              ? "View the always-on guidance currently applied in your personal workspace."
              : "Set the concise, always-on guidance for agents in this workspace."
            : view === "skills"
              ? personalWorkspace
                ? "Manage personal Skills that follow you, alongside other Skills available here."
                : "Create reusable instructions agents can fetch when relevant."
              : personalWorkspace
                ? "Your private instructions, Skills, documents, and Memory, together with company knowledge you can access."
                : "The instructions, skills, documents, and memories available to agents in this workspace."
        }
      />
      <div className="mt-6">
        {view ? (
          <Link
            to="/workspaces/$workspaceId/state"
            params={{ workspaceId }}
            search={{}}
            className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            <ArrowLeftIcon className="size-3" />
            Back to Agent Knowledge
          </Link>
        ) : null}
        {loading && !state ? <WorkspaceStateLoading /> : null}
        {error && !state ? (
          <LoadErrorState
            title="Couldn't load Agent Knowledge"
            error={error}
            onRetry={() => void reload()}
          />
        ) : null}
        {state ? (
          <div className="grid gap-4">
            {error ? (
              <LoadErrorState
                title="Couldn't refresh Agent Knowledge"
                error={error}
                onRetry={() => void reload()}
              />
            ) : null}
            {view === "instructions" ? (
              <FocusedInstructions
                state={state}
                workspaceId={workspaceId}
                personalWorkspace={personalWorkspace}
                onWorkspaceStateReload={reload}
              />
            ) : null}
            {view === "skills" ? (
              <PreferenceRegistryAdministration
                workspaceId={workspaceId}
                onWorkspaceStateReload={reload}
                compact
                personalWorkspace={personalWorkspace}
              />
            ) : null}
            {!view ? (
              <BrainOverview
                state={state}
                workspaceId={workspaceId}
                personalWorkspace={personalWorkspace}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </ContentPage>
  );
}
