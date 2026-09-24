# The Missing Piece — goal, concept and iteration log

Director: Opus 5.5 (independent). Branch: `video/opus55-missing-piece-20260924`.
Territory: *the missing piece* — apps are easy to build now; a capable, production-ready
agent inside the product is the missing capability.

## Goal

Deliver a finished OpenGeni advertisement, at most 30 seconds, H.264 1920x1080, plus
editable, reproducible source in this directory. The film is not done until it has been
built, rendered, reviewed in motion, revised at least twice, and exported.

## Acceptance checklist

- [x] Product claims and code verified against current source and opengeni.ai
- [x] At least three substantially different concepts explored; one chosen with rationale
- [x] A stranger can answer: what is this, why do I want it, why OpenGeni
- [x] One app, one customer, one request, one state carried through the whole film
- [x] Customer (end user) and builder (viewer) are never conflated
- [x] No fabricated live run: the product is an illustrated scenario, labelled as such
- [x] Code is a short, exact excerpt of the current SDK, causally tied to what was shown
- [x] No "production in N lines" claim; the excerpt says what it leaves out
- [x] Safe margins, nothing overlaps; phone legibility for the key lines (see limits)
- [x] Original sound design and music; no narration robot; loudness checked, no clipping
- [x] Multiple review/revision passes recorded below, each with concrete changes
- [x] Final MP4 <= 30.0 s, decoded and inspected, saved as an artifact
- [x] Source committed and pushed; render command documented; no PR, merge or deploy

## Research notes (what is true, with sources)

- opengeni.ai positions the product as "AI that works in your product and for your team";
  `/developers` says "Your product. Agents inside." and "Opengeni handles sessions, tools,
  sandboxes and approvals underneath." Brand: paper `#f4f3ec`, ink `#242423`,
  signal orange `#f65327`, hairlines `#d5d5ca`; Archivo headings, DM Sans body,
  JetBrains Mono micro-labels; square corners, 1 px ink borders, hard offset shadows,
  agent steps as mono lines with dot bullets (site hero mock). Wordmark vector taken from
  the site header.
- A product exposes its own actions to the agent as an MCP server (or a compiled
  OpenAPI/GraphQL integration). `docs/product-integration.md`: "The SDK cannot turn
  arbitrary in-process customer backend functions into remote tools."
- Session creation with product tools, exactly as the tested Northstar example does it
  (`examples/northstar-support/src/server.ts`): `createSession(workspaceId, { initialMessage,
  tools: [{ kind: "mcp", id }], mcpServers: [{ id, url, allowedTools, headers, ... }] })`.
  `tools` must reference the session server; `mcpServers` alone is not enough.
- `SessionConversation` (`packages/react/src/components/session-conversation.tsx`) renders
  an existing session: timeline, tool activity, structured human-input questions, queue and
  composer. It must sit inside an `OpenGeniProvider` (or receive `client`/`workspaceId`).
  Tool *approvals* use the separately exported `ApprovalSurface`; so the confirmation shown
  in the film is a structured question from the agent, which `SessionConversation` renders.
- Northstar pattern: MCP tools mutate the same product data the human UI uses, and product
  SSE updates the product UI while OpenGeni SSE updates the agent timeline. That is why the
  film may show the product's own rows changing as the agent works.
- No voice-synthesis credential exists in this environment. The film is therefore designed
  narration-free and sound-off first (X autoplays muted); sound adds, never carries.

## Concepts explored

**A. "It knows exactly what to do" (outside / inside).** One travel product. A customer
asks the product's bolted-on AI widget to fix their day after a flight delay. The widget
replies with a cheerful do-it-yourself list that points at buttons sitting right there in
the product. "It knows exactly what to do. It just can't do it." The widget pops; the
product's layout opens a slot — the missing piece — and an agent docks *inside* the
product. The same request, again: the agent uses the product's own actions, the itinerary
visibly re-flows, it asks before spending money, done. Then the source of what we just
watched: one `createSession` call handing over the product's actions, one component.
"Your product. Agents inside."

**B. "Everything but" (launch checklist).** A builder's launch list ticks itself off at
speed — sign-in, payments, dashboard, dark mode — until the last line: "Let customers hand
work to it", checkbox empty. OpenGeni ticks it. Rejected: checklist montage is a known
device, the benefit is *told* (a checkbox) rather than *shown*, and explaining why the
last item is hard drifts into the architecture explainer the brief forbids.

**C. "Words → work" (kinetic typography).** A customer's sentence physically travels. In
an ordinary chatbot, words produce more words — a balloon of text. With OpenGeni the
words break apart and become product actions. Beautiful, but abstract: a stranger would
not learn whose product, which user, or what OpenGeni is. Risk of a motion reel.

