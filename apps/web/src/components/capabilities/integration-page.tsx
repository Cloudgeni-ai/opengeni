import {
  CircleAlertIcon,
  FolderIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  UnplugIcon,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  OutcomeList,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import { integrationDisclosureElementId } from "@/components/capabilities/integration-sheet";
import { ConnectorToolPermissions } from "@opengeni/react/app/components/capabilities/connector-tool-permissions";
import {
  INTEGRATION_LOCKED_SENTENCE,
  type IntegrationAccess,
  type IntegrationAccessItem,
  type IntegrationFooter,
  type IntegrationOption,
  type IntegrationPolicyGrid,
  type IntegrationPolicyTable,
  type IntegrationSection,
  type IntegrationSectionRow,
  type IntegrationViewModel,
} from "@opengeni/react/app/components/capabilities/integration-view-model";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { Disclosure } from "@opengeni/react/ui/disclosure";
import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { Input } from "@opengeni/react/ui/input";
import { Notice } from "@opengeni/react/ui/notice";
import { Select } from "@opengeni/react/ui/select";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { Switch } from "@opengeni/react/ui/switch";
import { cn } from "@opengeni/react/app/lib/utils";

/* ----------------------------------------------------------------------------
   The page for an integration Opengeni runs itself (Slack bot, GitHub, Google
   Drive, Jira & Confluence sync, Outlook, OneDrive). Same view-model the old
   sheet rendered, laid out on the one Capabilities page anatomy: the connect
   or repair action in the header, Disconnect in the ⋯ menu, accounts and
   settings as flat sections, facts in the aside and tool names behind
   Technical details.
   -------------------------------------------------------------------------- */

function describedBy(disclosureId: string | undefined): string | undefined {
  return disclosureId ? integrationDisclosureElementId(disclosureId) : undefined;
}

export function IntegrationPage({
  model,
  onBack,
  backLabel,
  setupLabel,
  compactSettings = false,
  children,
}: {
  children?: ReactNode;
  compactSettings?: boolean;
  model: IntegrationViewModel;
  onBack: () => void;
  backLabel?: string;
  /** The verb for the setup action, "Add Opengeni to Slack". Defaults to "Connect <name>". */
  setupLabel?: string;
}) {
  const about = model.presentation?.summary;
  const asideItems = about
    ? [
        {
          label: compactSettings ? "Slack workspace" : "Connected to",
          value: about.title,
        },
        ...model.connection
          .filter((fact) => fact.label === "Installed")
          .map((fact) => ({ label: fact.label, value: fact.value })),
      ]
    : model.connection.map((fact) => ({ label: fact.label, value: fact.value }));
  return (
    <CapabilityPage
      onBack={onBack}
      backLabel={backLabel}
      mark={
        <CapabilityMark
          name={model.name}
          src={"logoSrc" in model.mark ? model.mark.logoSrc : null}
        />
      }
      title={model.name}
      status={model.chip.label}
      meta={["Built by Opengeni"]}
      actions={
        <IntegrationActions
          footer={model.footer}
          name={model.name}
          setupLabel={setupLabel ?? `Connect ${model.name}`}
        />
      }
      // No facts, no aside: an empty aside would still reserve its column.
      aside={
        asideItems.length > 0 ? <CapabilityAside name={model.name} items={asideItems} /> : undefined
      }
    >
      {model.notice ? (
        <DetailSection>
          <Notice
            tone={model.notice.tone}
            title={model.notice.title}
            action={
              model.notice.action || model.notice.onDismiss ? (
                <span className="flex flex-wrap gap-2">
                  {model.notice.action ? (
                    <RowButton
                      onClick={model.notice.action.onClick}
                      disabled={model.notice.action.disabled}
                    >
                      {model.notice.action.label}
                    </RowButton>
                  ) : null}
                  {model.notice.onDismiss ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="rounded-[10px] pointer-coarse:h-11"
                      onClick={model.notice.onDismiss}
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </span>
              ) : undefined
            }
          >
            {model.notice.description}
          </Notice>
        </DetailSection>
      ) : null}

      <DetailSection title="About">
        {about ? (
          <p className="m-0 text-sm leading-6 text-fg">{about.description}</p>
        ) : (
          <p className="m-0 text-sm leading-6 text-fg">{model.description}</p>
        )}
        {model.outcomes?.length ? (
          <div className="mt-4">
            <OutcomeList items={model.outcomes} />
          </div>
        ) : null}
        {model.footer.kind === "locked" && !model.access?.onEdit ? (
          <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
            {model.footer.message ?? INTEGRATION_LOCKED_SENTENCE}
          </p>
        ) : null}
      </DetailSection>

      {children}
      {model.sections?.map((section) => (
        <IntegrationSectionView key={section.id} section={section} />
      ))}
      {model.presentation?.routing ? (
        <DetailSection
          title={compactSettings ? "Work started from Slack" : "Where work starts"}
          description={model.presentation.routing.description}
          action={
            model.presentation.routing.action ? (
              <RowButton
                disabled={model.presentation.routing.action.disabled}
                onClick={model.presentation.routing.action.onClick}
              >
                {model.presentation.routing.action.label}
              </RowButton>
            ) : undefined
          }
        />
      ) : null}

      {model.policies ? <PolicySection table={model.policies} /> : null}
      {model.access ? <AccessSection access={model.access} /> : null}
      {model.toolPermissions ? (
        <DetailSection
          title="Approvals"
          description="Choose which actions run automatically and which need your review."
        >
          <ConnectorToolPermissions {...model.toolPermissions} bare />
        </DetailSection>
      ) : null}

      {model.options.length > 0 ? (
        compactSettings ? (
          <Disclosure title="More settings">
            <SettingRowGroup>
              {model.options.map((option) => (
                <OptionRow key={option.id} option={option} />
              ))}
            </SettingRowGroup>
          </Disclosure>
        ) : (
          <DetailSection title="Settings">
            <SettingRowGroup className="-my-3">
              {model.options.map((option) => (
                <OptionRow key={option.id} option={option} />
              ))}
            </SettingRowGroup>
          </DetailSection>
        )
      ) : null}

      {model.disclosures && model.disclosures.length > 0 ? (
        <DetailSection title="Your data">
          <div className="grid gap-2">
            {model.disclosures.map((disclosure) => (
              <p
                key={disclosure.id}
                id={integrationDisclosureElementId(disclosure.id)}
                className="m-0 text-xs leading-4.5 text-fg-muted"
              >
                {disclosure.text}
              </p>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <TechnicalDetails
        facts={(model.presentation?.diagnostics ?? []).map((fact) => ({
          label: fact.label,
          value: fact.value,
        }))}
        summary={
          model.tools?.tools.length
            ? `${model.tools.tools.length} tools${model.presentation?.diagnostics?.length ? ", connection details" : ""}`
            : undefined
        }
      >
        {model.tools && model.tools.tools.length > 0 ? (
          <div>
            <p className="m-0 text-xs leading-5 text-fg-muted">{model.tools.title ?? "Tools"}</p>
            <p className="mt-1 mb-0 font-mono text-xs leading-5 break-words text-fg">
              {model.tools.tools.join(", ")}
            </p>
          </div>
        ) : null}
      </TechnicalDetails>
    </CapabilityPage>
  );
}

/** One primary action and a ⋯ menu, from the adapter's closed footer set. */
function IntegrationActions({
  footer,
  name,
  setupLabel,
}: {
  footer: IntegrationFooter;
  name: string;
  setupLabel: string;
}) {
  const spinner = <Loader2Icon className="animate-spin" aria-hidden="true" />;
  if (footer.kind === "locked") return null;
  if (footer.kind === "setup") {
    return (
      <Button
        type="button"
        size="sm"
        className="rounded-[10px] pointer-coarse:h-11"
        disabled={footer.disabled || footer.busy}
        aria-describedby={describedBy(footer.disclosureId)}
        onClick={footer.onSetup}
      >
        {footer.busy ? spinner : null}
        {setupLabel}
      </Button>
    );
  }
  if (footer.kind === "actions") {
    const secondary = footer.secondary;
    return (
      <>
        {footer.primary ? (
          <Button
            type="button"
            size="sm"
            className="rounded-[10px] pointer-coarse:h-11"
            disabled={footer.primary.disabled || footer.busy}
            title={footer.primary.unavailableReason}
            aria-describedby={describedBy(footer.disclosureId)}
            onClick={footer.primary.onClick}
          >
            {footer.busy ? spinner : null}
            {footer.primary.label}
          </Button>
        ) : null}
        {secondary ? (
          secondary.destructive ? (
            <MoreMenu label={`More actions for ${name}`}>
              <DropdownMenuItem
                variant="destructive"
                disabled={secondary.disabled || footer.busy}
                onSelect={secondary.onClick}
              >
                {secondary.label}
              </DropdownMenuItem>
            </MoreMenu>
          ) : (
            <RowButton disabled={secondary.disabled || footer.busy} onClick={secondary.onClick}>
              {secondary.label}
            </RowButton>
          )
        ) : null}
      </>
    );
  }
  // connected / repair: Reconnect is the primary only when something broke.
  return (
    <>
      {footer.kind === "repair" ? (
        <Button
          type="button"
          size="sm"
          className="rounded-[10px] pointer-coarse:h-11"
          disabled={footer.reconnectDisabled || footer.busy}
          aria-describedby={describedBy(footer.disclosureId)}
          onClick={footer.onReconnect}
        >
          {footer.busy ? spinner : <RefreshCwIcon aria-hidden="true" />}
          Reconnect
        </Button>
      ) : footer.busy ? (
        <span role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
          {spinner}
          Working…
        </span>
      ) : null}
      <MoreMenu label={`More actions for ${name}`}>
        {footer.kind === "connected" ? (
          <DropdownMenuItem
            disabled={footer.reconnectDisabled || footer.busy}
            aria-describedby={describedBy(footer.disclosureId)}
            onSelect={footer.onReconnect}
          >
            <RefreshCwIcon />
            Reconnect
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          variant="destructive"
          disabled={footer.disconnectDisabled || footer.busy}
          onSelect={footer.onDisconnect}
        >
          <UnplugIcon />
          Disconnect
        </DropdownMenuItem>
      </MoreMenu>
    </>
  );
}

/** One named part of the integration: what it means, its state, one action. */
function IntegrationSectionView({ section }: { section: IntegrationSection }) {
  const action = section.action;
  return (
    <DetailSection
      title={section.title}
      description={section.description}
      action={
        action ? (
          action.primary ? (
            <Button
              type="button"
              size="sm"
              className="rounded-[10px] pointer-coarse:h-11"
              data-integration-section-action={section.id}
              disabled={action.disabled || action.busy}
              onClick={action.onClick}
            >
              {action.busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
              {action.label}
            </Button>
          ) : (
            <RowButton
              data-integration-section-action={section.id}
              disabled={action.disabled || action.busy}
              onClick={action.onClick}
            >
              {action.label}
            </RowButton>
          )
        ) : undefined
      }
    >
      {section.status || section.note ? (
        <div className="grid gap-1">
          {section.status ? (
            section.statusTone === "warn" ? (
              <p className="m-0 flex items-start gap-1.5 text-sm leading-5 text-status-waiting">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {section.status}
              </p>
            ) : (
              <p className="m-0 text-sm leading-5 text-fg">{section.status}</p>
            )
          ) : null}
          {section.note ? (
            <p className="m-0 text-xs leading-4.5 text-fg-muted">{section.note}</p>
          ) : null}
        </div>
      ) : null}
      {section.rows?.length ? (
        <ul
          data-integration-section-rows={section.id}
          className={cn(
            "m-0 list-none divide-y divide-border p-0",
            (section.status || section.note) && "mt-3",
          )}
        >
          {section.rows.map((row) => (
            <SectionRow key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </DetailSection>
  );
}

/** One thing a section manages: a status only when it needs attention, one action, a ⋯ menu. */
function SectionRow({ row }: { row: IntegrationSectionRow }) {
  const action = row.action;
  return (
    <li
      data-integration-row={row.id}
      data-attention={row.attention ? "" : undefined}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
    >
      <div className="min-w-0 grow basis-40">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="m-0 truncate text-sm leading-5 font-medium text-fg">{row.title}</p>
          {row.attention ? (
            <StatusBadge tone="attention" variant="tinted">
              {row.attention.label}
            </StatusBadge>
          ) : null}
        </div>
        {row.attention ? (
          <p className="m-0 mt-0.5 text-xs leading-4.5 text-fg-muted">{row.attention.detail}</p>
        ) : row.meta ? (
          <p className="m-0 text-xs leading-4.5 text-fg-muted">{row.meta}</p>
        ) : null}
      </div>
      {action || row.menu?.length ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {action ? (
            action.primary ? (
              <Button
                type="button"
                size="sm"
                className="rounded-[10px] pointer-coarse:h-11"
                aria-label={action.ariaLabel}
                disabled={action.disabled || action.busy}
                onClick={action.onClick}
              >
                {action.busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
                {action.label}
              </Button>
            ) : (
              <RowButton
                aria-label={action.ariaLabel}
                disabled={action.disabled || action.busy}
                onClick={action.onClick}
              >
                {action.label}
              </RowButton>
            )
          ) : null}
          {row.menu?.length ? (
            // Outlined like the page header's ⋯, so buttons and menus share one right edge.
            <MoreMenu label={`More actions for ${row.title}`}>
              {row.menu.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  variant={item.destructive ? "destructive" : "default"}
                  disabled={item.disabled}
                  onSelect={item.onClick}
                >
                  {item.label}
                </DropdownMenuItem>
              ))}
            </MoreMenu>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Approval choices as one compact grid, with finer overrides behind Advanced. */
function PolicySection({ table }: { table: IntegrationPolicyTable }) {
  return (
    <DetailSection title={table.title}>
      {table.failure ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-sm leading-5 text-fg-muted">{table.failure.message}</p>
          <RowButton onClick={table.failure.onRetry}>Retry</RowButton>
        </div>
      ) : (
        <>
          <PolicyGrid grid={table} />
          {table.note || table.footnote ? (
            <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
              {[table.note, table.footnote].filter(Boolean).join(" ")}
            </p>
          ) : null}
          {table.advanced ? (
            <Disclosure
              className="mt-2"
              title={table.advanced.title}
              summary={table.advanced.summary}
            >
              <PolicyGrid grid={table.advanced} />
            </Disclosure>
          ) : null}
        </>
      )}
    </DetailSection>
  );
}

function PolicyGrid({ grid }: { grid: IntegrationPolicyGrid }) {
  const cellSelect = (
    label: string,
    cell: ReturnType<IntegrationPolicyGrid["cell"]>,
    onChange: (value: string) => void,
  ) =>
    cell ? (
      <Select
        aria-label={label}
        aria-busy={cell.busy || undefined}
        value={cell.value}
        disabled={cell.disabled || cell.busy}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full min-w-0 rounded-[10px] bg-surface"
      >
        {grid.choices.some((choice) => choice.value === cell.value) ? null : (
          <option value={cell.value} disabled>
            {grid.otherValueLabels?.[cell.value] ?? cell.value}
          </option>
        )}
        {grid.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
    ) : null;
  // A grid, not a table: under 480px each row's label goes above its selects
  // so two columns still fit a phone. Every select names its row and column.
  // Narrow-only overrides use @max so no base utility from another style
  // sheet can outrank them.
  const rows = [
    ...(grid.all
      ? [
          {
            id: "all",
            label: grid.all.label,
            description: undefined,
            strong: true,
            cell: (columnId: string) => grid.all!.cell(columnId),
            onChange: (columnId: string, value: string) => grid.all!.onChange(columnId, value),
          },
        ]
      : []),
    ...grid.rows.map((row) => ({
      ...row,
      strong: false,
      cell: (columnId: string) => grid.cell(row.id, columnId),
      onChange: (columnId: string, value: string) => grid.onChange(row.id, columnId, value),
    })),
  ];
  return (
    <div className="@container min-w-0" data-integration-policy-grid="">
      <div
        className="grid grid-cols-[repeat(var(--policy-columns),minmax(0,1fr))] items-center gap-x-2 @min-[480px]:grid-cols-[minmax(0,1fr)_repeat(var(--policy-columns),9.5rem)]"
        style={{ "--policy-columns": grid.columns.length } as CSSProperties}
      >
        <span aria-hidden="true" className="@max-[480px]:hidden" />
        {grid.columns.map((column) => (
          <span
            key={column.id}
            aria-hidden="true"
            className="pb-2 text-xs leading-4.5 font-medium text-fg-muted"
          >
            {column.label}
          </span>
        ))}
        {rows.map((row) => (
          <div
            key={row.id}
            role="group"
            aria-label={row.label}
            data-integration-policy-row={row.id}
            className="col-span-full grid grid-cols-subgrid items-center gap-y-1.5 border-t border-border py-2.5"
          >
            <span className="min-w-0 @max-[480px]:col-span-full">
              <span className={cn("block text-sm leading-5 text-fg", row.strong && "font-medium")}>
                {row.label}
              </span>
              {row.description ? (
                <span className="block text-xs leading-4.5 text-fg-muted">{row.description}</span>
              ) : null}
            </span>
            {grid.columns.map((column) => (
              <span key={column.id} className="min-w-0 [&>span]:block [&>span]:w-full">
                {cellSelect(`${row.label}: ${column.label}`, row.cell(column.id), (value) =>
                  row.onChange(column.id, value),
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AccessSection({ access }: { access: IntegrationAccess }) {
  const [query, setQuery] = useState("");
  const collapsed = access.collapsed && access.items.length > 0 ? access.collapsed : null;
  const needle = query.trim().toLowerCase();
  const shown =
    collapsed && needle
      ? access.items.filter((item) =>
          `${item.name} ${item.meta ?? ""}`.toLowerCase().includes(needle),
        )
      : access.items;
  return (
    <DetailSection
      title={access.title}
      action={
        access.editLabel && access.onEdit ? (
          <RowButton
            onClick={access.onEdit}
            disabled={access.editDisabled}
            aria-describedby={describedBy(access.editDisclosureId)}
          >
            {access.editLabel}
          </RowButton>
        ) : undefined
      }
    >
      {access.items.length === 0 ? (
        <p className="m-0 text-sm leading-5 text-fg-muted">
          {access.emptyMessage ?? "Nothing selected yet."}
        </p>
      ) : collapsed ? (
        <Disclosure
          title={collapsed.summary}
          summary={accessSummary(access.items)}
          contentClassName="pl-0"
        >
          <div className="relative mb-3">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
            />
            <Input
              type="search"
              suppressAutofill
              aria-label={collapsed.searchLabel}
              placeholder={collapsed.searchLabel}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 rounded-[10px] bg-surface pl-9"
            />
          </div>
          {shown.length === 0 ? (
            <p className="m-0 text-sm leading-5 text-fg-muted">
              {collapsed.noMatchesMessage ?? "Nothing matches."}
            </p>
          ) : (
            <AccessItems items={shown} />
          )}
        </Disclosure>
      ) : (
        <AccessItems items={access.items} />
      )}
    </DetailSection>
  );
}

/** The first few names, so a folded list says what is inside. */
function accessSummary(items: IntegrationAccessItem[]): string {
  const names = items.slice(0, 3).map((item) => item.name);
  const rest = items.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
}

function AccessItems({ items }: { items: IntegrationAccessItem[] }) {
  return (
    <ul className="m-0 list-none divide-y divide-border p-0">
      {items.map((item, index) => (
        <li
          key={item.id ?? `${item.name}:${item.meta ?? ""}:${index}`}
          data-integration-access-item={item.id ?? item.name}
          className="min-w-0 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            {item.status ? (
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  item.status === "ok" ? "bg-status-idle" : "bg-status-waiting",
                )}
              />
            ) : (
              <FolderIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1 basis-40">
              <p className="m-0 truncate text-sm leading-5 font-medium text-fg">{item.name}</p>
              {item.meta ? (
                <p className="m-0 truncate text-xs leading-4.5 text-fg-muted">{item.meta}</p>
              ) : null}
            </div>
            {(item.actions ?? []).length ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                {item.actions!.map((itemAction) => (
                  <RowButton
                    key={itemAction.label}
                    onClick={itemAction.onClick}
                    disabled={itemAction.disabled}
                    aria-describedby={describedBy(itemAction.disclosureId)}
                    className={
                      itemAction.destructive ? "text-fg-muted hover:text-danger" : undefined
                    }
                  >
                    {itemAction.label}
                  </RowButton>
                ))}
              </div>
            ) : null}
          </div>
          {item.subItems && item.subItems.length === 0 && item.subItemsEmptyMessage ? (
            <p className="mt-2 mb-0 pl-5 text-xs leading-4.5 text-fg-muted">
              {item.subItemsEmptyMessage}
            </p>
          ) : null}
          {item.subItems && item.subItems.length > 0 ? (
            <ul className="mt-2 mb-0 grid list-none gap-1.5 p-0 pl-5">
              {item.subItems.map((sub) => (
                <li
                  key={`${sub.name}:${sub.meta ?? ""}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <FolderIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-xs leading-4.5 text-fg-muted">
                    {sub.name}
                  </span>
                  {sub.meta ? (
                    <span className="shrink-0 text-xs leading-4.5 text-fg-subtle">{sub.meta}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {item.detail ? <div className="mt-3 min-w-0">{item.detail}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export function OptionRow({ option }: { option: IntegrationOption }) {
  let control: ReactNode = null;
  if (option.kind === "toggle") {
    control = (
      <Switch
        checked={option.checked}
        pending={option.busy}
        disabled={option.disabled || option.busy}
        aria-describedby={describedBy(option.disclosureId)}
        onCheckedChange={(checked) => option.onChange(checked)}
      />
    );
  } else if (option.kind === "choice") {
    control = (
      <div className="w-[200px] max-w-full">
        <Select
          aria-label={option.label}
          aria-describedby={describedBy(option.disclosureId)}
          value={option.value}
          disabled={option.disabled || option.busy}
          onChange={(event) => option.onChange(event.target.value)}
          className="h-8 w-full min-w-[180px] rounded-[10px] bg-surface"
        >
          {option.choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </Select>
      </div>
    );
  } else {
    control = (
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <RowButton
          disabled={option.disabled}
          aria-label={option.action.ariaLabel}
          aria-describedby={describedBy(option.disclosureId)}
          onClick={option.action.onClick}
        >
          {option.action.label}
        </RowButton>
        {option.secondaryAction ? (
          <RowButton
            disabled={option.disabled}
            aria-label={option.secondaryAction.ariaLabel}
            onClick={option.secondaryAction.onClick}
            className={
              option.secondaryAction.destructive ? "text-fg-muted hover:text-danger" : undefined
            }
          >
            {option.secondaryAction.label}
          </RowButton>
        ) : null}
      </div>
    );
  }
  const secondary =
    option.kind !== "link" && option.action ? (
      <button
        type="button"
        onClick={option.action.onClick}
        disabled={option.disabled || option.busy}
        aria-describedby={describedBy(option.disclosureId)}
        className="rounded-sm text-xs font-medium og-link disabled:cursor-not-allowed disabled:opacity-50"
      >
        {option.action.label}
      </button>
    ) : undefined;
  return (
    <SettingRow
      label={option.label}
      description={option.description}
      control={control}
      controlWidth={option.kind === "choice" ? "auto" : "compact"}
      hint={secondary}
    />
  );
}
