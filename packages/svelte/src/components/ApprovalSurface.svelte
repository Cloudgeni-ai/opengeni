<script lang="ts">
  import type { PendingApproval, SessionControlStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";

  let { approvals, controller }: { approvals: readonly PendingApproval[]; controller: SessionControlStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

{#if approvals.length > 0}
  <section class="og-approval" data-og-component="approval" data-og-state={$snapshot.responding ? "submitting" : "waiting"} aria-live="polite">
    <header class="og-approval__title" data-og-part="header">
      <span class="og-approval__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M 12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
      </span>
      <div>
        <h2>Approval required</h2>
        <p>Review the requested action before the agent continues.</p>
      </div>
    </header>
    <div class="og-approval__list">
    {#each approvals as approval (approval.id)}
      <article data-approval-id={approval.id}>
        <p class="og-approval__name">{approval.name.replaceAll("_", " ").replaceAll(".", " › ")}</p>
        <pre class="og-approval__arguments">{JSON.stringify(approval.arguments, null, 2)}</pre>
        <div class="og-approval__actions">
          <button class="og-button" data-og-variant="secondary" type="button" disabled={$snapshot.responding} onclick={() => void controller.reject(approval.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg> Reject
          </button>
          <button class="og-button" data-og-variant="primary" type="button" disabled={$snapshot.responding} onclick={() => void controller.approve(approval.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg> Approve
          </button>
        </div>
      </article>
    {/each}
    </div>
    {#if $snapshot.error}<div class="og-error" role="alert">{$snapshot.error.message}</div>{/if}
  </section>
{/if}
