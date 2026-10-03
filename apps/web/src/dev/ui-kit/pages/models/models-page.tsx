import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRightIcon, BuildingIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { codexPoolCopy } from "@/components/models/codex-models";
import { DetailInline, DetailPage } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import {
  SettingDangerRow,
  SettingNavRow,
  SettingRow,
  SettingRowGroup,
  SettingRowSkeleton,
  useSettingRowField,
} from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageReadout } from "@/components/ui/usage-meter";
import { cn } from "@/lib/utils";

import { currentWorkspace, organization } from "../../fixtures";
import {
  CodexAccountDetail,
  GatewayDetail,
  PrimaryChip,
  accountInUse,
  accountStatus,
  type AccountView,
} from "./account-detail";
import { AllowedModelsForm, ConnectPage, ModelsDialogs } from "./dialogs";
import { ModelsFrame, SettingsPageHeader, useFrame } from "./frame";
import { ProviderTile } from "./marks";
import { useModelsPicks } from "./picks";
import {
  ORG_NAME,
  accountsOf,
  accountsStayConnected,
  allowedSummary,
  availabilitySummary,
  codexOn,
  effectiveSource,
  findAccount,
  modelChoices,
  resetsLabel,
  sameTarget,
  wait,
  useModels,
  type CodexAccount,
  type DetailTarget,
  type GatewayId,
  type LegacySource,
  type ModelsData,
  type Rotation,
  type Scope,
} from "./state";

/* ----------------------------------------------------------------------------
   Settings > Models, for a workspace and for the organization, built from the
   real primitives and driven by Bendik's picks. Defaults, one flat Accounts
   list, then the Codex section's setting rows. Rows open the account's own
   detail page (or expand in place, for question 12's other answer); Connect
   and Allowed models are navigational rows and pages; every control saves
   with fixtures.
   -------------------------------------------------------------------------- */

const COLUMNS: RowListColumn[] = [
  { id: "usage", label: "Usage", width: 200, hideLabel: true, align: "end" },
];

const GATEWAY_ORDER: readonly GatewayId[] = ["openrouter", "vercel"];

const PICK_HELP =
  "Spread work sends each new chat to the account with the most usage left. Primary only uses the primary account and waits when it runs out.";

const LEGACY_SOURCE_OPTIONS: SelectOption<LegacySource>[] = [
  {
    value: "automatic",
    label: "Automatic (default)",
    description: `This workspace's accounts if any are connected, otherwise the organization's.`,
  },
  {
    value: "organization",
    label: "Organization only",
    description: `Always use subscriptions from ${organization.name}.`,
  },
  {
    value: "workspace",
    label: "This workspace only",
    description: "Only use accounts connected to this workspace.",
  },
  { value: "disabled", label: "Turn off Codex", description: "New work can't use Codex here." },
];

/** Where the account detail shows: its own page, or in place under its row. */
function useDetailLayout(): "page" | "inline" {
  const { questions } = useModels();
  const picks = useModelsPicks();
  // Tables don't expand in place; they keep the page.
  if (questions.q12 === "inline" && picks.list !== "table") return "inline";
  return "page";
}

/* ----------------------------------------------------------------------------
   The preview: frame, and the one page that is showing. Everything you open
   is a page in the content area with a back link; only confirmations and
   one-field prompts are centered dialogs.
   -------------------------------------------------------------------------- */

