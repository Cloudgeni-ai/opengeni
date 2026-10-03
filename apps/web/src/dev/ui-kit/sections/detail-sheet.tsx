import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BoxIcon,
  BracesIcon,
  CalendarClockIcon,
  LoaderCircleIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailBody,
  DetailFooter,
  DetailHeader,
  DetailInline,
  DetailPage,
  DetailSection,
  DetailSheetPreview,
  DetailSkeleton,
  useDetailPresentation,
} from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DetailAside,
  DetailAsideItem,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DestructiveConfirmPanel } from "@/components/ui/destructive-confirm";
import { ErrorMessage } from "@/components/ui/error-message";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageMeter } from "@/components/ui/usage-meter";
import { AddVariableRow } from "@/components/variable-sets/variable-set-forms";
import type { WorkspaceVariableSet } from "@/types";

import {
  KIT_NOW,
  KIT_TIME_ZONE,
  codexOrganizationAccounts,
  codexWorkspaceAccounts,
  currentWorkspace,
  organization,
  variableSets,
  type ModelAccount,
  type VariableSet,
  type VariableSetUsage,
} from "../fixtures";
import {
  Alternative,
  Fork,
  KitBlock,
  KitSection,
  PagePreview,
  StateCell,
  StatesGrid,
  UsageNotes,
} from "../kit";

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;
const FRAME_HEIGHT = 640;

/* ----------------------------------------------------------------------------
   Small shared pieces.
   -------------------------------------------------------------------------- */

function DangerGhost({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="-ml-3 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
    >
      {children}
    </Button>
  );
}

function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="text-fg-muted hover:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ----------------------------------------------------------------------------
   The variable set, in every presentation.
   -------------------------------------------------------------------------- */

const VARIABLE_COLUMNS: RowListColumn[] = [
  { id: "value", label: "Value", width: 184, hideLabel: true },
  { id: "updated", label: "Updated", width: 148, hideLabel: true },
];

function VariablesList({ set, table }: { set: VariableSet; table?: boolean }) {
  return (
    <RowList
      variant={table ? "table" : "resource"}
      columns={VARIABLE_COLUMNS}
      label={`Variables in ${set.name}`}
    >
      {set.variables.map((variable) => (
        <ListRow
          key={variable.name}
          title={<span className="font-mono text-xs">{variable.name}</span>}
          cells={{
            value:
              variable.kind === "secret" ? (
                <span className="inline-flex items-center gap-1">
                  <LockIcon aria-hidden="true" className="size-3 text-fg-subtle" />
                  Secret
                </span>
              ) : (
                <span className="font-mono text-xs">{variable.value}</span>
              ),
            updated: (
              <RelativeTime
                date={variable.updatedAt}
                prefix={table ? undefined : "Updated"}
                {...TIME}
              />
            ),
          }}
          menuLabel={`More actions for ${variable.name}`}
          menu={
            <>
              <DropdownMenuItem>
                <RefreshCwIcon />
                Replace value
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </>
          }
        />
      ))}
    </RowList>
  );
}

const USAGE_ICON: Record<VariableSetUsage["kind"], ReactNode> = {
  schedule: <CalendarClockIcon />,
  chat: <MessageSquareIcon />,
  environment_default: <BoxIcon />,
};

function UsedByList({ set }: { set: VariableSet }) {
  if (set.usedBy.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        Not used yet. Turn it on from the chat composer or a schedule.
      </p>
    );
  }
  return (
    <RowList label={`What uses ${set.name}`}>
      {set.usedBy.map((usage) => (
        <ListRow
          key={usage.name}
          leading={<LogoTile icon={USAGE_ICON[usage.kind]} />}
          title={usage.name}
          description={usage.kindLabel}
          indicator="open"
          onOpen={() => {}}
        />
      ))}
    </RowList>
  );
}

/* ----------------------------------------------------------------------------
   The variable set detail, in each presentation. B uses the page anatomy
   (DetailPageHeader + DetailPageBody); A and C keep the retired shapes for
   the history.
   -------------------------------------------------------------------------- */

function VariableSetMenu({ set }: { set: VariableSet }) {
  return (
    <MoreMenu label={`More actions for ${set.name}`}>
      <DropdownMenuItem>
        <PencilIcon />
        Rename
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">
        <Trash2Icon />
        Delete variable set
      </DropdownMenuItem>
    </MoreMenu>
  );
}

