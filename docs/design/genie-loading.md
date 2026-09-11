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
