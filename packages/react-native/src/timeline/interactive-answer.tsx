import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import {
  bestInteractiveItems,
  formatInteractiveValue,
  interactiveActionLabel,
  interactiveAnswerKey,
  interactiveFilterOptions,
  interactiveSelectionMessage,
  interactiveSelectionWasSent,
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
} from "@opengeni/react/interactive-answer-model";
import { useOpenGeniText } from "@opengeni/react/messages";
import { DecisionActions, DecisionButton } from "./decision-card";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme, type NativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   An agent's `opengeni-ui` answer on the phone, from the same model as the
   web (`@opengeni/react/interactive-answer-model`): filter chips, an optional
   bar chart and the options as cards that share one selection, then the pick
   sent back as the person's next message. A phone column is narrow, so a
   table answer reads as cards here, as it does on a narrow web column.
   -------------------------------------------------------------------------- */

export function NativeInteractiveAnswer({
  source,
  state,
  renderSource,
}: {
  source: string;
  state: "complete" | "streaming" | "incomplete";
  renderSource: () => ReactNode;
}) {
  const parsed = useMemo(
    () =>
      settleInteractiveAnswer(
        parseInteractiveAnswer(source, { partial: state !== "complete" }),
        state,
      ),
    [source, state],
  );
  if (parsed.status === "invalid") return <Invalid renderSource={renderSource} />;
  if (!parsed.spec || parsed.spec.items.length === 0) {
    return state === "streaming" ? (
      <Writing title={parsed.spec?.title} />
    ) : (
      <Invalid renderSource={renderSource} />
    );
  }
  return (
    <Loaded
      spec={parsed.spec}
      answerKey={interactiveAnswerKey(source)}
      state={state}
      complete={parsed.status === "ok"}
    />
  );
}

type Words = { yes: string; no: string; empty: string };

