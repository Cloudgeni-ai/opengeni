<script lang="ts">
  import { OpenGeniClient } from "@opengeni/sdk";
  import { onDestroy, onMount, tick } from "svelte";
  import {
    LatencyPicker,
    ModelPicker,
    ReasoningPicker,
    SessionStatus,
    ToolPolicyPicker,
    createAttachments,
    createComposer,
    createGoal,
    createHumanInput,
    createSessionControl,
    createSessionEvents,
    createSessionResource,
    createTurnQueue,
    SessionSurface,
    type SessionSurfaceControllers,
    type ToolPolicyOption,
  } from "../../src";
  import { MissionControlMockClient, SESSION_ID, WORKSPACE_ID } from "./mock-client";

  const query = new URLSearchParams(location.search);
  const live = query.get("mode") === "live";
  const workspaceId = query.get("workspace") ?? WORKSPACE_ID;
  const sessionId = query.get("session") ?? SESSION_ID;
  const client = live ? new OpenGeniClient({ baseUrl: "/demo-api" }) : new MissionControlMockClient();
  const session = createSessionResource({ client: client as never, workspaceId, sessionId });
  const eventController = createSessionEvents({ client: client as never, workspaceId, sessionId });
  const composer = createComposer({
    client: client as never,
    workspaceId,
    sessionId,
    events: [],
  });
  const queue = createTurnQueue({ client: client as never, workspaceId, sessionId });
  const managed = {
    session,
    events: eventController,
    composer,
    attachments: createAttachments({ client: client as never, workspaceId }),
    queue,
    control: createSessionControl({ client: client as never, workspaceId, sessionId }),
    goal: createGoal({ client: client as never, workspaceId, sessionId }),
    humanInput: createHumanInput({ client: client as never, workspaceId, sessionId }),
  };
  const unsubscribeComposerEvents = eventController.controller.subscribe(() => {
    composer.controller.applyEvents([...eventController.controller.getSnapshot().events]);
  });
  const unsubscribeComposerQueue = queue.controller.subscribe(() => {
    composer.controller.setEffectiveControl(queue.controller.getSnapshot().effectiveControl);
  });
  composer.controller.applyEvents([...eventController.controller.getSnapshot().events]);
  composer.controller.setEffectiveControl(queue.controller.getSnapshot().effectiveControl);
  const controllers: SessionSurfaceControllers = {
    ...managed,
    destroy() {
      for (const controller of Object.values(managed)) controller.destroy();
    },
  };
  const composerStore = managed.composer.store;
  const eventStore = managed.events.store;
  const queueStore = managed.queue.store;
  const sessionStore = managed.session.store;
  const modelOptions = ["gpt-5.4", "codex/gpt-5.4", "gateway/openai/gpt-5.4"] as const;
  const toolPolicies: readonly ToolPolicyOption[] = [
    { id: "search", label: "Search", description: "Find current public evidence.", state: "enabled" },
    { id: "github", label: "GitHub", description: "Inspect repositories and pull requests.", state: "approval-required" },
    { id: "browser", label: "Browser", description: "Open and inspect web applications.", state: "available" },
    { id: "deploy", label: "Deploy", description: "Apply infrastructure changes.", state: "connection-required" },
    { id: "billing", label: "Billing", description: "Restricted by workspace policy.", state: "denied" },
  ];
  const composerTools = toolPolicies
    .filter((tool) => tool.state !== "denied" && tool.state !== "unavailable")
    .map(({ id, label }) => ({ id, label }));
  const sessionStatus = $derived($eventStore.sessionStatus ?? $sessionStore.value?.status ?? "queued");
  let selectedTools = $state<string[]>(["search", "github"]);
  let theme = $state<"dark" | "light">("dark");
  let density = $state<"comfortable" | "compact">("comfortable");
  let navigationOpen = $state(false);
  let inspectorOpen = $state(false);
  let navigationTrigger = $state<HTMLButtonElement>();
  let inspectorTrigger = $state<HTMLButtonElement>();

  function closeDrawers() {
    const trigger = navigationOpen ? navigationTrigger : inspectorOpen ? inspectorTrigger : undefined;
    navigationOpen = false;
    inspectorOpen = false;
    if (trigger) void tick().then(() => trigger.focus({ preventScroll: true }));
  }

  onMount(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawers();
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });
  onDestroy(() => {
    unsubscribeComposerEvents();
    unsubscribeComposerQueue();
    controllers.destroy();
  });
</script>

<div
  class="og-root mission-shell"
  data-og-theme={theme}
  data-og-density={density === "compact" ? "compact" : undefined}
  data-navigation-open={navigationOpen}
  data-inspector-open={inspectorOpen}
