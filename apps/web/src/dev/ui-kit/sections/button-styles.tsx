import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  EllipsisIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  PlusIcon,
} from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { LogoTile } from "@/components/ui/logo-tile";
import { cn } from "@/lib/utils";
import { schedules, variableSetById } from "../fixtures";
import { Alternative, Fork, KitSection, UsageNotes, useKitPane } from "../kit";
import { ThemeScope, type ResolvedTheme } from "../theme";
import type { ForkAlternativeId } from "./registry";

/* ----------------------------------------------------------------------------
   Button styles: five directions for the app's buttons, each applied to the
   same screens in dark and light.

   These are proposals, not the production Button. Each direction is a scoped
   stylesheet keyed by `data-dir` on the composition root, built from the
   theme tokens (plus two proposed indigo values for C). Hover, pressed and
   focus can be forced with `data-force` so the states strip shows them
   without a pointer.
   -------------------------------------------------------------------------- */

type Dir = ForkAlternativeId;
type Kind = "primary" | "secondary" | "ghost" | "danger" | "inline";
type Force = "hover" | "active" | "focus";

const DIRS: readonly Dir[] = ["a", "b", "c", "d", "e"];

interface DirSpec {
  /** Primary create actions get a leading "+". */
  plus: boolean;
  /** One line of the measurable choices. */
  spec: string;
}

const DIR_SPECS: Record<Dir, DirSpec> = {
  a: { plus: true, spec: "32px high · 8px radius · medium weight · leading + on create" },
  b: { plus: true, spec: "32px high · 8px radius · semibold primary · leading + on create" },
  c: { plus: false, spec: "36px high · 10px radius · medium weight · no icons in primaries" },
  d: { plus: true, spec: "32px high · 8px radius · medium weight · brand + on create" },
  e: { plus: false, spec: "32px high · fully rounded · medium weight · no icons in primaries" },
};

/* ----------------------------------------------------------------------------
   The stylesheet.
   -------------------------------------------------------------------------- */

const fg = "var(--color-fg)";
const bg = "var(--color-bg)";
const s1 = "var(--color-surface)";
const s2 = "var(--color-surface-2)";
const s3 = "var(--color-surface-3)";
const bd = "var(--color-border)";
const bds = "var(--color-border-strong)";
const muted = "var(--color-fg-muted)";
const subtle = "var(--color-fg-subtle)";
const brand = "var(--color-brand)";
const danger = "var(--color-danger)";
const onFill = "var(--color-brand-fg)";
const mix = (a: string, pct: number, b = "transparent") =>
  `color-mix(in oklch, ${a} ${pct}%, ${b})`;

/* Direction C's proposed indigo: darker and far less saturated than the brand blue. */
const indigo = {
  dark: {
    fill: "oklch(0.45 0.095 268)",
    hover: "oklch(0.49 0.1 268)",
    active: "oklch(0.42 0.09 268)",
    edge: "oklch(0.53 0.095 268)",
    text: "oklch(0.8 0.075 268)",
  },
  light: {
    fill: "oklch(0.4 0.105 268)",
    hover: "oklch(0.44 0.11 268)",
    active: "oklch(0.37 0.1 268)",
    edge: "oklch(0.34 0.1 268)",
    text: "oklch(0.44 0.12 268)",
  },
};

interface KindStyle {
  base: string;
  hover?: string;
  active?: string;
  disabled?: string;
}

interface DirStyle {
  vars: string;
  kinds: Partial<Record<Kind, KindStyle>>;
  /** Overrides for the light theme, merged over the dark rules. */
  light?: Partial<Record<Kind, KindStyle>>;
}

const inkPrimary: KindStyle = {
  base: `background:${fg};color:${bg};`,
  hover: `background:${mix(fg, 92, bg)};`,
  active: `background:${mix(fg, 84, bg)};`,
  disabled: `background:${s3};color:${subtle};`,
};

const quietGhost: KindStyle = {
  base: `background:transparent;color:${muted};`,
  hover: `background:${s2};color:${fg};`,
  active: `background:${s3};color:${fg};`,
};

const dangerFill: KindStyle = {
  base: `background:${mix(danger, 76, "black")};color:${onFill};`,
  hover: `background:${mix(danger, 86, "black")};`,
  active: `background:${mix(danger, 68, "black")};`,
};

const dangerFillLight: KindStyle = {
  base: `background:${danger};color:${onFill};`,
  hover: `background:${mix(danger, 90, "black")};`,
  active: `background:${mix(danger, 80, "black")};`,
};

