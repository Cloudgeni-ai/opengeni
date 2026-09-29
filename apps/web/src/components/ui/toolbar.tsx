import { useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { ListFilterIcon, SearchIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The list toolbar: search on the left, filters and the page's action on the
 * right, in a row that keeps its shape when tabs or filters change. On narrow
 * widths (its own container, not the viewport) the search takes the first line
 * and everything else moves to a second line, still in the same order.
 */

export function Toolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar"
      className={cn(
        "@container/toolbar flex min-w-0 flex-wrap items-center gap-2 @xl/toolbar:flex-nowrap",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Groups controls that belong together (a segmented filter and a view toggle,
 * or the page action). `align="end"` pins the group to the right edge, on
 * either line when the toolbar wraps.
 */
export function ToolbarGroup({
  align = "start",
  className,
  ...props
}: ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="toolbar-group"
      data-align={align}
      className={cn(
        // Wraps inside itself when it's wider than the toolbar (a phone), so
        // nothing ever runs past the edge; `end` keeps the wrapped lines right.
        "flex max-w-full min-w-0 shrink-0 flex-wrap items-center gap-2",
        align === "end" && "ml-auto justify-end",
        className,
      )}
      {...props}
    />
  );
}

/* ----------------------------------------------------------------------------
   Search
   -------------------------------------------------------------------------- */

export type ToolbarSearchSize = "md" | "lg";

export interface ToolbarSearchProps extends Omit<
  ComponentProps<"input">,
  "size" | "value" | "onChange" | "type"
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Names what is searchable: "Search connections, skills, and plugins". */
  placeholder: string;
  /**
   * `md` (36px, radius 10) sits in a row with 36px controls. `lg` (44px,
   * radius 14) is the page-level search on its own line, as on Capabilities.
   */
  size?: ToolbarSearchSize;
  /** Classes for the field wrapper (width, flex basis). */
  wrapperClassName?: string;
}

export function ToolbarSearch({
  value,
  onValueChange,
  placeholder,
  size = "md",
  wrapperClassName,
  className,
  disabled,
  onKeyDown,
  "aria-label": ariaLabel,
  ...props
}: ToolbarSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const large = size === "lg";

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && value) {
      event.preventDefault();
      onValueChange("");
    }
  };

  return (
    <div
      data-slot="toolbar-search"
      data-size={size}
      className={cn(
        // Full line on narrow toolbars; on wide ones it takes the space the controls leave.
        "relative flex min-w-0 grow basis-full items-center border border-border bg-surface transition-colors duration-[120ms] @xl/toolbar:basis-0",
        "hover:border-border-strong",
        "has-[input:focus-visible]:border-border-strong has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-brand/55",
        large ? "h-11 rounded-[14px]" : "h-9 rounded-[10px] pointer-coarse:h-11",
        disabled && "pointer-events-none bg-surface-2 text-fg-subtle",
        wrapperClassName,
      )}
    >
      <SearchIcon
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-fg-subtle",
          large ? "left-4" : "left-3",
        )}
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-full w-full min-w-0 appearance-none border-0 bg-transparent text-sm text-ellipsis text-fg outline-none! placeholder:text-fg-subtle disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:appearance-none",
          // Room for the clear button only while there is something to clear,
          // so long placeholders keep their words on narrow screens.
          large ? "pl-11" : "pl-9",
          value && !disabled ? (large ? "pr-11" : "pr-9") : large ? "pr-4" : "pr-3",
          className,
        )}
        {...props}
      />
      {value && !disabled ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange("");
            inputRef.current?.focus();
          }}
          className={cn(
            "absolute top-1/2 grid -translate-y-1/2 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-9",
            large ? "right-2.5 size-7" : "right-1.5 size-6",
          )}
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Filter menu: one "Filter" button with checkable items, grouped.
   -------------------------------------------------------------------------- */

export interface ToolbarFilterOption {
  id: string;
  label: string;
  /** Optional count shown right-aligned in the menu. */
  count?: number;
}

export interface ToolbarFilterGroup {
  id: string;
  /** Sentence case: "Type", "Status". */
  label: string;
  options: ToolbarFilterOption[];
}

/** Selected option ids per group id. An empty or missing list means "any". */
export type ToolbarFilterValue = Record<string, readonly string[]>;

