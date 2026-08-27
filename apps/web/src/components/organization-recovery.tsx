import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import {
  CheckIcon,
  ClockIcon,
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UserRoundCogIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import {
  beginOrganizationAdminOperation,
  isOrganizationConflict,
  organizationAdminIdentityKey,
  ownsOrganizationAdminOperation,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperation,
  type OrganizationAdminOperationLane,
} from "@/lib/organization-admin";
import { formatTimestamp } from "@/lib/format";
import type { OrganizationRecoveryOverview } from "@/types";

type RecoveryState = {
  ownerKey: string;
  overview: OrganizationRecoveryOverview | null;
  loading: boolean;
  error: Error | null;
};

type RecoveryAction =
  | "accept"
  | "approve"
  | "cancel"
  | "configure"
  | "disable"
  | "execute"
  | "start";

function memberLabel(
  member: Pick<
    OrganizationRecoveryOverview["eligibleMembers"][number],
    "name" | "email" | "membershipId"
  >,
): string {
  return member.name?.trim() || member.email || `Member ${member.membershipId.slice(0, 8)}`;
}

function policyStateLabel(
  state: NonNullable<OrganizationRecoveryOverview["policy"]>["state"],
): string {
  return state.replaceAll("_", " ");
}

function operationStateLabel(
  state: NonNullable<OrganizationRecoveryOverview["operation"]>["state"],
): string {
  return state.replaceAll("_", " ");
}

function unavailableReasonCopy(reason: OrganizationRecoveryOverview["unavailableReason"]): string {
  switch (reason) {
    case "no_policy":
      return "No custody policy is configured.";
    case "pending_acceptance":
      return "All three selected custodians must accept enrollment.";
    case "degraded":
      return "A custodian or stamped identity is no longer eligible. A current owner must rotate the policy.";
    case "disabled":
      return "A current owner disabled the custody policy.";
    case "identity_unavailable":
      return "The current canonical-human identity cannot participate in recovery.";
    default:
      return "Recovery has no viable policy.";
  }
}

export function OrganizationRecoverySection(props: {
  client: OpenGeniCoreClient;
  identity: OrganizationAdminIdentity;
  managedSession: boolean;
}) {
  const identityKey = organizationAdminIdentityKey(props.identity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(props.identity);
  identityRef.current = props.identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationLane, number>());
  const operationRef = useRef(
    new Map<OrganizationAdminOperationLane, OrganizationAdminOperation>(),
  );
  const [state, setState] = useState<RecoveryState>({
    ownerKey: "",
    overview: null,
    loading: false,
    error: null,
  });
  const [custodianIds, setCustodianIds] = useState<string[]>([]);
  const [targetMembershipId, setTargetMembershipId] = useState("");
  const [busyAction, setBusyAction] = useState<RecoveryAction | null>(null);
  const [busyOwnerKey, setBusyOwnerKey] = useState("");
  const [confirming, setConfirming] = useState<"cancel" | "disable" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const disableTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement | null>(null);

  const claim = useCallback(
    (lane: OrganizationAdminOperationLane) => {
      const operation = beginOrganizationAdminOperation({
        identity: props.identity,
        resource: "recovery",
        lane,
        previousSequence: sequenceRef.current.get(lane) ?? 0,
      });
      sequenceRef.current.set(lane, operation.sequence);
      operationRef.current.set(lane, operation);
      return operation;
    },
    [props.identity],
  );
  const owns = useCallback(
    (operation: OrganizationAdminOperation) =>
      ownsOrganizationAdminOperation({
        currentIdentity: identityRef.current,
        currentOperation: operationRef.current.get(operation.lane) ?? null,
        accepted: operation,
      }),
    [],
  );

  useEffect(() => {
    const activeOperations = operationRef.current;
    identityRef.current = props.identity;
    return () => {
      identityRef.current = null;
      activeOperations.clear();
    };
  }, [props.identity]);

  const load = useCallback(async () => {
    if (!props.managedSession || !props.identity.organizationId) {
      setState({
        ownerKey: identityKey,
        overview: null,
        loading: false,
        error: null,
      });
      return;
    }
    const operation = claim("read");
    setState({
      ownerKey: identityKey,
      overview: null,
      loading: true,
      error: null,
    });
    try {
      const overview = await props.client.getOrganizationRecovery(props.identity.organizationId);
      if (!owns(operation)) return;
      setState({
        ownerKey: identityKey,
        overview,
        loading: false,
        error: null,
      });
      setCustodianIds(overview.policy?.custodians.map((custodian) => custodian.membershipId) ?? []);
      setTargetMembershipId((current) =>
        overview.eligibleMembers.some((member) => member.membershipId === current)
          ? current
          : (overview.eligibleMembers[0]?.membershipId ?? ""),
      );
    } catch (error) {
      if (!owns(operation)) return;
      setState({
        ownerKey: identityKey,
        overview: null,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }, [claim, identityKey, owns, props.client, props.identity.organizationId, props.managedSession]);

  useEffect(() => {
    setBusyAction(null);
    setConfirming(null);
    setAnnouncement("");
    void load();
  }, [identityKey, load]);

  const visible =
    state.ownerKey === identityKey
      ? state
      : { ownerKey: identityKey, overview: null, loading: true, error: null };
  const visibleBusy = busyOwnerKey === identityKey ? busyAction : null;
  const overview = visible.overview;
  const policy = overview?.policy ?? null;
  const recoveryOperation = overview?.operation ?? null;
  const eligibleMembers = overview?.eligibleMembers ?? [];

  async function mutate(
    action: RecoveryAction,
    execute: () => Promise<{ overview: OrganizationRecoveryOverview }>,
    success: string,
  ): Promise<boolean> {
    if (!overview || visibleBusy) return false;
    const operation = claim("mutation");
    setBusyOwnerKey(identityKey);
    setBusyAction(action);
    try {
      const result = await execute();
      if (!owns(operation)) return false;
      setState((current) => ({
        ...current,
        ownerKey: identityKey,
        overview: result.overview,
        loading: false,
        error: null,
      }));
      setAnnouncement(success);
      toast.success(success);
      return true;
    } catch (error) {
      if (!owns(operation)) return false;
      const conflict = isOrganizationConflict(error);
      if (conflict) await load();
      toast.error(conflict ? "Recovery state changed" : "Recovery action failed", {
        description: conflict
          ? "The authoritative recovery state was refreshed. Review it and submit a new action."
          : error instanceof Error
            ? error.message
            : String(error),
      });
      return false;
    } finally {
      if (owns(operation)) setBusyAction(null);
    }
  }

  function toggleCustodian(membershipId: string) {
    setCustodianIds((current) => {
      if (current.includes(membershipId)) return current.filter((id) => id !== membershipId);
      return current.length < 3 ? [...current, membershipId] : current;
    });
  }

  if (!props.managedSession) {
    return (
      <Notice title="Recovery is unavailable" tone="muted">
        Organization recovery requires managed browser authentication and canonical human
        identities.
      </Notice>
    );
  }

  if (visible.error && !overview) {
    return (
      <LoadErrorState
        title="Couldn't load organization recovery"
        error={visible.error}
        onRetry={() => void load()}
      />
    );
  }

  if (visible.loading && !overview) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-4 text-sm text-fg-muted">
        <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
        Loading organization recovery
      </div>
    );
  }

  if (!overview) return null;

  return (
    <section aria-labelledby="organization-recovery-heading" className="grid min-w-0 gap-4">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              ref={headingRef}
              id="organization-recovery-heading"
              tabIndex={-1}
              className="flex items-center gap-1.5 text-sm font-medium"
            >
              <ShieldCheckIcon className="size-4 text-brand" />
              Recovery custody
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
              Three active non-owner members must accept custody. Any two custodians can then start
              a protected seven-day co-owner promotion.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={visible.loading || Boolean(visibleBusy)}
            onClick={() => void load()}
          >
            <RefreshCwIcon className={visible.loading ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
        </div>

        {overview.recentReauthenticationAt ? (
          <Notice tone="success" title="Recent re-authentication verified">
            Verified {formatTimestamp(overview.recentReauthenticationAt)}. Recovery mutations remain
            server-fenced to a short re-authentication window.
          </Notice>
        ) : (
          <Notice tone="waiting" title="Re-authentication required">
            Use Re-authenticate in the browser account menu, then refresh this section before
            changing recovery custody or approving an operation.
          </Notice>
        )}

        <div className="grid gap-1 text-xs text-fg-muted sm:grid-cols-3">
          <span>Policy: {policy ? policyStateLabel(policy.state) : "not configured"}</span>
          <span>
            Custodians accepted:{" "}
            {policy?.custodians.filter((item) => item.enrollmentState === "accepted").length ?? 0}
            /3
          </span>
          <span>Approval quorum: 2 distinct custodians</span>
        </div>
        {overview.availability === "recovery_unavailable" ? (
          <Notice tone="waiting" title="Recovery unavailable">
            {unavailableReasonCopy(overview.unavailableReason)}
          </Notice>
        ) : null}
        <Notice tone="muted" title="Exact promotion consequence">
          The target gains organization owner authority, including organization administration and
          billing management. Existing owners and the organization's billing history stay in place.
          No Personal content, workspace ownership, workspace grants, billing data, or organization
          identity transfers.
        </Notice>
      </section>

      {overview.capabilities.configure ? (
        <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <UserRoundCogIcon className="size-4 text-brand" />
              Choose exactly three custodians
            </h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              Saving a replacement policy supersedes the current policy and any unfinished
              operation. Existing owners and workspace ownership never change.
            </p>
          </div>
          <fieldset className="grid min-w-0 gap-2" disabled={Boolean(visibleBusy)}>
            <legend className="sr-only">Recovery custodians</legend>
            {eligibleMembers.length === 0 ? (
              <p className="text-xs text-fg-subtle">No eligible active non-owner members.</p>
            ) : (
              eligibleMembers.map((member) => {
                const selected = custodianIds.includes(member.membershipId);
                return (
                  <label
                    key={member.membershipId}
                    className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!selected && custodianIds.length >= 3}
                      onChange={() => toggleCustodian(member.membershipId)}
                      className="size-4 accent-brand"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{memberLabel(member)}</span>
                      {member.email ? (
                        <span className="block truncate text-xs text-fg-muted">{member.email}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })
            )}
          </fieldset>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-fg-muted">{custodianIds.length}/3 selected</span>
            <Button
              type="button"
              className="min-h-11 max-w-full"
              disabled={custodianIds.length !== 3 || Boolean(visibleBusy)}
              onClick={() =>
                void mutate(
                  "configure",
                  () =>
                    props.client.configureOrganizationRecoveryPolicy(
                      props.identity.organizationId,
                      {
                        custodianMembershipIds: custodianIds as [string, string, string],
                        expectedPolicyRevision: policy?.revision ?? 0,
                        operationId: crypto.randomUUID(),
                      },
                    ),
                  "Recovery custody policy saved.",
                )
              }
            >
              {visibleBusy === "configure" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CheckIcon className="size-4" />
              )}
              Save custody policy
            </Button>
          </div>
        </section>
      ) : null}

      {policy ? (
        <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">Custodian acceptance</h3>
              <p className="mt-1 text-xs text-fg-muted">Policy revision {policy.revision}</p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              {overview.capabilities.accept ? (
                <Button
                  type="button"
                  className="min-h-11 max-w-full"
                  disabled={Boolean(visibleBusy)}
                  onClick={() =>
                    void mutate(
                      "accept",
                      () =>
                        props.client.acceptOrganizationRecoveryCustody(
                          props.identity.organizationId,
                          {
                            expectedPolicyRevision: policy.revision,
                            operationId: crypto.randomUUID(),
                          },
                        ),
                      "Recovery custody accepted.",
                    )
                  }
                >
                  Accept custody
                </Button>
              ) : null}
              {overview.capabilities.disable ? (
                <Button
                  ref={disableTriggerRef}
                  type="button"
                  variant="outline"
                  className="min-h-11 max-w-full"
                  disabled={Boolean(visibleBusy)}
                  onClick={() => setConfirming("disable")}
                >
                  Disable policy
                </Button>
              ) : null}
            </div>
          </div>
          <ol className="grid gap-2 sm:grid-cols-3">
            {policy.custodians.map((custodian) => (
              <li
                key={custodian.membershipId}
                className="rounded-md border border-border p-3 text-sm"
              >
                <span className="block truncate font-medium">
                  {custodian.name || custodian.email || `Custodian ${custodian.ordinal}`}
                </span>
                <span className="mt-1 block text-xs text-fg-muted">
                  {custodian.enrollmentState.replaceAll("_", " ")}
                </span>
                {custodian.acceptedAt ? (
                  <span className="mt-1 block text-xs text-fg-subtle">
                    Accepted {formatTimestamp(custodian.acceptedAt)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {overview.capabilities.start && policy ? (
        <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <KeyRoundIcon className="size-4 text-brand" />
              Start recovery
            </h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              The target must already be an active organization member. Execution only promotes that
              member to co-owner.
            </p>
          </div>
          <label className="grid min-w-0 gap-1 text-xs font-medium">
            Target member
            <select
              value={targetMembershipId}
              disabled={Boolean(visibleBusy)}
              onChange={(event) => setTargetMembershipId(event.target.value)}
              className="min-h-11 min-w-0 rounded-md border border-input bg-bg px-3 text-sm"
            >
              {eligibleMembers.map((member) => (
                <option key={member.membershipId} value={member.membershipId}>
                  {memberLabel(member)}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            className="min-h-11 max-w-full sm:w-fit"
            disabled={!targetMembershipId || Boolean(visibleBusy)}
            onClick={() =>
              void mutate(
                "start",
                () =>
                  props.client.startOrganizationRecoveryOperation(props.identity.organizationId, {
                    targetMembershipId,
                    expectedPolicyRevision: policy.revision,
                    operationId: crypto.randomUUID(),
                  }),
                "Recovery operation started.",
              )
            }
          >
            Start seven-day recovery
          </Button>
        </section>
      ) : null}

      {recoveryOperation ? (
        <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <ClockIcon className="size-4 text-brand" />
                Current recovery operation
              </h3>
              <p className="mt-1 text-xs text-fg-muted">
                {operationStateLabel(recoveryOperation.state)} · revision{" "}
                {recoveryOperation.revision}
              </p>
            </div>
            <span className="rounded-full border border-border px-2 py-1 text-xs text-fg-muted">
              {recoveryOperation.approvalCount}/2 approvals
            </span>
          </div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-fg-subtle">Target</dt>
              <dd className="mt-0.5 font-medium">
                {recoveryOperation.target.name ||
                  recoveryOperation.target.email ||
                  recoveryOperation.target.membershipId}
              </dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Expires</dt>
              <dd className="mt-0.5 font-medium">{formatTimestamp(recoveryOperation.expiresAt)}</dd>
            </div>
            {recoveryOperation.executableAt ? (
              <div>
                <dt className="text-fg-subtle">Executable after</dt>
                <dd className="mt-0.5 font-medium">
                  {formatTimestamp(recoveryOperation.executableAt)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-fg-subtle">Notification evidence</dt>
              <dd className="mt-0.5 font-medium">
                {recoveryOperation.notificationJournaled ? "Journaled" : "Pending"}
              </dd>
            </div>
          </dl>
          {recoveryOperation.approvals.length > 0 ? (
            <ul className="grid gap-1 text-xs text-fg-muted">
              {recoveryOperation.approvals.map((approval) => (
                <li key={approval.membershipId}>
                  Approved by {approval.name || approval.email || approval.membershipId} at{" "}
                  {formatTimestamp(approval.approvedAt)}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-2">
            {overview.capabilities.approve ? (
              <Button
                type="button"
                className="min-h-11 max-w-full"
                disabled={Boolean(visibleBusy)}
                onClick={() =>
                  void mutate(
                    "approve",
                    () =>
                      props.client.approveOrganizationRecoveryOperation(
                        props.identity.organizationId,
                        recoveryOperation.id,
                        {
                          expectedOperationRevision: recoveryOperation.revision,
                          operationId: crypto.randomUUID(),
                        },
                      ),
                    "Recovery approval recorded.",
                  )
                }
              >
                Approve recovery
              </Button>
            ) : null}
            {overview.capabilities.execute ? (
              <Button
                type="button"
                className="min-h-11 max-w-full"
                disabled={Boolean(visibleBusy)}
                onClick={() =>
                  void mutate(
                    "execute",
                    () =>
                      props.client.executeOrganizationRecoveryOperation(
                        props.identity.organizationId,
                        recoveryOperation.id,
                        {
                          expectedOperationRevision: recoveryOperation.revision,
                          operationId: crypto.randomUUID(),
                        },
                      ),
                    "Target promoted to co-owner.",
                  )
                }
              >
                Execute promotion
              </Button>
            ) : null}
            {overview.capabilities.cancel ? (
              <Button
                ref={cancelTriggerRef}
                type="button"
                variant="outline"
                className="min-h-11 max-w-full"
                disabled={Boolean(visibleBusy)}
                onClick={() => setConfirming("cancel")}
              >
                Cancel recovery
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming === "disable"}
        onOpenChange={(open) => setConfirming(open ? "disable" : null)}
        title="Disable organization recovery?"
        description="This supersedes the custody policy and any unfinished recovery operation. Existing owners and workspaces are unchanged."
        confirmLabel="Disable recovery policy"
        restoreFocusRef={disableTriggerRef}
        restoreFocusFallbackRef={headingRef}
        onConfirm={() =>
          policy
            ? mutate(
                "disable",
                () =>
                  props.client.disableOrganizationRecoveryPolicy(props.identity.organizationId, {
                    expectedPolicyRevision: policy.revision,
                    operationId: crypto.randomUUID(),
                  }),
                "Recovery policy disabled.",
              )
            : false
        }
      />
      <ConfirmDialog
        open={confirming === "cancel"}
        onOpenChange={(open) => setConfirming(open ? "cancel" : null)}
        title="Cancel this recovery operation?"
        description="Collected approvals and the seven-day cooldown will be discarded. Organization ownership is unchanged."
        confirmLabel="Cancel recovery operation"
        restoreFocusRef={cancelTriggerRef}
        restoreFocusFallbackRef={headingRef}
        onConfirm={() =>
          recoveryOperation
            ? mutate(
                "cancel",
                () =>
                  props.client.cancelOrganizationRecoveryOperation(
                    props.identity.organizationId,
                    recoveryOperation.id,
                    {
                      expectedOperationRevision: recoveryOperation.revision,
                      operationId: crypto.randomUUID(),
                    },
                  ),
                "Recovery operation cancelled.",
              )
            : false
        }
      />
    </section>
  );
}
