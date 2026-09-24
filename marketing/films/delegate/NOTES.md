# Iteration notes — "The Last Click"

Honest log of what was reviewed, what was wrong, and what changed. Technical
checks (ffprobe, loudness) are the floor, not evidence of quality.

## Round 0 — style frames (stills only)

Reviewed nine stills across the story.

- Credible product: the calendar, cards and approval card read as a real app.
- Wrong: opening frame cropped the "Tomorrow" header and never showed the top
  bar, so the product name "hour" (needed for the later flip) and 11:48 PM were
  never established.
- Wrong: the edit form had an empty band where a message field belonged — the
  "chore" was under-described.
- Wrong: the "reading" scan rendered as a stray green artefact.
- Wrong: flying cards cross-faded card text and block text → ghosted double
  text mid-flight.
- Wrong: the resting cursor was clipped by the frame edge.
- Structural rethink: the agent bar sat in the middle of the grid, so the
  status and the cards were never in one shot. Moved the whole conversation
  into the Tomorrow column: left = tomorrow + talking to the app, right = next
  week where the work lands.

## Round 1 — v1 full render (first motion + first score)

- Snapped story beats to a 75 BPM grid so picture and music lock: Enter on a
  bar, landings on eighth notes, the approval click on the downbeat of bar 5,
  the camera finding "hour" on bar 6, the end line on bar 8.
- First mix was bad and I could see it without hearing it: the synthesized pad
  was ~30 dB hotter than the sampled instruments (music bus −9 dBFS RMS vs piano
  −39), a flat wall of harmonics with no dynamics. Fixed gain staging (every
  stem normalized to the same active RMS, then deliberate relative levels),
  made the pad warmer (1/k^1.6 partials, 4th-order low-pass) and much quieter,
  and automated a dynamic arc: intimate night → lift on Enter → held breath
  under the question → loudest moment on the last click → dark → morning.
- Motion review (2 fps contact sheets + 60 fps strips at transitions):
  - Hook weak: 0.4 s of a tiny static full-UI frame. → Open tighter, in motion.
  - Approval collapse at 16.0–16.3 s was a ghosted cross-fade (two layers at
    half opacity). → Made every panel state change sequential: outgoing content
    leaves with direction, panel resizes, incoming arrives.
  - The flying word "your" disappeared at the moment it should land: it was
    drawn beneath the code card's opaque background. → z-order fix.
  - Leftover top-bar rule sat under the giant wordmark. → Fades with the flight.
  - Code type too small for phones. → 32 → 35 px, annotations 38 → 41 px.

## Round 2 — v2 (reproducible build) and a self-found flaw

- `scripts/build.sh` now does cues → score → render → QA in ~80 s.
- v2 QA floor: decodes, 29.653 s, −15.0 LUFS integrated, −1.3 dB sample peak,
  LRA 14.8 LU (wide; opening may be too soft on phones — open question).
- Frame 0 was black (bad X thumbnail). → 3-frame lift only; frame 0 is the app.
- Self-found: the cursor's lie-down — the central gag — happened off-screen
  while the camera pulled up to the list. → Moved its resting place onto the
  calendar beside the list, inside the list shot while it flops and inside the
  approval close-up when it wakes.
- Sent v2 to two independent video reviewers: one blind (stranger test), one
  informed (craft checklist). Findings are recorded below when received.
