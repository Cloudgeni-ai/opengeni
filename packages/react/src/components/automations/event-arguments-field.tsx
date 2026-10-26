/**
 * An MCP event's subscription settings: a labelled field per argument when
 * the server's schema is flat, JSON otherwise. The value stays JSON text.
 */
import { useMemo } from "react";

import { useOpenGeniText } from "../../messages/runtime";
import { CheckboxField, Field, TextArea, TextInput } from "../../ui/field";
import { SelectMenu } from "../../ui/select-menu";
import {
  eventArgumentFields,
  eventArgumentsValue,
  withEventArgument,
  type EventArgumentField,
} from "./event-arguments-model";

export interface EventArgumentsFieldProps {
  /** The event's `argumentsSchema`; null or empty when it takes no arguments. */
  schema: Record<string, unknown> | null | undefined;
  /** The arguments as JSON text; empty for none. */
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  disabled?: boolean | undefined;
}

export function EventArgumentsField({
  schema,
  value,
  onChange,
  error,
  disabled = false,
}: EventArgumentsFieldProps) {
  const t = useOpenGeniText();
  const fields = useMemo(() => eventArgumentFields(schema), [schema]);
  const values = eventArgumentsValue(value);
  const title = t("automations.editor.subscriptionSettings");
  if (fields === null || values === null || (fields.length === 0 && value.trim())) {
    return (
      <Field
        label={title}
        optional
        error={error}
        hint={t("automations.editor.subscriptionSettingsHint")}
      >
        <TextArea
          mono
          rows={4}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={jsonExample(schema)}
          disabled={disabled}
          spellCheck={false}
        />
      </Field>
    );
  }
  if (fields.length === 0) return null;
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0" disabled={disabled}>
      <legend className="sr-only">{title}</legend>
      {fields.map((field) => (
        <ArgumentInput
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(next) => onChange(withEventArgument(value, field.name, next))}
          disabled={disabled}
        />
      ))}
      {error ? (
        <p role="alert" className="m-0 text-xs leading-4.5 text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function ArgumentInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: EventArgumentField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const t = useOpenGeniText();
  if (field.kind === "boolean") {
    return (
      <CheckboxField
        label={field.label}
        description={field.description ?? undefined}
        checked={value === true}
        onCheckedChange={(checked) => onChange(checked ? true : field.required ? false : undefined)}
        disabled={disabled}
      />
    );
  }
  const hint = field.description ?? undefined;
  if (field.kind === "choice") {
    const selected = field.options.findIndex((option) => option.value === value);
    return (
      <Field label={field.label} optional={!field.required} hint={hint}>
        <SelectMenu
          options={field.options.map((option, index) => ({
            value: String(index),
            label: option.label,
          }))}
          value={selected >= 0 ? String(selected) : null}
          onValueChange={(index) => onChange(field.options[Number(index)]?.value)}
          placeholder={t("automations.arguments.choose")}
          disabled={disabled}
          className="max-w-full"
        />
      </Field>
    );
  }
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return (
    <Field label={field.label} optional={!field.required} hint={hint}>
      <TextInput
        value={text}
        onChange={(event) => {
          const typed = event.target.value;
          if (!typed.trim()) return onChange(undefined);
          if (field.kind === "number") {
            // Kept as typed until it reads as a number, so "1." can become "1.5".
            const number = Number(typed.trim());
            return onChange(String(number) === typed.trim() ? number : typed);
          }
          onChange(typed);
        }}
        inputMode={field.kind === "number" ? (field.integer ? "numeric" : "decimal") : undefined}
        mono={field.kind === "text" && field.format === "uuid"}
        placeholder={field.placeholder ?? undefined}
        disabled={disabled}
        spellCheck={false}
        suppressAutofill
      />
    </Field>
  );
}

/** A filled-in example from a JSON Schema's properties, for the JSON placeholder. */
function jsonExample(schema: Record<string, unknown> | null | undefined): string {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return "{}";
  const example: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
    const type = (property as { type?: unknown } | null)?.type;
    example[name] = type === "number" || type === "integer" ? 0 : type === "boolean" ? true : "";
  }
  return JSON.stringify(example, null, 2);
}
