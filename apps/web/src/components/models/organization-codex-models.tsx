import type {
  CodexAccount,
  CodexAccountOverview,
  ModelConnectionAccessResponse,
} from "@opengeni/sdk";
import { CheckIcon, PencilIcon, UnplugIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  CodexDeviceCodePanel,
  CodexRedemptionDialog,
  ResetCreditInventory,
  codexAccountName,
  hasResetInventory,
  planLabel,
  useCodexResetRedemption,
} from "@/components/codex-connection";
import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
} from "@/components/connection-access-settings";
import {
  ModelsFormPage,
  ProviderTile,
  RenameAccountDialog,
  organizationReachLabel,
  type ModelsScopeLabels,
  useModelsListLabel,
} from "@/components/models/models-ui";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { DeviceSignInStatus } from "@/components/subscription-device-code-panel";
import type { OrganizationCodexSubscriptions } from "@/components/organization-codex-subscriptions";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldStack } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { CODEX_EXTRA_CREDITS_DESCRIPTION, OrganizationCodexUsage } from "./codex-account-usage";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";

/* ----------------------------------------------------------------------------
   The organization's Codex accounts on the one Models page: each account's
   page (Primary, Available in, Models it can serve), its access form and the
   Connect step for everyone in the organization. The rows live on the page,
   where they merge with what this workspace uses.
   -------------------------------------------------------------------------- */

/**
 * Whether an organization account reaches a workspace, from its "Available
 * in" policy. Null while unknown (still loading, or the read failed).
 */
export function reachesWorkspace(
  access: ModelConnectionAccessResponse | null,
  workspace: { id: string; personal: boolean },
): boolean | null {
  if (!access) return null;
  const { policy, personalWorkspacesSupported } = access;
  if (workspace.personal) return personalWorkspacesSupported && policy.allowPersonalWorkspaces;
  return policy.allowedWorkspaces === null || policy.allowedWorkspaces.includes(workspace.id);
}

export interface OrgCodexPlaces {
  organizationName: string;
  openAccount: (accountId: string) => void;
  /** Opens the connect step; with an account, to sign that account in again. */
  openConnect: (reconnectAccountId?: string) => void;
  openAccess: (accountId: string) => void;
  backToList: () => void;
  /** The tags for who an account is for; its page says everyone or selected workspaces. */
  scope: ModelsScopeLabels;
}

export function OrgCodexAccountPage({
  codex,
  accountId,
  places,
}: {
  codex: OrganizationCodexSubscriptions;
  accountId: string;
  places: OrgCodexPlaces;
}) {
  const listLabel = useModelsListLabel();
  const account = codex.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = { label: listLabel, onClick: places.backToList };
  if (codex.loading) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <DetailSkeleton />
      </DetailPage>
    );
  }
  if (!account) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<UnplugIcon />}
          title="This account isn't connected"
          description="It may have been disconnected."
          action={<RowButton onClick={places.backToList}>Back to Models</RowButton>}
        />
      </DetailPage>
    );
  }
  return <OrgCodexAccountDetail codex={codex} account={account} places={places} />;
}

