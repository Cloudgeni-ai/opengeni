import {
  createContext,
  isValidElement,
  useContext,
  useId,
  useMemo,
  useRef,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogoTileSizeProvider, type LogoTileSize } from "@/components/ui/logo-tile";
import { useSectionListFrame } from "@/components/ui/section-variant";
import { RelativeTimeDefaultsContext } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   RowList and ListRow (design brief 7.4) - the one way to show a thing in a
   list. The Capabilities catalog row, generalized: leading tile, title, one
   line of description, quiet meta, and one trailing affordance.

   One row definition renders in three layouts, chosen on the list:
   - "catalog"  (A) 76px rows, 40px tile, two columns at 720px+, trailing
                + / check. For discovering things (Capabilities).
   - "resource" (B, default) 56-64px rows in one column with hairlines, a
                32px tile, title + one line, fact columns and a chevron or ⋯
                menu. For things you own.
   - "table"    (C) column headers and sortable columns, 44px rows. For more
                than ~20 items or numeric data.

   The whole row is the action (a stretched button or link) unless it holds
   one control. Menus and controls sit above the stretched target.

   Resource and table rows share one grid (CSS subgrid), so fact columns and
   the trailing slot line up across rows whatever each row holds. Under 640px
   of list width (a container query, so a list in a sheet or a 390px frame
   behaves like a phone) the fact columns fold into the meta line.
   -------------------------------------------------------------------------- */

export type RowListVariant = "catalog" | "resource" | "table";

export interface RowListColumn {
  /** Key into each row's `cells`. */
  id: string;
  /** Header in tables; the small label above the value in resource rows. */
  label: string;
  /** Column width in px on wide layouts. Default 132. */
  width?: number;
  align?: "start" | "end";
  /** Tables only: the header becomes a sort button. */
  sortable?: boolean;
  /**
   * Hide the label in resource rows and the folded meta line, for values that
   * explain themselves ("4 variables"). The table header still shows it.
   */
  hideLabel?: boolean;
}

export interface RowListSort {
  /** A column id, or "name" for the title column. */
  column: string;
  direction: "asc" | "desc";
}

interface RowListContextValue {
  variant: RowListVariant;
  columns: RowListColumn[];
}

const RowListContext = createContext<RowListContextValue | null>(null);

function useRowList(): RowListContextValue {
  return useContext(RowListContext) ?? { variant: "resource", columns: NO_COLUMNS };
}

/** The layout of the enclosing RowList. */
export function useRowListVariant(): RowListVariant {
  return useRowList().variant;
}

const TILE_SIZE: Record<RowListVariant, LogoTileSize> = {
  catalog: "lg",
  resource: "md",
  table: "sm",
};

const DEFAULT_COLUMN_WIDTH = 132;
const NO_COLUMNS: RowListColumn[] = [];
const NO_META: ReactNode[] = [];
const NO_CELLS: Record<string, ReactNode> = {};
/** The row is the tab stop; times inside it show their tooltip on hover. */
const ROW_TIME_DEFAULTS = { focusable: false };

/** Wide layout: title, one track per fact column, then the trailing slot. */
function gridTemplate(columns: RowListColumn[], variant: RowListVariant): string {
  const facts = columns.map((column) => `${column.width ?? DEFAULT_COLUMN_WIDTH}px`);
  return ["minmax(0,1fr)", ...facts, variant === "table" ? "minmax(2.5rem,auto)" : "auto"].join(
    " ",
  );
}

/*
 * Container-query classes are written out in full (`@[640px]/list:`) so
 * Tailwind can see them. Narrow lists use two tracks: title and trailing.
 */
const SHARED_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] @[640px]/list:[grid-template-columns:var(--row-list-template)]";
const SUBGRID = "col-span-full grid grid-cols-subgrid";

