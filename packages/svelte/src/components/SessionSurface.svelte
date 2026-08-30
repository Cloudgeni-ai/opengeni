<script lang="ts">
  import { projectPendingApprovals } from "@opengeni/sdk/session";
  import type { SessionSurfaceControllers } from "../controllers";
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
  }: {
    controllers: SessionSurfaceControllers;
    title?: string;
    models?: readonly string[];
    tools?: readonly { id: string; label: string }[];
    selectedTools?: readonly string[];
    onToolsChange?: ((ids: string[]) => void) | undefined;
  } = $props();
  let session = $derived(readableFromController(controllers.session.controller, { owned: false }));
  let events = $derived(readableFromController(controllers.events.controller, { owned: false }));
  let control = $derived(readableFromController(controllers.control.controller, { owned: false }));
  let queue = $derived(readableFromController(controllers.queue.controller, { owned: false }));
  let humanInput = $derived(controllers.humanInput ? readableFromController(controllers.humanInput.controller, { owned: false }) : null);
  let goal = $derived(controllers.goal ? readableFromController(controllers.goal.controller, { owned: false }) : null);
  let approvals = $derived(projectPendingApprovals([...$events.events]));
  let status = $derived($events.sessionStatus ?? $session.value?.status ?? "queued");
</script>

<section class="og-root og-session" data-og-component="session" data-og-state={status}>
  <SessionChrome
    title={$session.value?.title ?? title}
    {status}
    paused={$queue.effectiveControl?.state === "paused"}
    controlling={$control.controlling}
    queueCount={$queue.queue.length}
    approvalCount={approvals.length}
    inputCount={humanInput ? ($humanInput?.requests.length ?? 0) : 0}
    goalLabel={goal ? $goal?.value?.status : undefined}
    onPause={() => controllers.control.controller.pause()}
    onResume={() => controllers.control.controller.resume()}
  />
  <MessageTimeline controller={controllers.events.controller} />
  <div data-og-part="controls">
    {#if approvals.length > 0}<ApprovalSurface {approvals} controller={controllers.control.controller} />{/if}
    {#if controllers.humanInput}<HumanInputSurface controller={controllers.humanInput.controller} />{/if}
    {#if controllers.goal}<GoalSurface controller={controllers.goal.controller} />{/if}
    {#if $queue.queue.length > 0}<QueueSurface controller={controllers.queue.controller} />{/if}
  </div>
  <SessionComposer
    controller={controllers.composer.controller}
    attachments={controllers.attachments.controller}
    {models}
    {tools}
    {selectedTools}
    {onToolsChange}
  />
</section>