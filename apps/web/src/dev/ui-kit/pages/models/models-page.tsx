import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  MoreHorizontalIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailInline,
  DetailPage,
  DetailSheet,
  DetailSheetContent,
} from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField } from "@/components/ui/field";
import { HelpLink, HelpTip, InlineHelp } from "@/components/ui/inline-help";
import {
  ListRow,
  ListRowSkeleton,
  RowList,
  useRowListVariant,
  type RowListColumn,
} from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import {
  SettingRow,
  SettingRowGroup,
  SettingRowSkeleton,
  useSettingRowField,
} from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageMeter } from "@/components/ui/usage-meter";
import { cn } from "@/lib/utils";

import { currentWorkspace, organization } from "../../fixtures";
import {
  CodexAccountDetail,
  GatewayDetail,
  PrimaryChip,
  accountInUse,
  accountStatus,
  buttonWidth,
  type AccountView,
} from "./account-detail";
import { AllowedModelsForm, ModelsDialogs } from "./dialogs";
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
  modelChoices,
  resetsLabel,
  sameTarget,
  wait,
  useModels,
  type CodexAccount,
  type DetailTarget,
  type GatewayId,
  type LegacySource,
  type Rotation,
  type Scope,
  type Source,
} from "./state";

/* ----------------------------------------------------------------------------
   Settings > Models, for a workspace and for the organization, built from the
   real primitives and driven by Bendik's picks. Rows open the account detail
   (sheet, page or in place); every control saves with fixtures.
   -------------------------------------------------------------------------- */

const COLUMNS: RowListColumn[] = [
  { id: "usage", label: "Usage", width: 156, hideLabel: true },
  { id: "state", label: "Status", width: 120, hideLabel: true },
];

const GATEWAY_ORDER: readonly GatewayId[] = ["openrouter", "vercel"];

const SOURCE_HELP = `Organization uses the Codex accounts ${organization.name} shares with this workspace. This workspace uses only accounts connected here. New work uses one or the other, never both.`;
const PICK_HELP =
  "Spread work sends new work to whichever account has the most room left. Primary only uses the primary account and waits when its limit runs out.";

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

/** Where the account detail shows: a sheet, a page, or in place under its row. */
function useDetailLayout(): "sheet" | "page" | "inline" {
  const { questions } = useModels();
  const picks = useModelsPicks();
  // Tables don't expand in place; they keep the sheet.
  if (questions.q12 === "inline" && picks.list !== "table") return "inline";
  return picks.detail === "page" ? "page" : "sheet";
}

/* ----------------------------------------------------------------------------
   The preview: frame, page, and whatever is open.
   -------------------------------------------------------------------------- */