export interface RowListProps {
  /** Default "resource". */
  variant?: RowListVariant;
  /** Fact columns: labelled values in resource rows, real columns in tables. */
  columns?: RowListColumn[];
  /** Accessible name for the list or table, for example "Variable sets". */
  label: string;
  /** Header of the title column in tables. Default "Name". */
  nameLabel?: string;
  /** Tables: make the title column sortable. */
  nameSortable?: boolean;
  /** Tables: the current sort. Sorting the rows is the caller's job. */
  sort?: RowListSort;
  onSortChange?: (sort: RowListSort) => void;
  /** Rows are loading; announces it and sets aria-busy. */
  busy?: boolean;
  /**
   * Resource lists inside an open section or page: tiles and titles line up
   * with the section's edge, the row hover bleeds 12px out with rounded
   * corners, and the hairlines stay inside the content edge.
   */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/* Hairlines drawn inside the row padding, so they end where the content does. */
const FLUSH_LIST = cn(
  "[&>li]:relative [&>li+li]:before:pointer-events-none [&>li+li]:before:absolute [&>li+li]:before:inset-x-3 [&>li+li]:before:top-0 [&>li+li]:before:h-px [&>li+li]:before:bg-border [&>li+li]:before:content-['']",
  "[&>li>div]:rounded-[10px]",
);

export function RowList({
  variant = "resource",
  columns = NO_COLUMNS,
  label,
  nameLabel = "Name",
  nameSortable = false,
  sort,
  onSortChange,
  busy = false,
  flush = false,
  className,
  children,
}: RowListProps) {
  const value = useMemo<RowListContextValue>(() => ({ variant, columns }), [variant, columns]);
  // In settings (grouped sections) a flush list that is not already inside a
  // section card becomes the card itself: rows keep their 12px padding, the
  // card adds 8px so titles sit 20px in, like setting rows.
  const frame = useSectionListFrame();
  const flushCard = flush && frame === "card";
  const templateStyle = {
    "--row-list-template": gridTemplate(columns, variant),
  } as CSSProperties;
  const busyNote = busy ? (
    <span role="status" className="sr-only">
      Loading {label.toLocaleLowerCase()}
    </span>
  ) : null;

  let body: ReactNode;
  if (variant === "table") {
    body = (
      <div
        role="table"
        aria-label={label}
        aria-busy={busy || undefined}
        className={cn("min-w-0 gap-x-4", SHARED_GRID)}
        style={templateStyle}
      >
        <div role="rowgroup" className={cn(SUBGRID, "hidden", "@[640px]/list:grid")}>
          <div
            role="row"
            className={cn(SUBGRID, "min-h-9 items-center border-b border-border px-3")}
          >
            <HeaderCell
              label={nameLabel}
              columnId="name"
              sortable={nameSortable}
              sort={sort}
              onSortChange={onSortChange}
            />
            {columns.map((column) => (
              <HeaderCell
                key={column.id}
                label={column.label}
                columnId={column.id}
                align={column.align}
                sortable={column.sortable}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
            <div role="columnheader">
              <span className="sr-only">Actions</span>
            </div>
          </div>
        </div>
        <div role="rowgroup" className={cn(SUBGRID, "divide-y divide-border")}>
          {children}
        </div>
      </div>
    );
  } else if (variant === "catalog") {
    body = (
      <ul
        aria-label={label}
        aria-busy={busy || undefined}
        className="m-0 grid min-w-0 list-none grid-cols-1 gap-x-6 gap-y-1 p-0 @[720px]/list:grid-cols-2"
      >
        {children}
      </ul>
    );
  } else {
    body = (
      <ul
        aria-label={label}
        aria-busy={busy || undefined}
        className={cn(
          "m-0 min-w-0 list-none gap-x-3 p-0",
          SHARED_GRID,
          flush ? FLUSH_LIST : "divide-y divide-border",
        )}
        style={templateStyle}
      >
        {children}
      </ul>
    );
  }

  return (
    <RowListContext.Provider value={value}>
      <LogoTileSizeProvider size={TILE_SIZE[variant]}>
        <div
          data-slot="row-list"
          data-variant={variant}
          data-flush={flush || undefined}
          data-frame={flushCard ? "card" : undefined}
          className={cn(
            "@container/list min-w-0",
            flushCard ? "rounded-lg border border-border bg-surface px-2 py-1" : flush && "-mx-3",
            className,
          )}
        >
          {busyNote}
          {body}
        </div>
      </LogoTileSizeProvider>
    </RowListContext.Provider>
  );
}

function HeaderCell({
  label,
  columnId,
  align = "start",
  sortable = false,
  sort,
  onSortChange,
}: {
  label: string;
  columnId: string;
  align?: "start" | "end";
  sortable?: boolean;
  sort?: RowListSort;
  onSortChange?: (sort: RowListSort) => void;
}) {
  const active = sort?.column === columnId;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
  const text = "text-xs leading-4.5 font-medium text-fg-subtle";
  if (!sortable || !onSortChange) {
    return (
      <div
        role="columnheader"
        className={cn("min-w-0 truncate", text, align === "end" && "text-right")}
      >
        {label}
      </div>
    );
  }
  const SortIcon = active
    ? sort.direction === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon
    : ChevronsUpDownIcon;
  return (
    <div
      role="columnheader"
      aria-sort={ariaSort}
      className={cn("min-w-0", align === "end" && "text-right")}
    >
      <button
        type="button"
        onClick={() =>
          onSortChange({
            column: columnId,
            direction: active && sort.direction === "asc" ? "desc" : "asc",
          })
        }
        className={cn(
          "-mx-1.5 inline-flex max-w-full items-center gap-1 rounded-[6px] px-1.5 py-0.5 transition-colors duration-[120ms] hover:bg-hover hover:text-fg pointer-coarse:min-h-11",
          text,
          active && "text-fg",
          align === "end" && "flex-row-reverse",
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        <SortIcon aria-hidden="true" className={cn("size-3.5 shrink-0", !active && "opacity-60")} />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   RowIndicator: the display-only trailing glyph. The row is the action.
   -------------------------------------------------------------------------- */

export type RowIndicatorKind =
  | "open"
  | "expand"
  | "external"
  | "add"
  | "added"
  | "attention"
  | "unavailable"
  | "loading";

const INDICATOR_LABEL: Record<RowIndicatorKind, string> = {
  open: "Open",
  expand: "Show details",
  external: "Opens in a new tab",
  add: "Available to add",
  added: "Added",
  attention: "Needs attention",
  unavailable: "Unavailable",
  loading: "Working",
};

export interface RowIndicatorProps {
  kind: RowIndicatorKind;
  /**
   * The state in words. Visible for "attention" and "unavailable" ("Needs
   * reconnect"); screen-reader only for the others.
   */
  label?: string;
  id?: string;
  className?: string;
}

export function RowIndicator({ kind, label, id, className }: RowIndicatorProps) {
  const Icon =
    kind === "open"
      ? ChevronRightIcon
      : kind === "expand"
        ? ChevronDownIcon
        : kind === "external"
          ? ArrowUpRightIcon
          : kind === "add"
            ? PlusIcon
            : kind === "added"
              ? CheckIcon
              : kind === "loading"
                ? LoaderCircleIcon
                : CircleAlertIcon;
  const visibleLabel = kind === "attention" || kind === "unavailable";
  return (
    <span
      data-slot="row-indicator"
      data-kind={kind}
      className={cn(
        "pointer-events-none inline-flex min-w-0 shrink-0 items-center justify-end gap-1.5",
        kind === "attention"
          ? "text-status-waiting"
          : kind === "added"
            ? "text-fg-muted"
            : "text-fg-subtle",
        className,
      )}
    >
      {visibleLabel ? (
        // On narrow lists the row repeats the words under its title (see
        // ListRow), so only the icon stays here and nothing truncates.
        <span
          id={id}
          className="max-w-40 min-w-0 truncate text-xs leading-4.5 font-medium @max-[479px]/list:sr-only"
        >
          {label ?? INDICATOR_LABEL[kind]}
        </span>
      ) : null}
      <Icon
        aria-hidden="true"
        className={cn(
          visibleLabel ? "size-4" : "size-[18px]",
          kind === "loading" && "motion-safe:animate-spin",
          kind === "expand" && "transition-transform duration-[120ms]",
        )}
      />
      {visibleLabel ? null : (
        <span id={id} className="sr-only">
          {label ?? INDICATOR_LABEL[kind]}
        </span>
      )}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   ListRow.
   -------------------------------------------------------------------------- */

type RowLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children">;

export interface ListRowProps {
  /** Leading tile: a LogoTile (sized by the list), an avatar or a status dot. */
  leading?: ReactNode | ((size: LogoTileSize) => ReactNode);
  /** One line, 14/500. The row's accessible name. */
  title: ReactNode;
  /** Small chips right after the title: "Organization", "Primary", "You". */
  titleAddon?: ReactNode;
  /** One sentence, 12/18 muted. Two lines in catalog rows, one elsewhere. */
  description?: ReactNode;
  /** Quiet facts joined with " · " (the meta line). */
  meta?: ReactNode[];
  /**
   * The row's state, usually a dot StatusBadge ("Suspended", "Invited ·
   * expires in 14 days"). It sits at the right of the name area on wide lists
   * and joins the meta line on narrow ones: a status never adds a line.
   */
  status?: ReactNode;
  /** Values for the list's fact columns, by column id. */
  cells?: Record<string, ReactNode>;
  /** Display-only trailing glyph. A kind, or a kind with its state in words. */
  indicator?: RowIndicatorKind | { kind: RowIndicatorKind; label?: string };
  /**
   * One interactive control (a switch, a small button). Sits above the row
   * target; drops under the text on narrow lists that have fact columns.
   */
  control?: ReactNode;
  /** Items for the row's ⋯ menu (DropdownMenuItem elements). */
  menu?: ReactNode;
  /** Accessible name of the ⋯ button. Default "More actions for <title>". */
  menuLabel?: string;
  /** Makes the whole row a button. */
  onOpen?: (event: MouseEvent<HTMLElement>) => void;
  /** Makes the whole row a link. */
  href?: string;
  /**
   * Extra props for the link (target, rel, router handlers). An in-app `href`
   * needs `onClick` (or `onOpen`) to call the router and preventDefault on a
   * plain click; otherwise the row loads the whole page.
   */
  linkProps?: RowLinkProps;
  /** The row's detail is open (sheet or page). */
  selected?: boolean;
  /**
   * Expand in place (one level of secondary detail). The row toggles `panel`
   * below it and announces aria-expanded. Prefer a sheet for anything larger.
   */
  expanded?: boolean;
  /** The content shown under the row while `expanded`. List layouts only. */
  panel?: ReactNode;
  /** Not actionable right now. Say why with `disabledReason`. */
  disabled?: boolean;
  /** Why the row can't be used, and who can fix it. Replaces the description. */
  disabledReason?: ReactNode;
  className?: string;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const RAISED = "[data-slot=relative-time], [data-slot=status-badge]";

export function ListRow({
  leading,
  title,
  titleAddon,
  description,
  meta = NO_META,
  status,
  cells = NO_CELLS,
  indicator,
  control,
  menu,
  menuLabel,
  onOpen,
  href,
  linkProps,
  selected = false,
  expanded,
  panel,
  disabled = false,
  disabledReason,
  className,
}: ListRowProps) {
  const { variant, columns } = useRowList();
  const actionRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const secondaryId = useId();
  const indicatorId = useId();
  const panelId = useId();
  const actionable = !disabled && Boolean(onOpen || href);
  const indicatorSpec = typeof indicator === "string" ? { kind: indicator } : indicator;
  const secondary = disabled && disabledReason ? disabledReason : description;
  // "Needs reconnect" and "Unavailable" move under the title on narrow lists.
  const narrowState =
    indicatorSpec && (indicatorSpec.kind === "attention" || indicatorSpec.kind === "unavailable")
      ? (indicatorSpec.label ?? INDICATOR_LABEL[indicatorSpec.kind])
      : null;
  const table = variant === "table";
  const catalog = variant === "catalog";
  const gridded = !catalog;
  const hasColumns = gridded && columns.length > 0;
  const expandable = !table && expanded !== undefined;

  /* The meta line: quiet facts, then the fact columns folded in on narrow lists. */
  const facts = columns.filter((column) => cells[column.id] != null);
  const metaItems = meta.filter((item) => item != null && item !== false && item !== "");
  // On one line the facts give way from the end: a later part truncates (and
  // then disappears) before an earlier one, so a narrow row reads "Fact ·
  // Staging runs on walrus-2…" instead of every part cut to a few letters.
  // Only the last meta item and the folded facts after it shrink at all: any
  // shrink, however small, would put an ellipsis into a short fact ("Fa…").
  const metaParts: ReactNode[] = [
    ...metaItems.map((item, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- meta items are positional
      <MetaPart key={`meta-${index}`} order={index} keep={index < metaItems.length - 1}>
        {item}
      </MetaPart>
    )),
    ...facts.map((column, index) => (
      <MetaPart
        key={column.id}
        order={metaItems.length + index}
        className={cn(
          hasColumns && "@[640px]/list:hidden",
          // A phone-width line has room for one folded fact (none next to a
          // status); more would only be cut to a dot and a few letters.
          (index > 0 || status) && "@max-[479px]/list:hidden",
        )}
      >
        {column.hideLabel ? null : <span className="text-fg-subtle">{column.label} </span>}
        <span className="text-fg-muted">{cells[column.id]}</span>
      </MetaPart>
    )),
  ];
  // Resource and table rows keep one fixed height: the description, the meta
  // facts and (on narrow lists) the status and indicator words share ONE
  // secondary line that truncates. Catalog rows keep a two-line description
  // with the facts under it.
  const singleLine = !catalog;
  const statusPart = status ? (
    <MetaPart key="status" keep className="@[480px]/list:hidden">
      {status}
    </MetaPart>
  ) : null;
  const narrowStatePart =
    singleLine && narrowState ? (
      <MetaPart
        key="narrow-state"
        keep
        hidden
        className={cn(
          "hidden font-medium @max-[479px]/list:flex",
          indicatorSpec?.kind === "attention" ? "text-status-waiting" : "text-fg-subtle",
        )}
      >
        {narrowState}
      </MetaPart>
    ) : null;
  const lineParts = [
    ...metaParts,
    ...(singleLine && statusPart ? [statusPart] : []),
    ...(narrowStatePart ? [narrowStatePart] : []),
  ];
  // Every part leads with its separator and the line is shifted left by one
  // separator and clipped, so no line of a wrapped meta line starts or ends
  // with a dot.
  const metaLine =
    !singleLine && metaParts.length > 0 ? (
      <div
        className={cn(
          "mt-0.5 min-w-0 overflow-hidden text-xs leading-4.5 text-fg-subtle",
          // Only folded facts: the line disappears once the columns show.
          hasColumns && metaItems.length === 0 && "@[640px]/list:hidden",
        )}
      >
        <p className="m-0 -ml-4 flex min-w-0 flex-wrap items-center">{metaParts}</p>
      </div>
    ) : null;

  /* The title is the row's action, stretched over the whole row. */
  // The chevron is decoration; every other indicator states something worth hearing.
  const announceIndicator =
    indicatorSpec && indicatorSpec.kind !== "open" && indicatorSpec.kind !== "expand";
  const labelledBy = [titleId, announceIndicator ? indicatorId : null].filter(Boolean).join(" ");
  const actionProps = {
    "data-row-action": "",
    "aria-labelledby": labelledBy,
    "aria-describedby": secondary ? secondaryId : undefined,
    "aria-current": selected ? ("true" as const) : undefined,
    "aria-expanded": expandable ? expanded : undefined,
    "aria-controls": expandable && expanded ? panelId : undefined,
    // The row draws the focus ring; the global focus outline is unlayered, so
    // only an inline style keeps it off the title.
    style: { outline: "none" },
    className: cn(
      "min-w-0 cursor-pointer truncate text-left text-sm leading-5 font-medium text-fg",
      "after:absolute after:inset-0 after:z-0 after:content-['']",
    ),
  };
  const titleNode = actionable ? (
    href ? (
      <a
        {...linkProps}
        {...actionProps}
        ref={actionRef as RefObject<HTMLAnchorElement>}
        href={href}
        // Both handlers run: `linkProps.onClick` is how callers keep a plain
        // click in the router. Letting an absent `onOpen` replace it made the
        // row a full page load.
        onClick={(event) => {
          onOpen?.(event);
          if (!event.defaultPrevented) linkProps?.onClick?.(event);
        }}
      >
        <span id={titleId}>{title}</span>
      </a>
    ) : (
      <button
        {...actionProps}
        ref={actionRef as RefObject<HTMLButtonElement>}
        type="button"
        onClick={onOpen}
      >
        <span id={titleId}>{title}</span>
      </button>
    )
  ) : (
    <span
      id={titleId}
      className={cn(
        "min-w-0 truncate text-sm leading-5 font-medium",
        disabled ? "text-fg-muted" : "text-fg",
      )}
    >
      {title}
    </span>
  );

  const leadingNode =
    typeof leading === "function" ? leading(TILE_SIZE[variant]) : leading ? leading : null;

  const menuNode = menu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={menuLabel ?? `More actions for ${textOf(title) || "this item"}`}
          className="grid size-8 shrink-0 place-items-center rounded-[10px] text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-3 hover:text-fg data-[state=open]:bg-surface-3 data-[state=open]:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {menu}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  // In gridded lists the control sits right after the text (before the fact
  // columns) and drops under the text when the list is narrow.
  const controlNode = control ? (
    <div
      className={cn(
        "relative z-10 flex shrink-0 items-center",
        hasColumns &&
          (table
            ? "@max-[639px]/list:basis-full @max-[639px]/list:pl-9"
            : "@max-[639px]/list:basis-full @max-[639px]/list:pl-11"),
      )}
    >
      {control}
    </div>
  ) : null;
  const controlInline = hasColumns;

  const trailingContent =
    indicatorSpec || menuNode || (control && !controlInline) ? (
      <>
        {controlInline ? null : controlNode}
        {menuNode ? <div className="relative z-10 flex items-center">{menuNode}</div> : null}
        {indicatorSpec ? (
          <RowIndicator
            kind={indicatorSpec.kind}
            label={indicatorSpec.label}
            id={indicatorId}
            className={
              indicatorSpec.kind === "expand" && expanded ? "[&>svg]:rotate-180" : undefined
            }
          />
        ) : null}
      </>
    ) : null;
  // Gridded rows always fill the trailing track so the grid stays in step.
  const trailing =
    trailingContent || gridded ? (
      <div
        role={table ? "cell" : undefined}
        className="flex min-w-0 shrink-0 items-center justify-end gap-1"
      >
        {trailingContent}
      </div>
    ) : null;

  const main = (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-x-3",
        controlInline && control && "flex-wrap gap-y-2",
      )}
    >
      {leadingNode ? (
        <div
          className={cn(
            "flex shrink-0 items-center justify-center",
            disabled && "opacity-60 grayscale",
          )}
        >
          {leadingNode}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {titleNode}
          {titleAddon ? (
            // Held to the title's 20px line: a chip never makes its row taller.
            <span className="flex h-5 shrink-0 items-center gap-1.5">{titleAddon}</span>
          ) : null}
        </div>
        {secondary && (catalog || (disabled && disabledReason)) ? (
          <p
            id={secondaryId}
            className={cn(
              "mt-0.5 min-w-0 text-xs leading-4.5 text-fg-muted",
              // A disabled reason is the point of the row: it never truncates.
              disabled && disabledReason ? "break-words" : "line-clamp-2 break-words",
            )}
          >
            {secondary}
          </p>
        ) : null}
        {singleLine && ((secondary && !(disabled && disabledReason)) || lineParts.length > 0) ? (
          <p
            className={cn(
              "m-0 mt-0.5 flex min-w-0 items-center overflow-hidden text-xs leading-4.5 whitespace-nowrap text-fg-subtle",
              // Tables keep rows to one line once the columns show, unless
              // the line still has facts that aren't columns.
              table && metaItems.length === 0 && "@[640px]/list:hidden",
              // Only folded facts: the line disappears once the columns show.
              !table &&
                !secondary &&
                hasColumns &&
                metaItems.length === 0 &&
                !status &&
                !narrowState &&
                "@[640px]/list:hidden",
            )}
          >
            {secondary && !(disabled && disabledReason) ? (
              <span id={secondaryId} className="min-w-0 shrink truncate text-fg-muted">
                {secondary}
              </span>
            ) : null}
            {lineParts.length > 0 ? (
              <span
                className={cn(
                  "flex min-w-0 shrink-[2] items-center overflow-hidden",
                  // No description: drop the first part's leading dot.
                  !(secondary && !(disabled && disabledReason)) && "-ml-4",
                )}
              >
                {lineParts}
              </span>
            ) : null}
          </p>
        ) : null}
        {metaLine}
        {!singleLine && narrowState ? (
          <p
            aria-hidden="true"
            className={cn(
              "mt-1 hidden min-w-0 items-center text-xs leading-4.5 font-medium @max-[479px]/list:flex",
              indicatorSpec?.kind === "attention" ? "text-status-waiting" : "text-fg-subtle",
            )}
          >
            <span className="min-w-0 truncate">{narrowState}</span>
          </p>
        ) : null}
      </div>
      {status ? (
        <div className="relative z-10 hidden shrink-0 items-center @[480px]/list:flex">
          {status}
        </div>
      ) : null}
      {controlInline ? controlNode : null}
    </div>
  );

  const factColumns = hasColumns
    ? columns.map((column) => {
        const value = cells[column.id];
        return (
          <div
            key={column.id}
            role={table ? "cell" : undefined}
            className={cn(
              "hidden min-w-0 @[640px]/list:block",
              column.align === "end" && "text-right",
            )}
          >
            {table ? (
              <span className="block truncate text-sm leading-5 text-fg-muted">
                {value ?? <span className="text-fg-subtle">-</span>}
              </span>
            ) : value == null ? null : (
              <>
                {column.hideLabel ? null : (
                  <span className="block truncate text-2xs leading-4 text-fg-subtle">
                    {column.label}
                  </span>
                )}
                <span className="block truncate text-xs leading-4.5 text-fg-muted">{value}</span>
              </>
            )}
          </div>
        );
      })
    : null;

  // Times and badges float above the stretched target so their tooltips work
  // on hover; a click on them still opens the row.
  const forwardClick = actionable
    ? (event: MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || !(event.target instanceof Element)) return;
        if (event.target.closest("[data-row-action]")) return;
        if (!event.target.closest(RAISED)) return;
        actionRef.current?.click();
      }
    : undefined;

  const rowClass = cn(
    // isolate: the raised times and badges stack inside the row, never above
    // sticky headers or overlays around the list.
    "group/row relative isolate min-w-0 items-center transition-colors duration-[120ms]",
    "[&_[data-slot=relative-time]]:relative [&_[data-slot=relative-time]]:z-10 [&_[data-slot=status-badge]]:relative [&_[data-slot=status-badge]]:z-10",
    catalog && "flex min-h-[76px] gap-3 rounded-[14px] px-3 py-3.5",
    // One fixed height per list type: 64px resource rows (title plus one
    // secondary line; a title-only row centers in the same height).
    variant === "resource" && cn(SUBGRID, "min-h-16 px-3 py-3"),
    table && cn(SUBGRID, "min-h-11 px-3 py-2"),
    actionable && "hover:bg-hover",
    selected &&
      cn(
        "bg-selection hover:bg-selection",
        "before:absolute before:top-1/2 before:left-0 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-brand before:content-['']",
      ),
    // Focus ring on the whole row when its target has keyboard focus.
    actionable &&
      cn(
        "has-[[data-row-action]:focus-visible]:outline-2 has-[[data-row-action]:focus-visible]:outline-brand/55",
        catalog
          ? "has-[[data-row-action]:focus-visible]:outline-offset-2"
          : "has-[[data-row-action]:focus-visible]:-outline-offset-2",
      ),
    className,
  );

  const content = (
    <RelativeTimeDefaultsContext.Provider value={ROW_TIME_DEFAULTS}>
      {table ? (
        <div role="rowheader" className="flex min-w-0 items-center">
          {main}
        </div>
      ) : (
        main
      )}
      {factColumns}
      {trailing}
    </RelativeTimeDefaultsContext.Provider>
  );

  if (table) {
    return (
      <div
        role="row"
        data-slot="list-row"
        data-selected={selected || undefined}
        data-disabled={disabled || undefined}
        aria-disabled={disabled || undefined}
        className={rowClass}
        onClick={forwardClick}
      >
        {content}
      </div>
    );
  }

  return (
    <li
      data-slot="list-row"
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      data-expanded={expandable ? expanded : undefined}
      aria-disabled={disabled || undefined}
      className={cn("min-w-0", gridded && SUBGRID)}
    >
      <div className={rowClass} onClick={forwardClick}>
        {content}
      </div>
      {expandable && expanded && panel ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={titleId}
          className={cn("col-span-full min-w-0 pr-3 pb-4", catalog ? "pl-16" : "pl-14")}
        >
          {panel}
        </div>
      ) : null}
    </li>
  );
}

function MetaPart({
  className,
  children,
  hidden = false,
  order = 0,
  keep = false,
}: {
  className?: string;
  children: ReactNode;
  /** A visual copy of something already announced elsewhere. */
  hidden?: boolean;
  /** Position on the line: later parts give way first when it runs out of room. */
  order?: number;
  /** Never shrinks (a status): it stays whole while the facts before it give way. */
  keep?: boolean;
}) {
  return (
    <span
      aria-hidden={hidden || undefined}
      style={{ flexShrink: keep ? 0 : 64 ** Math.min(order, 4) }}
      className={cn(
        "flex max-w-full min-w-0 items-center overflow-hidden whitespace-nowrap",
        className,
      )}
    >
      <span aria-hidden="true" className="w-4 shrink-0 text-center text-fg-subtle">
        ·
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/* ----------------------------------------------------------------------------
   Loading placeholders in the same geometry as the list's rows.
   -------------------------------------------------------------------------- */

export function ListRowSkeleton({ count = 3 }: { count?: number }) {
  const { variant, columns } = useRowList();
  const table = variant === "table";
  const catalog = variant === "catalog";
  const tile = catalog
    ? "size-10 rounded-[10px]"
    : variant === "resource"
      ? "size-8 rounded-[10px]"
      : "size-6 rounded-[6px]";
  const widths = ["w-2/5", "w-1/3", "w-1/2", "w-1/4"];
  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        const inner = (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Skeleton className={cn("shrink-0 bg-surface-2", tile)} />
              <div className="min-w-0 flex-1">
                <Skeleton
                  className={cn("h-3.5 rounded-full bg-surface-2", widths[index % widths.length])}
                />
                {table ? null : (
                  <Skeleton
                    className={cn(
                      "mt-2 h-3 rounded-full bg-surface-2",
                      catalog ? "w-4/5" : "w-3/5",
                    )}
                  />
                )}
              </div>
            </div>
            {catalog
              ? null
              : columns.map((column) => (
                  <div key={column.id} className="hidden min-w-0 @[640px]/list:block">
                    {table ? null : <Skeleton className="h-2.5 w-12 rounded-full bg-surface-2" />}
                    <Skeleton
                      className={cn("h-3 w-20 rounded-full bg-surface-2", !table && "mt-1.5")}
                    />
                  </div>
                ))}
            {catalog ? null : <div />}
          </>
        );
        const rowClass = cn(
          "min-w-0 items-center",
          catalog && "flex min-h-[76px] gap-3 px-3 py-3.5",
          // One fixed height per list type: 64px resource rows (title plus one
          // secondary line; a title-only row centers in the same height).
          variant === "resource" && cn(SUBGRID, "min-h-16 px-3 py-3"),
          table && cn(SUBGRID, "min-h-11 px-3 py-2"),
        );
        return table ? (
          // oxlint-disable-next-line react/no-array-index-key -- identical placeholders
          <div key={index} role="row" aria-hidden="true" className={rowClass}>
            {inner}
          </div>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- identical placeholders
          <li key={index} aria-hidden="true" className={cn(!catalog && SUBGRID)}>
            <div className={rowClass}>{inner}</div>
          </li>
        );
      })}
    </>
  );
}
