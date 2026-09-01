<script lang="ts">
  import type { ModelPickerOption } from "../picker-types";

  let {
    value,
    options,
    disabled = false,
    label = "Model",
    onChange,
  }: {
    value: string;
    options: readonly ModelPickerOption[];
    disabled?: boolean;
    label?: string;
    onChange?: (value: string) => unknown;
  } = $props();
</script>

<label class="og-picker" data-og-component="menu" data-og-part="item">
  <span class="og-visually-hidden">{label}</span>
  <select class="og-model-picker-native" aria-label={label} {value} {disabled} onchange={(event) => onChange?.(event.currentTarget.value)}>
    {#each options as option (option.id)}
      <option value={option.id} disabled={option.disabled}>{option.label ?? option.id}</option>
    {/each}
  </select>
  <svg class="og-picker__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
</label>
