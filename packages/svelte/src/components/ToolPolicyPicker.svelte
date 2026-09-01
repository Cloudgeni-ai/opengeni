<script lang="ts">
  import type { ToolPolicyOption } from "../picker-types";

  let {
    tools,
    selected = [],
    disabled = false,
    label = "Session tools",
    onChange,
  }: {
    tools: readonly ToolPolicyOption[];
    selected?: readonly string[];
    disabled?: boolean;
    label?: string;
    onChange?: ((ids: string[]) => unknown) | undefined;
  } = $props();

  function toggle(id: string, checked: boolean) {
    const next = checked
      ? selected.includes(id) ? [...selected] : [...selected, id]
      : selected.filter((candidate) => candidate !== id);
    onChange?.(next);
  }
</script>

<fieldset class="og-tool-policy" data-og-component="menu" data-og-part="content" {disabled}>
  <legend>{label}</legend>
  {#each tools as tool (tool.id)}
    {@const unavailable = tool.state === "denied" || tool.state === "unavailable"}
    <label class="og-tool-policy__item" data-og-state={tool.state ?? "available"}>
      <input
        type="checkbox"
        checked={selected.includes(tool.id)}
        disabled={disabled || unavailable}
        onchange={(event) => toggle(tool.id, event.currentTarget.checked)}
      />
      <span><strong>{tool.label}</strong>{#if tool.description}<small>{tool.description}</small>{/if}</span>
      {#if tool.state && tool.state !== "available"}<small>{tool.state.replaceAll("-", " ")}</small>{/if}
    </label>
  {/each}
</fieldset>
