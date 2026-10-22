/** TEST ONLY: historical Codex regression fixture, snapshot 8c43a921512078d302f671ae590d43645669f88d. Never import from production. */
import { type CodexCapacityWakeTarget, type CodexCapacitySelectionContext } from "@opengeni/db";
import { armCodexCapacityWait, listPendingCodexCapacityWakeTargets, reconcileCodexCapacityWait as reconcileCodexCapacityWaitDb } from "../../../../../packages/db/test/fixtures/legacy-codex";

import { publishDurableSessionEvents } from "@opengeni/events";





import { authoritativeCodexCapacityResetAt, codexAccountServesModel, isCodexCredentialEligible, isCodexCredentialHealthy, selectCodexCredentialLeaseForTurn } from "./rotation";

import type { ControlActivityServices } from "../../../src/activities/types";

type CodexCapacitySignalServices = {
  signalCodexCapacityWorkflow?:
    | NonNullable<ControlActivityServices["signalCodexCapacityWorkflow"]>
    | null
    | undefined;
  wakeSessionWorkflow: ControlActivityServices["wakeSessionWorkflow"];
};

export async function refreshCodexUsageAndRepairCapacityWaiters(
  refreshes: readonly (() => Promise<unknown>)[],
  repairPendingWakes: () => Promise<void>,
): Promise<void> {
  await Promise.all(refreshes.map((refresh) => refresh().catch(() => undefined)));
  await repairPendingWakes();
}

export async function signalCodexCapacityWakeTargets(
  services: CodexCapacitySignalServices,
  targets: readonly CodexCapacityWakeTarget[],
): Promise<void> {
  await Promise.allSettled(
    targets.map((target) =>
      services.signalCodexCapacityWorkflow
        ? services.signalCodexCapacityWorkflow({
            accountId: target.accountId,
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            workflowId: target.workflowId,
            wakeRevision: target.wakeRevision,
          })
        : services.wakeSessionWorkflow
          ? services.wakeSessionWorkflow({
              accountId: target.accountId,
              workspaceId: target.workspaceId,
              sessionId: target.sessionId,
              workflowId: target.workflowId,
              wakeRevision: target.workflowWakeRevision,
            })
          : Promise.resolve(),
    ),
  );
}

export async function signalPendingCodexCapacityWakeTargets(
  services: CodexCapacitySignalServices & { db: ControlActivityServices["db"] },
  workspaceId: string,
): Promise<void> {
  const targets = await listPendingCodexCapacityWakeTargets(services.db, workspaceId).catch(
    () => [],
  );
  await signalCodexCapacityWakeTargets(services, targets);
}

export function codexCapacityDecision<TPolicyScope = never, TUnavailableDiagnostic = never>(
  context: CodexCapacitySelectionContext<TPolicyScope, TUnavailableDiagnostic>,
  now = new Date(),
): ReturnType<Parameters<typeof reconcileCodexCapacityWaitDb>[2]> {
  context = {
    ...context,
    accounts: context.accounts.filter(
      (account) => !context.modelId || codexAccountServesModel(account, context.modelId, now),
    ),
  };
  const selected = selectCodexCredentialLeaseForTurn({
    context,
    sessionId: context.sessionId,
    sessionPinnedCredentialId: context.sessionPinnedCredentialId,
    sessionPinSource: context.sessionPinSource,
    sessionLastCredentialId: context.sessionLastCredentialId,
    now,
  });
  const selectedAccount = selected.credentialId
    ? context.accounts.find((account) => account.id === selected.credentialId)
    : undefined;
  const selectedIsAvailable =
    selectedAccount !== undefined &&
    (selectedAccount.id === context.existingCredentialId
      ? isCodexCredentialHealthy(selectedAccount, now)
      : isCodexCredentialEligible(selectedAccount, now));
  if (selected.credentialId && selectedIsAvailable) {
    return {
      kind: "available",
      credentialId: selected.credentialId,
      diagnostic: {
        connectedCount: context.accounts.length,
        eligibleCount: context.accounts.filter(
          (account) =>
            (account.id === selected.credentialId ||
              !context.failedCredentialIds?.includes(account.id)) &&
            isCodexCredentialEligible(account, now),
        ).length,
      },
    };
  }
  const policyCredentialId =
    context.sessionPinSource === "manual" && context.sessionPinnedCredentialId
      ? context.sessionPinnedCredentialId
      : !context.rotationEnabled
        ? context.activeCredentialId
        : null;
  const capacityAccounts = policyCredentialId
    ? context.accounts.filter((account) => account.id === policyCredentialId)
    : context.accounts;
  const authoritativeReset = authoritativeCodexCapacityResetAt(capacityAccounts, now);
  const hasReconcilableQuotaCooldown = capacityAccounts.some(
    (account) =>
      account.status === "active" &&
      account.allocatorEnabled &&
      account.exhaustedKind === "quota" &&
      account.exhaustedUntil !== null,
  );
  const policyAccount = capacityAccounts[0] ?? null;
  const mutationOnlyStatusBlock =
    (policyAccount != null &&
      (!policyAccount.allocatorEnabled || policyAccount.status !== "active")) ||
    (authoritativeReset === null &&
      capacityAccounts.length > 0 &&
      capacityAccounts.every(
        (account) => !account.allocatorEnabled || account.status !== "active",
      ));
  const noneReason =
    selected.decision.kind === "none"
      ? context.sessionPinSource === "manual" && context.sessionPinnedCredentialId !== null
        ? "manual_pin_missing"
        : !context.rotationEnabled && context.activeCredentialId === null
          ? "rotation_off_active_pointer_missing"
          : context.policyScope !== null && context.accounts.length === 0
            ? "policy_filtered_pool_empty"
            : context.accounts.length === 0
              ? "no_connected_credentials"
              : "no_eligible_credential"
      : null;
  return {
    kind: "unavailable",
    earliestResetAt: authoritativeReset,
    resetKind:
      (selected.decision.kind === "none" && !hasReconcilableQuotaCooldown && !authoritativeReset) ||
      selected.decision.kind === "allocatorDisabled" ||
      mutationOnlyStatusBlock
        ? "mutation_only"
        : authoritativeReset && !hasReconcilableQuotaCooldown
          ? "authoritative"
          : "bounded_refresh",
    diagnostic: {
      connectedCount: context.accounts.length,
      allocatorEnabledCount: context.accounts.filter((account) => account.allocatorEnabled).length,
      policyHash: context.policyHash,
      ...(noneReason ? { reason: noneReason } : {}),
    },
  };
}

export async function armAndReconcileCodexCapacityWait(
  services: Pick<ControlActivityServices, "db" | "bus">,
  input: Parameters<typeof armCodexCapacityWait>[1],
  options: { onArmed?: () => void } = {},
) {
  const armed = await armCodexCapacityWait(services.db, input);
  if (armed.action === "stopped") {
    options.onArmed?.();
    await publishDurableSessionEvents(
      services.bus,
      input.workspaceId,
      input.sessionId,
      armed.events,
    );
    return armed;
  }
  if (armed.action !== "waiting") return armed;

  options.onArmed?.();
  await publishDurableSessionEvents(services.bus, input.workspaceId, input.sessionId, armed.events);
  const evaluated = await reconcileCodexCapacityWaitDb(
    services.db,
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      waiterId: armed.waiter.id,
      generation: armed.waiter.generation,
      ...(input.now ? { now: input.now } : {}),
    },
    (context) => codexCapacityDecision(context),
  );
  await publishDurableSessionEvents(
    services.bus,
    input.workspaceId,
    input.sessionId,
    evaluated.events,
  );
  return evaluated;
}
