import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { RowButton } from "@/components/ui/page-actions";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField } from "@/components/ui/field";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, RowList } from "@/components/ui/list-row";
import { RelativeTime } from "@/components/ui/relative-time";
import { SelectMenu } from "@/components/ui/select-menu";
import {
  SettingDangerRow,
  SettingRow,
  SettingRowGroup,
  SettingRowSkeleton,
} from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  beginOrganizationAdminOperation,
  isOrganizationConflict,
  organizationAdminIdentityKey,
  ownsOrganizationAdminOperation,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperation,
  type OrganizationAdminOperationLane,
} from "@/lib/organization-admin";
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
  switch (state) {
    case "pending_acceptance":
      return "Waiting for contacts to accept";
    case "active":
      return "Ready";
    case "degraded":
      return "Needs new contacts";
    case "disabled":
      return "Turned off";
    default:
      return "Replaced";
  }
}

function operationStateLabel(
  state: NonNullable<OrganizationRecoveryOverview["operation"]>["state"],
): string {
  switch (state) {
    case "collecting":
      return "Waiting for approvals";
    case "cooling":
      return "Waiting seven days";
    case "executed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    default:
      return "Replaced";
  }
}

function unavailableReasonCopy(reason: OrganizationRecoveryOverview["unavailableReason"]): string {
  switch (reason) {
    case "no_policy":
      return "Choose three recovery contacts to turn it on.";
    case "pending_acceptance":
      return "All three contacts have to accept before recovery works.";
    case "degraded":
      return "A contact can no longer take part. An owner has to choose new contacts.";
    case "disabled":
      return "An owner turned recovery off.";
    case "identity_unavailable":
      return "Your sign-in can't take part in recovery.";
    default:
      return "Recovery isn't set up.";
  }
}

