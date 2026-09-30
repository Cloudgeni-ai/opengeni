import type { CodexAccount } from "@opengeni/sdk";
import {
  CheckIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  ProviderAccessPage,
  ProviderConnectPage,
  ProviderConnectionPage,
  ProviderConnectionRow,
  providerListed,
  type ProviderConnection,
} from "@/components/ai-gateway-connection";
import { CodexDeviceCodePanel, codexAccountName, planLabel } from "@/components/codex-connection";
import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
  workspacesSummary,
} from "@/components/connection-access-settings";
import { ACCOUNT_COLUMNS } from "@/components/models/codex-models";
import {
  ModelsFormPage,
  ProviderTile,
  RenameAccountDialog,
  useModelsNavigation,
} from "@/components/models/models-ui";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import {
  SuperGrokAccessPage,
  SuperGrokAccountPage,
  SuperGrokAccountRows,
  SuperGrokConnectPage,
  SuperGrokSettingRows,
  superGrokListedCount,
  superGrokSectionVisible,
  type SuperGrokPlaces,
} from "@/components/models/supergrok-models";
import { ConnectPickerPage } from "@/components/models/workspace-models-page";
import {
  useOrganizationCodexSubscriptions,
  type OrganizationCodexSubscriptions,
} from "@/components/organization-codex-subscriptions";
import { useOrganizationProviderConnection } from "@/components/organization-model-provider-connection";
import { useSuperGrokSubscriptions } from "@/components/supergrok-connection";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSection, DetailSkeleton } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { FieldStack } from "@/components/ui/field";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { accountKeyOf, type ModelsView } from "@/lib/models-route";
import type { ReturnTo } from "@/lib/return-to";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";

/* ----------------------------------------------------------------------------
   Organization settings > Models: one flat list of the subscriptions and API
   keys the organization shares, then each provider's settings. Same rows,
   account pages and forms as a workspace's Models page.
   -------------------------------------------------------------------------- */

