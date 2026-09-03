// Organization settings (formerly "Account"): identity, organization API
// keys, account-wide billing usage, plan entitlements, and members.
import { useBillingUsage } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  GaugeIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState } from "@/components/common";
import {
  OrganizationPeopleSection,
  OrganizationOverviewSection,
  OrganizationPrivateSessionsSection,
  OrganizationRetentionSection,
} from "@/components/organization-admin";
import { OrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import { OrganizationModelProviderConnection } from "@/components/organization-model-provider-connection";
import { OrganizationSettingsShell } from "@/components/settings/organization-settings-shell";
import { OrganizationRecoverySection } from "@/components/organization-recovery";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
  entitlementEntries,
  formatMoneyMicros,
  formatTimestamp,
  validTopupAmount,
} from "@/lib/format";
import { orgLabel } from "@/lib/org";
import {
  beginOrganizationAdminOperation,
  organizationAdminIdentityKey,
  organizationAdminOperationSlot,
  ownsOrganizationAdminOperation,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperationLane,
  type OrganizationAdminOperation,
  type OrganizationAdminOperationSlot,
  type OrganizationAdminSection,
} from "@/lib/organization-admin";
import { hasAccountPermission } from "@/lib/permissions";
import type {
  BillingEntitlementsResponse,
  BillingSummary,
  CompanyProfileAgentPolicy,
  CompanyProfileAgentPolicyMode,
  OrganizationMembershipRole,
  UsageEvent,
} from "@/types";
import { OrganizationKnowledgePrompt } from "./organization-knowledge-prompt";
import { useCompanyProfileInventory } from "./workspace-state-loader";

const LazyOrganizationApiKeysSection = lazy(async () => {
  const module = await import("@/components/organization-api-keys-section");
  return { default: module.OrganizationApiKeysSection };
});

const COMPANY_PROFILE_AGENT_MODE_COPY: Record<
  CompanyProfileAgentPolicyMode,
  { label: string; description: string }
> = {
  off: {
    label: "Off",
    description: "Agents cannot stage or activate organization identity changes.",
  },
  suggest: {
    label: "Require approval",
    description: "Agents prepare a proposal and the initiating owner approves each change.",
  },
  automatic: {
    label: "Autonomous",
    description:
      "Eligible proposals from an owner-initiated live chat activate without another prompt.",
  },
};

