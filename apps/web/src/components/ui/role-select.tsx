/* ----------------------------------------------------------------------------
   RoleSelect - one role per person, from the server's role catalog.

   Roles are passed in (never a client copy), each with its own description.
   Picking a role that grants more power (Owner, Admin) asks first. Legacy
   custom grants show as "Custom (set via API)" and can be replaced by a role.

   Variants:
   - "field" (default): a bordered select for rows and forms.
   - "cell": a borderless select for dense grids (the access matrix).
   - "list": every role with its description as a radio list, for sheets
     and the invite dialog.
   - "text": the role as quiet text, for read-only views.
   -------------------------------------------------------------------------- */

import { useId, useState } from "react";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive, Select as SelectPrimitive } from "radix-ui";

import {
  MENU_CHECK_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";
import { ReasonTooltip } from "@/components/ui/disabled-reason";
import { FormDialog } from "@/components/ui/form-dialog";
import { InlineDisabledReason } from "@/components/ui/select-menu";

export interface RoleOption<R extends string = string> {
  id: R;
  /** "Workspace admin". */
  label: string;
  /** One line from the role catalog: what someone with it can do. */
  description: string;
  /**
   * Grants more power, so picking it asks first (Owner, Admin). Pass a
   * string to replace the role description in the confirmation.
   */
  escalation?: boolean | string;
  /** Why this role can't be picked here. */
  disabledReason?: string;
}

/** A role id, "custom" for a legacy hand-picked grant, or null for no access. */
export type RoleValue<R extends string = string> = R | "custom" | null;

export type RoleSelectVariant = "field" | "cell" | "list" | "text";

export const CUSTOM_ROLE_LABEL = "Custom (set via API)";
const CUSTOM_ROLE_DESCRIPTION =
  "Hand-picked permissions from the API. Pick a role to replace them.";
const NO_ACCESS_DESCRIPTION = "Can't open this workspace.";
const NONE = "__none";
const CUSTOM = "__custom";

export interface RoleSelectProps<R extends string = string> {
  roles: readonly RoleOption<R>[];
  value: RoleValue<R>;
  /**
   * Saves the new role. Return a promise to show the saving state until it
   * settles; the select keeps showing the new role meanwhile.
   */
  onValueChange?: (role: R | null) => void | Promise<unknown>;
  variant?: RoleSelectVariant;
  /** "sm" is 32px for rows, "md" is 36px for forms. Field variant only. */
  size?: "sm" | "md";
  /** Adds a "No access" option (value null), for the person sheet and the matrix. */
  noAccessLabel?: string;
  customLabel?: string;
  /** The person whose role this is, for confirmations and screen readers. */
  subjectName?: string;
  disabled?: boolean;
  /** Shown in a tooltip on the disabled control, and read by screen readers. */
  disabledReason?: string;
  /** Saving started elsewhere. */
  pending?: boolean;
  /** Menu alignment against the trigger. */
  align?: "start" | "end";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  id?: string;
  className?: string;
}

function toKey(value: RoleValue): string {
  if (value === null) return NONE;
  if (value === "custom") return CUSTOM;
  return value;
}

function withArticle(label: string): string {
  const lower = label.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
}

/** The label a role value shows, for rows, toasts and read-only text. */
export function roleLabel<R extends string>(
  roles: readonly RoleOption<R>[],
  value: RoleValue<R>,
  {
    noAccessLabel = "No access",
    customLabel = CUSTOM_ROLE_LABEL,
  }: { noAccessLabel?: string; customLabel?: string } = {},
): string {
  if (value === null) return noAccessLabel;
  if (value === "custom") return customLabel;
  return roles.find((role) => role.id === value)?.label ?? value;
}

/** Whether moving to a role needs a confirmation first: only roles marked as escalations do. */
export function needsEscalationConfirm<R extends string>(
  roles: readonly RoleOption<R>[],
  from: RoleValue<R>,
  to: R | null,
): boolean {
  if (to === null || to === from) return false;
  return Boolean(roles.find((role) => role.id === to)?.escalation);
}

// The one menu surface and option row (menu-styles.ts), as in select-menu.tsx:
// the list carries the 6px inset, the chosen option a check on the right.
const menuContent = cn(
  MENU_SURFACE_CLASS,
  "z-50 max-h-(--radix-select-content-available-height) w-[min(19rem,calc(100vw-24px))] min-w-(--radix-select-trigger-width) overflow-hidden p-0",
);

const menuItem =
  "relative flex min-h-8 cursor-pointer flex-col items-start rounded-[10px] py-1.5 pr-9 pl-2.5 text-left outline-none select-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-surface-2 pointer-coarse:min-h-11";

// Field trigger: the Select primitive's look at 32px (rows) or 36px (forms).
const fieldTrigger =
  "border border-border bg-surface px-3 hover:border-border-strong data-[state=open]:border-border-strong";

function MenuItem({
  value,
  label,
  description,
  disabled,
  muted,
}: {
  value: string;
  label: string;
  description: string;
  disabled?: boolean;
  muted?: boolean;
}) {
  return (
    <SelectPrimitive.Item value={value} disabled={disabled} className={menuItem}>
      <SelectPrimitive.ItemText>
        <span className={cn("text-sm", muted || disabled ? "text-fg-muted" : "text-fg")}>
          {label}
        </span>
      </SelectPrimitive.ItemText>
      <span className="mt-0.5 text-xs leading-4.5 text-fg-muted">{description}</span>
      <SelectPrimitive.ItemIndicator className="absolute top-2 right-2.5">
        <CheckIcon aria-hidden="true" className={MENU_CHECK_CLASS} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

/** Pick one role, from the server's catalog. Saves on change. */
export function RoleSelect<R extends string>({
  roles,
  value,
  onValueChange,
  variant = "field",
  size = "sm",
  noAccessLabel,
  customLabel = CUSTOM_ROLE_LABEL,
  subjectName,
  disabled,
  disabledReason,
  pending: pendingProp,
  align = "end",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  id,
  className,
}: RoleSelectProps<R>) {
  const [saving, setSaving] = useState<RoleValue<R> | undefined>(undefined);
  const [confirming, setConfirming] = useState<RoleOption<R> | null>(null);
  const reasonId = useId();
  const shown: RoleValue<R> = saving !== undefined ? saving : value;
  const pending = pendingProp || saving !== undefined;
  const isDisabled = disabled || Boolean(disabledReason);
  const label = roleLabel(roles, shown, { noAccessLabel, customLabel });
  const accessibleName = ariaLabel ?? (subjectName ? `Role for ${subjectName}` : "Role");

  const commit = async (next: R | null) => {
    if (!onValueChange) return;
    const result = onValueChange(next);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setSaving(next);
      try {
        await result;
      } finally {
        setSaving(undefined);
      }
    }
  };

  const choose = (next: R | null) => {
    if (next === shown) return;
    if (needsEscalationConfirm(roles, shown, next)) {
      setConfirming(roles.find((role) => role.id === next) ?? null);
      return;
    }
    void commit(next);
  };

  // Escalation asks first, in the same dialog anatomy as every other confirm.
  const confirmation = confirming ? (
    <FormDialog
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) setConfirming(null);
      }}
      title={`Make ${subjectName ?? "this person"} ${withArticle(confirming.label)}?`}
      description={
        typeof confirming.escalation === "string" ? confirming.escalation : confirming.description
      }
      submitLabel={`Make ${confirming.label.toLowerCase()}`}
      initialFocus="cancel"
      onSubmit={() => {
        const next = confirming.id;
        setConfirming(null);
        void commit(next);
      }}
    />
  ) : null;

  if (variant === "text") {
    return (
      <span
        id={id}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 text-sm",
          shown === null ? "text-fg-subtle" : "text-fg-muted",
          className,
        )}
      >
        <span className="truncate">{label}</span>
      </span>
    );
  }

  if (variant === "list") {
    return (
      <>
        <RadioGroupPrimitive.Root
          id={id}
          value={toKey(shown)}
          onValueChange={(key) => choose(key === NONE ? null : (key as R))}
          disabled={isDisabled || pending}
          aria-label={ariaLabelledBy ? undefined : accessibleName}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={disabledReason ? reasonId : undefined}
          aria-busy={pending || undefined}
          className={cn("flex min-w-0 flex-col gap-0.5", className)}
        >
          {shown === "custom" ? (
            <div className="mb-1 flex items-start gap-3 rounded-[10px] border border-dashed border-border px-3 py-2.5">
              <span
                aria-hidden="true"
                className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-brand"
              >
                <span className="size-2 rounded-full bg-brand" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{customLabel}</span>
                <span className="block text-xs leading-4.5 text-fg-muted">
                  {CUSTOM_ROLE_DESCRIPTION}
                </span>
              </span>
            </div>
          ) : null}
          {noAccessLabel ? (
            <ListOption value={NONE} label={noAccessLabel} description={NO_ACCESS_DESCRIPTION} />
          ) : null}
          {roles.map((role) => (
            <ListOption
              key={role.id}
              value={role.id}
              label={role.label}
              description={role.disabledReason ?? role.description}
              disabled={Boolean(role.disabledReason)}
              saving={pending && saving === role.id}
            />
          ))}
        </RadioGroupPrimitive.Root>
        {disabledReason ? (
          <div className="mt-2">
            <InlineDisabledReason id={reasonId}>{disabledReason}</InlineDisabledReason>
          </div>
        ) : null}
        {confirmation}
      </>
    );
  }

  const cell = variant === "cell";
  const triggerShape = cn(
    "group/role inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-[10px] text-sm transition-colors duration-[120ms]",
    cell
      ? "h-8 px-2 hover:bg-surface-2 data-[state=open]:bg-surface-2 pointer-coarse:h-11"
      : cn(fieldTrigger, size === "md" ? "h-9 pointer-coarse:h-11" : "h-8 pointer-coarse:h-11"),
    className,
  );

  // Locked: not a select at all. A focusable, aria-disabled control that
  // explains itself on hover, focus and tap (the shared ReasonTooltip).
  if (disabledReason) {
    return (
      <>
        <ReasonTooltip reason={disabledReason}>
          <button
            type="button"
            id={id}
            aria-disabled="true"
            aria-label={ariaLabelledBy ? undefined : `${accessibleName}: ${label}`}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={reasonId}
            data-locked=""
            className={cn(
              triggerShape,
              "cursor-not-allowed",
              cell
                ? "text-fg-muted hover:bg-transparent"
                : "bg-surface-2 text-fg-muted hover:border-border",
            )}
          >
            <span className="min-w-0 truncate">{label}</span>
            <LockIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
          </button>
        </ReasonTooltip>
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      </>
    );
  }

  return (
    <>
      <SelectPrimitive.Root
        value={toKey(shown)}
        onValueChange={(key) => choose(key === NONE ? null : (key as R))}
        disabled={disabled || pending}
      >
        <SelectPrimitive.Trigger
          id={id}
          aria-label={ariaLabelledBy ? undefined : `${accessibleName}: ${label}`}
          aria-labelledby={ariaLabelledBy}
          aria-busy={pending || undefined}
          className={cn(
            triggerShape,
            "disabled:cursor-not-allowed",
            cell
              ? "disabled:hover:bg-transparent"
              : "disabled:bg-surface-2 disabled:text-fg-muted disabled:hover:border-border",
            // Saving keeps the look of an enabled control; only the spinner says so.
            pending && !cell && "disabled:bg-surface disabled:text-fg",
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate",
              shown === null ? "text-fg-subtle" : disabled ? "text-fg-muted" : "text-fg",
            )}
          >
            <SelectPrimitive.Value>{label}</SelectPrimitive.Value>
          </span>
          {pending ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-fg-subtle motion-safe:animate-spin"
            />
          ) : disabled ? null : (
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-fg-subtle transition-[opacity,transform] duration-[120ms] group-data-[state=open]/role:rotate-180",
                cell &&
                  "opacity-0 group-hover/role:opacity-100 group-focus-visible/role:opacity-100 group-data-[state=open]/role:opacity-100 pointer-coarse:opacity-100",
              )}
            />
          )}
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            side="bottom"
            align={align}
            sideOffset={6}
            collisionPadding={12}
            className={menuContent}
          >
            <SelectPrimitive.Viewport className="p-1.5">
              {shown === "custom" ? (
                <>
                  <MenuItem
                    value={CUSTOM}
                    label={customLabel}
                    description={CUSTOM_ROLE_DESCRIPTION}
                    disabled
                  />
                  <SelectPrimitive.Separator className={MENU_SEPARATOR_CLASS} />
                </>
              ) : null}
              {noAccessLabel ? (
                <MenuItem
                  value={NONE}
                  label={noAccessLabel}
                  description={NO_ACCESS_DESCRIPTION}
                  muted
                />
              ) : null}
              {roles.map((role) => (
                <MenuItem
                  key={role.id}
                  value={role.id}
                  label={role.label}
                  description={role.disabledReason ?? role.description}
                  disabled={Boolean(role.disabledReason)}
                />
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {confirmation}
    </>
  );
}

function ListOption({
  value,
  label,
  description,
  disabled,
  saving,
}: {
  value: string;
  label: string;
  description: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  return (
    <RadioGroupPrimitive.Item
      value={value}
      disabled={disabled}
      className="group/option flex w-full min-w-0 items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-[120ms] hover:bg-surface-2 disabled:cursor-not-allowed disabled:hover:bg-transparent data-[state=checked]:bg-brand/5 pointer-coarse:min-h-11"
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-border-strong bg-surface transition-colors group-data-[state=checked]/option:border-brand group-disabled/option:opacity-50"
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-brand" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex items-center gap-2 text-sm font-medium",
            disabled ? "text-fg-muted" : "text-fg",
          )}
        >
          {label}
          {saving ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-3.5 text-fg-subtle motion-safe:animate-spin"
            />
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-4.5 text-fg-muted">{description}</span>
      </span>
    </RadioGroupPrimitive.Item>
  );
}