**D. "Your AI forwards it to you" (founder inbox).** Split screen: your customer asks
your chatbot; it escalates; tickets pile into *your* inbox at 1 a.m. With OpenGeni, the
product does it and your inbox stays at zero. Very true for founders, but two surfaces and
two protagonists, it centres cost savings over capability, and it risks exactly the
operator/customer conflation the brief warns about.

**E. "Shape sorter" (metaphor gag).** A round chat bubble keeps failing to fit a square
slot in the product; the OpenGeni piece fits. Funny for two seconds, proves nothing.

**Chosen: A.** It is the only concept where the missing piece is both the insight and the
demonstration, inside one continuous product state. Recognition is instant (everyone has
received the useless do-it-yourself answer), the turn names the gap in plain words, the
proof is a visible, multi-step, meaningful outcome inside the product, and the ending
line is the brand's own positioning — earned because the film just showed "inside"
versus "beside". From C it keeps the idea that the words must turn into work; from E the
design joke that the generic widget does not *fit* the product's design language while
the agent inside does.

## Rationale for key choices

- **Travel delay.** Universal stress, a stranger understands it instantly, and fixing it
  takes several real product actions (car pickup, hotel, dinner) — a meaningful outcome,
  not a toggle. The flight row already shows "Delayed", so the request is natural.
- **"YOUR PRODUCT" chip, no invented brand.** The viewer is the builder. The product is
  shown in the same editorial window grammar the website uses for "your product".
- **Customer vs builder.** Only the customer ever acts on screen. The builder is the
  viewer, addressed by the supers ("your product").
- **Honesty.** The product is an illustrated scenario (end card says so). The confirmation
  is a structured question, which `SessionConversation` actually renders. Code is an exact
  excerpt; a footnote says auth, tenant mapping and the action endpoint are not shown.
