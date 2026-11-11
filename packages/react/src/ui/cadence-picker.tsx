/* ----------------------------------------------------------------------------
   CadencePicker - say when something runs, as a sentence, with a preview.

   Two halves:
   1. Pure cadence logic (no React), in `cadence-model.ts` and re-exported
      here: describe a rule in words, compute the next runs in the schedule's
      time zone, validate it, parse typed text, and map it to and from the API
      schedule spec. Unit tested in `cadence-picker.test.ts`.
   2. The picker itself, with three variants:
      - "sentence" (default): [Every weekday] at [08:00] [Oslo time]
      - "presets": labelled preset chips and fields, with a summary line
      - "text": type "every weekday at 8" and see the rule it becomes

   Words come from the host's message catalog (`cadence.*`): components read
   `useOpenGeniText()`, and the pure functions take it as `text` in their
   options, English when omitted. Typed text (`parseCadence`, the "text"
   variant) reads English.
   -------------------------------------------------------------------------- */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CalendarClockIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GlobeIcon,
  SearchIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive, Select as SelectPrimitive } from "radix-ui";

import { InlineDisabledReason, SelectMenuPanel, type SelectOption } from "./select-menu";
import { MENU_CHECK_CLASS, MENU_SURFACE_CLASS } from "./menu-styles";
import { cn } from "../lib/cn";
import { containedPortal } from "./portal-container";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";
import {
  type Weekday,
  type IntervalUnit,
  type CadenceRule,
  type CadenceFrequency,
  type CadenceValue,
  WEEKDAYS,
  weekdayName,
  monthName,
  UNIT_LIMITS,
  DEFAULT_CADENCE_TIME,
  type LocalDate,
  zonedParts,
  localDateOf,
  addDays,
  dayNumber,
  weekdayOf,
  daysInMonth,
  formatLocalDate,
  parseLocalDate,
  timeZoneLabels,
  pad,
  parseTime,
  normalizeTime,
  stepTime,
  type RunFormatOptions,
  dateLabel,
  describeNextRuns,
  sortDays,
  describeCadence,
  normalizeCadenceRule,
  type CadenceField,
  type CadenceIssue,
  validateCadence,
  nextRuns,
  parseCadence,
} from "./cadence-model";

const SelectContainedPortal = containedPortal(SelectPrimitive.Portal);
const PopoverContainedPortal = containedPortal(PopoverPrimitive.Portal);

/* ============================================================================
   1. Cadence logic: pure, in ./cadence-model so non-DOM hosts can use it too
   ========================================================================== */

export {
  type Weekday,
  type IntervalUnit,
  type CadenceRule,
  type CadenceFrequency,
  type CadenceValue,
  type ApiWeekday,
  type CadenceScheduleSpec,
  WEEKDAYS,
  DEFAULT_CADENCE_TIME,
  type LocalDate,
  zonedParts,
  zonedTimeToUtc,
  formatLocalDate,
  parseLocalDate,
  timeZoneLabels,
  parseTime,
  normalizeTime,
  stepTime,
  type RunFormatOptions,
  formatRunTime,
  describeNextRuns,
  type CadenceDescribeOptions,
  type CadenceDescription,
  describeCadence,
  normalizeCadenceRule,
  type CadenceField,
  type CadenceIssue,
  validateCadence,
  type NextRunOptions,
  nextRuns,
  toScheduleSpec,
  cadenceFromScheduleSpec,
  type CadenceParseResult,
  parseCadence,
} from "./cadence-model";

/* ============================================================================
   2. The picker
   ========================================================================== */

export type CadencePickerVariant = "sentence" | "presets" | "text";

export interface CadenceTimeZoneOption {
  /** IANA id, "Europe/Oslo". */
  id: string;
  /** "Oslo time". */
  label: string;
  /** "Oslo". */
  shortLabel?: string | undefined;
  /** "UTC+2". */
  offsetLabel?: string | undefined;
}

export interface CadencePickerProps {
  value: CadenceValue;
  /** Called with every valid change. The text variant only reports rules it could read. */
  onChange: (value: CadenceValue) => void;
  /**
   * "sentence" (default): [Every weekday] at [08:00] [Oslo time].
   * "presets": labelled preset chips and fields.
   * "text": type the cadence in words.
   */
  variant?: CadencePickerVariant | undefined;
  /** Suggested zones, listed first. Search also covers every zone the browser knows. */
  timeZones?: readonly CadenceTimeZoneOption[] | undefined;
  /** Limit the frequencies a picker offers. */
  frequencies?: readonly CadenceFrequency[] | undefined;
  /** The clock for previews. Defaults to the time of the first render. */
  now?: Date | undefined;
  /** When it differs from the schedule's zone, the preview adds the viewer's local time. */
  viewerTimeZone?: string | undefined;
  /** How many upcoming runs the preview lists. Default 3. */
  previewCount?: number | undefined;
  disabled?: boolean | undefined;
  /** Shown under the picker while it is disabled: who can change it. */
  disabledReason?: ReactNode | undefined;
  /** The surrounding field label ("When"). */
  "aria-labelledby"?: string | undefined;
  className?: string | undefined;
}

const ALL_FREQUENCIES: readonly CadenceFrequency[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "interval",
  "once",
];

interface FrequencyWords {
  /** In the menu: "Every day". */
  label: string;
  /** On the closed menu: "Every day", or "Every" before an interval's number. */
  trigger: string;
  /** On a preset chip: "Daily". */
  preset: string;
  /** Under the menu label: "Including weekends". */
  description: string;
}

