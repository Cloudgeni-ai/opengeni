import { SubscriptionAccountPoolRows, subscriptionListedCount } from "./subscription-account-rows";
import { SubscriptionAccountPage } from "./subscription-account-detail";
import type { SuperGrokAccount } from "@opengeni/sdk";
import { SubscriptionAccountRow, SubscriptionRotationSettingRows } from "./subscription-account-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ConnectionAccessFormPage,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import {
  ModelsFormPage,
  ProviderTile,
  type ModelsScopeLabels,
} from "@/components/models/models-ui";
import { DeviceSignInStatus } from "@/components/subscription-device-code-panel";
import {
  SuperGrokDeviceCodePanel,
  superGrokAccountName,
  type SuperGrokSubscriptions,
} from "@/components/supergrok-connection";
import { SubscriptionConnectScope } from "./subscription-connect-scope";
import { DetailSection } from "@/components/ui/detail-sheet";
import { FieldStack } from "@/components/ui/field";
import { ListRow } from "@/components/ui/list-row";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageMeterGroup, UsageReadout } from "@/components/ui/usage-meter";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

/* ----------------------------------------------------------------------------
   SuperGrok on Settings > Models, at workspace and organization scope: the
   provider group, each account's page and the Connect page. Hidden entirely
   when the deployment has SuperGrok turned off.
   -------------------------------------------------------------------------- */

export interface SuperGrokPlaces {
  /** "Local" or the organization's name: where these accounts belong. */
  scopeName: string;
  organizationName: string;
  /** Who each account is for: "Everyone in Acme", "This workspace only", "Only you". */
  scope: ModelsScopeLabels;
  openAccount: (accountId: string) => void;
  /** Opens the connect step; with an account, to sign that account in again. */
  openConnect: (reconnectAccountId?: string) => void;
  openAccess: (accountId: string) => void;
  backToList: () => void;
}

function needsReconnect(account: SuperGrokAccount): boolean {
  return account.status !== "active";
}

export function planOf(account: SuperGrokAccount): string {
  const plan = account.plan ?? account.quota?.subscriptionTier;
  return plan
    ? `SuperGrok ${plan.charAt(0).toLocaleUpperCase()}${plan.slice(1)}`
    : "SuperGrok plan";
}

export function percentLeft(account: SuperGrokAccount): number | null {
  const used = account.quota?.usedPercent;
  return typeof used === "number" ? Math.max(0, Math.min(100, Math.round(100 - used))) : null;
}

function accountStatus(account: SuperGrokAccount): "connected" | "paused" | "needs_reconnect" {
  if (needsReconnect(account)) return "needs_reconnect";
  if (!account.allocatorEnabled) return "paused";
  return "connected";
}

/**
 * The organization's own SuperGrok accounts, for people who manage them: the
 * rows show every one of them, in use here or not, and open their organization page.
 */
export interface OrganizationSuperGrokPool {
  grok: SuperGrokSubscriptions;
  workspace: { id: string; personal: boolean };
  openAccount: (accountId: string) => void;
}

/** How many rows SuperGrok adds to the Accounts list once loaded. */
export function superGrokListedCount(
  grok: SuperGrokSubscriptions,
  organization: OrganizationSuperGrokPool | null = null,
) {
  return subscriptionListedCount(
    grok,
    organization ? { ...organization, pool: organization.grok } : null,
  );
}
/** Who a SuperGrok account is for, in the one tag its row and page carry. */
function scopeOf(grok: SuperGrokSubscriptions, account: SuperGrokAccount, places: SuperGrokPlaces) {
  if (grok.inherited || grok.organizationId) return places.scope.organization;
  return account.scope === "user" ? places.scope.user : places.scope.workspace;
}

export function SuperGrokAccountRows({
  grok,
  places,
  organization = null,
}: {
  grok: SuperGrokSubscriptions;
  places: SuperGrokPlaces;
  organization?: OrganizationSuperGrokPool | null;
}) {
  return (
    <SubscriptionAccountPoolRows
      pool={grok}
      places={places}
      organization={organization ? { ...organization, pool: organization.grok } : null}
      provider="supergrok"
      kind="supergrok"
      providerName="SuperGrok"
      plan={planOf}
      renderRow={(account, onOpen, scopeLabel) => (
        <SuperGrokRow
          grok={grok}
          account={account}
          places={places}
          onOpen={onOpen}
          {...(scopeLabel ? { scopeLabel } : {})}
        />
      )}
      pendingRow={
        grok.pending ? (
          <ListRow
            leading={<ProviderTile provider="supergrok" size="lg" />}
            title="Signing in to xAI…"
            meta={["Finish signing in to add the account"]}
            indicator="open"
            onOpen={() => places.openConnect()}
          />
        ) : null
      }
    />
  );
}

/** "When several accounts are connected", once there are two SuperGrok accounts. */
export function superGrokSectionVisible(grok: SuperGrokSubscriptions): boolean {
  return !grok.unavailable && !grok.loading && grok.canManageAccounts && grok.accounts.length >= 2;
}

export function SuperGrokSettingRows({
  grok,
  label = "When several accounts are connected",
}: {
  grok: SuperGrokSubscriptions;
  label?: string;
}) {
  return (
    <SubscriptionRotationSettingRows
      label={label}
      rotationEnabled={grok.rotationEnabled}
      pending={grok.working === "rotation"}
      disabled={grok.busy && grok.working !== "rotation"}
      onChange={(enabled) => void grok.setRotation(enabled)}
    />
  );
}

