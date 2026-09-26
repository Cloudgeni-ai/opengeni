import { useState, type ReactNode } from "react";
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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailBody,
  DetailFact,
  DetailFacts,
  DetailFooter,
  DetailFooterConfirm,
  DetailHeader,
  DetailInline,
  DetailPage,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
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
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageMeter } from "@/components/ui/usage-meter";
import { cn } from "@/lib/utils";

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

function VariableSetDetail({ set }: { set: VariableSet }) {
  const presentation = useDetailPresentation();
  const page = presentation === "page";
  const inline = presentation === "inline";
  const addVariable = (
    <Button
      type="button"
      variant={page ? "default" : "outline"}
      size={page ? "default" : "sm"}
      className={cn(!page && "h-7 rounded-[10px] px-2.5", "pointer-coarse:h-11")}
    >
      <PlusIcon />
      Add variable
    </Button>
  );
  const menu = (
    <MoreMenu label={`More actions for ${set.name}`}>
      <DropdownMenuItem>
        <PencilIcon />
        Edit name and description
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">
        <Trash2Icon />
        Delete variable set
      </DropdownMenuItem>
    </MoreMenu>
  );

  return (
    <>
      {inline ? null : (
        <DetailHeader
          leading={<LogoTile icon={<BracesIcon />} />}
          title={set.name}
          subtitle={set.description}
          status={set.scopeLabel ? <MetaChip variant="outline">{set.scopeLabel}</MetaChip> : null}
          actions={
            page ? (
              <>
                {addVariable}
                {menu}
              </>
            ) : (
              menu
            )
          }
        />
      )}
      <DetailBody>
        <DetailSection
          title={`Variables (${set.variables.length})`}
          description={
            inline ? undefined : "Secrets are write-only. Agents get them in their sandbox."
          }
          action={page ? null : addVariable}
        >
          <VariablesList set={set} table={page} />
        </DetailSection>
        <DetailSection title="Used by">
          <UsedByList set={set} />
        </DetailSection>
        {inline ? null : (
          <DetailSection title="Details">
            <DetailFacts>
              <DetailFact label="Available to">
                {set.scope === "organization"
                  ? `Everyone in ${organization.name}`
                  : `Everyone in ${currentWorkspace.name}`}
              </DetailFact>
              <DetailFact label="Last change">
                <RelativeTime date={set.updatedAt} {...TIME} />
              </DetailFact>
              <DetailFact label="Variable set ID">
                <CopyField value={set.id} label="variable set ID" />
              </DetailFact>
            </DetailFacts>
          </DetailSection>
        )}
      </DetailBody>
      {page || inline ? null : (
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
                    <VariableSetDetail set={set} />
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

/** A: the list stays in view; the sheet opens over it. */
function SheetFrame() {
  const [openId, setOpenId] = useState<string | null>(variableSets[0]!.id);
  const [realOpen, setRealOpen] = useState(false);
  const set = variableSets.find((each) => each.id === openId) ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PagePreview label="Variable sets with a detail sheet" height={FRAME_HEIGHT}>
        <div className="relative h-full min-w-0">
          <div className="h-full overflow-auto">
            <VariableSetsPage selectedId={openId} onOpen={setOpenId} />
          </div>
          {set ? (
            <>
              <button
                type="button"
                tabIndex={-1}
                aria-label="Close details"
                onClick={() => setOpenId(null)}
                className="absolute inset-0 z-10 cursor-default bg-black/50"
              />
              <DetailSheetPreview
                label={set.name}
                onClose={() => setOpenId(null)}
                className="absolute inset-y-0 right-0 z-20 max-w-[min(520px,100%)]"
              >
                <VariableSetDetail set={set} />
              </DetailSheetPreview>
            </>
          ) : null}
        </div>
      </PagePreview>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-4.5 text-fg-subtle">
        Click a row to show its sheet in the frame.
        <button
          type="button"
          onClick={() => setRealOpen(true)}
          className="rounded-[6px] font-medium text-brand hover:underline pointer-coarse:min-h-11"
        >
          Open the real sheet
        </button>
      </p>
      <DetailSheet open={realOpen} onOpenChange={setRealOpen}>
        <DetailSheetContent>
          <VariableSetDetail set={variableSets[0]!} />
        </DetailSheetContent>
      </DetailSheet>
    </div>
  );
}

/** B: the row navigates to its own page. */
function PageFrame() {
  const set = variableSets[0]!;
  return (
    <PagePreview label={`${set.name} detail page`} height={FRAME_HEIGHT}>
      <DetailPage back={{ label: "Variable sets", onClick: () => {} }}>
        <VariableSetDetail set={set} />
      </DetailPage>
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
   The account sheet (brief sample content), for the states.
   -------------------------------------------------------------------------- */

type AccountState = "default" | "readonly" | "saving" | "confirm" | "error";

function AccountDetail({
  account,
  state = "default",
}: {
  account: ModelAccount;
  state?: AccountState;
}) {
  const readOnly = state === "readonly";
  const weekly = account.usage.find((window) => window.label === "Weekly");
  const fiveHour = account.usage.find((window) => window.label === "5-hour");
  const lockedReason = `Managed by ${organization.name}. Only organization admins can change it.`;

  return (
    <>
      <DetailHeader
        leading={<LogoTile name="Codex" monogram="C" />}
        title={account.name}
        subtitle={`${account.plan} · ${account.sourceLabel}`}
        status={
          <>
            <StatusBadge status={account.state === "paused" ? "paused" : "connected"} />
            {account.isPrimary ? (
              <MetaChip variant="outline" icon={<StarIcon />}>
                Primary
              </MetaChip>
            ) : null}
          </>
        }
        actions={
          readOnly ? null : (
            <MoreMenu label={`More actions for ${account.name}`}>
              <DropdownMenuItem>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={account.isPrimary}>
                <StarIcon />
                Make primary
              </DropdownMenuItem>
            </MoreMenu>
          )
        }
      />
      {state === "error" ? (
        <DetailBody>
          <div className="py-10">
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
        </DetailBody>
      ) : (
        <DetailBody>
          {readOnly ? (
            <p className="flex items-start gap-2 py-4 text-xs leading-4.5 text-fg-muted">
              <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
              {lockedReason}
            </p>
          ) : null}
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
          {account.resets.length > 0 ? (
            <DetailSection
              title={`Usage limit resets (${account.resets.length})`}
              description="Each reset gives this account a fresh weekly limit. Only you can redeem them."
            >
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
            </DetailSection>
          ) : null}
          <DetailSection title="Models">
            <DetailFacts>
              <DetailFact
                label="Can serve"
                action={
                  readOnly ? null : (
                    <Button type="button" variant="ghost" size="sm" className="-mr-2 h-7">
                      Edit
                    </Button>
                  )
                }
              >
                {account.modelsServedLabel === "All" ? "All models" : account.modelsServedLabel}
              </DetailFact>
              {account.availableInLabel ? (
                <DetailFact label="Available in">{account.availableInLabel}</DetailFact>
              ) : null}
            </DetailFacts>
          </DetailSection>
        </DetailBody>
      )}
      {state === "confirm" ? (
        <DetailFooterConfirm
          title={`Disconnect ${account.name}?`}
          description="New work moves to research@acme.dev. Work already running finishes first."
          confirmLabel="Disconnect"
        />
      ) : (
        <DetailFooter
          start={
            state === "saving" ? (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-xs text-fg-muted"
              >
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-3.5 motion-safe:animate-spin"
                />
                Saving
              </span>
            ) : readOnly || state === "error" ? null : (
              <DangerGhost>Disconnect</DangerGhost>
            )
          }
        >
          <Button type="button" variant="outline" className="pointer-coarse:h-11">
            Done
          </Button>
        </DetailFooter>
      )}
    </>
  );
}

function SheetState({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DetailSheetPreview
      label={label}
      // The cell is the sheet's frame: the panel fills it and follows its corners.
      className="h-[600px] max-w-none overflow-hidden rounded-[13px] border-l-0 shadow-none"
      onClose={() => {}}
    >
      {children}
    </DetailSheetPreview>
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

      <StatesGrid
        columns={2}
        description="The recommended right sheet (A), with the Codex account from Models."
      >
        <StateCell label="Default" padding={false} align="stretch" canvas="bg">
          <SheetState label={ops.name}>
            <AccountDetail account={ops} />
          </SheetState>
        </StateCell>
        <StateCell label="Loading" padding={false} align="stretch">
          <SheetState label="Loading account">
            <DetailSkeleton sections={3} />
          </SheetState>
        </StateCell>
        <StateCell
          label="Read-only"
          note="An organization account seen by a member: says who manages it, no destructive action."
          padding={false}
          align="stretch"
        >
          <SheetState label={platform.name}>
            <AccountDetail account={platform} state="readonly" />
          </SheetState>
        </StateCell>
        <StateCell
          label="Couldn't load"
          note="What happened and what to do; the reference goes in Technical details."
          padding={false}
          align="stretch"
        >
          <SheetState label={ops.name}>
            <AccountDetail account={ops} state="error" />
          </SheetState>
        </StateCell>
        <StateCell
          label="Saving"
          note="Switches save on change: the switch spins and the footer says so."
          padding={false}
          align="stretch"
        >
          <SheetState label={ops.name}>
            <AccountDetail account={ops} state="saving" />
          </SheetState>
        </StateCell>
        <StateCell
          label="Destructive confirm"
          note="The footer asks with the real name and the real consequence."
          padding={false}
          align="stretch"
        >
          <SheetState label={ops.name}>
            <AccountDetail account={ops} state="confirm" />
          </SheetState>
        </StateCell>
        <StateCell
          label="Long text"
          note="Titles wrap; nothing overlaps the ⋯ and close buttons."
          padding={false}
          align="stretch"
        >
          <SheetState label={longAccount.name}>
            <AccountDetail account={longAccount} />
          </SheetState>
        </StateCell>
        <StateCell
          label="Mobile 390"
          note="Full screen on phones; fact rows stack; the footer stays reachable."
          padding={false}
          width="mobile"
          align="stretch"
        >
          <SheetState label={ops.name}>
            <AccountDetail account={ops} />
          </SheetState>
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "One object with a few settings and a short sub-list: model accounts, people, API keys, schedules (sheet).",
          "Objects with their own table of 10 to 100 rows: variable sets, sandbox environments (page).",
          "Any detail people link to. Keep the sheet in the URL, for example ?account=ops.",
        ]}
        avoid={[
          "Create and edit forms: use a form dialog or form sheet.",
          "Expanding a row in place for anything with its own list.",
          "A card inside a section, or a sheet opened from a sheet.",
          "More than one primary action in the footer.",
        ]}
      />
    </KitSection>
  );
}
