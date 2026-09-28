# Genie loading

Startup presentation lives in `packages/react/src/timeline/activity-rail.tsx`.
Normal preparation shows the MIT-licensed `thinking-orbs` React component (`searching`, 64px, speed 0.8) with a fixed list of playful phrases,
randomly selected every five seconds. After 30 seconds, factual waiting copy
replaces the phrases. Failure and cancellation stop the animation; actual
reasoning/tool activity replaces it. Reduced-motion preferences disable animation.

Startup phase events and their projection remain unchanged. The Debug inspector's
Startup tab displays recorded durations, including overlapping phases. Its
“Show startup details in chat” switch is off by default and stored only in the
current browser under `opengeni:startup-details:v1`. “Behind the magic” appears after 15 seconds and reveals
one activity group's details without changing that preference.

Run `bun run --cwd packages/react demo`, then open `/genie-loading.html` for
replayable quick, unhurried, long-wait, and failure scenarios, a light/dark switch,
and diagnostics. The studio renders the production MessageTimeline from simulated
SessionEvents and requires no model calls. The full stack runs with `bun run dev`.

Hosts can customize the SDK without editing its source:

```tsx
<MessageTimeline
  events={events}
  genieLoading={{
    phrases: ["Polishing the lamp…", "Consulting the carpet…"],
    orb: { state: "searching", size: 64, speed: 0.8 },
  }}
/>
```

Orb states use the `thinking-orbs` component's typed options. Omitted settings
keep the defaults; an empty phrase list also falls back to the defaults.

To brand or localize the native visual, supply `genieLoading.phrases` and
`genieLoading.messages`. Every message is optional and defaults to the existing
English copy:

```tsx
<MessageTimeline
  events={events}
  genieLoading={{
    phrases: ["Preparing…"],
    messages: {
      status: "Preparing your task.",
      slowStatus: "Preparing your task. Taking longer than usual.",
      slowText: "A little longer than usual…",
      showDetails: "Show details",
      hideDetails: "Hide details",
    },
  }}
/>
```

`status` and `slowStatus` are the stable screen-reader announcements; phrase
rotation stays decorative. The slow text appears after 30 seconds, while the
details button appears after 15 seconds (or whenever details are open). Message
overrides preserve native timing, accessibility, and details behavior. Empty
phrase arrays retain the default phrase list.

For an entirely different visual, supply `genieLoading.render`:

```tsx
<MessageTimeline
  events={events}
  genieLoading={{ render: () => <MyLoadingIndicator /> }}
/>
```

The renderer receives `startedAt`, `detailsOpen`, and `onShowDetails` to optionally
keep the diagnostics affordance. The SDK still owns loading visibility and exit
transitions. Returning `null` hides the visual.

## Readable turns (`turnSummary.rolling`)

`turnSummary={{ rolling: true }}` selects `groupTimeline(items, { readableTurns:
true })`. The September 28, 2026 OPE-591 decision supersedes the exchange-fold and
answer-anchor presentation. Runtime phase semantics, replay deduplication, and
classic `groupTimeline(items)` grouping are unchanged. The deprecated
`foldExchanges` option aliases readable turns; there is no legacy folding mode.

- **Assistant prose stays readable.** Every commentary and answer message is a
  distinct, fully formatted message with its normal actions. Short and long
  phase-less streams render identically: there is no character-count heuristic,
  replaceable note preview, or automatic demotion when more work follows.
- **One summary per turn.** Work uses a stable turn identity, never a cross-turn
  exchange fold. Routine machine deliveries coalesce into one compact reason per
  resumed turn, with payloads behind its disclosure. Prior turn-ending messages
  remain visible. Failures, approvals, auth recovery, human input, scheduled
  prompts, generated media, and deliberately presented images remain accessible.
- **Truthful activity.** Working and its elapsed clock remain active between
  tools, while the rolling latest tool retains its own actual completion state.
  Live category counts stay hidden; assistant text is not counted as steps.
  Completed summaries carry fuller facets. Completed compaction has a compact
  indicator and inspectable details. The disclosure chevron remains clear on
  phones without redundant show/hide-steps copy.
- **Stable settlement.** The Worked separator sits before the response. Its
  duration ends at the response's first delta, not its completion receipt. A
  declared final phase establishes that boundary while streaming; for phase-less
  messages, settlement identifies the last response without hiding any text.
  Same-row expansion state survives updates and settlement. New turns get their
  own rows rather than inheriting an earlier turn's disclosure.

The recorded wait itself reads "Waited for 1 agent · 3m 5s" once later input, a
pause, or the session failing or being cancelled ended it, or "Waiting · since
10:32" while it is still open, in both presentations.

OPE-99 normal tip-follow continues through long answers. Manual scroll, older
history anchors, and explicit Jump to latest retain their existing behavior.
There is no forced answer stop and no automatic repin on subsequent work.

One **Latest question** button targets the newest actual user message, never the
question nearest the viewport. Hosts with bounded history wire
`onJumpToLatestQuestion={events.jumpToLatestQuestion}` from `useSessionEvents`.
It resolves the newest durable `user.message` with one filtered read, then uses
the existing bounded `jumpToSequence` path only when needed. Target placement
wins over prepend correction without enabling tip-follow. Lookup failures are
retryable; stale history/identity requests cannot replace the current window.
Without the callback, local navigation is limited to the live window and does
not substitute an older page's last question. There are no previous/next arrows.

Tool labels reuse `ActivityDisclosure` through its compact presentation context;
reasoning keeps a stable Thinking label with a live text preview. Step changes roll
together over 400ms; a focused light beam sweeps across running text every 3.6
seconds. Reduced motion disables both animations.

`/exchange-fold.html` in the React demo replays a delegated question through every
stage (working, waiting, resumed, answering, done, follow-up) with a readable or
classic toggle and light/dark themes; `?scenario=follow-up`, `notes`, and `history`
replay messages streamed the way the runtime records them today (identified,
phase-less deltas), and `?scenario=machine-follow-up` replays an anonymized
recorded exchange whose answer (with an image and a question) is followed by one
more machine-triggered turn. `/rolling-steps.html` loops sample commands. Neither
needs model calls. `test/e2e/timeline-exchange-fold.browser.e2e.ts` covers, in the
readable presentation and in Chromium, normal long-answer following, manual
scroll retention, phase-less progress, older-history anchoring, newest-question
navigation across bounded windows, and answers surviving machine turns. It also
checks desktop/mobile light/dark layouts and disclosures. Set
`OPENGENI_TIMELINE_PREVIEW_DIR` to retain actual-component screenshots.