export function ModelsPreview() {
  const {
    data,
    scenario,
    setScenario,
    detail,
    openDetail,
    allowed,
    openAllowed,
    dialog,
    openDialog,
  } = useModels();
  const picks = useModelsPicks();
  const layout = useDetailLayout();
  const viewerIsOrgAdmin = scenario.viewer === "org_admin";
  const detailPage = layout === "page" ? detail : null;
  const connect = dialog?.kind === "connect" ? dialog : null;

  const view: AccountView = {
    pageScope: scenario.scope,
    onClose: () => openDetail(null),
    onManageInOrganization: (id) => {
      setScenario({ scope: "organization" });
      openDetail({ kind: "codex", scope: "organization", id });
    },
  };

  let page: ReactNode;
  let key: string;
  if (connect) {
    key = `connect:${connect.scope}`;
    page = (
      <ConnectPage
        key={key}
        scope={connect.scope}
        initialProvider={connect.provider}
        onClose={() => openDialog(null)}
      />
    );
  } else if (allowed) {
    key = `allowed:${JSON.stringify(allowed)}`;
    page = (
      <AllowedModelsForm
        key={key}
        target={allowed}
        backLabel={detailPage ? detailTitle(data, detailPage) : "Models"}
        onClose={() => openAllowed(null)}
      />
    );
  } else if (detailPage) {
    key = `detail:${detailPage.kind}:${detailPage.scope}:${detailPage.id}`;
    page = (
      <DetailPage
        back={{ label: "Models", onClick: () => openDetail(null) }}
        className="max-w-none px-0 pt-0 pb-0 max-sm:px-0"
      >
        <DetailView target={detailPage} view={view} />
      </DetailPage>
    );
  } else if (scenario.scope === "organization") {
    key = "list:organization";
    page = <OrganizationModels />;
  } else {
    key = "list:workspace";
    page = <WorkspaceModels />;
  }

  const focusRoot = useFocusOnChange(key, detailPage ? detailTitle(data, detailPage) : null);

  return (
    <>
      <ModelsFrame
        label={
          scenario.scope === "organization"
            ? "Organization settings, Models"
            : "Workspace settings, Models"
        }
        nav={picks.nav}
        tabs={picks.tabs}
        scope={scenario.scope}
        viewerIsOrgAdmin={viewerIsOrgAdmin}
        onScope={(scope) => {
          if (scope === "organization" && !viewerIsOrgAdmin) return;
          setScenario({ scope });
        }}
        headerVariant={picks.headerVariant}
        headerIcon={picks.headerIcon}
      >
        <ScrollOnChange value={key} />
        <div ref={focusRoot} className="min-w-0">
          {page}
        </div>
      </ModelsFrame>
      <ModelsDialogs />
    </>
  );
}

/** The back label for a form opened from an account's page: the account's name. */
function detailTitle(data: ModelsData, target: DetailTarget): string {
  return target.kind === "codex"
    ? (findAccount(data, target.scope, target.id)?.name ?? "Models")
    : data.gateways[target.scope][target.id].name;
}

/**
 * After a navigation, focus lands on the new page's title so keyboard and
 * screen reader users start at the top of it. Back on the list, focus returns
 * to the row that was opened.
 */
function useFocusOnChange(value: string, openedName: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    const root = ref.current;
    const returnTo = lastOpened.current;
    lastOpened.current = openedName;
    if (first.current) {
      first.current = false;
      return;
    }
    if (!root) return;
    if (value.startsWith("list:")) {
      if (!returnTo) return;
      const row = Array.from(root.querySelectorAll<HTMLElement>("[data-slot=list-row]")).find(
        (each) => each.textContent?.includes(returnTo),
      );
      row?.querySelector<HTMLElement>("[data-row-action]")?.focus({ preventScroll: true });
      return;
    }
    const heading = root.querySelector<HTMLElement>("h1");
    if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the page changes
  }, [value]);
  return ref;
}

/** Detail pages and full-page forms start at the top, like a navigation. */
function ScrollOnChange({ value }: { value: string }) {
  const frame = useFrame();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    frame.scrollTop();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the view changes
  }, [value]);
  return null;
}

export function DetailView({
  target,
  view,
  showHeader = true,
}: {
  target: DetailTarget;
  view: AccountView;
  showHeader?: boolean;
}) {
  return target.kind === "codex" ? (
    <CodexAccountDetail scope={target.scope} id={target.id} view={view} showHeader={showHeader} />
  ) : (
    <GatewayDetail scope={target.scope} id={target.id} view={view} showHeader={showHeader} />
  );
}

/* ----------------------------------------------------------------------------
   Pages.
   -------------------------------------------------------------------------- */

