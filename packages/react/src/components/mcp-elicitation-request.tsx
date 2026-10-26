import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircleIcon, MessageCircleQuestionIcon } from "lucide-react";
import {
  mcpElicitationChoices,
  mcpElicitationDefaults,
  type McpElicitationApprovalRequest,
  type McpElicitationContent,
  type McpElicitationField,
  type McpElicitationValue,
} from "@opengeni/contracts/mcp-elicitation";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { DeclineButton, ToolReviewFrame } from "./tool-action-review";

/** More choices than this become a drop-down instead of a list. */
const LISTED_CHOICES = 6;

type Draft = Record<string, Record<string, McpElicitationValue | undefined>>;

const inputClass =
  "w-full rounded-og-md border border-og-border bg-og-surface-1 px-3 py-2 text-og-sm text-og-fg outline-hidden placeholder:text-og-fg-subtle focus:border-og-accent disabled:opacity-60 aria-[invalid=true]:border-og-status-failed";

/**
 * An MCP server's question in the middle of a tool call, answered in place:
 * its message, its form (prefilled with the server's defaults), and Decline.
 * A question with no fields is a plain confirmation answered with Allow.
 */
export function McpElicitationRequest({
  elicitation,
  title,
  subtitle,
  submitting,
  disabled,
  onAnswer,
  onDecline,
  details,
}: {
  elicitation: McpElicitationApprovalRequest;
  /** What the paused call does, e.g. "Send message". */
  title: ReactNode;
  subtitle?: ReactNode;
  submitting: "approve" | "reject" | null;
  disabled: boolean;
  onAnswer: (content: McpElicitationContent) => void;
  onDecline: () => void;
  /** A link to the paused call's full arguments. */
  details?: ReactNode;
}) {
  const t = useOpenGeniText();
  const formId = useId();
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(
      elicitation.requests.map((request) => [
        request.id,
        mcpElicitationDefaults(request.requestedSchema),
      ]),
    ),
  );
  const hasFields = elicitation.requests.some(
    (request) => Object.keys(request.requestedSchema.properties).length > 0,
  );
  const busy = disabled || submitting !== null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    onAnswer(answerContent(elicitation, draft));
  };
  return (
    <ToolReviewFrame
      tone="waiting"
      icon={
        submitting ? (
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <MessageCircleQuestionIcon className="size-4" aria-hidden="true" />
        )
      }
      eyebrow={
        submitting === "approve"
          ? hasFields
            ? t("approvalSurface.sendingAnswer")
            : t("approvalSurface.approving")
          : submitting === "reject"
            ? t("approvalSurface.declining")
            : t("approvalSurface.serverAsks", { server: elicitation.server })
      }
      title={title}
      titleId={titleId}
      subtitle={subtitle}
      aria-busy={submitting !== null}
      data-og-mcp-elicitation=""
      footer={
        <>
          <div className="flex min-w-0 flex-1 basis-32 items-center">{details}</div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            <DeclineButton
              busy={busy}
              submitting={submitting === "reject"}
              label={t("approvalSurface.decline")}
              onClick={onDecline}
            />
            <button
              type="submit"
              form={formId}
              disabled={busy}
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-og-md border border-og-primary-border bg-og-primary px-3.5 py-1.5 text-og-sm font-medium text-og-primary-fg transition-colors hover:bg-og-primary-hover disabled:opacity-60 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            >
              {submitting === "approve" ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {hasFields ? t("approvalSurface.sendAnswer") : t("approvalSurface.allow")}
            </button>
          </div>
        </>
      }
    >
      <form id={formId} onSubmit={submit} aria-labelledby={titleId} className="space-y-4">
        {elicitation.requests.map((request) => (
          // mx-0 resets the browser's fieldset margin and leaves the vertical rhythm to space-y.
          <fieldset
            key={request.id}
            disabled={busy}
            className="mx-0 min-w-0 space-y-5 border-0 p-0"
          >
            {request.message ? (
              <legend className="mb-4 whitespace-pre-wrap p-0 text-og-sm leading-relaxed text-og-fg [overflow-wrap:anywhere] last:mb-0">
                {request.message}
              </legend>
            ) : null}
            {Object.entries(request.requestedSchema.properties).map(([name, field]) => (
              <ElicitationField
                key={name}
                id={`${formId}-${request.id}-${name}`}
                name={name}
                field={field}
                required={(request.requestedSchema.required ?? []).includes(name)}
                value={draft[request.id]?.[name]}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    [request.id]: { ...current[request.id], [name]: value },
                  }))
                }
              />
            ))}
          </fieldset>
        ))}
      </form>
    </ToolReviewFrame>
  );
}

/** What the person entered, without fields they left empty. */
function answerContent(
  elicitation: McpElicitationApprovalRequest,
  draft: Draft,
): McpElicitationContent {
  const content: McpElicitationContent = {};
  for (const request of elicitation.requests) {
    const values: Record<string, McpElicitationValue> = {};
    for (const [name, value] of Object.entries(draft[request.id] ?? {})) {
      if (value === undefined || value === "") continue;
      const field = request.requestedSchema.properties[name];
      values[name] =
        field?.type === "string" && "format" in field && field.format === "date-time"
          ? new Date(value as string).toISOString()
          : value;
    }
    content[request.id] = values;
  }
  return content;
}

