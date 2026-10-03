import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListFilterIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  MENU_BUTTON_CLASS,
  MENU_LABEL_CLASS,
  MENU_SURFACE_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";

export type FilterOption = {
  /** One or more raw ids joined by "," (one option can stand for several ids). */
  id: string;
  label: string;
  /** Quiet words after the label: "you", "private amounts". */
  hint?: string;
};

export type FilterDimension = {
  id: string;
  /** Sentence case: "Person", "Paid with". */
  label: string;
  options: FilterOption[];
  /** Selected option ids. */
  selected: string[];
};

/**
 * Filters as a two-step popover: pick a dimension, then search and tick its
 * values. Every dimension is multi-select; the chips under the toolbar show
 * and remove what's active.
 */
export function FilterPicker(props: {
  dimensions: FilterDimension[];
  onChange: (dimension: string, selected: string[]) => void;
  /** One value per dimension (servers that can't combine values). */
  single?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dimensionId, setDimensionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const active = props.dimensions.reduce((sum, dimension) => sum + dimension.selected.length, 0);
  const dimension = props.dimensions.find((each) => each.id === dimensionId) ?? null;
  const options = useMemo(() => {
    if (!dimension) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return dimension.options.filter((option) => {
      const text = `${option.label} ${option.hint ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [dimension, query]);

  const toggle = (option: FilterOption) => {
    if (!dimension) return;
    const on = dimension.selected.includes(option.id);
    const next = on
      ? dimension.selected.filter((id) => id !== option.id)
      : props.single
        ? [option.id]
        : [...dimension.selected, option.id];
    props.onChange(dimension.id, next);
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setDimensionId(null);
          setQuery("");
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-2 rounded-[8px] px-3",
            active > 0 && "border-border-strong text-fg",
          )}
        >
          <ListFilterIcon aria-hidden="true" className="size-4 text-fg-muted" />
          Filter
          {active > 0 ? (
            <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-fg px-1.5 text-2xs font-medium text-bg tabular-nums">
              <span className="sr-only">Active filters: </span>
              {active}
            </span>
          ) : null}
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            if (dimension) {
              event.preventDefault();
              searchRef.current?.focus();
            }
          }}
          className={cn(
            MENU_SURFACE_CLASS,
            "z-50 flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-24px))] flex-col",
          )}
        >
          {dimension ? (
            <>
              <div className="flex items-center gap-1 pb-1">
                <button
                  type="button"
                  aria-label="All filters"
                  className="grid size-8 shrink-0 place-items-center rounded-[10px] text-fg-muted hover:bg-hover hover:text-fg"
                  onClick={() => {
                    setDimensionId(null);
                    setQuery("");
                  }}
                >
                  <ChevronLeftIcon aria-hidden="true" className="size-4" />
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {dimension.label}
                </span>
                {dimension.selected.length > 0 ? (
                  <button
                    type="button"
                    className="rounded-[8px] px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-fg"
                    onClick={() => props.onChange(dimension.id, [])}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              {dimension.options.length > 6 ? (
                <label className="mb-1 flex h-8 items-center gap-2 rounded-[10px] border border-border px-2.5 focus-within:border-border-strong">
                  <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={`Search ${dimension.label.toLowerCase()}`}
                    aria-label={`Search ${dimension.label.toLowerCase()}`}
                    className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
                  />
                  {query ? (
                    <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                      <XIcon aria-hidden="true" className="size-3.5 text-fg-subtle" />
                    </button>
                  ) : null}
                </label>
              ) : null}
              <ul
                role="listbox"
                aria-multiselectable={!props.single}
                aria-label={dimension.label}
                className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0"
              >
                {options.length === 0 ? (
                  <li className="px-2.5 py-2 text-sm text-fg-subtle">No matches</li>
                ) : (
                  options.map((option) => {
                    const on = dimension.selected.includes(option.id);
                    return (
                      <li key={option.id} role="option" aria-selected={on}>
                        <button
                          type="button"
                          className={MENU_BUTTON_CLASS}
                          onClick={() => toggle(option)}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                              on ? "border-fg bg-fg text-bg" : "border-border-strong",
                            )}
                          >
                            {on ? <CheckIcon className="size-3 text-bg" /> : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          {option.hint ? (
                            <span className="shrink-0 text-xs text-fg-subtle">{option.hint}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          ) : (
            <>
              <p className={MENU_LABEL_CLASS}>Filter by</p>
              <ul className="m-0 list-none p-0">
                {props.dimensions.map((each) => (
                  <li key={each.id}>
                    <button
                      type="button"
                      className={MENU_BUTTON_CLASS}
                      onClick={() => setDimensionId(each.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{each.label}</span>
                      {each.selected.length > 0 ? (
                        <span className="text-xs text-fg-muted tabular-nums">
                          {each.selected.length}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle tabular-nums">
                          {each.options.length}
                        </span>
                      )}
                      <ChevronRightIcon aria-hidden="true" className="size-4 text-fg-subtle" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** The active filters as removable chips. */
export function FilterChips(props: {
  dimensions: FilterDimension[];
  onChange: (dimension: string, selected: string[]) => void;
  onClear: () => void;
}) {
  const chips = props.dimensions.flatMap((dimension) =>
    dimension.selected.map((id) => ({
      dimension,
      id,
      label: dimension.options.find((option) => option.id === id)?.label ?? id,
    })),
  );
  if (chips.length === 0) return null;
  return (
    <ul
      aria-label="Active filters"
      className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0"
    >
      {chips.map(({ dimension, id, label }) => (
        <li key={`${dimension.id}:${id}`} className="flex">
          <span className="inline-flex h-7 max-w-72 items-center gap-1 rounded-full border border-border bg-surface pr-1 pl-2.5 text-xs font-medium text-fg pointer-coarse:h-9">
            <span className="shrink-0 text-fg-subtle">{dimension.label}:</span>
            <span className="min-w-0 truncate">{label}</span>
            <button
              type="button"
              aria-label={`Remove filter ${dimension.label}: ${label}`}
              onClick={() =>
                props.onChange(
                  dimension.id,
                  dimension.selected.filter((each) => each !== id),
                )
              }
              className="grid size-5 shrink-0 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-8"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        </li>
      ))}
      {chips.length > 1 ? (
        <li>
          <button
            type="button"
            onClick={props.onClear}
            className="h-7 rounded-full px-2.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
          >
            Clear all
          </button>
        </li>
      ) : null}
    </ul>
  );
}
