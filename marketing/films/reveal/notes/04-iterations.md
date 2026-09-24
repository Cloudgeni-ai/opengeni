# Reveal — iteration log

What was actually inspected at each pass, what was wrong, and what changed.
Scores from reviewers are recorded as signals, not proof of quality.

## v0 — stills only (before any motion render)

Inspected: 21 full-resolution stills across the timeline.

- Logo glyph read as an "H". → lowercase "c" letter mark.
- Grey "booked" blocks were heavy; the calendar felt generic. → lighter,
  borderless bookings so the client blocks and the agent's orange carry the eye.
- Status pill collided with the request text in the field. → shorter status
  copy and an ellipsis on the request once submitted.
- Toast and "App closed" caption far too small for a phone. → ~35% larger.
- Approval card had dead space; camera read it at 1.35×. → tighter card, 1.5×.
- Super sat 36 px from the top edge in the single-page shots. → re-framed.
- The push into the code started the instant the pan ended, so the
  "it fits on one screen" beat never registered. → 0.85 s whole-file hold.
- JetBrains Mono ligatures turned `=>` into an arrow glyph. → ligatures off, so
  the code is character-exact.
- Close-up half-cropped the hour labels at the left edge. → frame starts just
  right of the gutter.

## v1 — first full render (29.0 s)

Inspected: full playback by an independent video model with no brief (cold
stranger read; it cannot hear audio), a 2 fps timestamped contact sheet, the
score's spectrogram, waveform and per-stem levels, ffmpeg EBU R128 meter.

Cold read, verbatim gist: correctly identified "an SDK for embedding
autonomous, background-running AI agents into their own applications",
correctly separated the stylist (the app's user), her clients, and "you" (the
builder). Most memorable: "You can close the app — I'll keep going" and the
badge counting up while closed. Weakest: the code reveal — "a wall of small
text that halts the narrative momentum". Also: preference tags too fast to
read; the close/reopen read as abrupt hard cuts.

My critique on top:

- The code section runs ~7.75 s of reading-heavy frames: it explains instead
  of revealing. Cut to ~5.3 s and make each highlight point at a *picture*
  from the demo, not only words.
- End card holds ~3 s completely static; camera also sits dead still on the
  full calendar for ~5 s.
- Score (analysis only — I cannot listen): sub-bass swells were ~10 dB above
  the piano motif in RMS and dominated the waveform; whooshes were broadband
  columns to 15 kHz. Rebalanced: motif +4 dB, pads −3.6 dB with a 110 Hz
  high-pass, subs −10.5 dB and low-passed, whooshes low-passed at 7.5 kHz.
  Result −16.5 LUFS integrated, −1.8 dBTP, LRA 6.9 LU.

Changes for v2:

- Code cues become small replicas of the demo's own UI next to the line that
  caused them: the "Studio Lena" chip beside `tenant`/`user`, Ana's moved
  appointment beside the tool endpoint, the "Send 6 messages" button (with the
  cursor) beside `requireApproval`. Each still replays its moment's sound.
- Highlights 0.9–0.95 s each; film shortened to 28 s.
- Close morph 0.45 → 0.7 s and reopen 0.55 s, so the page visibly shrinks into
  the app icon instead of cutting.
- Reason tags become orange pills.
- Slow camera drift on the full calendar; a gentle settle on the end card.
