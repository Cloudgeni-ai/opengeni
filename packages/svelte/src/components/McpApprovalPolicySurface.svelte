<script lang="ts">
  import type { SessionMcpApprovalPolicy } from "@opengeni/sdk";
  import type { SessionMcpApprovalPolicyStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";
  let { controller }: { controller: SessionMcpApprovalPolicyStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  function value(policy: SessionMcpApprovalPolicy | null): string {
    return policy === true ? "always" : policy === false ? "never" : "selected";
  }
  function updatePolicy(next: string) {
    if (next === "always") void controller.update(true);
    else if (next === "never") void controller.update(false);
  }
</script>

<section class="og-mcp-policy" data-og-component="mcp-policy" data-og-state={$snapshot.loading ? "loading" : "ready"}>
  <header class="og-mcp-policy__header"><strong>MCP approval policy</strong><span>{$snapshot.server?.name ?? "Server"}</span></header>
  <label>
    Require approval
    <select value={value($snapshot.policy)} disabled={$snapshot.updating} onchange={(event) => updatePolicy(event.currentTarget.value)}>
      <option value="always">Always</option>
      <option value="never">Never</option>
      <option value="selected" disabled>Selected tools</option>
    </select>
  </label>
  {#if Array.isArray($snapshot.policy)}<small>{($snapshot.policy as string[]).length} selected tool rules</small>{/if}
  {#if $snapshot.error}<div class="og-error" role="alert">{$snapshot.error.message}</div>{/if}
</section>