export function OrganizationRecoverySection(props: {
  client: OpenGeniBrowserClient;
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
      <p className="text-sm text-fg-muted">
        Recovery needs managed sign-in, so it isn't available in this installation.
      </p>
    );
  }

  if (visible.error && !overview) {
    // The API deliberately conceals whether recovery exists for this account.
    // Do not infer policy state or replace authority checks with an owner-role gate.
    if (
      visible.error instanceof OpenGeniApiError &&
      visible.error.status === 404 &&
      visible.error.code === "not_found"
    ) {
      return (
        <SettingRowGroup>
          <SettingRow
            label="Recovery"
            description="Recovery isn't available for this account. Only owners can set it up."
            control={<RowButton onClick={() => void load()}>Check again</RowButton>}
          />
        </SettingRowGroup>
      );
    }
    return (
      <ErrorMessage
        variant="inline"
        title="Couldn't load organization recovery."
        action={<RowButton onClick={() => void load()}>Try again</RowButton>}
      >
        {visible.error.message}
      </ErrorMessage>
    );
  }

  if (visible.loading && !overview) return <SettingRowSkeleton />;
  if (!overview) return null;

  const accepted =
    policy?.custodians.filter((item) => item.enrollmentState === "accepted").length ?? 0;
  const busy = Boolean(visibleBusy);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <SettingRowGroup>
        <SettingRow
          label="Recovery contacts"
          description={
            policy
              ? `${policyStateLabel(policy.state)} · ${accepted} of 3 accepted. Two of them can approve making a member an owner; it happens seven days later.`
              : "Not set up. Three members who aren't owners can later approve making a member an owner."
          }
          control={
            policy ? (
              <StatusBadge status={policy.state === "active" ? "ready" : "pending_review"}>
                {policyStateLabel(policy.state)}
              </StatusBadge>
            ) : undefined
          }
        />
      </SettingRowGroup>

      {overview.availability === "recovery_unavailable" && policy ? (
        <InlineHelp icon>{unavailableReasonCopy(overview.unavailableReason)}</InlineHelp>
      ) : null}
      {!overview.recentReauthenticationAt &&
      (overview.capabilities.configure ||
        overview.capabilities.accept ||
        overview.capabilities.start ||
        overview.capabilities.approve) ? (
        <InlineHelp icon>
          Sign in again from your account menu before changing recovery. Changes are only accepted
          shortly after signing in.
        </InlineHelp>
      ) : null}

      {policy && policy.custodians.length > 0 ? (
        <RowList label="Recovery contacts" flush>
          {policy.custodians.map((custodian) => (
            <ListRow
              key={custodian.membershipId}
              title={custodian.name || custodian.email || `Contact ${custodian.ordinal}`}
              description={custodian.name && custodian.email ? custodian.email : undefined}
              meta={[
                <StatusBadge
                  key="state"
                  variant="dot"
                  status={
                    custodian.enrollmentState === "accepted"
                      ? "active"
                      : custodian.enrollmentState === "ineligible"
                        ? "unavailable"
                        : "invited"
                  }
                >
                  {custodian.enrollmentState === "accepted"
                    ? "Accepted"
                    : custodian.enrollmentState === "ineligible"
                      ? "Can't take part"
                      : "Hasn't accepted yet"}
                </StatusBadge>,
                custodian.acceptedAt ? (
                  <RelativeTime key="at" date={custodian.acceptedAt} prefix="Accepted" />
                ) : null,
              ].filter(Boolean)}
            />
          ))}
        </RowList>
      ) : null}

      {policy && overview.capabilities.accept ? (
        <SettingRowGroup>
          <SettingRow
            label="You're asked to be a recovery contact"
            description="Accepting lets you approve making a member an owner if every owner loses access."
            control={
              <Button
                type="button"
                size="sm"
                disabled={busy}
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
                    "You're a recovery contact now.",
                  )
                }
                className="pointer-coarse:h-11"
              >
                Accept
              </Button>
            }
          />
        </SettingRowGroup>
      ) : null}

      {overview.capabilities.configure ? (
        <fieldset
          className="flex min-w-0 flex-col gap-3"
          disabled={busy}
          aria-labelledby="recovery-contacts-heading"
        >
          <div className="min-w-0">
            <h3 id="recovery-contacts-heading" className="text-sm leading-5 font-medium text-fg">
              {policy ? "Choose new recovery contacts" : "Choose three recovery contacts"}
            </h3>
            <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
              Active members who aren't owners. Saving replaces the current contacts and stops any
              recovery in progress.
            </p>
          </div>
          {eligibleMembers.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Nobody can be a contact yet. Invite members who aren't owners first.
            </p>
          ) : (
            eligibleMembers.map((member) => {
              const selected = custodianIds.includes(member.membershipId);
              return (
                <CheckboxField
                  key={member.membershipId}
                  label={memberLabel(member)}
                  description={member.email ?? undefined}
                  checked={selected}
                  disabled={!selected && custodianIds.length >= 3}
                  onCheckedChange={() => toggleCustodian(member.membershipId)}
                />
              );
            })
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={custodianIds.length !== 3 || busy}
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
                  "Saved the recovery contacts.",
                )
              }
            >
              Save recovery contacts
            </Button>
            <span className="text-xs text-fg-muted tabular-nums">
              {custodianIds.length} of 3 chosen
            </span>
          </div>
        </fieldset>
      ) : null}

      {overview.capabilities.start && policy ? (
        <SettingRowGroup>
          <SettingRow
            label="Start recovery"
            description="Makes this member an owner after two contacts approve and seven days pass. Nothing else changes."
            controlWidth="select"
            control={
              <SelectMenu
                size="sm"
                aria-label="Member to make an owner"
                value={targetMembershipId || null}
                disabled={busy}
                options={eligibleMembers.map((member) => ({
                  value: member.membershipId,
                  label: memberLabel(member),
                }))}
                onValueChange={setTargetMembershipId}
                className="w-full"
              />
            }
          />
          <div className="py-3">
            <Button
              type="button"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={!targetMembershipId || busy}
              onClick={() =>
                void mutate(
                  "start",
                  () =>
                    props.client.startOrganizationRecoveryOperation(props.identity.organizationId, {
                      targetMembershipId,
                      expectedPolicyRevision: policy.revision,
                      operationId: crypto.randomUUID(),
                    }),
                  "Started recovery.",
                )
              }
            >
              Start seven-day recovery
            </Button>
          </div>
        </SettingRowGroup>
      ) : null}

      {recoveryOperation ? (
        <section aria-label="Recovery in progress" className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm leading-5 font-semibold text-fg">
                Making{" "}
                {recoveryOperation.target.name || recoveryOperation.target.email || "a member"} an
                owner
              </h3>
              <p className="mt-1 text-xs leading-4.5 text-fg-muted">
                {operationStateLabel(recoveryOperation.state)} · {recoveryOperation.approvalCount}{" "}
                of 2 approvals
                {recoveryOperation.executableAt ? (
                  <>
                    {" "}
                    · <RelativeTime date={recoveryOperation.executableAt} prefix="Can finish" />
                  </>
                ) : null}{" "}
                · <RelativeTime date={recoveryOperation.expiresAt} prefix="Expires" />
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              {overview.capabilities.approve ? (
                <Button
                  variant={overview.capabilities.execute ? "outline" : "default"}
                  type="button"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={busy}
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
                      "Recorded your approval.",
                    )
                  }
                >
                  Approve
                </Button>
              ) : null}
              {overview.capabilities.execute ? (
                <Button
                  type="button"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={busy}
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
                      "They're an owner now.",
                    )
                  }
                >
                  Make owner
                </Button>
              ) : null}
              {overview.capabilities.cancel ? (
                <Button
                  ref={cancelTriggerRef}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="pointer-coarse:h-11"
                  disabled={busy}
                  onClick={() => setConfirming("cancel")}
                >
                  Cancel recovery
                </Button>
              ) : null}
            </div>
          </div>
          {recoveryOperation.approvals.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-fg-muted">
              {recoveryOperation.approvals.map((approval) => (
                <li key={approval.membershipId}>
                  Approved by {approval.name || approval.email || "a contact"},{" "}
                  <RelativeTime date={approval.approvedAt} inSentence />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {policy && overview.capabilities.disable ? (
        <SettingDangerRow
          label="Turn off recovery"
          description="Removes the contacts and stops any recovery in progress."
          disabled={busy}
          onClick={() => setConfirming("disable")}
        />
      ) : null}

      <DestructiveConfirm
        open={confirming === "disable"}
        onOpenChange={(open) => setConfirming(open ? "disable" : null)}
        title="Turn off recovery?"
        consequences={[
          "The recovery contacts are removed.",
          "Any recovery in progress stops.",
          "Owners and workspaces don't change.",
        ]}
        confirmLabel="Turn off recovery"
        pendingLabel="Turning off…"
        onConfirm={async () => {
          if (!policy) return false;
          return await mutate(
            "disable",
            () =>
              props.client.disableOrganizationRecoveryPolicy(props.identity.organizationId, {
                expectedPolicyRevision: policy.revision,
                operationId: crypto.randomUUID(),
              }),
            "Turned off recovery.",
          );
        }}
      />
      <DestructiveConfirm
        open={confirming === "cancel"}
        onOpenChange={(open) => setConfirming(open ? "cancel" : null)}
        title="Cancel this recovery?"
        consequences={[
          "The approvals so far and the seven-day wait are discarded.",
          "Nobody becomes an owner.",
        ]}
        confirmLabel="Cancel recovery"
        pendingLabel="Cancelling…"
        restoreFocusRef={cancelTriggerRef}
        onConfirm={async () => {
          if (!recoveryOperation) return false;
          return await mutate(
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
            "Cancelled the recovery.",
          );
        }}
      />
    </div>
  );
}