>
  <header class="mission-header">
    <div class="mission-brand">
      <button
        bind:this={navigationTrigger}
        class="mission-mobile-action og-button"
        type="button"
        aria-controls="mission-navigation"
        aria-expanded={navigationOpen}
        onclick={() => {
          navigationOpen = !navigationOpen;
          inspectorOpen = false;
        }}
      >Sessions</button>
      <div>
        <p class="mission-eyebrow">OpenGeni</p>
        <h1>Mission Control <span>Svelte</span></h1>
      </div>
    </div>
    <div class="mission-context" aria-label="Demo context">
      <SessionStatus status={sessionStatus as never} />
      <span>{live ? "Live same-origin session" : "Deterministic release fixture"}</span>
    </div>
    <div class="mission-controls">
      <button class="og-button" type="button" onclick={() => (theme = theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light" : "Dark"}</button>
      <button class="og-button" type="button" onclick={() => (density = density === "compact" ? "comfortable" : "compact")}>{density === "compact" ? "Comfortable" : "Compact"}</button>
      <button
        bind:this={inspectorTrigger}
        class="mission-mobile-action og-button"
        type="button"
        aria-controls="mission-inspector"
        aria-expanded={inspectorOpen}
        onclick={() => {
          inspectorOpen = !inspectorOpen;
          navigationOpen = false;
        }}
      >Configure</button>
    </div>
  </header>

  <div class="mission-layout">
    <aside id="mission-navigation" class="mission-navigation" aria-label="Session navigation">
      <div class="mission-panel-heading">
        <div><p class="mission-eyebrow">Workspace</p><h2>Release command</h2></div>
        <button class="mission-close og-icon-button" type="button" aria-label="Close session navigation" onclick={closeDrawers}>×</button>
      </div>
      <nav aria-label="OpenGeni sessions">
        <button class="mission-session" data-selected="true" type="button">
          <span class="mission-session__status" aria-hidden="true"></span>
          <span><strong>{$sessionStore.value?.title ?? "Framework-neutral UI release"}</strong><small>Approval and operator input required</small></span>
          <time datetime="2026-08-29T12:00:00Z">now</time>
        </button>
        <button class="mission-session" type="button">
          <span class="mission-session__status" data-state="idle" aria-hidden="true"></span>
          <span><strong>SDK package audit</strong><small>Completed with clean closure</small></span>
          <time datetime="2026-08-29T11:42:00Z">42m</time>
        </button>
        <button class="mission-session" type="button">
          <span class="mission-session__status" data-state="paused" aria-hidden="true"></span>
          <span><strong>Preview environment</strong><small>Waiting for candidate SHA</small></span>
          <time datetime="2026-08-29T10:55:00Z">1h</time>
        </button>
      </nav>
      <section class="mission-rail-summary" aria-labelledby="release-readiness-title">
        <p class="mission-eyebrow">Readiness</p>
        <h3 id="release-readiness-title">Two decisions remain</h3>
        <dl><div><dt>Queue</dt><dd>{$queueStore.queue.length}</dd></div><div><dt>Events</dt><dd>{$eventStore.events.length}</dd></div><div><dt>Mode</dt><dd>{live ? "Live" : "Fixture"}</dd></div></dl>
      </section>
      {#if !live}<button class="mission-reset" type="button" onclick={() => location.reload()}>Reset deterministic scenario</button>{/if}
    </aside>

    <main class="mission-main">
      <SessionSurface
        {controllers}
        models={modelOptions}
        tools={composerTools}
        {selectedTools}
        onToolsChange={(ids) => (selectedTools = ids)}
      />
    </main>

    <aside id="mission-inspector" class="mission-inspector" aria-label="Session configuration">
      <div class="mission-panel-heading">
        <div><p class="mission-eyebrow">Run policy</p><h2>Session configuration</h2></div>
        <button class="mission-close og-icon-button" type="button" aria-label="Close session configuration" onclick={closeDrawers}>×</button>
      </div>
      <section class="mission-inspector-section" aria-labelledby="model-policy-title">
        <div class="mission-section-heading"><h3 id="model-policy-title">Model policy</h3><small>Applies to the next delivery</small></div>
        <label class="mission-field"><span>Model</span><ModelPicker value={$composerStore.model || modelOptions[0]} options={modelOptions.map((id) => ({ id }))} onChange={managed.composer.controller.setModel} /></label>
        <label class="mission-field"><span>Reasoning</span><ReasoningPicker value={$composerStore.reasoningEffort} onChange={managed.composer.controller.setReasoningEffort} /></label>
        <label class="mission-field"><span>Latency</span><LatencyPicker value={$composerStore.latencyMode} onChange={managed.composer.controller.setLatencyMode} /></label>
      </section>
      <section class="mission-inspector-section" aria-labelledby="tools-title">
        <div class="mission-section-heading"><h3 id="tools-title">Capabilities</h3><small>{selectedTools.length} enabled</small></div>
        <ToolPolicyPicker tools={toolPolicies} selected={selectedTools} onChange={(ids) => (selectedTools = ids)} />
      </section>
      <section class="mission-inspector-section mission-runtime" aria-labelledby="runtime-title">
        <div class="mission-section-heading"><h3 id="runtime-title">Runtime</h3><small>Browser-safe authority</small></div>
        <dl>
          <div><dt>Transport</dt><dd>{live ? "Same-origin proxy" : "In-memory fixture"}</dd></div>
          <div><dt>Connection</dt><dd>{$eventStore.connectionState}</dd></div>
          <div><dt>Draft</dt><dd>{$composerStore.dirty ? "Unsaved" : "Synchronized"}</dd></div>
          <div><dt>Session</dt><dd>{sessionId.slice(0, 8)}…</dd></div>
        </dl>
      </section>
    </aside>
  </div>

  {#if navigationOpen || inspectorOpen}
    <button class="mission-backdrop" type="button" aria-label="Close open panel" onclick={closeDrawers}></button>
  {/if}
</div>