const DIR_STYLES: Record<Dir, DirStyle> = {
  // A. Inverted ink.
  a: {
    vars: "--kb-h:32px;--kb-h-sm:28px;--kb-r:8px;--kb-px:12px;--kb-fw:500;",
    kinds: {
      primary: inkPrimary,
      secondary: {
        base: `background:transparent;border-color:${bd};color:${fg};`,
        hover: `background:${s2};border-color:${mix(bds, 60, bd)};`,
        active: `background:${s3};`,
        disabled: `color:${subtle};`,
      },
      ghost: quietGhost,
      danger: dangerFill,
      inline: quietGhost,
    },
    light: {
      secondary: {
        base: `background:${s1};border-color:${mix(bds, 55, bd)};color:${fg};`,
        hover: `background:${s2};border-color:${bds};`,
        active: `background:${s3};`,
      },
      danger: dangerFillLight,
    },
  },
  // B. Quiet surface.
  b: {
    vars: "--kb-h:32px;--kb-h-sm:28px;--kb-r:8px;--kb-px:12px;--kb-fw:500;",
    kinds: {
      primary: {
        base: `background:${s3};border-color:${mix(bds, 75, bd)};color:${fg};font-weight:600;--kb-shadow:inset 0 1px 0 oklch(1 0 0 / 0.06),0 1px 2px oklch(0 0 0 / 0.3);`,
        hover: `background:${mix(s3, 72, bds)};border-color:${bds};`,
        active: `background:${s2};--kb-shadow:inset 0 1px 2px oklch(0 0 0 / 0.25);`,
        disabled: `background:transparent;border-color:${bd};color:${subtle};font-weight:500;--kb-shadow:0 0 #0000;`,
      },
      secondary: {
        base: `background:transparent;border-color:${bd};color:${muted};`,
        hover: `background:${s2};color:${fg};`,
        active: `background:${s3};color:${fg};`,
        disabled: `color:${subtle};`,
      },
      ghost: quietGhost,
      danger: dangerFill,
      inline: quietGhost,
    },
    light: {
      primary: {
        base: `background:${s1};border-color:${mix(bds, 55, fg)};color:${fg};font-weight:600;--kb-shadow:0 1px 2px oklch(0.2 0.02 260 / 0.12),0 1px 1px oklch(0.2 0.02 260 / 0.05);`,
        hover: `background:${s2};border-color:${mix(bds, 80, fg)};`,
        active: `background:${s3};--kb-shadow:inset 0 1px 2px oklch(0.2 0.02 260 / 0.1);`,
        disabled: `background:${s2};border-color:transparent;color:${subtle};font-weight:500;--kb-shadow:0 0 #0000;`,
      },
      secondary: {
        base: `background:transparent;border-color:${mix(bds, 55, bd)};color:${muted};`,
        hover: `background:${s2};color:${fg};`,
        active: `background:${s3};color:${fg};`,
      },
      danger: dangerFillLight,
    },
  },
  // C. Deep indigo.
  c: {
    vars: "--kb-h:36px;--kb-h-sm:30px;--kb-r:10px;--kb-px:14px;--kb-fw:500;",
    kinds: {
      primary: {
        base: `background:${indigo.dark.fill};border-color:${indigo.dark.edge};color:oklch(0.975 0.008 268);--kb-shadow:inset 0 1px 0 oklch(1 0 0 / 0.1),0 1px 2px oklch(0 0 0 / 0.35);`,
        hover: `background:${indigo.dark.hover};`,
        active: `background:${indigo.dark.active};--kb-shadow:inset 0 1px 2px oklch(0 0 0 / 0.25);`,
        disabled: `background:${s3};border-color:transparent;color:${subtle};--kb-shadow:0 0 #0000;`,
      },
      secondary: {
        base: `background:${s2};border-color:${bd};color:${fg};`,
        hover: `background:${s3};border-color:${mix(bds, 60, bd)};`,
        active: `background:${s2};`,
        disabled: `color:${subtle};`,
      },
      ghost: quietGhost,
      danger: dangerFill,
      inline: {
        base: `background:transparent;color:${indigo.dark.text};`,
        hover: `background:${mix(indigo.dark.fill, 22)};`,
        active: `background:${mix(indigo.dark.fill, 32)};`,
      },
    },
    light: {
      primary: {
        base: `background:${indigo.light.fill};border-color:${indigo.light.edge};color:oklch(0.99 0.004 268);--kb-shadow:inset 0 1px 0 oklch(1 0 0 / 0.12),0 1px 2px oklch(0.25 0.06 268 / 0.25);`,
        hover: `background:${indigo.light.hover};`,
        active: `background:${indigo.light.active};--kb-shadow:inset 0 1px 2px oklch(0 0 0 / 0.2);`,
        disabled: `background:${s3};border-color:transparent;color:${subtle};--kb-shadow:0 0 #0000;`,
      },
      secondary: {
        base: `background:${s1};border-color:${mix(bds, 60, bd)};color:${fg};--kb-shadow:0 1px 2px oklch(0.2 0.02 260 / 0.06);`,
        hover: `background:${s2};`,
        active: `background:${s3};`,
      },
      danger: dangerFillLight,
      inline: {
        base: `background:transparent;color:${indigo.light.text};`,
        hover: `background:${mix(indigo.light.fill, 9)};`,
        active: `background:${mix(indigo.light.fill, 15)};`,
      },
    },
  },
  // D. Outline accent.
  d: {
    vars: "--kb-h:32px;--kb-h-sm:28px;--kb-r:8px;--kb-px:12px;--kb-fw:500;",
    kinds: {
      primary: {
        base: `background:${mix(brand, 6)};border-color:${mix(brand, 62)};color:${brand};`,
        hover: `background:${mix(brand, 12)};border-color:${brand};`,
        active: `background:${mix(brand, 18)};`,
        disabled: `background:transparent;border-color:${bd};color:${subtle};`,
      },
      secondary: {
        base: `background:transparent;border-color:${bd};color:${fg};`,
        hover: `background:${mix(fg, 5)};border-color:${mix(bds, 70, bd)};`,
        active: `background:${mix(fg, 9)};`,
        disabled: `color:${subtle};`,
      },
      ghost: {
        base: `background:transparent;border-color:${bd};color:${muted};`,
        hover: `background:${mix(fg, 5)};color:${fg};border-color:${mix(bds, 70, bd)};`,
        active: `background:${mix(fg, 9)};color:${fg};`,
      },
      danger: {
        base: `background:${mix(danger, 6)};border-color:${mix(danger, 60)};color:${danger};`,
        hover: `background:${mix(danger, 12)};border-color:${danger};`,
        active: `background:${mix(danger, 18)};`,
      },
      inline: {
        base: `background:transparent;border-color:${mix(brand, 45)};color:${brand};`,
        hover: `background:${mix(brand, 10)};border-color:${mix(brand, 70)};`,
        active: `background:${mix(brand, 16)};`,
      },
    },
    light: {
      secondary: {
        base: `background:${s1};border-color:${mix(bds, 60, bd)};color:${fg};`,
        hover: `background:${s2};border-color:${bds};`,
        active: `background:${s3};`,
      },
      ghost: {
        base: `background:${s1};border-color:${mix(bds, 60, bd)};color:${muted};`,
        hover: `background:${s2};color:${fg};border-color:${bds};`,
        active: `background:${s3};color:${fg};`,
      },
    },
  },
  // E. Ink pills.
  e: {
    vars: "--kb-h:32px;--kb-h-sm:28px;--kb-r:9999px;--kb-px:14px;--kb-fw:500;",
    kinds: {
      primary: inkPrimary,
      secondary: {
        base: `background:${s2};color:${fg};`,
        hover: `background:${s3};`,
        active: `background:${mix(s3, 75, bds)};`,
        disabled: `color:${subtle};`,
      },
      ghost: quietGhost,
      danger: dangerFill,
      inline: {
        base: `background:${s2};color:${fg};`,
        hover: `background:${s3};`,
        active: `background:${mix(s3, 75, bds)};`,
      },
    },
    light: {
      secondary: {
        base: `background:${s3};color:${fg};`,
        hover: `background:${mix(s3, 82, bds)};`,
        active: `background:${mix(s3, 65, bds)};`,
      },
      inline: {
        base: `background:${s3};color:${fg};`,
        hover: `background:${mix(s3, 82, bds)};`,
        active: `background:${mix(s3, 65, bds)};`,
      },
      danger: dangerFillLight,
    },
  },
};