function OrgCodexAccountDetail({
  codex,
  account,
  places,
}: {
  codex: OrganizationCodexSubscriptions;
  account: CodexAccount;
  places: OrgCodexPlaces;
}) {
  const listLabel = useModelsListLabel();
  const [renaming, setRenaming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // Bumped after a reset is redeemed, so the usage above reads the fresh limits.
  const [usageEpoch, setUsageEpoch] = useState(0);
  const name = codexAccountName(account);
  const access = useConnectionAccess({
    client: codex.client,
    organizationId: codex.organizationId,
    kind: "codex",
    connectionId: account.id,
  });
  const reconnect = account.status !== "active";
  return (
    <DetailPage
      back={{ label: listLabel, onClick: places.backToList }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider="codex" />}
        title={name}
        chips={
          reconnect ? (
            <StatusBadge status="needs_reconnect" variant="outline" />
          ) : !account.allocatorEnabled ? (
            <StatusBadge status="paused" variant="outline" />
          ) : null
        }
        meta={[
          planLabel(account.plan, "ChatGPT"),
          account.email && account.email !== name ? account.email : null,
          organizationReachLabel(places.scope, access.data),
        ]}
        actions={
          <MoreMenu label={`More actions for ${name}`}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setDisconnecting(true)}>
              <UnplugIcon />
              Disconnect
            </DropdownMenuItem>
          </MoreMenu>
        }
      />
      <DetailPageBody>
        {reconnect ? (
          <DetailSection>
            <Notice
              tone="waiting"
              title="Sign in to ChatGPT again"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() => places.openConnect(account.id)}
                  className="rounded-[10px] pointer-coarse:h-11"
                >
                  Sign in again
                </Button>
              }
            >
              {account.lastError ?? "This account can't be used until someone signs in again."}
            </Notice>
          </DetailSection>
        ) : null}
        <DetailSection title="Usage">
          <OrganizationCodexUsage
            key={`${codex.organizationId}:${account.id}:${usageEpoch}`}
            client={codex.client}
            organizationId={codex.organizationId}
            account={account}
            onNeedsReconnect={codex.refresh}
          />
        </DetailSection>
        <DetailSection title="Settings">
          <SettingRowGroup className="-my-3">
            <SettingRow
              label="Use for new work"
              description="When off, no workspace picks this account for new chats or schedules. Work already running continues."
              control={
                <Switch
                  aria-label={`Use ${name} for new work`}
                  checked={account.allocatorEnabled}
                  pending={codex.working === `allocator:${account.id}`}
                  disabled={codex.busy}
                  onCheckedChange={(next) => void codex.setAllocator(account, next)}
                />
              }
            />
            <SettingRow
              label="Use extra credits"
              description={CODEX_EXTRA_CREDITS_DESCRIPTION}
              control={
                <Switch
                  aria-label={`Use extra credits on ${name}`}
                  checked={account.extraCreditsEnabled ?? false}
                  pending={codex.working === `extra-credits:${account.id}`}
                  disabled={codex.busy}
                  onCheckedChange={(next) => void codex.setExtraCredits(account, next)}
                />
              }
            />
            {/* A workspace's account can't be the organization primary; shown once known. */}
            {codex.accounts.length > 1 &&
            (access.data ? !access.data.managedByWorkspaceId : Boolean(access.error)) ? (
              <SettingRow
                label="Primary account"
                description="Used for new work when sharing is set to Primary only."
                control={
                  account.id === codex.activeAccountId ? (
                    <span className="inline-flex h-8 items-center gap-1.5 text-sm font-medium text-fg-muted">
                      <CheckIcon aria-hidden="true" className="size-4 text-status-idle" />
                      Primary
                    </span>
                  ) : (
                    <RowButton
                      disabled={codex.busy || reconnect}
                      onClick={() => void codex.activate(account)}
                    >
                      Make primary
                    </RowButton>
                  )
                }
              />
            ) : null}
            <ConnectionAccessRows
              access={access}
              organization
              canManage
              onEdit={() => places.openAccess(account.id)}
            />
          </SettingRowGroup>
        </DetailSection>
        <OrgCodexResets
          codex={codex}
          account={account}
          busy={codex.busy}
          onReconnect={() => places.openConnect(account.id)}
          onRedeemed={() => setUsageEpoch((epoch) => epoch + 1)}
        />
      </DetailPageBody>
      <RenameAccountDialog
        open={renaming}
        onOpenChange={setRenaming}
        name={name}
        label={account.label}
        provider="ChatGPT"
        onSave={(label) => codex.rename(account, label)}
      />
      <DestructiveConfirm
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${name}?`}
        consequences={[
          `Workspaces that use ${name} stop using it for new work.`,
          "Work already running finishes first.",
          "You'll need to sign in to ChatGPT again to reconnect it.",
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          await codex.disconnect(account);
          places.backToList();
        }}
      />
    </DetailPage>
  );
}

/**
 * An organization account's usage limit resets, on its page in Organization
 * settings: its owners and admins redeem them here, whether or not any
 * workspace uses the account. Redeeming is done by the person in their own
 * browser, never by an agent.
 */
function OrgCodexResets({
  codex,
  account,
  busy,
  onReconnect,
  onRedeemed,
}: {
  codex: OrganizationCodexSubscriptions;
  account: CodexAccount;
  busy: boolean;
  onReconnect: () => void;
  onRedeemed: () => void;
}) {
  const { client, organizationId } = codex;
  const [overview, setOverview] = useState<CodexAccountOverview | undefined>(undefined);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await client.requestJson<CodexAccountOverview>(
        "GET",
        `/v1/organizations/${encodeURIComponent(organizationId)}/codex/accounts/${encodeURIComponent(account.id)}/overview`,
      );
      if (generation.current === current) setOverview(result);
    } catch {
      // Usage above already says when the account can't be read; resets stay hidden.
      if (generation.current === current) setOverview(undefined);
    }
  }, [client, organizationId, account.id]);
  useEffect(() => {
    setOverview(undefined);
    if (account.status === "active") void load();
    return () => {
      generation.current += 1;
    };
  }, [load, account.status]);
  const afterRedemption = useCallback(async () => {
    await load();
    onRedeemed();
  }, [load, onRedeemed]);
  const resets = useCodexResetRedemption("organization", organizationId, afterRedemption);
  const attempts = resets.redemptionAttempts(account.id, overview);
  if (!overview || !hasResetInventory(overview, attempts)) return null;
  const count = overview.resetCredits.availableCount ?? 0;
  return (
    <DetailSection title={count > 0 ? `Usage limit resets (${count})` : "Usage limit resets"}>
      <ResetCreditInventory
        organization
        overview={overview}
        busy={busy || resets.preparingReset != null}
        recoveryAttempts={attempts}
        onRedeem={(credit, recovery) => void resets.beginRedemption(account.id, credit, recovery)}
        onReconnectSameAccount={onReconnect}
      />
      <CodexRedemptionDialog
        codex={{
          redemption: resets.redemption,
          now: Date.now(),
          closeRedemption: resets.closeRedemption,
          confirmRedemption: resets.confirmRedemption,
        }}
      />
    </DetailSection>
  );
}

export function OrgCodexAccessPage({
  codex,
  accountId,
  onClose,
}: {
  codex: OrganizationCodexSubscriptions;
  accountId: string;
  onClose: () => void;
}) {
  const account = codex.accounts.find((candidate) => candidate.id === accountId);
  const access = useConnectionAccess({
    client: codex.client,
    organizationId: codex.organizationId,
    kind: "codex",
    connectionId: accountId,
  });
  return (
    <ConnectionAccessFormPage
      access={access}
      organization
      canManage
      name={account ? codexAccountName(account) : "this account"}
      onClose={onClose}
    />
  );
}

export function OrgCodexConnectPage({
  codex,
  places,
  onClose,
  fields,
  blockedReason,
  onAccountConnected,
}: {
  codex: OrganizationCodexSubscriptions;
  places: OrgCodexPlaces;
  onClose: () => void;
  /** Fields above the sign-in, such as which workspaces can use the account. */
  fields?: ReactNode;
  /** Why the sign-in can't start yet (a choice above is incomplete). */
  blockedReason?: string | null;
  /** Runs once the account is connected, before its page opens, even if this page was left. */
  onAccountConnected?: ((accountId: string | null) => Promise<void> | void) | undefined;
}) {
  const [connected, setConnected] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const signingIn = Boolean(codex.pending);
  return (
    <ModelsFormPage
      title="Connect Codex"
      description={`Sign in with the ChatGPT account whose plan pays for work across ${places.organizationName}.`}
      onClose={onClose}
      submitLabel="Sign in with ChatGPT"
      pendingLabel="Opening ChatGPT…"
      // While the code waits, the step holds its own actions.
      footer={signingIn || connected ? false : undefined}
      submitDisabled={codex.busy || connected || Boolean(blockedReason)}
      disabledReason={blockedReason ?? undefined}
      onSubmit={async () => {
        if (signingIn) return false;
        await codex.connect({
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
        <DeviceSignInStatus
          provider="codex"
          connected={connected}
          panel={
            codex.pending ? (
              <CodexDeviceCodePanel
                userCode={codex.pending.userCode}
                verificationUri={codex.pending.verificationUri}
              />
            ) : null
          }
        />
      </FieldStack>
    </ModelsFormPage>
  );
}
