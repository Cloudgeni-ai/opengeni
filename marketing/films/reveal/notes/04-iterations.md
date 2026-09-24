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

## v2 — 28.0 s

Inspected: fresh independent video-model cold read + "harshest creative
director" critique (no memory of v1; no audio), stills at every changed
moment, onset-timing measurement of the delivered MP4, colour measurement of
the decoded file.

Technical defects found and fixed (both invisible in stills):

- Remotion's own AAC mux decoded ~39 ms late (un-trimmed encoder priming; the
  audio stream ran 53 ms longer than the picture). Source WAV onsets were on
  time (−3…−5 ms, deliberately anticipatory). → picture is rendered muted and
  muxed with ffmpeg; delivered-file onsets now match the source exactly.
- Untagged colour: the brand orange decoded as [255,96,35] on players that
  assume BT.709 for HD. → explicit BT.709 pipeline; decodes to [244,83,38]
  against the brand's [246,83,39].

Critique triage — what I accepted and what I rejected:

- Rejected as mis-sampled (the model watches sparse frames): "robotic linear
  typing", "blocks move linearly and snap", "toast pops in with a hard cut".
  All three are eased/rhythmic in the source. I still made typing burstier and
  landings longer-tailed, because a stranger scrolling past sees even less.
- Rejected as contrary to the brief: its fixes for the code beat (3D flip,
  glassmorphism code over a blurred UI) are exactly the tilts, ghosted fades
  and overlapping code the client already rejected.
- Accepted (recurring across both reviews): the code beat still reads as a
  slide; the arrows look like PowerPoint; the "App closed" icon looks
  placeholder-grade; the split-screen leaves dead paper; the end card is
  ~3 s of dead air.
- Accepted, real ambiguity: during the tenant→tools handover both bands were
  briefly lit, so Ana's appointment could be read as pointing at `user`.

Changes for v3:

- The code is no longer *beside* her app, it is *under* it: the app page
  slides away and uncovers the handler in place (casting a shadow as it goes).
  The metaphor becomes "behind her app", not "next slide".
- No arrows: each highlight band runs straight into its replica, like a tag.
  Highlights are strictly sequential (one out before the next in).
- "App closed" redesigned: a real-looking app icon with depth and a thin
  progress ring that fills with each muffled note.
- The separate end card is gone. The thesis frame becomes the ending: both
  supers, both pages, and the OpenGeni wordmark + URL building in beneath —
  no dead air, no extra transition. 28.0 → ~26 s.

## v3 — 26.5 s

Inspected: fresh reviewer (cold read + critique), then a calibration question
to that reviewer, a frame-to-frame difference analysis of all 1,590 frames,
and a motion-energy plot against the story cues.

- The reviewer reported hard cuts at 0:04, 0:08, 0:10, 0:14 and 0:22, "no
  shadow" on the slide, a "stark white" background and a "circular" logo —
  all contradicted by the source. Asked directly, it confirmed it samples
  about **1 frame per second** and that any sub-second transition looks like a
  hard cut to it. From here on, video-model reviews are used only for
  comprehension and static composition; motion is judged by frame analysis.
- Frame analysis: no hard cuts anywhere; no static hold over 0.75 s. But three
  genuine single-frame snaps (code tokens switching colour when a highlight
  crossed 50%), and the push into the code was the most violent change in the
  film (2.2× zoom in 0.58 s).
- Motion-energy plot: the capability section and the highlight section were
  the two flattest stretches — the "lecture" feel, now measured.
- Accepted from the review: the tenant chip ("Studio Lena") was the least
  recognisable pairing; only the approval pairing was unmistakable.
- The slide left a sliver of her app cropped at the frame edge during the
  code hold.

## v4 → v5 — 26.0 s

- Code beat keeps the two pairings viewers recognise: the tool lines → Ana's
  moved appointment, `requireApproval` → the Send button. `tenant`/`user` stay
  on screen, unhighlighted.
- Continuous colour envelopes (no snaps); gentler S-curve highlight entrances
  after imaging the pixel difference of the snap frames showed ~40% of a
  five-line change landing in one frame.
- Push-in slowed to 0.85 s; the camera tracks down with the highlights.
- Dotted orange flight paths from each old slot to the new one; stronger lift.
- Her app slides fully out, then returns beside the code for the final frame.
- Compile-time proof of the on-screen code against the repository's SDK source
  (see `03-truth-ledger.md`), with negative controls.
- Drift on the calendar reduced from 1.06× to 1.03× after it cropped the hour
  labels.

## v6 — sound and a fourth cold read

Audio, by measurement (I cannot listen; nothing here certifies how it sounds):

- The typing foley measured as loud as the music (−17.9 LUFS momentary median).
  Keys −5 dB: the opening is now hushed (−22.4) and the score blooms on Enter
  (−17.8); the closed app dips to −22.7 by design.
- The mix was dark for phone speakers (presence 15 dB below total; 6 dB of
  energy under 120 Hz). Gentle master EQ: −2 dB low shelf at 110 Hz, +3 dB
  high shelf at 3.5 kHz, +1.5 dB at 2.5 kHz.
- Mono fold-down −0.5 dB (L/R correlation 0.78): safe on mono phone speakers.

Fourth independent cold read (fresh reviewer, told to judge frames only):
correct on product, audience, actor, clients and "you"; rated the final frame
as making the integration feel "highly approachable". New, valid risk: a
non-programmer might still think OpenGeni is a salon scheduling app, because
the final frame named the brand without saying what it is.

## v7 — final (26.0 s)

- The brand's own positioning line, "AI that works in your product.", returns
  under the wordmark in the final frame, so the sign-off says what OpenGeni is
  and whose product it is for.
- Flight paths softened and shortened; reason pills 13 → 14 px; the Send
  replica holds "Send 6 messages" longer before the press.

Final verification of the delivered file (`scripts/build.sh`, `onsets.py`,
`audio_report.py`, frame-difference analysis, frames decoded from the MP4):

- 26.000 s; 1920×1080; 60 fps; H.264 High; yuv420p; BT.709 tagged; AAC-LC
  48 kHz stereo; audio and video durations identical; full decode clean.
- −16.7 LUFS integrated, LRA 7.9 LU, −1.72 dBTP, zero clipped samples.
- Every measured sound cue lands 4–7 ms before its picture cue, identical in
  the source WAV and the MP4.
- No single-frame snaps; no static hold longer than 0.75 s.

What was not and could not be verified:

- I cannot hear. The score was designed from principles and checked only by
  spectrograms, stem levels, loudness curves and onset timing. A human should
  listen before this is published.
- Every video-model review sampled ~1 frame per second, so no model judged
  motion; motion quality rests on my own frame analysis and stills.
- The salon app and the agent run are dramatized; no live run was recorded.
  The code is real and compiles against the SDK source, but the film does not
  prove production behaviour under load.