const HOVER = ":is(:hover:not(:disabled),[data-force=hover])";
const ACTIVE = ":is(:active:not(:disabled),[data-force=active])";

function kindRules(scope: string, kind: Kind, style: KindStyle): string {
  const sel = `${scope} .kb[data-kind="${kind}"]`;
  const rules = [`${sel}{${style.base}}`];
  if (style.hover) rules.push(`${sel}${HOVER}{${style.hover}}`);
  if (style.active) rules.push(`${sel}${ACTIVE}{${style.active}}`);
  if (style.disabled) rules.push(`${sel}:disabled{${style.disabled}}`);
  return rules.join("\n");
}

function buildStylesheet(): string {
  const rules: string[] = [
    `.bsk{--kb-shadow:0 0 #0000;--kb-ring:${mix(brand, 70)};--kb-gap:${bg};}`,
    `.bsk .kb-on-surface{--kb-gap:${s1};}`,
    `.bsk .kb{position:relative;display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;gap:6px;height:var(--kb-h);padding:0 var(--kb-px);border-radius:var(--kb-r);border:1px solid transparent;font-size:14px;line-height:20px;font-weight:var(--kb-fw);letter-spacing:-0.006em;white-space:nowrap;box-shadow:var(--kb-shadow);outline:none;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease;}`,
    `.bsk .kb svg{width:16px;height:16px;flex-shrink:0;}`,
    `.bsk .kb[data-icon-only]{width:var(--kb-h);padding:0;}`,
    `.bsk .kb[data-size=sm]{height:var(--kb-h-sm);padding:0 10px;gap:4px;font-size:13px;}`,
    `.bsk .kb[data-size=sm]:has(> svg:first-child){padding-left:7px;}`,
    `.bsk .kb[data-size=sm] svg{width:14px;height:14px;}`,
    `.bsk .kb:is(:focus-visible,[data-force=focus]){box-shadow:var(--kb-shadow),0 0 0 2px var(--kb-gap),0 0 0 4px var(--kb-ring);}`,
    `.bsk .kb:disabled{cursor:not-allowed;}`,
    `.bsk .kb .kb-plus{color:inherit;opacity:0.9;}`,
    `.bsk[data-dir="d"] .kb[data-kind="primary"] .kb-plus{opacity:1;}`,
    `.bsk .kb-link{color:${brand};text-decoration:none;border-radius:4px;}`,
    `.bsk .kb-link:hover{text-decoration:underline;text-underline-offset:3px;}`,
  ];
  for (const dir of DIRS) {
    const style = DIR_STYLES[dir];
    const scope = `.bsk[data-dir="${dir}"]`;
    rules.push(`${scope}{${style.vars}}`);
    for (const [kind, kindStyle] of Object.entries(style.kinds) as Array<[Kind, KindStyle]>) {
      rules.push(kindRules(scope, kind, kindStyle));
    }
    for (const [kind, kindStyle] of Object.entries(style.light ?? {}) as Array<[Kind, KindStyle]>) {
      rules.push(kindRules(`${scope}[data-t="light"]`, kind, kindStyle));
    }
  }
  return rules.join("\n");
}

