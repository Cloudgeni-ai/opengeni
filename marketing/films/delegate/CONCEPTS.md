# Concepts — territory: "From clicking to delegating"

## What the film must make a stranger understand

1. **What is this?** An agent that lives inside a product and does real work with
   that product's own actions and data, not a chatbot parked beside it.
2. **Why would I want it?** My users could hand off a chore in one sentence and
   stay in control of what matters.
3. **Why OpenGeni?** Adding it is small and credible: my backend creates a cloud
   agent session, points it at my product's actions (MCP), and marks which
   actions need a human yes.

Verified product facts this film leans on (from source, not memory):

- `OpenGeniClient.createSession(workspaceId, { initialMessage, tools, mcpServers })`
  (`packages/sdk`, `examples/northstar-support/src/server.ts`).
- `mcpServers[]` = `{ id, url, headers?, allowedTools?, requireApproval? }`;
  `requireApproval` may list exact tool names; the agent pauses for a human
  decision before those tools run (`packages/contracts/src/index.ts`,
  `docs/session-mcp-servers.md`).
- The session must also select the server in `tools: [{ kind: "mcp", id }]`;
  omitting `tools` falls back to workspace defaults (`packages/core/src/domain/sessions.ts`).
- One organization workspace per customer is the product-integration model
  (`docs/product-integration.md`, `ensureWorkspace`).
- Products may render their own agent UI with the headless session hooks, or
  mount `SessionConversation` (`packages/react`).
- Brand today (opengeni.ai): warm paper, near-black ink, vermilion accent,
  square corners, mono small-caps labels, extended geometric wordmark.

No narration voice is available in this environment (no TTS credential). The
concept therefore has to work with picture, type, music and sound alone. That
also avoids the rejected "continuous AI narration" pattern.

---

## Concept A — "The Last Click"

**Logline.** The mouse cursor has done the clicking in every app for forty
years. Tonight it gets to lie down.

**Story.** 11:48 PM. Ines, a hairstylist, is sick with seven clients booked for
tomorrow in her booking app, *hour*. She opens the first booking; a dense edit
form springs open. She closes it and types one sentence into the app instead:
"I'm sick. Move tomorrow's clients to next week and let them know." The cursor
drifts to the corner and lies down. The app works through its own features:
it reads tomorrow, checks each client's usual time from their booking history,
moves every booking into next week, drafts a note per client. Then it stops and
asks: *Send 7 messages as Ines?* The cursor gets up for one click: Approve.
Tomorrow reads "clear". The wordmark *hour* flips one letter and becomes
*your*. The code behind it is revealed as three causal lines: a session per
customer, your product's actions, and the approval rule that gave her the last
click. End line: "Your product does the work. Your users keep the last click."

**Why it could win.** It literalizes the territory (clicking → delegating) with
the one character everyone on earth recognizes. Human stakes in five seconds.
The approval is not a disclaimer but the climax. The code lines each map to
something the viewer just watched. The ending is a truth that was demonstrated.

**Risks.** Cursor "acting" can turn cartoonish; must be restrained. Seven moves
must stay legible on a phone. Code must be short and read in seconds.

## Concept B — "Leave a Note"

**Logline.** People delegate with sticky notes. Now software can take the note.

**Story.** A freelancer's invoicing app. A handwritten note has been stuck to
the screen edge for weeks: "Chase everyone who owes me money — be nice to
Luca." The handwriting lifts off the paper and becomes the request inside the
app. The app finds six overdue invoices, tailors a reminder to each client's
history, and asks before adding a late fee. The note curls and falls away.
Line: "Delegation used to need a person. Now it's a feature."

**Strengths.** Strong human metaphor for delegation; strong builder line.
**Weaknesses.** Paper and handwriting effects drift toward kitsch; an invoice
list is visually flat; the payoff is transactional; the "operating" half of the
territory is only implied.

## Concept C — "Close the Lid"

**Logline.** Cloud agents keep working after you close the laptop.

**Story.** 6 PM in a small shop's operations app. The owner delegates a long job
("Fix all 214 failed payments and email each customer a new link"), then
closes the lid: the classic moment where work stops. In the dark, a single line
of progress keeps moving; a server restart blinks and it resumes at the same
step. Morning: done, one refund waiting for her approval. Line: "Close the lid.
Your product keeps going."