function frequencyWords(t: OpenGeniText, frequency: CadenceFrequency): FrequencyWords {
  switch (frequency) {
    case "hourly":
      return {
        label: t("cadence.frequency.hourly"),
        trigger: t("cadence.frequency.hourly"),
        preset: t("cadence.frequency.hourlyPreset"),
        description: t("cadence.frequency.hourlyDescription"),
      };
    case "daily":
      return {
        label: t("cadence.frequency.daily"),
        trigger: t("cadence.frequency.daily"),
        preset: t("cadence.frequency.dailyPreset"),
        description: t("cadence.frequency.dailyDescription"),
      };
    case "weekdays":
      return {
        label: t("cadence.frequency.weekdays"),
        trigger: t("cadence.frequency.weekdays"),
        preset: t("cadence.frequency.weekdaysPreset"),
        description: t("cadence.frequency.weekdaysDescription"),
      };
    case "weekly":
      return {
        label: t("cadence.frequency.weekly"),
        trigger: t("cadence.frequency.weekly"),
        preset: t("cadence.frequency.weeklyPreset"),
        description: t("cadence.frequency.weeklyDescription"),
      };
    case "monthly":
      return {
        label: t("cadence.frequency.monthly"),
        trigger: t("cadence.frequency.monthly"),
        preset: t("cadence.frequency.monthlyPreset"),
        description: t("cadence.frequency.monthlyDescription"),
      };
    case "interval":
      return {
        label: t("cadence.frequency.interval"),
        trigger: t("cadence.frequency.intervalTrigger"),
        preset: t("cadence.frequency.intervalPreset"),
        description: t("cadence.frequency.intervalDescription"),
      };
    case "once":
      return {
        label: t("cadence.frequency.once"),
        trigger: t("cadence.frequency.once"),
        preset: t("cadence.frequency.oncePreset"),
        description: t("cadence.frequency.onceDescription"),
      };
  }
}

function unitOptions(
  t: OpenGeniText,
  every: number,
): Array<{ value: IntervalUnit; label: string }> {
  const one = every === 1;
  return [
    { value: "minutes", label: one ? t("cadence.unit.minute") : t("cadence.unit.minutes") },
    { value: "hours", label: one ? t("cadence.unit.hour") : t("cadence.unit.hours") },
    { value: "days", label: one ? t("cadence.unit.day") : t("cadence.unit.days") },
  ];
}

function ruleTime(rule: CadenceRule): string | undefined {
  if (rule.frequency === "hourly") return undefined;
  if (rule.frequency === "once") return "at" in rule ? undefined : rule.time;
  return rule.time;
}

function usesTime(rule: CadenceRule): boolean {
  if (rule.frequency === "hourly") return false;
  if (rule.frequency === "interval") return rule.unit === "days";
  return true;
}

/** Switching frequency keeps what still applies: the time, the days. */
export function switchFrequency(
  rule: CadenceRule,
  frequency: CadenceFrequency,
  { timeZone, now }: RunFormatOptions,
): CadenceRule {
  const time = ruleTime(rule) ?? DEFAULT_CADENCE_TIME;
  switch (frequency) {
    case "hourly":
      return { frequency: "hourly" };
    case "daily":
      return { frequency: "daily", time };
    case "weekdays":
      return { frequency: "weekdays", time };
    case "weekly":
      return {
        frequency: "weekly",
        days: rule.frequency === "weekly" && rule.days.length > 0 ? rule.days : ["mon"],
        time,
      };
    case "monthly":
      return { frequency: "monthly", dayOfMonth: 1, time };
    case "interval":
      return { frequency: "interval", every: 30, unit: "minutes" };
    case "once":
      return {
        frequency: "once",
        date: formatLocalDate(addDays(localDateOf(now, timeZone), 1)),
        time,
      };
  }
}

function withTime(rule: CadenceRule, time: string): CadenceRule {
  if (rule.frequency === "hourly") return rule;
  if (rule.frequency === "once") return "at" in rule ? rule : { ...rule, time };
  return { ...rule, time };
}

/** The typed form of a rule, without "Runs" or the zone: "every weekday at 08:00". */
export function cadencePhrase(rule: CadenceRule, timeZone: string, now?: Date): string {
  const { sentence } = describeCadence(rule, { timeZone, timeZoneLabel: "", now });
  return sentence.replace(/^Runs /, "").trim();
}

/* ---------------------------------------------------------------- styles */

// Matches the Select primitive (select-menu.tsx): 36px, radius 10, 14/400 value,
// hover and open darken the border, disabled fills with surface-2.
const fieldBase =
  "inline-flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-sm text-fg transition-colors duration-[120ms] hover:border-border-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-fg-muted aria-invalid:border-danger aria-invalid:hover:border-danger data-[state=open]:border-border-strong pointer-coarse:h-11";

// Text inputs also take the brand border on focus, like TextInput (field.tsx).
const inputBase = cn(
  fieldBase,
  "cursor-text justify-center px-2 text-center tabular-nums focus-visible:border-brand pointer-coarse:text-base",
);

// Popovers are the one menu surface (menu-styles.ts); their bodies set the inset.
const popoverPanel = cn(MENU_SURFACE_CLASS, "z-50 overflow-hidden p-0 outline-hidden");

const menuContent = cn(
  popoverPanel,
  "max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width)",
);

const menuItem =
  "relative flex min-h-8 cursor-pointer items-start gap-2.5 rounded-[10px] py-1.5 pr-9 pl-2.5 text-sm text-fg outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:text-fg-muted data-[highlighted]:bg-surface-2 pointer-coarse:min-h-11";