function Loaded({
  spec,
  answerKey,
  state: streamState,
  complete,
}: {
  spec: InteractiveAnswerSpec;
  answerKey: string;
  state: "complete" | "streaming" | "incomplete";
  complete: boolean;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const host = useInteractiveAnswerHost();
  const ids = useMemo(
    () => (complete ? spec.items.map((item) => item.id) : null),
    [complete, spec],
  );
  const [state, update] = useInteractiveAnswerState(answerKey, ids);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const canPick = complete && Boolean(spec.select) && Boolean(host.send) && !host.readOnly;
  const max = spec.select?.max ?? 0;
  const visible = complete ? visibleInteractiveItems(spec, state) : spec.items;
  const best = useMemo(
    () => (complete ? bestInteractiveItems(spec, spec.items) : new Map<string, Set<string>>()),
    [complete, spec],
  );
  const words: Words = {
    yes: t("interactiveAnswer.yes"),
    no: t("interactiveAnswer.no"),
    empty: "—",
  };
  const fallbackAction =
    max === 1 ? t("interactiveAnswer.continueWithThis") : t("interactiveAnswer.continueWithThese");
  const sent = interactiveSelectionWasSent(state);
  const filterFields = complete ? spec.fields.filter((field) => field.filter) : [];
  const activeFilters = Object.values(state.filters).some((values) => values.length > 0);
  const atMax = max > 1 && state.selected.length >= max;

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
  const chartField = spec.chart ? spec.fields.find((field) => field.key === spec.chart) : undefined;
  const small = { ...fontStyle(theme), fontSize: theme.size.xs, lineHeight: 16 };

  return (
    <View
      accessibilityLabel={spec.title ?? t("interactiveAnswer.options")}
      style={{ gap: 12, marginVertical: 6 }}
    >
      {spec.title ? (
        <Text
          accessibilityRole="header"
          style={{ ...fontStyle(theme, 500), fontSize: theme.size.md, lineHeight: 22, color: c.fg }}
        >
          {spec.title}
        </Text>
      ) : null}

      {filterFields.map((field) => {
        const options = interactiveFilterOptions(field, spec.items);
        if (options.length === 0) return null;
        const active = state.filters[field.key] ?? [];
        return (
          <View
            key={field.key}
            accessibilityLabel={field.label}
            style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}
          >
            <Text style={{ ...small, color: c["fg-subtle"], marginRight: 2 }}>{field.label}</Text>
            {options.map((option) => (
              <FilterChip
                key={String(option)}
                label={formatInteractiveValue(field, option, words, t.locale)}
                on={active.includes(option)}
                onPress={() =>
                  update((current) => {
                    const values = current.filters[field.key] ?? [];
                    const next: InteractiveAnswerValue[] = values.includes(option)
                      ? values.filter((value) => value !== option)
                      : [...values, option];
                    return { ...current, filters: { ...current.filters, [field.key]: next } };
                  })
                }
              />
            ))}
          </View>
        );
      })}

      {chartField ? (
        <Chart
          field={chartField}
          items={visible}
          selected={state.selected}
          best={best}
          words={words}
          onToggle={canPick ? toggle : undefined}
          atMax={atMax}
        />
      ) : null}

      {visible.length === 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}>
            {t("interactiveAnswer.noMatches")}
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => update((current) => ({ ...current, filters: {} }))}
          >
            <Text
              style={{
                ...fontStyle(theme, 500),
                fontSize: theme.size.sm,
                color: c.fg,
                textDecorationLine: "underline",
              }}
            >
              {t("interactiveAnswer.showAll")}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {visible.map((item) => (
            <OptionCard
              key={item.id}
              item={item}
              fields={spec.fields}
              on={state.selected.includes(item.id)}
              disabled={canPick && atMax && !state.selected.includes(item.id)}
              single={max === 1}
              best={best}
              words={words}
              onToggle={canPick ? toggle : undefined}
            />
          ))}
        </View>
      )}

      {complete && (activeFilters || spec.omitted > 0) ? (
        <Text style={{ ...small, color: c["fg-subtle"] }}>
          {activeFilters
            ? t("interactiveAnswer.showing", { shown: visible.length, total: spec.items.length })
            : t("interactiveAnswer.omitted", { count: spec.omitted })}
        </Text>
      ) : null}
      {streamState === "streaming" ? <Writing /> : null}
      {streamState === "incomplete" ? (
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}>
          {t("interactiveAnswer.stopped")}
        </Text>
      ) : null}

      {canPick ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12, gap: 10 }}>
          <PickStatus
            spec={spec}
            max={max}
            selected={state.selected}
            sent={sent}
            failed={failed}
            onClear={() => update((current) => ({ ...current, selected: [] }))}
          />
          <DecisionActions
            primary={
              <DecisionButton
                kind={sent ? "secondary" : "primary"}
                label={interactiveActionLabel(spec, fallbackAction)}
                busy={sending}
                disabled={state.selected.length === 0 || sent}
                onPress={() => void send()}
              />
            }
          />
        </View>
      ) : null}
    </View>
  );
}

function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => ({
        minHeight: 34,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: on ? c.fg : c.border,
        backgroundColor: on ? c.fg : "transparent",
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {on ? <Icon name="check" size={12} color={c.bg} strokeWidth={2.5} /> : null}
      <Text
        style={{
          ...fontStyle(theme),
          fontSize: theme.size.xs,
          color: on ? c.bg : c["fg-muted"],
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SelectMark({
  on,
  single,
  theme,
}: {
  on: boolean;
  single: boolean;
  theme: NativeTimelineTheme;
}) {
  const c = theme.colors;
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: single ? 10 : 5,
        borderWidth: 1,
        borderColor: on ? c.fg : c["border-strong"],
        backgroundColor: on ? c.fg : c["surface-1"],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on ? (
        single ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.bg }} />
        ) : (
          <Icon name="check" size={13} color={c.bg} strokeWidth={3} />
        )
      ) : null}
    </View>
  );
}