**Strengths.** Dramatizes the real durability story (sessions that survive
restarts, long runs, approvals) — the strongest "why OpenGeni" of the three.
**Weaknesses.** Most of the film happens in darkness, away from the product;
the delegation *inside* the product is barely visible; it risks reading as an
infrastructure ad; time-lapse abstraction is weaker proof than a watched task.

---

## Decision: Concept A, "The Last Click"

A is the only concept where the viewer *watches* the shift happen inside one
product, end to end, with a meaningful outcome and a human payoff. B's line is
good but its demonstration is flat. C has the best platform truth but hides
the product. A absorbs C's best idea (the agent keeps the human in control of
consequential actions) as its climax, and its code reveal is causal rather than
appended: the approval line in the code *is* the last click.

Two deliberate choices:

- **The app is fictional and designed, not recorded.** It is presented as an
  illustrative product ("hour" becomes "your"); no live run is claimed. The
  code on screen is the real SDK call; fine print states it is an excerpt.
- **No voice.** Music, sound design and type carry it. The first sound is a
  click and the last beat is a click: a structural rhyme.

## Internal storyboard (target timings, 60 fps)

| # | Time | Picture | Sound |
|---|------|---------|-------|
| 1 | 0.0–2.3 | Night. *hour* calendar: left column "Tomorrow · 7 bookings", right grid is next week. Cursor clicks Ben's 9:00; a dense "Edit booking" form springs open. Cursor hesitates. | Dry click. Room tone. One low piano note. |
| 2 | 2.3–3.0 | Cursor hits Cancel; form collapses. | Click. |
| 3 | 3.0–6.6 | Cursor clicks "Ask hour…". Camera pushes in. The sentence types at readable speed. Enter. | Soft keys. Pad breathes in. |
| 4 | 6.6–8.0 | Camera eases wide. Cursor drifts to the corner and lies down. Agent status begins. | Soft settle. Pulse begins. |
| 5 | 8.0–13.4 | Bookings lift off tomorrow and glide into next week's gaps, one by one, each tagged with its reason ("his usual"). Status: found 7 → checked usual times → moved 7 → drafted 7. | Each landing is a mallet note; an arpeggio builds. |
| 6 | 13.4–17.0 | Approval card: "Send 7 messages as Ines?" with one real preview and the `send_messages` tag. Cursor sits up, glides to Approve. Click. | Music suspends. The click lands on a downbeat; chord blooms. |
| 7 | 17.0–19.4 | Sent marks ripple across the moved bookings. "Tomorrow — clear." Cursor lies back down. | Seven quick notes resolve. |
| 8 | 19.4–21.6 | Camera flies to the wordmark; the *h* flips to *y*: "your". | Split-flap tick. |
| 9 | 21.6–26.4 | Paper-light brand world. Code card (server.ts). Three highlights, each with a short label: session per customer · your product's actions · your user says yes. | Warm, steady. |
| 10 | 26.4–30.0 | "Your product does the work. / Your users keep the last click." Wordmark, opengeni.ai, fine print. | Resolve; final click. |

## Stranger-comprehension self-critique (before building)

Simulated viewer with zero OpenGeni knowledge, sound off (X autoplays muted):

- 0–3 s: "Dark calendar, someone opens an appointment form and gives up." OK,
  but not yet arresting. → Open *in motion* (the form springing) and make the
  seven-booking burden visible in the first frame.
- 3–7 s: The typed sentence explains the stakes in the user's own words. Must
  be large enough to read on a phone; hold it after Enter.
- 7–13 s: "The app moves the appointments by itself." The reason chips
  ("his usual") are what prove it used the product's data. They must be
  readable in the wide shot or the camera must move closer.
- 13–17 s: "It asks before messaging people." The preview message must be real
  and short. The single click is the climax: give it room.
- 19–22 s: The flip risks being missed. Hold it, and follow with copy that does
  not depend on noticing the pun.
- 22–26 s: Non-developers read shape, not syntax: keep it to one short card and
  three labels. Developers must find it correct: real field names, required
  `tools` line included, auth header shown, per-customer workspace id.
- The word "agent" never appears in the story. Name the category once at the
  end so builders know what they are looking at.
- Confusion risk: "Is OpenGeni a booking app?" The flip + "your product" copy +
  fine print ("hour is a fictional app") answers it.
