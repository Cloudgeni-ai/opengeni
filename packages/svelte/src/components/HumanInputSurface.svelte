<script lang="ts">
  import type { HumanInputStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";
  import HumanInputForm from "./HumanInputForm.svelte";

  let { controller }: { controller: HumanInputStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

{#if $snapshot.requests[0]}
  <HumanInputForm
    request={$snapshot.requests[0]}
    submitting={$snapshot.respondingRequestId === $snapshot.requests[0].id}
    onSubmit={async (response) => { await controller.respond($snapshot.requests[0]!.id, response); }}
  />
{/if}
{#if $snapshot.mutationError}<div class="og-error" role="alert">{$snapshot.mutationError.message}</div>{/if}