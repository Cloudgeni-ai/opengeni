import {
  PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_REASON_MAX_CHARS,
  PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
} from "@opengeni/contracts";
import {
  OpenGeniApiError,
  normalizePreferenceRegistryStableKey,
  type PreferenceRegistryConflictStrategy,
  type PreferenceRegistryDetailResponse,
  type PreferenceRegistryEvent,
  type PreferenceRegistryRecord,
  type PreferenceRegistryRevisionSummary,
  type PreferenceRegistryScope,
} from "@opengeni/sdk";
import {
  CircleAlertIcon,
  FileTextIcon,
  HistoryIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { EmptyState, LoadErrorState } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";

import {
  usePreferenceRegistryDetail,
  usePreferenceRegistryInventory,
} from "./workspace-state-loader";

const fieldClass =
  "rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass =
  "rounded-md border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass =
  "rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-60";

function formatDate(value: string | null): string {
  if (!value) return "None";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase());
}

function scopeLabel(scope: PreferenceRegistryScope): string {
  switch (scope) {
    case "organization":
      return "Organization";
    case "workspace":
      return "Workspace";
    case "user":
      return "Personal";
  }
}

function normalizedConflictKeys(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map(normalizePreferenceRegistryStableKey)
        .filter(Boolean),
    ),
  ].sort();
}

function optionalDateTime(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Enter a valid expiration date and time.");
  return parsed.toISOString();
}

