<script lang="ts">
  import { onDestroy } from "svelte";
  import { SessionStatus, SessionSurface } from "@opengeni/svelte/session-ui";
  import {
    createContextSessionControllers,
    setOpenGeniContext,
  } from "@opengeni/svelte/session";
  import { FrameworkDemoClient, SESSION_ID, WORKSPACE_ID } from "./mock-client";
  import { FRAMEWORK_DEMO_DESCRIPTION, FRAMEWORK_DEMO_MODELS } from "../../../../test/fixtures/framework-session/demo-scenario";

  const client = new FrameworkDemoClient();
  setOpenGeniContext({ client, workspaceId: WORKSPACE_ID });
  const controllers = createContextSessionControllers(SESSION_ID, { goal: false });
  const sessionStore = controllers.session.store;
  const status = $derived($sessionStore.value?.status ?? "queued");
  const models = FRAMEWORK_DEMO_MODELS;
  let theme = $state<"dark" | "light">("dark");

  if (typeof window !== "undefined") {
    Object.assign(window, { __OPENGENI_DEMO_REQUESTS__: client.requests });
  }

  onDestroy(() => {
    controllers.destroy();
  });
</script>

<div class="sdk-demo" data-og-theme={theme === "light" ? "light" : undefined}>
  <header class="sdk-demo__header">
    <div>
      <p class="sdk-demo__eyebrow">OpenGeni frontend SDK</p>
      <h1>Session SDK showcase</h1>
      <p>Deterministic fixture · native Svelte components</p>
    </div>
    <div class="sdk-demo__actions">
      <span class="sdk-demo__framework">Svelte</span>
      <button type="button" onclick={() => (theme = theme === "dark" ? "light" : "dark")} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </div>
  </header>
  <main class="sdk-demo__main">
    <section class="sdk-session" data-demo-surface="session">
      <header class="sdk-session__header">
        <div>
          <h2>Deterministic session</h2>
          <p>{FRAMEWORK_DEMO_DESCRIPTION}</p>
        </div>
        <div class="sdk-session__status"><span>stream live</span><SessionStatus {status} /></div>
      </header>
      <div class="sdk-session__surface">
        <SessionSurface
          {controllers}
          title="Deterministic session"
          {models}
          showChrome={false}
        />
      </div>
    </section>
  </main>
</div>