function OrganizationCompanyProfileAgentPolicy({ workspaceId }: { workspaceId: string }) {
  const client = useAppContext().client;
  const [policy, setPolicy] = useState<CompanyProfileAgentPolicy | null>(null);
  const [mode, setMode] = useState<CompanyProfileAgentPolicyMode>("suggest");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await client.getCompanyProfileAgentPolicy(workspaceId);
      setPolicy(value);
      setMode(value.mode);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (nextMode: CompanyProfileAgentPolicyMode): Promise<void> => {
    if (!policy || saving) return;
    setMode(nextMode);
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const value = await client.updateCompanyProfileAgentPolicy(workspaceId, {
        mode: nextMode,
        expectedVersion: policy.version,
        operationId: crypto.randomUUID(),
      });
      setPolicy(value);
      setMode(value.mode);
      setMessage(
        value.mode === "automatic"
          ? "Autonomous organization identity updates are enabled."
          : value.mode === "suggest"
            ? "Organization identity changes require owner approval."
            : "Agent-authored organization identity changes are off.",
      );
    } catch (saveError) {
      setMode(policy.mode);
      setError(saveError instanceof Error ? saveError : new Error(String(saveError)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="grid gap-4 border-b border-border pb-6">
      <div>
        <h3 className="text-sm font-medium text-fg">Agent-managed organization identity</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
          Choose whether agents may update the small identity and mission shared by every workspace.
          Only a live chat initiated by an active organization owner can use this authority.
        </p>
      </div>
      {error && !policy ? (
        <LoadErrorState
          title="Couldn't load agent autonomy"
          error={error}
          onRetry={() => void load()}
        />
      ) : loading || !policy ? (
        <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading agent autonomy…
        </p>
      ) : (
        <>
          <fieldset className="grid gap-2 sm:grid-cols-3" disabled={saving}>
            <legend className="sr-only">Agent-managed organization identity mode</legend>
            {(Object.keys(COMPANY_PROFILE_AGENT_MODE_COPY) as CompanyProfileAgentPolicyMode[]).map(
              (candidate) => (
                <label
                  key={candidate}
                  className="cursor-pointer rounded-md border border-border p-3 has-[:checked]:border-brand has-[:checked]:bg-brand/5"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <input
                      type="radio"
                      name="company-profile-agent-policy"
                      value={candidate}
                      checked={mode === candidate}
                      onChange={() => void save(candidate)}
                    />
                    {COMPANY_PROFILE_AGENT_MODE_COPY[candidate].label}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-fg-muted">
                    {COMPANY_PROFILE_AGENT_MODE_COPY[candidate].description}
                  </span>
                </label>
              ),
            )}
          </fieldset>
          {mode === "automatic" ? (
            <p className="rounded-md border border-status-waiting/30 bg-status-waiting/5 p-3 text-xs leading-5 text-fg-muted">
              This is organization-wide. Eligible changes still pass live-owner, stale-head, and
              compare-and-swap checks, and apply only to newly accepted agent runs.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-status-error">
              {error.message}
            </p>
          ) : null}
          {saving ? (
            <p role="status" className="text-xs text-fg-muted">
              <Loader2Icon className="mr-1 inline size-3.5 animate-spin" /> Saving autonomy mode…
            </p>
          ) : message ? (
            <p role="status" className="text-xs text-status-success">
              {message}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function OrganizationKnowledgeSummary({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useAppContext().client;
  const inventory = useCompanyProfileInventory(client, workspaceId);
  const storedProfile = inventory.response?.activeRevision?.profile ?? null;
  const profile = storedProfile?.identity || storedProfile?.mission ? storedProfile : null;
  const legacyDetailCount = storedProfile
    ? storedProfile.products.length +
      storedProfile.customers.length +
      storedProfile.goals.length +
      storedProfile.constraints.length
    : 0;

  if (inventory.loading && !inventory.response) {
    return (
      <div className="flex items-center gap-2 border-b border-border py-5 text-xs text-fg-muted">
        <Loader2Icon className="size-3.5 animate-spin" />
        Loading organization identity…
      </div>
    );
  }
  if (inventory.error && !inventory.response) {
    return (
      <LoadErrorState
        title="Couldn't load the organization identity"
        error={inventory.error}
        onRetry={() => void inventory.reload()}
      />
    );
  }
  if (!profile) {
    return (
      <div className="grid gap-3">
        <div className="rounded-lg border border-dashed border-border bg-surface-2/20 p-4 text-xs leading-5 text-fg-muted">
          {canManage
            ? "No organization identity has been saved yet. Describe who the organization is and why it exists below, and OpenGeni will prepare a concise version."
            : "No organization identity has been saved yet. An organization owner can add one."}
        </div>
        {legacyDetailCount > 0 ? (
          <p className="rounded-lg border border-status-waiting/30 bg-status-waiting/5 p-3 text-xs leading-5 text-fg-muted">
            {legacyDetailCount} historical structured detail
            {legacyDetailCount === 1 ? " is" : "s are"} still retained in agent context for
            compatibility. An owner can move that information into Company Documents before
            replacing this profile.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section className="border-b border-border pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-fg">Current organization identity</h3>
          <p className="mt-1 text-xs text-fg-muted">
            Small, stable context available to top-level agents.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={inventory.loading}
          onClick={() => void inventory.reload()}
        >
          <RefreshCwIcon className={inventory.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      </div>
      {legacyDetailCount > 0 ? (
        <p className="mt-4 rounded-lg border border-status-waiting/30 bg-status-waiting/5 p-3 text-xs leading-5 text-fg-muted">
          {legacyDetailCount} historical structured detail
          {legacyDetailCount === 1 ? " is" : "s are"} still retained in agent context for
          compatibility. Move it into Company Documents before replacing this profile.
        </p>
      ) : null}

      <div className="mt-4 grid gap-4">
        {profile.identity ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Identity
            </h4>
            <p className="mt-2 text-sm leading-6 text-fg">{profile.identity}</p>
          </div>
        ) : null}
        {profile.mission ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Mission
            </h4>
            <p className="mt-2 text-sm leading-6 text-fg">{profile.mission}</p>
          </div>
        ) : null}
      </div>
      {inventory.error ? (
        <p className="mt-3 text-xs text-status-error">Refresh failed: {inventory.error.message}</p>
      ) : null}
    </section>
  );
}

export function OrgSettingsRoute({
  workspaceId,
  checkout,
  section = "overview",
}: {
  workspaceId: string;
  checkout?: "success" | "cancelled";
  section?: OrganizationAdminSection;
}) {
  const context = useAppContext();
  const client = context.client;
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const accountId = activeWorkspace?.accountId ?? "";
  const organizationLabel = accountId
    ? orgLabel(accountId, context.accessContext.accountGrants)
    : "Organization";
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [billingOwnerKey, setBillingOwnerKey] = useState("");
  const [billingError, setBillingError] = useState<Error | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [entitlements, setEntitlements] = useState<BillingEntitlementsResponse | null>(null);
  const [entitlementsOwnerKey, setEntitlementsOwnerKey] = useState("");
  const [entitlementsError, setEntitlementsError] = useState<Error | null>(null);
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [busy, setBusy] = useState(false);
  const [busyOwnerKey, setBusyOwnerKey] = useState("");
  const canManageBilling = hasAccountPermission(context.accessContext, accountId, "billing:manage");
  const canReadBilling =
    canManageBilling || hasAccountPermission(context.accessContext, accountId, "billing:read");
  const canManageOrganizationKnowledge = hasAccountPermission(
    context.accessContext,
    accountId,
    "account:admin",
  );
  const accountGrant =
    context.accessContext.accountGrants.find((grant) => grant.accountId === accountId) ?? null;
  const canManageCompanyProfileAgentPolicy = accountGrant?.role === "owner";
  const canManageOrganizationApiKeys = hasAccountPermission(
    context.accessContext,
    accountId,
    "api_keys:manage",
  );
  const actorRole: OrganizationMembershipRole | null =
    accountGrant?.role === "owner" ||
    accountGrant?.role === "admin" ||
    accountGrant?.role === "member"
      ? accountGrant.role
      : null;
  const singleUser = context.clientConfig.productAccessMode === "local";
  const organizationAdministratorSession =
    context.clientConfig.auth.mode === "managedSession" || singleUser;
  const canManageOrganizationModels =
    organizationAdministratorSession && (actorRole === "owner" || actorRole === "admin");
  const adminIdentity = useMemo<OrganizationAdminIdentity>(
    () => ({
      principalGeneration: context.accessKeyVersion,
      subjectId: context.accessContext.subjectId,
      organizationId: accountId,
      workspaceId,
    }),
    [accountId, context.accessContext.subjectId, context.accessKeyVersion, workspaceId],
  );
  const identityKey = organizationAdminIdentityKey(adminIdentity);
  const identityRef = useRef<OrganizationAdminIdentity | null>(adminIdentity);
  identityRef.current = adminIdentity;
  const billingSequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const billingOperationRef = useRef(
    new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>(),
  );
  const claimBillingOperation = useCallback(
    (resource: "billing" | "entitlements", lane: OrganizationAdminOperationLane) => {
      const slot = organizationAdminOperationSlot(resource, lane);
      const operation = beginOrganizationAdminOperation({
        identity: adminIdentity,
        resource,
        lane,
        previousSequence: billingSequenceRef.current.get(slot) ?? 0,
      });
      billingSequenceRef.current.set(slot, operation.sequence);
      billingOperationRef.current.set(slot, operation);
      return operation;
    },
    [adminIdentity],
  );
  const ownsBillingOperation = useCallback(
    (operation: OrganizationAdminOperation) =>
      ownsOrganizationAdminOperation({
        currentIdentity: identityRef.current,
        currentOperation:
          billingOperationRef.current.get(
            organizationAdminOperationSlot(operation.resource, operation.lane),
          ) ?? null,
        accepted: operation,
      }),
    [],
  );
  useEffect(() => {
    const activeOperations = billingOperationRef.current;
    identityRef.current = adminIdentity;
    return () => {
      identityRef.current = null;
      activeOperations.clear();
    };
  }, [adminIdentity]);

  const listOrganizationApiKeys = useCallback(async () => {
    return await client.listOrganizationApiKeys(accountId);
  }, [accountId, client]);
  const createOrganizationApiKey = useCallback(
    async (request: Parameters<typeof client.createOrganizationApiKey>[1]) =>
      await client.createOrganizationApiKey(accountId, request),
    [accountId, client],
  );
  const deleteOrganizationApiKey = useCallback(
    async (apiKeyId: string) => await client.deleteOrganizationApiKey(accountId, apiKeyId),
    [accountId, client],
  );

  const refreshBilling = useCallback(async () => {
    if (!accountId || !canReadBilling) {
      setBilling(null);
      setBillingOwnerKey(identityKey);
      setBillingError(null);
      return;
    }
    const operation = claimBillingOperation("billing", "read");
    setBillingOwnerKey(identityKey);
    setBilling(null);
    setBillingLoading(true);
    try {
      const result = await client.getBilling({ accountId });
      if (!ownsBillingOperation(operation)) return;
      setBilling(result);
      setBillingError(null);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      setBilling(null);
      setBillingError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (ownsBillingOperation(operation)) setBillingLoading(false);
    }
  }, [accountId, canReadBilling, claimBillingOperation, client, identityKey, ownsBillingOperation]);

  const refreshEntitlements = useCallback(async () => {
    if (!accountId || !canReadBilling) {
      setEntitlements(null);
      setEntitlementsOwnerKey(identityKey);
      setEntitlementsError(null);
      return;
    }
    const operation = claimBillingOperation("entitlements", "read");
    setEntitlementsOwnerKey(identityKey);
    setEntitlements(null);
    try {
      const result = await client.getBillingEntitlements({ accountId });
      if (!ownsBillingOperation(operation)) return;
      setEntitlements(result);
      setEntitlementsError(null);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      setEntitlements(null);
      setEntitlementsError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [accountId, canReadBilling, claimBillingOperation, client, identityKey, ownsBillingOperation]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshBilling(), refreshEntitlements()]);
  }, [refreshBilling, refreshEntitlements]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    void refresh();
  }, [workspaceId, refresh]);

  // Confirm the Stripe checkout outcome the /billing return redirect forwarded
  // here. Credits post via the asynchronous webhook, so success is phrased as
  // "shortly" rather than implying the balance already reflects the top-up.
  useEffect(() => {
    if (checkout === "success") {
      toast.success("Payment received", {
        description: "Your credits will appear shortly.",
      });
    } else if (checkout === "cancelled") {
      toast("Checkout cancelled", { description: "No charge was made." });
    }
  }, [checkout]);

  async function startCheckout(amountUsd: number) {
    const operation = claimBillingOperation("billing", "mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const session = await client.createBillingCheckout({
        amountUsd,
        ...(accountId ? { accountId } : {}),
      });
      if (!ownsBillingOperation(operation)) return;
      window.location.assign(session.url);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      toast.error("Checkout failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (ownsBillingOperation(operation)) setBusy(false);
    }
  }

  async function openBillingPortal() {
    const operation = claimBillingOperation("billing", "mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const session = await client.createBillingPortalSession({
        ...(accountId ? { accountId } : {}),
        returnUrl: window.location.href,
      });
      if (!ownsBillingOperation(operation)) return;
      window.location.assign(session.url);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      toast.error("Couldn't open Stripe billing", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (ownsBillingOperation(operation)) setBusy(false);
    }
  }

  const visibleBilling = billingOwnerKey === identityKey ? billing : null;
  const visibleBillingError = billingOwnerKey === identityKey ? billingError : null;
  const visibleBillingLoading = billingOwnerKey === identityKey ? billingLoading : true;
  const visibleEntitlements = entitlementsOwnerKey === identityKey ? entitlements : null;
  const visibleEntitlementsError = entitlementsOwnerKey === identityKey ? entitlementsError : null;
  const visibleBusy = busyOwnerKey === identityKey && busy;

  return (
    <OrganizationSettingsShell
      workspaceId={workspaceId}
      organizationLabel={organizationLabel}
      section={section}
      showModels={canManageOrganizationModels}
    >
      <section className="grid gap-5 text-left">
        {section === "overview" ? (
          <>
            <OrganizationOverviewSection
              key={`${identityKey}:overview`}
              client={client}
              identity={adminIdentity}
              actorRole={actorRole}
              managedSession={organizationAdministratorSession}
              singleUser={singleUser}
              accessibleWorkspaceIds={new Set(context.workspaces.map((workspace) => workspace.id))}
              onOrganizationChanged={context.revalidatePrincipalAccess}
              onCreateWorkspace={async (name, operationId) => {
                if (singleUser) {
                  const created = await context.createWorkspace({ accountId, name });
                  if (!created) throw new Error("workspace creation did not complete");
                } else {
                  await client.createOrganizationWorkspace(accountId, {
                    name,
                    operationId,
                  });
                  await context.revalidatePrincipalAccess();
                }
              }}
            />
            {!singleUser ? (
              <OrganizationPrivateSessionsSection
                key={`${identityKey}:private-sessions`}
                client={client}
                identity={adminIdentity}
                actorRole={actorRole}
                managedSession
              />
            ) : null}
          </>
        ) : null}

        {section === "people" ? (
          singleUser ? (
            <p className="text-sm leading-6 text-fg-muted">
              This installation has one local administrator. People, invitations, and private user
              workspaces become available when managed sign-in is enabled.
            </p>
          ) : (
            <OrganizationPeopleSection
              key={identityKey}
              client={client}
              identity={adminIdentity}
              actorRole={actorRole}
              managedSession
              onAuthorityChanged={context.revalidatePrincipalAccess}
            />
          )
        ) : null}

        {section === "models" && canManageOrganizationModels ? (
          <div className="grid gap-6">
            <OrganizationCodexSubscriptions
              key={`${identityKey}:organization-codex`}
              organizationId={accountId}
            />
            <OrganizationModelProviderConnection
              organizationId={accountId}
              providerKind="vercel_gateway"
            />
            <OrganizationModelProviderConnection
              organizationId={accountId}
              providerKind="openrouter"
            />
          </div>
        ) : null}

        {section === "models" && !canManageOrganizationModels ? (
          <p className="text-xs leading-5 text-fg-muted">
            Organization model subscriptions can be managed only by organization owners and admins
            using an organization administrator session.
          </p>
        ) : null}

        {section === "knowledge" ? (
          <section className="grid gap-6">
            <div>
              <h2 className="text-sm font-medium">Organization identity</h2>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                A concise answer to who the organization is and why it exists. This is always
                available to top-level agents, so it should stay small and stable.
              </p>
            </div>
            <OrganizationKnowledgeSummary
              workspaceId={workspaceId}
              canManage={canManageOrganizationKnowledge}
            />
            {canManageOrganizationKnowledge ? (
              <>
                {canManageCompanyProfileAgentPolicy ? (
                  <OrganizationCompanyProfileAgentPolicy
                    key={`${identityKey}:company-profile-agent-policy`}
                    workspaceId={workspaceId}
                  />
                ) : (
                  <p className="border-b border-border pb-6 text-xs leading-5 text-fg-muted">
                    Agent-managed organization identity is owner-only. Ask an organization owner to
                    change this mode.
                  </p>
                )}
                <OrganizationKnowledgePrompt workspaceId={workspaceId} />
              </>
            ) : (
              <p className="border-b border-border pb-6 text-xs leading-5 text-fg-muted">
                Organization identity is read-only for you. An organization owner can update it.
              </p>
            )}
            <section className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
              <div className="max-w-2xl">
                <h3 className="text-sm font-medium text-fg">Organization documents</h3>
                <p className="mt-1 text-xs leading-5 text-fg-muted">
                  Products, customers, goals, constraints, strategy, and changing facts belong in
                  organization-scoped Documents. Agents retrieve them only when relevant.
                </p>
              </div>
              <Link
                to="/workspaces/$workspaceId/documents"
                params={{ workspaceId }}
                search={{ authority: "organization" }}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
              >
                Open documents
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </section>
          </section>
        ) : null}

        {section === "retention" ? (
          <OrganizationRetentionSection
            key={identityKey}
            client={client}
            identity={adminIdentity}
            actorRole={actorRole}
            managedSession={organizationAdministratorSession}
          />
        ) : null}

        {section === "recovery" ? (
          singleUser ? (
            <p className="text-sm leading-6 text-fg-muted">
              Organization recovery protects managed multi-user accounts. This single-user local
              installation is recovered through its server backup and deployment configuration.
            </p>
          ) : (
            <OrganizationRecoverySection
              key={`${identityKey}:recovery`}
              client={client}
              identity={adminIdentity}
              managedSession
            />
          )
        ) : null}

        {section === "developer" ? (
          <Suspense fallback={<Skeleton className="h-48 w-full rounded-lg" />}>
            <LazyOrganizationApiKeysSection
              key={`${identityKey}:organization-api-keys`}
              organizationId={accountId}
              canManage={canManageOrganizationApiKeys && Boolean(accountId)}
              listApiKeys={listOrganizationApiKeys}
              createApiKey={createOrganizationApiKey}
              deleteApiKey={deleteOrganizationApiKey}
            />
          </Suspense>
        ) : null}

        {section === "billing" ? (
          <section className="grid gap-4 border-b border-border pb-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Available credits
                </h2>
                <p
                  className={
                    visibleBilling
                      ? "mt-1 text-2xl font-semibold tracking-tight text-fg"
                      : "mt-2 flex items-center gap-1.5 text-xs text-fg-muted"
                  }
                >
                  {visibleBilling ? (
                    `${formatMoneyMicros(visibleBilling.balance.balanceMicros, visibleBilling.balance.currency)} available`
                  ) : !canReadBilling || !accountId ? (
                    "You don't have permission to view billing."
                  ) : visibleBillingError ? (
                    "Couldn't load your balance"
                  ) : visibleBillingLoading ? (
                    <>
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Loading balance…
                    </>
                  ) : (
                    "Billing balance unavailable"
                  )}
                </p>
                <p className="mt-1 text-xs text-fg-muted">
                  Used for organization-funded model and platform usage.
                </p>
              </div>
              <span className="rounded-full border border-border px-2 py-1 text-xs text-fg-muted">
                {visibleBilling?.mode ?? "unknown"}
              </span>
            </div>
            {visibleBillingError ? (
              <LoadErrorState
                title="Couldn't load the billing balance"
                error={visibleBillingError}
                onRetry={() => void refreshBilling()}
              />
            ) : null}
            {visibleBilling?.mode === "stripe" && canManageBilling ? (
              <div className="grid gap-2">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="grid gap-1">
                    <span className="sr-only">Credit amount</span>
                    <input
                      className="h-9 rounded-md border border-border bg-bg px-3 text-sm outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
                      type="number"
                      name="credit-amount"
                      autoComplete="off"
                      inputMode="decimal"
                      min="5"
                      max="10000"
                      step="0.01"
                      value={topupAmount}
                      onChange={(event) => setTopupAmount(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={visibleBusy || !validTopupAmount(topupAmount)}
                    onClick={() => void startCheckout(Number(topupAmount))}
                  >
                    Add credits
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[25, 100, 500, 1000].map((amount) => (
                    <Button
                      key={amount}
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={visibleBusy}
                      onClick={() => setTopupAmount(amount.toFixed(2))}
                    >
                      {formatMoneyMicros(amount * 1_000_000, "usd")}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-fg-subtle">Minimum top-up is $5.00.</p>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <p className="text-xs text-fg-muted">
                    View invoices and manage payment information in Stripe.
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={visibleBusy}
                    onClick={() => void openBillingPortal()}
                  >
                    Open Stripe billing
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-fg-subtle">
                Credit checkout is available when Stripe billing is enabled for this deployment.
              </p>
            )}
          </section>
        ) : null}

        {section === "billing" ? (
          <EntitlementsSection
            enabled={canReadBilling && Boolean(accountId)}
            entitlements={visibleEntitlements}
            error={visibleEntitlementsError}
            onRetry={() => void refreshEntitlements()}
          />
        ) : null}

        {section === "billing" ? (
          <BillingUsageSection
            key={identityKey}
            accountId={accountId}
            enabled={canReadBilling && Boolean(accountId)}
          />
        ) : null}
      </section>
    </OrganizationSettingsShell>
  );
}

/** Aggregate usage events by type for the honest at-a-glance summary. */
export function aggregateUsage(
  events: UsageEvent[],
): Array<{ eventType: string; unit: string; total: number; count: number }> {
  const byKey = new Map<
    string,
    { eventType: string; unit: string; total: number; count: number }
  >();
  for (const event of events) {
    const key = `${event.eventType}\u0000${event.unit}`;
    const entry = byKey.get(key) ?? {
      eventType: event.eventType,
      unit: event.unit,
      total: 0,
      count: 0,
    };
    entry.total += event.quantity;
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType),
  );
}

/** Plan & entitlements (/v1/billing/entitlements): the limits the org runs under. */
function EntitlementsSection(props: {
  enabled: boolean;
  entitlements: BillingEntitlementsResponse | null;
  error: Error | null;
  onRetry: () => void;
}) {
  const rows = props.entitlements ? entitlementEntries(props.entitlements.entitlements) : [];
  return (
    <section className="grid gap-4 border-b border-border pb-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <GaugeIcon className="size-3.5 text-brand" />
            Plan & entitlements
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            The limits and features this organization runs under.
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-1 text-xs text-fg-muted">
          {props.entitlements?.mode ?? "unknown"}
        </span>
      </div>

      {!props.enabled ? (
        <p className="text-xs text-fg-subtle">You don't have permission to view plan limits.</p>
      ) : props.error ? (
        <LoadErrorState
          title="Couldn't load entitlements"
          error={props.error}
          onRetry={props.onRetry}
        />
      ) : !props.entitlements ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading entitlements
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-fg-subtle">
          No entitlement limits — this deployment does not restrict the organization.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map((row) => (
            <span
              key={row.name}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg/35 px-2 py-1 text-xs"
            >
              <span className="font-medium">{row.name}</span>
              <span className="font-mono text-2xs text-fg-muted">{row.value}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageSection(props: {
  enabled: boolean;
  loading: boolean;
  error: Error | null;
  usage: UsageEvent[];
  onRefresh: () => void;
}) {
  const summary = useMemo(() => aggregateUsage(props.usage), [props.usage]);
  return (
    <section className="grid gap-4 border-b border-border pb-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <ActivityIcon className="size-3.5 text-brand" />
            Usage
          </h2>
          <p className="mt-1 text-xs text-fg-muted">Recent metered usage for this organization.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!props.enabled || props.loading}
          onClick={props.onRefresh}
        >
          <RefreshCwIcon className={props.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      </div>

      {!props.enabled ? (
        <p className="text-xs text-fg-subtle">You don't have permission to view usage.</p>
      ) : props.error && props.usage.length === 0 ? (
        // Honest failed-load state: a failed usage read must never render as
        // "No usage recorded yet." (usage already on screen keeps rendering).
        <LoadErrorState title="Couldn't load usage" error={props.error} onRetry={props.onRefresh} />
      ) : props.loading && props.usage.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading usage
        </div>
      ) : props.usage.length === 0 ? (
        <p className="text-xs text-fg-subtle">No usage recorded yet</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {summary.map((entry) => (
              <span
                key={`${entry.eventType}:${entry.unit}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg/35 px-2 py-1 text-xs"
              >
                <span className="font-medium">{entry.eventType}</span>
                <span className="font-mono text-2xs text-fg-muted">
                  {Number.isInteger(entry.total) ? entry.total : entry.total.toFixed(4)}{" "}
                  {entry.unit}
                </span>
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="border-b border-border text-fg">
                <tr>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Event</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Quantity</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Source</th>
                  <th className="whitespace-nowrap px-2 py-1.5 font-medium">Occurred</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {props.usage.slice(0, 30).map((event) => (
                  <tr key={event.id}>
                    <td className="px-2 py-1.5 text-fg-muted">{event.eventType}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-fg-muted">
                      {Number.isInteger(event.quantity)
                        ? event.quantity
                        : event.quantity.toFixed(6)}{" "}
                      {event.unit}
                    </td>
                    <td className="max-w-44 truncate px-2 py-1.5 font-mono text-2xs text-fg-subtle">
                      {event.sourceResourceType
                        ? `${event.sourceResourceType}:${event.sourceResourceId ?? ""}`
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-fg-subtle">
                      {formatTimestamp(event.occurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Remounted at route identity boundaries; the usage request itself stays account-wide. */
function BillingUsageSection(props: { accountId: string; enabled: boolean }) {
  const usage = useBillingUsage({
    ...(props.accountId ? { accountId: props.accountId } : {}),
    enabled: props.enabled,
  });
  return (
    <UsageSection
      enabled={props.enabled}
      loading={usage.loading}
      error={usage.error}
      usage={usage.usage}
      onRefresh={() => void usage.refresh()}
    />
  );
}
