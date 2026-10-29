import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CheckIcon,
  LayoutGridIcon,
  LoaderCircleIcon,
  Table2Icon,
} from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  bestInteractiveItems,
  formatInteractiveValue,
  interactiveActionLabel,
  interactiveAnswerKey,
  interactiveFilterOptions,
  interactiveSelectionMessage,
  interactiveSelectionWasSent,
  nextInteractiveSort,
  parseInteractiveAnswer,
  settleInteractiveAnswer,
  toggleInteractiveSelection,
  useInteractiveAnswerHost,
  useInteractiveAnswerState,
  visibleInteractiveItems,
  type InteractiveAnswerField,
  type InteractiveAnswerItem,
  type InteractiveAnswerSpec,
  type InteractiveAnswerValue,
  type InteractiveAnswerView,
} from "../interactive-answer-model";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { DecisionButton } from "./decision-card";

/*
 * An agent's `opengeni-ui` answer: the options it found as cards or a table,
 * an optional bar chart, filter chips, and a pick that goes back into the
 * conversation as the person's next message. Every view shares one selection
 * and one hover, so an option lights up wherever it appears.
 */

export type InteractiveAnswerProps = {
  source: string;
  /** "streaming" grows the answer in place; "incomplete" shows what arrived. */
  state: "complete" | "streaming" | "incomplete";
  /** The fence as plain code, shown when the body cannot be drawn. */
  renderSource: () => ReactNode;
};

export function InteractiveAnswer({ source, state, renderSource }: InteractiveAnswerProps) {
  const parsed = useMemo(
    () =>
      settleInteractiveAnswer(
        parseInteractiveAnswer(source, { partial: state !== "complete" }),
        state,
      ),
    [source, state],
  );
  if (parsed.status === "invalid") return <InvalidAnswer renderSource={renderSource} />;
  if (!parsed.spec || parsed.spec.items.length === 0) {
    return state === "streaming" ? (
      <AnswerStatus streaming title={parsed.spec?.title} />
    ) : (
      <InvalidAnswer renderSource={renderSource} />
    );
  }
  return (
    <LoadedAnswer
      spec={parsed.spec}
      answerKey={interactiveAnswerKey(source)}
      state={state}
      complete={parsed.status === "ok"}
    />
  );
}

