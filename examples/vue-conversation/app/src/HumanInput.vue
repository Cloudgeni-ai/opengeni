<script setup lang="ts">
import { reactive, ref } from "vue";
import type { SessionHumanInputRequest, SubmitHumanInputResponseRequest } from "@opengeni/sdk";
import { validateAnswers } from "./human-input";

const props = defineProps<{ request: SessionHumanInputRequest; busy: boolean }>();
const emit = defineEmits<{ answer: [response: SubmitHumanInputResponseRequest] }>();
const values = reactive<Record<string, string | string[]>>(
  Object.fromEntries(
    props.request.questions.map((q) => [q.id, q.kind === "multi_select" ? [] : ""]),
  ),
);
const other = reactive<Record<string, string>>({});
const error = ref("");
function submit() {
  const answers = props.request.questions.map((q) => ({
    questionId: q.id,
    values: Array.isArray(values[q.id])
      ? (values[q.id] as string[])
      : values[q.id]
        ? [values[q.id] as string]
        : [],
    ...(other[q.id] ? { other: other[q.id] } : {}),
  }));
  error.value = validateAnswers(props.request, answers) ?? "";
  if (!error.value) emit("answer", { outcome: "answered", answers });
}
</script>

<template>
  <form class="decision" @submit.prevent="submit">
    <h3>A detail before we continue</h3>
    <fieldset v-for="q in request.questions" :key="q.id">
      <legend>{{ q.prompt }}{{ q.required ? " (required)" : "" }}</legend>
      <p v-if="q.helpText">{{ q.helpText }}</p>
      <input
        v-if="q.kind === 'text'"
        v-model="values[q.id]"
        :aria-label="q.label || q.prompt"
        :required="q.required && !other[q.id]"
      />
      <select
        v-else
        v-model="values[q.id]"
        :aria-label="q.label || q.prompt"
        :multiple="q.kind === 'multi_select'"
        :required="q.required && !other[q.id]"
      >
        <option v-if="q.kind === 'single_select'" value="">Choose an option</option>
        <option v-for="option in q.options" :key="option.id" :value="option.id">
          {{ option.label }}{{ option.description ? ` — ${option.description}` : "" }}
        </option>
      </select>
      <label v-if="q.allowOther">Other<input v-model="other[q.id]" /></label>
      <p v-if="q.validation?.minSelections || q.validation?.maxSelections">
        Select {{ q.validation.minSelections || 0 }} to
        {{ q.validation.maxSelections || "any number of" }} options.
      </p>
    </fieldset>
    <p v-if="request.expiresAt">Respond by {{ new Date(request.expiresAt).toLocaleString() }}.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="actions">
      <button :disabled="busy" type="submit">Continue</button>
      <button
        v-if="request.allowSkip"
        :disabled="busy"
        class="secondary"
        type="button"
        @click="emit('answer', { outcome: 'skipped' })"
      >
        Skip
      </button>
    </div>
  </form>
</template>
