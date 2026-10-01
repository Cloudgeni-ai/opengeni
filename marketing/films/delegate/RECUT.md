# The Last Click — October brand refresh

The October 1 refresh preserves the story, 28.8-second picture timeline, and
original score. The complete film now sits on a continuous off-white,
aqua-lower-left / peach-upper-right light field. The independently branded
`hour` UI remains dark, framed with rounded corners and soft elevation; its
camera beats and human approval are unchanged. The reveal and integration
scenes are rebuilt in the light identity. The ending reads “Give your users
an agent.” and “Your app. Your brand. Your tools.”

Brand provenance: live opengeni.ai HTML/CSS inspected October 1, corroborated by
`Cloudgeni-ai/opengeni-demos` main at
`ffd2ebb6c55dbbad5cd68f9c81704901ce4fbd9b`, especially
`src/videos/web-identity-reveal/Demo.tsx`. The symbol uses the exact live SVG
geometry; the lockup follows the identity film's mixed-case “Opengeni”. Brand
copy uses DM Sans with locally bundled Instrument Serif italic (OFL license
included). Colors are #FBFBF8, #111311, #9FE3D3 and #FFB787. These are separate
from hour's product tokens; the demos repo's legacy generic brand kit is not
used. The pending identity v7 soundtrack is not copied or assumed approved.

Local validation can also use `npm install --package-lock=false --workspaces=false`,
`npm run typecheck`, then `npx --no-install remotion render src/index.ts TheLastClick
out/the-last-click-october-brand.mp4` and `bash scripts/qa.sh
out/the-last-click-october-brand.mp4` when the host Bun cannot read the lockfile.

## Story and integration context

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