export function SuperGrokRow({
  grok,
  account,
  places,
  scopeLabel,
  onOpen,
}: {
  grok: SuperGrokSubscriptions;
  account: SuperGrokAccount;
  places: SuperGrokPlaces;
  /** Overrides the tag, for an organization account whose "Available in" is known. */
  scopeLabel?: string | undefined;
  onOpen: () => void;
}) {
  const primary = grok.accounts.length > 1 && account.id === grok.activeAccountId;
  const left = percentLeft(account);
  const status = accountStatus(account);
  return (
    <SubscriptionAccountRow
      provider="supergrok"
      title={superGrokAccountName(account)}
      email={account.email}
      primary={primary}
      meta={[scopeLabel ?? scopeOf(grok, account, places), planOf(account)]}
      cells={{
        usage: needsReconnect(account) ? null : status === "paused" ? (
          <StatusBadge status="paused" variant="dot" />
        ) : (
          <UsageReadout
            percent={left}
            window="this period"
            {...(account.quota?.periodEnd
              ? { resetsLabel: formatReset(account.quota.periodEnd) }
              : {})}
          />
        ),
      }}
      indicator={needsReconnect(account) ? { kind: "attention", label: "Needs reconnect" } : "open"}
      onOpen={onOpen}
    />
  );
}

export function SuperGrokAccountPage({
  grok,
  accountId,
  places,
  client,
}: {
  grok: SuperGrokSubscriptions;
  accountId: string;
  places: SuperGrokPlaces;
  client: OpenGeniBrowserClient;
}) {
  return (
    <SubscriptionAccountPage
      pool={grok}
      accountId={accountId}
      places={places}
      client={client}
      provider="supergrok"
      providerName="xAI"
      connectionKind="supergrok"
      plan={planOf}
      renderUsage={(account) => {
        const left = percentLeft(account);
        return left === null ? null : (
          <DetailSection title="Usage">
            <UsageMeterGroup
              windows={[
                {
                  label: "This period",
                  percent: left,
                  ...(account.quota?.periodEnd
                    ? { resetsLabel: formatReset(account.quota.periodEnd) }
                    : {}),
                },
              ]}
              checked={
                account.quota?.checkedAt ? (
                  <RelativeTime date={account.quota.checkedAt} prefix="Checked" />
                ) : undefined
              }
            />
          </DetailSection>
        );
      }}
    />
  );
}

export function formatReset(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function SuperGrokAccessPage({
  grok,
  accountId,
  client,
  onClose,
}: {
  grok: SuperGrokSubscriptions;
  accountId: string;
  client: OpenGeniBrowserClient;
  onClose: () => void;
}) {
  const account = grok.accounts.find((candidate) => candidate.id === accountId);
  const access = useConnectionAccess({
    client,
    organizationId: grok.organizationId,
    workspaceId: grok.workspaceId,
    kind: "supergrok",
    connectionId: accountId,
  });
  return (
    <ConnectionAccessFormPage
      access={access}
      organization={Boolean(grok.organizationId)}
      canManage={grok.canManageAccounts}
      name={account ? superGrokAccountName(account) : "this account"}
      onClose={onClose}
    />
  );
}

export function SuperGrokConnectPage({
  grok,
  places,
  onClose,
  footerStart,
  fields,
  blockedReason,
  onAccountConnected,
}: {
  grok: SuperGrokSubscriptions;
  places: SuperGrokPlaces;
  onClose: () => void;
  footerStart?: ReactNode;
  /** Fields above the sign-in, such as which workspaces can use the account. */
  fields?: ReactNode;
  /** Why the sign-in can't start yet (a choice above is incomplete). */
  blockedReason?: string | null;
  /** Runs once the account is connected, before its page opens, even if this page was left. */
  onAccountConnected?: ((accountId: string | null) => Promise<void> | void) | undefined;
}) {
  const organization = Boolean(grok.organizationId);
  const [scope, setScope] = useState<"workspace" | "user">("workspace");
  const [connected, setConnected] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const signingIn = Boolean(grok.pending);
  return (
    <ModelsFormPage
      title="Connect SuperGrok"
      description="Sign in with the xAI account whose SuperGrok plan should pay for Grok models."
      onClose={onClose}
      submitLabel="Sign in with xAI"
      pendingLabel="Opening xAI…"
      submitAnalyticsAction="connect_supergrok"
      // While the code waits, the step holds its own actions.
      footer={signingIn || connected ? false : undefined}
      submitDisabled={!grok.canManage || grok.busy || connected || Boolean(blockedReason)}
      disabledReason={
        grok.canManage
          ? (blockedReason ?? undefined)
          : "Only people who can manage connections can add an account."
      }
      footerStart={footerStart}
      onSubmit={async () => {
        if (signingIn) return false;
        await grok.connect(scope, {
          onConnected: (accountId) =>
            void (async () => {
              await onAccountConnected?.(accountId);
              if (!active.current) return;
              setConnected(true);
              if (accountId) places.openAccount(accountId);
              else places.backToList();
            })(),
        });
        return false;
      }}
    >
      <FieldStack>
        {fields}
        {!organization ? (
          <SubscriptionConnectScope
            value={scope}
            disabled={signingIn}
            onChange={setScope}
            scopeName={places.scopeName}
          />
        ) : null}
        <DeviceSignInStatus
          provider="supergrok"
          connected={connected}
          panel={
            grok.pending ? (
              <SuperGrokDeviceCodePanel
                userCode={grok.pending.userCode}
                verificationUri={grok.pending.verificationUri}
              />
            ) : null
          }
        />
      </FieldStack>
    </ModelsFormPage>
  );
}
