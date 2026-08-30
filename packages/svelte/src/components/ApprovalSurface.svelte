<script lang="ts">
  import type { PendingApproval, SessionControlStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";

  let { approvals, controller }: { approvals: readonly PendingApproval[]; controller: SessionControlStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

{#if approvals.length > 0}
  <section class="og-approval" data-og-component="approval" data-og-state={$snapshot.responding ? "submitting" : "waiting"} aria-live="polite">
    {#each approvals as approval (approval.id)}
      <article>
        <header class="og-approval__header"><strong>Approval required</strong><span>{approval.name}</span></header>
        <pre class="og-approval__arguments">{JSON.stringify(approval.arguments, null, 2)}</pre>
        <div class="og-approval__actions">
          <button class="og-button" data-og-variant="danger" type="button" disabled={$snapshot.responding} onclick={() => void controller.reject(approval.id)}>Reject</button>
          <button class="og-button" data-og-variant="primary" type="button" disabled={$snapshot.responding} onclick={() => void controller.approve(approval.id)}>Approve</button>
        </div>
      </article>
    {/each}
    {#if $snapshot.error}<div class="og-error" role="alert">{$snapshot.error.message}</div>{/if}
  </section>
{/if}