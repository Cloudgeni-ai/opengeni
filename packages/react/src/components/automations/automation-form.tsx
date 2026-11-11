/**
 * Create or edit an automation: what the agent does, when it runs, and an
 * optional name. Where its runs go is the host's choice (`destination`), and
 * the runs inherit their access from there; nothing here narrows it.
 * Presentational: the host saves through `onSubmit`.
 */
import { useMemo, useState, type FormEvent } from "react";
import { CircleAlertIcon } from "lucide-react";

import type { EventSource, EventTypeDescriptor } from "@opengeni/sdk";

import { useOpenGeniText } from "../../messages/runtime";
import { apiErrorFacts } from "../../ui/api-error";
import { Button } from "../../ui/button";
import { Field, TextArea, TextInput } from "../../ui/field";
import { cn } from "../../lib/cn";
import {
  deriveAutomationName,
  hasAutomationDraftIssues,
  validateAutomationDraft,
  type AutomationDraft,
  type AutomationDraftIssues,
} from "./automation-model";
import { AutomationWhenField } from "./automation-when-field";
import { withTemplateSources } from "./automation-template-model";
import type { EventSourceChoice } from "./event-source-model";
import type { EventSourceLogoResolver } from "./event-source-tile";

export interface AutomationFormProps {
  /** Where it starts: a saved automation's draft, or `newAutomationDraft()`. */
  initial: AutomationDraft;
  /** It edits a saved automation: the button says Save changes. */
  editing?: boolean | undefined;
  /** Where its runs go: on in one chat, or a new chat each run. */
  destination: "chat" | "new_chat";
  /** Event triggers run here. False offers the schedule only. */
  eventTriggers: boolean;
  /** Sources the person can point triggers at; undefined while loading. */
  sources: EventSource[] | undefined;
  loadEventTypes: (sourceId: string) => Promise<EventTypeDescriptor[]>;
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** Opens the host's "Add a source" page; offered when no source fits. */
  onAddSource?: ((choice?: EventSourceChoice) => void) | undefined;
  /** Arguments a new MCP subscription starts with, such as `{ projectId }`. */
  argumentDefaults?: Readonly<Record<string, unknown>> | undefined;
  /** Saves the draft. Throw to keep the form open; the error's message is shown. */
  onSubmit: (draft: AutomationDraft) => Promise<void>;
  onCancel: () => void;
  /** The clock for schedule previews. */
  now?: Date | undefined;
  className?: string | undefined;
}

export function AutomationForm({
  initial,
  editing = false,
  destination,
  eventTriggers,
  sources,
  loadEventTypes,
  sourceLogo,
  onAddSource,
  argumentDefaults,
  onSubmit,
  onCancel,
  now,
  className,
}: AutomationFormProps) {
  const t = useOpenGeniText();
  const [draft, setDraft] = useState(initial);
  // A template's triggers take the person's own sources once those load.
  const [filledFrom, setFilledFrom] = useState(sources);
  if (sources !== filledFrom) {
    setFilledFrom(sources);
    const events = withTemplateSources(draft.events, sources);
    if (events !== draft.events) setDraft({ ...draft, events });
  }
  const [issues, setIssues] = useState<AutomationDraftIssues>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const derivedName = useMemo(() => deriveAutomationName(draft.instructions), [draft.instructions]);
  const update = (patch: Partial<AutomationDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setIssues((current) => ({
      ...current,
      ...("instructions" in patch ? { instructions: undefined } : {}),
      ...("name" in patch ? { name: undefined } : {}),
      ...("cadence" in patch ? { cadence: undefined, when: undefined } : {}),
      ...("events" in patch ? { events: undefined, when: undefined } : {}),
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const found = validateAutomationDraft(t, draft, sources ?? [], now ?? new Date());
    setIssues(found);
    if (hasAutomationDraftIssues(found)) return;
    setSaving(true);
    setFailure(null);
    try {
      await onSubmit(draft);
    } catch (error) {
      setFailure(errorSentence(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-busy={saving || undefined}
      className={cn("flex min-w-0 flex-col gap-5", className)}
    >
      <Field
        label={t("automations.form.instructions")}
        error={issues.instructions}
        hint={
          destination === "chat"
            ? t("automations.form.instructionsHintChat")
            : t("automations.form.instructionsHintNewChat")
        }
      >
        <TextArea
          rows={4}
          value={draft.instructions}
          onChange={(event) => update({ instructions: event.target.value })}
          placeholder={t("automations.form.instructionsPlaceholder")}
          disabled={saving}
          autoFocus={!editing}
        />
      </Field>
      <AutomationWhenField
        cadence={draft.cadence}
        onCadenceChange={(cadence) => update({ cadence })}
        events={draft.events}
        onEventsChange={(events) => update({ events })}
        eventTriggers={eventTriggers}
        sources={sources}
        loadEventTypes={loadEventTypes}
        eventIssues={issues.events}
        error={issues.when ?? issues.cadence}
        sourceLogo={sourceLogo}
        onAddSource={onAddSource}
        argumentDefaults={argumentDefaults}
        now={now}
        disabled={saving}
      />
      <Field label={t("automations.form.name")} optional error={issues.name}>
        <TextInput
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder={derivedName || t("automations.form.namePlaceholder")}
          disabled={saving}
          suppressAutofill
        />
      </Field>
      {failure ? (
        <p
          role="alert"
          className="m-0 flex min-w-0 items-start gap-1.5 text-sm leading-5 text-danger"
        >
          <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">
            <span className="font-medium">{t("automations.form.saveFailed")}</span> {failure}
          </span>
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
          className="pointer-coarse:h-11"
        >
          {t("automations.form.cancel")}
        </Button>
        <Button type="submit" disabled={saving} className="pointer-coarse:h-11">
          {saving
            ? editing
              ? t("automations.form.saving")
              : t("automations.form.creating")
            : editing
              ? t("automations.form.save")
              : t("automations.form.create")}
        </Button>
      </div>
    </form>
  );
}

/** What went wrong, as the server said it, ending in a full stop. */
export function errorSentence(error: unknown): string {
  const message = apiErrorFacts(error).serverMessage ?? "";
  if (!message) return "";
  const sentence = message.charAt(0).toLocaleUpperCase() + message.slice(1);
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}