const STYLESHEET = buildStylesheet();

/* ----------------------------------------------------------------------------
   The button and the pieces of the composition.
   -------------------------------------------------------------------------- */

const DirContext = createContext<Dir>("a");

function KB({
  kind,
  size,
  force,
  iconOnly,
  className,
  children,
  ...props
}: Omit<ComponentProps<"button">, "type"> & {
  kind: Kind;
  size?: "sm";
  force?: Force;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      // Opts out of the global focus outline; the direction draws its own ring.
      data-slot="button"
      data-kind={kind}
      data-size={size}
      data-force={force}
      data-icon-only={iconOnly ? "" : undefined}
      className={cn("kb", className)}
      {...props}
    >
      {children}
    </button>
  );
}

/** A create action: a leading "+" in directions that use one. */
function CreateLabel({ children }: { children: ReactNode }) {
  const dir = useContext(DirContext);
  return (
    <>
      {DIR_SPECS[dir].plus ? <PlusIcon className="kb-plus" aria-hidden="true" /> : null}
      {children}
    </>
  );
}

function MoreButton({ label, force }: { label: string; force?: Force }) {
  return (
    <KB kind="ghost" iconOnly aria-label={label} force={force}>
      <EllipsisIcon aria-hidden="true" />
    </KB>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-2.5 text-xs leading-4.5 font-medium text-fg-subtle">{children}</p>;
}

const set = variableSetById("vs-aws-production");
const schedule = schedules[0]!;

function PageHeaderDemo() {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b border-border pb-4">
      <div className="min-w-0">
        <h3 className="text-xl leading-7 font-semibold tracking-[-0.5px] text-fg">Variable sets</h3>
        <p className="mt-0.5 truncate text-sm leading-5 text-fg-muted">
          Environment variables and secrets your agents get in their sandbox.
        </p>
      </div>
      <KB kind="primary">
        <CreateLabel>New variable set</CreateLabel>
      </KB>
    </div>
  );
}

