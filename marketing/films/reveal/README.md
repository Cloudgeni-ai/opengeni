# Reveal — a 26-second OpenGeni film

**One sentence for her. One handler for you.**

A hair stylist wakes up sick and types one sentence into her booking app. The
app itself does the work: it moves six appointments to times each client
prefers, keeps going after she closes the app, and waits for her OK before
messaging anyone. Then her app slides away to uncover what was underneath it:
the one handler her app's builder wrote with OpenGeni.

Territory: *the impossible becomes simple* — a product gains a surprisingly
capable cloud agent, and only then is the integration revealed as approachable.

- 1920×1080, 60 fps, H.264 High, BT.709, AAC-LC 48 kHz stereo, 26.0 s.
- No narration. Every idea reads with the sound off; the original synthesized
  score (no samples, no third-party music) plays the agent's work as a motif.
- The salon app is fictional and its screens are simulated (labelled on
  screen). The code is the real current SDK surface, compiled against this
  repository's SDK source. See `notes/03-truth-ledger.md`.

## Build

Requirements: Bun (the repository's pinned version), Python 3 with pip,
ffmpeg with libx264. Remotion downloads its own headless Chrome on first run.

```bash
cd marketing/films/reveal
bun install
bash scripts/build.sh out/reveal.mp4
```

`scripts/build.sh` exports the shared timeline to `audio/cues.json`,
synthesizes `public/audio/score.wav` (scipy is installed into `.pydeps/` on
first run), renders the picture muted in BT.709, muxes the audio with ffmpeg,
and runs `scripts/verify.sh` (streams, full decode, EBU R128 loudness, duration).

Other checks:

```bash
bun run check:snippet                                            # on-screen code vs the SDK
PYTHONPATH=.pydeps python3 scripts/onsets.py out/reveal.mp4      # sound vs picture sync
PYTHONPATH=.pydeps python3 scripts/audio_report.py out/reveal.mp4
node scripts/stills.mjs 420 1165                                 # review frames
bun run studio                                                   # interactive preview
```

## Source map

| Path | What it holds |
| --- | --- |
| `src/timeline.ts` | Every cue in seconds, including the typing rhythm. The single source of truth for picture and sound |
| `src/camera.ts` | The one continuous camera over the canvas |
| `src/scenes/AppPage.tsx` | The fictional booking app, the agent's moves, the closed-app moment, the approval |
| `src/scenes/CodePage.tsx` | The handler, its two highlights and their replica cues |
| `src/data/code.ts` | The exact on-screen code |
| `src/scenes/Supers.tsx`, `EndCard.tsx` | Punchline lines, wordmark (the live site's path) |
| `audio/score.py` | The synthesized score and sound design |
| `notes/` | Concepts, storyboard, truth ledger, iteration log |
