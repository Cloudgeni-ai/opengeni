import { useState, type ReactNode } from "react";
import {
  CheckIcon,
  LockIcon,
  MinusCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailBody,
  DetailFact,
  DetailFacts,
  DetailFooter,
  DetailHeader,
  DetailSection,
  useDetailPresentation,
} from "@/components/ui/detail-sheet";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { Disclosure } from "@/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { UsageMeterGroup } from "@/components/ui/usage-meter";

import { KIT_NOW, KIT_TIME_ZONE, workspaces, you } from "../../fixtures";
import { ProviderTile } from "./marks";
import { useModelsPicks } from "./picks";
import {
  ORG_NAME,
  availabilitySummary,
  effectiveSource,
  findAccount,
  makePrimary,
  servedSummary,
  updateAccount,
  updateGateway,
  useModels,
  wait,
  type CodexAccount,
  type GatewayId,
  type Scope,
} from "./state";

/* ----------------------------------------------------------------------------
   The account detail: one place for everything about one model account. The
   same parts render in the sheet, the detail page, in place under a row, and
   in the kit's sheet preview; DetailHeader and friends adapt to where they are.
   -------------------------------------------------------------------------- */

const TIME = { now: KIT_NOW, timeZone: KIT_TIME_ZONE } as const;

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

function RowButton({
  children,
  onClick,
  label,
}: {
  children: ReactNode;
  onClick?: () => void;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={label}
      className="rounded-[10px] pointer-coarse:h-11"
    >
      {children}
    </Button>
  );
}

/**
 * Buttons ("Rename", "Make primary") stay in the right column when controls
 * sit on the right, and move under the text in the control-left list style,
 * where the leading column is only for switches.
 */
export function buttonWidth(variant: string): "compact" | "auto" {
  return variant === "control-left" ? "auto" : "compact";
}

/** The one-line "who manages this" note on a read-only account. */
function ManagedNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 py-4 text-xs leading-4.5 text-fg-muted">
      <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Where the account is used from the page being viewed. */
export interface AccountView {
  /** The settings area the page belongs to. */
  pageScope: Scope;
  /** Called when "Manage in organization settings" is chosen. */
  onManageInOrganization?: (id: string) => void;
  /** Called when the detail closes itself (Done, or after Disconnect). */
  onClose?: () => void;
}

export function accountStatus(
  account: CodexAccount,
  inUse: boolean,
): { status: "connected" | "paused" | "needs_reconnect"; label?: string; tone?: "neutral" } {
  if (account.needsReconnect) return { status: "needs_reconnect" };
  if (!account.useForNewWork) return { status: "paused" };
  if (!inUse) return { status: "connected", label: "Not in use", tone: "neutral" };
  return { status: "connected" };
}

/** The account belongs to the Codex pool new work uses right now. */
export function accountInUse(
  account: CodexAccount,
  context: Pick<ReturnType<typeof useModels>, "data" | "questions" | "scenario">,
): boolean {
  if (account.scope === "organization" && context.scenario.scope === "organization") return true;
  return effectiveSource(context.data, context.questions, context.scenario) === account.scope;
}

/* ----------------------------------------------------------------------------
   Codex account.
   -------------------------------------------------------------------------- */

export function CodexAccountDetail({
  scope,
  id,
  view,
  showHeader = true,
}: {
  scope: Scope;
  id: string;
  view: AccountView;
  showHeader?: boolean;
}) {
  const models = useModels();
  const { data, scenario } = models;
  const account = findAccount(data, scope, id);
  const presentation = useDetailPresentation();
  const picks = useModelsPicks();
  if (!account) {
    return (
      <DetailBody>
        <p className="py-10 text-center text-sm text-fg-muted">This account was disconnected.</p>
      </DetailBody>
    );
  }
  const readOnly = account.scope === "organization" && view.pageScope === "workspace";
  const orgAdmin = scenario.viewer === "org_admin";
  const status = accountStatus(account, accountInUse(account, models));

  return (
    <>
      {showHeader ? (
        <DetailHeader
          leading={<ProviderTile provider="codex" />}
          title={account.name}
          subtitle={`${account.plan} · ${account.scope === "organization" ? "Organization" : "Workspace"}`}
          // "Primary" is not repeated here: the Settings row below says it.
          status={
            <StatusBadge status={status.status} tone={status.tone} variant={picks.statusHeader}>
              {status.label}
            </StatusBadge>
          }
        />
      ) : null}
      <DetailBody>
        {readOnly ? (
          <ManagedNote>
            Managed by {ORG_NAME}.{" "}
            {orgAdmin
              ? "Change it in organization settings."
              : "Only organization admins can change it."}
          </ManagedNote>
        ) : null}
        <UsageSection account={account} />
        {readOnly ? <ReadOnlyFacts account={account} /> : <SettingsSection account={account} />}
        {account.scope === "organization" && !readOnly ? (
          <AvailabilitySection account={account} />
        ) : null}
        <ResetsSection account={account} readOnly={readOnly} />
        <TechnicalDetails account={account} />
      </DetailBody>
      <CodexFooter
        account={account}
        readOnly={readOnly}
        orgAdmin={orgAdmin}
        view={view}
        presentation={presentation}
      />
    </>
  );
}

