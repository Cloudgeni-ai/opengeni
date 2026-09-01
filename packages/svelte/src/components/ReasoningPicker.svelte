<script lang="ts">
  import type { ReasoningEffort } from "@opengeni/sdk";

  const DEFAULT_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  let {
    value,
    options = DEFAULT_OPTIONS,
    disabled = false,
    label = "Reasoning effort",
    onChange,
  }: {
    value: ReasoningEffort;
    options?: readonly ReasoningEffort[];
    disabled?: boolean;
    label?: string;
    onChange?: (value: ReasoningEffort) => unknown;
  } = $props();
</script>

<label class="og-picker" data-og-component="menu" data-og-part="item">
  <span class="og-visually-hidden">{label}</span>
  <select aria-label={label} {value} {disabled} onchange={(event) => onChange?.(event.currentTarget.value as ReasoningEffort)}>
    {#each options as option}<option value={option}>{option}</option>{/each}
  </select>
</label>