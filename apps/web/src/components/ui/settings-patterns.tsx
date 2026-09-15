import { useId, type ComponentProps, type ReactNode } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "./input";

/** One boundary per section; rows inside use separators, not nested cards. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={id} className="text-sm font-semibold text-fg">
            {title}
          </h2>
          {description && <p className="mt-1 text-xs leading-5 text-fg-muted">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
        {children}
      </div>
    </section>
  );
}

/** A single responsive row anatomy for preferences, resources and metadata. */
export function SettingsRow({
  title,
  description,
  icon,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="settings-row"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-border px-4 py-4 last:border-b-0 sm:px-5"
    >
      {icon && (
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted [&_svg]:size-4"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">{title}</div>
        {description && (
          <div className="mt-1 break-words text-xs leading-5 text-fg-muted">{description}</div>
        )}
        {children}
      </div>
      {control && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{control}</div>
      )}
    </div>
  );
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  saving,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  saving?: boolean;
}) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={saving || undefined}
      disabled={props.disabled || saving}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {saving ? (
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-5 w-9 items-center rounded-full border transition-colors",
            checked ? "border-brand bg-brand" : "border-border-strong bg-surface-2",
          )}
        >
          <span
            className={cn(
              "size-3.5 rounded-full bg-white shadow-sm transition-transform",
              checked ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </span>
      )}
    </button>
  );
}

export function ToggleSetting({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  saving,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  saving?: boolean;
}) {
  const id = useId();
  return (
    <SettingsRow
      title={title}
      description={<span id={id}>{description}</span>}
      control={
        <SettingsSwitch
          aria-label={title}
          aria-describedby={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          saving={saving}
        />
      }
    />
  );
}

/** Use checkboxes for membership in a set, switches for an independent on/off setting. */
export function CheckboxSetting({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <SettingsRow
      title={<label htmlFor={id}>{title}</label>}
      description={<span id={`${id}-description`}>{description}</span>}
      control={
        <span className="flex min-h-11 min-w-11 items-center justify-center">
          <input
            id={id}
            type="checkbox"
            aria-describedby={`${id}-description`}
            checked={checked}
            disabled={disabled}
            onChange={(event) => onCheckedChange(event.target.checked)}
            className="size-4 accent-brand focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand disabled:opacity-50"
          />
        </span>
      }
    />
  );
}

/** Search stays left; scoped filters and collection actions stay right. */
export function ListToolbar({
  query,
  onQueryChange,
  placeholder,
  filters,
  actions,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  filters?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div data-slot="list-toolbar" className="mb-4 flex min-w-0 flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 basis-52 sm:max-w-sm">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          type="search"
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="pl-9"
        />
      </div>
      {filters}
      <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function ChoiceGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string; description: string }[];
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-3 text-sm font-semibold">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring",
              value === option.value
                ? "border-brand bg-brand/5"
                : "border-border hover:bg-surface-2/50",
            )}
          >
            <input
              className="mt-0.5 size-4 shrink-0 accent-brand"
              type="radio"
              name={name}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block text-xs leading-5 text-fg-muted">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
