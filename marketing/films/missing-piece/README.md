# The Missing Piece — OpenGeni, 28.8 s

**Concept.** Everyone has asked an app's AI to do something and received a cheerful list of
instructions instead. The film shows that moment inside one travel product — "It knows
exactly what to do. It just can't do it." — then names the missing piece: *an agent inside
your product*. An OpenGeni agent presses into the gap in the product's layout, the same
request flies into it, and this time the product's own actions change the customer's day
(car, hotel, dinner), asking before it spends money. The panel then opens to show the code
behind what we watched, and the film ends where act 2 was, with the opposite truth:
**Your product. Agents inside.**

One product, one customer, one request, one continuous camera take. No narration: X
autoplays muted, so the story is carried by picture and type; the original score adds a
second layer (a three-note phrase that stops one note short of home until the agent docks).

## Deliverable

- 1920×1080, 60 fps, H.264 High / AAC-LC 48 kHz stereo, 28.800 s, −16 LUFS, −1.5 dBTP.
- Produced by `bun run render` → `out/missing-piece.mp4` (not committed; see artifacts).

## What is real and what is illustrated

- The travel product, its data and the customer are an **illustrated scenario** (labelled
  "Illustrative product scenario" on the end frame). No live run is shown or implied.
- The capability is real and current: a product exposes its own actions as an MCP server
  (or a compiled OpenAPI/GraphQL integration); the backend creates a session that names
  those tools; `SessionConversation` renders that session inside the product; the agent's
  tool calls mutate the product's own data, so the product UI updates
  (`examples/northstar-support` is the tested reference for this loop).
- The confirmation ("The car change costs €12. Go ahead?") is shown as a structured question,
  which `SessionConversation` renders; enforced tool approvals use the separately exported
  `ApprovalSurface` and `requireApproval` on the MCP server.
- The code on screen is an exact excerpt of the current SDK
  (`OpenGeniClient.createSession(workspaceId, { initialMessage, mcpServers, tools })`,
  `<SessionConversation sessionId />`), with the comment
  `// after your own sign-in and tenant lookup` stating what it leaves out. No
  "production in N lines" claim is made.

## Preview and render

Requirements: Bun 1.4, Google Chrome/Chromium (`CHROME_PATH`, default
`/usr/local/bin/google-chrome`), ffmpeg, Python 3 with
`numpy scipy soundfile pyloudnorm pillow`.

```bash
cd marketing/films/missing-piece
bun install
bun run preview            # http://127.0.0.1:4700 — space plays, arrows step frames
bun run render             # build → 1728 PNG frames → score → out/missing-piece.mp4
bun run qa                 # format, duration ≤ 30 s, full decode, loudness, clipping, contact sheet
```

Useful pieces on their own:

```bash
bun scripts/render-frames.ts --frames 0s,10.667s,26.667s   # stills → out/stills/
bun scripts/render-frames.ts --every 2 --scale 0.5 --format jpeg --out out/preview   # fast preview frames
bun scripts/render-frames.ts --scale 0.5 --format jpeg --out out/allframes \
  && python3 scripts/pop-check.py out/allframes             # find single-frame visual pops
python3 scripts/audio/compose.py --stems                     # score + stems → out/audio/
python3 scripts/contact-sheet.py out/stills out/review/sheet.png 4 480
```

## How it is built

- Every visual is a pure function of the frame number. `src/main.tsx` exposes
  `window.__setFrame`; `scripts/render-frames.ts` drives headless Chrome through
  puppeteer-core, frame by frame, in parallel tabs. A tiny custom renderer is used instead of
  Remotion to avoid Remotion's company-license requirement for a commercial ad.
- `src/timeline.ts` is the single source of truth: 112.5 BPM (one beat = 32 frames at
  60 fps), every cue in seconds, and `audioCues()` exported to `out/cues.json` so the score
  (`scripts/audio/compose.py`) lands on the same frames as the picture.
- `src/film.tsx` — one continuous camera (log-space zoom), the panel "container transform"
  into the code page. `src/components/` — product window, bolted-on widget, itinerary,
  agent panel, supers, code page, end lockup, wordmark.
- `src/theme.ts` — brand tokens from opengeni.ai (paper `#f4f3ec`, ink `#242423`,
  orange `#f65327`, Archivo / DM Sans / JetBrains Mono). The widget is deliberately off-brand.

To change copy, edit `src/timeline.ts` (messages, widget text) or the component strings; to
retime, move cues in `T` (keep dock/tap/steps/wordmark on beats), then `bun run render`.

## Assets and licences

- Fonts: Archivo, DM Sans, JetBrains Mono, Inter — SIL OFL 1.1 (licences in `assets/fonts/`),
  subset to Latin WOFF2.
- Emoji: three glyph bitmaps from Noto Color Emoji — SIL OFL 1.1 (`assets/emoji/`).
- Icons: lucide-react — ISC.
- Wordmark: the OPENGENI vector from the opengeni.ai site header.
- Sound: 100% synthesised in `scripts/audio/compose.py` (sine, FM and filtered noise); no
  samples or third-party recordings.

See `GOAL.md` for the concept exploration, storyboard and the full review/revision log.
