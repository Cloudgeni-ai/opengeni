<script lang="ts">
  import type { LatencyMode } from "@opengeni/sdk";

  const DEFAULT_OPTIONS = ["standard", "priority", "fast"] as const;
  let {
    value,
    options = DEFAULT_OPTIONS,
    disabled = false,
    label = "Latency",
    onChange,
  }: {
    value: LatencyMode;
    options?: readonly LatencyMode[];
    disabled?: boolean;
    label?: string;
    onChange?: (value: LatencyMode) => unknown;
  } = $props();
</script>

<label class="og-picker" data-og-component="menu" data-og-part="item">
  <span class="og-visually-hidden">{label}</span>
  <select aria-label={label} {value} {disabled} onchange={(event) => onChange?.(event.currentTarget.value as LatencyMode)}>
    {#each options as option}<option value={option}>{option}</option>{/each}
  </select>
</label>