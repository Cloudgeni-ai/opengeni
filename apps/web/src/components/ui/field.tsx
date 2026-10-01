import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { CheckIcon, CircleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Field - one labelled control in a vertical form (brief 7.15).

   Label 14/500 bound to the control, an optional "Optional" marker, a 12px
   hint, and an inline error that replaces the hint and sets aria-invalid on
   the control. Controls inside a Field pick up their id, aria-describedby,
   aria-invalid and aria-required from context, so a form never needs to wire
   ids by hand.
   -------------------------------------------------------------------------- */

interface FieldContextValue {
  controlId: string;
  labelId: string;
  /** Ids of the visible hint or error, for aria-describedby. */
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** The enclosing Field, or null. Use it to label custom group controls. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

/** Accessibility props for the control inside a Field. Explicit props win. */
export function useFieldControlProps(): {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  disabled?: true;
} {
  const field = useField();
  if (!field) return {};
  return {
    id: field.controlId,
    "aria-describedby": field.describedBy,
    "aria-invalid": field.invalid ? true : undefined,
    "aria-required": field.required ? true : undefined,
    disabled: field.disabled ? true : undefined,
  };
}

export function Field({
  label,
  hint,
  error,
  optional = false,
  required = false,
  disabled = false,
  aside,
  group = false,
  id,
  className,
  children,
}: {
  /** 14/500, sentence case, names what is being entered. */
  label: ReactNode;
  /** One 12px line under the control. Hidden while an error shows. */
  hint?: ReactNode;
  /** Inline error: what is wrong and how to fix it. Sets aria-invalid. */
  error?: ReactNode;
  /** Shows a quiet "Optional" marker after the label. */
  optional?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** Right-aligned next to the label, for example a character count. */
  aside?: ReactNode;
  /**
   * For controls that are a group (segmented control, radio cards): the label
   * becomes the group's name through aria-labelledby instead of htmlFor.
   */
  group?: boolean;
  /** Control id. Generated when omitted. */
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const controlId = id ?? `${generatedId}-control`;
  const labelId = `${generatedId}-label`;
  const hintId = `${generatedId}-hint`;
  const errorId = `${generatedId}-error`;
  const invalid = Boolean(error);
  const showHint = Boolean(hint) && !invalid;
  const describedBy = invalid ? errorId : showHint ? hintId : undefined;

  const labelContent = (
    <>
      {label}
      {optional ? (
        <span className="ml-1.5 text-xs font-normal text-fg-subtle">Optional</span>
      ) : null}
    </>
  );

  const context = useMemo(
    () => ({ controlId, labelId, describedBy, invalid, required, disabled }),
    [controlId, labelId, describedBy, invalid, required, disabled],
  );

  return (
    <FieldContext.Provider value={context}>
      <div
        role={group ? "group" : undefined}
        aria-labelledby={group ? labelId : undefined}
        aria-describedby={group ? describedBy : undefined}
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
        className={cn("flex min-w-0 flex-col", className)}
      >
        <div className="mb-2 flex min-w-0 items-baseline justify-between gap-3">
          {group ? (
            <span id={labelId} className="min-w-0 text-sm font-medium text-fg">
              {labelContent}
            </span>
          ) : (
            <label id={labelId} htmlFor={controlId} className="min-w-0 text-sm font-medium text-fg">
              {labelContent}
            </label>
          )}
          {aside ? <div className="shrink-0 text-xs text-fg-subtle">{aside}</div> : null}
        </div>
        {children}
        {invalid ? (
          <p
            id={errorId}
            className="mt-1.5 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger"
          >
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : showHint ? (
          <p id={hintId} className="mt-1.5 min-w-0 text-xs leading-4.5 break-words text-fg-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** Vertical rhythm for a form: 24px between fields. */
export function FieldStack({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-w-0 flex-col gap-6", className)}>{children}</div>;
}

/* ----------------------------------------------------------------------------
   Controls. Token styled; they read their Field for ids and aria.
   `rounded-md!` keeps the 10px radius when the global focus outline applies.
   -------------------------------------------------------------------------- */

const controlBase =
  "block w-full min-w-0 rounded-md! border border-border bg-surface text-sm text-fg transition-colors duration-[120ms] outline-offset-2 placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-brand disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-fg-muted read-only:bg-surface-2 read-only:hover:border-border aria-invalid:border-danger aria-invalid:hover:border-danger pointer-coarse:text-base";

export const TextInput = forwardRef<
  HTMLInputElement,
  ComponentProps<"input"> & {
    /** JetBrains Mono, for names, IDs and code. */
    mono?: boolean;
    /** Resource names are not a person's identity or a saved credential. */
    suppressAutofill?: boolean;
  }
>(function TextInput(
  { className, mono = false, suppressAutofill = false, type = "text", ...props },
  ref,
) {
  const fieldProps = useFieldControlProps();
  return (
    <input
      ref={ref}
      type={type}
      data-slot="text-input"
      {...fieldProps}
      {...props}
      {...(suppressAutofill
        ? { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true" }
        : {})}
      className={cn(
        controlBase,
        "h-9 px-3 pointer-coarse:h-11",
        mono && "font-mono text-xs pointer-coarse:text-base",
        className,
      )}
    />
  );
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  ComponentProps<"textarea"> & {
    mono?: boolean;
  }
>(function TextArea({ className, mono = false, rows = 3, style, ...props }, ref) {
  const fieldProps = useFieldControlProps();
  return (
    <textarea
      ref={ref}
      rows={rows}
      data-slot="text-area"
      {...fieldProps}
      {...props}
      // Grows with its content from `rows` lines (18px mono, 20px text) up to 240px.
      style={{ minHeight: `calc(${rows} * ${mono ? 18 : 20}px + 18px)`, ...style }}
      className={cn(
        controlBase,
        "field-sizing-content max-h-60 resize-y px-3 py-2 leading-5",
        mono && "font-mono text-xs leading-4.5 pointer-coarse:text-base",
        className,
      )}
    />
  );
});

/**
 * The bare 16px checkbox, for rows that carry their own label (a model in
 * Allowed models). Wrap the row in a <label> so the whole row toggles it.
 */
export function Checkbox({
  onCheckedChange,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type" | "onChange" | "className"> & {
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <span className={cn("relative grid size-4 shrink-0 place-items-center", className)}>
      <input
        type="checkbox"
        {...props}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        className="peer size-4 appearance-none rounded-[4px]! border border-border-strong bg-surface transition-colors duration-[120ms] checked:border-brand-strong checked:bg-brand-strong hover:border-fg-subtle disabled:cursor-not-allowed pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5 pointer-coarse:after:content-['']"
      />
      <CheckIcon
        aria-hidden="true"
        strokeWidth={3}
        className="pointer-events-none absolute size-3 text-brand-fg opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}

/**
 * A single yes/no choice inside a form with a Save button. For on/off that
 * saves immediately, use a switch instead.
 */
export function CheckboxField({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false,
  name,
  className,
}: {
  label: ReactNode;
  /** One 12px line under the label. */
  description?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <div
      data-disabled={disabled || undefined}
      className={cn(
        "flex min-w-0 items-start gap-3 data-[disabled]:opacity-60 pointer-coarse:py-1",
        className,
      )}
    >
      <Checkbox
        id={id}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-fg">
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="mt-0.5 block text-xs leading-4.5 text-fg-muted">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