function LoadedAnswer({
  spec,
  answerKey,
  state: streamState,
  complete,
}: {
  spec: InteractiveAnswerSpec;
  answerKey: string;
  state: InteractiveAnswerProps["state"];
  complete: boolean;
}) {
  const t = useOpenGeniText();
  const host = useInteractiveAnswerHost();
  const ids = useMemo(
    () => (complete ? spec.items.map((item) => item.id) : null),
    [complete, spec],
  );
  const [state, update] = useInteractiveAnswerState(answerKey, ids);
  const [hovered, setHovered] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleId = useId();

  const interactive = complete;
  const canPick = interactive && Boolean(spec.select) && Boolean(host.send) && !host.readOnly;
  const max = spec.select?.max ?? 0;
  const view: InteractiveAnswerView = state.view ?? spec.view;
  const showTable = view === "table" && spec.fields.length > 0;
  const filterFields = interactive ? spec.fields.filter((field) => field.filter) : [];
  const visible = interactive ? visibleInteractiveItems(spec, state) : spec.items;
  const best = useMemo(
    () => (complete ? bestInteractiveItems(spec, spec.items) : new Map<string, Set<string>>()),
    [complete, spec],
  );
  const words = { yes: t("interactiveAnswer.yes"), no: t("interactiveAnswer.no"), empty: "—" };
  const fallbackAction =
    max === 1 ? t("interactiveAnswer.continueWithThis") : t("interactiveAnswer.continueWithThese");
  const sent = interactiveSelectionWasSent(state);
  const activeFilters = Object.values(state.filters).some((values) => values.length > 0);

  const toggle = (id: string) => {
    if (!canPick) return;
    setFailed(false);
    update((current) => ({
      ...current,
      selected: toggleInteractiveSelection(current.selected, id, max),
    }));
  };

  const send = async () => {
    if (!host.send || state.selected.length === 0 || sending) return;
    const selection = [...state.selected];
    setSending(true);
    setFailed(false);
    try {
      const result = await host.send(
        interactiveSelectionMessage(spec, selection, fallbackAction, t.locale),
      );
      if (result === false) setFailed(true);
      else update((current) => ({ ...current, sent: selection }));
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const itemProps = {
    spec,
    selected: state.selected,
    hovered,
    onHover: setHovered,
    onToggle: canPick ? toggle : undefined,
    atMax: max > 1 && state.selected.length >= max,
    best,
    words,
    single: max === 1,
  };

  return (
    <section
      aria-labelledby={spec.title ? titleId : undefined}
      aria-label={spec.title ? undefined : t("interactiveAnswer.options")}
      aria-busy={(streamState === "streaming" && !complete) || undefined}
      className="og-interactive-answer @container/answer my-3 flex min-w-0 flex-col gap-3 first:mt-0"
    >
      {spec.title || (interactive && spec.fields.length > 0) ? (
        // Without a title, narrow answers have no header: the switch is hidden there.
        <header
          className={cn("flex min-w-0 items-center gap-3", !spec.title && "hidden @md/answer:flex")}
        >
          {spec.title ? (
            <h3
              id={titleId}
              className="m-0 min-w-0 flex-1 text-og-md leading-6 font-medium text-og-fg"
            >
              {spec.title}
            </h3>
          ) : (
            <span className="flex-1" />
          )}
          {interactive && spec.fields.length > 0 ? (
            <ViewSwitch
              view={showTable ? "table" : "cards"}
              onChange={(next) => update((current) => ({ ...current, view: next }))}
            />
          ) : null}
        </header>
      ) : null}

      {filterFields.length > 0 ? (
        <Filters
          fields={filterFields}
          items={spec.items}
          filters={state.filters}
          words={words}
          onChange={(key, values) =>
            update((current) => ({ ...current, filters: { ...current.filters, [key]: values } }))
          }
        />
      ) : null}

      {spec.chart ? (
        <BarChart
          {...itemProps}
          field={spec.fields.find((field) => field.key === spec.chart)!}
          items={visible}
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-og-sm text-og-fg-muted">
          {t("interactiveAnswer.noMatches")}
          <button
            type="button"
            className="cursor-pointer rounded-og-sm text-og-fg underline decoration-og-border-strong underline-offset-2 hover:decoration-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45"
            onClick={() => update((current) => ({ ...current, filters: {} }))}
          >
            {t("interactiveAnswer.showAll")}
          </button>
        </p>
      ) : (
        <>
          {showTable ? (
            // Narrow answers (a phone, a side panel) read the same options as cards,
            // so no column hides off-screen.
            <div className="hidden min-w-0 @md/answer:block">
              <OptionTable
                {...itemProps}
                items={visible}
                sort={state.sort}
                onSort={(key, field) =>
                  update((current) => ({
                    ...current,
                    sort: nextInteractiveSort(current.sort, key, field),
                  }))
                }
              />
            </div>
          ) : null}
          <div
            className={cn(
              "grid min-w-0 grid-cols-1 gap-2 @lg/answer:grid-cols-2",
              showTable && "@md/answer:hidden",
            )}
          >
            {visible.map((item) => (
              <OptionCard key={item.id} item={item} {...itemProps} />
            ))}
          </div>
        </>
      )}

      {interactive && (activeFilters || spec.omitted > 0) ? (
        <p className="m-0 text-og-xs text-og-fg-subtle">
          {activeFilters
            ? t("interactiveAnswer.showing", { shown: visible.length, total: spec.items.length })
            : t("interactiveAnswer.omitted", { count: spec.omitted })}
        </p>
      ) : null}

      {streamState === "streaming" && !complete ? <AnswerStatus streaming /> : null}
      {streamState === "incomplete" && !complete ? (
        <p className="m-0 text-og-sm text-og-fg-muted">{t("interactiveAnswer.stopped")}</p>
      ) : null}

      {canPick ? (
        <PickBar
          spec={spec}
          max={max}
          selected={state.selected}
          sent={sent}
          sending={sending}
          failed={failed}
          action={interactiveActionLabel(spec, fallbackAction)}
          onClear={() => update((current) => ({ ...current, selected: [] }))}
          onSend={() => void send()}
        />
      ) : null}
    </section>
  );
}

type ItemProps = {
  spec: InteractiveAnswerSpec;
  selected: readonly string[];
  hovered: string | null;
  onHover: (id: string | null) => void;
  onToggle: ((id: string) => void) | undefined;
  atMax: boolean;
  best: Map<string, Set<string>>;
  words: { yes: string; no: string; empty: string };
  single: boolean;
};

function ViewSwitch({
  view,
  onChange,
}: {
  view: InteractiveAnswerView;
  onChange: (view: InteractiveAnswerView) => void;
}) {
  const t = useOpenGeniText();
  const options = [
    { id: "cards" as const, label: t("interactiveAnswer.cards"), icon: LayoutGridIcon },
    { id: "table" as const, label: t("interactiveAnswer.table"), icon: Table2Icon },
  ];
  return (
    <div
      role="group"
      aria-label={t("interactiveAnswer.viewAs")}
      className="hidden shrink-0 items-center rounded-og-md bg-og-fg/[0.05] p-0.5 @md/answer:inline-flex"
    >
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          title={label}
          onClick={() => onChange(id)}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[calc(var(--og-radius-md)-2px)] px-2 text-og-xs font-medium transition-colors duration-150 pointer-coarse:h-9 pointer-coarse:px-3",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45",
            view === id
              ? "bg-og-surface-1 text-og-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
              : "text-og-fg-muted hover:text-og-fg",
          )}
        >
          <Icon aria-hidden="true" className="size-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function Filters({
  fields,
  items,
  filters,
  words,
  onChange,
}: {
  fields: InteractiveAnswerField[];
  items: InteractiveAnswerItem[];
  filters: Record<string, InteractiveAnswerValue[]>;
  words: ItemProps["words"];
  onChange: (key: string, values: InteractiveAnswerValue[]) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {fields.map((field) => {
        const options = interactiveFilterOptions(field, items);
        if (options.length === 0) return null;
        const active = filters[field.key] ?? [];
        return (
          <div
            key={field.key}
            role="group"
            aria-label={field.label}
            className="flex min-w-0 flex-wrap items-center gap-1.5"
          >
            <span className="mr-1 text-og-xs text-og-fg-subtle">{field.label}</span>
            {options.map((option) => {
              const on = active.includes(option);
              return (
                <button
                  key={String(option)}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange(
                      field.key,
                      on ? active.filter((value) => value !== option) : [...active, option],
                    )
                  }
                  className={cn(
                    "inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-og-xs transition-colors duration-150 pointer-coarse:h-9 pointer-coarse:px-3",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45",
                    on
                      ? "border-og-fg bg-og-fg text-og-bg"
                      : "border-og-border text-og-fg-muted hover:border-og-border-strong hover:text-og-fg",
                  )}
                >
                  {on ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
                  {formatInteractiveValue(field, option, words)}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function SelectMark({ on, single }: { on: boolean; single: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center border transition-colors duration-150",
        single ? "rounded-full" : "rounded-[5px]",
        on
          ? "border-og-fg bg-og-fg text-og-bg"
          : "border-og-border-strong bg-og-surface-1 group-hover/option:border-og-fg-muted",
      )}
    >
      {on ? (
        single ? (
          <span className="size-1.5 rounded-full bg-og-bg" />
        ) : (
          <CheckIcon className="size-3" strokeWidth={3} />
        )
      ) : null}
    </span>
  );
}

function BestMark() {
  const t = useOpenGeniText();
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] leading-4 font-medium text-og-status-idle">
      <CheckIcon aria-hidden="true" className="size-3" strokeWidth={2.5} />
      {t("interactiveAnswer.best")}
    </span>
  );
}

function OptionCard({
  item,
  spec,
  selected,
  hovered,
  onHover,
  onToggle,
  atMax,
  best,
  words,
  single,
}: ItemProps & { item: InteractiveAnswerItem }) {
  const t = useOpenGeniText();
  const on = selected.includes(item.id);
  const disabled = Boolean(onToggle) && !on && atMax;
  const facts = spec.fields.filter((field) => {
    const value = item.values[field.key];
    return value !== undefined && value !== null && value !== "";
  });
  const Root = onToggle ? "label" : "div";
  return (
    <Root
      data-option-id={item.id}
      onPointerEnter={() => onHover(item.id)}
      onPointerLeave={() => onHover(null)}
      className={cn(
        "group/option relative flex min-w-0 gap-3 rounded-og-lg border bg-og-surface-1 px-3.5 py-3 transition-[border-color,background-color,box-shadow] duration-150",
        onToggle && !disabled && "cursor-pointer",
        disabled && "opacity-60",
        on
          ? "border-og-fg bg-og-fg/[0.025]"
          : hovered === item.id
            ? "border-og-border-strong bg-og-hover"
            : "border-og-border",
        "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-og-accent/45",
      )}
    >
      {onToggle ? (
        <>
          <input
            type={single ? "radio" : "checkbox"}
            className="sr-only"
            checked={on}
            disabled={disabled}
            aria-label={t("interactiveAnswer.select", { title: item.title })}
            onChange={() => onToggle(item.id)}
          />
          <span className="pt-0.5">
            <SelectMark on={on} single={single} />
          </span>
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-og-sm leading-5 font-medium text-og-fg">{item.title}</div>
            {item.subtitle ? (
              <div className="text-og-xs leading-4 text-og-fg-muted">{item.subtitle}</div>
            ) : null}
          </div>
          {item.badge ? (
            <span className="shrink-0 rounded-full bg-og-fg/[0.07] px-2 py-0.5 text-[11px] leading-4 font-medium text-og-fg">
              {item.badge}
            </span>
          ) : null}
        </div>
        {item.description ? (
          <p className="m-0 line-clamp-2 text-og-sm leading-5 text-og-fg-muted">
            {item.description}
          </p>
        ) : null}
        {facts.length > 0 ? (
          <dl className="m-0 mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
            {facts.map((field) => {
              const isBest = best.get(field.key)?.has(item.id);
              return (
                <div key={field.key} className="flex min-w-0 flex-col">
                  <dt className="flex items-center gap-1.5 text-og-xs leading-4 text-og-fg-subtle">
                    {field.label}
                    {isBest ? <BestMark /> : null}
                  </dt>
                  <dd className="m-0 min-w-0 text-og-sm leading-5 text-og-fg tabular-nums">
                    {formatInteractiveValue(field, item.values[field.key], words, t.locale)}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : null}
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
            className="relative z-10 mt-1 inline-flex w-fit items-center gap-1 rounded-og-sm text-og-xs font-medium text-og-fg-muted underline decoration-og-border-strong underline-offset-2 hover:text-og-fg hover:decoration-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45"
          >
            {hostLabel(item.url)}
            <ArrowUpRightIcon aria-hidden="true" className="size-3" />
          </a>
        ) : null}
      </div>
    </Root>
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Units drawn with every number; others go in the column header once. */
const INLINE_UNITS = new Set(["$", "€", "£", "¥", "US$", "%"]);

function OptionTable({
  items,
  spec,
  selected,
  hovered,
  onHover,
  onToggle,
  atMax,
  best,
  words,
  single,
  sort,
  onSort,
}: ItemProps & {
  items: InteractiveAnswerItem[];
  sort: { key: string; direction: "asc" | "desc" } | null;
  onSort: (key: string, field?: InteractiveAnswerField) => void;
}) {
  const t = useOpenGeniText();
  const header = (
    key: string,
    label: string,
    field?: InteractiveAnswerField,
    numeric?: boolean,
  ) => {
    const active = sort?.key === key;
    const Arrow = active && sort?.direction === "desc" ? ArrowDownIcon : ArrowUpIcon;
    const arrow = (
      <Arrow
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0 transition-opacity",
          active ? "opacity-100" : "opacity-0 group-hover/sort:opacity-60",
        )}
      />
    );
    return (
      <th
        key={key}
        scope="col"
        aria-sort={active ? (sort?.direction === "asc" ? "ascending" : "descending") : undefined}
        className={cn(
          "border-b border-og-border px-2.5 py-2 text-left align-bottom font-normal first:pl-0",
          numeric && "text-right",
          numeric && field?.better && "pr-6",
        )}
      >
        <button
          type="button"
          onClick={() => onSort(key, field)}
          className={cn(
            // align-bottom: an inline-flex box takes its baseline from its first
            // item, and a leading arrow icon would lift numeric headers.
            "group/sort inline-flex cursor-pointer items-center gap-1 rounded-og-sm align-bottom text-og-xs whitespace-nowrap focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45",
            active ? "text-og-fg" : "text-og-fg-subtle hover:text-og-fg",
          )}
        >
          {numeric ? arrow : null}
          <span>
            {label}
            {field?.unit && !INLINE_UNITS.has(field.unit) ? (
              <span className="text-og-fg-subtle"> ({field.unit})</span>
            ) : null}
          </span>
          {numeric ? null : arrow}
        </button>
      </th>
    );
  };
  const numericField = (field: InteractiveAnswerField) =>
    spec.items.some((item) => typeof item.values[field.key] === "number");
  return (
    <div className="min-w-0 overflow-x-auto [scrollbar-gutter:stable]">
      <table className="w-full border-collapse text-og-sm">
        <thead>
          <tr>
            {onToggle ? (
              <th scope="col" className="w-8 border-b border-og-border py-2 pr-1">
                <span className="sr-only">{t("interactiveAnswer.selected")}</span>
              </th>
            ) : null}
            {header("title", t("interactiveAnswer.option"))}
            {spec.fields.map((field) => header(field.key, field.label, field, numericField(field)))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const on = selected.includes(item.id);
            const disabled = Boolean(onToggle) && !on && atMax;
            return (
              <tr
                key={item.id}
                data-option-id={item.id}
                onPointerEnter={() => onHover(item.id)}
                onPointerLeave={() => onHover(null)}
                onClick={(event) => {
                  // The checkbox's own label and input toggle through onChange.
                  if ((event.target as HTMLElement).closest("a,label,input")) return;
                  if (onToggle && !disabled) onToggle(item.id);
                }}
                className={cn(
                  "transition-colors duration-150",
                  onToggle && !disabled && "cursor-pointer",
                  disabled && "opacity-60",
                  on ? "bg-og-fg/[0.06]" : hovered === item.id && "bg-og-hover",
                )}
              >
                {onToggle ? (
                  <td className="border-b border-og-border py-2 pr-1 align-top">
                    <label className="group/option relative inline-flex cursor-pointer pt-0.5 has-[input:focus-visible]:rounded-[5px] has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-og-accent/45">
                      <input
                        type={single ? "radio" : "checkbox"}
                        className="sr-only"
                        checked={on}
                        disabled={disabled}
                        aria-label={t("interactiveAnswer.select", { title: item.title })}
                        onChange={() => onToggle(item.id)}
                      />
                      <SelectMark on={on} single={single} />
                    </label>
                  </td>
                ) : null}
                <th
                  scope="row"
                  className="border-b border-og-border px-2.5 py-2 text-left align-top font-normal first:pl-0"
                >
                  <div className="flex min-w-[9rem] flex-wrap items-center gap-x-1.5">
                    <span className="font-medium text-og-fg">{item.title}</span>
                    {item.badge ? (
                      <span className="rounded-full bg-og-fg/[0.07] px-1.5 text-[10.5px] leading-4 font-medium text-og-fg">
                        {item.badge}
                      </span>
                    ) : null}
                  </div>
                  {item.subtitle ? (
                    <div className="text-og-xs text-og-fg-muted">{item.subtitle}</div>
                  ) : null}
                </th>
                {spec.fields.map((field) => {
                  const value = item.values[field.key];
                  const isBest = best.get(field.key)?.has(item.id);
                  return (
                    <td
                      key={field.key}
                      className={cn(
                        "border-b border-og-border px-2.5 py-2 align-top text-og-fg tabular-nums",
                        typeof value === "number" && "text-right whitespace-nowrap",
                        typeof value === "number" && field.better && "pr-2",
                        isBest && "font-medium",
                        (value === undefined || value === null) && "text-og-fg-subtle",
                      )}
                    >
                      {formatInteractiveValue(
                        field.unit && !INLINE_UNITS.has(field.unit)
                          ? { ...field, unit: undefined }
                          : field,
                        value,
                        words,
                        t.locale,
                      )}
                      {field.better && typeof value === "number" ? (
                        // A fixed slot keeps numbers aligned whether or not they are best.
                        <span className="inline-flex w-3.5 justify-end">
                          {isBest ? (
                            <span
                              role="img"
                              aria-label={t("interactiveAnswer.best")}
                              className="inline-block size-1.5 rounded-full bg-og-status-idle"
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {best.size > 0 ? (
        <p className="m-0 mt-2 inline-flex items-center gap-1.5 text-og-xs text-og-fg-subtle">
          <span
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full bg-og-status-idle"
          />
          {t("interactiveAnswer.bestInColumn")}
        </p>
      ) : null}
    </div>
  );
}

function BarChart({
  field,
  items,
  selected,
  hovered,
  onHover,
  onToggle,
  atMax,
  best,
  words,
}: ItemProps & { field: InteractiveAnswerField; items: InteractiveAnswerItem[] }) {
  const t = useOpenGeniText();
  const values = items
    .map((item) => item.values[field.key])
    .filter((value): value is number => typeof value === "number");
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const rows = items.filter((item) => typeof item.values[field.key] === "number");
  if (rows.length === 0) return null;
  return (
    <figure
      className="m-0 flex min-w-0 flex-col gap-1.5"
      aria-label={t("interactiveAnswer.chartLabel", { label: field.label })}
    >
      <figcaption className="text-og-xs text-og-fg-subtle">
        {field.label}
        {field.unit ? ` (${field.unit})` : ""}
      </figcaption>
      {/* Rows share the list's columns (subgrid), so every bar has the same track. */}
      <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)_auto] gap-y-0.5 p-0 @md/answer:grid-cols-[minmax(5.5rem,34%)_minmax(0,1fr)_auto]">
        {rows.map((item) => {
          const value = item.values[field.key] as number;
          const on = selected.includes(item.id);
          const lit = on || hovered === item.id;
          const width = `${Math.max(1.5, (Math.abs(value) / span) * 100)}%`;
          const disabled = !on && atMax;
          const body = (
            <>
              <span className="col-start-1 row-start-1 min-w-0 truncate text-left text-og-xs leading-5 text-og-fg @md/answer:leading-6">
                {item.title}
              </span>
              <span className="col-span-2 col-start-1 row-start-2 flex h-4 min-w-0 items-center @md/answer:col-span-1 @md/answer:col-start-2 @md/answer:row-start-1 @md/answer:h-6">
                <span
                  className={cn(
                    "h-2.5 rounded-r-[4px] rounded-l-[2px] transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none @md/answer:h-3.5",
                    on ? "bg-og-fg/85" : lit ? "bg-og-fg/40" : "bg-og-fg/[0.16]",
                  )}
                  style={{ width }}
                />
              </span>
              <span className="col-start-2 row-start-1 text-right text-og-xs leading-5 whitespace-nowrap text-og-fg-muted tabular-nums @md/answer:col-start-3 @md/answer:text-left @md/answer:leading-6">
                {formatInteractiveValue(field, value, words, t.locale)}
                {best.get(field.key)?.has(item.id) ? (
                  <span className="ml-1.5 inline-flex align-[-2px]">
                    <BestMark />
                  </span>
                ) : null}
              </span>
            </>
          );
          const rowClass =
            "col-span-full grid min-w-0 grid-cols-subgrid items-center gap-x-3 rounded-og-sm px-1 py-1 -mx-1 @md/answer:py-0";
          return (
            <li
              key={item.id}
              data-option-id={item.id}
              className="col-span-full grid grid-cols-subgrid"
              onPointerEnter={() => onHover(item.id)}
              onPointerLeave={() => onHover(null)}
            >
              {onToggle ? (
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  aria-label={t("interactiveAnswer.select", { title: item.title })}
                  onClick={() => onToggle(item.id)}
                  className={cn(
                    rowClass,
                    "cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45 disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                >
                  {body}
                </button>
              ) : (
                <div className={rowClass}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function PickBar({
  spec,
  max,
  selected,
  sent,
  sending,
  failed,
  action,
  onClear,
  onSend,
}: {
  spec: InteractiveAnswerSpec;
  max: number;
  selected: readonly string[];
  sent: boolean;
  sending: boolean;
  failed: boolean;
  action: string;
  onClear: () => void;
  onSend: () => void;
}) {
  const t = useOpenGeniText();
  const names = spec.items.filter((item) => selected.includes(item.id)).map((item) => item.title);
  const status = failed
    ? t("interactiveAnswer.sendFailed")
    : sent
      ? t("interactiveAnswer.sent")
      : selected.length === 0
        ? max === 1
          ? t("interactiveAnswer.pickOne")
          : max < spec.items.length
            ? t("interactiveAnswer.pickUpTo", { count: max })
            : t("interactiveAnswer.pickAny")
        : max > 1 && selected.length >= max && max < spec.items.length
          ? t("interactiveAnswer.selectedMax", { count: selected.length })
          : t("interactiveAnswer.selectedCount", { count: selected.length });
  return (
    <div className="@container/decision min-w-0 border-t border-og-border pt-3">
      <div className="flex min-w-0 flex-col gap-2.5 @md/decision:flex-row @md/decision:items-center">
        <div className="flex min-w-0 flex-1 flex-col">
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "m-0 flex items-center gap-1.5 text-og-sm",
              failed ? "text-og-status-failed" : "text-og-fg-muted",
            )}
          >
            {sent && !failed ? (
              <CheckIcon aria-hidden="true" className="size-3.5 text-og-status-running" />
            ) : null}
            <span>{status}</span>
            {selected.length > 0 && !sent ? (
              <button
                type="button"
                onClick={onClear}
                className="cursor-pointer rounded-og-sm text-og-fg-subtle underline decoration-transparent underline-offset-2 hover:text-og-fg hover:decoration-current focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45"
              >
                {t("interactiveAnswer.clear")}
              </button>
            ) : null}
          </p>
          {names.length > 0 ? (
            <p className="m-0 truncate text-og-xs text-og-fg-subtle">{names.join(", ")}</p>
          ) : null}
        </div>
        <DecisionButton
          kind={sent ? "secondary" : "primary"}
          busy={sending}
          disabled={selected.length === 0 || sent || sending}
          onClick={onSend}
        >
          {action}
        </DecisionButton>
      </div>
    </div>
  );
}

function AnswerStatus({ streaming, title }: { streaming?: boolean; title?: string | undefined }) {
  const t = useOpenGeniText();
  return (
    <div role="status" aria-live="polite" className="my-3 flex flex-col gap-2 first:mt-0">
      {title ? <h3 className="m-0 text-og-md leading-6 font-medium text-og-fg">{title}</h3> : null}
      <p className="m-0 inline-flex items-center gap-2 text-og-sm text-og-fg-muted">
        {streaming ? (
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : null}
        {t("interactiveAnswer.writing")}
      </p>
    </div>
  );
}

function InvalidAnswer({ renderSource }: { renderSource: () => ReactNode }) {
  const t = useOpenGeniText();
  const [open, setOpen] = useState(false);
  return (
    <div className="my-3 flex flex-col gap-2 first:mt-0">
      <p className="m-0 flex flex-wrap items-center gap-x-2 text-og-sm text-og-fg-muted">
        {t("interactiveAnswer.invalid")}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="cursor-pointer rounded-og-sm text-og-fg underline decoration-og-border-strong underline-offset-2 hover:decoration-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45"
        >
          {open ? t("interactiveAnswer.hideSource") : t("interactiveAnswer.showSource")}
        </button>
      </p>
      {open ? renderSource() : null}
    </div>
  );
}
