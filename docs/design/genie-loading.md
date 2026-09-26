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

## Compact progress (`turnSummary.rolling`)

`turnSummary={{ rolling: true }}` selects the compact progress presentation, which
the web app enables. It groups with `groupTimeline(items, { foldExchanges: true })`:

- **Commentary is activity.** Assistant prose that narrates work joins its activity
  cluster instead of splitting it: a provider-declared `commentary` phase, or, for
  phase-less events, a message that more work or prose followed in the same turn.
  The runtime does not yet record a phase, and while it streams the latest message
  of the running turn cannot be told apart from a note, so it stays the live note
  until its turn ends or it grows past 1,000 characters (a length recorded notes
  rarely reach); a declared `final_answer` phase is an answer at once. A long
  message that turns out to be a note folds back once work follows it.
- **One row per exchange.** Everything between two human boundaries folds behind
  one status row. Only human messages, structured human input, and input notices
  start a new exchange. Routine machine inputs (child results and progress, agent
  messages, background command results, wait timeouts, goal continuations),
  recorded waits, and completed compaction fold inside; compaction also counts as
  the chip's `compacted` facet. Failed turns, approvals, auth recovery, scheduled
  prompts, generated media, and presented images stay visible between folds.
- **Live status.** While the agent works, the row reads "Working · 2m 14s · 12
  steps" with a live clock and the step count (notes are not steps). Below it, the
  latest progress note is previewed muted and clamped to two lines, replaced when a
  newer note arrives, and the fixed-height rolling reel shows the current step even
  when there is no note. A parked exchange reads "Waiting for 2 agents · 3m" using
  the delegated workers (sessions this session spawned) that had not reported back
  when the wait began; a pending approval or question reads "Waiting for you".
  Opening the row shows every earlier turn, note, input, and wait on one rail.
- **Answer.** The answer renders below a "Worked for 4m 10s" separator that carries
  the remaining facets; the time runs until the answer started, so it does not
  change when the answer completes. A turn that ends without an answer still lifts
  its latest note as the visible reply, unless it parked in a wait.

The recorded wait itself reads "Waited for 1 agent · 3m 5s" once later input, a
pause, or the session failing or being cancelled ended it, or "Waiting · since
10:32" while it is still open, in both presentations.

Following the tip stops once an answer pushes its question to the top of the
viewport (or, when the question had already scrolled away, the status row or the
answer itself). The stop applies only while that answer is the newest row: once a
question, more work, or the answer folding back into a note follows it, a reader
who has not moved since returns to the tip. When the question of the exchange
being read has scrolled away, a "Your question" control returns to it, with
previous and next question buttons.

Tool labels reuse `ActivityDisclosure` through its compact presentation context;
reasoning keeps a stable Thinking label with a live text preview. Step changes roll
together over 400ms; a focused light beam sweeps across running text every 3.6
seconds. Reduced motion disables both animations.

`/exchange-fold.html` in the React demo replays a delegated question through every
stage (working, waiting, resumed, answering, done, follow-up) with a compact or
classic toggle and light/dark themes; `?scenario=follow-up`, `notes`, and `history`
replay messages streamed the way the runtime records them today (identified,
phase-less deltas). `/rolling-steps.html` loops sample commands. Neither needs
model calls. `test/e2e/timeline-exchange-fold.browser.e2e.ts` covers, in the
compact presentation and in Chromium, the answer anchoring, a short answer
followed by a new question, phase-less progress notes, loading older history
inside an exchange, and question navigation.