function WorkspaceModels() {
  const { data, scenario, setScenario, questions, openDialog } = useModels();
  const picks = useModelsPicks();
  const orgAdmin = scenario.viewer === "org_admin";
  const connect = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => openDialog({ kind: "connect", scope: "workspace" })}
      className="rounded-[10px] pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      Connect account
    </Button>
  );
  return (
    <div className="min-w-0">
      <SettingsPageHeader
        title="Models"
        description="Which models this workspace can use, and who pays for them."
        onScope={(scope) => setScenario({ scope })}
        actions={
          questions.q11 === "keep" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (orgAdmin) setScenario({ scope: "organization" });
                else
                  toast("Organization settings", {
                    description: `Organization model subscriptions can be managed only by owners and admins of ${organization.name}.`,
                  });
              }}
              className="text-brand hover:bg-brand/10 hover:text-brand"
            >
              Manage organization connections
              <ArrowUpRightIcon aria-hidden="true" />
            </Button>
          ) : null
        }
      />
      <div className="mt-8">
        <PageBody>
          <SectionStack variant={picks.section}>
            <Section title="Defaults">
              <SettingRowGroup>
                <DefaultModelRow />
                <AllowedModelsRow />
              </SettingRowGroup>
            </Section>
            <Section
              title="Accounts"
              description="Subscriptions and API keys that pay for models here."
              action={connect}
            >
              <KitPoolNotice />
              <AccountsList scope="workspace" />
            </Section>
            {codexOn(data, questions) || data.workspaceAccounts.length > 0 ? (
              <Section title="Codex">
                <CodexSettings />
              </Section>
            ) : null}
          </SectionStack>
        </PageBody>
      </div>
    </div>
  );
}

function OrganizationModels() {
  const { data, setData, setScenario, openDialog } = useModels();
  const picks = useModelsPicks();
  return (
    <div className="min-w-0">
      <SettingsPageHeader
        title="Models"
        description={`Subscriptions and API keys ${organization.name} pays for, and which workspaces can use them.`}
        context={organization.name}
        onScope={(scope) => setScenario({ scope })}
      />
      <div className="mt-8">
        <PageBody>
          <SectionStack variant={picks.section}>
            <Section
              title="Accounts"
              description="Shared with the organization's workspaces. Each workspace chooses whether to use them or its own."
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openDialog({ kind: "connect", scope: "organization" })}
                  className="rounded-[10px] pointer-coarse:h-11"
                >
                  <PlusIcon aria-hidden="true" />
                  Connect account
                </Button>
              }
            >
              <AccountsList scope="organization" />
            </Section>
            {data.orgAccounts.length >= 2 ? (
              <Section title="Codex">
                <SettingRowGroup>
                  <RotationRow
                    value={data.orgRotation}
                    onChange={(value) => setData((current) => ({ ...current, orgRotation: value }))}
                  />
                </SettingRowGroup>
              </Section>
            ) : null}
          </SectionStack>
        </PageBody>
      </div>
    </div>
  );
}

/** Loading and error states for the whole page, from the scenario controls. */
function PageBody({ children }: { children: ReactNode }) {
  const { scenario, setScenario } = useModels();
  const picks = useModelsPicks();
  const [retrying, setRetrying] = useState(false);
  if (scenario.load === "loading") {
    return (
      <div role="status" aria-label="Loading models" className="min-w-0">
        <SectionStack variant={picks.section}>
          <Section title="Defaults">
            <SettingRowGroup>
              <SettingRowSkeleton controlWidth="auto" />
              <SettingRowSkeleton />
            </SettingRowGroup>
          </Section>
          <Section title="Accounts">
            <RowList label="Accounts" columns={COLUMNS} flush busy>
              <ListRowSkeleton count={3} />
            </RowList>
          </Section>
        </SectionStack>
      </div>
    );
  }
  if (scenario.load === "error") {
    return (
      <ErrorMessage
        align="center"
        title="Couldn't load models."
        reference="req_4be17c0a93"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              await wait(900);
              setRetrying(false);
              setScenario({ load: "ready" });
            }}
            className="rounded-[10px] pointer-coarse:h-11"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn(retrying && "motion-safe:animate-spin")}
            />
            Try again
          </Button>
        }
      >
        Check your connection and try again. Nothing was changed.
      </ErrorMessage>
    );
  }
  return <>{children}</>;
}

/* ----------------------------------------------------------------------------
   Defaults: the default model and Allowed models.
   -------------------------------------------------------------------------- */