function BestMark() {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const color = theme.colors["status-idle"];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <Icon name="check" size={11} color={color} strokeWidth={2.5} />
      <Text style={{ ...fontStyle(theme, 500), fontSize: 11, lineHeight: 14, color }}>
        {t("interactiveAnswer.best")}
      </Text>
    </View>
  );
}

function OptionCard({
  item,
  fields,
  on,
  disabled,
  single,
  best,
  words,
  onToggle,
}: {
  item: InteractiveAnswerItem;
  fields: InteractiveAnswerField[];
  on: boolean;
  disabled: boolean;
  single: boolean;
  best: Map<string, Set<string>>;
  words: Words;
  onToggle: ((id: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const facts = fields.filter((field) => {
    const value = item.values[field.key];
    return value !== undefined && value !== null && value !== "";
  });
  const body = (
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.base,
              lineHeight: 20,
              color: c.fg,
            }}
          >
            {item.title}
          </Text>
          {item.subtitle ? (
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.xs,
                lineHeight: 16,
                color: c["fg-muted"],
              }}
            >
              {item.subtitle}
            </Text>
          ) : null}
        </View>
        {item.badge ? (
          <View
            style={{
              borderRadius: 999,
              paddingHorizontal: 8,
              paddingVertical: 2,
              backgroundColor: withAlpha(c.fg, 0.07),
            }}
          >
            <Text style={{ ...fontStyle(theme, 500), fontSize: 11, lineHeight: 15, color: c.fg }}>
              {item.badge}
            </Text>
          </View>
        ) : null}
      </View>
      {item.description ? (
        <Text
          numberOfLines={3}
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.sm,
            lineHeight: 19,
            color: c["fg-muted"],
          }}
        >
          {item.description}
        </Text>
      ) : null}
      {facts.length > 0 ? (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 18, rowGap: 8, marginTop: 4 }}
        >
          {facts.map((field) => (
            <View key={field.key} style={{ minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: theme.size.xs,
                    lineHeight: 16,
                    color: c["fg-subtle"],
                  }}
                >
                  {field.label}
                </Text>
                {best.get(field.key)?.has(item.id) ? <BestMark /> : null}
              </View>
              <Text
                style={{
                  ...fontStyle(theme),
                  fontSize: theme.size.sm,
                  lineHeight: 19,
                  color: c.fg,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatInteractiveValue(field, item.values[field.key], words, t.locale)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {item.url ? (
        <Pressable
          accessibilityRole="link"
          hitSlop={10}
          onPress={() => void Linking.openURL(item.url!)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            marginTop: 4,
            alignSelf: "flex-start",
          }}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.xs,
              color: c["fg-muted"],
              textDecorationLine: "underline",
            }}
          >
            {hostLabel(item.url)}
          </Text>
          <Icon name="arrow-up-right" size={12} color={c["fg-muted"]} />
        </Pressable>
      ) : null}
    </View>
  );
  const frame = {
    flexDirection: "row" as const,
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: on ? c.fg : c.border,
    backgroundColor: on ? withAlpha(c.fg, 0.025) : c["surface-1"],
    opacity: disabled ? 0.55 : 1,
  };
  if (!onToggle) return <View style={frame}>{body}</View>;
  return (
    <Pressable
      accessibilityRole={single ? "radio" : "checkbox"}
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={t("interactiveAnswer.select", { title: item.title })}
      disabled={disabled}
      onPress={() => onToggle(item.id)}
      style={({ pressed }) => [frame, pressed && !disabled ? { backgroundColor: c.hover } : null]}
    >
      <View style={{ paddingTop: 1 }}>
        <SelectMark on={on} single={single} theme={theme} />
      </View>
      {body}
    </Pressable>
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Chart({
  field,
  items,
  selected,
  best,
  words,
  onToggle,
  atMax,
}: {
  field: InteractiveAnswerField;
  items: InteractiveAnswerItem[];
  selected: readonly string[];
  best: Map<string, Set<string>>;
  words: Words;
  onToggle: ((id: string) => void) | undefined;
  atMax: boolean;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const rows = items.filter((item) => typeof item.values[field.key] === "number");
  if (rows.length === 0) return null;
  const values = rows.map((item) => item.values[field.key] as number);
  const span = Math.max(0, ...values) - Math.min(0, ...values) || 1;
  return (
    <View
      accessibilityLabel={t("interactiveAnswer.chartLabel", { label: field.label })}
      style={{ gap: 4 }}
    >
      <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["fg-subtle"] }}>
        {field.label}
        {field.unit ? ` (${field.unit})` : ""}
      </Text>
      {rows.map((item) => {
        const value = item.values[field.key] as number;
        const on = selected.includes(item.id);
        const disabled = !on && atMax;
        const row = (
          <View style={{ gap: 3, paddingVertical: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text
                numberOfLines={1}
                style={{ ...fontStyle(theme), flex: 1, fontSize: theme.size.xs, color: c.fg }}
              >
                {item.title}
              </Text>
              <Text
                style={{
                  ...fontStyle(theme),
                  fontSize: theme.size.xs,
                  color: c["fg-muted"],
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatInteractiveValue(field, value, words, t.locale)}
              </Text>
              {best.get(field.key)?.has(item.id) ? <BestMark /> : null}
            </View>
            <View
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: withAlpha(c.fg, 0.06),
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: 8,
                  borderRadius: 4,
                  width: `${Math.max(2, (Math.abs(value) / span) * 100)}%`,
                  backgroundColor: on ? withAlpha(c.fg, 0.85) : withAlpha(c.fg, 0.22),
                }}
              />
            </View>
          </View>
        );
        return onToggle ? (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled }}
            accessibilityLabel={t("interactiveAnswer.select", { title: item.title })}
            disabled={disabled}
            onPress={() => onToggle(item.id)}
            style={({ pressed }) => ({ opacity: disabled ? 0.55 : pressed ? 0.7 : 1 })}
          >
            {row}
          </Pressable>
        ) : (
          <View key={item.id}>{row}</View>
        );
      })}
    </View>
  );
}

