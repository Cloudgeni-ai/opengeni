# Right here — editable film source

New composition: `InsideYourProduct`, 48 seconds, 1920×1080, 30 fps.
The existing `TheLastClick` composition and its audio remain unchanged.

The first frame establishes the category: **Agents. Inside your product.**
Three separately branded illustrative applications then demonstrate the idea:
hour (bookings), thread (commerce), and folio (project work). OpenGeni remains
the infrastructure brand, not the fictional booking product. The closing uses
the approved “Give your users an agent.” / “Your app. Your brand. Your tools.”

## Reproduce without API access or additional spend

Prerequisites: Node.js 20.11+ and FFmpeg/ffprobe available on PATH.

```sh
npm ci
npm run typecheck
node scripts/mix-demo-audio.mjs
node scripts/qa-inside-product.mjs
npx remotion render src/index.ts InsideYourProduct out/inside-your-product.mp4
node scripts/qa-inside-product.mjs out/inside-your-product.mp4
```

The supplied MP3 stems are the retained ElevenLabs outputs. Rendering and
mixing do not call ElevenLabs. `mix.wav` is derived locally, not another
generation. Do not use the legacy `qa.sh` for this composition: its deliberate
30-second ceiling belongs to The Last Click.

## Audio and spend

Read-only models and voices checks confirmed `eleven_v4` and
`eleven_v4_turbo` on October 2, 2026. The provider guide identifies the v4
Text to Dialogue endpoint; MCP model guide/schema access was also confirmed
after the staging rollout. Narration uses Roger; illustrative customer lines
use Sarah, Chris and Alice. Six v4 clips were generated once each. One original
48-second instrumental was generated with `music_v2_5`. No voice cloning,
celebrity imitation, public posting or subscriptions were involved.

The manifest has a $22 conservative request reserve inside the authorized
$50 total ceiling. This is **not** an invoice or claimed actual spend. Speech
receipts total 50 provider `character-cost` units. The music response returns
song ID `BU11jQO0RhYon4DrrzdI`, but no monetary cost. The scoped API key lacks
`user_read`, so account billing could not be verified. No further generations
are needed to reproduce this film.

`scripts/generate-demo-audio.mjs` is an explicit, one-job generation helper.
It refuses an existing receipt to prevent duplicate paid requests after an
interrupted tool result. It accepts a key only through `ELEVEN_DEMO_KEY` in
process memory, passing it to curl through stdin. Never put a key in source,
the manifest, an archive, or an output log. The helper does not retry POSTs.

## Timeline and provenance

`src/inside-product-timeline.json` owns voice start times and scene boundaries.
Generated voice durations are measured, not guessed. The SRT captions use
approximate sentence timing within those durations; they are not word-aligned.
The mix includes local approval tones, speech-keyed music ducking, and final
loudness normalization. Media QA verifies full decode, 48-second duration,
voice non-overlap, stereo 48 kHz audio, format and true-peak headroom.

The visuals are authored illustrative product interactions, not live OpenGeni
recordings or proof that any named third-party service executed. App data and
brands are fictional. The spoken requests are voiceover, not a claim that
every embedded interface includes voice input. Each protected action includes
an illustrated approval before completion. Newly created project tasks stay
“To do”, not falsely completed.

Brand: exact previously verified October mark, DM Sans, Instrument Serif,
paper/mint/peach field. Font licenses are retained under `public/fonts`.
No auditory human-review claim is made by the automated media checks.