export function PrimaryChip({
  account,
  variant,
}: {
  account: CodexAccount;
  variant: "text" | "outline" | "soft";
}) {
  const { data, questions } = useModels();
  const pool = account.scope === "organization" ? data.orgAccounts : data.workspaceAccounts;
  // "Primary" only means something when there is more than one account to pick from.
  if (!account.isPrimary || pool.length < 2) return null;
  return <MetaChip variant={variant}>{questions.q14 === "legacy" ? "Active" : "Primary"}</MetaChip>;
}

function UsageSection({ account }: { account: CodexAccount }) {
  const { setData } = useModels();
  const picks = useModelsPicks();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <DetailSection title="Usage">
      <UsageMeterGroup
        variant={picks.meter}
        windows={account.usage.map((window) => ({
          label: window.label,
          percent: window.percentLeft,
          resetsLabel: window.resetsLabel,
        }))}
        checked={<RelativeTime date={account.checkedAt} prefix="Checked" {...TIME} />}
        refreshing={refreshing}
        refreshDisabledReason={
          account.needsReconnect ? "Sign in to ChatGPT again to check usage." : undefined
        }
        onRefresh={async () => {
          setRefreshing(true);
          await wait(1100);
          setData((value) =>
            updateAccount(value, account.scope, account.id, { checkedAt: KIT_NOW }),
          );
          setRefreshing(false);
        }}
      />
    </DetailSection>
  );
}

function ReadOnlyFacts({ account }: { account: CodexAccount }) {
  return (
    <DetailSection title="Details">
      <DetailFacts>
        <DetailFact label="Available in">{availabilitySummary(account.availability)}</DetailFact>
        <DetailFact label="Models it can serve">{servedSummary(account.modelsServed)}</DetailFact>
        <DetailFact label="Use for new work">{account.useForNewWork ? "On" : "Off"}</DetailFact>
      </DetailFacts>
    </DetailSection>
  );
}