function ElicitationField({
  id,
  name,
  field,
  required,
  value,
  onChange,
}: {
  id: string;
  name: string;
  field: McpElicitationField;
  required: boolean;
  value: McpElicitationValue | undefined;
  onChange: (value: McpElicitationValue | undefined) => void;
}) {
  const t = useOpenGeniText();
  const label = field.title ?? name;
  const helpId = `${id}-help`;
  const describedBy = field.description ? helpId : undefined;
  const choices = useMemo(() => mcpElicitationChoices(field), [field]);
  const heading = (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="min-w-0 text-og-sm font-medium text-og-fg [overflow-wrap:anywhere]">
        {label}
      </span>
      {required ? null : (
        <span className="text-og-xs text-og-fg-subtle">{t("approvalSurface.optional")}</span>
      )}
    </span>
  );
  const help = field.description ? (
    <p id={helpId} className="m-0 text-og-xs text-og-fg-muted [overflow-wrap:anywhere]">
      {field.description}
    </p>
  ) : null;
  if (field.type === "boolean") {
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-0.5 accent-og-accent"
          />
          {heading}
        </label>
        {help}
      </div>
    );
  }
  if (choices && (field.type === "array" || choices.length <= LISTED_CHOICES)) {
    const multiple = field.type === "array";
    const selected = multiple ? ((value as string[] | undefined) ?? []) : [value];
    return (
      <fieldset className="mx-0 min-w-0 space-y-1 border-0 p-0" aria-describedby={describedBy}>
        <legend className="mb-1 p-0">{heading}</legend>
        {help}
        {/* Rows bleed into the gutter so each control lines up with the labels. */}
        <div className="-mx-2.5 flex flex-col">
          {choices.map((choice, index) => {
            const checked = selected.includes(choice.value);
            return (
              <label
                key={choice.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-og-md px-2.5 py-1.5 transition-colors [@media(pointer:coarse)]:py-2.5",
                  checked ? "bg-og-status-waiting/12" : "hover:bg-og-surface-1/80",
                )}
              >
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={id}
                  value={choice.value}
                  checked={checked}
                  required={!multiple && required && index === 0}
                  onChange={(event) => {
                    if (!multiple) return onChange(choice.value);
                    const current = (value as string[] | undefined) ?? [];
                    onChange(
                      event.target.checked
                        ? [...current, choice.value]
                        : current.filter((item) => item !== choice.value),
                    );
                  }}
                  className="mt-0.5 accent-og-accent"
                />
                <span className="min-w-0 text-og-sm text-og-fg [overflow-wrap:anywhere]">
                  {choice.label}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }
  const control = choices ? (
    <select
      id={id}
      value={(value as string | undefined) ?? ""}
      required={required}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value || undefined)}
      className={cn(inputClass, "max-w-sm")}
    >
      <option value="" disabled={required}>
        {t("approvalSurface.choose")}
      </option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  ) : field.type === "number" || field.type === "integer" ? (
    <input
      id={id}
      type="number"
      inputMode={field.type === "integer" ? "numeric" : "decimal"}
      step={field.type === "integer" ? 1 : "any"}
      min={field.minimum}
      max={field.maximum}
      required={required}
      value={typeof value === "number" ? value : ""}
      aria-describedby={describedBy}
      onChange={(event) =>
        // A number input's value is a valid number or empty.
        onChange(event.target.value === "" ? undefined : Number(event.target.value))
      }
      className={cn(inputClass, "max-w-40")}
    />
  ) : (
    <TextControl
      id={id}
      field={field as Extract<McpElicitationField, { minLength?: number }>}
      required={required}
      value={typeof value === "string" ? value : ""}
      describedBy={describedBy}
      onChange={onChange}
    />
  );
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block">
        {heading}
      </label>
      {help}
      {control}
    </div>
  );
}

function TextControl({
  id,
  field,
  required,
  value,
  describedBy,
  onChange,
}: {
  id: string;
  field: { minLength?: number; maxLength?: number; format?: string };
  required: boolean;
  value: string;
  describedBy: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const shared = {
    id,
    required,
    minLength: field.minLength,
    maxLength: field.maxLength,
    "aria-describedby": describedBy,
    className: inputClass,
  };
  if (field.format === "date-time") {
    return (
      <input
        {...shared}
        type="datetime-local"
        value={localDateTime(value)}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={cn(inputClass, "max-w-64")}
      />
    );
  }
  if (field.format) {
    const type = field.format === "uri" ? "url" : field.format;
    return (
      <input
        {...shared}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value || undefined)}
        {...(type === "date" ? { className: cn(inputClass, "max-w-56") } : {})}
      />
    );
  }
  // A short answer is one line; anything that may run long can wrap.
  return field.maxLength !== undefined && field.maxLength <= 200 ? (
    <input
      {...shared}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value || undefined)}
    />
  ) : (
    <textarea
      {...shared}
      rows={2}
      value={value}
      onChange={(event) => onChange(event.target.value || undefined)}
      className={cn(inputClass, "min-h-14 resize-y")}
    />
  );
}

/** An RFC 3339 default shown in the person's own time, as the picker needs. */
function localDateTime(value: string): string {
  if (!value || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
