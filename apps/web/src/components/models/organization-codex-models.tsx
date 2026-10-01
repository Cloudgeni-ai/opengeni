import type { CodexAccount, ModelConnectionAccessResponse } from "@opengeni/sdk";
import { CheckIcon, PencilIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CodexDeviceCodePanel, codexAccountName, planLabel } from "@/components/codex-connection";
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
  usage,
  resets,
}: {
  codex: OrganizationCodexSubscriptions;
  accountId: string;
  places: OrgCodexPlaces;
  /** This account's usage, while the workspace the page is open in uses it. */
  usage?: ReactNode;
  /** Its usage limit resets, which only an account owned by a workspace can redeem. */
  resets?: ReactNode;
}) {
  const account = codex.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = { label: "Models", onClick: places.backToList };
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
  return (
    <OrgCodexAccountDetail
      codex={codex}
      account={account}
      places={places}
      usage={usage}
      resets={resets}
    />
  );
}

function OrgCodexAccountDetail({
  codex,
  account,
  places,
  usage,
  resets,
}: {
  codex: OrganizationCodexSubscriptions;
  account: CodexAccount;
  places: OrgCodexPlaces;
  usage: ReactNode;
  resets: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
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
      back={{ label: "Models", onClick: places.backToList }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider="codex" />}
        title={name}
        chips={reconnect ? <StatusBadge status="needs_reconnect" variant="outline" /> : null}
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
        {usage ? <DetailSection title="Usage">{usage}</DetailSection> : null}
        <DetailSection title="Settings">
          <SettingRowGroup className="-my-3">
            {codex.accounts.length > 1 ? (
              <SettingRow
                label="Primary account"
                description={
                  account.id === codex.activeAccountId
                    ? `New work across ${places.organizationName} starts here.`
                    : "Make this the account new work starts with."
                }
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
        {resets ? <DetailSection title="Usage limit resets">{resets}</DetailSection> : null}
        {usage ? null : (
          <DetailSection>
            <p className="text-xs leading-4.5 text-fg-muted">
              Usage shows on the Models page of each workspace that uses this account.
            </p>
          </DetailSection>
        )}
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
