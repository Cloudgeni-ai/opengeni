<script lang="ts">
  import { projectPendingApprovals } from "@opengeni/sdk/session";
  import type { SessionSurfaceControllers } from "../controllers";
  import { projectOptimisticQueuedMessages } from "../optimistic-messages";
  import { editQueuedTurnIntoComposer } from "../queue-edit";
  import type { AuthReconnectHandler } from "../renderers";
  import { readableFromController } from "../store";
  import ApprovalSurface from "./ApprovalSurface.svelte";
  import GoalSurface from "./GoalSurface.svelte";
  import HumanInputSurface from "./HumanInputSurface.svelte";
  import MessageTimeline from "./MessageTimeline.svelte";
  import QueueSurface from "./QueueSurface.svelte";
  import SessionChrome from "./SessionChrome.svelte";
  import SessionComposer from "./SessionComposer.svelte";

  let {
    controllers,
    title = "OpenGeni session",
    models = [],
    tools = [],
    selectedTools = [],
    onToolsChange,
    onReconnect,
  }: {
    controllers: SessionSurfaceControllers;
    title?: string;
    models?: readonly string[];
    tools?: readonly { id: string; label: string }[];
    selectedTools?: readonly string[];
    onToolsChange?: ((ids: string[]) => void) | undefined;
    onReconnect?: AuthReconnectHandler | undefined;
  } = $props();
  let session = $derived(readableFromController(controllers.session.controller, { owned: false }));
  let events = $derived(readableFromController(controllers.events.controller, { owned: false }));
  let control = $derived(readableFromController(controllers.control.controller, { owned: false }));
  let queue = $derived(readableFromController(controllers.queue.controller, { owned: false }));
  let composer = $derived(readableFromController(controllers.composer.controller, { owned: false }));
  let humanInput = $derived(controllers.humanInput ? readableFromController(controllers.humanInput.controller, { owned: false }) : null);
  let goal = $derived(controllers.goal ? readableFromController(controllers.goal.controller, { owned: false }) : null);
  let approvals = $derived(projectPendingApprovals([...$events.events]));
  let status = $derived($events.sessionStatus ?? $session.value?.status ?? "queued");
  let optimisticQueueCount = $derived(
    projectOptimisticQueuedMessages($composer.optimisticMessages, $queue).length,
  );

  $effect(() => controllers.acquire());

  function pause() {
    controllers.control.controller.clearError();
    return controllers.control.controller.pause();
  }

  function resume() {
    controllers.control.controller.clearError();
    return controllers.control.controller.resume();
  }

  async function editQueuedTurn(turnId: string) {
    const edited = await editQueuedTurnIntoComposer({
      queue: controllers.queue.controller,
      composer: controllers.composer.controller,
      turnId,
      confirmReplace: () =>
        window.confirm(
          "Your composer already has a draft. Replace it with this queued prompt? The current draft will be permanently discarded.",
        ),
    });
    if (!edited) return;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
    });
  }
</script>

<section class="og-root og-session" data-og-component="session" data-og-state={status}>
  <SessionChrome
    title={$session.value?.title ?? title}
    {status}
    paused={$queue.effectiveControl?.state === "paused"}
    controlling={$control.controlling}
    queueCount={$queue.queue.length + optimisticQueueCount}
    approvalCount={approvals.length}
    inputCount={humanInput ? ($humanInput?.requests.length ?? 0) : 0}
    goalLabel={goal ? $goal?.value?.status : undefined}
    onPause={pause}
    onResume={resume}
  />
  {#if $control.error}<div class="og-error" data-og-part="control-error" role="alert">{$control.error.message}</div>{/if}
  <MessageTimeline controller={controllers.events.controller} composer={controllers.composer.controller} {onReconnect} />
  <div data-og-part="controls">
    {#if approvals.length > 0}<ApprovalSurface {approvals} controller={controllers.control.controller} showError={false} />{/if}
    {#if controllers.humanInput}<HumanInputSurface controller={controllers.humanInput.controller} />{/if}
    {#if controllers.goal}<GoalSurface controller={controllers.goal.controller} />{/if}
    {#if $queue.queue.length > 0 || optimisticQueueCount > 0}<QueueSurface controller={controllers.queue.controller} composer={controllers.composer.controller} onEdit={editQueuedTurn} />{/if}
  </div>
  <SessionComposer
    controller={controllers.composer.controller}
    attachments={controllers.attachments?.controller}
    {models}
    {tools}
    {selectedTools}
    {onToolsChange}
  />
</section>