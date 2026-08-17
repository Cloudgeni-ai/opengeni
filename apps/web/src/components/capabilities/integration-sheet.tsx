import { FolderIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

import {
  IntegrationChipView,
  IntegrationMarkView,
} from "@/components/capabilities/integration-row";
import {
  INTEGRATION_LOCKED_SENTENCE,
  type IntegrationAccess,
  type IntegrationFact,
  type IntegrationFooter,
  type IntegrationOption,
  type IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The one detail sheet for every integration. Four blocks in a fixed order
 * (Connection, Access, Options, Action); empty blocks are omitted and there is
 * no provider-specific branch here. Deep provider dialogs live behind the
 * Access block's single edit affordance or an option's action link.
 */
export function IntegrationSheet({
  model,
  open,
  onOpenChange,
}: {
  model: IntegrationViewModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 border-border bg-bg p-0 sm:max-w-[32rem]"
        aria-labelledby={model ? `integration-sheet-title-${model.id}` : undefined}
      >
        {model ? <IntegrationSheetBody model={model} /> : null}
      </SheetContent>
    </Sheet>
  );
}

/** The sheet's content: header, the four blocks in fixed order, and the footer. */
export function IntegrationSheetBody({ model }: { model: IntegrationViewModel }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-integration-sheet={model.id}
      role="region"
      aria-label={`${model.name} settings`}
    >
      <SheetHeader className="flex-row items-center gap-3 border-b border-border px-5 py-4 pr-12">
        <IntegrationMarkView mark={model.mark} name={model.name} />
        <div className="min-w-0 flex-1">
          <SheetTitle
            id={`integration-sheet-title-${model.id}`}
            className="truncate text-base text-fg"
          >
            {model.name}
          </SheetTitle>
          <SheetDescription className="truncate text-xs text-fg-muted">
            {model.description}
          </SheetDescription>
        </div>
        <IntegrationChipView chip={model.chip} />
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {model.notice ? (
          <Notice tone={model.notice.tone} title={model.notice.title}>
            {model.notice.description}
          </Notice>
        ) : null}
        {model.connection.length > 0 ? (
          <Block title="Connection">
            <ConnectionFacts facts={model.connection} />
          </Block>
        ) : null}
        {model.access ? <AccessBlock access={model.access} /> : null}
        {model.options.length > 0 ? (
          <Block title="Options">
            <div className="space-y-2">
              {model.options.map((option) => (
                <OptionRow key={option.id} option={option} />
              ))}
            </div>
          </Block>
        ) : null}
      </div>

      <IntegrationFooterView footer={model.footer} />
    </div>
  );
}

function Block({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ConnectionFacts({ facts }: { facts: IntegrationFact[] }) {
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {facts.map((fact) => (
        <div
          key={`${fact.label}:${fact.value}`}
          className="flex items-start justify-between gap-4 px-3 py-2 text-xs"
        >
          <dt className="shrink-0 text-fg-muted">{fact.label}</dt>
          <dd className="min-w-0 break-words text-right font-medium text-fg">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AccessBlock({ access }: { access: IntegrationAccess }) {
  return (
    <Block
      title={access.title}
      action={
        access.editLabel && access.onEdit ? (
          <button
            type="button"
            onClick={access.onEdit}
            className="text-xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-sm"
          >
            {access.editLabel}
          </button>
        ) : null
      }
    >
      {access.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-fg-muted">
          {access.emptyMessage ?? "Nothing selected yet."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {access.items.map((item) => (
            <li
              key={`${item.name}:${item.meta ?? ""}`}
              className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs"
            >
              <FolderIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium text-fg">{item.name}</span>
              {item.meta ? (
                <span className="shrink-0 text-2xs text-fg-subtle">{item.meta}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function OptionRow({ option }: { option: IntegrationOption }) {
  const labelId = `integration-option-${option.id}`;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-xs font-medium text-fg">
          {option.label}
        </p>
        {option.description ? (
          <p className="mt-0.5 text-2xs leading-4 text-fg-subtle">{option.description}</p>
        ) : null}
        {option.action ? (
          <button
            type="button"
            onClick={option.action.onClick}
            className="mt-1 text-2xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-sm"
          >
            {option.action.label}
          </button>
        ) : null}
      </div>
      {option.busy ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-fg-subtle" aria-hidden />
      ) : null}
      {option.kind === "toggle" ? (
        <button
          type="button"
          role="switch"
          aria-checked={option.checked}
          aria-labelledby={labelId}
          disabled={option.disabled || option.busy}
          onClick={() => option.onChange(!option.checked)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            option.checked ? "border-brand bg-brand" : "border-border bg-surface-2",
          )}
        >
          <span
            className={cn(
              "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
              option.checked ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      ) : (
        <Select
          aria-labelledby={labelId}
          value={option.value}
          disabled={option.disabled || option.busy}
          onChange={(event) => option.onChange(event.target.value)}
          className="h-8 w-auto max-w-[12rem] text-xs"
        >
          {option.choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

function IntegrationFooterView({ footer }: { footer: IntegrationFooter }) {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-surface px-5 py-3">
      {footer.kind === "locked" ? (
        <p className="text-xs leading-5 text-fg-muted">{INTEGRATION_LOCKED_SENTENCE}</p>
      ) : footer.kind === "setup" ? (
        <Button
          type="button"
          className="flex-1"
          disabled={footer.disabled || footer.busy}
          onClick={footer.onSetup}
        >
          {footer.busy ? <Loader2Icon className="animate-spin" /> : null}
          Set up
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant={footer.kind === "repair" ? "default" : "secondary"}
            className="flex-1"
            disabled={footer.reconnectDisabled || footer.busy}
            onClick={footer.onReconnect}
          >
            {footer.busy ? <Loader2Icon className="animate-spin" /> : null}
            Reconnect
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="text-fg-muted hover:text-status-failed"
            disabled={footer.disconnectDisabled || footer.busy}
            onClick={footer.onDisconnect}
          >
            Disconnect
          </Button>
        </>
      )}
    </div>
  );
}