/** As in the product: one variable is added inline under the list. */
function AddVariableInline({ set }: { set: VariableSet }) {
  return (
    <AddVariableRow
      set={set as unknown as WorkspaceVariableSet}
      onAdd={() => new Promise<void>((resolve) => setTimeout(resolve, 500))}
      onPaste={() => {}}
    />
  );
}

function scopeText(set: VariableSet): string {
  return set.scope === "organization"
    ? `Everyone in ${organization.name}`
    : `Everyone in ${currentWorkspace.name}`;
}

type VariableSetTab = "variables" | "used-by";

/** B: the decided detail page. */
function VariableSetPage({ set, onBack }: { set: VariableSet; onBack: () => void }) {
  const [tab, setTab] = useState<VariableSetTab>("variables");
  return (
    <DetailPage back={{ label: "Variable sets", onClick: onBack }}>
      <DetailPageHeader
        leading={<LogoTile icon={<BracesIcon />} />}
        title={set.name}
        chips={set.scopeLabel ? <MetaChip variant="soft">{set.scopeLabel}</MetaChip> : null}
        meta={[
          set.variablesLabel,
          set.usageLabel,
          <RelativeTime key="updated" date={set.updatedAt} prefix="updated" {...TIME} />,
        ]}
        actions={<VariableSetMenu set={set} />}
        tabs={
          <LineTabsNav aria-label={`${set.name} sections`}>
            <LineTabsLink asChild active={tab === "variables"} count={set.variables.length}>
              <button type="button" onClick={() => setTab("variables")}>
                Variables
              </button>
            </LineTabsLink>
            <LineTabsLink asChild active={tab === "used-by"} count={set.usedBy.length}>
              <button type="button" onClick={() => setTab("used-by")}>
                Used by
              </button>
            </LineTabsLink>
          </LineTabsNav>
        }
      />
      <DetailPageBody
        aside={
          <DetailAside label={`About ${set.name}`}>
            <DetailAsideItem label="Available to" icon={<UsersIcon />}>
              {scopeText(set)}
            </DetailAsideItem>
            <DetailAsideItem label="Last change" icon={<CalendarClockIcon />}>
              <RelativeTime date={set.updatedAt} {...TIME} />
            </DetailAsideItem>
            <DetailAsideItem label="Variable set ID">
              <CopyField value={set.id} label="variable set ID" />
            </DetailAsideItem>
          </DetailAside>
        }
      >
        {tab === "variables" ? (
          <DetailSection title="Description" className="pb-2">
            <p className="text-sm leading-6 text-fg">{set.description}</p>
          </DetailSection>
        ) : null}
        {tab === "variables" ? (
          <DetailSection
            title="Variables"
            description="Secrets are write-only. Agents get them in their sandbox."
          >
            <VariablesList set={set} table />
            <AddVariableInline set={set} />
          </DetailSection>
        ) : (
          <DetailSection
            title="Used by"
            description="Turning the set off here stops new work from getting it."
          >
            <UsedByList set={set} />
          </DetailSection>
        )}
      </DetailPageBody>
    </DetailPage>
  );
}

/** A and C: the retired sheet body and today's inline body. */
function VariableSetCompact({ set }: { set: VariableSet }) {
  const inline = useDetailPresentation() === "inline";
  return (
    <>
      {inline ? null : (
        <DetailHeader
          leading={<LogoTile icon={<BracesIcon />} />}
          title={set.name}
          subtitle={set.description}
          status={set.scopeLabel ? <MetaChip variant="outline">{set.scopeLabel}</MetaChip> : null}
          actions={<VariableSetMenu set={set} />}
        />
      )}
      <DetailBody>
        <DetailSection title={`Variables (${set.variables.length})`}>
          <VariablesList set={set} />
          <AddVariableInline set={set} />
        </DetailSection>
        <DetailSection title="Used by">
          <UsedByList set={set} />
        </DetailSection>
      </DetailBody>
      {inline ? null : (
        <DetailFooter start={<DangerGhost>Delete variable set</DangerGhost>}>
          <Button type="button" variant="outline" className="pointer-coarse:h-11">
            Done
          </Button>
        </DetailFooter>
      )}
    </>
  );
}

/* ----------------------------------------------------------------------------
   The variable set list behind each presentation.
   -------------------------------------------------------------------------- */