function PickStatus({
  spec,
  max,
  selected,
  sent,
  failed,
  onClear,
}: {
  spec: InteractiveAnswerSpec;
  max: number;
  selected: readonly string[];
  sent: boolean;
  failed: boolean;
  onClear: () => void;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
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
    <View accessibilityLiveRegion="polite" style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {sent && !failed ? <Icon name="check" size={14} color={c["status-idle"]} /> : null}
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.sm,
            color: failed ? c["status-failed"] : c["fg-muted"],
          }}
        >
          {status}
        </Text>
        {selected.length > 0 && !sent ? (
          <Pressable accessibilityRole="button" hitSlop={12} onPress={onClear}>
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.sm,
                color: c["fg-subtle"],
                textDecorationLine: "underline",
              }}
            >
              {t("interactiveAnswer.clear")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {names.length > 0 ? (
        <Text
          numberOfLines={2}
          style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["fg-subtle"] }}
        >
          {names.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

function Writing({ title }: { title?: string | undefined }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 8, marginVertical: 6 }}>
      {title ? (
        <Text
          style={{ ...fontStyle(theme, 500), fontSize: theme.size.md, lineHeight: 22, color: c.fg }}
        >
          {title}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ActivityIndicator size="small" color={c["fg-muted"]} />
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}>
          {t("interactiveAnswer.writing")}
        </Text>
      </View>
    </View>
  );
}

function Invalid({ renderSource }: { renderSource: () => ReactNode }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8, marginVertical: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}>
          {t("interactiveAnswer.invalid")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={10}
          onPress={() => setOpen((value) => !value)}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.sm,
              color: c.fg,
              textDecorationLine: "underline",
            }}
          >
            {open ? t("interactiveAnswer.hideSource") : t("interactiveAnswer.showSource")}
          </Text>
        </Pressable>
      </View>
      {open ? renderSource() : null}
    </View>
  );
}