export function ModelsPreview() {
  const { scenario, setScenario, detail, openDetail, allowed, openAllowed } = useModels();
  const picks = useModelsPicks();
  const layout = useDetailLayout();
  const viewerIsOrgAdmin = scenario.viewer === "org_admin";
  const allowedLayout =
    allowed?.kind === "workspace"
      ? picks.form === "page"
        ? "page"
        : picks.form === "inline"
          ? "inline"
          : "sheet"
      : "sheet";

  const view: AccountView = {
    pageScope: scenario.scope,
    onClose: () => openDetail(null),
    onManageInOrganization: (id) => {
      setScenario({ scope: "organization" });
      openDetail({ kind: "codex", scope: "organization", id });
    },
  };

  let page: ReactNode;
  if (layout === "page" && detail) {
    page = (
      <DetailPage
        back={{ label: "Models", onClick: () => openDetail(null) }}
        className="max-w-none px-0 pt-0 pb-0 max-sm:px-0"
      >
        <DetailView target={detail} view={view} />
      </DetailPage>
    );
  } else if (allowed && allowedLayout === "page") {
    page = (
      <AllowedModelsForm target={allowed} presentation="page" onClose={() => openAllowed(null)} />
    );
  } else if (scenario.scope === "organization") {
    page = <OrganizationModels />;
  } else {
    page = <WorkspaceModels />;
  }

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
        <ScrollOnChange
          value={
            layout === "page" && detail
              ? `detail:${detail.scope}:${detail.id}`
              : allowed && allowedLayout === "page"
                ? "allowed"
                : "list"
          }
        />
        {page}
      </ModelsFrame>
      {layout === "sheet" ? (
        <DetailSheet
          open={detail !== null}
          onOpenChange={(open) => (open ? null : openDetail(null))}
        >
          {detail ? (
            <DetailSheetContent>
              <DetailView target={detail} view={view} />
            </DetailSheetContent>
          ) : null}
        </DetailSheet>
      ) : null}
      {allowed && allowedLayout === "sheet" ? (
        <AllowedModelsForm
          key={JSON.stringify(allowed)}
          target={allowed}
          presentation="sheet"
          onClose={() => openAllowed(null)}
        />
      ) : null}
      <ModelsDialogs />
    </>
  );
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
  const { scenario, setScenario, questions, openDialog } = useModels();
  const picks = useModelsPicks();
  const orgAdmin = scenario.viewer === "org_admin";
  return (
    <div className="min-w-0">
      <SettingsPageHeader
        title="Models"
        description="How new work in this workspace is paid for and which models it may use."
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
            <Section title="New work">
              <SettingRowGroup>
                <DefaultModelRow />
                <AllowedModelsRow />
              </SettingRowGroup>
              <AllowedInline />
            </Section>
            <Section
              title="Model accounts"
              description="Subscriptions and API keys that pay for model use."
              action={
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
              }
            >
              <AccountsList scope="workspace" />
            </Section>
          </SectionStack>
        </PageBody>
      </div>
    </div>
  );
}

function OrganizationModels() {
  const { setScenario, openDialog } = useModels();
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
              title="Shared model accounts"
              description="Each workspace chooses whether new work uses these or its own accounts."
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
          <Section title="New work">
            <SettingRowGroup>
              <SettingRowSkeleton controlWidth="select" />
              <SettingRowSkeleton />
            </SettingRowGroup>
          </Section>
          <Section title="Model accounts">
            <RowList label="Model accounts" columns={COLUMNS} busy>
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
   New work: default model and allowed models.
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
      controlWidth="select"
      label="Default model"
      description="New chats and schedules start with this model unless someone picks another."
      error={
        cantRun
          ? `${current.label} · ${current.payer} can't run: ${current.unavailableReason ?? "it isn't available."}`
          : undefined
      }
      control={<DefaultModelSelect />}
    />
  );
}

function AllowedModelsRow() {
  const { data, openAllowed } = useModels();
  const picks = useModelsPicks();
  return (
    <SettingRow
      variant={picks.settingRow}
      label="Allowed models"
      description={allowedSummary(data.allowedModels)}
      controlWidth={buttonWidth(picks.settingRow)}
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openAllowed({ kind: "workspace" })}
          className="rounded-[10px] pointer-coarse:h-11"
        >
          Edit
        </Button>
      }
    />
  );
}