- **Sound.** A three-note phrase that keeps stopping one note short of home
  (A–B–C#…) while the widget fails. The missing note (D) lands exactly when the agent
  docks, and the groove begins. Every agent action is a tactile tick on the beat.

## Internal storyboard (v1 plan, one continuous camera)

| Time | Picture | Words on screen | Sound |
| --- | --- | --- | --- |
| 0.0–2.1 | Tight on a generic purple AI widget over the product. The customer's message is already being typed. | "Our flight lands 3 hours late. Can you fix the rest of today?" | Key ticks. Motif A–B–C#, rest. |
| 2.1–5.6 | Send. Camera pulls back to reveal the product. The widget streams a do-it-yourself list; its steps name buttons visible in the rows. | "So sorry about the delay! Here's how to update each booking yourself: 1. … 7." "Hope this helps!" | Chat blips. Motif, rest. |
| 5.6–8.4 | Window slides right; supers on paper. | "It knows exactly what to do." / "It just can't do it." | Motif stalls; the C# hangs. |
| 8.4–10.8 | Widget pops. The layout opens a dashed slot inside the product. | "THE MISSING PIECE" / "An agent inside your product." | Last unresolved phrase. Silence on the missing beat. |
| 10.8 | Agent panel docks into the slot. Header: agent · OPENGENI. | — | The missing D lands. Groove starts. |
| 10.8–19.5 | Same request. Agent steps on the beat; itinerary rows re-time; it asks before a €12 fee; customer taps yes; all set; customer's 🙏. | Mono step lines; question card; "All set. Your evening still works." | Ticks on beats; suspension on the question; release. |
| 19.5–24.5 | Scanline: the product turns into its source. | Excerpt: `createSession(..., { initialMessage, mcpServers: [tripActions], tools: [...] })` and `<SessionConversation sessionId={session.id} />`, labelled "YOUR SERVER" / "YOUR UI". | Groove thins. |
| 24.5–28.5 | End card. | "Your product. / Agents inside." OPENGENI · opengeni.ai | Motif completes on the tonic. Tail. |

## Pre-build self-critique (stranger comprehension)

- *First frame is an empty input* — weak hook. Start with the message already half typed.
- *On a phone, the widget's list is too small to read* — the supers must carry the joke;
  the list's job is shape (a wall of instructions) and the visible buttons it names.
- *Brand could arrive too late* — show OPENGENI in the docked panel header at the turn.
- *Too much text before the proof* — the supers must be short and separated in time;
  nothing else competes while a super is on screen.
- *Code may lose non-developers* — keep it to one short excerpt with plain-word labels and
  the three tool names the viewer just watched being used; under five seconds.
- *Camera fatigue* — a single take with few, slow, eased moves; no whip-pans.

## Iteration log

Reviews came from three sources: my own frame-by-frame inspection (stills, dense contact
sheets, 60 fps frame sequences, frames extracted from the delivered file), an objective pop
detector (`scripts/pop-check.py`), and seven independent full-motion reviews by a video model. The video model proved unreliable in two
specific ways, so its claims were verified against frames before acting: it cannot hear the
audio (one review invented a "drum fill"; later ones said plainly they cannot perceive audio),
and it samples too sparsely to see 0.2–0.5 s animations (it repeatedly called measured
multi-frame animations "hard cuts", and described a "3D flip" that does not exist).

**v0 — first stills.** Structure worked; the hook was weak (empty widget, tiny typed line),
the leader line in the code crossed `"mcp"`, JetBrains Mono fused `/>` into a ligature, the
orphaned request bubble was oversized. Fixed: macro opening on the typed line, ligatures off,
no leader line, tighter bubble.

**v1 — first motion (29.4 s).** Reviews: 6 s of failure before the point lands; the push-in
to the question card hid the itinerary as it updated; the orange scanline read as a template
wipe; the page scroll clipped code off the top edge; code too small for phones; dashed
"missing piece" box read as a wireframe; the request bubble snapped colour. Objective audio
analysis: sub-bass roots down to 49 Hz eating headroom; loudnorm silently fell back to dynamic
compression because true peak would have exceeded target.

**v2 (27.7 s).** Retimed on a 112.5 BPM grid (32 frames per beat); opening shortened to six
list items; one steady framing for the whole proof (no push-ins); the code moved *inside the
agent panel* via a container transform (the panel's conversation area opens to fill the frame)
instead of a wipe; code enlarged to 56 px and revealed in two steps (the one component that
renders the panel, then the server call); a new ending that rhymes with act 2 — same
composition, product in its final state beside "Your product. Agents inside."; widget
suggestion chips added (every canned prompt asks for information, none for an action); score
retimed with an A pedal so the dock resolves melody and harmony; true-peak limiter in
Python mastering to −16 LUFS / −1.6 dBTP.

**v3 (28.8 s).** Review: the widget-pop-to-dock stretch felt slow and the dashed slot cheap;
the panel drop looked like a stock animation; the code page still felt like leaving the
product. Changes: the missing piece became a *hole cut in the product* (paper showing through,
inner shadow); the agent panel appears lifted above it and presses home on the downbeat; the
request arcs into the panel; the opened code page keeps the panel's "Agent · OPENGENI" header;
non-essential code dimmed so the eye goes to `mcpServers: [tripActions]` and
`<SessionConversation … />`; two more beats of code.

**v4.** Verified at 60 fps: the request morph really did snap (colour and shape flipped in
~3 frames because they rode the eased flight curve), and the widget jumped at send (chips
vanished instantly; the streamed reply grew a line at a time). The v1 review's still-valid
notes: the question card had ~1 s before the click, the pointer moved robotically, steps and
rows changed at the same instant, panel padding was tight, footnotes sat near the frame edge,
the widget looked cheap. Changes: widget restyled as a polished, contemporary but generic
assistant (its behaviour is the joke, not bad craft); chips collapse, dots grow into the reply,
streamed text reserves its final height; the morph runs on its own ~0.45 s clock with a
lateral bow that avoids the panel header; the question holds 1.6 s; a curved, decelerating
pointer with hover state; each row now updates after its panel step; the unreadable
"excerpt" footnote replaced by a real code comment `// after your own sign-in and tenant
lookup`; highlighter boxes instead of an underline that read like a spell-check error; the
action chips replay with checks in the order the agent used them, on the same four notes
as its steps; proof reframed to 1.08× for title-safe margins.

**v5.** Review: attention still ping-ponged between panel and itinerary; the hole looked flat
at preview size; the disclaimer looked like an afterthought; small lulls around the pop and
the fold-back. Changes: attention routing — tag lights at the row end beside the panel, an
orange wash sweeps leftward, the time rolls as the wash arrives; the sent bubble rises out of
the input; deeper hole with ink edges; disclaimer as a figure caption under the product; end
lockup aligned to the product window's top and bottom; lulls tightened.

**Objective passes on v5.** The pop detector found four genuine one-frame jumps that no
reviewer had located precisely: the input box growing when text wrapped (0.57 s), the lifted
panel's reveal (10.1 s), the question card's entrance (12.3 s), and — largest — the opened
panel overlay covering a conversation still mid-fade (18.5 s). All fixed; the remaining
flags are the velocity peaks of deliberate multi-frame moves. A renderer bug was also
found and fixed (a stalled Chrome tab silently truncated a render to 898/1728 frames:
`--disable-dev-shm-usage`, per-tab readiness retries and a completeness assertion). Audio
spectrum analysis showed 56% of energy below 120 Hz and ~2% at 2–6 kHz — a dark mix that
would vanish on phone speakers — rebalanced to ~29% below 120 Hz with more presence while
keeping −16.0 LUFS. Encoded master measured against source PNGs: SSIM ≥ 0.99; the residual
is 4:2:0 chroma on orange text, not compression (lower CRF did not change it).

**v6 — recovery pass (fresh eyes on the finished v5 master).** Three things still weakened it:
(1) the first frame was not a feed-stopping hook — the typed request was ~44 px; (2) about
0.6 s of near-empty frame at 19.2–19.8 s while the opened panel waited for its first code
line, and a similar gap as the code left; (3) the payoff lived only in the agent's panel —
the product itself never said the day was fixed. Changes: a 2.9× macro so the request reads
at headline size (~58 px) in frame one, framed so the whole greeting bubble stays inside;
the code page now renders *inside* the opening panel, clipped by it, so the panel's moving
edge reveals the first line and later carries the code away while the itinerary is
uncovered (near-empty time: from ~0.3–0.6 s to 3 frames mid-reveal, measured); and the
product's own header rolls to an orange "✓ Replanned around your delay" on "All set",
so the final frame shows the outcome in the product next to "Your product. Agents inside."
The v6 video review claimed a 0.4 s blank at 18.9 s, a hard cut at 24.3 s and a cropped
greeting bubble; frames extracted from the delivered MP4 contradict all three (the panel
edge is visibly sweeping at 19.05–19.3 s and 24.25–24.55 s; the bubble's top edge sits
47 px inside the frame), so they were not acted on. Its fourth note describes the
deliberate masked line reveal of the supers.

## Final storyboard (as built, 28.8 s)

| Time | Picture | Sound |
| --- | --- | --- |
| 0–1.6 | Macro (2.9×): the request, at headline size, typed into the product's AI widget; suggestion chips all ask for information. | Key ticks; A–B–C♯, rest. |
| 1.6–4.7 | Reply: "Here's how to update each booking yourself" + 6 steps + "Hope this helps!"; camera reveals the links it names. | Chat blips; phrase again, unresolved. |
| 4.7–8.1 | Product slides right. "It knows exactly what to do." / "It just can't do it." | Phrase; then silence under the second line. |
| 8.5–10.1 | Widget pops; request left floating; the product's empty side becomes a hole: "THE MISSING PIECE / An agent inside your product." | Pop; riser; the phrase once more. |
| 10.13–10.67 | Agent panel appears lifted over the hole. | The missing beat: near-silence. |
| 10.67 | Panel presses home; request morphs into it. | Latch + low thump; the missing D lands; groove starts. |
| 11.7–18.4 | Agent checks the flight, asks about the €12 fee, customer clicks yes; car / hotel / dinner rows update after each step, "By agent"; "All set. Your evening still works." and the product's own header: "✓ Replanned around your delay"; 🙏. | Ticks on beats; B minor under the question, G on the click; home to D on "All set". |
| 18.5–24.7 | Conversation clears; the panel opens (header stays) and the first line rises as it opens: `<SessionConversation … />`, then the `createSession` excerpt with the comment naming what is left out; the four actions light up in order; the panel folds back carrying the code away. | Lighter groove; the chips echo the steps' four notes. |
| 24.7–28.8 | Product slides right as in act 2; "Your product. Agents inside."; wordmark lands; opengeni.ai; caption. | ii–V–I; the phrase completes, D with the wordmark. |

## Honest limits

- I cannot listen. Sound was judged by design intent, spectrum, loudness curves, section RMS,
  peak/clipping checks and sync against cues — not by ear. A human listen is still required;
  the most subjective risks are the celesta timbre and the synthesized drum feel.
- Bland v3 Matthew (or any voice) was not available in this environment; the film was
  designed narration-free rather than substitute a robotic voice. No VO version exists.
- The video-model reviewers could not perceive audio and under-sampled short animations;
  their final approval is not proof of quality. The objective checks above are the evidence.
- Phone-feed legibility: the supers, slot line and end lockup are large; product UI detail
  (itinerary sub-lines, widget list, code) is designed for desktop/fullscreen viewing. The
  big times, tags and highlights carry the proof at phone size.
- The product is illustrative. OpenGeni's security, tenancy and scale behaviour are not
  demonstrated by this film.
