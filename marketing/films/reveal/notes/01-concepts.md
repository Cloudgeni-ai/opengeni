# Reveal — concept exploration

Territory: **The impossible becomes simple.** A product gains a surprisingly
capable cloud agent; only then is the integration revealed as approachable.
Desire first, ease second.

Audience: anyone building a product with AI (founders, designers, product
teams, AI-assisted builders). Most will watch muted in a feed.

## Concept A — "Sick Day" (chosen)

A hair stylist wakes up sick and types one sentence into her booking app:
*"I'm sick today. Move my clients to next week and let them know."* The app
itself does it — appointments lift out of today and settle into times each
client prefers. She closes the app; the work keeps going. When she reopens it,
everything is moved and six messages wait for her OK. She taps Send.

Then the camera slides to the other side of the screen: the one handler her
app's builder wrote. Punchline: **One sentence for her. One handler for you.**

- Impossible → simple, twice: for the app's user (a booked-out day cleared in
  one sentence) and for the builder (a cloud agent added with one handler).
- Shows an agent *inside* a customer-facing product, acting through the
  product's own data and actions — not a chat window beside it.
- Shows the three things that separate a cloud agent from a chatbot without
  naming them: it acts (moves appointments), it keeps working when the app is
  closed, and it waits for a human before doing something irreversible.
- One app, one task, one state, one continuous camera over one canvas.

## Concept B — "The Feature Nobody Built"

A roadmap card — "Bulk-reschedule when a stylist is sick · Someday" — sits at
the bottom of an endless backlog. A user simply asks the product to do it; the
agent composes the product's existing actions and does it; the card slides
itself to Done. Punchline: "The feature you didn't have to build."

- Sharp builder insight: an agent handles the long tail of requests.
- Rejected: two visual worlds (board + product) break continuity, it needs
  product-team literacy, and "you don't have to build features" overclaims —
  the agent still needs actions to exist.

## Concept C — "Weight"

A monumental slab labelled "an agent inside your product", engraved with what
it takes (remembers, survives restarts, uses your actions, asks before it
spends, keeps customers apart), too big for the frame. It compresses with a
deep sound into a thin tile of code that slides into an app, which lights up.
Punchline: "We carry the weight. You ship the feature."

- Iconic and restrained, great sound opportunity.
- Rejected: capability is asserted by a list of infrastructure words rather
  than demonstrated — exactly the "vague capable agents" failure. No reason for
  a non-developer to want it.

## Concept D — "Night Shift" (sketch)

A shop owner hands off a courier change at midnight and closes the laptop;
lighting shifts to dawn as orders flip over. Rejected: exaggerates duration,
lighting tricks on flat UI feel gimmicky, and approvals at 3 a.m. are odd.

## Why A

A is the only concept where every claim is *demonstrated on screen* before it
is stated, where the ending line is a literal description of what the viewer
just watched, and where a stranger with no idea what OpenGeni is can retell
the film: "Her booking app did her whole sick-day rescheduling by itself, even
with the app closed, and asked before texting anyone. The company that built
the app only had to add one handler from OpenGeni."

## Craft rules for A

- **Vermilion means the agent.** OpenGeni's brand accent (#f65327) appears only
  where the agent acts (in the product), where code enabled that act, and in
  the sign-off. Everything else is ink, paper and the product's own palette.
- **One canvas, one camera.** Her app and the code are two pages on OpenGeni's
  paper canvas. The film is one continuous camera move across it, with one
  deliberate break: the app closing.
- **The work plays the music.** Each appointment that lands plays the next
  note of a motif. While the app is closed, the remaining notes continue,
  muffled, as if heard through a wall. In the reveal, each highlighted line of
  code replays the sound of the moment it caused.
- **Silent-first.** Every idea reads with the sound off (X autoplays muted).
  No narration: no safely available natural voice, and the film does not need
  one.
- **Honest boundaries.** The salon app is fictional and its screens are
  simulated (labelled on screen). The code is the real current SDK surface,
  verified from source (see `03-truth-ledger.md`).

## Stranger-comprehension critique (before building)

| Risk | Mitigation |
| --- | --- |
| Viewer thinks OpenGeni is a salon app | Product brand stays tiny; the pan to code, "One handler for **you**", and the sign-off all address the builder |
| Code unreadable on a phone | The whole file is shown only as proof of size; the camera pushes in on two or three highlighted lines that each map to a moment in the demo |
| "App closed" reads as a glitch or ending | Caption "App closed" plus a pulsing vermilion dot labelled "agent still working", and audible work continuing |
| Approval card too wordy | One sentence, one message preview, one button |
| "One handler" overclaims | The full handler is shown, including auth, tenant/user mapping and the tool endpoint marked "your app's own actions"; the delivery notes list what else a real integration needs |
| Dramatized run passed off as real | Persistent small super: "Fictional app. Simulated screens." |
| Pacing: too slow where nothing happens | Every beat either moves the story or is a deliberate held breath (the closed app); holds only where reading is required |