function DefaultModelSelect() {
  const { data, setData, questions, scenario } = useModels();
  const picks = useModelsPicks();
  const field = useSettingRowField();
  const choices = modelChoices(data, questions, scenario);
  const allowed = data.allowedModels;
  const options: SelectOption[] = choices.map((choice) => {
    const notAllowed = allowed !== "all" && !allowed.includes(choice.id);
    return {
      value: choice.id,
      label: choice.label,
      meta: choice.payer,
      description: choice.description,
      group: choice.group,
      disabled: !choice.available || notAllowed,
      disabledReason: notAllowed
        ? "Not in Allowed models for this workspace."
        : choice.available
          ? undefined
          : choice.unavailableReason,
    };
  });
  return (
    <SelectMenu
      variant={picks.select}
      size="sm"
      align="end"
      options={options}
      value={data.defaultModelId}
      showSelectedDescription={false}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      invalid={field?.invalid}
      menuClassName="w-80"
      className="w-auto min-w-[180px]"
      onValueChange={(value) => {
        setData((current) => ({ ...current, defaultModelId: value }));
        const choice = choices.find((each) => each.id === value);
        toast.success(`New work starts with ${choice?.label ?? value} · ${choice?.payer ?? ""}`);
      }}
    />
  );
}

function DefaultModelRow() {
  const { data, questions, scenario } = useModels();
  const picks = useModelsPicks();
  const choices = modelChoices(data, questions, scenario);
  const current = choices.find((choice) => choice.id === data.defaultModelId);
  const cantRun = current && !current.available;
  return (
    <SettingRow
      variant={picks.settingRow}
      controlWidth="auto"
      label="Default model"
      description="New chats and schedules start with this model."
      error={
        cantRun
          ? `${current.label} can't run: ${current.unavailableReason ?? "it isn't available."}`
          : undefined
      }
      control={<DefaultModelSelect />}
    />
  );
}

/** A navigational row: the whole row opens the page, the value sits by the chevron. */
function AllowedModelsRow() {
  const { data, openAllowed } = useModels();
  return (
    <SettingNavRow
      label="Allowed models"
      description="The models people can pick for new chats and schedules."
      value={data.allowedModels === "all" ? "All models" : allowedSummary(data.allowedModels)}
      onOpen={() => openAllowed({ kind: "workspace" })}
    />
  );
}

/* ----------------------------------------------------------------------------
   Accounts: one flat list, whatever the provider. Unconnected providers are
   choices on the Connect account page, not rows.
   -------------------------------------------------------------------------- */

function AccountsList({ scope }: { scope: Scope }) {
  const models = useModels();
  const { data, questions, scenario } = models;
  const picks = useModelsPicks();
  const on = scope === "organization" || codexOn(data, questions);
  const source = effectiveSource(data, questions, scenario);

  let codexAccounts: CodexAccount[];
  if (scope === "organization") {
    codexAccounts = data.orgAccounts;
  } else {
    // Both pools in one list: the one new work uses first, the other muted as "Not in use".
    const own = data.workspaceAccounts;
    const shared = scenario.orgAssigned ? data.orgAccounts : [];
    codexAccounts = source === "organization" ? [...shared, ...own] : [...own, ...shared];
  }
  const gateways = GATEWAY_ORDER.filter((id) => data.gateways[scope][id].connected);

  return (
    <RowList
      variant={picks.list}
      columns={COLUMNS}
      flush={picks.list === "resource"}
      label={scope === "organization" ? "Shared accounts" : "Accounts"}
    >
      {on ? (
        codexAccounts.map((account) => (
          <CodexRow key={`${account.scope}:${account.id}`} account={account} pageScope={scope} />
        ))
      ) : (
        <CodexOffRow count={data.workspaceAccounts.length} />
      )}
      {gateways.map((id) => (
        <GatewayRow key={id} scope={scope} id={id} />
      ))}
    </RowList>
  );
}

/* ----------------------------------------------------------------------------
   Codex: its settings as rows, one control each, and Turn off at the end.
   -------------------------------------------------------------------------- */