function VariableSetsPage({
  selectedId,
  onOpen,
  expandable,
}: {
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** C: rows expand in place instead of opening. */
  expandable?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-[960px] min-w-0 px-8 pt-6 pb-10 max-sm:px-4">
      <PageHeader
        title="Variable sets"
        description="Environment variables and secrets your agents get in their sandbox."
        icon={<BracesIcon />}
        actions={
          <Button type="button" className="pointer-coarse:h-11">
            <PlusIcon />
            New variable set
          </Button>
        }
      />
      <RowList
        label="Variable sets"
        className="mt-4"
        columns={[
          { id: "variables", label: "Variables", width: 88, hideLabel: true },
          { id: "updated", label: "Updated", width: 148, hideLabel: true },
        ]}
      >
        {variableSets.map((set) => {
          const expanded = expandable ? selectedId === set.id : undefined;
          return (
            <ListRow
              key={set.id}
              leading={<LogoTile icon={<BracesIcon />} />}
              title={set.name}
              titleAddon={
                set.scopeLabel ? <MetaChip variant="outline">{set.scopeLabel}</MetaChip> : null
              }
              description={set.description}
              cells={{
                variables: set.variablesLabel,
                updated: <RelativeTime date={set.updatedAt} prefix="Updated" {...TIME} />,
              }}
              indicator={expandable ? "expand" : "open"}
              selected={!expandable && selectedId === set.id}
              expanded={expanded}
              panel={
                expanded ? (
                  <DetailInline>
                    <VariableSetCompact set={set} />
                  </DetailInline>
                ) : undefined
              }
              onOpen={() => onOpen(set.id)}
            />
          );
        })}
      </RowList>
    </div>
  );
}

/** A (retired): the sheet over the list. A static picture, kept for the history. */
function SheetFrame() {
  const set = variableSets[0]!;
  return (
    <PagePreview label="Variable sets with a detail sheet (retired)" height={FRAME_HEIGHT}>
      <div className="relative h-full min-w-0" inert>
        <div className="h-full overflow-hidden">
          <VariableSetsPage selectedId={set.id} onOpen={() => {}} />
        </div>
        <div aria-hidden="true" className="absolute inset-0 z-10 bg-black/50" />
        <DetailSheetPreview
          label={set.name}
          className="absolute inset-y-0 right-0 z-20 max-w-[min(520px,100%)]"
        >
          <VariableSetCompact set={set} />
        </DetailSheetPreview>
      </div>
    </PagePreview>
  );
}

/** Scroll the preview frame back to the top and focus the new view's heading. */
function useViewFocus(view: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const root = ref.current;
    if (!root) return;
    root.scrollTop = 0;
    root.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [view]);
  return ref;
}

/** B (decided): the row opens its own page; the back link returns to the list. */
function PageFrame() {
  const [openId, setOpenId] = useState<string | null>(null);
  const set = variableSets.find((each) => each.id === openId) ?? null;
  const ref = useViewFocus(openId);
  return (
    <PagePreview label="Variable sets with detail pages" height={FRAME_HEIGHT}>
      <div ref={ref} className="h-full overflow-auto [&_h1]:outline-none" data-kit-scroller="">
        {set ? (
          <VariableSetPage set={set} onBack={() => setOpenId(null)} />
        ) : (
          <VariableSetsPage selectedId={null} onOpen={setOpenId} />
        )}
      </div>
    </PagePreview>
  );
}

/** C: today's pattern, the row expands in place. */
function InlineFrame() {
  const [openId, setOpenId] = useState<string | null>(variableSets[0]!.id);
  return (
    <PagePreview label="Variable sets expanding in place" height={FRAME_HEIGHT}>
      <VariableSetsPage
        expandable
        selectedId={openId}
        onOpen={(id) => setOpenId((current) => (current === id ? null : id))}
      />
    </PagePreview>
  );
}

/* ----------------------------------------------------------------------------
   The account page (brief sample content), for the anatomy and the states.
   -------------------------------------------------------------------------- */

type AccountState = "default" | "readonly" | "saving" | "error";