export function countActiveFilters(value: ToolbarFilterValue): number {
  return Object.values(value).reduce((total, ids) => total + ids.length, 0);
}

export function toggleFilter(
  value: ToolbarFilterValue,
  groupId: string,
  optionId: string,
  checked: boolean,
): ToolbarFilterValue {
  const current = value[groupId] ?? [];
  const next = checked
    ? current.includes(optionId)
      ? current
      : [...current, optionId]
    : current.filter((id) => id !== optionId);
  return { ...value, [groupId]: next };
}

// The highlighted item is a surface-2 fill, like the other menus; the global
// focus outline would draw a second ring on it.
const MENU_ITEM_CLASS =
  "min-h-8 rounded-[10px] outline-none! focus:bg-surface-2 focus:text-fg data-[highlighted]:bg-surface-2 pointer-coarse:min-h-11";

export interface ToolbarFilterMenuProps {
  groups: ToolbarFilterGroup[];
  value: ToolbarFilterValue;
  onValueChange: (value: ToolbarFilterValue) => void;
  /** Button label. Default "Filter". */
  label?: string;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}

export function ToolbarFilterMenu({
  groups,
  value,
  onValueChange,
  label = "Filter",
  disabled,
  align = "end",
  className,
}: ToolbarFilterMenuProps) {
  const active = countActiveFilters(value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-9 shrink-0 gap-2 rounded-[10px] px-3 pointer-coarse:h-11",
            active > 0 && "border-border-strong text-fg",
            className,
          )}
        >
          <ListFilterIcon aria-hidden="true" className="size-4 text-fg-muted" />
          {label}
          {active > 0 ? (
            <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-fg px-1.5 text-2xs font-medium text-bg tabular-nums">
              <span className="sr-only">Active filters: </span>
              {active}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-60 rounded-[16px] border-border bg-surface p-1.5 text-fg shadow-og-md"
      >
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
              {group.label}
            </DropdownMenuLabel>
            {group.options.map((option) => {
              const checked = (value[group.id] ?? []).includes(option.id);
              return (
                <DropdownMenuCheckboxItem
                  key={option.id}
                  checked={checked}
                  // Keep the menu open so several filters can be picked at once.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(next) =>
                    onValueChange(toggleFilter(value, group.id, option.id, next === true))
                  }
                  className={MENU_ITEM_CLASS}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.count === undefined ? null : (
                    <span className="text-xs text-fg-subtle tabular-nums">{option.count}</span>
                  )}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
        {active > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onValueChange({})}
              className={cn(MENU_ITEM_CLASS, "text-fg-muted")}
            >
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The applied filters as removable chips, shown next to the Filter button so
 * the active state is never hidden inside a closed menu.
 */
export function ToolbarFilterChips({
  groups,
  value,
  onValueChange,
  className,
}: {
  groups: ToolbarFilterGroup[];
  value: ToolbarFilterValue;
  onValueChange: (value: ToolbarFilterValue) => void;
  className?: string;
}) {
  const chips: Array<{ group: ToolbarFilterGroup; option: ToolbarFilterOption }> = [];
  for (const group of groups) {
    for (const option of group.options) {
      if ((value[group.id] ?? []).includes(option.id)) chips.push({ group, option });
    }
  }
  if (chips.length === 0) return null;
  return (
    <ul
      aria-label="Active filters"
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      {chips.map(({ group, option }) => (
        <li key={`${group.id}:${option.id}`} className="flex">
          <span className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface pr-1 pl-2.5 text-xs font-medium text-fg pointer-coarse:h-9 pointer-coarse:pr-0.5">
            <span className="text-fg-subtle">{group.label}:</span>
            {option.label}
            <button
              type="button"
              aria-label={`Remove filter ${group.label}: ${option.label}`}
              onClick={() => onValueChange(toggleFilter(value, group.id, option.id, false))}
              className="grid size-5 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-8"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A quiet result line under the toolbar: "3 of 12 connections". */
export function ToolbarSummary({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      data-slot="toolbar-summary"
      aria-live="polite"
      className={cn("text-xs leading-4.5 text-fg-subtle", className)}
    >
      {children}
    </p>
  );
}