/** The Allowed models form in place, when the Form pick is "Inline on the page". */
function AllowedInline() {
  const { allowed, openAllowed } = useModels();
  const picks = useModelsPicks();
  if (allowed?.kind !== "workspace" || picks.form !== "inline") return null;
  return (
    <div className="mt-2 mb-2">
      <AllowedModelsForm target={allowed} presentation="inline" onClose={() => openAllowed(null)} />
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Model accounts: providers as groups, one row per account.
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
    const own = data.workspaceAccounts;
    const shared = scenario.orgAssigned ? data.orgAccounts : [];
    codexAccounts = source === "organization" ? [...shared, ...own] : [...own, ...shared];
  }
  const gateways = data.gateways[scope];

  return (
    <>
      <RowList
        variant={picks.list}
        columns={COLUMNS}
        label={scope === "organization" ? "Shared Codex accounts" : "Codex accounts"}
      >
        <GroupHeader
          first
          title="Codex"
          subtitle="ChatGPT plan"
          trailing={<CodexTrailing scope={scope} />}
          controls={<CodexControls scope={scope} />}
          note={<CodexNote scope={scope} />}
        />
        {on ? (
          codexAccounts.length > 0 ? (
            codexAccounts.map((account) => (
              <CodexRow
                key={`${account.scope}:${account.id}`}
                account={account}
                pageScope={scope}
              />
            ))
          ) : (
            <NoCodexRow scope={scope} />
          )
        ) : (
          <CodexOffRow count={data.workspaceAccounts.length} />
        )}
      </RowList>
      {/* API keys have no usage to line up, so their list has no fact columns and
          the Connect button sits at the row's end. */}
      <RowList
        // Without fact columns a table has nothing to head; it keeps the resource rows.
        variant={picks.list === "table" ? "resource" : picks.list}
        label={scope === "organization" ? "Shared API keys" : "API keys"}
        className={cn(picks.section === "open" && "mt-2 border-t border-border")}
      >
        <GroupHeader title="API keys" subtitle="Pay the provider per token" />
        {[...GATEWAY_ORDER]
          .sort((a, b) => Number(gateways[b].connected) - Number(gateways[a].connected))
          .map((id) => (
            <GatewayRow key={id} scope={scope} id={id} />
          ))}
      </RowList>
    </>
  );
}