function CodexSettings() {
  const { data, setData, questions, scenario, openDialog } = useModels();
  const picks = useModelsPicks();
  const [pending, setPending] = useState<"source" | "rotation" | null>(null);
  const [portable, setPortable] = useState(false);

  if (!codexOn(data, questions)) {
    return (
      <SettingRowGroup>
        <SettingRow
          variant={picks.settingRow}
          label="Codex is off in this workspace"
          description={`New chats and schedules here can't use Codex models. ${accountsStayConnected(data.workspaceAccounts.length)}`}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setData((current) => ({
                  ...current,
                  codexEnabled: true,
                  legacySource:
                    current.legacySource === "disabled" ? "automatic" : current.legacySource,
                }));
                toast.success(`Codex is on in ${currentWorkspace.name}`);
              }}
              className="rounded-[10px] pointer-coarse:h-11"
            >
              Turn on Codex
            </Button>
          }
        />
      </SettingRowGroup>
    );
  }

  const source = effectiveSource(data, questions, scenario);
  const pool = accountsOf(data, source);
  const showRotation = source === "workspace" && data.workspaceAccounts.length >= 2;

  return (
    <SettingRowGroup>
      {questions.q13 === "select" ? (
        <SettingRow
          variant={picks.settingRow}
          controlWidth="auto"
          label="Subscription source"
          control={
            <SelectMenu<LegacySource>
              variant={picks.select}
              size="sm"
              align="end"
              options={LEGACY_SOURCE_OPTIONS}
              value={data.legacySource}
              showSelectedDescription={false}
              menuClassName="w-72"
              className="w-48"
              onValueChange={(value) => {
                setData((current) => ({ ...current, legacySource: value }));
                toast.success("Subscription source saved");
              }}
            />
          }
        />
      ) : null}
      {showRotation ? (
        <RotationRow
          value={data.rotation}
          pending={pending === "rotation"}
          onChange={async (value) => {
            setData((current) => ({ ...current, rotation: value }));
            setPending("rotation");
            await wait(700);
            setPending(null);
            toast.success(
              value === "spread"
                ? "New work is spread across accounts"
                : `New work uses ${pool.find((each) => each.isPrimary)?.name ?? "the primary account"} only`,
            );
          }}
        />
      ) : null}
      <SettingRow
        variant={picks.settingRow}
        label="Keep Codex chats portable"
        description="Summarizes long chats in a form another provider's model can continue. Off keeps new chats on Codex, with better memory of long conversations."
        control={
          <Switch
            checked={portable}
            onCheckedChange={(next) => {
              setPortable(next);
              toast.success(
                next ? "New Codex chats are portable" : "New Codex chats stay on Codex",
              );
            }}
          />
        }
      />
      {questions.q13 === "segmented" ? (
        <SettingDangerRow
          label="Turn off Codex"
          description="New chats and schedules here stop using Codex models. Accounts stay connected."
          onClick={() => openDialog({ kind: "turn-off-codex" })}
        />
      ) : null}
    </SettingRowGroup>
  );
}

function RotationRow({
  value,
  pending = false,
  onChange,
}: {
  value: Rotation;
  pending?: boolean;
  onChange: (value: Rotation) => void;
}) {
  const picks = useModelsPicks();
  return (
    <SettingRow
      variant={picks.settingRow}
      controlWidth="auto"
      label="Sharing work between accounts"
      description={PICK_HELP}
      control={
        <SegmentedControl<Rotation>
          variant={picks.segmented}
          size="sm"
          pending={pending}
          value={value}
          onValueChange={onChange}
          options={[
            { value: "spread", label: "Spread work" },
            { value: "primary", label: "Primary only" },
          ]}
        />
      }
    />
  );
}

function useDetailRowProps(target: DetailTarget, render: () => ReactNode) {
  const { detail, openDetail } = useModels();
  const layout = useDetailLayout();
  const open = sameTarget(detail, target);
  const inline = layout === "inline";
  return {
    selected: false,
    onOpen: () => openDetail(open && inline ? null : target),
    expanded: inline ? open : undefined,
    panel: inline && open ? <DetailInline className="mt-1">{render()}</DetailInline> : undefined,
  };
}

/** ⋯ on an organization row: keep new work on the organization's accounts. */
function AlwaysOrganizationItem() {
  const { setData } = useModels();
  return (
    <DropdownMenuItem
      onSelect={() => {
        setData((current) => ({ ...current, legacySource: "organization" }));
        toast.success(`New work in ${currentWorkspace.name} now uses the organization's accounts`);
      }}
    >
      <BuildingIcon />
      Always use the organization's accounts
    </DropdownMenuItem>
  );
}