function DetailHeaderDemo() {
  return (
    <div className="min-w-0">
      <a
        href="#schedules"
        onClick={(event) => event.preventDefault()}
        className="mb-3 inline-flex items-center gap-1 text-xs leading-4.5 font-medium text-fg-muted hover:text-fg"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        Schedules
      </a>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <LogoTile size="md" icon={<CalendarClockIcon />} />
          <div className="min-w-0">
            <h3 className="truncate text-base leading-6 font-semibold tracking-[-0.25px] text-fg">
              {schedule.name}
            </h3>
            <p className="truncate text-sm leading-5 text-fg-muted">
              {schedule.cadenceLabel} · next {schedule.nextRunLabel.toLowerCase()}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <KB kind="secondary">Pause</KB>
          <KB kind="primary">Run now</KB>
          <MoreButton label={`More actions for ${schedule.name}`} />
        </div>
      </div>
    </div>
  );
}

/** A read-only field drawn with tokens only (the Input primitive uses `dark:` variants, which a forced pane can't flip). */
function StaticField({ label, value }: { label: string; value: string }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-sm leading-5 font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        readOnly
        defaultValue={value}
        className="mt-1.5 block h-9 w-full min-w-0 rounded-[8px] border border-border bg-bg px-3 font-mono text-sm text-fg"
      />
    </div>
  );
}

function FormFooterDemo() {
  const variable = set.variables[2]!;
  return (
    <div className="kb-on-surface min-w-0 rounded-[14px] border border-border bg-surface">
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <StaticField label="Name" value={variable.name} />
        <StaticField label="Value" value={variable.value ?? ""} />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <KB kind="secondary">Cancel</KB>
        <KB kind="primary">Save variable</KB>
      </div>
    </div>
  );
}

function EmptyStateDemo() {
  return (
    <div className="min-w-0 rounded-[14px] border border-dashed border-border">
      <EmptyState
        variant="page"
        className="px-4 pt-8 pb-8"
        icon={<MessageSquareIcon />}
        title="No sessions yet"
        description="A session is where an agent works on a task, with its own sandbox and history."
        action={
          <KB kind="primary">
            <CreateLabel>Start your first session</CreateLabel>
          </KB>
        }
      />
    </div>
  );
}

function DestructiveDemo() {
  const usedBy = set.usedBy[0]!;
  return (
    <div
      role="group"
      aria-label={`Delete ${set.name}?`}
      className="kb-on-surface min-w-0 rounded-[14px] border border-border bg-surface p-5 shadow-lg"
    >
      <p className="text-base leading-6 font-semibold text-fg">Delete {set.name}?</p>
      <p className="mt-1.5 text-sm leading-5 text-fg-muted">
        Its {set.variablesLabel} are removed and {usedBy.name} loses access at its next run. This
        can't be undone.
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <KB kind="secondary">Cancel</KB>
        <KB kind="danger">Delete variable set</KB>
      </div>
    </div>
  );
}

