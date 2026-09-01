<script lang="ts">
  import type { SessionMcpApprovalPolicy } from "@opengeni/sdk";
  import type { SessionMcpApprovalPolicyStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";
  let { controller }: { controller: SessionMcpApprovalPolicyStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let selectedTools = $state("");
  $effect(() => {
    if (Array.isArray($snapshot.policy)) selectedTools = $snapshot.policy.join(", ");
  });
  function value(policy: SessionMcpApprovalPolicy | null): string {
    return policy === true ? "always" : policy === false ? "never" : "selected";
  }
  function updatePolicy(next: string) {
    if (next === "always") void controller.update(true);
    else if (next === "never") void controller.update(false);
    else if (next === "selected") void controller.update(selectedToolNames());
  }
  function selectedToolNames(): string[] {
    return [...new Set(selectedTools.split(",").map((name) => name.trim()).filter(Boolean))].sort();
  }
  function saveSelectedTools() {
    void controller.update(selectedToolNames());
  }
</script>

<section class="og-mcp-policy" data-og-component="mcp-policy" data-og-state={$snapshot.loading ? "loading" : "ready"}>
  <header class="og-mcp-policy__header"><strong>MCP approval policy</strong><span>{$snapshot.server?.name ?? "Server"}</span></header>
  <label>
    Require approval
    <select value={value($snapshot.policy)} disabled={$snapshot.updating} onchange={(event) => updatePolicy(event.currentTarget.value)}>
      <option value="always">Always</option>
      <option value="never">Never</option>
      <option value="selected">Selected tools</option>
    </select>
  </label>
  {#if Array.isArray($snapshot.policy)}
    <label>
      Tool names
      <input bind:value={selectedTools} disabled={$snapshot.updating} aria-label="Tools requiring approval" placeholder="deploy, delete_resource" />
    </label>
    <button class="og-button" type="button" disabled={$snapshot.updating} onclick={saveSelectedTools}>Save selected tools</button>
    <small>{selectedToolNames().length} selected tool rules</small>
  {/if}
  {#if $snapshot.error}<div class="og-error" role="alert">{$snapshot.error.message}</div>{/if}
</section>
