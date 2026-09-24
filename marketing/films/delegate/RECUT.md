# The Last Click — clearer builder reveal

The first 18 seconds retain the original customer story in the fictional booking
app `hour`: Ines asks for appointments to be moved and approves the customer
messages. The recut begins when the app lifts away at 18.4 seconds. It keeps a
still from the *actual previous film frame* in view while naming the two roles:
`hour` is the app; OpenGeni is the agent working inside it. Then it highlights
two selected, real SDK integration surfaces: the protected app-action endpoint
selected as MCP tools, and `SessionConversation` in the app UI. The ending
speaks to the builder, with license and self-hosting as a secondary line.

This is an **illustrative scenario, not a recorded agent run**. The code is an
excerpt: `og`, `workspaceId`, `text`, and `hourTools` must be provided by the
product backend; `hourTools` is an authenticated, tenant-scoped MCP endpoint
implemented by that product. The browser must have an authorized client and
workspace context, such as `OpenGeniProvider`. User authentication, workspace
mapping/onboarding, the actual tool implementation, connected model, error and
approval handling are not supplied by the code shown in the film. An MCP server
definition must be *selected* in `tools` to be model-visible. The end card's
Apache-2.0 and self-hostability claims are verified in the repository's LICENSE,
README and `docs-site/guides/self-host.mdx`.

The original score is embedded as `public/audio/original-score.m4a`, an unaltered
stream copy extracted from the prior 28.84-second final MP4. This recut makes
no new acoustic-quality assertion. Its `audio/compose.py` source remains for
further sound work; `scripts/build.sh` now renders against the supplied score
without requiring the original workstation's SoundFont and fluidsynth.

Run `bun install --frozen-lockfile`, then
`bash scripts/build.sh out/the-last-click-clarity.mp4`. The source remains an
editable Remotion composition; after making timing or sound changes, re-render
and inspect the complete film.