export function OrganizationModelsPage({
  workspaceId,
  organizationId,
  organizationName,
  account,
  view,
  returnTo,
}: {
  workspaceId: string;
  organizationId: string;
  organizationName: string;
  account: string | undefined;
  view: ModelsView | undefined;
  /** Where a cross-scope link came from (a workspace's Models); Back returns there. */
  returnTo?: ReturnTo | undefined;
}) {
  const client = useAppContext().client;
  const nav = useModelsNavigation(
    useMemo(() => ({ kind: "organization" as const, workspaceId }), [workspaceId]),
    { account, view, returnTo },
  );
  const codex = useOrganizationCodexSubscriptions({ client, organizationId });
  const grok = useSuperGrokSubscriptions({ client, organizationId, canManage: true });
  const vercel = useOrganizationProviderConnection({
    client,
    organizationId,
    providerKind: "vercel_gateway",
  });
  const openrouter = useOrganizationProviderConnection({
    client,
    organizationId,
    providerKind: "openrouter",
  });
  const anthropic = useOrganizationProviderConnection({
    client,
    organizationId,
    providerKind: "anthropic",
  });
  const claude_subscription = useOrganizationProviderConnection({
    client,
    organizationId,
    providerKind: "claude_subscription",
  });
  const gateways = { vercel, openrouter, anthropic, claude_subscription };

  const backToList = () => nav.openAccount(undefined);
  const codexPlaces: OrgCodexPlaces = {
    organizationName,
    openAccount: (id) => nav.openAccount(`codex:${id}`),
    openConnect: () => nav.openView("connect:codex"),
    openAccess: (id) => nav.openView("model-access", `codex:${id}`),
    backToList,
    back: nav.returnTo
      ? { label: nav.returnTo.label, onClick: () => nav.goBack(nav.returnTo!) }
      : { label: "Models", onClick: backToList },
  };
  const grokPlaces: SuperGrokPlaces = {
    scopeName: organizationName,
    organizationName,
    openAccount: (id) => nav.openAccount(`supergrok:${id}`),
    openConnect: () => nav.openView("connect:supergrok"),
    openAccess: (id) => nav.openView("model-access", `supergrok:${id}`),
    backToList,
  };

  const key = accountKeyOf(account);
  let page: ReactNode;
  if (view === "connect") {
    page = (
      <ConnectPickerPage
        codexAvailable
        grok={grok.unavailable ? "not_enabled" : "available"}
        gateways={gateways}
        scopeName={`${organizationName}'s shared workspaces`}
        onClose={backToList}
        onPick={(provider) => nav.openView(`connect:${provider}`)}
        onOpenConnected={(provider) => nav.openAccount(`gateway:${provider}`)}
      />
    );
  } else if (view === "connect:codex") {
    page = <OrgCodexConnectPage codex={codex} places={codexPlaces} onClose={backToList} />;
  } else if (view === "connect:supergrok") {
    page = <SuperGrokConnectPage grok={grok} places={grokPlaces} onClose={backToList} />;
  } else if (
    view === "connect:vercel" ||
    view === "connect:openrouter" ||
    view === "connect:anthropic" ||
    view === "connect:claude_subscription"
  ) {
    const id = view.slice("connect:".length) as keyof typeof gateways;
    page = (
      <ProviderConnectPage
        state={gateways[id]}
        onClose={backToList}
        onConnected={() => nav.openAccount(`gateway:${id}`)}
      />
    );
  } else if (view === "model-access" && key) {
    const back = () => nav.openAccount(account);
    page =
      key.provider === "codex" ? (
        <OrgCodexAccessPage codex={codex} accountId={key.id} onClose={back} />
      ) : key.provider === "supergrok" ? (
        <SuperGrokAccessPage grok={grok} accountId={key.id} client={client} onClose={back} />
      ) : (
        <ProviderAccessPage state={gateways[key.id as "vercel" | "openrouter"]} onClose={back} />
      );
  } else if (key?.provider === "codex") {
    page = <OrgCodexAccountPage codex={codex} accountId={key.id} places={codexPlaces} />;
  } else if (key?.provider === "supergrok") {
    page = (
      <SuperGrokAccountPage grok={grok} accountId={key.id} places={grokPlaces} client={client} />
    );
  } else if (key?.provider === "gateway") {
    page = (
      <ProviderConnectionPage
        state={gateways[key.id]}
        scopeName={organizationName}
        onBack={backToList}
        onConnect={() => nav.openView(`connect:${key.id}`)}
        onEditAccess={() => nav.openView("model-access", account)}
      />
    );
  } else {
    const loadingAccounts =
      codex.loading ||
      (!grok.unavailable && grok.loading) ||
      (["openrouter", "vercel", "anthropic", "claude_subscription"] as const).some(
        (id) => !gateways[id].settled,
      );
    const listed =
      (codex.loading ? 0 : codex.loadError || codex.pending ? 1 : codex.accounts.length) +
      superGrokListedCount(grok) +
      (["openrouter", "vercel", "anthropic", "claude_subscription"] as const).filter((id) =>
        providerListed(gateways[id]),
      ).length;
    const empty = !loadingAccounts && listed === 0;
    const connect = (
      <RowButton onClick={() => nav.openView("connect")}>
        <PlusIcon aria-hidden="true" />
        Connect account
      </RowButton>
    );
    page = (
      <SectionStack>
        <Section
          title="Accounts"
          description="Shared with the organization's workspaces. Each workspace chooses whether to use them or its own."
          action={empty ? null : connect}
        >
          {empty ? (
            <EmptyState
              variant="page"
              icon={<KeyRoundIcon />}
              title="No shared accounts"
              description="Connect a subscription or an API key to share it with your workspaces."
              action={connect}
              className="pt-8 pb-6"
            />
          ) : (
            <RowList label="Shared accounts" columns={ACCOUNT_COLUMNS} flush>
              <OrgCodexRows codex={codex} places={codexPlaces} />
              <SuperGrokAccountRows grok={grok} places={grokPlaces} />
              {(["openrouter", "vercel", "anthropic", "claude_subscription"] as const)
                .filter((id) => providerListed(gateways[id]))
                .map((id) => (
                  <ProviderConnectionRow
                    key={id}
                    state={gateways[id]}
                    onOpen={() => nav.openAccount(`gateway:${id}`)}
                  />
                ))}
            </RowList>
          )}
        </Section>
        {!codex.loading && codex.accounts.length >= 2 ? (
          <Section title="Codex">
            <SettingRowGroup>
              <SettingRow
                label="When several accounts are connected"
                description="Spread work sends new work to the account with the most room left. Primary only waits for the primary account."
                controlWidth="auto"
                control={
                  <SegmentedControl<"spread" | "primary">
                    size="sm"
                    pending={codex.working === "rotation"}
                    disabled={codex.busy && codex.working !== "rotation"}
                    value={codex.rotationEnabled ? "spread" : "primary"}
                    onValueChange={(value) => void codex.setRotation(value === "spread")}
                    options={[
                      { value: "spread", label: "Spread work" },
                      { value: "primary", label: "Primary only" },
                    ]}
                  />
                }
              />
            </SettingRowGroup>
          </Section>
        ) : null}
        {superGrokSectionVisible(grok) ? (
          <Section title="SuperGrok">
            <SuperGrokSettingRows grok={grok} />
          </Section>
        ) : null}
      </SectionStack>
    );
  }
  const root = useRef<HTMLDivElement>(null);
  const pageKey = `${view ?? ""}|${account ?? ""}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = root.current?.querySelector<HTMLElement>("h1");
    if (heading && pageKey !== "|") {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }, [pageKey]);
  return (
    <div ref={root} className="min-w-0">
      {page}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The organization's Codex accounts.
   -------------------------------------------------------------------------- */

interface OrgCodexPlaces {
  organizationName: string;
  openAccount: (accountId: string) => void;
  openConnect: () => void;
  openAccess: (accountId: string) => void;
  backToList: () => void;
  /** The account page's back link: "Models", or the page a cross-scope link came from. */
  back: { label: string; onClick: () => void };
}

function OrgCodexRows({
  codex,
  places,
}: {
  codex: OrganizationCodexSubscriptions;
  places: OrgCodexPlaces;
}) {
  if (codex.loading) return <ListRowSkeleton count={1} />;
  if (codex.loadError) {
    return (
      <li className="col-span-full list-none px-3 py-3">
        <ErrorMessage
          variant="inline"
          title="Couldn't load the organization's Codex accounts."
          action={<RowButton onClick={() => void codex.refresh()}>Try again</RowButton>}
        >
          {codex.loadError}
        </ErrorMessage>
      </li>
    );
  }
  return (
    <>
      {codex.accounts.map((account) => (
        <OrgCodexRow
          key={account.id}
          codex={codex}
          account={account}
          onOpen={() => places.openAccount(account.id)}
        />
      ))}
      {codex.pending ? (
        <ListRow
          leading={<ProviderTile provider="codex" size="lg" />}
          title="Signing in to ChatGPT…"
          meta={["Finish signing in to add the account"]}
          indicator="open"
          onOpen={places.openConnect}
        />
      ) : null}
    </>
  );
}

function OrgCodexRow({
  codex,
  account,
  onOpen,
}: {
  codex: OrganizationCodexSubscriptions;
  account: CodexAccount;
  onOpen: () => void;
}) {
  const access = useConnectionAccess({
    client: codex.client,
    organizationId: codex.organizationId,
    kind: "codex",
    connectionId: account.id,
  });
  const primary = codex.accounts.length > 1 && account.id === codex.activeAccountId;
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title={codexAccountName(account)}
      titleAddon={primary ? <MetaChip variant="outline">Primary</MetaChip> : null}
      meta={[
        planLabel(account.plan, "ChatGPT"),
        access.data
          ? `Available in ${workspacesSummary(access.data.policy, access.data.personalWorkspacesSupported).replace(/^All/, "all")}`
          : null,
      ]}
      indicator={
        account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
      }
      onOpen={onOpen}
    />
  );
}

function OrgCodexAccountPage({
  codex,
  accountId,
  places,
}: {
  codex: OrganizationCodexSubscriptions;
  accountId: string;
  places: OrgCodexPlaces;
}) {
  const account = codex.accounts.find((candidate) => candidate.id === accountId) ?? null;
  const back = places.back;
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
    <DetailPage back={places.back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<ProviderTile provider="codex" />}
        title={name}
        chips={reconnect ? <StatusBadge status="needs_reconnect" variant="outline" /> : null}
        meta={[
          planLabel(account.plan, "ChatGPT"),
          account.email && account.email !== name ? account.email : null,
          "Organization account",
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
                  variant="outline"
                  onClick={places.openConnect}
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
        <DetailSection title="Settings">
          <SettingRowGroup className="-my-3">
            {codex.accounts.length > 1 ? (
              <SettingRow
                label="Primary account"
                description={
                  account.id === codex.activeAccountId
                    ? "New work in workspaces that use the organization's accounts starts here."
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
        <DetailSection>
          <p className="text-xs leading-4.5 text-fg-muted">
            Usage shows on the Models page of each workspace that uses this account.
          </p>
        </DetailSection>
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

function OrgCodexAccessPage({
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

function OrgCodexConnectPage({
  codex,
  places,
  onClose,
}: {
  codex: OrganizationCodexSubscriptions;
  places: OrgCodexPlaces;
  onClose: () => void;
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
      description={`Sign in with the ChatGPT account whose plan ${places.organizationName} shares with its workspaces.`}
      onClose={onClose}
      submitLabel={signingIn ? "Open ChatGPT again" : "Sign in with ChatGPT"}
      pendingLabel="Opening ChatGPT…"
      submitDisabled={codex.busy || connected}
      onSubmit={async () => {
        if (signingIn && codex.pending) {
          window.open(codex.pending.verificationUri, "_blank", "noopener,noreferrer");
          return false;
        }
        await codex.connect({
          onConnected: (accountId) => {
            if (!active.current) return;
            setConnected(true);
            if (accountId) places.openAccount(accountId);
            else places.backToList();
          },
        });
        return false;
      }}
    >
      <FieldStack>
        <p className="text-sm text-fg-muted">
          ChatGPT opens in a new tab and asks for a code, which shows here. OpenGeni never sees your
          password. Every shared workspace can use the account until you limit it.
        </p>
        {codex.pending ? (
          <CodexDeviceCodePanel
            userCode={codex.pending.userCode}
            verificationUri={codex.pending.verificationUri}
          />
        ) : null}
        {signingIn || connected ? (
          <p
            role="status"
            className="flex min-w-0 items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2.5 text-sm text-fg-muted"
          >
            {connected ? (
              <>
                <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-idle" />
                Connected
              </>
            ) : (
              <>
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-fg-subtle motion-safe:animate-spin"
                />
                Waiting for you to sign in…
              </>
            )}
          </p>
        ) : null}
      </FieldStack>
    </ModelsFormPage>
  );
}