function AccountPage({
  account,
  state = "default",
}: {
  account: ModelAccount;
  state?: AccountState;
}) {
  const [tab, setTab] = useState<"overview" | "resets">("overview");
  const readOnly = state === "readonly";
  const weekly = account.usage.find((window) => window.label === "Weekly");
  const fiveHour = account.usage.find((window) => window.label === "5-hour");
  const lockedReason = `Managed by ${organization.name}. Only organization admins can change it.`;

  return (
    <DetailPage back={{ label: "Models", onClick: () => {} }}>
      <DetailPageHeader
        leading={<LogoTile name="Codex" monogram="C" />}
        title={account.name}
        chips={
          <>
            <StatusBadge status={account.state === "paused" ? "paused" : "connected"} />
            {account.isPrimary ? (
              <MetaChip variant="soft" icon={<StarIcon />}>
                Primary
              </MetaChip>
            ) : null}
          </>
        }
        meta={[account.plan, account.sourceLabel, account.checkedLabel]}
        actions={
          state === "saving" ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
              <LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
              Saving
            </span>
          ) : readOnly ? null : (
            <MoreMenu label={`More actions for ${account.name}`}>
              <DropdownMenuItem>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={account.isPrimary}>
                <StarIcon />
                Make primary
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Trash2Icon />
                Disconnect
              </DropdownMenuItem>
            </MoreMenu>
          )
        }
        tabs={
          <LineTabsNav aria-label={`${account.name} sections`}>
            <LineTabsLink asChild active={tab === "overview"}>
              <button type="button" onClick={() => setTab("overview")}>
                Overview
              </button>
            </LineTabsLink>
            <LineTabsLink asChild active={tab === "resets"} count={account.resets.length}>
              <button type="button" onClick={() => setTab("resets")}>
                Usage limit resets
              </button>
            </LineTabsLink>
          </LineTabsNav>
        }
      />
      {state === "error" ? (
        <div className="py-12">
          <ErrorMessage
            title="Couldn't load this account."
            align="center"
            action={
              <Button type="button" variant="outline" size="sm">
                <RefreshCwIcon />
                Try again
              </Button>
            }
            reference="req_7c41e2d09a"
          >
            Check your connection and try again. Your settings are unchanged.
          </ErrorMessage>
        </div>
      ) : (
        <DetailPageBody
          aside={
            <DetailAside label={`About ${account.name}`}>
              <DetailAsideItem label="Plan" icon={<BoxIcon />}>
                {account.plan}
              </DetailAsideItem>
              <DetailAsideItem label="Connected in" icon={<UsersIcon />}>
                {account.sourceLabel === "Organization"
                  ? organization.name
                  : account.sourceLabel === "Only you"
                    ? "Only you"
                    : currentWorkspace.name}
              </DetailAsideItem>
              <DetailAsideItem label="Can serve">
                {account.modelsServedLabel === "All" ? "All models" : account.modelsServedLabel}
              </DetailAsideItem>
              {account.availableInLabel ? (
                <DetailAsideItem label="Available in">{account.availableInLabel}</DetailAsideItem>
              ) : null}
            </DetailAside>
          }
        >
          {readOnly ? (
            <p className="flex items-start gap-2 py-4 text-xs leading-4.5 text-fg-muted">
              <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
              {lockedReason}
            </p>
          ) : null}
          {tab === "overview" ? (
            <>
              <DetailSection
                title="Usage"
                description={account.checkedLabel}
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Check usage now"
                    className="-mr-2 text-fg-muted hover:text-fg pointer-coarse:size-11"
                  >
                    <RefreshCwIcon />
                  </Button>
                }
              >
                <div className="flex flex-col gap-4">
                  {weekly ? (
                    <UsageMeter
                      label="Weekly"
                      percent={weekly.percentLeft}
                      resetsLabel={weekly.resetsLabel}
                    />
                  ) : null}
                  {fiveHour ? (
                    <UsageMeter
                      label="5-hour"
                      percent={fiveHour.percentLeft}
                      resetsLabel={fiveHour.resetsLabel}
                    />
                  ) : null}
                </div>
              </DetailSection>
              <DetailSection title="Settings">
                <SettingRowGroup className="-my-3">
                  <SettingRow
                    label="Use for new work"
                    description="New chats and schedules can use this account."
                    control={
                      <Switch
                        defaultChecked={account.useForNewWork}
                        pending={state === "saving"}
                        disabled={readOnly}
                        disabledReason={readOnly ? lockedReason : undefined}
                      />
                    }
                  />
                  <SettingRow
                    label="Codex Apps"
                    description="Let agents use the ChatGPT apps connected to this account."
                    control={
                      <Switch
                        defaultChecked={account.codexApps}
                        disabled={readOnly}
                        disabledReason={readOnly ? lockedReason : undefined}
                      />
                    }
                  />
                </SettingRowGroup>
              </DetailSection>
            </>
          ) : (
            <DetailSection
              title="Usage limit resets"
              description="Each reset gives this account a fresh weekly limit. Only you can redeem them."
            >
              {account.resets.length === 0 ? (
                <p className="text-sm text-fg-muted">No resets available right now.</p>
              ) : (
                <RowList label="Usage limit resets">
                  {account.resets.map((reset, index) => (
                    <ListRow
                      key={reset.id}
                      title={reset.label}
                      description={reset.expiresLabel}
                      control={
                        index === 0 && !readOnly ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 rounded-[10px] px-2.5 pointer-coarse:h-11"
                          >
                            Redeem
                          </Button>
                        ) : null
                      }
                    />
                  ))}
                </RowList>
              )}
            </DetailSection>
          )}
        </DetailPageBody>
      )}
    </DetailPage>
  );
}

