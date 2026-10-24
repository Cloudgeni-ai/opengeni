/**
 * The event half of an automation's "When": one block per trigger (where the
 * events come from, which events, and optional conditions), plus "Run once".
 * Controlled and data-agnostic: the host passes the sources it can read and a
 * loader for each source's event types.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";

import type { EventSource, EventTypeDescriptor } from "@opengeni/sdk";

import { useOpenGeniText } from "../../messages/runtime";
import { Button } from "../../ui/button";
import { CheckboxField, Field, TextArea, TextInput } from "../../ui/field";
import { ComboboxSelect, SelectMenu, type SelectOption } from "../../ui/select-menu";
import { cn } from "../../lib/cn";
import { eventSourceKindLabel } from "./event-source-model";
import { EventSourceTile, type EventSourceLogoResolver } from "./event-source-tile";
import {
  EVENT_CONDITION_OPERATORS,
  EVENT_TRIGGER_CONDITIONS_MAX,
  EVENT_TRIGGERS_PER_AUTOMATION_MAX,
  eventConditionFieldSuggestions,
  eventConditionOperator,
  eventConditionOperatorLabel,
  eventTypeIssue,
  eventTypeLabel,
  newEventConditionDraft,
  newEventTriggerDraft,
  type EventConditionDraft,
  type EventTriggerDraft,
  type EventTriggerIssues,
  type EventTriggersDraft,
  type EventTriggersIssues,
} from "./event-trigger-model";

/** A source's event types, or why they couldn't be read. */
export type EventTypesState =
  | { status: "loading" }
  | { status: "ready"; eventTypes: EventTypeDescriptor[] }
  | { status: "error"; message: string };

/**
 * Reads each picked source's event types once and keeps them, so switching a
 * trigger's source back and forth never refetches.
 */
export function useEventTypes(
  sourceIds: readonly string[],
  load: (sourceId: string) => Promise<EventTypeDescriptor[]>,
): Record<string, EventTypesState> {
  const t = useOpenGeniText();
  const [states, setStates] = useState<Record<string, EventTypesState>>({});
  const requested = useRef(new Set<string>());
  const loadRef = useRef(load);
  loadRef.current = load;
  const textRef = useRef(t);
  textRef.current = t;
  const key = [...new Set(sourceIds)].filter(Boolean).sort().join(",");
  useEffect(() => {
    for (const sourceId of key ? key.split(",") : []) {
      if (requested.current.has(sourceId)) continue;
      requested.current.add(sourceId);
      setStates((current) => ({ ...current, [sourceId]: { status: "loading" } }));
      loadRef.current(sourceId).then(
        (eventTypes) =>
          setStates((current) => ({ ...current, [sourceId]: { status: "ready", eventTypes } })),
        (error: unknown) => {
          requested.current.delete(sourceId);
          setStates((current) => ({
            ...current,
            [sourceId]: {
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : textRef.current("automations.editor.loadEventsFailed"),
            },
          }));
        },
      );
    }
  }, [key]);
  return states;
}

/* ----------------------------------------------------------------------------
   The field: every trigger, Add, and Run once.
   -------------------------------------------------------------------------- */

export interface EventTriggersFieldProps {
  value: EventTriggersDraft;
  onChange: (next: EventTriggersDraft) => void;
  /** Sources the person can point triggers at; undefined while loading. */
  sources: EventSource[] | undefined;
  /** Reads one source's event types. */
  loadEventTypes: (sourceId: string) => Promise<EventTypeDescriptor[]>;
  issues?: EventTriggersIssues | undefined;
  /** The source's brand logo, from the host's connector catalog. */
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** Opens the host's "Add a source" page; offered when no source fits. */
  onAddSource?: (() => void) | undefined;
  /** Offer "Run once, then finish" (default true). */
  allowOnce?: boolean | undefined;
  disabled?: boolean | undefined;
}