function GroupHeader({
  title,
  subtitle,
  trailing,
  controls,
  note,
  first = false,
}: {
  title: string;
  subtitle: string;
  /** The group's one action (⋯ menu, or "Turn on Codex"), at the row's end. */
  trailing?: ReactNode;
  /** Pool-wide choices ("Use", "Pick"), on their own line under the title. */
  controls?: ReactNode;
  note?: ReactNode;
  /** The first group in the section sits closer to the section's title. */
  first?: boolean;
}) {
  const variant = useRowListVariant();
  const picks = useModelsPicks();
  const boxed = picks.section !== "open";
  const content = (
    <div
      className={cn(
        "min-w-0 px-3",
        boxed ? "pt-4" : first ? "pt-1" : "pt-5",
        variant === "catalog" ? "pb-1" : "pb-3",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm leading-5 font-semibold text-fg">{title}</h3>
          <p className="text-xs leading-4.5 text-fg-muted">{subtitle}</p>
        </div>
        {trailing ? <div className="flex shrink-0 items-center empty:hidden">{trailing}</div> : null}
      </div>
      {controls ? (
        // Empty (one account, or Codex off) collapses instead of leaving a gap.
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 empty:hidden">
          {controls}
        </div>
      ) : null}
      {note ? <div className="mt-2 min-w-0 empty:hidden">{note}</div> : null}
    </div>
  );
  if (variant === "table") {
    return (
      <div role="row" className="col-span-full min-w-0">
        <div role="cell" className="min-w-0">
          {content}
        </div>
      </div>
    );
  }
  return <li className="col-span-full min-w-0 list-none">{content}</li>;
}

/** A small label, an optional help tip, and one control, as they sit in a group header. */
function Labelled({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* On a phone the controls stack; a fixed label column keeps them aligned. */}
      <span className="flex min-w-0 shrink-0 items-center gap-2 @max-[479px]/list:w-14">
        <span id={labelId} className="text-xs leading-4.5 font-medium text-fg-muted">
          {label}
        </span>
        {help ? <HelpTip label={`About ${label}`}>{help}</HelpTip> : null}
      </span>
      {children(labelId)}
    </div>
  );
}

function CodexControls({ scope }: { scope: Scope }) {
  const { data, setData, questions, scenario } = useModels();
  const picks = useModelsPicks();
  const [pending, setPending] = useState<"source" | "rotation" | null>(null);

  if (scope === "organization") {
    if (data.orgAccounts.length < 2) return null;
    return (
      <RotationControl
        value={data.orgRotation}
        onChange={(value) => setData((current) => ({ ...current, orgRotation: value }))}
      />
    );
  }

  if (!codexOn(data, questions)) return null;

  const source = effectiveSource(data, questions, scenario);
  const pool = accountsOf(data, source);
  const showRotation = source === "workspace" && data.workspaceAccounts.length >= 2;

  const saveSource = async (value: Source) => {
    setData((current) => ({ ...current, source: value }));
    setPending("source");
    await wait(700);
    setPending(null);
    toast.success(
      value === "organization"
        ? `New work in ${currentWorkspace.name} now uses subscriptions from ${ORG_NAME}`
        : `New work in ${currentWorkspace.name} now uses this workspace's accounts`,
    );
  };

  return (
    <>
      {questions.q13 === "segmented" && scenario.orgAssigned ? (
        <Labelled label="Use" help={SOURCE_HELP}>
          {(labelId) => (
            <SegmentedControl<Source>
              aria-labelledby={labelId}
              variant={picks.segmented}
              size="sm"
              pending={pending === "source"}
              value={data.source}
              onValueChange={(value) => void saveSource(value)}
              options={[
                { value: "organization", label: "Organization" },
                { value: "workspace", label: "This workspace" },
              ]}
            />
          )}
        </Labelled>
      ) : null}
      {questions.q13 === "select" ? (
        <Labelled label="Subscription source">
          {(labelId) => (
            <SelectMenu<LegacySource>
              variant={picks.select}
              size="sm"
              align="end"
              aria-labelledby={labelId}
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
          )}
        </Labelled>
      ) : null}
      {showRotation && questions.q14 === "modes" ? (
        <RotationControl
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
      {showRotation && questions.q14 === "legacy" ? (
        <CheckboxField
          label="Auto-rotate subscriptions"
          checked={data.rotation === "spread"}
          onCheckedChange={(checked) => {
            setData((current) => ({ ...current, rotation: checked ? "spread" : "primary" }));
            toast.success(checked ? "Auto-rotate turned on" : "Auto-rotate turned off");
          }}
        />
      ) : null}
    </>
  );
}

/** The Codex header's one action: ⋯ with "Turn off", or "Turn on Codex" while it's off. */
function CodexTrailing({ scope }: { scope: Scope }) {
  const { data, setData, questions, openDialog } = useModels();
  if (scope === "organization") return null;
  if (!codexOn(data, questions)) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setData((current) => ({
            ...current,
            codexEnabled: true,
            legacySource: current.legacySource === "disabled" ? "automatic" : current.legacySource,
          }));
          toast.success(`Codex is on in ${currentWorkspace.name}`);
        }}
        className="rounded-[10px] pointer-coarse:h-11"
      >
        <PowerIcon aria-hidden="true" />
        Turn on Codex
      </Button>
    );
  }
  // Today's select (question 13's other answer) turns Codex off from inside the select.
  if (questions.q13 !== "segmented") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="More actions for Codex"
          // -mr-1.5 lines the dots up with the row chevrons below.
          className="-mr-1.5 rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => openDialog({ kind: "turn-off-codex" })}
        >
          <PowerIcon />
          Turn off Codex in this workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RotationControl({
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
    <Labelled label="Pick" help={PICK_HELP}>
      {(labelId) => (
        <SegmentedControl<Rotation>
          aria-labelledby={labelId}
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
      )}
    </Labelled>
  );
}

/** A quiet line under the Codex header, only where an answer needs one. */
function CodexNote({ scope }: { scope: Scope }) {
  const { data, questions, scenario, setScenario } = useModels();
  if (scope !== "workspace" || !codexOn(data, questions)) return null;
  const source = effectiveSource(data, questions, scenario);
  const orgLink =
    questions.q11 === "keep" && source === "organization" ? (
      <HelpLink
        onClick={() => {
          if (scenario.viewer === "org_admin") setScenario({ scope: "organization" });
          else
            toast("Organization settings", {
              description: `Only owners and admins of ${organization.name} can manage these.`,
            });
        }}
      >
        Manage in organization settings
      </HelpLink>
    ) : null;
  if (questions.q13 === "select" && data.legacySource === "automatic") {
    return (
      <InlineHelp action={orgLink}>
        {source === "workspace"
          ? `Automatic is using this workspace's accounts because ${data.workspaceAccounts.length} are connected. Disconnecting them all switches everyone to the organization's subscriptions.`
          : `Automatic is using subscriptions from ${ORG_NAME}. Connecting an account here switches everyone to it.`}
      </InlineHelp>
    );
  }
  return orgLink ? (
    <InlineHelp action={orgLink}>{`Using subscriptions from ${ORG_NAME}.`}</InlineHelp>
  ) : null;
}

