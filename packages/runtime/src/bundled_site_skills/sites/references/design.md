# Design a new app

Read this before writing markup for a new app, single-file apps included, and
before a restyle someone asked for. A small edit keeps the app's look.

"Look" in SKILL.md decides which look the app takes; this file is how to make
it good. A design the person or the workspace gave you wins over anything
here, and an installed design Skill such as `frontend-design` adds to it.

## Decide before writing markup

A minute of thought, no document:

1. **What they come for.** Name the one thing a visitor does or learns (log
   today's reading, find the overdue invoices, decide whether to come). It
   gets the first screen, the most space and the strongest contrast. The rest
   is quieter or left out.
2. **Tool or page.** A tool is worked in again and again (tracker, dashboard,
   admin, form, portal): dense, calm, quick to scan. A page is read or shown
   to others (landing page, invitation, menu, recipes, portfolio): roomy, with
   a voice of its own. Don't give a tool a hero and slogans, or a page a grid
   of cards and stats.
3. **One strong choice.** Spend the boldness in one place (the type, one
   color, the layout of the main view) and keep everything around it plain.

## Tools in the Opengeni look

- **Frame.** `og-page` (`og-page-wide` for tables and boards). One header
  row: `og-title`, the main action on the right, and a muted line only when
  the title does not explain the app. One `og-button-primary` per view; other
  actions are plain or `og-button-ghost`.
- **Lead with the working surface**: the table, list, board or form, set
  straight on the page. Summary numbers earn a place only when someone acts
  on them, and then say what they compare to (a target, the last period).
- **Show the data's shape.** This is where a tool stops looking generic. A
  stage is its place in a row of steps, a date is how far away it is ("in 9
  days", "3 days late"), an amount is a bar or a figure, a person is initials
  beside a name, a share is a filled track. A few fixed choices to filter by
  (stage, owner, status) are tabs with their counts, not a dropdown. A table
  of plain strings is the fallback.
- **Cards group what belongs together.** Not every section, not the main
  table, never a card in a card. Separate with space and a `--og-border`
  line first.
- **Tables.** Text and dates left; amounts and counts right with
  `font-variant-numeric: tabular-nums`. One line per row (truncate, full value
  in `title`), the row's name strong and the rest regular or muted, hover
  `--og-surface-2`, the whole row opens the item. On a phone, stack each row
  into a block or scroll the table sideways in its own wrapper; never shrink
  the text.
- **Color carries meaning.** The look is neutral on purpose. Use
  `og-badge-success`, `-warning`, `-danger` and the matching tokens only for
  done or healthy, needs attention, and late or broken. An ordinary stage or
  category stays neutral. A product accent goes on the main action, the
  active tab and links, not on backgrounds.
- **Past the kit, build from tokens** so light and dark both work: space in
  steps of 4, 8, 12, 16, 24, 32, 48px, the same gap between the same kinds of
  thing; `--og-radius` on controls and `--og-radius-card` on containers; 1px
  `--og-border`; shadow only on what floats (menu, dialog, toast). Also
  available: `og-stack`, `og-row`, `og-label`, `og-subtle`, `og-mono`,
  `og-link`, `og-button-danger`, `--og-surface-2`, `--og-fg-subtle`,
  `--og-focus`.
- **Icons** are inline SVG from one family, 16 or 20px, `currentColor`, 1.5px
  stroke. No emoji as icons.

## Pages with a design of their own

- **Start from the subject**: its materials, place, period and words. A
  bakery menu, a climbing-club sign-up and a quarterly review should not look
  related.
- **Palette.** One background, one ink, one muted ink, one accent, one line
  color, as CSS custom properties. Tint the neutrals toward the accent
  instead of pure gray, and keep text at 4.5:1 contrast or better. Define
  both `prefers-color-scheme` values, or commit to one scheme and set
  `color-scheme` on `:root`.
- **Type.** Nothing may load from a font or CSS CDN, so pick a system stack
  on purpose (a full app may ship one or two font files through its build):

  ```css
  --serif-old: "Iowan Old Style", "Palatino Linotype", Palatino, P052, serif;
  --serif: Charter, "Bitstream Charter", "Sitka Text", Cambria, serif;
  --sans-humanist: Seravek, "Gill Sans Nova", Ubuntu, Calibri, sans-serif;
  --sans-geometric: Avenir, Montserrat, Corbel, "URW Gothic", sans-serif;
  --rounded: ui-rounded, Quicksand, "Arial Rounded MT Bold", sans-serif;
  --mono: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
  ```

  One family, or two that clearly differ (display and text). Make the scale
  jump (for example 1rem, 1.25rem, 1.75rem, then `clamp(2.5rem, 6vw, 4rem)`),
  with tighter line height and slight negative tracking on the large sizes.
  Prefer weight contrast to more sizes.
- **Layout.** A grid with one clear left edge. Left-align; center only a
  short invitation or title. Let one element be large and leave space around
  it. Vary the sections instead of repeating one band down the page.
- **Images.** Photos the person supplied; otherwise type, inline SVG
  drawing, pattern or fields of color. No placeholder stock imagery, no
  invented logos.
- **Motion.** At most one considered moment on load, plus 120 to 200ms
  feedback on actions. Honor `prefers-reduced-motion`.

## Every app

- **States.** Empty (what will appear here and the first action), loading
  (a quiet line or skeleton, no layout jump), error (what happened and what to
  do), plus hover, `:focus-visible`, disabled, and long names that wrap or
  truncate.
- **Real content.** The person's data and words. No lorem ipsum, invented
  numbers, testimonials or team members.
- **Words.** Sentence case. Name a control by what it does ("Add reading",
  not "Submit") and keep that name through the flow. No heading that repeats
  the app's title, no "Welcome to", no sales adjectives in a tool.
- **Phone.** One column, and nothing wider than the screen: columns placed
  side by side stack, grid and flex children get `min-width: 0`, a wide table
  stacks its rows or scrolls inside its own `overflow-x: auto` wrapper. Touch
  targets of 44px, the main action in reach.

## Signs of a generated page

Leave these out unless the person asks for them:

- A purple, indigo or blue gradient hero, gradient text, glow, glass blur or
  decorative blobs.
- Emoji as icons or in headings.
- Stat cards above a tool where nobody acts on the numbers.
- Every block in the same rounded card with the same soft shadow; a colored
  stripe down a card's edge.
- A small all-caps label above every heading; numbered markers (01, 02, 03)
  on content that is not a sequence.
- Everything centered.
- Fade-in on every section, lift on every card.
- Pills and badges on things that have no state.
- A footer credit, a slogan under the title, a section that only describes
  the app.

## Before saving

Read the page as its visitor. The eye should land first on the thing from
step 1; if it lands elsewhere, quiet that. Then remove one decoration that
does no work.