const connector = "text-sm text-fg-muted";

/* ---------------------------------------------------------------- value select */

interface ValueOption<V extends string> {
  value: V;
  label: string;
  description?: string | undefined;
}

function ValueSelect<V extends string>({
  value,
  options,
  onValueChange,
  triggerLabel,
  label,
  disabled,
  invalid,
  describedBy,
  className,
  contentClassName,
}: {
  value: V;
  options: readonly ValueOption<V>[];
  onValueChange: (value: V) => void;
  triggerLabel?: string | undefined;
  /** Accessible name. */
  label: string;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  className?: string | undefined;
  contentClassName?: string | undefined;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
      disabled={disabled ?? false}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(fieldBase, "group/value-select justify-between", className)}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value>{triggerLabel ?? selected?.label}</SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-data-[state=open]/value-select:rotate-180"
          />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectContainedPortal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          align="start"
          className={cn(menuContent, contentClassName)}
        >
          <SelectPrimitive.Viewport className="max-h-[26rem] p-1.5">
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} className={menuItem}>
                <span className="flex min-w-0 flex-col">
                  <SelectPrimitive.ItemText>
                    <span>{option.label}</span>
                  </SelectPrimitive.ItemText>
                  {option.description ? (
                    <span className="mt-0.5 text-xs leading-4.5 text-fg-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <SelectPrimitive.ItemIndicator className="absolute top-2 right-2.5">
                  <CheckIcon aria-hidden="true" className={MENU_CHECK_CLASS} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectContainedPortal>
    </SelectPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- time field */

/** A 24-hour time input. Type "8", "830" or "8pm"; arrow keys step 15 minutes. */
export function TimeField({
  value,
  onChange,
  label: labelProp,
  disabled,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const label = labelProp ?? t("cadence.picker.time");
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);
  const normalized = normalizeTime(draft);
  const invalid = !normalized || !parseTime(value);

  const commit = () => {
    if (normalized) {
      setDraft(normalized);
      if (normalized !== value) onChange(normalized);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = stepTime(normalized ?? value, event.key === "ArrowUp" ? 15 : -15);
      setDraft(next);
      onChange(next);
    } else if (event.key === "Enter") {
      commit();
    }
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={draft}
      maxLength={8}
      placeholder="08:00"
      onChange={(event) => {
        setDraft(event.target.value);
        const next = normalizeTime(event.target.value);
        if (next && /^\d{1,2}[:.]\d{2}$/.test(event.target.value.trim())) onChange(next);
      }}
      onFocus={(event) => {
        setFocused(true);
        event.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={onKeyDown}
      className={cn(inputBase, "w-[4.75rem] placeholder:text-fg-subtle", className)}
    />
  );
}

/* ---------------------------------------------------------------- number field */

function NumberField({
  value,
  onChange,
  label,
  max,
  disabled,
  invalid,
  describedBy,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  max: number;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        const text = event.target.value.replace(/[^\d]/g, "").slice(0, 4);
        setDraft(text);
        if (text) onChange(Number(text));
      }}
      onBlur={() => setDraft(String(value))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        onChange(Math.min(max, Math.max(1, value + (event.key === "ArrowUp" ? 1 : -1))));
      }}
      className={cn(inputBase, "w-16")}
    />
  );
}

/* ---------------------------------------------------------------- days */

function DayToggleGroup({
  days,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  days: readonly Weekday[];
  onChange: (days: Weekday[]) => void;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  const t = useOpenGeniText();
  return (
    <div
      role="group"
      aria-label={t("cadence.picker.days")}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-0.5 rounded-[10px] border p-[3px] transition-colors duration-[120ms] pointer-coarse:h-11",
        invalid ? "border-danger" : "border-border",
        disabled ? "bg-surface-2" : "bg-surface",
      )}
    >
      {WEEKDAYS.map((day) => {
        const on = days.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={on}
            aria-label={weekdayName(t, day, "long")}
            disabled={disabled}
            onClick={() =>
              onChange(on ? days.filter((each) => each !== day) : sortDays([...days, day]))
            }
            className={cn(
              "inline-flex h-7 w-9 items-center justify-center rounded-sm text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed pointer-coarse:h-9 pointer-coarse:w-10",
              on
                ? "bg-brand/10 text-brand disabled:bg-surface-3 disabled:text-fg-muted"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg disabled:text-fg-subtle disabled:hover:bg-transparent",
            )}
          >
            {weekdayName(t, day, "short").slice(0, 2)}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- time zones */

// Every zone the browser knows, labelled in each text's words.
const allZonesCache = new WeakMap<OpenGeniText, CadenceTimeZoneOption[]>();
const NO_TIME_ZONES: readonly CadenceTimeZoneOption[] = [];

function offsetLabelFor(timeZone: string, at: Date): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (!name || name === "GMT") return "UTC";
    return name.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

function allTimeZones(at: Date, t: OpenGeniText): CadenceTimeZoneOption[] {
  const cached = allZonesCache.get(t);
  if (cached) return cached;
  const ids =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = ids.map((id) => ({
    id,
    ...timeZoneLabels(id, t),
    offsetLabel: offsetLabelFor(id, at),
  }));
  allZonesCache.set(t, zones);
  return zones;
}

function zoneOption(
  timeZone: string,
  suggested: readonly CadenceTimeZoneOption[],
  at: Date,
  t: OpenGeniText,
): CadenceTimeZoneOption {
  return (
    suggested.find((zone) => zone.id === timeZone) ?? {
      id: timeZone,
      ...timeZoneLabels(timeZone, t),
      offsetLabel: offsetLabelFor(timeZone, at),
    }
  );
}

/**
 * The searchable list inside the time zone picker. Exported so a sheet or the
 * kit can show it inline; the picker renders it in a popover.
 */
export function TimeZoneSearch({
  value,
  onSelect,
  timeZones = NO_TIME_ZONES,
  now,
  initialQuery = "",
  autoFocus = true,
  preview = false,
  className,
}: {
  value: string;
  onSelect: (timeZone: string) => void;
  timeZones?: readonly CadenceTimeZoneOption[] | undefined;
  now?: Date | undefined;
  initialQuery?: string | undefined;
  autoFocus?: boolean | undefined;
  /** A static, inert copy for previews and docs (like ComboboxPanelPreview). */
  preview?: boolean | undefined;
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const [clock] = useState(() => now ?? new Date());
  const [query, setQuery] = useState(initialQuery);
  const listId = useId();
  const optionPrefix = useId();
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...timeZones];
    const seen = new Set<string>();
    const results: CadenceTimeZoneOption[] = [];
    for (const zone of [...timeZones, ...allTimeZones(clock, t)]) {
      if (seen.has(zone.id)) continue;
      const haystack = `${zone.label} ${zone.id} ${zone.offsetLabel ?? ""}`.toLowerCase();
      if (haystack.includes(needle)) {
        seen.add(zone.id);
        results.push(zone);
      }
      if (results.length >= 50) break;
    }
    return results;
  }, [clock, query, t, timeZones]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((zone) => zone.id === value),
    ),
  );
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const searching = query.trim().length > 0;
  // The same option list as every other select and combobox (SelectMenuPanel).
  const panelOptions = useMemo<SelectOption[]>(
    () =>
      options.map((zone) => ({
        value: zone.id,
        label: zone.label,
        meta: zone.offsetLabel || undefined,
        // Search results name the region so "New Salem time" is findable and clear.
        description: searching && zone.id.includes("/") ? regionOf(zone.id) : undefined,
        group: searching ? undefined : t("cadence.picker.suggested"),
      })),
    [options, searching, t],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) =>
        options.length === 0
          ? 0
          : (Math.min(current, options.length - 1) + delta + options.length) % options.length,
      );
    } else if (event.key === "Enter") {
      const zone = options[activeIndex];
      if (zone) {
        event.preventDefault();
        onSelect(zone.id);
      }
    }
  };

  return (
    <SelectMenuPanel
      options={panelOptions}
      value={value}
      activeIndex={options.length > 0 ? activeIndex : -1}
      onActiveIndexChange={setActive}
      onSelect={onSelect}
      listboxId={listId}
      idPrefix={optionPrefix}
      aria-label={t("cadence.picker.timeZones")}
      preview={preview}
      emptyMessage={t("cadence.picker.noZonesMatch", { query: query.trim() })}
      className={className}
      header={
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
          <input
            role="combobox"
            aria-expanded={!preview}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              options[activeIndex] ? `${optionPrefix}-${activeIndex}` : undefined
            }
            aria-label={t("cadence.picker.searchZones")}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus moves into the opened picker
            autoFocus={autoFocus && !preview}
            autoComplete="off"
            spellCheck={false}
            readOnly={preview}
            value={query}
            placeholder={t("cadence.picker.searchZonesPlaceholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-hidden! placeholder:text-fg-subtle pointer-coarse:text-base"
          />
        </div>
      }
    />
  );
}