/** Which Codex accounts new work uses, above the list. Same words as the real page. */
function KitPoolNotice() {
  const { data, setData, questions, scenario } = useModels();
  if (!codexOn(data, questions) || !scenario.orgAssigned) return null;
  const source = effectiveSource(data, questions, scenario);
  const mode = data.legacySource === "disabled" ? "automatic" : data.legacySource;
  const copy = codexPoolCopy({
    mode,
    inUse: source,
    organizationAvailable: data.orgAccounts.length > 0,
    workspaceCount: source === "workspace" ? data.workspaceAccounts.length : 0,
    organizationCount: data.orgAccounts.length,
    canConnect: true,
  });
  return (
    <Notice
      tone={copy.blocked ? "waiting" : "muted"}
      actionLayout="responsive"
      className="mb-2"
      action={
        mode === "automatic" ? undefined : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setData((current) => ({ ...current, legacySource: "automatic" }));
              toast.success(
                `New work in ${currentWorkspace.name} picks Codex accounts automatically`,
              );
            }}
            className="rounded-[10px] pointer-coarse:h-11"
          >
            Use automatically
          </Button>
        )
      }
    >
      {copy.text}
    </Notice>
  );
}

function CodexRow({ account, pageScope }: { account: CodexAccount; pageScope: Scope }) {
  const models = useModels();
  const { data, openDetail, setScenario } = models;
  const picks = useModelsPicks();
  const inUse = accountInUse(account, models);
  const status = accountStatus(account, inUse);
  const weekly = account.usage.find((window) => window.label === "Weekly");
  const target: DetailTarget = { kind: "codex", scope: account.scope, id: account.id };
  const row = useDetailRowProps(target, () => (
    <DetailView
      target={target}
      showHeader={false}
      view={{
        pageScope,
        onClose: () => openDetail(null),
        onManageInOrganization: (id) => {
          setScenario({ scope: "organization" });
          openDetail({ kind: "codex", scope: "organization", id });
        },
      }}
    />
  ));
  const shared = account.scope === "organization" && pageScope === "workspace";
  if (!inUse && pageScope === "workspace") {
    return (
      <ListRow
        disabled
        leading={<ProviderTile provider="codex" size="lg" />}
        title={account.name}
        meta={[account.plan, shared ? `Shared by ${ORG_NAME}` : "Connected here"]}
        cells={{ usage: <span className="text-xs font-medium text-fg-subtle">Not in use</span> }}
        menu={shared ? <AlwaysOrganizationItem /> : undefined}
      />
    );
  }
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title={account.name}
      titleAddon={<PrimaryChip account={account} variant={picks.chip} />}
      meta={[
        account.plan,
        shared ? `Shared by ${ORG_NAME}` : null,
        pageScope === "organization"
          ? `Available in ${availabilitySummary(account.availability, true)}`
          : null,
        resetsLabel(account.resets.length),
      ]}
      cells={{
        usage: account.needsReconnect ? null : status?.status === "paused" ? (
          <StatusBadge status="paused" variant={picks.statusRow} />
        ) : weekly ? (
          <UsageReadout
            percent={weekly.percentLeft}
            window="this week"
            resetsLabel={weekly.resetsLabel}
          />
        ) : null,
      }}
      menu={shared && data.legacySource === "automatic" ? <AlwaysOrganizationItem /> : undefined}
      indicator={
        account.needsReconnect
          ? { kind: "attention", label: "Needs reconnect" }
          : row.expanded !== undefined
            ? "expand"
            : "open"
      }
      {...row}
    />
  );
}

/** Codex off: one quiet row; "Turn on Codex" lives in the Codex section. */
function CodexOffRow({ count }: { count: number }) {
  return (
    <ListRow
      leading={<ProviderTile provider="codex" size="lg" />}
      title="Codex"
      meta={["Off in this workspace", accountsStayConnected(count)]}
    />
  );
}

function GatewayRow({ scope, id }: { scope: Scope; id: GatewayId }) {
  const { data, openDetail } = useModels();
  const gateway = data.gateways[scope][id];
  const target: DetailTarget = { kind: "gateway", scope, id };
  const row = useDetailRowProps(target, () => (
    <DetailView
      target={target}
      showHeader={false}
      view={{ pageScope: scope, onClose: () => openDetail(null) }}
    />
  ));
  const models = gateway.customModels.length;
  return (
    <ListRow
      leading={<ProviderTile provider={id} size="lg" />}
      title={gateway.name}
      meta={[
        `API key ending ${gateway.keyHint ?? ""}`,
        models === 0 ? null : models === 1 ? "1 custom model" : `${models} custom models`,
      ]}
      indicator={row.expanded !== undefined ? "expand" : "open"}
      {...row}
    />
  );
}
