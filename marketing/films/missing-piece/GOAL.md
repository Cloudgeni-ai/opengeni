# The Missing Piece — goal, concept and iteration log

Director: Opus 5.5 (independent). Branch: `video/opus55-missing-piece-20260924`.
Territory: *the missing piece* — apps are easy to build now; a capable, production-ready
agent inside the product is the missing capability.

## Goal

Deliver a finished OpenGeni advertisement, at most 30 seconds, H.264 1920x1080, plus
editable, reproducible source in this directory. The film is not done until it has been
built, rendered, reviewed in motion, revised at least twice, and exported.

## Acceptance checklist

- [ ] Product claims and code verified against current source and opengeni.ai
- [ ] At least three substantially different concepts explored; one chosen with rationale
- [ ] A stranger can answer: what is this, why do I want it, why OpenGeni
- [ ] One app, one customer, one request, one state carried through the whole film
- [ ] Customer (end user) and builder (viewer) are never conflated
- [ ] No fabricated live run: the product is an illustrated scenario, labelled as such
- [ ] Code is a short, exact excerpt of the current SDK, causally tied to what was shown
- [ ] No "production in N lines" claim; the excerpt says what it leaves out
- [ ] Legible on a phone feed; safe margins; nothing overlaps; no template tropes
- [ ] Original sound design and music; no narration robot; loudness checked, no clipping
- [ ] Multiple review/revision passes recorded below, each with concrete changes
- [ ] Final MP4 <= 30.0 s, decoded and inspected, saved as an artifact
- [ ] Source committed and pushed; render command documented; no PR, merge or deploy

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

(Filled in as the film is rendered and reviewed.)