function SettingsSection({ account }: { account: CodexAccount }) {
  const { data, setData, questions, openDialog } = useModels();
  const picks = useModelsPicks();
  const [pending, setPending] = useState<"use" | "apps" | "primary" | null>(null);
  const legacy = questions.q14 === "legacy";
  const pool = account.scope === "organization" ? data.orgAccounts : data.workspaceAccounts;
  const switchProps = { variant: picks.switchVariant, showStateText: picks.switchStateText };

  const save = async (
    key: "use" | "apps" | "primary",
    patch: () => void,
    message: string,
  ): Promise<void> => {
    setPending(key);
    await wait(700);
    patch();
    setPending(null);
    toast.success(message);
  };

  return (
    <DetailSection title="Settings">
      <SettingRowGroup className="-my-3">
        <SettingRow
          variant={picks.settingRow}
          label={legacy ? "Use for new automatic turns" : "Use for new work"}
          description={
            legacy
              ? "Enabled accounts can be picked for new automatic turns."
              : "When off, this account isn't picked for new chats, schedules or sessions pinned to it. Work already running continues."
          }
          control={
            <Switch
              {...switchProps}
              checked={account.useForNewWork}
              pending={pending === "use"}
              onCheckedChange={(next) =>
                void save(
                  "use",
                  () =>
                    setData((value) =>
                      updateAccount(value, account.scope, account.id, { useForNewWork: next }),
                    ),
                  next
                    ? `${account.name} is used for new work again`
                    : `${account.name} won't be used for new work`,
                )
              }
            />
          }
        />
        {pool.length > 1 ? (
          <SettingRow
            variant={picks.settingRow}
            controlWidth={buttonWidth(picks.settingRow)}
            label={legacy ? "Active account" : "Primary account"}
            description={
              account.isPrimary
                ? legacy
                  ? "Used when a session isn't pinned and Auto-rotate is off."
                  : "New work starts here. With Primary only, it's the only account used."
                : legacy
                  ? "Make this the account unpinned sessions use."
                  : "Make this the account new work starts with."
            }
            control={
              account.isPrimary ? (
                <span className="inline-flex h-8 items-center gap-1.5 text-sm font-medium text-fg-muted">
                  <CheckIcon aria-hidden="true" className="size-4 text-status-idle" />
                  {legacy ? "Active" : "Primary"}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending === "primary"}
                  onClick={() =>
                    void save(
                      "primary",
                      () => setData((value) => makePrimary(value, account.scope, account.id)),
                      `${account.name} is now the ${legacy ? "active" : "primary"} account`,
                    )
                  }
                  className="rounded-[10px] pointer-coarse:h-11"
                >
                  {legacy ? "Make active" : "Make primary"}
                </Button>
              )
            }
          />
        ) : null}
        <SettingRow
          variant={picks.settingRow}
          label="Codex Apps"
          description="Let agents use the ChatGPT apps connected to this account."
          control={
            <Switch
              {...switchProps}
              checked={account.codexApps}
              pending={pending === "apps"}
              onCheckedChange={(next) =>
                void save(
                  "apps",
                  () =>
                    setData((value) =>
                      updateAccount(value, account.scope, account.id, { codexApps: next }),
                    ),
                  next ? "Codex Apps turned on" : "Codex Apps turned off",
                )
              }
            />
          }
        />
        <SettingRow
          variant={picks.settingRow}
          controlWidth={buttonWidth(picks.settingRow)}
          label="Name"
          description={account.name}
          control={
            <RowButton
              label={`Rename ${account.name}`}
              onClick={() => openDialog({ kind: "rename", scope: account.scope, id: account.id })}
            >
              <PencilIcon aria-hidden="true" />
              Rename
            </RowButton>
          }
        />
        {account.scope === "workspace" ? (
          <ServedRow kind="codex" scope={account.scope} id={account.id} />
        ) : null}
      </SettingRowGroup>
    </DetailSection>
  );
}

function AvailabilitySection({ account }: { account: CodexAccount }) {
  const { setData } = useModels();
  const picks = useModelsPicks();
  const availability = account.availability ?? {
    allShared: true,
    workspaces: [],
    personal: true,
  };
  const switchProps = { variant: picks.switchVariant, showStateText: picks.switchStateText };
  const setAvailability = (patch: Partial<typeof availability>, message: string) => {
    setData((value) =>
      updateAccount(value, account.scope, account.id, {
        availability: { ...availability, ...patch },
      }),
    );
    toast.success(message);
  };
  return (
    <DetailSection
      title="Access"
      description="Which workspaces can use this account, and for which models."
    >
      <SettingRowGroup className="-my-3">
        <SettingRow
          variant={picks.settingRow}
          label="All shared workspaces"
          description="Includes workspaces created later."
          control={
            <Switch
              {...switchProps}
              checked={availability.allShared}
              onCheckedChange={(next) =>
                setAvailability(
                  { allShared: next },
                  next
                    ? `${account.name} is available in every shared workspace`
                    : "Choose the workspaces that can use it",
                )
              }
            />
          }
        >
          {availability.allShared
            ? null
            : workspaces.map((workspace) => {
                const on = availability.workspaces.includes(workspace.id);
                return (
                  <SettingRow
                    key={workspace.id}
                    variant={picks.settingRow}
                    label={workspace.name}
                    control={
                      <Switch
                        {...switchProps}
                        size="sm"
                        checked={on}
                        onCheckedChange={(next) =>
                          setAvailability(
                            {
                              workspaces: next
                                ? [...availability.workspaces, workspace.id]
                                : availability.workspaces.filter((each) => each !== workspace.id),
                            },
                            next
                              ? `${workspace.name} can use ${account.name}`
                              : `${workspace.name} can't use ${account.name} for new work`,
                          )
                        }
                      />
                    }
                  />
                );
              })}
        </SettingRow>
        <SettingRow
          variant={picks.settingRow}
          label="Personal workspaces"
          description="Everyone's private Personal workspace can use it too."
          control={
            <Switch
              {...switchProps}
              checked={availability.personal}
              onCheckedChange={(next) =>
                setAvailability(
                  { personal: next },
                  next
                    ? "Personal workspaces can use it"
                    : "Personal workspaces can't use it for new work",
                )
              }
            />
          }
        />
        <ServedRow kind="codex" scope={account.scope} id={account.id} />
      </SettingRowGroup>
    </DetailSection>
  );
}