function PageState({ height = 600, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="w-full overflow-auto rounded-[13px] bg-bg" style={{ height }}>
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The section.
   -------------------------------------------------------------------------- */

export default function DetailSheetSection() {
  const ops = codexWorkspaceAccounts[0]!;
  const platform = codexOrganizationAccounts[0]!;
  const longAccount: ModelAccount = {
    ...ops,
    name: "platform-automation-eu-north@acme-robotics-engineering.dev",
    plan: "ChatGPT Pro",
  };

  return (
    <KitSection sectionKey="detail-sheet">
      <Fork layout="stack">
        <Alternative id="a">
          <SheetFrame />
        </Alternative>
        <Alternative id="b">
          <PageFrame />
        </Alternative>
        <Alternative id="c">
          <InlineFrame />
        </Alternative>
      </Fork>

      <KitBlock
        title="Anatomy"
        description="DetailPage, DetailPageHeader, DetailPageBody and DetailAside from components/ui/detail-page.tsx. Back link, 40px tile, title with chips, a meta line, underline tabs, a main column and a quiet aside card."
      >
        <PagePreview label={`${ops.name} account page`} height={FRAME_HEIGHT}>
          <AccountPage account={ops} />
        </PagePreview>
      </KitBlock>

      <StatesGrid
        columns={2}
        description="The detail page (B), with the Codex account from Models."
      >
        <StateCell label="Loading" padding={false} align="stretch">
          <PageState>
            <DetailPage back={{ label: "Models", onClick: () => {} }}>
              <DetailSkeleton sections={3} />
            </DetailPage>
          </PageState>
        </StateCell>
        <StateCell
          label="Read-only"
          note="An organization account seen by a member: says who manages it, no ⋯ menu."
          padding={false}
          align="stretch"
        >
          <PageState>
            <AccountPage account={platform} state="readonly" />
          </PageState>
        </StateCell>
        <StateCell
          label="Couldn't load"
          note="What happened and what to do; the reference goes in Technical details."
          padding={false}
          align="stretch"
        >
          <PageState height={420}>
            <AccountPage account={ops} state="error" />
          </PageState>
        </StateCell>
        <StateCell
          label="Saving"
          note="Switches save on change: the switch spins and the header says so."
          padding={false}
          align="stretch"
        >
          <PageState height={420}>
            <AccountPage account={ops} state="saving" />
          </PageState>
        </StateCell>
        <StateCell
          label="Disconnect"
          note="Destructive actions live in the ⋯ menu and confirm in a small centered modal over the page."
          align="center"
        >
          <DestructiveConfirmPanel
            title={`Disconnect ${ops.name}?`}
            consequences={[
              "New work moves to research@acme.dev.",
              "Work already running finishes first.",
            ]}
            confirmLabel="Disconnect"
          />
        </StateCell>
        <StateCell
          label="Long text"
          note="Titles wrap; the actions stay on the right or drop under the title."
          padding={false}
          align="stretch"
        >
          <PageState height={420}>
            <AccountPage account={longAccount} />
          </PageState>
        </StateCell>
        <StateCell
          label="Mobile 390"
          note="The aside drops under the main column; tabs scroll sideways."
          padding={false}
          width="mobile"
          align="stretch"
          span="full"
        >
          <PageState>
            <AccountPage account={ops} />
          </PageState>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Anything you open: model accounts, people, API keys, schedules, variable sets, environments, knowledge entries, workspaces. Each is its own page in the content area.",
          'A back link to the list at the top: "← Models", "← Variable sets".',
          "Keep the page in the URL, for example /models/accounts/ops so people can link to it.",
          "Destructive actions in the ⋯ menu, confirmed in a small centered modal.",
        ]}
        avoid={[
          "Right-side sheets or panels, for anything.",
          "Expanding a row in place for anything with its own list.",
          "A card inside a section. The aside card is the only card on the page.",
          "More than one primary action in the header.",
        ]}
      />
    </KitSection>
  );
}
