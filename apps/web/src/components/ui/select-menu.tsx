import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  LockIcon,
  SearchIcon,
} from "lucide-react";
import { Popover } from "radix-ui";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useFieldControlProps } from "@/components/ui/field";
import {
  MENU_CHECK_CLASS,
  MENU_LABEL_CLASS,
  MENU_NOTE_CLASS,
  MENU_SURFACE_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Types
   -------------------------------------------------------------------------- */

export interface SelectOption<V extends string = string> {
  value: V;
  /** "GPT-6 Sol", "Member", "Oslo time". */
  label: string;
  /** One sentence: what picking it means. */
  description?: ReactNode;
  /**
   * Quiet detail shown after the label in the menu and the trigger. For
   * models this is the payment source ("Codex plan"); for time zones the
   * offset; for people the email.
   */
  meta?: string;
  /** A 20px avatar or 16px icon before the label. */
  leading?: ReactNode;
  disabled?: boolean;
  /** Why it can't be picked and who can fix it. Replaces the description. */
  disabledReason?: string;
  /** Consecutive options with the same group get one quiet heading. */
  group?: string;
  /** Extra words the combobox search matches. */
  keywords?: string[];
}

/**
 * - `menu` (default): a popover list with title, description and meta, and a
 *   check on the selected option.
 * - `native`: the browser's select, restyled; the chosen option's description
 *   shows under it.
 * - `combobox`: the menu with a search field, for long or remote lists.
 */
export type SelectMenuVariant = "native" | "menu" | "combobox";

export interface SelectMenuProps<V extends string = string> {
  options: ReadonlyArray<SelectOption<V>>;
  value?: V | null;
  defaultValue?: V | null;
  onValueChange?: (value: V) => void;
  variant?: SelectMenuVariant;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** `md` is 36px for forms, `sm` is 32px for rows. Native is always 32px. */
  size?: "sm" | "md";
  disabled?: boolean;
  /** Why the whole control is disabled and who can change it. Shown under it. */
  disabledReason?: ReactNode;
  /** Options are loading: the trigger shows a spinner and can't open. */
  loading?: boolean;
  /** "Loading models…". */
  loadingLabel?: string;
  /** The value is wrong; pair it with a message through `aria-describedby`. */
  invalid?: boolean;
  /** Shown in the menu when there are no options at all. */
  emptyMessage?: ReactNode;
  /** Show the meta text in the trigger too (default true). */
  showMetaInTrigger?: boolean;
  /** Native only: show the chosen option's description under the select (default true). */
  showSelectedDescription?: boolean;
  /** Combobox: "Search time zones". */
  searchPlaceholder?: string;
  /** Combobox: called on every keystroke, for remote search. */
  onSearchChange?: (query: string) => void;
  /** Combobox: set false when `options` already come filtered from the server. */
  filterLocally?: boolean;
  /** Combobox: the remote search is running. */
  searching?: boolean;
  /** Menu alignment against the trigger. */
  align?: "start" | "end";
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Trigger classes, usually a width: "w-60". */
  className?: string;
  /** Classes on the popover panel. */
  menuClassName?: string;
}

/* ----------------------------------------------------------------------------
   Shared helpers
   -------------------------------------------------------------------------- */

function useControllableValue<V extends string>(
  value: V | null | undefined,
  defaultValue: V | null | undefined,
  onChange: ((value: V) => void) | undefined,
) {
  const [inner, setInner] = useState<V | null>(defaultValue ?? null);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const setValue = useCallback(
    (next: V) => {
      if (!controlled) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, setValue] as const;
}

/** Words in the query must all appear in the option's label, meta, description or keywords. */
export function filterSelectOptions<V extends string>(
  options: ReadonlyArray<SelectOption<V>>,
  query: string,
): SelectOption<V>[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = [
      option.label,
      option.meta,
      typeof option.description === "string" ? option.description : "",
      ...(option.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The next enabled option index from `from` in `direction`, wrapping around. */
export function nextEnabledIndex<V extends string>(
  options: ReadonlyArray<SelectOption<V>>,
  from: number,
  direction: 1 | -1,
): number {
  const count = options.length;
  if (count === 0) return -1;
  for (let step = 1; step <= count; step += 1) {
    const index = (((from + direction * step) % count) + count) % count;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function firstEnabledIndex<V extends string>(options: ReadonlyArray<SelectOption<V>>): number {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex<V extends string>(options: ReadonlyArray<SelectOption<V>>): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/**
 * Typeahead: the first enabled option after `from` whose label starts with
 * `buffer`. Repeating one letter cycles through options starting with it.
 */
export function typeaheadIndex<V extends string>(
  options: ReadonlyArray<SelectOption<V>>,
  buffer: string,
  from: number,
): number {
  const needle = buffer.toLowerCase();
  if (!needle) return -1;
  const repeated = needle.split("").every((char) => char === needle[0]);
  const search = repeated ? needle[0]! : needle;
  const count = options.length;
  const start = repeated ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < count; step += 1) {
    const index = (start + step) % count;
    const option = options[index];
    if (option && !option.disabled && option.label.toLowerCase().startsWith(search)) return index;
  }
  return -1;
}

// Matches the Field controls: hover darkens the border, keyboard focus turns it
// brand under the global 2px ring, and an invalid value keeps a danger border.
const TRIGGER_CLASS =
  "group/select-trigger inline-flex w-full min-w-0 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-left text-sm text-fg transition-colors duration-[120ms] hover:border-border-strong focus-visible:border-brand aria-expanded:border-border-strong aria-expanded:focus-visible:border-brand disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-fg-muted aria-invalid:border-danger aria-invalid:hover:border-danger pointer-coarse:h-11";

// The one menu surface (menu-styles.ts); the list inside carries the 6px inset.
const PANEL_CLASS = cn(
  MENU_SURFACE_CLASS,
  "z-50 flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[max(var(--radix-popover-trigger-width),22rem)] max-w-[calc(100vw-24px)] flex-col overflow-hidden p-0 outline-none transition-opacity duration-[120ms] starting:opacity-0",
);

function TriggerValue<V extends string>({
  option,
  placeholder,
  showMeta,
  loading,
  loadingLabel,
}: {
  option: SelectOption<V> | undefined;
  placeholder: string;
  showMeta: boolean;
  loading?: boolean;
  loadingLabel?: string;
}) {
  if (loading) {
    return <span className="min-w-0 flex-1 truncate text-fg-subtle">{loadingLabel}</span>;
  }
  if (!option) {
    return <span className="min-w-0 flex-1 truncate text-fg-subtle">{placeholder}</span>;
  }
  return (
    <>
      {option.leading ? (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {option.leading}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">
        {option.label}
        {showMeta && option.meta ? (
          <span className="text-fg-subtle group-disabled/select-trigger:text-fg-subtle">
            {" "}
            · {option.meta}
          </span>
        ) : null}
      </span>
    </>
  );
}

function TriggerIcon({ loading }: { loading?: boolean }) {
  return loading ? (
    <LoaderCircleIcon
      aria-hidden="true"
      className="size-4 shrink-0 animate-spin text-fg-subtle motion-reduce:animate-none"
    />
  ) : (
    <ChevronDownIcon
      aria-hidden="true"
      className="size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-aria-expanded/select-trigger:rotate-180"
    />
  );
}

/**
 * The inline reason under a disabled control: a lock and one sentence. (The
 * tooltip version for buttons is `DisabledReason` in `disabled-reason.tsx`.)
 */
export function InlineDisabledReason({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted">
      <LockIcon className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

function joinIds(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

/**
 * Inside a `Field`, the select picks up the field's id, hint or error,
 * invalid and disabled state. Explicit props win.
 */
function useSelectField({
  id,
  describedBy,
  invalid,
  disabled,
}: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const field = useFieldControlProps();
  return {
    id: id ?? field.id,
    describedBy: describedBy ?? field["aria-describedby"],
    invalid: invalid ?? Boolean(field["aria-invalid"]),
    disabled: Boolean(disabled || field.disabled),
  };
}

/* ----------------------------------------------------------------------------
   The panel: one option list for the menu, the combobox and static previews.
   -------------------------------------------------------------------------- */

export interface SelectMenuPanelProps<V extends string = string> {
  options: ReadonlyArray<SelectOption<V>>;
  value: V | null;
  /** The keyboard or pointer position. */
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  onSelect?: (value: V) => void;
  listboxId?: string;
  /** Option ids are `${idPrefix}-${index}`. */
  idPrefix?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Content above the list, for example the search field. */
  header?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  /** Shown when `options` is empty. */
  emptyMessage?: ReactNode;
  /**
   * Renders the panel in place, not as a popover, for previews and docs. It
   * is inert and hidden from assistive technology.
   */
  preview?: boolean;
  className?: string;
}

/**
 * The option list. Every option shows its label, meta (for example the
 * payment source) and description; the selected one gets the menu check on
 * the right (menu-styles.ts), hover and keyboard focus the surface-2 fill.
 */
export function SelectMenuPanel<V extends string>({
  options,
  value,
  activeIndex = -1,
  onActiveIndexChange,
  onSelect,
  listboxId,
  idPrefix,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  header,
  loading,
  loadingLabel = "Loading…",
  emptyMessage = "Nothing to choose from yet.",
  preview,
  className,
}: SelectMenuPanelProps<V>) {
  const fallbackPrefix = useId();
  const prefix = idPrefix ?? fallbackPrefix;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeIndex < 0 || preview) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    );
    element?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, preview]);

  let previousGroup: string | undefined;
  const rows: ReactNode[] = [];
  options.forEach((option, index) => {
    if (option.group && option.group !== previousGroup) {
      rows.push(
        <div
          key={`group-${option.group}-${option.value}`}
          role="presentation"
          className={cn(
            MENU_LABEL_CLASS,
            index === 0 ? null : "mt-1.5 border-t border-border pt-2.5",
          )}
        >
          {option.group}
        </div>,
      );
    }
    previousGroup = option.group;
    const selected = option.value === value;
    const active = index === activeIndex;
    const reason = option.disabled ? option.disabledReason : undefined;
    rows.push(
      <div
        key={option.value}
        id={`${prefix}-${index}`}
        role="option"
        aria-selected={selected}
        aria-disabled={option.disabled || undefined}
        data-option-index={index}
        data-active={active || undefined}
        data-selected={selected || undefined}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => {
          if (!active && !option.disabled) onActiveIndexChange?.(index);
        }}
        onClick={() => {
          if (!option.disabled) onSelect?.(option.value);
        }}
        className={cn(
          "group/option flex min-h-8 min-w-0 cursor-pointer items-start gap-2.5 rounded-[10px] px-2.5 py-1.5 transition-colors duration-[120ms] pointer-coarse:min-h-11",
          active ? "bg-surface-2" : null,
          option.disabled ? "cursor-not-allowed" : null,
        )}
      >
        {option.leading ? (
          <span
            aria-hidden="true"
            className={cn(
              "flex h-5 shrink-0 items-center text-fg-muted [&_svg]:size-4",
              option.disabled && "opacity-60",
            )}
          >
            {option.leading}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span
              className={cn(
                "min-w-0 text-sm [overflow-wrap:anywhere]",
                option.disabled ? "text-fg-muted" : "text-fg",
              )}
            >
              {option.label}
            </span>
            {/* Under a group heading that already names it, the meta would repeat. */}
            {option.meta && option.meta !== option.group ? (
              <span className="min-w-0 text-xs text-fg-muted">{option.meta}</span>
            ) : null}
          </span>
          {reason ? (
            <span className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted">
              <LockIcon className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span className="min-w-0">{reason}</span>
            </span>
          ) : option.description ? (
            <span className="mt-0.5 block text-xs leading-4.5 text-fg-muted">
              {option.description}
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="flex h-5 w-4 shrink-0 items-center">
          {selected ? <CheckIcon className={MENU_CHECK_CLASS} /> : null}
        </span>
      </div>,
    );
  });

  return (
    <div
      data-slot="select-menu-panel"
      aria-hidden={preview || undefined}
      inert={preview || undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        preview && cn(MENU_SURFACE_CLASS, "p-0"),
        className,
      )}
    >
      {header}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-busy={loading || undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
      >
        {loading ? (
          <div role="presentation" className={cn(MENU_NOTE_CLASS, "flex items-center gap-2")}>
            <LoaderCircleIcon
              className="size-4 animate-spin text-fg-subtle motion-reduce:animate-none"
              aria-hidden="true"
            />
            {loadingLabel}
          </div>
        ) : rows.length > 0 ? (
          rows
        ) : (
          <div role="presentation" className={MENU_NOTE_CLASS}>
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Menu select (B): focus stays on the trigger, the list is a popover.
   -------------------------------------------------------------------------- */

/**
 * The trigger is a Popover anchor, not a Popover trigger, so its own click
 * handles toggling. Closing returns focus to it, unless the person clicked
 * somewhere else on the page.
 */
function usePopoverAnchor() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closedOutside = useRef(false);
  const onInteractOutside = useCallback((event: Event) => {
    const target = event.target;
    if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
    else closedOutside.current = true;
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (!closedOutside.current) anchorRef.current?.focus();
    closedOutside.current = false;
  }, []);
  return { anchorRef, onInteractOutside, onCloseAutoFocus };
}

function DisabledReasonWrapper({
  reasonId,
  reason,
  className,
  children,
}: {
  reasonId: string;
  reason: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  if (!reason) return <>{children}</>;
  return (
    <span className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}>
      {children}
      <InlineDisabledReason id={reasonId}>{reason}</InlineDisabledReason>
    </span>
  );
}

/** Choose one of many from a popover list. Options show description and payer. */
export function MenuSelect<V extends string>({
  options,
  value: valueProp,
  defaultValue,
  onValueChange,
  placeholder = "Choose…",
  size = "md",
  disabled: disabledProp,
  disabledReason,
  loading,
  loadingLabel = "Loading…",
  invalid: invalidProp,
  emptyMessage,
  showMetaInTrigger = true,
  align = "start",
  id: idProp,
  name,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedByProp,
  className,
  menuClassName,
}: Omit<SelectMenuProps<V>, "variant">) {
  const {
    id,
    describedBy: ariaDescribedBy,
    invalid,
    disabled,
  } = useSelectField({
    id: idProp,
    describedBy: ariaDescribedByProp,
    invalid: invalidProp,
    disabled: disabledProp,
  });
  const [value, setValue] = useControllableValue(valueProp, defaultValue, onValueChange);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { anchorRef, onInteractOutside, onCloseAutoFocus } = usePopoverAnchor();
  const listboxId = useId();
  const idPrefix = useId();
  const reasonId = useId();
  const typeahead = useRef({ buffer: "", timer: 0 as ReturnType<typeof setTimeout> | 0 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const blocked = Boolean(disabled || loading);
  const showReason = Boolean(disabled && disabledReason);

  const openMenu = useCallback(
    (focus: "selected" | "first" | "last" = "selected") => {
      if (blocked) return;
      const start =
        focus === "last"
          ? lastEnabledIndex(options)
          : focus === "first"
            ? firstEnabledIndex(options)
            : selectedIndex >= 0 && !options[selectedIndex]?.disabled
              ? selectedIndex
              : firstEnabledIndex(options);
      setActiveIndex(start);
      setOpen(true);
    },
    [blocked, options, selectedIndex],
  );

  const choose = useCallback(
    (next: V) => {
      setValue(next);
      setOpen(false);
      anchorRef.current?.focus();
    },
    [anchorRef, setValue],
  );

  const runTypeahead = (key: string) => {
    const state = typeahead.current;
    if (state.timer) clearTimeout(state.timer);
    state.buffer += key;
    state.timer = setTimeout(() => {
      state.buffer = "";
    }, 500);
    const from = open ? activeIndex : selectedIndex;
    const match = typeaheadIndex(options, state.buffer, from);
    if (match < 0) return;
    if (open) setActiveIndex(match);
    else setValue(options[match]!.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (blocked) return;
    const { key } = event;
    if (!open) {
      if (key === "ArrowDown" || key === "Enter" || key === " ") {
        event.preventDefault();
        openMenu("selected");
      } else if (key === "ArrowUp") {
        event.preventDefault();
        openMenu(selectedIndex >= 0 ? "selected" : "last");
      } else if (key === "Home") {
        event.preventDefault();
        openMenu("first");
      } else if (key === "End") {
        event.preventDefault();
        openMenu("last");
      } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        runTypeahead(key);
      }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (event.altKey && key === "ArrowUp") {
        const option = options[activeIndex];
        if (option && !option.disabled) choose(option.value);
        return;
      }
      setActiveIndex(nextEnabledIndex(options, activeIndex, key === "ArrowDown" ? 1 : -1));
    } else if (key === "Home") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options));
    } else if (key === "End") {
      event.preventDefault();
      setActiveIndex(lastEnabledIndex(options));
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option && !option.disabled) choose(option.value);
    } else if (key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (key === "Tab") {
      setOpen(false);
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      runTypeahead(key);
    }
  };

  useEffect(() => {
    const state = typeahead.current;
    return () => {
      if (state.timer) clearTimeout(state.timer);
    };
  }, []);

  return (
    <DisabledReasonWrapper reasonId={reasonId} reason={showReason ? disabledReason : null}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <button
            ref={anchorRef}
            id={id}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${idPrefix}-${activeIndex}` : undefined
            }
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={joinIds(ariaDescribedBy, showReason && reasonId)}
            aria-invalid={invalid || undefined}
            aria-busy={loading || undefined}
            disabled={blocked}
            data-slot="select-menu-trigger"
            data-size={size}
            onClick={() => (open ? setOpen(false) : openMenu("selected"))}
            onKeyDown={onKeyDown}
            className={cn(TRIGGER_CLASS, size === "sm" ? "h-8" : "h-9", className)}
          >
            <TriggerValue
              option={selected}
              placeholder={placeholder}
              showMeta={showMetaInTrigger}
              loading={loading}
              loadingLabel={loadingLabel}
            />
            <TriggerIcon loading={loading} />
          </button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align={align}
            side="bottom"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={onCloseAutoFocus}
            onInteractOutside={onInteractOutside}
            className={cn(PANEL_CLASS, menuClassName)}
          >
            <SelectMenuPanel
              options={options}
              value={value}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onSelect={choose}
              listboxId={listboxId}
              idPrefix={idPrefix}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              emptyMessage={emptyMessage}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
    </DisabledReasonWrapper>
  );
}

/* ----------------------------------------------------------------------------
   Combobox (C): the menu plus a search field. Focus moves into the search.
   -------------------------------------------------------------------------- */

/** A searchable popover list, for long or remote lists (people, time zones, repositories). */
export function ComboboxSelect<V extends string>({
  options,
  value: valueProp,
  defaultValue,
  onValueChange,
  placeholder = "Choose…",
  size = "md",
  disabled: disabledProp,
  disabledReason,
  loading,
  loadingLabel = "Loading…",
  invalid: invalidProp,
  emptyMessage,
  showMetaInTrigger = true,
  searchPlaceholder = "Search",
  onSearchChange,
  filterLocally = true,
  searching,
  align = "start",
  id: idProp,
  name,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedByProp,
  className,
  menuClassName,
}: Omit<SelectMenuProps<V>, "variant">) {
  const {
    id,
    describedBy: ariaDescribedBy,
    invalid,
    disabled,
  } = useSelectField({
    id: idProp,
    describedBy: ariaDescribedByProp,
    invalid: invalidProp,
    disabled: disabledProp,
  });
  const [value, setValue] = useControllableValue(valueProp, defaultValue, onValueChange);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const { anchorRef, onInteractOutside, onCloseAutoFocus } = usePopoverAnchor();
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const idPrefix = useId();
  const reasonId = useId();
  const selected = options.find((option) => option.value === value);
  const blocked = Boolean(disabled || loading);
  const showReason = Boolean(disabled && disabledReason);
  const visible = useMemo(
    () => (filterLocally ? filterSelectOptions(options, query) : [...options]),
    [filterLocally, options, query],
  );

  const setOpenState = (next: boolean) => {
    if (next && blocked) return;
    setOpen(next);
    if (next) {
      const selectedIndex = visible.findIndex((option) => option.value === value);
      setActiveIndex(
        selectedIndex >= 0 && !visible[selectedIndex]?.disabled
          ? selectedIndex
          : firstEnabledIndex(visible),
      );
    } else if (query) {
      setQuery("");
      onSearchChange?.("");
    }
  };

  const choose = (next: V) => {
    setValue(next);
    setOpenState(false);
    anchorRef.current?.focus();
  };

  const onQueryChange = (next: string) => {
    setQuery(next);
    onSearchChange?.(next);
    const filtered = filterLocally ? filterSelectOptions(options, next) : [...options];
    setActiveIndex(firstEnabledIndex(filtered));
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { key } = event;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(visible, activeIndex, key === "ArrowDown" ? 1 : -1));
    } else if (key === "Enter") {
      event.preventDefault();
      const option = visible[activeIndex];
      if (option && !option.disabled) choose(option.value);
    } else if (key === "Tab") {
      setOpenState(false);
    }
  };

  const busy = Boolean(searching);

  return (
    <DisabledReasonWrapper reasonId={reasonId} reason={showReason ? disabledReason : null}>
      <Popover.Root open={open} onOpenChange={setOpenState}>
        <Popover.Anchor asChild>
          <button
            ref={anchorRef}
            id={id}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={joinIds(ariaDescribedBy, showReason && reasonId)}
            aria-invalid={invalid || undefined}
            aria-busy={loading || undefined}
            disabled={blocked}
            data-slot="select-menu-trigger"
            data-size={size}
            onClick={() => setOpenState(!open)}
            onKeyDown={(event) => {
              if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setOpenState(true);
              }
            }}
            className={cn(TRIGGER_CLASS, size === "sm" ? "h-8" : "h-9", className)}
          >
            <TriggerValue
              option={selected}
              placeholder={placeholder}
              showMeta={showMetaInTrigger}
              loading={loading}
              loadingLabel={loadingLabel}
            />
            <TriggerIcon loading={loading} />
          </button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align={align}
            side="bottom"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              inputRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              // The first Escape clears the search, the second one closes.
              if (!query) return;
              event.preventDefault();
              onQueryChange("");
            }}
            onCloseAutoFocus={onCloseAutoFocus}
            onInteractOutside={onInteractOutside}
            className={cn(PANEL_CLASS, menuClassName)}
          >
            <SelectMenuPanel
              options={visible}
              value={value}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onSelect={choose}
              listboxId={listboxId}
              idPrefix={idPrefix}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              loading={busy}
              loadingLabel="Searching…"
              emptyMessage={
                query ? (
                  <>No matches for &ldquo;{query.trim()}&rdquo;.</>
                ) : (
                  (emptyMessage ?? "Nothing to choose from yet.")
                )
              }
              header={
                <ComboboxSearch
                  inputRef={inputRef}
                  query={query}
                  placeholder={searchPlaceholder}
                  listboxId={listboxId}
                  activeId={activeIndex >= 0 ? `${idPrefix}-${activeIndex}` : undefined}
                  onChange={onQueryChange}
                  onKeyDown={onInputKeyDown}
                />
              }
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
    </DisabledReasonWrapper>
  );
}

function ComboboxSearch({
  inputRef,
  query,
  placeholder,
  listboxId,
  activeId,
  onChange,
  onKeyDown,
  preview,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  query: string;
  placeholder: string;
  listboxId?: string;
  activeId?: string;
  onChange?: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  preview?: boolean;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
      <SearchIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={!preview}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={query}
        readOnly={preview}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none! placeholder:text-fg-subtle"
      />
    </div>
  );
}

/** A static, inert combobox panel for previews and docs. */
export function ComboboxPanelPreview<V extends string>({
  options,
  value,
  query = "",
  searchPlaceholder = "Search",
  activeValue,
  className,
}: {
  options: ReadonlyArray<SelectOption<V>>;
  value: V | null;
  query?: string;
  searchPlaceholder?: string;
  activeValue?: V;
  className?: string;
}) {
  const visible = filterSelectOptions(options, query);
  return (
    <SelectMenuPanel
      preview
      options={visible}
      value={value}
      activeIndex={activeValue ? visible.findIndex((option) => option.value === activeValue) : -1}
      className={className}
      emptyMessage={<>No matches for &ldquo;{query.trim()}&rdquo;.</>}
      header={<ComboboxSearch preview query={query} placeholder={searchPlaceholder} />}
    />
  );
}

/* ----------------------------------------------------------------------------
   Native select (A): the browser's own list, restyled to one height.
   -------------------------------------------------------------------------- */

/** Native text for an option: the label, its meta, and "unavailable" when disabled. */
export function nativeOptionText<V extends string>(option: SelectOption<V>): string {
  const base = option.meta ? `${option.label} · ${option.meta}` : option.label;
  return option.disabled ? `${base} - unavailable` : base;
}

/** The browser's select at 32px, with the chosen option's description under it. */
export function NativeSelect<V extends string>({
  options,
  value: valueProp,
  defaultValue,
  onValueChange,
  placeholder,
  disabled: disabledProp,
  disabledReason,
  loading,
  loadingLabel = "Loading…",
  invalid: invalidProp,
  showSelectedDescription = true,
  id: idProp,
  name,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedByProp,
  className,
}: Omit<SelectMenuProps<V>, "variant">) {
  const {
    id,
    describedBy: ariaDescribedBy,
    invalid,
    disabled,
  } = useSelectField({
    id: idProp,
    describedBy: ariaDescribedByProp,
    invalid: invalidProp,
    disabled: disabledProp,
  });
  const [value, setValue] = useControllableValue(valueProp, defaultValue, onValueChange);
  const descriptionId = useId();
  const reasonId = useId();
  const selected = options.find((option) => option.value === value);
  const showReason = Boolean(disabled && disabledReason);
  const selectedDescription =
    showSelectedDescription && selected?.description && !loading ? selected.description : null;

  const groups: Array<{ label: string | undefined; options: SelectOption<V>[] }> = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last && last.label === option.group) last.options.push(option);
    else groups.push({ label: option.group, options: [option] });
  }
  const renderOption = (option: SelectOption<V>) => (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {nativeOptionText(option)}
    </option>
  );

  return (
    <span data-slot="native-select" className="flex w-full min-w-0 flex-col gap-1.5">
      <span className={cn("relative block w-full min-w-0", className)}>
        <select
          id={id}
          name={name}
          value={loading ? "" : (value ?? "")}
          disabled={disabled || loading}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={joinIds(
            ariaDescribedBy,
            selectedDescription ? descriptionId : null,
            showReason && reasonId,
          )}
          aria-invalid={invalid || undefined}
          aria-busy={loading || undefined}
          onChange={(event) => setValue(event.target.value as V)}
          className={cn(
            "block h-8 w-full min-w-0 cursor-pointer appearance-none truncate rounded-[10px] border border-border bg-surface pr-8 pl-3 text-sm text-fg transition-colors duration-[120ms] hover:border-border-strong focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/55 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-fg-muted aria-invalid:border-danger aria-invalid:hover:border-danger pointer-coarse:h-11",
            !value && "text-fg-subtle",
          )}
        >
          {loading ? (
            <option value="">{loadingLabel}</option>
          ) : placeholder || !value ? (
            <option value="" disabled>
              {placeholder ?? "Choose…"}
            </option>
          ) : null}
          {loading
            ? null
            : groups.map((group) =>
                group.label ? (
                  <optgroup key={`${group.label}-${group.options[0]!.value}`} label={group.label}>
                    {group.options.map(renderOption)}
                  </optgroup>
                ) : (
                  group.options.map(renderOption)
                ),
              )}
        </select>
        {loading ? (
          <LoaderCircleIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-fg-subtle motion-reduce:animate-none"
          />
        ) : (
          <ChevronDownIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-subtle"
          />
        )}
      </span>
      {selectedDescription ? (
        <span id={descriptionId} className="text-xs leading-4.5 text-fg-muted">
          {selectedDescription}
        </span>
      ) : null}
      {showReason ? (
        <InlineDisabledReason id={reasonId}>{disabledReason}</InlineDisabledReason>
      ) : null}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   SelectMenu: one entry point, three variants.
   -------------------------------------------------------------------------- */

/**
 * Choose one of many. `menu` is the default; `combobox` is for long or remote
 * lists whichever default is picked; `native` keeps the browser's select.
 * Menus for actions stay in `DropdownMenu`.
 */
export function SelectMenu<V extends string>({ variant = "menu", ...props }: SelectMenuProps<V>) {
  if (variant === "native") return <NativeSelect {...props} />;
  if (variant === "combobox") return <ComboboxSelect {...props} />;
  return <MenuSelect {...props} />;
}

/** The error line under a select, matching the choice cards error. */
export function SelectError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