/** "Models it can serve": at organization scope always, in workspaces only for question 15's other answer. */
function ServedRow({ kind, scope, id }: { kind: "codex" | "gateway"; scope: Scope; id: string }) {
  const { data, questions, openAllowed } = useModels();
  const picks = useModelsPicks();
  if (scope === "workspace" && questions.q15 === "org_only") return null;
  const served =
    kind === "codex"
      ? (findAccount(data, scope, id)?.modelsServed ?? "all")
      : data.gateways[scope][id as GatewayId].modelsServed;
  return (
    <SettingRow
      variant={picks.settingRow}
      controlWidth={buttonWidth(picks.settingRow)}
      label="Models it can serve"
      description={
        scope === "organization"
          ? servedSummary(served)
          : `${servedSummary(served)}. Allowed models for the workspace still apply.`
      }
      control={
        <RowButton onClick={() => openAllowed({ kind: "account", scope, id })}>Edit</RowButton>
      }
    />
  );
}

function ResetsSection({ account, readOnly }: { account: CodexAccount; readOnly: boolean }) {
  const { openDialog, scenario } = useModels();
  const picks = useModelsPicks();
  if (account.resets.length === 0) return null;
  const yours = account.connectedBy === you.name && scenario.viewer === "org_admin";
  const weekly = account.usage.find((window) => window.label === "Weekly");
  const worthRedeeming = weekly?.percentLeft !== null && (weekly?.percentLeft ?? 100) < 100;
  const who = yours ? "Only you can redeem them" : `Only ${account.connectedBy} can redeem them`;
  return (
    <DetailSection
      title={`Usage limit resets (${account.resets.length})`}
      description={`Each gives this account a fresh weekly limit. ${who}, as the person who connected it.`}
    >
      {/* The resets differ only in when they expire, so that is each row's label.
          Redeem uses the one that expires first. */}
      <SettingRowGroup className="-my-3" role="list" aria-label="Usage limit resets">
        {account.resets.map((reset, index) => (
          <SettingRow
            key={reset.id}
            role="listitem"
            variant={picks.settingRow}
            controlWidth={buttonWidth(picks.settingRow)}
            label={reset.expiresLabel}
            control={
              index === 0 && yours && !readOnly && worthRedeeming ? (
                <RowButton
                  label={`Redeem a usage limit reset for ${account.name}`}
                  onClick={() =>
                    openDialog({ kind: "redeem", scope: account.scope, id: account.id })
                  }
                >
                  Redeem
                </RowButton>
              ) : null
            }
          />
        ))}
      </SettingRowGroup>
    </DetailSection>
  );
}

function TechnicalDetails({ account }: { account: CodexAccount }) {
  const picks = useModelsPicks();
  return (
    <div className="py-3">
      <Disclosure
        variant={picks.disclosure}
        title="Technical details"
        summary="Account ID, who connected it"
        sheetDescription={account.name}
      >
        <DetailFacts className="pb-2">
          <DetailFact label="Account ID">
            <CopyField value={account.accountId} label="account ID" />
          </DetailFact>
          <DetailFact label="Connected by">
            {account.connectedBy} · {account.connectedOn}
          </DetailFact>
        </DetailFacts>
      </Disclosure>
    </div>
  );
}

function CodexFooter({
  account,
  readOnly,
  orgAdmin,
  view,
  presentation,
}: {
  account: CodexAccount;
  readOnly: boolean;
  orgAdmin: boolean;
  view: AccountView;
  presentation: string;
}) {
  const { openDialog } = useModels();
  const closable =
    (presentation === "sheet" || presentation === "preview") && Boolean(view.onClose);
  const start = readOnly ? (
    orgAdmin && view.onManageInOrganization ? (
      <Button
        type="button"
        variant="ghost"
        onClick={() => view.onManageInOrganization?.(account.id)}
        className="-ml-3 text-brand hover:bg-brand/10 hover:text-brand pointer-coarse:h-11"
      >
        Manage in organization settings
      </Button>
    ) : null
  ) : (
    <DangerGhost
      onClick={() =>
        openDialog({
          kind: "disconnect",
          target: { kind: "codex", scope: account.scope, id: account.id },
        })
      }
    >
      Disconnect
    </DangerGhost>
  );
  if (!start && !closable) return null;
  return (
    <DetailFooter start={start}>
      {closable ? (
        <Button
          type="button"
          variant="outline"
          onClick={view.onClose}
          className="pointer-coarse:h-11"
        >
          Done
        </Button>
      ) : null}
    </DetailFooter>
  );
}

