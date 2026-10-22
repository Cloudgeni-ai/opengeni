# Opengeni Simple

An experimental, chat-first Opengeni client for internal use. The sidebar shows
only your agents; everything else lives in Settings.

- **Geni** is the main agent. Every workspace gets one on first visit.
- **One continuous chat per agent.** Ask Geni for a new agent, or press **New
  agent** for a blank chat that shapes itself as you talk.
- **Short by default.** Replies are concise; **Tell me more** on any reply asks
  for the full version.
- **Background work stays out of the way.** Agents hand heavy work to
  subagents; their chats open in a side panel only when you ask.
- **No model picker.** Agents run on the workspace's model (connect ChatGPT
  in Settings > Model) and pick models for their own helpers. One thinking
  setting (Fast, Balanced, Thorough) applies everywhere, with an optional
  per-agent override in the agent's menu.
- **Connections inline.** When an agent needs Slack, GitHub or another service,
  a connect card appears in the chat. Settings > Connections is the fallback.
- **Self-organizing sidebar.** Geni first, then pins, then agents ranked by how
  much and how recently you use them. Agents untouched for two weeks fold into
  **Quiet**.
- **Personal and shared agents** follow Opengeni's own session visibility and
  workspace permissions.
- Every agent gets an AI-painted avatar once a model that can draw is connected.

## How it fits

The browser talks to Opengeni through the public SDK and React packages
(`SessionConversation`, `ConnectPanel`, `SiteList`) over a same-origin `/v1`
proxy. Opengeni owns sessions, permissions and execution; this app has no
authority of its own.

A small Bun companion server (`server/`) keeps app-only state in SQLite
(`data/simple.sqlite`): agent profiles (emoji, description, avatar), sidebar
usage, applied action blocks and preferences. It forwards the caller's cookie
and authorization headers, so Opengeni sees the real person.

Agents act on the app through fenced JSON blocks in their replies:
`geni-agent` creates an agent and `geni-profile` updates the speaker's own
profile. The app applies each block exactly once (keyed by a hash of chat and
content) and shows a card instead. Agent instructions live in
`server/prompts.ts`; bump `INSTRUCTIONS_VERSION` to re-apply them to existing
agents. Per-message app context (other agents, connected services, reply
style) rides on each message as `modelContext`, never in instructions.

## Run

Start the Opengeni stack first (`bun run dev` at the repo root), then:

```bash
cd apps/simple
bun run dev
```

The app is served on port 5190 (bound to `0.0.0.0`) and the companion server on
`127.0.0.1:5191`. Override the Opengeni URLs with `OPENGENI_SIMPLE_API_URL` and
`OPENGENI_SIMPLE_FULL_APP_URL` (adds an "Open full Opengeni" link), and the data directory with
`OPENGENI_SIMPLE_DATA_DIR`.

Before a model is connected the app shows a welcome screen that connects
ChatGPT. To try the UI without one, run the scripted local model and start the
stack with it registered:

```bash
bun scripts/mock-model.ts &
OPENGENI_MODEL_PROVIDERS_JSON="$(bun scripts/mock-model.ts --print-config)" bun run dev  # at the repo root
```

## Check

```bash
bun run typecheck
bun run test
```