function InlineAddDemo() {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="text-sm leading-5 font-semibold text-fg">
          Variables <span className="ml-1 font-normal text-fg-subtle tabular-nums">4</span>
        </p>
        <KB kind="inline" size="sm">
          <PlusIcon aria-hidden="true" />
          Add
        </KB>
      </div>
      <ul className="mt-2 divide-y divide-border rounded-[14px] border border-border bg-surface">
        {set.variables.slice(1, 3).map((variable) => (
          <li key={variable.name} className="flex min-w-0 items-center gap-3 px-4 py-2.5">
            <KeyRoundIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
              {variable.name}
            </span>
            <span className="shrink-0 text-xs text-fg-subtle">
              {variable.kind === "secret" ? "Secret" : variable.value} · {variable.updatedLabel}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-4.5 text-fg-muted">
        {set.usageLabel}.{" "}
        <a
          href="#usage"
          onClick={(event) => event.preventDefault()}
          className="kb-link font-medium"
        >
          See where it's used
        </a>
      </p>
    </div>
  );
}

function StatesStrip() {
  const cells: Array<{ label: string; node: ReactNode }> = [
    { label: "Rest", node: <KB kind="primary">Save</KB> },
    {
      label: "Hover",
      node: (
        <KB kind="primary" force="hover">
          Save
        </KB>
      ),
    },
    {
      label: "Pressed",
      node: (
        <KB kind="primary" force="active">
          Save
        </KB>
      ),
    },
    {
      label: "Focus",
      node: (
        <KB kind="primary" force="focus">
          Save
        </KB>
      ),
    },
    {
      label: "Disabled",
      node: (
        <KB kind="primary" disabled>
          Save
        </KB>
      ),
    },
    { label: "Secondary", node: <KB kind="secondary">Cancel</KB> },
    {
      label: "Hover",
      node: (
        <KB kind="secondary" force="hover">
          Cancel
        </KB>
      ),
    },
    {
      label: "Focus",
      node: (
        <KB kind="secondary" force="focus">
          Cancel
        </KB>
      ),
    },
    { label: "Icon", node: <MoreButton label="More actions" /> },
    { label: "Hover", node: <MoreButton label="More actions" force="hover" /> },
  ];
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-3 gap-y-3">
      {cells.map((cell, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- static list, never reordered
        <div key={index} className="flex min-w-0 flex-col items-start gap-1.5">
          <span className="text-2xs leading-4 text-fg-subtle">{cell.label}</span>
          {cell.node}
        </div>
      ))}
    </div>
  );
}

function Composition({ dir, theme }: { dir: Dir; theme: ResolvedTheme }) {
  return (
    <DirContext.Provider value={dir}>
      <ThemeScope theme={theme} className="h-full min-w-0">
        <div data-dir={dir} data-t={theme} className="bsk flex min-w-0 flex-col gap-7 p-6">
          <p className="-mb-3 text-xs leading-4.5 font-semibold text-fg">
            {theme === "dark" ? "Dark" : "Light"}
          </p>
          <section className="min-w-0">
            <Label>Page header</Label>
            <PageHeaderDemo />
          </section>
          <section className="min-w-0">
            <Label>Detail header</Label>
            <DetailHeaderDemo />
          </section>
          <section className="min-w-0">
            <Label>Form footer</Label>
            <FormFooterDemo />
          </section>
          <section className="min-w-0">
            <Label>Empty state</Label>
            <EmptyStateDemo />
          </section>
          <section className="min-w-0">
            <Label>Destructive confirm</Label>
            <DestructiveDemo />
          </section>
          <section className="min-w-0">
            <Label>Inline add and a link</Label>
            <InlineAddDemo />
          </section>
          <section className="min-w-0">
            <Label>States</Label>
            <StatesStrip />
          </section>
        </div>
      </ThemeScope>
    </DirContext.Provider>
  );
}

function DirectionPreview({ dir }: { dir: Dir }) {
  const pane = useKitPane();
  // In the shell's Side by side each pane already has a theme: show only that one.
  const themes: ResolvedTheme[] = pane.count > 1 ? [pane.theme] : ["dark", "light"];
  return (
    <div className="@container/bs min-w-0">
      <p className="border-b border-border px-5 py-2.5 text-xs leading-4.5 text-fg-muted">
        {DIR_SPECS[dir].spec}
      </p>
      <div
        className={cn(
          "grid min-w-0",
          themes.length === 2 &&
            "divide-y divide-border @4xl/bs:grid-cols-2 @4xl/bs:divide-x @4xl/bs:divide-y-0",
        )}
      >
        {themes.map((theme) => (
          <Composition key={theme} dir={dir} theme={theme} />
        ))}
      </div>
    </div>
  );
}

export default function ButtonStylesSection() {
  return (
    <KitSection sectionKey="button-styles">
      <style>{STYLESHEET}</style>
      <Fork layout="stack" title="Pick a button style">
        {DIRS.map((dir) => (
          <Alternative key={dir} id={dir} padding={false}>
            <DirectionPreview dir={dir} />
          </Alternative>
        ))}
      </Fork>
      <UsageNotes
        title="Rules that hold in every version"
        use={[
          "One primary per screen: the action the page exists for",
          "Cancel, Edit and Pause are secondary; row and header menus are icon buttons",
          "A destructive fill only inside the confirm, never on the page itself",
        ]}
        avoid={[
          "A primary for every action in a header",
          "Brand-colored fills outside the one primary",
        ]}
      >
        The pick becomes the Button primitive's default, secondary and destructive variants, and
        every page follows it. Nothing in production changes until then.
      </UsageNotes>
    </KitSection>
  );
}
