<script lang="ts">
  import type { AuthNeededItem, TimelineItem } from "@opengeni/sdk/session";
  import {
    timelineRendererFor,
    type AuthReconnectHandler,
    type TimelineRendererRegistry,
  } from "../renderers";
  import {
    authNeededPresentation,
    boundedTimelineValue,
    timelineItemLabel,
    timelineItemOutcome,
    timelineItemSummary,
  } from "../timeline-presentation";
  import UserMessageBody from "./UserMessageBody.svelte";

  let {
    item,
    renderers,
    onReconnect,
  }: {
    item: TimelineItem;
    renderers?: TimelineRendererRegistry | undefined;
    onReconnect?: AuthReconnectHandler | undefined;
  } = $props();
  let renderer = $derived(timelineRendererFor(renderers, item));
  let label = $derived(timelineItemLabel(item));
  let outcome = $derived(timelineItemOutcome(item));
  let summary = $derived(timelineItemSummary(item));
  let deliveryFailed = $derived(item.kind === "user-message" && item.delivery?.state === "failed");
  let reconnecting = $state(false);
  let reconnectFailed = $state(false);

  function humanize(value: string): string {
    return value.replaceAll("_", " ");
  }

  function titleize(value: string): string {
    const text = humanize(value);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function workerTitle(value: Extract<TimelineItem, { kind: "worker" }>): string {
    const noun = value.action === "spawn" ? "Worker spawn" : "Worker message";
    if (value.status === "running") return value.action === "spawn" ? "Spawning worker" : "Messaging worker";
    if (value.status === "complete") return `${noun} complete`;
    if (value.status === "failed") return `${noun} failed`;
    return `${noun} interrupted`;
  }

  function workerCompletionTitle(value: Extract<TimelineItem, { kind: "worker-completion" }>): string {
    if (value.childStatus === "failed") return "Worker failed";
    if (value.goalStatus === "paused") return "Worker paused";
    if (value.goalStatus === "completed") return "Worker completed";
    return "Worker reported back";
  }

  async function reconnect(value: AuthNeededItem) {
    if (!onReconnect || reconnecting) return;
    reconnecting = true;
    reconnectFailed = false;
    try {
      await onReconnect(value);
    } catch {
      reconnectFailed = true;
    } finally {
      reconnecting = false;
    }
  }
</script>

<article class="og-timeline-row" data-og-component="timeline-row" data-og-kind={item.kind} data-og-outcome={outcome}>
  <div class="og-timeline-row__meta" data-og-part="metadata">{label}</div>
  <div class="og-timeline-row__body" data-og-part="body">
    {#if renderer}
      {@render renderer(item)}
    {:else if item.kind === "user-message"}
      <UserMessageBody text={item.text} />
    {:else if item.kind === "agent-message" || item.kind === "reasoning"}
      <div data-og-part="message-text" data-og-state={item.streaming ? "streaming" : "ready"}>{item.text}</div>
    {:else if item.kind === "tool-call"}
      <details class="og-timeline-row__details og-timeline-row__compact-details">
        <summary><svg class="og-timeline-row__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/></svg><strong>{titleize(item.name)}</strong> <span>{item.status === "complete" ? "Done" : titleize(item.status)}</span></summary>
        {#if item.arguments !== undefined}<pre>{boundedTimelineValue(item.arguments)}</pre>{/if}
        {#if item.output !== undefined && item.output !== null}<pre>{boundedTimelineValue(item.output)}</pre>{/if}
      </details>
    {:else if item.kind === "human-input"}
      <strong>{item.questions.map((question) => question.label ?? question.prompt).join(" · ")}</strong>
      {#if item.answers.length > 0}<div>{item.answers.flatMap((answer) => answer.values).join(" · ")}</div>{/if}
    {:else if item.kind === "worker"}
      <div class="og-timeline-row__headline">
        <strong>{workerTitle(item)}</strong>
        <span class="og-timeline-row__pill">{humanize(item.status)}</span>
      </div>
      {#if item.prompt}<p class="og-timeline-row__summary">{item.prompt}</p>{/if}
      {#if item.failure}
        <div class="og-timeline-row__failure" role="alert">
          <code>{item.failure.code}</code>
          <span>{item.failure.message}</span>
        </div>
      {/if}
      {#if item.workerSessionId}<code class="og-timeline-row__identifier">{item.workerSessionId}</code>{/if}
    {:else if item.kind === "worker-completion"}
      <div class="og-timeline-row__headline">
        <strong>{workerCompletionTitle(item)}</strong>
        <span class="og-timeline-row__pill">{humanize(item.childStatus)}</span>
      </div>
      {#if item.goalText}<p class="og-timeline-row__summary">{item.goalText}</p>{/if}
      {#if item.text || item.evidence || (item.goalStatus === "paused" && item.pausedReason)}
        <details class="og-timeline-row__details">
          <summary>Show worker report</summary>
          {#if item.text}<p>{item.text}</p>{/if}
          {#if item.evidence}<p><strong>Evidence</strong><br />{item.evidence}</p>{/if}
          {#if item.goalStatus === "paused" && item.pausedReason}<p><strong>Paused because</strong><br />{item.pausedReason}</p>{/if}
        </details>
      {/if}
      <code class="og-timeline-row__identifier">{item.childSessionId}</code>
    {:else if item.kind === "sandbox"}
      <details class="og-timeline-row__details og-timeline-row__compact-details">
        <summary><svg class="og-timeline-row__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg><strong>{titleize(item.name)}</strong>{#if item.command}<span>{item.command}</span>{/if}</summary>
        {#if item.origin}<p class="og-timeline-row__summary">Sandbox {item.origin}</p>{/if}
        {#if item.output}<pre>{boundedTimelineValue(item.output)}</pre>{/if}
      </details>
    {:else if item.kind === "startup-phase"}
      <div class="og-timeline-row__headline">
        <span class="og-timeline-row__title"><svg class="og-timeline-row__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg><span>{titleize(item.phase)} ready</span></span>
        {#if item.durationMs !== null}<span class="og-timeline-row__summary">{item.durationMs.toLocaleString("en-US")} ms</span>{/if}
      </div>
    {:else if item.kind === "memory"}
      <div class="og-timeline-row__headline">
        <strong>{item.variant === "corrected" ? "Updated memory" : "Saved to memory"}</strong>
        {#if item.memoryKind}<span class="og-timeline-row__pill">{humanize(item.memoryKind)}</span>{/if}
      </div>
      {#if item.variant === "corrected" && item.replacementPreview}
        <p class="og-timeline-row__previous">{item.preview}</p>
        <p>{item.replacementPreview}</p>
      {:else}
        <p>{item.preview}</p>
      {/if}
      {#if item.variant === "corrected" && !item.replacementPreview}
        <p class="og-timeline-row__summary">{item.action === "updated" ? "Updated in place." : "Archived."}</p>
      {/if}
      {#if item.deduped}<p class="og-timeline-row__summary">Merged into an existing memory.</p>{/if}
    {:else if item.kind === "fleet-decision"}
      <div class="og-timeline-row__headline">
        <strong>{humanize(item.actualOutcome)}</strong>
        <span class="og-timeline-row__pill">{humanize(item.confidence)} confidence</span>
      </div>
      <p class="og-timeline-row__summary">{humanize(item.actualReason)} · {humanize(item.comparison)}</p>
      <details class="og-timeline-row__details">
        <summary>Show placement evidence</summary>
        <dl class="og-timeline-row__definition-list">
          <div><dt>Admission</dt><dd>{humanize(item.admissionOutcome)} · {humanize(item.admissionReason)}</dd></div>
          <div><dt>Candidates</dt><dd>{item.candidateCount.toLocaleString("en-US")}</dd></div>
          <div><dt>Stranded eligible</dt><dd>{item.strandedEligibleCount.toLocaleString("en-US")}</dd></div>
        </dl>
        {#if item.scores.length > 0}
          <ul>
            {#each item.scores as score (score.candidateKey)}
              <li><code>{score.candidateKey}</code> · {score.eligible ? "eligible" : humanize(score.rejectionReason ?? "ineligible")} · {score.total}</li>
            {/each}
          </ul>
        {/if}
      </details>
    {:else if item.kind === "session-status"}
      <div class="og-timeline-row__status" role="status">
        <span aria-hidden="true"></span>
        <strong>{humanize(item.status)}</strong>
      </div>
    {:else if item.kind === "goal"}
      <div class="og-timeline-row__landmark" role="status">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
        <span>Goal {humanize(item.action)}{#if item.text}: {item.text}{/if}</span>
      </div>
    {:else if item.kind === "notice"}
      <div class="og-timeline-row__notice"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><span>{item.text}</span></div>
      {#if item.details}<pre>{item.details.label}: {boundedTimelineValue(item.details.value)}</pre>{/if}
      {#if item.action}<a class="og-button" href={item.action.url}>{item.action.label}</a>{/if}
    {:else if item.kind === "context-compaction"}
      <div class="og-timeline-row__headline">
        <strong>{summary}</strong>
        {#if item.trigger}<span class="og-timeline-row__pill">{humanize(item.trigger)}</span>{/if}
      </div>
      {#if item.estimatedTokensBefore !== null || item.estimatedTokensAfter !== null}
        <p class="og-timeline-row__summary">
          Estimated history tokens:
          {item.estimatedTokensBefore === null ? "unknown" : item.estimatedTokensBefore.toLocaleString("en-US")}
          →
          {item.estimatedTokensAfter === null ? "unknown" : item.estimatedTokensAfter.toLocaleString("en-US")}
        </p>
      {/if}
      {#if item.skipReason}<p class="og-timeline-row__failure">{humanize(item.skipReason)}</p>{/if}
      {#if item.implementation}<code class="og-timeline-row__identifier">{item.implementation}</code>{/if}
    {:else if item.kind === "machine-input-batch"}
      <ul>{#each item.members as member (member.id)}<li>{member.summary}</li>{/each}</ul>
    {:else if item.kind === "auth-needed"}
      {@const auth = authNeededPresentation(item)}
      <div class="og-timeline-row__headline">
        <strong>{auth.title}</strong>
        <span class="og-timeline-row__pill">Action required</span>
      </div>
      <p class="og-timeline-row__summary">{auth.reasonLine}</p>
      {#if auth.capability}<p>Provider: <code>{item.providerDomain}</code></p>{/if}
      {#if auth.requiredVariables.length > 0}
        <p>Needs variables: <code>{auth.requiredVariables.join(", ")}</code></p>
      {/if}
      {#if item.toolName}<p>Requested by <code>{item.toolName}</code></p>{/if}
      {#if item.authoritySource === "host" && item.authorizationUrl}
        <a class="og-button" href={item.authorizationUrl} rel="noreferrer" target="_blank">{auth.actionLabel}</a>
      {:else if item.authoritySource !== "host" && auth.actionable && onReconnect}
        <button class="og-button" type="button" disabled={reconnecting} onclick={() => void reconnect(item)}>{reconnecting ? "Opening…" : auth.actionLabel}</button>
      {:else if item.authoritySource !== "host" && auth.actionable && item.authorizationUrl}
        <a class="og-button" href={item.authorizationUrl} rel="noreferrer" target="_blank">{auth.actionLabel}</a>
      {/if}
      {#if auth.followUpLine}<p class="og-timeline-row__summary">{auth.followUpLine}</p>{/if}
      {#if reconnectFailed}<p class="og-timeline-row__failure" role="alert">Could not start connection setup. Try again.</p>{/if}
    {:else if item.kind === "turn-end"}
      <div class="og-timeline-row__status" role="status">
        <span aria-hidden="true"></span>
        <strong>Turn {humanize(item.outcome)}</strong>
      </div>
      {#if item.failureText}<p class="og-timeline-row__failure">{item.failureText}</p>{/if}
    {/if}
  </div>
  {#if item.kind === "user-message" && deliveryFailed}
    <div class="og-message-delivery" role="status" aria-live="polite" aria-atomic="true" title={item.delivery?.error}>
      <span>Message not sent</span>
      {#if item.delivery?.onRetry}<button class="og-button" type="button" onclick={item.delivery.onRetry}>Retry</button>{/if}
      {#if item.delivery?.onRemove}<button class="og-button" type="button" onclick={item.delivery.onRemove}>Remove</button>{/if}
    </div>
  {/if}
</article>