function localDateTime(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function registryErrorMessage(error: unknown): string {
  if (error instanceof OpenGeniApiError) {
    if (error.status === 403) {
      return "This registry action requires a direct signed-in human with authority for both the current and requested scope.";
    }
    if (error.code === "PREFERENCE_REGISTRY_STABLE_KEY_CONFLICT") {
      return "A preference with this stable key already exists in the requested scope. Choose a different stable key or scope.";
    }
    if (error.code === "PREFERENCE_REGISTRY_CONFLICT") {
      return "The preference changed in another request. Refresh the registry and selected detail before trying again.";
    }
    if (error.status === 422) {
      return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function ScopeOption({ scope, enabled }: { scope: PreferenceRegistryScope; enabled: boolean }) {
  return (
    <option value={scope} disabled={!enabled}>
      {scopeLabel(scope)}
      {enabled ? "" : " — not authorized"}
    </option>
  );
}

function ScopeAuthorityNotice({
  directHuman,
  canManageOrganization,
  canManageWorkspace,
}: {
  directHuman: boolean;
  canManageOrganization: boolean;
  canManageWorkspace: boolean;
}) {
  return (
    <div className="grid gap-2 text-xs leading-5 text-fg-muted sm:grid-cols-3">
      <div className="rounded-md border border-border bg-surface-2/30 p-3">
        <div className="font-medium text-fg">Organization</div>
        <div>
          Company-wide. Requires a matching direct human <code>account:admin</code> grant.
        </div>
        <div className={canManageOrganization ? "text-status-success" : "text-status-waiting"}>
          {canManageOrganization ? "Authorized" : "Read only"}
        </div>
      </div>
      <div className="rounded-md border border-border bg-surface-2/30 p-3">
        <div className="font-medium text-fg">Workspace</div>
        <div>Applies inside this workspace. Requires a direct human workspace admin.</div>
        <div className={canManageWorkspace ? "text-status-success" : "text-status-waiting"}>
          {canManageWorkspace ? "Authorized" : "Read only"}
        </div>
      </div>
      <div className="rounded-md border border-border bg-surface-2/30 p-3">
        <div className="font-medium text-fg">Personal</div>
        <div>Always targets the immutable signed-in subject; another user cannot be selected.</div>
        <div className={directHuman ? "text-status-success" : "text-status-waiting"}>
          {directHuman ? "Self-service" : "Direct human session required"}
        </div>
      </div>
    </div>
  );
}

function PreferenceProposalComposer({
  workspaceId,
  directHuman,
  canManageOrganization,
  canManageWorkspace,
  onCreated,
}: {
  workspaceId: string;
  directHuman: boolean;
  canManageOrganization: boolean;
  canManageWorkspace: boolean;
  onCreated: (preference: PreferenceRegistryRecord) => Promise<void>;
}) {
  const { client } = useAppContext();
  const defaultScope: PreferenceRegistryScope = canManageWorkspace ? "workspace" : "user";
  const [scope, setScope] = useState<PreferenceRegistryScope>(defaultScope);
  const [stableKey, setStableKey] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [precedenceRank, setPrecedenceRank] = useState("0");
  const [conflictStrategy, setConflictStrategy] =
    useState<PreferenceRegistryConflictStrategy>("override");
  const [conflictsWith, setConflictsWith] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdMessage, setCreatedMessage] = useState<string | null>(null);

  const canManageScope =
    directHuman &&
    (scope === "user" ||
      (scope === "workspace" && canManageWorkspace) ||
      (scope === "organization" && canManageOrganization));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canManageScope || submitting) return;
    const rank = Number(precedenceRank);
    if (!Number.isInteger(rank) || rank < -1_000 || rank > 1_000) {
      setSubmitError("Precedence rank must be a whole number from -1000 to 1000.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setCreatedMessage(null);
    try {
      const preference = await client.createPreferenceRegistryProposal(workspaceId, {
        stableKey,
        scope,
        title,
        description,
        content,
        precedenceRank: rank,
        conflictStrategy,
        conflictsWith: normalizedConflictKeys(conflictsWith),
        expiresAt: optionalDateTime(expiresAt),
        provenanceSource: "human",
        provenanceSourceId: null,
      });
      setStableKey("");
      setTitle("");
      setDescription("");
      setContent("");
      setPrecedenceRank("0");
      setConflictStrategy("override");
      setConflictsWith("");
      setExpiresAt("");
      setCreatedMessage(
        `${scopeLabel(preference.target.scope)} proposal created inactive. No prompt behavior changed.`,
      );
      await onCreated(preference);
    } catch (error) {
      setSubmitError(registryErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <details open className="rounded-md border border-border bg-surface-2/20">
      <summary className="cursor-pointer px-3 py-3 text-sm font-medium text-fg">
        Create structured preference proposal
      </summary>
      <form
        aria-label="Create structured preference proposal"
        className="grid gap-3 border-t border-border p-3"
        onSubmit={(event) => void submit(event)}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Authority scope
            <select
              className={fieldClass}
              value={scope}
              onChange={(event) => setScope(event.target.value as PreferenceRegistryScope)}
            >
              <ScopeOption scope="organization" enabled={canManageOrganization} />
              <ScopeOption scope="workspace" enabled={canManageWorkspace} />
              <ScopeOption scope="user" enabled={directHuman} />
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted md:col-span-2">
            Stable key
            <input
              className={fieldClass}
              placeholder="response.format"
              value={stableKey}
              maxLength={PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS}
              required
              onChange={(event) => setStableKey(event.target.value)}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Descriptor title
            <input
              className={fieldClass}
              value={title}
              maxLength={PREFERENCE_REGISTRY_TITLE_MAX_CHARS}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Compact descriptor
            <input
              className={fieldClass}
              value={description}
              maxLength={PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS}
              required
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>
        <label className="grid gap-1 text-xs font-medium text-fg-muted">
          Full preference content
          <textarea
            className={`${fieldClass} min-h-36 leading-6`}
            value={content}
            maxLength={PREFERENCE_REGISTRY_CONTENT_MAX_CHARS}
            required
            onChange={(event) => setContent(event.target.value)}
          />
          <span className="font-normal leading-5 text-fg-subtle">
            The browser sends this once to create an immutable revision. Agents receive only the
            compact descriptor automatically and retrieve this body on demand from an authorized
            attempt snapshot.
          </span>
        </label>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Precedence rank
            <input
              className={fieldClass}
              type="number"
              min="-1000"
              max="1000"
              step="1"
              value={precedenceRank}
              required
              onChange={(event) => setPrecedenceRank(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Conflict strategy
            <select
              className={fieldClass}
              value={conflictStrategy}
              onChange={(event) =>
                setConflictStrategy(event.target.value as PreferenceRegistryConflictStrategy)
              }
            >
              <option value="override">Override</option>
              <option value="merge">Merge</option>
              <option value="reject">Reject</option>
              <option value="inform">Inform</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Conflicts with
            <input
              className={fieldClass}
              placeholder="key.one, key.two"
              value={conflictsWith}
              onChange={(event) => setConflictsWith(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Expires at
            <input
              className={fieldClass}
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
        </div>
        <div className="rounded-md border border-status-waiting/30 bg-status-waiting/10 p-3 text-xs leading-5 text-fg-muted">
          Human-created entries still begin as inactive proposals. Documents, Memory, connectors,
          and imported evidence cannot activate this registry. Only the separately authorized
          governed-learning controller may use the automatic-activation seam.
        </div>
        {!directHuman ? (
          <div role="alert" className="text-xs text-status-waiting">
            A direct signed-in human session is required for registry changes. API keys, workers,
            services, and agent attempts are read only here.
          </div>
        ) : null}
        {submitError ? (
          <div role="alert" className="text-xs text-status-error">
            {submitError}
          </div>
        ) : null}
        {createdMessage ? (
          <div role="status" className="text-xs text-status-success">
            {createdMessage}
          </div>
        ) : null}
        <div>
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={!canManageScope || submitting}
          >
            {submitting ? "Creating proposal…" : "Create inactive proposal"}
          </button>
        </div>
      </form>
    </details>
  );
}

function PreferenceRecordButton({
  preference,
  selected,
  onSelect,
}: {
  preference: PreferenceRegistryRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`grid w-full gap-1 px-3 py-3 text-left text-xs transition-colors hover:bg-surface-2 ${
        selected ? "bg-brand/10" : ""
      }`}
      onClick={onSelect}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-all font-medium text-fg">
          {preference.activeRevision?.title ?? preference.stableKey}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5 text-fg-muted">
          {humanize(preference.status)}
        </span>
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1 text-fg-muted">
        <span>{scopeLabel(preference.target.scope)}</span>
        <span>Scope v{preference.scopeVersion}</span>
        <span>Activation v{preference.activationVersion}</span>
      </span>
      {preference.activeRevision ? (
        <span className="line-clamp-2 leading-5 text-fg-muted">
          {preference.activeRevision.description}
        </span>
      ) : (
        <span className="leading-5 text-fg-subtle">
          Inactive proposal; select to inspect its immutable revision.
        </span>
      )}
    </button>
  );
}

function RevisionMetadata({ revision }: { revision: PreferenceRegistryRevisionSummary }) {
  return (
    <div className="grid gap-2 text-xs text-fg-muted">
      <div className="font-medium text-fg">{revision.title}</div>
      <div className="leading-5">{revision.description}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>Rank {revision.precedence.rank}</span>
        <span>{humanize(revision.precedence.conflictStrategy)}</span>
        <span>Trust: {humanize(revision.provenance.trust)}</span>
        <span>Source: {humanize(revision.provenance.source)}</span>
        <span>Expires: {formatDate(revision.expiresAt)}</span>
      </div>
      {revision.provenance.sourceId ? (
        <div className="break-all">Source ID: {revision.provenance.sourceId}</div>
      ) : null}
      {revision.correctsRevisionId ? (
        <div className="break-all">Corrects revision: {revision.correctsRevisionId}</div>
      ) : null}
      {revision.precedence.conflictsWith.length ? (
        <div className="break-words">
          Conflicts with: {revision.precedence.conflictsWith.join(", ")}
        </div>
      ) : null}
      <code className="break-all text-2xs">sha256:{revision.contentHash}</code>
    </div>
  );
}

function EventRow({ event }: { event: PreferenceRegistryEvent }) {
  return (
    <li className="grid gap-1 px-3 py-3 text-xs text-fg-muted">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-fg">
          v{event.version} · {humanize(event.type)}
        </span>
        <span>{formatDate(event.createdAt)}</span>
      </div>
      <div className="leading-5 text-fg">{event.reason}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>Actor: {event.actorSubjectId}</span>
        {event.oldRevisionId ? (
          <span className="break-all">Previous revision: {event.oldRevisionId}</span>
        ) : null}
        {event.newRevisionId ? (
          <span className="break-all">New revision: {event.newRevisionId}</span>
        ) : null}
        {event.relatedPreferenceId ? (
          <span className="break-all">Related preference: {event.relatedPreferenceId}</span>
        ) : null}
      </div>
    </li>
  );
}

function PreferenceDetailPanel({
  workspaceId,
  detail,
  replacementCandidates,
  canManageScope,
  canManageOrganization,
  canManageWorkspace,
  directHuman,
  onMutated,
}: {
  workspaceId: string;
  detail: PreferenceRegistryDetailResponse;
  replacementCandidates: PreferenceRegistryRecord[];
  canManageScope: (scope: PreferenceRegistryScope) => boolean;
  canManageOrganization: boolean;
  canManageWorkspace: boolean;
  directHuman: boolean;
  onMutated: () => Promise<void>;
}) {
  const { client } = useAppContext();
  const preference = detail.preference;
  const revisions = [...detail.revisions].sort((left, right) => right.revision - left.revision);
  const latestRevision = revisions[0] ?? null;
  const activeRevision = preference.activeRevision;
  const terminal = preference.status === "rejected" || preference.status === "superseded";
  const canManageCurrent = canManageScope(preference.target.scope) && !terminal;
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [targetScope, setTargetScope] = useState<PreferenceRegistryScope>(preference.target.scope);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [correctionTitle, setCorrectionTitle] = useState(activeRevision?.title ?? "");
  const [correctionDescription, setCorrectionDescription] = useState(
    activeRevision?.description ?? "",
  );
  const [correctionContent, setCorrectionContent] = useState("");
  const [correctionRank, setCorrectionRank] = useState(
    String(activeRevision?.precedence.rank ?? 0),
  );
  const [correctionStrategy, setCorrectionStrategy] = useState<PreferenceRegistryConflictStrategy>(
    activeRevision?.precedence.conflictStrategy ?? "override",
  );
  const [correctionConflicts, setCorrectionConflicts] = useState(
    activeRevision?.precedence.conflictsWith.join(", ") ?? "",
  );
  const [correctionExpiresAt, setCorrectionExpiresAt] = useState(
    localDateTime(activeRevision?.expiresAt ?? null),
  );
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionConfirmed, setCorrectionConfirmed] = useState(false);
  const [replacementPreferenceId, setReplacementPreferenceId] = useState("");
  const effectiveReplacementPreferenceId = replacementCandidates.some(
    (candidate) => candidate.id === replacementPreferenceId,
  )
    ? replacementPreferenceId
    : (replacementCandidates[0]?.id ?? "");
  const currentlyAuthoritative = preference.status === "active" && activeRevision !== null;

  const runLifecycle = async (
    operation: string,
    action: (reason: string) => Promise<unknown>,
  ): Promise<void> => {
    if (!reason.trim()) {
      setActionError("Enter an audit reason for the lifecycle action.");
      return;
    }
    if (!confirmed) {
      setActionError("Confirm that this action applies only to newly accepted attempts.");
      return;
    }
    setBusy(operation);
    setActionError(null);
    setActionMessage(null);
    try {
      await action(reason.trim());
      setReason("");
      setConfirmed(false);
      setActionMessage(`${operation} completed and recorded in the immutable audit history.`);
      await onMutated();
    } catch (error) {
      setActionError(registryErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const correct = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!activeRevision || !canManageCurrent || busy) return;
    if (!correctionConfirmed) {
      setActionError(
        "Confirm that this correction changes authority only for newly accepted attempts.",
      );
      return;
    }
    const rank = Number(correctionRank);
    if (!Number.isInteger(rank) || rank < -1_000 || rank > 1_000) {
      setActionError("Correction precedence rank must be a whole number from -1000 to 1000.");
      return;
    }
    setBusy("Correction");
    setActionError(null);
    setActionMessage(null);
    try {
      await client.correctPreferenceRegistry(workspaceId, preference.id, {
        expectedCurrentRevisionId: activeRevision.id,
        expectedScopeVersion: preference.scopeVersion,
        title: correctionTitle,
        description: correctionDescription,
        content: correctionContent,
        precedenceRank: rank,
        conflictStrategy: correctionStrategy,
        conflictsWith: normalizedConflictKeys(correctionConflicts),
        expiresAt: optionalDateTime(correctionExpiresAt),
        reason: correctionReason,
      });
      setCorrectionContent("");
      setCorrectionReason("");
      setCorrectionConfirmed(false);
      setActionMessage("Correction created a new immutable active revision.");
      await onMutated();
    } catch (error) {
      setActionError(registryErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border bg-surface-2/20 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <SlidersHorizontalIcon className="size-4 text-brand" />
            {currentlyAuthoritative ? "Compact descriptor" : "Retained head descriptor"}
          </div>
          {activeRevision ? (
            <div className="mt-3">
              {!currentlyAuthoritative ? (
                <div className="mb-2 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-xs leading-5 text-status-waiting">
                  Retained head metadata only. This {humanize(preference.status).toLowerCase()}{" "}
                  record is excluded from current descriptor authority for newly accepted attempts.
                </div>
              ) : null}
              <RevisionMetadata revision={activeRevision} />
            </div>
          ) : latestRevision ? (
            <div className="mt-3">
              <div className="mb-2 text-xs text-status-waiting">
                This immutable revision is proposed and not included in agent descriptors.
              </div>
              <RevisionMetadata revision={latestRevision} />
            </div>
          ) : (
            <EmptyState>No immutable revision is visible for this preference.</EmptyState>
          )}
        </div>
        <div className="rounded-md border border-border bg-surface-2/20 p-3 text-xs leading-5 text-fg-muted">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <FileTextIcon className="size-4 text-brand" />
            Full content stays on demand
          </div>
          <p className="mt-3">
            Agents receive only the bounded descriptor automatically. The full body is available
            only through <code>preference_registry_get</code> after the exact accepted attempt has
            obtained a retrieval handle from <code>preference_registry_summary</code>.
          </p>
          <p className="mt-2">
            This human administration endpoint intentionally returns revision metadata, hashes,
            provenance, and audit evidence—not the stored body or an attempt retrieval handle. A
            correction therefore requires a complete replacement body.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-border p-3 text-xs">
          <div className="text-fg-subtle">Scope</div>
          <div className="mt-1 font-medium text-fg">{scopeLabel(preference.target.scope)}</div>
        </div>
        <div className="rounded-md border border-border p-3 text-xs">
          <div className="text-fg-subtle">Lifecycle</div>
          <div className="mt-1 font-medium text-fg">{humanize(preference.status)}</div>
        </div>
        <div className="rounded-md border border-border p-3 text-xs">
          <div className="text-fg-subtle">Versions</div>
          <div className="mt-1 font-medium text-fg">
            Scope v{preference.scopeVersion} · activation v{preference.activationVersion}
          </div>
        </div>
        <div className="rounded-md border border-border p-3 text-xs">
          <div className="text-fg-subtle">Stable key</div>
          <div className="mt-1 break-all font-medium text-fg">{preference.stableKey}</div>
        </div>
      </div>

      {preference.supersededByPreferenceId ? (
        <div className="rounded-md border border-border bg-surface-2/20 p-3 text-xs text-fg-muted">
          Superseded by replacement preference:{" "}
          <code className="break-all text-fg">{preference.supersededByPreferenceId}</code>
        </div>
      ) : null}

      {canManageCurrent ? (
        <div className="grid gap-3 rounded-md border border-border bg-surface-2/20 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <ShieldCheckIcon className="size-4 text-brand" />
            Lifecycle controls
          </div>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Audit reason
            <input
              className={fieldClass}
              value={reason}
              maxLength={PREFERENCE_REGISTRY_REASON_MAX_CHARS}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className="flex items-start gap-2 text-xs leading-5 text-fg-muted">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand activation, rollback, supersession, scope changes, deactivation, and
            rejection affect only newly accepted attempts; already accepted attempts retain their
            immutable snapshot.
          </label>
          <div className="flex flex-wrap gap-2">
            {activeRevision ? (
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy !== null}
                onClick={() =>
                  void runLifecycle("Deactivation", async (auditReason) => {
                    await client.deactivatePreferenceRegistry(workspaceId, preference.id, {
                      expectedCurrentRevisionId: activeRevision.id,
                      expectedScopeVersion: preference.scopeVersion,
                      reason: auditReason,
                    });
                  })
                }
              >
                Deactivate
              </button>
            ) : null}
            {preference.status === "proposed" && latestRevision ? (
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={busy !== null}
                onClick={() =>
                  void runLifecycle("Rejection", async (auditReason) => {
                    await client.rejectPreferenceRegistryProposal(workspaceId, preference.id, {
                      revisionId: latestRevision.id,
                      expectedScopeVersion: preference.scopeVersion,
                      reason: auditReason,
                    });
                  })
                }
              >
                Reject proposal
              </button>
            ) : null}
          </div>
          {preference.status === "active" && activeRevision ? (
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Active same-scope replacement
                <select
                  className={fieldClass}
                  value={effectiveReplacementPreferenceId}
                  disabled={replacementCandidates.length === 0}
                  onChange={(event) => setReplacementPreferenceId(event.target.value)}
                >
                  {replacementCandidates.length === 0 ? (
                    <option value="">No active replacement is visible</option>
                  ) : null}
                  {replacementCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.activeRevision?.title ?? candidate.stableKey} ·{" "}
                      {candidate.stableKey}
                    </option>
                  ))}
                </select>
                <span className="font-normal leading-5 text-fg-subtle">
                  Supersession records typed replacement lineage and makes this preference terminal.
                  The replacement must already be active and unexpired in the same scope.
                </span>
              </label>
              <button
                type="button"
                className={`${secondaryButtonClass} self-end`}
                disabled={busy !== null || !effectiveReplacementPreferenceId}
                onClick={() =>
                  void runLifecycle("Supersession", async (auditReason) => {
                    await client.supersedePreferenceRegistry(workspaceId, preference.id, {
                      replacementPreferenceId: effectiveReplacementPreferenceId,
                      expectedCurrentRevisionId: activeRevision.id,
                      expectedScopeVersion: preference.scopeVersion,
                      reason: auditReason,
                    });
                  })
                }
              >
                Supersede with replacement
              </button>
            </div>
          ) : null}
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Move to scope
              <select
                className={fieldClass}
                value={targetScope}
                onChange={(event) => setTargetScope(event.target.value as PreferenceRegistryScope)}
              >
                <ScopeOption scope="organization" enabled={canManageOrganization} />
                <ScopeOption scope="workspace" enabled={canManageWorkspace} />
                <ScopeOption scope="user" enabled={directHuman} />
              </select>
            </label>
            <button
              type="button"
              className={`${secondaryButtonClass} self-end`}
              disabled={
                busy !== null ||
                targetScope === preference.target.scope ||
                !canManageScope(targetScope)
              }
              onClick={() =>
                void runLifecycle("Scope change", async (auditReason) => {
                  await client.changePreferenceRegistryScope(workspaceId, preference.id, {
                    scope: targetScope,
                    expectedScopeVersion: preference.scopeVersion,
                    reason: auditReason,
                  });
                })
              }
            >
              Change scope
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-border bg-surface-2/20 p-3 text-xs leading-5 text-fg-muted">
          This record is readable, but lifecycle changes require a direct signed-in human with
          authority for its current scope. Rejected and superseded records are terminal.
        </div>
      )}

      <div className="grid gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <RotateCcwIcon className="size-4 text-brand" />
          Immutable revisions and rollback
        </div>
        <div className="divide-y divide-border rounded-md border border-border">
          {revisions.map((revision) => {
            const isRetainedHead = revision.id === activeRevision?.id;
            const isActive = isRetainedHead && preference.status === "active";
            const rollback = activeRevision !== null && revision.revision < activeRevision.revision;
            return (
              <div key={revision.id} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto]">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-fg">Revision r{revision.revision}</span>
                    {isActive ? (
                      <span className="rounded-full border border-status-success/50 px-2 py-0.5 text-status-success">
                        Active
                      </span>
                    ) : null}
                    {isRetainedHead && !isActive ? (
                      <span className="rounded-full border border-status-waiting/50 px-2 py-0.5 text-status-waiting">
                        Retained head · not current authority
                      </span>
                    ) : null}
                    {revision.correctsRevisionId ? (
                      <span className="rounded-full border border-border px-2 py-0.5 text-fg-muted">
                        Correction
                      </span>
                    ) : null}
                  </div>
                  <RevisionMetadata revision={revision} />
                </div>
                {!isRetainedHead && canManageCurrent ? (
                  <button
                    type="button"
                    className={`${secondaryButtonClass} self-start`}
                    disabled={busy !== null}
                    onClick={() =>
                      void runLifecycle(
                        rollback ? "Rollback" : "Activation",
                        async (auditReason) => {
                          await client.activatePreferenceRegistryRevision(
                            workspaceId,
                            preference.id,
                            {
                              revisionId: revision.id,
                              expectedCurrentRevisionId: activeRevision?.id ?? null,
                              expectedScopeVersion: preference.scopeVersion,
                              reason: auditReason,
                            },
                          );
                        },
                      )
                    }
                  >
                    {rollback
                      ? `Roll back to r${revision.revision}`
                      : `Activate r${revision.revision}`}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {activeRevision && canManageCurrent ? (
        <details className="rounded-md border border-border bg-surface-2/20">
          <summary className="cursor-pointer px-3 py-3 text-sm font-medium text-fg">
            Create correction revision
          </summary>
          <form
            aria-label="Correct structured preference"
            className="grid gap-3 border-t border-border p-3"
            onSubmit={(event) => void correct(event)}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Descriptor title
                <input
                  className={fieldClass}
                  value={correctionTitle}
                  maxLength={PREFERENCE_REGISTRY_TITLE_MAX_CHARS}
                  required
                  onChange={(event) => setCorrectionTitle(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Compact descriptor
                <input
                  className={fieldClass}
                  value={correctionDescription}
                  maxLength={PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS}
                  required
                  onChange={(event) => setCorrectionDescription(event.target.value)}
                />
              </label>
            </div>
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Complete replacement content
              <textarea
                className={`${fieldClass} min-h-36 leading-6`}
                value={correctionContent}
                maxLength={PREFERENCE_REGISTRY_CONTENT_MAX_CHARS}
                required
                onChange={(event) => setCorrectionContent(event.target.value)}
              />
              <span className="font-normal text-fg-subtle">
                The current body is intentionally not returned to this browser endpoint.
              </span>
            </label>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Precedence rank
                <input
                  className={fieldClass}
                  type="number"
                  min="-1000"
                  max="1000"
                  step="1"
                  value={correctionRank}
                  required
                  onChange={(event) => setCorrectionRank(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Conflict strategy
                <select
                  className={fieldClass}
                  value={correctionStrategy}
                  onChange={(event) =>
                    setCorrectionStrategy(event.target.value as PreferenceRegistryConflictStrategy)
                  }
                >
                  <option value="override">Override</option>
                  <option value="merge">Merge</option>
                  <option value="reject">Reject</option>
                  <option value="inform">Inform</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Conflicts with
                <input
                  className={fieldClass}
                  value={correctionConflicts}
                  onChange={(event) => setCorrectionConflicts(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-fg-muted">
                Expires at
                <input
                  className={fieldClass}
                  type="datetime-local"
                  value={correctionExpiresAt}
                  onChange={(event) => setCorrectionExpiresAt(event.target.value)}
                />
              </label>
            </div>
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Correction reason
              <input
                className={fieldClass}
                value={correctionReason}
                maxLength={PREFERENCE_REGISTRY_REASON_MAX_CHARS}
                required
                onChange={(event) => setCorrectionReason(event.target.value)}
              />
            </label>
            <label className="flex items-start gap-2 text-xs leading-5 text-fg-muted">
              <input
                className="mt-1"
                type="checkbox"
                checked={correctionConfirmed}
                onChange={(event) => setCorrectionConfirmed(event.target.checked)}
              />
              I understand this correction immediately activates a new immutable revision only for
              newly accepted attempts; existing attempts retain their accepted snapshot.
            </label>
            <div>
              <button type="submit" className={primaryButtonClass} disabled={busy !== null}>
                {busy === "Correction" ? "Creating correction…" : "Create and activate correction"}
              </button>
            </div>
          </form>
        </details>
      ) : null}

      {actionError ? (
        <div role="alert" className="flex items-start gap-2 text-xs text-status-error">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {actionError}
        </div>
      ) : null}
      {actionMessage ? (
        <div role="status" className="text-xs text-status-success">
          {actionMessage}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
          <HistoryIcon className="size-4 text-brand" />
          Immutable lifecycle audit
        </div>
        {detail.events.length ? (
          <ol className="divide-y divide-border rounded-md border border-border">
            {[...detail.events]
              .sort((left, right) => right.version - left.version)
              .map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
          </ol>
        ) : (
          <EmptyState>No lifecycle events are visible.</EmptyState>
        )}
      </div>
    </div>
  );
}

export function PreferenceRegistryAdministration({
  workspaceId,
  onWorkspaceStateReload,
}: {
  workspaceId: string;
  onWorkspaceStateReload: () => Promise<void>;
}) {
  const context = useAppContext();
  const { client } = context;
  const workspaceGrant = context.accessContext.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const directHuman =
    workspaceGrant?.principalKind === "human_session" || context.authSession != null;
  const canManageWorkspace =
    directHuman && hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const canManageOrganization = Boolean(
    directHuman &&
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const canManageScope = (scope: PreferenceRegistryScope): boolean =>
    directHuman &&
    (scope === "user" ||
      (scope === "workspace" && canManageWorkspace) ||
      (scope === "organization" && canManageOrganization));
  const inventory = usePreferenceRegistryInventory(client, workspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualDetailRefreshVersion, setManualDetailRefreshVersion] = useState(0);

  useEffect(() => {
    setSelectedId(null);
  }, [workspaceId]);

  useEffect(() => {
    const preferences = inventory.response?.preferences;
    if (!preferences?.length) {
      if (inventory.response) setSelectedId(null);
      return;
    }
    if (!selectedId || !preferences.some((preference) => preference.id === selectedId)) {
      setSelectedId(preferences[0]!.id);
    }
  }, [inventory.response, selectedId]);

  const detail = usePreferenceRegistryDetail(client, workspaceId, selectedId);
  const reloadAll = async (): Promise<void> => {
    await Promise.all([inventory.reload(), detail.reload(), onWorkspaceStateReload()]);
  };
  const refreshAll = async (): Promise<void> => {
    await reloadAll();
    setManualDetailRefreshVersion((version) => version + 1);
  };
  const replacementCandidates = (inventory.response?.preferences ?? []).filter(
    (candidate) =>
      candidate.id !== selectedId &&
      candidate.status === "active" &&
      candidate.activeRevision !== null &&
      candidate.target.scope === detail.response?.preference.target.scope,
  );

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Structured preference administration</h2>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-fg-muted">
            This is the dedicated organization/workspace/personal registry—not ordinary Memory.
            Descriptors, precedence, immutable revisions, provenance, and audit state are visible
            here. Documents and retrieved knowledge remain evidence or inactive proposals only.
          </p>
        </div>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={inventory.loading || detail.loading}
          onClick={() => void refreshAll()}
        >
          <RefreshCwIcon className="mr-1.5 inline size-3.5" />
          Refresh registry and detail
        </button>
      </div>

      <div className="mt-4">
        <ScopeAuthorityNotice
          directHuman={directHuman}
          canManageOrganization={canManageOrganization}
          canManageWorkspace={canManageWorkspace}
        />
      </div>

      <div className="mt-4">
        <PreferenceProposalComposer
          workspaceId={workspaceId}
          directHuman={directHuman}
          canManageOrganization={canManageOrganization}
          canManageWorkspace={canManageWorkspace}
          onCreated={async (preference) => {
            setSelectedId(preference.id);
            await Promise.all([inventory.reload(), onWorkspaceStateReload()]);
          }}
        />
      </div>

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Authorized registry records
            </h3>
            <span className="text-2xs text-fg-subtle">Up to 100 records</span>
          </div>
          {inventory.loading && !inventory.response ? (
            <Skeleton aria-label="Loading preference registry" className="h-40 w-full" />
          ) : null}
          {inventory.error && !inventory.response ? (
            <LoadErrorState
              title="Couldn't load structured preferences"
              error={inventory.error}
              onRetry={() => void inventory.reload()}
            />
          ) : null}
          {inventory.response?.preferences.length === 0 ? (
            <EmptyState>
              No structured preferences are visible in your authorized scopes.
            </EmptyState>
          ) : null}
          {inventory.response?.preferences.length ? (
            <div className="max-h-[36rem] divide-y divide-border overflow-y-auto rounded-md border border-border">
              {inventory.response.preferences.map((preference) => (
                <PreferenceRecordButton
                  key={preference.id}
                  preference={preference}
                  selected={preference.id === selectedId}
                  onSelect={() => setSelectedId(preference.id)}
                />
              ))}
            </div>
          ) : null}
          {inventory.error && inventory.response ? (
            <p className="mt-2 text-xs text-status-error">
              Refresh failed: {inventory.error.message}
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Selected preference
          </h3>
          {!selectedId ? <EmptyState>Select a registry record to inspect it.</EmptyState> : null}
          {selectedId && detail.loading && !detail.response ? (
            <Skeleton aria-label="Loading preference detail" className="h-64 w-full" />
          ) : null}
          {selectedId && detail.error && !detail.response ? (
            <LoadErrorState
              title="Couldn't load preference detail"
              error={detail.error}
              onRetry={() => void detail.reload()}
            />
          ) : null}
          {detail.response ? (
            <PreferenceDetailPanel
              key={`${detail.response.preference.id}:${detail.response.preference.status}:${detail.response.preference.activeRevision?.id ?? "none"}:${detail.response.preference.scopeVersion}:${detail.response.preference.activationVersion}:${manualDetailRefreshVersion}`}
              workspaceId={workspaceId}
              detail={detail.response}
              replacementCandidates={replacementCandidates}
              canManageScope={canManageScope}
              canManageOrganization={canManageOrganization}
              canManageWorkspace={canManageWorkspace}
              directHuman={directHuman}
              onMutated={reloadAll}
            />
          ) : null}
          {detail.error && detail.response ? (
            <p className="mt-2 text-xs text-status-error">Refresh failed: {detail.error.message}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
