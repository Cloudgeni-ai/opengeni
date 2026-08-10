import {
  COMPANY_PROFILE_ENTRY_MAX_CHARS,
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  OpenGeniApiError,
  normalizeCompanyProfileStableKey,
  type CompanyProfileContent,
  type CompanyProfileEntry,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  normalizeWorkspaceInstructionPolicyRoleKey,
  type WorkspaceInstructionPolicyKind,
  type WorkspaceInstructionPolicyOnboardingProposal,
  type WorkspaceInstructionPolicyScope,
  type WorkspaceStateGapCode,
  type WorkspaceStateGovernanceDriftStatus,
  type WorkspaceStateResponse,
} from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import {
  BookOpenIcon,
  BrainCircuitIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Clock3Icon,
  FileSearchIcon,
  NetworkIcon,
  PlugIcon,
  ServerCogIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";

import { BrainOverview } from "./agent-brain-overview";
import {
  useCompanyProfileInventory,
  useWorkspaceInstructionPolicyOnboardingProposals,
  useWorkspaceStateInventory,
} from "./workspace-state-loader";
import { PreferenceRegistryAdministration } from "./preference-registry-admin";

const GAP_LABELS: Record<WorkspaceStateGapCode, string> = {
  no_document_bases: "No document bases are configured.",
  no_visible_documents: "The visible document bases are empty.",
  failed_documents: "Some visible documents failed indexing.",
  processing_documents: "Some visible documents are queued or indexing.",
  missing_topic_coverage: "Ready documents do not have topic metadata.",
  no_memory_records: "The newest memory sample is empty.",
  pending_memory_review: "Some sampled memories are awaiting review.",
  partial_inventory:
    "The inventory reached a safety bound; one or more lists or samples is truncated.",
};

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
    <div aria-label="Loading Agent Brain" className="grid gap-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

function PolicyInventory({ state }: { state: WorkspaceStateResponse }) {
  const { policy } = state;
  return (
    <StateCard
      title="Instruction policy inventory"
      description="Metadata from the authoritative instruction-policy backend. Policy bodies are intentionally excluded."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Active heads" value={policy.activeHeads.length} />
        <Metric
          label="Latest revision"
          value={policy.latestRevision ? `r${policy.latestRevision.revision}` : "None"}
        />
        <Metric
          label="Runtime source"
          value={
            policy.legacyRuntime.workspaceOverrideConfigured ? "Workspace override" : "Default"
          }
        />
      </div>

      <div className="mt-4 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-3 text-xs leading-5 text-fg-muted">
        <span className="font-medium text-fg">Current governance:</span> active heads are read-time
        metadata, not prompt bodies. Inspect an accepted attempt below to compare them with the
        immutable governance frozen for that attempt.
      </div>

      {policy.latestRevision ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span className="rounded-full border border-border px-2 py-1">
            {humanize(policy.latestRevision.kind)} · {humanize(policy.latestRevision.scope)}
          </span>
          <span className="rounded-full border border-border px-2 py-1">
            {humanize(policy.latestRevision.state)}
          </span>
          <span className="rounded-full border border-border px-2 py-1">
            Provenance: {humanize(policy.latestRevision.provenanceSource)}
          </span>
        </div>
      ) : (
        <div className="mt-4">
          <EmptyState>No instruction-policy revisions exist yet.</EmptyState>
        </div>
      )}

      {policy.activeHeads.length > 0 ? (
        <div className="mt-4 divide-y divide-border rounded-md border border-border">
          {policy.activeHeads.map((head) => (
            <div
              key={`${head.kind}:${head.scope}:${head.roleKey ?? "global"}`}
              className="flex flex-col gap-1 p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="font-medium text-fg">
                {humanize(head.kind)} · {head.roleKey ?? humanize(head.scope)}
              </div>
              <div className="text-fg-muted">
                r{head.revision} · activated {formatDate(head.activatedAt)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {policy.activeHeadsTruncated ? (
        <p className="mt-2 text-xs text-status-waiting">
          Only the first 32 active heads are shown.
        </p>
      ) : null}
    </StateCard>
  );
}

function PreferenceInventory({ state }: { state: WorkspaceStateResponse }) {
  const { preferences } = state;
  return (
    <StateCard
      title="Preference authority inventory"
      description="Identity-only metadata from the structured preference registry. Titles, descriptions, values, and retrieval handles are excluded."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Active descriptors" value={preferences.activeDescriptorCount} />
        <Metric label="Organization" value={preferences.scopeCounts.organization} />
        <Metric label="Workspace" value={preferences.scopeCounts.workspace} />
        <Metric label="Personal" value={preferences.scopeCounts.user} />
      </div>
      <div className="mt-4 text-xs text-fg-muted">
        Current identity:{" "}
        <code className="break-all">sha256:{preferences.activeDescriptorHash}</code>
      </div>
      {preferences.truncated ? (
        <p className="mt-2 text-xs text-status-waiting">
          The descriptor inventory reached its safety bound; the hash must not be treated as
          complete.
        </p>
      ) : null}
    </StateCard>
  );
}

function profileEntriesText(entries: readonly CompanyProfileEntry[]): string {
  return entries.map((entry) => `${entry.key}: ${entry.content}`).join("\n");
}

function parseProfileEntries(value: string): CompanyProfileEntry[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error("Each list line must use `stable-key: content`.");
      const key = normalizeCompanyProfileStableKey(line.slice(0, separator));
      const content = line.slice(separator + 1).trim();
      if (!key || !content) throw new Error("Each list line needs a stable key and content.");
      if (content.length > COMPANY_PROFILE_ENTRY_MAX_CHARS) {
        throw new Error(
          `Company-profile list entries must be at most ${COMPANY_PROFILE_ENTRY_MAX_CHARS} characters.`,
        );
      }
      return { key, content };
    });
}

function emptyCompanyProfile(): CompanyProfileContent {
  return {
    identity: null,
    mission: null,
    products: [],
    customers: [],
    goals: [],
    constraints: [],
  };
}

export function CompanyProfileInventory({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { client } = context;
  const inventory = useCompanyProfileInventory(client, workspaceId);
  const workspaceGrant = context.accessContext.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManage = Boolean(
    workspaceGrant?.accountId &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const currentRevision = inventory.response?.current
    ? (inventory.response.revisions.find(
        (revision) => revision.id === inventory.response?.current?.revisionId,
      ) ?? null)
    : null;
  const [identity, setIdentity] = useState("");
  const [mission, setMission] = useState("");
  const [products, setProducts] = useState("");
  const [customers, setCustomers] = useState("");
  const [goals, setGoals] = useState("");
  const [constraints, setConstraints] = useState("");
  const [reason, setReason] = useState("Update organization company profile");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const profile = currentRevision?.profile ?? emptyCompanyProfile();
    setIdentity(profile.identity ?? "");
    setMission(profile.mission ?? "");
    setProducts(profileEntriesText(profile.products));
    setCustomers(profileEntriesText(profile.customers));
    setGoals(profileEntriesText(profile.goals));
    setConstraints(profileEntriesText(profile.constraints));
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
          products: parseProfileEntries(products),
          customers: parseProfileEntries(customers),
          goals: parseProfileEntries(goals),
          constraints: parseProfileEntries(constraints),
        },
        expectedCurrentRevisionId: inventory.response.current?.revisionId ?? null,
        expectedActivationVersion: inventory.response.current?.activationVersion ?? 0,
        reason,
      });
      await inventory.reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
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
      await inventory.reload();
    } catch (activationError) {
      setError(
        activationError instanceof Error ? activationError.message : String(activationError),
      );
    } finally {
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
      await inventory.reload();
    } catch (rollbackError) {
      setError(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StateCard
      title="Organization company profile"
      description="Concise mandatory context shared across the organization. Longer material stays in Documents; this is not Memory, Preference Registry, or workspace policy."
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
            <div className="grid gap-3 rounded-md border border-border bg-surface-2/30 p-3 text-xs leading-5 text-fg-muted">
              {currentRevision.profile.identity ? (
                <div>
                  <strong className="text-fg">Identity:</strong> {currentRevision.profile.identity}
                </div>
              ) : null}
              {currentRevision.profile.mission ? (
                <div>
                  <strong className="text-fg">Mission:</strong> {currentRevision.profile.mission}
                </div>
              ) : null}
              {(["products", "customers", "goals", "constraints"] as const).map((field) =>
                currentRevision.profile[field].length > 0 ? (
                  <div key={field}>
                    <strong className="text-fg">{humanize(field)}:</strong>{" "}
                    {currentRevision.profile[field].map((entry) => entry.content).join(" · ")}
                  </div>
                ) : null,
              )}
            </div>
          ) : (
            <EmptyState>No organization company profile is active.</EmptyState>
          )}

          {canManage ? (
            <form
              aria-label="Edit organization company profile"
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
              <div className="grid gap-3 md:grid-cols-2">
                {(
                  [
                    ["Products", products, setProducts],
                    ["Customers", customers, setCustomers],
                    ["Goals", goals, setGoals],
                    ["Critical constraints", constraints, setConstraints],
                  ] as const
                ).map(([label, value, setter]) => (
                  <label key={label} className="grid gap-1 text-xs font-medium text-fg-muted">
                    {label}
                    <textarea
                      className="min-h-24 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-fg"
                      placeholder="stable-key: concise content"
                      value={value}
                      onChange={(event) => setter(event.target.value)}
                    />
                  </label>
                ))}
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
              Editing and rollback require direct organization account-admin authority.
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
        return "The active policy changed. Refresh Agent Brain and review the new baseline.";
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
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
  onWorkspaceStateReload: () => Promise<void>;
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

function KnowledgeInventory({
  state,
  workspaceId,
}: {
  state: WorkspaceStateResponse;
  workspaceId: string;
}) {
  if (state.knowledge.availability === "unavailable") {
    return (
      <StateCard
        title="Knowledge map"
        description="Documents and Memory remain separate authorities."
      >
        <EmptyState>
          This inventory is unavailable because your grant does not include{" "}
          <code>documents:search</code>. No knowledge counts were disclosed.
        </EmptyState>
      </StateCard>
    );
  }

  const knowledge = state.knowledge;
  return (
    <StateCard
      title="Knowledge map"
      description="A structural view of visible Documents and the newest Memory sample; no document or memory text is returned."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Document bases" value={knowledge.baseCount} />
        <Metric label="Visible documents" value={knowledge.inspectedVisibleDocumentCount} />
        <Metric label="Ready" value={knowledge.documentStatusCounts.ready} />
        <Metric label="Memory sample" value={knowledge.memorySample.recordCount} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1">
          <Clock3Icon className="size-3" /> Latest document{" "}
          {formatDate(knowledge.latestDocumentUpdatedAt)}
        </span>
        <span className="rounded-full border border-border px-2 py-1">
          Coverage: {humanize(knowledge.coverage)}
        </span>
        {knowledge.basesTruncated ? (
          <span className="rounded-full border border-status-waiting/50 px-2 py-1 text-status-waiting">
            Base list truncated
          </span>
        ) : null}
        {knowledge.memorySample.limitReached ? (
          <span className="rounded-full border border-status-waiting/50 px-2 py-1 text-status-waiting">
            Memory sample reached {knowledge.memorySample.sampleLimit}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label="Company documents" value={knowledge.authorityKindCounts.organization} />
        <Metric label="Workspace documents" value={knowledge.authorityKindCounts.workspace} />
        <Metric label="Personal documents" value={knowledge.authorityKindCounts.personal} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Bases</h3>
            <Link
              to="/workspaces/$workspaceId/documents"
              params={{ workspaceId }}
              className="text-xs font-medium text-brand hover:underline"
            >
              Open Documents
            </Link>
          </div>
          {knowledge.bases.length === 0 ? (
            <EmptyState>No document bases are visible.</EmptyState>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {knowledge.bases.map((base) => (
                <div key={base.id} className="p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-fg">{base.name}</span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {base.visibleDocumentCount} visible
                    </span>
                  </div>
                  <div className="mt-1 text-2xs text-fg-subtle">
                    {base.statusCounts.ready} ready ·{" "}
                    {base.statusCounts.indexing + base.statusCounts.queued} processing ·{" "}
                    {base.statusCounts.failed} failed
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Topics
          </h3>
          {knowledge.topics.length === 0 ? (
            <EmptyState>No topic metadata was found in the visible documents.</EmptyState>
          ) : (
            <div className="flex flex-wrap gap-2 rounded-md border border-border p-3">
              {knowledge.topics.map((topic) => (
                <span
                  key={topic.name}
                  className="rounded-full border border-border bg-surface-2/50 px-2 py-1 text-xs text-fg-muted"
                >
                  {topic.name} · {topic.documentCount}
                </span>
              ))}
            </div>
          )}
          {knowledge.topicsTruncated ? (
            <p className="mt-2 text-xs text-status-waiting">Only the top 24 topics are shown.</p>
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          Deterministic gap signals
        </h3>
        {knowledge.gaps.length === 0 ? (
          <EmptyState>No structural gaps were detected in the visible inventory.</EmptyState>
        ) : (
          <ul className="grid gap-2">
            {knowledge.gaps.map((gap) => (
              <li
                key={gap.code}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-2/30 p-3 text-xs text-fg-muted"
              >
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
                <span>
                  {GAP_LABELS[gap.code]}
                  {gap.relatedCount === null ? "" : ` (${gap.relatedCount})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StateCard>
  );
}

function ExistingSources({ workspaceId }: { workspaceId: string }) {
  const links = [
    { to: "/workspaces/$workspaceId/documents" as const, label: "Documents", icon: FileSearchIcon },
    { to: "/workspaces/$workspaceId/memory" as const, label: "Memory", icon: BrainCircuitIcon },
    {
      to: "/workspaces/$workspaceId/capabilities" as const,
      label: "Skills & capabilities",
      icon: PlugIcon,
    },
    {
      to: "/workspaces/$workspaceId/sessions" as const,
      label: "Sessions & agents",
      icon: UsersIcon,
    },
    { to: "/workspaces/$workspaceId/rigs" as const, label: "Rigs", icon: ServerCogIcon },
    {
      to: "/workspaces/$workspaceId/variable-sets" as const,
      label: "Variable sets",
      icon: BookOpenIcon,
    },
    {
      to: "/workspaces/$workspaceId/settings" as const,
      label: "Workspace",
      icon: SettingsIcon,
    },
  ];
  return (
    <StateCard
      title="Authoritative source surfaces"
      description="Agent Brain is an overview, not a duplicate editor. Use each authority's existing surface or canonical lifecycle panel for detail and permitted changes."
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ workspaceId }}
            className="flex items-center gap-2 rounded-md border border-border p-3 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
          >
            <item.icon className="size-4 text-brand" />
            {item.label}
          </Link>
        ))}
      </div>
    </StateCard>
  );
}

export function WorkspaceStateRoute({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const [attemptInput, setAttemptInput] = useState("");
  const [attemptId, setAttemptId] = useState<string | undefined>();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const { state, error, loading, reload } = useWorkspaceStateInventory(
    client,
    workspaceId,
    attemptId,
  );
  const inspectAttempt = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttemptId(attemptInput.trim());
  };
  const clearAttempt = (): void => {
    setAttemptInput("");
    setAttemptId(undefined);
  };

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BrainCircuitIcon className="size-4" />}
        title="Agent Brain"
        description="Understand what agents always know, what they retrieve when relevant, and which authority owns every change."
      />
      {loading && !state ? <WorkspaceStateLoading /> : null}
      {error && !state ? (
        <LoadErrorState
          title="Couldn't load Agent Brain"
          error={error}
          onRetry={() => void reload()}
        />
      ) : null}
      {state ? (
        <div className="grid gap-4">
          {error ? (
            <LoadErrorState
              title="Couldn't refresh Agent Brain"
              error={error}
              onRetry={() => void reload()}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/30 px-3 py-2 text-xs text-fg-muted">
            <NetworkIcon className="size-3.5 text-brand" />
            Generated {formatDate(state.generatedAt)} from a read-time projection. Registry and
            onboarding mutations use explicit canonical lifecycle APIs; imported evidence never
            activates prompt authority directly.
          </div>
          <BrainOverview
            state={state}
            workspaceId={workspaceId}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          />
          <CompanyProfileInventory workspaceId={workspaceId} />
          <details
            id="brain-diagnostics"
            className="group scroll-mt-4 rounded-lg border border-border bg-surface"
            open={diagnosticsOpen}
            onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 [&::-webkit-details-marker]:hidden">
              <div>
                <h2 className="text-sm font-semibold text-fg">Advanced & diagnostics</h2>
                <p className="mt-1 text-xs leading-5 text-fg-muted">
                  Authority inventories, structured preference lifecycle controls, immutable hashes,
                  accepted-attempt drift, inactive policy drafts, and bounded structural gaps.
                </p>
              </div>
              <ChevronDownIcon className="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
            </summary>
            <div className="grid gap-4 border-t border-border p-4">
              <PolicyInventory state={state} />
              <PreferenceInventory state={state} />
              <PreferenceRegistryAdministration
                workspaceId={workspaceId}
                onWorkspaceStateReload={reload}
              />
              <OnboardingProposalInventory
                state={state}
                workspaceId={workspaceId}
                onWorkspaceStateReload={reload}
              />
              <AttemptGovernanceInventory
                state={state}
                attemptInput={attemptInput}
                onAttemptInput={setAttemptInput}
                onInspect={inspectAttempt}
                onClear={clearAttempt}
              />
              <KnowledgeInventory state={state} workspaceId={workspaceId} />
              <ExistingSources workspaceId={workspaceId} />
            </div>
          </details>
        </div>
      ) : null}
    </ContentPage>
  );
}