/* ----------------------------------------------------------------------------
   API-key providers (OpenRouter, Vercel AI Gateway).
   -------------------------------------------------------------------------- */

export function GatewayDetail({
  scope,
  id,
  view,
  showHeader = true,
}: {
  scope: Scope;
  id: GatewayId;
  view: AccountView;
  showHeader?: boolean;
}) {
  const { data, setData, openDialog, questions } = useModels();
  const picks = useModelsPicks();
  const presentation = useDetailPresentation();
  const gateway = data.gateways[scope][id];
  const closable =
    (presentation === "sheet" || presentation === "preview") && Boolean(view.onClose);
  if (!gateway.connected) {
    return (
      <DetailBody>
        <p className="py-10 text-center text-sm text-fg-muted">{gateway.name} was disconnected.</p>
      </DetailBody>
    );
  }
  const removeModel = (slug: string) => {
    const before = gateway.customModels;
    setData((value) =>
      updateGateway(value, scope, id, {
        customModels: before.filter((each) => each !== slug),
      }),
    );
    showUndoToast({
      title: `Removed ${slug}`,
      description: "Agents can't pick it for new work.",
      onUndo: () => setData((value) => updateGateway(value, scope, id, { customModels: before })),
    });
  };
  return (
    <>
      {showHeader ? (
        <DetailHeader
          leading={<ProviderTile provider={id} />}
          title={gateway.name}
          subtitle={`API key · ${scope === "organization" ? "Organization" : "Workspace"}`}
          status={<StatusBadge status="connected" variant={picks.statusHeader} />}
        />
      ) : null}
      <DetailBody>
        <DetailSection title="Key">
          <SettingRowGroup className="-my-3">
            <SettingRow
              variant={picks.settingRow}
              controlWidth={buttonWidth(picks.settingRow)}
              label={`Key ending ${gateway.keyHint ?? ""}`}
              description={`Added ${gateway.connectedOn ?? "just now"}. Stored encrypted; nobody can read it back.`}
              control={
                <RowButton onClick={() => openDialog({ kind: "replace-key", scope, id })}>
                  Replace key
                </RowButton>
              }
            />
          </SettingRowGroup>
        </DetailSection>
        <DetailSection
          title="Custom models"
          description="Extra model IDs agents can pick, billed to this key."
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openDialog({ kind: "add-model", scope, id })}
              className="-mr-2 rounded-[10px] pointer-coarse:h-11"
            >
              <PlusIcon aria-hidden="true" />
              Add model
            </Button>
          }
        >
          {gateway.customModels.length === 0 ? (
            <EmptyState
              variant="inline"
              title="No custom models yet."
              description="Add a model ID so agents can pick it for new work."
            />
          ) : (
            // Flush rows like the settings above them: the IDs line up with the
            // section title and the hairlines match the sheet's other rows.
            <SettingRowGroup
              className="-my-3"
              role="list"
              aria-label={`Custom models on ${gateway.name}`}
            >
              {gateway.customModels.map((slug) => (
                <SettingRow
                  key={slug}
                  role="listitem"
                  // A row menu, not a setting: it stays at the row's end in every style.
                  variant="control-right"
                  label={<span className="font-mono text-xs font-normal">{slug}</span>}
                  control={
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`More actions for ${slug}`}
                          className="-mr-1.5 rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onSelect={() => removeModel(slug)}>
                          <MinusCircleIcon />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              ))}
            </SettingRowGroup>
          )}
        </DetailSection>
        {scope === "organization" || questions.q15 === "everywhere" ? (
          <DetailSection title="Access">
            <SettingRowGroup className="-my-3">
              <ServedRow kind="gateway" scope={scope} id={id} />
            </SettingRowGroup>
          </DetailSection>
        ) : null}
      </DetailBody>
      <DetailFooter
        start={
          <DangerGhost
            onClick={() =>
              openDialog({ kind: "disconnect", target: { kind: "gateway", scope, id } })
            }
          >
            Disconnect
          </DangerGhost>
        }
      >
        {closable ? (
          <Button
            type="button"
            variant="outline"
            onClick={view.onClose}
            className="pointer-coarse:h-11"
          >
            Done
          </Button>
        ) : null}
      </DetailFooter>
    </>
  );
}