export function EventTriggersField({
  value,
  onChange,
  sources,
  loadEventTypes,
  issues,
  sourceLogo,
  onAddSource,
  allowOnce = true,
  disabled = false,
}: EventTriggersFieldProps) {
  const t = useOpenGeniText();
  const eventTypes = useEventTypes(
    value.triggers.map((trigger) => trigger.sourceId),
    loadEventTypes,
  );
  const lastAdded = useRef<string | null>(null);
  const update = (key: string, next: EventTriggerDraft) =>
    onChange({
      ...value,
      triggers: value.triggers.map((trigger) => (trigger.key === key ? next : trigger)),
    });
  const remove = (key: string) => {
    const triggers = value.triggers.filter((trigger) => trigger.key !== key);
    onChange({ ...value, triggers, ...(triggers.length === 0 ? { once: false } : {}) });
  };
  const add = () => {
    const only = sources?.length === 1 ? sources[0]!.id : "";
    const trigger = newEventTriggerDraft(only);
    lastAdded.current = trigger.key;
    onChange({ ...value, triggers: [...value.triggers, trigger] });
  };
  const full = value.triggers.length >= EVENT_TRIGGERS_PER_AUTOMATION_MAX;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {value.triggers.map((trigger, index) => (
        <EventTriggerEditor
          key={trigger.key}
          index={index}
          value={trigger}
          onChange={(next) => update(trigger.key, next)}
          onRemove={() => remove(trigger.key)}
          sources={sources}
          eventTypes={trigger.sourceId ? eventTypes[trigger.sourceId] : undefined}
          issues={issues?.triggers[trigger.key]}
          sourceLogo={sourceLogo}
          onAddSource={onAddSource}
          autoFocus={lastAdded.current === trigger.key}
          disabled={disabled}
        />
      ))}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={disabled || full}
          className="pointer-coarse:h-11"
        >
          <PlusIcon aria-hidden="true" />
          {value.triggers.length === 0
            ? t("automations.editor.addEvent")
            : t("automations.editor.addAnotherEvent")}
        </Button>
        {full ? (
          <span className="text-xs text-fg-muted">
            {t("automations.editor.triggersMax", { max: EVENT_TRIGGERS_PER_AUTOMATION_MAX })}
          </span>
        ) : null}
      </div>
      {allowOnce && value.triggers.length > 0 ? (
        <CheckboxField
          label={t("automations.editor.once")}
          description={t("automations.editor.onceDescription")}
          checked={value.once}
          onCheckedChange={(once) => onChange({ ...value, once })}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   One trigger.
   -------------------------------------------------------------------------- */

export interface EventTriggerEditorProps {
  value: EventTriggerDraft;
  onChange: (next: EventTriggerDraft) => void;
  onRemove: () => void;
  /** Position in the list, for accessible names. */
  index: number;
  sources: EventSource[] | undefined;
  /** The chosen source's event types; undefined before a source is chosen. */
  eventTypes: EventTypesState | undefined;
  issues?: EventTriggerIssues | undefined;
  sourceLogo?: EventSourceLogoResolver | undefined;
  onAddSource?: (() => void) | undefined;
  /** Move focus to the source picker when the block appears. */
  autoFocus?: boolean | undefined;
  disabled?: boolean | undefined;
}

export function EventTriggerEditor({
  value,
  onChange,
  onRemove,
  index,
  sources,
  eventTypes,
  issues,
  sourceLogo,
  onAddSource,
  autoFocus = false,
  disabled = false,
}: EventTriggerEditorProps) {
  const t = useOpenGeniText();
  const blockRef = useRef<HTMLDivElement>(null);
  const source = sources?.find((candidate) => candidate.id === value.sourceId);
  const descriptors = eventTypes?.status === "ready" ? eventTypes.eventTypes : [];
  const argumentsSchema = value.eventTypes
    .map((type) => descriptors.find((descriptor) => descriptor.type === type)?.argumentsSchema)
    .find((schema) => schema && Object.keys(schema).length > 0);
  const showArguments = source?.kind === "mcp" && (argumentsSchema || value.argumentsText.trim());
  useEffect(() => {
    if (!autoFocus) return;
    blockRef.current?.querySelector<HTMLElement>("button, input")?.focus();
  }, [autoFocus]);

  const sourceOptions: SelectOption[] = (sources ?? []).map((candidate) => ({
    value: candidate.id,
    label: candidate.name,
    meta: eventSourceKindLabel(t, candidate),
    leading: <EventSourceTile source={candidate} logo={sourceLogo} size="sm" />,
    ...(candidate.status === "active"
      ? {}
      : {
          description: candidate.statusReason ?? t("automations.editor.sourceOff"),
        }),
  }));
  const label = t("automations.editor.eventN", { index: index + 1 });

  return (
    <div
      ref={blockRef}
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Field
          label={t("automations.editor.from")}
          error={issues?.source}
          className="min-w-0 flex-1"
        >
          <SelectMenu
            variant={sourceOptions.length > 8 ? "combobox" : "menu"}
            options={sourceOptions}
            value={value.sourceId || null}
            onValueChange={(sourceId) =>
              onChange({ ...value, sourceId, eventTypes: [], conditions: [], argumentsText: "" })
            }
            placeholder={
              sources === undefined
                ? t("automations.editor.loadingSources")
                : t("automations.editor.chooseSource")
            }
            loading={sources === undefined}
            searchPlaceholder={t("automations.editor.searchSources")}
            emptyMessage={
              onAddSource ? (
                <span>
                  {t("automations.editor.noSources")}{" "}
                  <button type="button" className="og-link" onClick={onAddSource}>
                    {t("automations.editor.addSource")}
                  </button>
                </span>
              ) : (
                t("automations.editor.noSourcesAskAdmin")
              )
            }
            invalid={Boolean(issues?.source)}
            disabled={disabled}
            className="max-w-full"
          />
        </Field>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t("automations.editor.removeEventN", { index: index + 1 })}
          title={t("automations.editor.remove")}
          className="mt-7 shrink-0 text-fg-muted pointer-coarse:size-11"
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
      {value.sourceId ? (
        <>
          <Field
            label={
              source?.kind === "mcp"
                ? t("automations.editor.event")
                : t("automations.editor.events")
            }
            error={issues?.eventTypes}
            hint={
              source?.kind === "mcp"
                ? t("automations.editor.mcpOneEventHint")
                : t("automations.editor.anyStartsRun")
            }
          >
            <EventTypePicker
              value={value.eventTypes}
              onChange={(picked) => onChange({ ...value, eventTypes: picked })}
              state={eventTypes}
              single={source?.kind === "mcp"}
              invalid={Boolean(issues?.eventTypes)}
              disabled={disabled}
            />
          </Field>
          <EventConditionsEditor
            value={value.conditions}
            onChange={(conditions) => onChange({ ...value, conditions })}
            suggestions={eventConditionFieldSuggestions(t, value.eventTypes, descriptors)}
            issues={issues?.conditions}
            disabled={disabled}
          />
          {showArguments ? (
            <Field
              label={t("automations.editor.subscriptionSettings")}
              optional
              error={issues?.arguments}
              hint={t("automations.editor.subscriptionSettingsHint")}
            >
              <TextArea
                mono
                rows={4}
                value={value.argumentsText}
                onChange={(event) => onChange({ ...value, argumentsText: event.target.value })}
                placeholder={argumentsSchema ? argumentsExample(argumentsSchema) : "{}"}
                disabled={disabled}
                spellCheck={false}
              />
            </Field>
          ) : null}
          {source?.kind === "github" || source?.kind === "slack" ? (
            <CheckboxField
              label={t("automations.editor.includeOwn")}
              description={t("automations.editor.includeOwnDescription")}
              checked={value.includeOwnEvents}
              onCheckedChange={(includeOwnEvents) => onChange({ ...value, includeOwnEvents })}
              disabled={disabled}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A filled-in example from a JSON Schema's properties, for the placeholder. */
function argumentsExample(schema: Record<string, unknown>): string {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return "{}";
  const example: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
    const type = (property as { type?: unknown } | null)?.type;
    example[name] = type === "number" || type === "integer" ? 0 : type === "boolean" ? true : "";
  }
  return JSON.stringify(example, null, 2);
}

/* ----------------------------------------------------------------------------
   Event types.
   -------------------------------------------------------------------------- */

const CUSTOM_PREFIX = "custom:";
/** One empty list while types load, so the picker's options keep their identity. */
const NO_EVENT_TYPES: EventTypeDescriptor[] = [];

export function EventTypePicker({
  value,
  onChange,
  state,
  single = false,
  invalid = false,
  disabled = false,
}: {
  value: string[];
  onChange: (eventTypes: string[]) => void;
  state: EventTypesState | undefined;
  /** Only one type (MCP triggers); picking replaces it. */
  single?: boolean | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const [query, setQuery] = useState("");
  const descriptors = state?.status === "ready" ? state.eventTypes : NO_EVENT_TYPES;
  const options = useMemo(() => {
    const picked = new Set(value);
    const known: SelectOption[] = descriptors
      .filter((descriptor) => !picked.has(descriptor.type))
      .map((descriptor) => ({
        value: descriptor.type,
        label: descriptor.type,
        description: descriptor.available
          ? descriptor.description
          : (descriptor.unavailableReason ?? descriptor.description),
        disabled: !descriptor.available,
        ...(descriptor.available
          ? {}
          : {
              disabledReason: descriptor.unavailableReason ?? t("automations.picker.cantReceive"),
            }),
        keywords: [descriptor.description],
      }));
    const all: SelectOption[] =
      single || picked.has("*")
        ? []
        : [
            {
              value: "*",
              label: eventTypeLabel(t, "*"),
              description: t("automations.picker.everyEventDescription"),
            },
          ];
    const needle = query.trim().toLowerCase();
    const matches = [...all, ...known].filter(
      (option) =>
        !needle ||
        option.value.toLowerCase().includes(needle) ||
        String(option.description ?? "")
          .toLowerCase()
          .includes(needle),
    );
    const typed = query.trim();
    const custom =
      typed &&
      !single &&
      !picked.has(typed) &&
      !descriptors.some((descriptor) => descriptor.type === typed) &&
      eventTypeIssue(t, typed) === null
        ? [
            {
              value: `${CUSTOM_PREFIX}${typed}`,
              label: t("automations.picker.use", { type: typed }),
              description: typed.endsWith(".*")
                ? t("automations.picker.prefixDescription", { prefix: typed.slice(0, -1) })
                : t("automations.picker.unlisted"),
            },
          ]
        : [];
    return [...matches, ...custom];
  }, [descriptors, query, single, t, value]);

  const add = (picked: string) => {
    const type = picked.startsWith(CUSTOM_PREFIX) ? picked.slice(CUSTOM_PREFIX.length) : picked;
    setQuery("");
    onChange(single ? [type] : [...value, type]);
  };
  const loading = state === undefined || state.status === "loading";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {value.length > 0 ? (
        <ul
          aria-label={t("automations.picker.picked")}
          className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0"
        >
          {value.map((type) => {
            const description = descriptors.find((entry) => entry.type === type)?.description;
            return (
              <li
                key={type}
                title={description}
                className="inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-surface-2 pr-0.5 pl-2.5 text-xs font-medium text-fg"
              >
                <span className={cn("min-w-0 truncate", type !== "*" && "font-mono")}>
                  {eventTypeLabel(t, type)}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((entry) => entry !== type))}
                  disabled={disabled}
                  aria-label={t("automations.picker.removeType", { type: eventTypeLabel(t, type) })}
                  className="grid size-6 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hover hover:text-fg pointer-coarse:size-8"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state?.status === "error" ? (
        <p className="m-0 text-xs leading-4.5 text-fg-muted">
          {t("automations.picker.loadFailed", { reason: state.message.replace(/\.$/, "") })}
        </p>
      ) : null}
      {single && value.length > 0 ? null : (
        <ComboboxSelect
          options={options}
          value={null}
          onValueChange={add}
          onSearchChange={setQuery}
          filterLocally={false}
          placeholder={
            value.length === 0 ? t("automations.picker.choose") : t("automations.picker.addEvent")
          }
          searchPlaceholder={t("automations.picker.search")}
          loading={loading && state?.status !== "error"}
          loadingLabel={t("automations.picker.loading")}
          emptyMessage={t("automations.picker.empty")}
          invalid={invalid}
          disabled={disabled}
          showMetaInTrigger={false}
          className="max-w-full sm:max-w-80"
          aria-label={
            value.length === 0 ? t("automations.picker.choose") : t("automations.picker.addEvent")
          }
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Conditions.
   -------------------------------------------------------------------------- */

export function EventConditionsEditor({
  value,
  onChange,
  suggestions,
  issues,
  disabled = false,
}: {
  value: EventConditionDraft[];
  onChange: (conditions: EventConditionDraft[]) => void;
  /** Fields worth matching, for autocomplete. */
  suggestions: ReadonlyArray<{ field: string; description: string }>;
  /** By condition key. */
  issues?: Record<string, string> | undefined;
  disabled?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const listId = useId();
  const headingId = useId();
  const update = (key: string, next: Partial<EventConditionDraft>) =>
    onChange(
      value.map((condition) => (condition.key === key ? { ...condition, ...next } : condition)),
    );
  const full = value.length >= EVENT_TRIGGER_CONDITIONS_MAX;
  return (
    <div role="group" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <p id={headingId} className="m-0 text-sm leading-5 font-medium text-fg">
        {t("automations.conditions.heading")}
        <span className="ml-1.5 text-xs font-normal text-fg-subtle">
          {t("automations.conditions.optional")}
        </span>
      </p>
      <datalist id={listId}>
        {suggestions.map((entry) => (
          <option key={entry.field} value={entry.field}>
            {entry.description}
          </option>
        ))}
      </datalist>
      {value.map((condition, index) => {
        const operator = eventConditionOperator(condition.op);
        const issue = issues?.[condition.key];
        const position = { index: index + 1 };
        return (
          <div key={condition.key} className="flex min-w-0 flex-col gap-1.5">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1.2fr)_9.5rem_minmax(0,1fr)_auto]">
              <TextInput
                value={condition.field}
                onChange={(event) => update(condition.key, { field: event.target.value })}
                list={listId}
                placeholder="data.action"
                aria-label={t("automations.conditions.fieldFor", position)}
                aria-invalid={issue ? true : undefined}
                mono
                suppressAutofill
                disabled={disabled}
                className="col-span-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange(value.filter((entry) => entry.key !== condition.key))}
                disabled={disabled}
                aria-label={t("automations.conditions.remove", position)}
                title={t("automations.editor.remove")}
                className="text-fg-muted sm:order-last pointer-coarse:size-11"
              >
                <XIcon aria-hidden="true" />
              </Button>
              <SelectMenu
                variant="native"
                options={EVENT_CONDITION_OPERATORS.map((option) => ({
                  value: option.value,
                  label: eventConditionOperatorLabel(t, option.value),
                }))}
                value={condition.op}
                onValueChange={(op) =>
                  update(condition.key, {
                    op,
                    ...(eventConditionOperator(op).takes === null ? { value: "" } : {}),
                  })
                }
                aria-label={t("automations.conditions.comparisonFor", position)}
                showSelectedDescription={false}
                disabled={disabled}
                className="col-span-2 sm:col-span-1"
              />
              {operator.takes === null ? (
                <span className="hidden sm:block" />
              ) : (
                <TextInput
                  value={condition.value}
                  onChange={(event) => update(condition.key, { value: event.target.value })}
                  placeholder={operator.takes === "list" ? "opened, reopened" : "opened"}
                  aria-label={t("automations.conditions.valueFor", position)}
                  aria-invalid={issue ? true : undefined}
                  suppressAutofill
                  disabled={disabled}
                  className="col-span-2 sm:col-span-1"
                />
              )}
            </div>
            {issue ? <p className="m-0 text-xs leading-4.5 text-danger">{issue}</p> : null}
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...value, newEventConditionDraft()])}
          disabled={disabled || full}
          className="-ml-2 text-fg-muted pointer-coarse:h-11"
        >
          <PlusIcon aria-hidden="true" />
          {t("automations.conditions.add")}
        </Button>
      </div>
    </div>
  );
}