function regionOf(timeZone: string): string {
  return timeZone.split("/").slice(0, -1).join(" / ").replaceAll("_", " ");
}

/** "Oslo time" with a search popover. */
export function TimeZonePicker({
  value,
  onChange,
  timeZones = NO_TIME_ZONES,
  now,
  disabled,
  className,
  variant = "field",
}: {
  value: string;
  onChange: (timeZone: string) => void;
  timeZones?: readonly CadenceTimeZoneOption[] | undefined;
  now?: Date | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** "field" is a bordered control; "ghost" sits inside another field. */
  variant?: "field" | "ghost" | undefined;
}) {
  const t = useOpenGeniText();
  const [open, setOpen] = useState(false);
  const [clock] = useState(() => now ?? new Date());
  const current = zoneOption(value, timeZones, clock, t);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        disabled={disabled}
        aria-label={t("cadence.picker.timeZoneLabel", { zone: current.label })}
        className={cn(
          fieldBase,
          "group/zone justify-between",
          variant === "ghost" &&
            "h-7 gap-1.5 border-transparent bg-transparent px-2 text-fg-muted hover:border-transparent hover:bg-surface-2 hover:text-fg disabled:bg-transparent data-[state=open]:border-transparent data-[state=open]:bg-surface-2 data-[state=open]:text-fg pointer-coarse:h-9",
          className,
        )}
      >
        {variant === "ghost" ? <GlobeIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
        {variant === "ghost" && current.shortLabel ? (
          // Inside a narrow field the city alone is enough ("Oslo").
          <>
            <span className="min-w-0 truncate @max-[26rem]/cadence-text:hidden">
              {current.label}
            </span>
            <span className="hidden min-w-0 truncate @max-[26rem]/cadence-text:inline">
              {current.shortLabel}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate">{current.label}</span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-data-[state=open]/zone:rotate-180"
        />
      </PopoverPrimitive.Trigger>
      <PopoverContainedPortal>
        <PopoverPrimitive.Content
          align={variant === "ghost" ? "end" : "start"}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            popoverPanel,
            "flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-24px))] flex-col",
          )}
        >
          <TimeZoneSearch
            value={value}
            timeZones={timeZones}
            now={clock}
            onSelect={(zone) => {
              onChange(zone);
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverContainedPortal>
    </PopoverPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- date field */

function CalendarGrid({
  value,
  min,
  onSelect,
}: {
  value: LocalDate | null;
  min: LocalDate;
  onSelect: (date: LocalDate) => void;
}) {
  const t = useOpenGeniText();
  const [focus, setFocus] = useState<LocalDate>(value ?? min);
  const [view, setView] = useState({ year: focus.year, month: focus.month });
  const gridRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(true);

  useEffect(() => {
    if (!shouldFocus.current) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${formatLocalDate(focus)}"]`)
      ?.focus();
  }, [focus, view]);

  const first: LocalDate = { year: view.year, month: view.month, day: 1 };
  const leading = WEEKDAYS.indexOf(weekdayOf(first));
  const total = daysInMonth(view.year, view.month);
  const cells: Array<LocalDate | null> = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: total }, (_, index) => ({ ...first, day: index + 1 })),
  ];
  const minDay = dayNumber(min);

  const move = (date: LocalDate) => {
    const target = dayNumber(date) < minDay ? min : date;
    shouldFocus.current = true;
    setFocus(target);
    setView({ year: target.year, month: target.month });
  };

  const shiftMonth = (delta: number) => {
    const index = view.month - 1 + delta;
    const year = view.year + Math.floor(index / 12);
    const month = (((index % 12) + 12) % 12) + 1;
    shouldFocus.current = false;
    setView({ year, month });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      move(addDays(focus, step));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const delta = event.key === "PageUp" ? -1 : 1;
      const index = focus.month - 1 + delta;
      const year = focus.year + Math.floor(index / 12);
      const month = (((index % 12) + 12) % 12) + 1;
      move({ year, month, day: Math.min(focus.day, daysInMonth(year, month)) });
    }
  };

  const canGoBack = view.year > min.year || (view.year === min.year && view.month > min.month);

  return (
    <div className="w-[17.5rem] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p aria-live="polite" className="text-sm font-semibold text-fg">
          {t("cadence.picker.monthYear", {
            month: monthName(t, view.month, "long"),
            year: view.year,
          })}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("cadence.picker.previousMonth")}
            disabled={!canGoBack}
            onClick={() => shiftMonth(-1)}
            className="grid size-8 place-items-center rounded-[10px] text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:text-fg-subtle disabled:hover:bg-transparent pointer-coarse:size-11"
          >
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("cadence.picker.nextMonth")}
            onClick={() => shiftMonth(1)}
            className="grid size-8 place-items-center rounded-[10px] text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-11"
          >
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label={t("cadence.picker.monthYear", {
          month: monthName(t, view.month, "long"),
          year: view.year,
        })}
        onKeyDown={onKeyDown}
      >
        <div role="row" className="grid grid-cols-7">
          {WEEKDAYS.map((day) => (
            <span
              key={day}
              role="columnheader"
              aria-label={weekdayName(t, day, "long")}
              className="grid h-8 place-items-center text-xs font-medium text-fg-subtle"
            >
              {weekdayName(t, day, "short").slice(0, 2)}
            </span>
          ))}
        </div>
        {Array.from({ length: Math.ceil(cells.length / 7) }, (_, row) => (
          <div
            key={`week-${view.year}-${view.month}-${row}`}
            role="row"
            className="grid grid-cols-7"
          >
            {cells.slice(row * 7, row * 7 + 7).map((date, column) => {
              // Leading blanks only occur in the first row, before day 1.
              if (!date) return <span key={`blank-${WEEKDAYS[column]}`} role="gridcell" />;
              const iso = formatLocalDate(date);
              const selected = value !== null && dayNumber(value) === dayNumber(date);
              const isToday = dayNumber(date) === minDay;
              const past = dayNumber(date) < minDay;
              const focused = dayNumber(date) === dayNumber(focus);
              return (
                <span key={iso} role="gridcell" aria-selected={selected}>
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={focused ? 0 : -1}
                    disabled={past}
                    aria-label={t(
                      isToday ? "cadence.picker.monthDayToday" : "cadence.picker.monthDay",
                      {
                        weekday: weekdayName(t, weekdayOf(date), "long"),
                        day: date.day,
                        month: monthName(t, date.month, "long"),
                        year: date.year,
                      },
                    )}
                    onClick={() => onSelect(date)}
                    className={cn(
                      "relative mx-auto grid size-9 place-items-center rounded-[10px] text-sm tabular-nums transition-colors duration-[120ms]",
                      selected
                        ? "border border-primary-border bg-primary font-medium text-primary-foreground"
                        : past
                          ? "cursor-not-allowed text-fg-subtle"
                          : "text-fg hover:bg-surface-2",
                    )}
                  >
                    {date.day}
                    {isToday && !selected ? (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 size-1 rounded-full bg-brand"
                      />
                    ) : null}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DateField({
  value,
  onChange,
  timeZone,
  now,
  disabled,
  invalid,
  describedBy,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  timeZone: string;
  now: Date;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const [open, setOpen] = useState(false);
  const date = parseLocalDate(value);
  const today = localDateOf(now, timeZone);
  const label = date ? dateLabel(t, date, today) : t("cadence.picker.pickDate");
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        disabled={disabled}
        aria-label={t("cadence.picker.dateLabel", { date: label })}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(fieldBase, "justify-between", className)}
      >
        <CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        <span className="min-w-0 truncate">{label}</span>
      </PopoverPrimitive.Trigger>
      <PopoverContainedPortal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={popoverPanel}
        >
          <CalendarGrid
            value={date}
            min={today}
            onSelect={(picked) => {
              onChange(formatLocalDate(picked));
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverContainedPortal>
    </PopoverPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- preview */

/**
 * The live summary under a cadence: the rule as a sentence, the next runs,
 * or what to fix. Exported for read-only places such as a schedule sheet.
 */
export function CadencePreview({
  value,
  now,
  timeZones = NO_TIME_ZONES,
  viewerTimeZone,
  count = 3,
  issue,
  id,
  className,
}: {
  value: CadenceValue;
  now: Date;
  timeZones?: readonly CadenceTimeZoneOption[] | undefined;
  viewerTimeZone?: string | undefined;
  count?: number | undefined;
  /** Overrides the rule's own validation, for example a parse error. */
  issue?: string | null | undefined;
  id?: string | undefined;
  className?: string | undefined;
}) {
  const t = useOpenGeniText();
  const zone = zoneOption(value.timeZone, timeZones, now, t);
  const options = { timeZone: value.timeZone, now, text: t };
  const problem = issue ?? validateCadence(value.rule, options)?.message ?? null;
  const description = describeCadence(value.rule, {
    timeZone: value.timeZone,
    timeZoneLabel: zone.label,
    timeZoneShortLabel: zone.shortLabel,
    now,
    text: t,
  });
  const runs = problem ? [] : nextRuns(value.rule, { ...options, count });
  const viewerZone =
    viewerTimeZone && viewerTimeZone !== value.timeZone && usesTime(value.rule)
      ? viewerTimeZone
      : null;
  const viewerLine =
    viewerZone && runs[0]
      ? (() => {
          const local = zonedParts(runs[0], viewerZone);
          const viewerLabel = zoneOption(viewerZone, timeZones, now, t).label;
          return t("cadence.picker.viewerTime", {
            time: `${pad(local.hour)}:${pad(local.minute)}`,
            zone: viewerLabel,
          });
        })()
      : null;

  // A problem reads like every other field error (field.tsx): a red line, no box.
  if (problem) {
    return (
      <p
        id={id}
        role="status"
        aria-live="polite"
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger",
          className,
        )}
      >
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{problem}</span>
      </p>
    );
  }

  return (
    <div
      id={id}
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2.5",
        className,
      )}
    >
      <CalendarClockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{description.sentence}.</p>
        <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
          {runs.length > 0 ? (
            <>
              <span className="text-fg-subtle">{t("cadence.picker.next")}</span>
              {describeNextRuns(runs, options)}
            </>
          ) : (
            t("cadence.picker.noUpcomingRuns")
          )}
        </p>
        {viewerLine ? (
          <p className="mt-0.5 text-xs leading-4.5 text-fg-subtle">{viewerLine}</p>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the picker */

interface PartProps {
  value: CadenceValue;
  update: (rule: CadenceRule) => void;
  updateZone: (timeZone: string) => void;
  issue: CadenceIssue | null;
  issueId: string;
  now: Date;
  disabled?: boolean | undefined;
  timeZones: readonly CadenceTimeZoneOption[];
  frequencies: readonly CadenceFrequency[];
}

function FrequencySelect({ value, update, now, disabled, frequencies }: PartProps) {
  const rule = value.rule;
  const t = useOpenGeniText();
  return (
    <ValueSelect<CadenceFrequency>
      label={t("cadence.picker.howOften")}
      value={rule.frequency}
      triggerLabel={frequencyWords(t, rule.frequency).trigger}
      disabled={disabled}
      options={frequencies.map((frequency) => {
        const words = frequencyWords(t, frequency);
        return { value: frequency, label: words.label, description: words.description };
      })}
      onValueChange={(frequency) =>
        update(switchFrequency(rule, frequency, { timeZone: value.timeZone, now }))
      }
      contentClassName="w-64"
    />
  );
}

const DAY_OF_MONTH_OPTIONS: ValueOption<string>[] = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/** Inline, each phrase ("on day [1]") wraps as one unit so a word never dangles. */
function Phrase({ inline, children }: { inline: boolean; children: ReactNode }) {
  return inline ? (
    <span className="inline-flex min-w-0 items-center gap-2">{children}</span>
  ) : (
    <>{children}</>
  );
}

function RuleDetails({
  value,
  update,
  issue,
  issueId,
  now,
  disabled,
  layout,
}: PartProps & { layout: "inline" | "stacked" }) {
  const rule = normalizeCadenceRule(value.rule, value.timeZone);
  const invalid = (field: CadenceField) => issue?.field === field;
  const described = (field: CadenceField) => (issue?.field === field ? issueId : undefined);
  const t = useOpenGeniText();
  const word = (text: string) =>
    layout === "inline" ? <span className={connector}>{text}</span> : null;
  const inline = layout === "inline";

  switch (rule.frequency) {
    case "weekly":
      return (
        <Phrase inline={inline}>
          {word(t("cadence.picker.wordOn"))}
          <DayToggleGroup
            days={rule.days}
            disabled={disabled}
            invalid={invalid("days")}
            describedBy={described("days")}
            onChange={(days) => update({ ...rule, days })}
          />
        </Phrase>
      );
    case "monthly":
      return (
        <Phrase inline={inline}>
          {word(t("cadence.picker.wordOnDay"))}
          <ValueSelect
            label={t("cadence.picker.dayOfMonth")}
            value={String(rule.dayOfMonth)}
            options={DAY_OF_MONTH_OPTIONS}
            disabled={disabled}
            invalid={invalid("dayOfMonth")}
            describedBy={described("dayOfMonth")}
            onValueChange={(day) => update({ ...rule, dayOfMonth: Number(day) })}
            className="w-[4.5rem]"
            contentClassName="w-24"
          />
        </Phrase>
      );
    case "interval":
      return (
        <Phrase inline={inline}>
          <NumberField
            label={t("cadence.picker.everyHowMany")}
            value={rule.every}
            max={UNIT_LIMITS[rule.unit]}
            disabled={disabled}
            invalid={invalid("every")}
            describedBy={described("every")}
            onChange={(every) => update({ ...rule, every })}
          />
          <ValueSelect<IntervalUnit>
            label={t("cadence.picker.unit")}
            value={rule.unit}
            options={unitOptions(t, rule.every)}
            disabled={disabled}
            onValueChange={(unit) =>
              update(
                unit === "days"
                  ? {
                      frequency: "interval",
                      every: Math.min(rule.every, UNIT_LIMITS.days),
                      unit,
                      time: rule.time ?? DEFAULT_CADENCE_TIME,
                    }
                  : { frequency: "interval", every: Math.min(rule.every, UNIT_LIMITS[unit]), unit },
              )
            }
            className="w-[6.5rem]"
          />
        </Phrase>
      );
    case "once":
      if ("at" in rule) return null;
      return (
        <Phrase inline={inline}>
          {word(t("cadence.picker.wordOn"))}
          <DateField
            value={rule.date}
            timeZone={value.timeZone}
            now={now}
            disabled={disabled}
            invalid={invalid("date")}
            describedBy={described("date")}
            onChange={(date) => update({ ...rule, date })}
          />
        </Phrase>
      );
    default:
      return null;
  }
}

function monthDayHint(t: OpenGeniText, rule: CadenceRule): string | null {
  if (rule.frequency !== "monthly" || rule.dayOfMonth <= 28) return null;
  return rule.dayOfMonth === 29
    ? t("cadence.picker.skipsFebruary")
    : t("cadence.picker.skipsShortMonths", { day: rule.dayOfMonth });
}

function SentenceVariant(props: PartProps) {
  const { value, update, updateZone, now, disabled, timeZones } = props;
  const rule = value.rule;
  const time = ruleTime(normalizeCadenceRule(rule, value.timeZone));
  const showTime = usesTime(rule) && time !== undefined;
  const t = useOpenGeniText();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <FrequencySelect {...props} />
      {rule.frequency === "hourly" ? (
        <span className={connector}>{t("cadence.picker.onTheHour")}</span>
      ) : null}
      <RuleDetails {...props} layout="inline" />
      {showTime ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className={connector}>{t("cadence.picker.wordAt")}</span>
          <TimeField
            value={time}
            disabled={disabled}
            onChange={(next) => update(withTime(normalizeCadenceRule(rule, value.timeZone), next))}
          />
          <TimeZonePicker
            value={value.timeZone}
            onChange={updateZone}
            timeZones={timeZones}
            now={now}
            disabled={disabled}
          />
        </span>
      ) : null}
    </div>
  );
}

function PresetChips({
  value,
  frequencies,
  onChange,
  disabled,
  labelledBy,
}: {
  value: CadenceFrequency;
  frequencies: readonly CadenceFrequency[];
  onChange: (frequency: CadenceFrequency) => void;
  disabled?: boolean | undefined;
  labelledBy: string;
}) {
  const t = useOpenGeniText();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + frequencies.length) % frequencies.length;
    onChange(frequencies[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex min-w-0 flex-wrap gap-1.5">
      {frequencies.map((frequency, index) => {
        const checked = frequency === value;
        return (
          <button
            key={frequency}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(frequency)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-8 items-center rounded-full border px-3 text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed pointer-coarse:h-11",
              // Selected matches the outlined segmented control: brand tint, soft brand edge.
              checked
                ? "border-brand/45 bg-brand/10 text-brand disabled:border-border disabled:bg-surface-3 disabled:text-fg-muted"
                : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg disabled:bg-surface-2 disabled:text-fg-subtle disabled:hover:border-border",
            )}
          >
            {frequencyWords(t, frequency).preset}
          </button>
        );
      })}
    </div>
  );
}

function PresetField({
  label,
  htmlFor,
  labelId,
  children,
}: {
  label: string;
  htmlFor?: string | undefined;
  labelId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} id={labelId} className="text-xs leading-4.5 font-medium text-fg">
          {label}
        </label>
      ) : (
        <span id={labelId} className="text-xs leading-4.5 font-medium text-fg">
          {label}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function PresetsVariant(props: PartProps) {
  const { value, update, updateZone, now, disabled, timeZones, frequencies } = props;
  const rule = normalizeCadenceRule(value.rule, value.timeZone);
  const time = ruleTime(rule);
  const repeatsId = useId();
  const timeId = useId();
  const t = useOpenGeniText();
  const detailLabel: Partial<Record<CadenceFrequency, string>> = {
    weekly: t("cadence.picker.days"),
    monthly: t("cadence.picker.dayOfMonth"),
    interval: t("cadence.picker.every"),
    once: t("cadence.picker.date"),
  };
  const detail = detailLabel[rule.frequency];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <span id={repeatsId} className="text-xs leading-4.5 font-medium text-fg">
          {t("cadence.picker.repeats")}
        </span>
        <PresetChips
          value={rule.frequency}
          frequencies={frequencies}
          labelledBy={repeatsId}
          disabled={disabled}
          onChange={(frequency) =>
            update(switchFrequency(rule, frequency, { timeZone: value.timeZone, now }))
          }
        />
      </div>
      {detail ? (
        <PresetField label={detail}>
          <RuleDetails {...props} layout="stacked" />
        </PresetField>
      ) : null}
      {usesTime(rule) && time !== undefined ? (
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-4">
          <PresetField label={t("cadence.picker.time")} htmlFor={timeId}>
            <TimeField
              id={timeId}
              value={time}
              disabled={disabled}
              onChange={(next) => update(withTime(rule, next))}
            />
          </PresetField>
          <PresetField label={t("cadence.picker.timeZone")}>
            <TimeZonePicker
              value={value.timeZone}
              onChange={updateZone}
              timeZones={timeZones}
              now={now}
              disabled={disabled}
              className="w-full max-w-60"
            />
          </PresetField>
        </div>
      ) : null}
    </div>
  );
}

const TEXT_EXAMPLES = [
  "weekdays at 8",
  "mon and thu at 9:30",
  "1st of the month at 9",
  "every 30 min",
];

function TextVariant({
  value,
  update,
  updateZone,
  now,
  disabled,
  timeZones,
  inputIssueId,
  onIssue,
}: PartProps & { inputIssueId: string; onIssue: (message: string | null) => void }) {
  const [text, setText] = useState(() => cadencePhrase(value.rule, value.timeZone, now));
  const inputId = useId();
  const read = (next: string) => {
    setText(next);
    const result = parseCadence(next, { timeZone: value.timeZone, now });
    if (result.ok) {
      onIssue(null);
      update(result.rule);
    } else {
      onIssue(result.message);
    }
  };
  return (
    <div className="@container/cadence-text flex min-w-0 flex-col gap-2.5">
      <div
        className={cn(
          "flex h-9 min-w-0 items-center gap-1 rounded-[10px] border border-border pr-1 pl-3 transition-colors duration-[120ms] pointer-coarse:h-11",
          disabled
            ? "bg-surface-2 text-fg-muted"
            : "bg-surface hover:border-border-strong focus-within:border-brand focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand/55 focus-within:hover:border-brand",
        )}
      >
        <CalendarClockIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label="When it runs, in words"
          aria-describedby={inputIssueId}
          disabled={disabled}
          value={text}
          placeholder='For example "every weekday at 8"'
          onChange={(event) => read(event.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-sm text-fg outline-hidden! placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:text-fg-muted pointer-coarse:text-base"
        />
        <TimeZonePicker
          value={value.timeZone}
          onChange={updateZone}
          timeZones={timeZones}
          now={now}
          disabled={disabled}
          variant="ghost"
          className="max-w-44 shrink-0"
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-xs text-fg-subtle">Try</span>
        {TEXT_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            disabled={disabled}
            onClick={() => read(example)}
            className="inline-flex h-7 items-center rounded-full border border-border bg-surface px-2.5 text-xs text-fg-muted transition-colors duration-[120ms] hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle disabled:hover:border-border pointer-coarse:h-9"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Say when something runs. Emits a `CadenceValue` (rule + time zone); map it
 * to the API with `toScheduleSpec` and describe it with `describeCadence`.
 */
export function CadencePicker({
  value,
  onChange,
  variant = "sentence",
  timeZones = NO_TIME_ZONES,
  frequencies = ALL_FREQUENCIES,
  now: nowProp,
  viewerTimeZone,
  previewCount = 3,
  disabled,
  disabledReason,
  "aria-labelledby": labelledBy,
  className,
}: CadencePickerProps) {
  const [firstRender] = useState(() => new Date());
  const now = nowProp ?? firstRender;
  const issueId = useId();
  const reasonId = useId();
  const t = useOpenGeniText();
  const [parseIssue, setParseIssue] = useState<string | null>(null);
  const issue = validateCadence(value.rule, { timeZone: value.timeZone, now, text: t });
  const hint = monthDayHint(t, value.rule);

  const parts: PartProps = {
    value,
    update: (rule) => onChange({ ...value, rule }),
    updateZone: (timeZone) => onChange({ ...value, timeZone }),
    issue,
    issueId,
    now,
    disabled,
    timeZones,
    frequencies,
  };

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      data-variant={variant}
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {variant === "presets" ? (
        <PresetsVariant {...parts} />
      ) : variant === "text" ? (
        <TextVariant {...parts} inputIssueId={issueId} onIssue={setParseIssue} />
      ) : (
        <SentenceVariant {...parts} />
      )}
      {hint && !issue ? <p className="-mt-1 text-xs leading-4.5 text-fg-muted">{hint}</p> : null}
      <CadencePreview
        id={issueId}
        value={value}
        now={now}
        timeZones={timeZones}
        viewerTimeZone={viewerTimeZone}
        count={previewCount}
        issue={variant === "text" ? parseIssue : null}
        // An error line sits 6px under the controls, like a field error.
        className={(variant === "text" && parseIssue) || issue ? "-mt-1.5" : undefined}
      />
      {disabled && disabledReason ? (
        <InlineDisabledReason id={reasonId}>{disabledReason}</InlineDisabledReason>
      ) : null}
    </div>
  );
}
