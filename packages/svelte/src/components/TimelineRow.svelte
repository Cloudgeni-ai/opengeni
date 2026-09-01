<script lang="ts">
  import type { TimelineItem } from "@opengeni/sdk/session";
  import { timelineRendererFor, type TimelineRendererRegistry } from "../renderers";
  import {
    boundedTimelineValue,
    timelineItemLabel,
    timelineItemOutcome,
    timelineItemSummary,
  } from "../timeline-presentation";
  import UserMessageBody from "./UserMessageBody.svelte";

  let {
    item,
    renderers,
  }: {
    item: TimelineItem;
    renderers?: TimelineRendererRegistry | undefined;
  } = $props();
  let renderer = $derived(timelineRendererFor(renderers, item));
  let label = $derived(timelineItemLabel(item));
  let outcome = $derived(timelineItemOutcome(item));
  let summary = $derived(timelineItemSummary(item));

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
</script>

<article class="og-timeline-row" data-og-component="timeline-row" data-og-kind={item.kind} data-og-outcome={outcome}>
  <div class="og-timeline-row__meta" data-og-part="metadata">{label}</div>
  <div class="og-timeline-row__body" data-og-part="body">
    {#if renderer}
      {@render renderer(item)}
    {:else if item.kind === "user-message"}
      <UserMessageBody text={item.text} />
    {:else if item.kind === "agent-message" || item.kind === "reasoning"}
      <div data-og-state={item.streaming ? "streaming" : "ready"}>{item.text}</div>
    {:else if item.kind === "tool-call"}
      <details class="og-timeline-row__details og-timeline-row__compact-details">
        <summary><strong>{titleize(item.name)}</strong> <span>{item.status === "complete" ? "Done" : titleize(item.status)}</span></summary>
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
        <summary><strong>{titleize(item.name)}</strong>{#if item.command}<span>{item.command}</span>{/if}</summary>
        {#if item.origin}<p class="og-timeline-row__summary">Sandbox {item.origin}</p>{/if}
        {#if item.output}<pre>{boundedTimelineValue(item.output)}</pre>{/if}
      </details>
    {:else if item.kind === "startup-phase"}
      <div class="og-timeline-row__headline">
        <strong>{titleize(item.phase)} ready</strong>
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
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3"/></svg>
        <span>{titleize(item.action)}{#if item.text}: {item.text}{/if}</span>
      </div>
    {:else if item.kind === "notice"}
      <div class="og-timeline-row__notice"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 17H2L10 3Z"/><path d="M10 7v4M10 14h.01"/></svg><span>{item.text}</span></div>
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
      <div class="og-timeline-row__headline">
        <strong>{item.providerDomain || "Provider"} needs to be connected again</strong>
        <span class="og-timeline-row__pill">Action required</span>
      </div>
      <p class="og-timeline-row__summary">The failed tool call was not replayed.</p>
      {#if item.toolName}<p>Requested by <code>{item.toolName}</code></p>{/if}
      {#if item.authorizationUrl}
        <a class="og-button" href={item.authorizationUrl} rel="noreferrer" target="_blank">Connect</a>
      {/if}
    {:else if item.kind === "turn-end"}
      <div class="og-timeline-row__status" role="status">
        <span aria-hidden="true"></span>
        <strong>Turn {humanize(item.outcome)}</strong>
      </div>
      {#if item.failureText}<p class="og-timeline-row__failure">{item.failureText}</p>{/if}
    {/if}
  </div>
</article>