function useDetailRowProps(target: DetailTarget, render: () => ReactNode) {
  const { detail, openDetail } = useModels();
  const layout = useDetailLayout();
  const open = sameTarget(detail, target);
  const inline = layout === "inline";
  return {
    selected: open && layout !== "inline",
    onOpen: () => openDetail(open && inline ? null : target),
    expanded: inline ? open : undefined,
    panel: inline && open ? <DetailInline className="mt-1">{render()}</DetailInline> : undefined,
  };
}

function CodexRow({ account, pageScope }: { account: CodexAccount; pageScope: Scope }) {
  const models = useModels();
  const { openDetail, setScenario } = models;
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
  return (
    <ListRow
      leading={<ProviderTile provider="codex" />}
      title={account.name}
      titleAddon={
        <>
          <PrimaryChip account={account} variant={picks.chip} />
          {shared ? <MetaChip variant={picks.chip}>Organization</MetaChip> : null}
        </>
      }
      meta={[
        account.plan,
        // On the workspace page the Organization badge says who manages it.
        pageScope === "organization"
          ? `Available in ${availabilitySummary(account.availability, true)}`
          : null,
        resetsLabel(account.resets.length),
      ]}
      cells={{
        usage: weekly ? (
          <UsageMeter
            variant={picks.meter}
            density="compact"
            label="Weekly"
            percent={weekly.percentLeft}
            resetsLabel={weekly.resetsLabel}
          />
        ) : null,
        state:
          status.status === "connected" && !status.label ? null : account.needsReconnect ? null : (
            <StatusBadge status={status.status} tone={status.tone} variant={picks.statusRow}>
              {status.label}
            </StatusBadge>
          ),
      }}
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

function NoCodexRow({ scope }: { scope: Scope }) {
  const { openDialog } = useModels();
  return (
    <ListRow
      leading={<ProviderTile provider="codex" />}
      title="No Codex accounts yet"
      description="Pay for new work with a ChatGPT Plus or Pro plan."
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openDialog({ kind: "connect", scope, provider: "codex" })}
          className="rounded-[10px] pointer-coarse:h-11"
        >
          Connect
        </Button>
      }
    />
  );
}

/** The title says it's off; "Turn on Codex" sits in the header above. */
function CodexOffRow({ count }: { count: number }) {
  return (
    <ListRow
      leading={<ProviderTile provider="codex" />}
      title="Codex is off in this workspace"
      description={accountsStayConnected(count)}
    />
  );
}

function GatewayRow({ scope, id }: { scope: Scope; id: GatewayId }) {
  const { data, openDialog, openDetail } = useModels();
  const gateway = data.gateways[scope][id];
  const target: DetailTarget = { kind: "gateway", scope, id };
  const row = useDetailRowProps(target, () => (
    <DetailView
      target={target}
      showHeader={false}
      view={{ pageScope: scope, onClose: () => openDetail(null) }}
    />
  ));
  if (!gateway.connected) {
    return (
      <ListRow
        leading={<ProviderTile provider={id} />}
        title={gateway.name}
        description={gateway.summary}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openDialog({ kind: "connect", scope, provider: id })}
            aria-label={`Connect ${gateway.name}`}
            className="rounded-[10px] pointer-coarse:h-11"
          >
            Connect
          </Button>
        }
      />
    );
  }
  const models = gateway.customModels.length;
  return (
    <ListRow
      leading={<ProviderTile provider={id} />}
      title={gateway.name}
      meta={[
        `Key ending ${gateway.keyHint ?? ""}`,
        models === 0
          ? "No custom models"
          : models === 1
            ? "1 custom model"
            : `${models} custom models`,
      ]}
      indicator={row.expanded !== undefined ? "expand" : "open"}
      {...row}
    />
  );
}
