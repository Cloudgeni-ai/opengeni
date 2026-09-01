<script lang="ts">
  import type { SessionHumanInputRequest, SubmitHumanInputResponseRequest } from "@opengeni/sdk";
  import { answersFromHumanInputDrafts } from "@opengeni/sdk/session";
  import {
    DEFAULT_HUMAN_INPUT_FORM_MESSAGES,
    initialHumanInputDrafts,
    type HumanInputDraft,
    type HumanInputFormMessages,
  } from "../human-input";

  let {
    request,
    submitting = false,
    error = null,
    messages: messageOverrides = {},
    autoFocus = true,
    onSubmit,
  }: {
    request: SessionHumanInputRequest;
    submitting?: boolean;
    error?: string | null;
    messages?: Partial<HumanInputFormMessages>;
    autoFocus?: boolean;
    onSubmit: (response: SubmitHumanInputResponseRequest) => unknown | Promise<unknown>;
  } = $props();

  let form = $state<HTMLFormElement>();
  let requestIdentity = $state("");
  let drafts = $state<Record<string, HumanInputDraft>>({});
  let validationErrors = $state<Record<string, string>>({});
  let submissionError = $state<string | null>(null);
  let submittingInternally = $state(false);
  let autofocusedRequestId = $state<string | null>(null);
  let submissionInFlight = false;
  let collapsed = $state(false);
  let messages = $derived({ ...DEFAULT_HUMAN_INPUT_FORM_MESSAGES, ...messageOverrides });
  let busy = $derived(submitting || submittingInternally);

  $effect(() => {
    if (request.id === requestIdentity) return;
    requestIdentity = request.id;
    drafts = initialHumanInputDrafts(request.questions);
    validationErrors = {};
    submissionError = null;
    submissionInFlight = false;
  });

  $effect(() => {
    if (!autoFocus || request.id === autofocusedRequestId || request.id !== requestIdentity) return;
    autofocusedRequestId = request.id;
    queueMicrotask(() => {
      form?.querySelector<HTMLElement>("textarea:not([disabled]), input:not([disabled])")?.focus();
    });
  });

  function emptyDraft(): HumanInputDraft {
    return { values: [], other: "", otherSelected: false };
  }

  function update(id: string, apply: (draft: HumanInputDraft) => HumanInputDraft) {
    drafts = { ...drafts, [id]: apply(drafts[id] ?? emptyDraft()) };
    if (validationErrors[id] !== undefined) {
      const next = { ...validationErrors };
      delete next[id];
      validationErrors = next;
    }
  }

  function toggleOption(questionId: string, optionId: string, kind: "single_select" | "multi_select", checked: boolean) {
    update(questionId, (current) => ({
      ...current,
      values:
        kind === "single_select"
          ? checked
            ? [optionId]
            : []
          : checked
            ? current.values.includes(optionId)
              ? current.values
              : [...current.values, optionId]
            : current.values.filter((candidate: string) => candidate !== optionId),
      ...(kind === "single_select" && checked ? { otherSelected: false } : {}),
    }));
  }

  function selectOther(questionId: string, kind: "single_select" | "multi_select") {
    update(questionId, (current) => ({
      ...current,
      otherSelected: true,
      ...(kind === "single_select" ? { values: [] } : {}),
    }));
  }

  function toggleOther(questionId: string, kind: "single_select" | "multi_select", checked: boolean) {
    update(questionId, (current) => ({
      ...current,
      otherSelected: checked,
      ...(kind === "single_select" && checked ? { values: [] } : {}),
    }));
  }

  function focusQuestion(questionId: string) {
    const block = Array.from(form?.querySelectorAll<HTMLElement>("[data-human-input-question]") ?? [])
      .find((node) => node.getAttribute("data-human-input-question") === questionId);
    block?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    block?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])")
      ?.focus({ preventScroll: true });
  }

  async function submitResponse(response: SubmitHumanInputResponseRequest) {
    if (busy || submissionInFlight) return;
    submissionInFlight = true;
    submissionError = null;
    submittingInternally = true;
    try {
      await onSubmit(response);
    } catch (cause) {
      submissionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      submissionInFlight = false;
      submittingInternally = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const result = answersFromHumanInputDrafts(request.questions, drafts, messages);
    validationErrors = { ...result.errors };
    const firstInvalid = request.questions.find((question) => result.errors[question.id] !== undefined);
    if (firstInvalid) {
      const focus = () => focusQuestion(firstInvalid.id);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
      else queueMicrotask(focus);
      return;
    }
    await submitResponse({ outcome: "answered", answers: result.answers });
  }

  function fieldId(questionId: string, suffix: string) {
    return `og-human-${request.id}-${questionId}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, "-");
  }
</script>

{#if collapsed}
<div class="og-human-input og-human-input--collapsed" data-og-component="human-input" data-og-state="collapsed">
  <span class="og-human-input__icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M7.8 7.3a2.5 2.5 0 1 1 3.3 2.4c-.7.3-1.1.8-1.1 1.5M10 14.5h.01" /></svg></span>
  <h2>{request.questions.length === 1 ? (request.questions[0]?.label ?? request.questions[0]?.prompt) : messages.title}</h2>
  <button class="og-button" type="button" onclick={() => (collapsed = false)}>{messages.expand}</button>
</div>
{:else}
<form
  bind:this={form}
  class="og-human-input"
  data-og-component="human-input"
  data-og-state={busy ? "submitting" : "waiting"}
  data-human-input-request={request.id}
  aria-busy={busy}
  aria-labelledby={fieldId(request.id, "title")}
  onsubmit={submit}
>
  <header class="og-human-input__header" data-og-part="header">
    <span class="og-human-input__icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M7.8 7.3a2.5 2.5 0 1 1 3.3 2.4c-.7.3-1.1.8-1.1 1.5M10 14.5h.01" /></svg></span>
    <div>
      <h2 id={fieldId(request.id, "title")}>{request.questions.length === 1 ? (request.questions[0]?.label ?? request.questions[0]?.prompt) : messages.title}{#if request.questions.length === 1 && request.questions[0]?.required && !request.allowSkip}<span aria-hidden="true"> *</span>{/if}</h2>
      {#if request.questions.length === 1 && request.questions[0]?.label}<p>{request.questions[0].prompt}</p>{/if}
    </div>
    {#if request.questions.length > 1}<span>{request.questions.length} questions</span>{/if}
    <button class="og-icon-button" type="button" aria-label={messages.collapse} title={messages.collapse} onclick={() => (collapsed = true)}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 12 4-4 4 4" /></svg></button>
  </header>
  <div class="og-human-input__content" data-og-part="content">
  <fieldset disabled={busy} class="og-human-input__questions">
    {#each request.questions as question, index (question.id)}
      {@const draft = drafts[question.id] ?? emptyDraft()}
      {@const questionError = validationErrors[question.id]}
      {@const labelId = fieldId(question.id, "label")}
      {@const helpId = fieldId(question.id, "help")}
      {@const hintId = fieldId(question.id, "hint")}
      {@const errorId = fieldId(question.id, "error")}
      {@const controlId = fieldId(question.id, "control")}
      {@const otherChoiceId = fieldId(question.id, "other-choice")}
      {@const otherTextId = fieldId(question.id, "other-text")}
      {@const hint = question.kind === "multi_select" ? messages.selectionHint(question.validation?.minSelections, question.validation?.maxSelections) : null}
      {@const describedBy = [question.helpText ? helpId : null, hint ? hintId : null, questionError ? errorId : null].filter(Boolean).join(" ") || undefined}
      <div class="og-human-input__question" data-og-part="item" data-human-input-question={question.id}>
        <label class={request.questions.length === 1 ? "og-visually-hidden" : undefined} id={labelId} for={question.kind === "text" ? controlId : undefined}>
          {request.questions.length > 1 ? `${index + 1}. ` : ""}{question.label ?? question.prompt}
          {#if question.required && !request.allowSkip}<span aria-hidden="true"> *</span>{:else if !question.required}<small> {messages.optional}</small>{/if}
        </label>
        {#if request.questions.length > 1 && question.label && question.prompt !== question.label}<p>{question.prompt}</p>{/if}
        {#if question.helpText}<small id={helpId}>{question.helpText}</small>{/if}
        {#if hint}<small id={hintId}>{hint}</small>{/if}

        {#if question.kind === "text"}
          <textarea
            id={controlId}
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            aria-invalid={Boolean(questionError)}
            value={draft.values[0] ?? ""}
            oninput={(event) => update(question.id, (current) => ({
              ...current,
              values: event.currentTarget.value ? [event.currentTarget.value] : [],
            }))}
          ></textarea>
        {:else}
          <div
            class="og-human-input__choices"
            role={question.kind === "single_select" ? "radiogroup" : "group"}
            aria-labelledby={labelId}
            aria-describedby={describedBy}
          >
            {#each question.options as option, optionIndex (option.id)}
              <label class="og-human-input__choice" data-og-state={draft.values.includes(option.id) ? "ready" : "idle"}>
                <input
                  type={question.kind === "single_select" ? "radio" : "checkbox"}
                  name={question.kind === "single_select" ? controlId : undefined}
                  checked={draft.values.includes(option.id)}
                  onchange={(event) => toggleOption(question.id, option.id, question.kind as "single_select" | "multi_select", event.currentTarget.checked)}
                />
                <span><strong>{option.label}</strong>{#if option.description}<small>{option.description}</small>{/if}</span>
              </label>
            {/each}
            {#if question.allowOther}
              <div class="og-human-input__choice" data-og-state={draft.otherSelected ? "ready" : "idle"}>
                <input
                  id={otherChoiceId}
                  type={question.kind === "single_select" ? "radio" : "checkbox"}
                  name={question.kind === "single_select" ? controlId : undefined}
                  aria-label={messages.other}
                  checked={draft.otherSelected}
                  onchange={(event) => toggleOther(question.id, question.kind as "single_select" | "multi_select", event.currentTarget.checked)}
                />
                <span>
                  <label for={otherChoiceId}><strong>{messages.other}</strong></label>
                  <label class="og-visually-hidden" for={otherTextId}>{messages.other} answer for {question.label ?? question.prompt}</label>
                  <input
                    id={otherTextId}
                    type="text"
                    value={draft.other}
                    placeholder="Type a value…"
                    onfocus={() => selectOther(question.id, question.kind as "single_select" | "multi_select")}
                    onclick={() => selectOther(question.id, question.kind as "single_select" | "multi_select")}
                    oninput={(event) => {
                      const other = event.currentTarget.value;
                      update(question.id, (current) => ({
                        ...current,
                        other,
                        otherSelected: true,
                        ...(question.kind === "single_select" ? { values: [] } : {}),
                      }));
                    }}
                  />
                </span>
              </div>
            {/if}
          </div>
        {/if}
        {#if questionError}<small id={errorId} class="og-error" role="alert">{questionError}</small>{/if}
      </div>
    {/each}
  </fieldset>
  </div>
  {#if error ?? submissionError}<div class="og-error" data-og-part="error" role="alert">{error ?? submissionError}</div>{/if}
  <div class="og-human-input__actions" data-og-part="actions">
    {#if request.allowSkip}<button class="og-button" type="button" disabled={busy} onclick={() => void submitResponse({ outcome: "skipped" })}>{messages.skip}</button>{/if}
    <button class="og-button" data-og-variant="primary" type="submit" disabled={busy}>{busy ? messages.submitting : messages.submit}</button>
  </div>
</form>
{/if}
