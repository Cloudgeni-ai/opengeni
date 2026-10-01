import { FolderIcon, Loader2Icon, RefreshCwIcon, UnplugIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  OutcomeList,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import { integrationDisclosureElementId } from "@/components/capabilities/integration-sheet";
import {
  INTEGRATION_LOCKED_SENTENCE,
  type IntegrationAccess,
  type IntegrationFooter,
  type IntegrationOption,
  type IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   The page for an integration OpenGeni runs itself (Slack bot, GitHub, Google
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
}: {
  model: IntegrationViewModel;
  onBack: () => void;
  backLabel?: string;
  /** The verb for the setup action, "Add OpenGeni to Slack". Defaults to "Connect <name>". */
  setupLabel?: string;
}) {
  const about = model.presentation?.summary;
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
      aside={
        <CapabilityAside
          name={model.name}
          items={
            about
              ? [
                  { label: "Connected to", value: about.title },
                  ...model.connection
                    .filter((fact) => fact.label === "Installed")
                    .map((fact) => ({ label: fact.label, value: fact.value })),
                ]
              : model.connection.map((fact) => ({ label: fact.label, value: fact.value }))
          }
        />
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

      {model.presentation?.routing ? (
        <DetailSection
          title="Where work starts"
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

      {model.access ? <AccessSection access={model.access} /> : null}

      {model.options.length > 0 ? (
        <DetailSection title="Settings">
          <SettingRowGroup className="-my-3">
            {model.options.map((option) => (
              <OptionRow key={option.id} option={option} />
            ))}
          </SettingRowGroup>
        </DetailSection>
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

function AccessSection({ access }: { access: IntegrationAccess }) {
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
      ) : (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {access.items.map((item, index) => (
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
                        <span className="shrink-0 text-xs leading-4.5 text-fg-subtle">
                          {sub.meta}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.detail ? <div className="mt-3 min-w-0">{item.detail}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function OptionRow({ option }: { option: IntegrationOption }) {
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
      <RowButton
        disabled={option.disabled}
        aria-describedby={describedBy(option.disclosureId)}
        onClick={option.action.onClick}
      >
        {option.action.label}
      </RowButton>
    );
  }
  const secondary =
    option.kind !== "link" && option.action ? (
      <button
        type="button"
        onClick={option.action.onClick}
        disabled={option.disabled || option.busy}
        aria-describedby={describedBy(option.disclosureId)}
        className="rounded-sm text-xs font-medium text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-50"
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
