export const categories = [
  {
    id: "rows",
    title: "Preference layouts",
    description:
      "Three different ways to organize the same settings: an interactive tile board, a quiet form, or a focused settings navigator.",
    options: [
      {
        id: "compact",
        title: "Interactive tiles",
        use: "Recognizable preferences you can turn on directly from a visual board.",
        tradeoff: "Works best for a short set; not for every field in a long form.",
      },
      {
        id: "comfortable",
        title: "Quiet form",
        use: "Calm, familiar editing with switches and minimal decoration.",
        tradeoff: "Less visual recognition than a tile board.",
      },
      {
        id: "grouped",
        title: "Settings navigator",
        use: "Choose a setting, then focus on its explanation and controls.",
        tradeoff: "Adds a navigation step and hides the other controls until selected.",
      },
    ],
  },
  {
    id: "lists",
    title: "Connector layouts",
    description:
      "Cards, the actual Capabilities catalog rows, or an icon-rail browser. Plus means available to add; check means added. No repeated status badges.",
    options: [
      {
        id: "simple",
        title: "Capability cards",
        use: "Visual browsing: recognizable logos, a short description, and a plus or check.",
        tradeoff: "Needs more room than a list when the catalog is large.",
      },
      {
        id: "metadata",
        title: "Quiet catalog",
        use: "The same shared row and status indicator used by the Capabilities page.",
        tradeoff: "Less visual emphasis on each connector than the card grid.",
      },
      {
        id: "table",
        title: "Connector browser",
        use: "Browse logos in a rail and inspect one connector in a dedicated detail area.",
        tradeoff: "Only one description is visible at a time.",
      },
    ],
  },
  {
    id: "tabs",
    title: "Tabs & view switching",
    description:
      "Same views, counts, and content. This is a visual choice, not a change to membership behavior.",
    options: [
      {
        id: "line",
        title: "Floating pill navigation",
        use: "A small set of prominent horizontal views, like a catalog filter.",
        tradeoff: "The selected pill has more visual weight than an underline.",
      },
      {
        id: "segmented",
        title: "Vertical view rail",
        use: "A browsing workspace with persistent local navigation beside the results.",
        tradeoff: "Uses some horizontal room; best with a wider content area.",
      },
    ],
  },
  {
    id: "search",
    title: "Search & filters",
    description:
      "A discovery-style search and card grid, or a compact workspace toolbar with a quiet results list. Both filter the same sample catalog.",
    options: [
      {
        id: "above",
        title: "Discovery canvas",
        use: "A prominent rounded search field, filter chips and visual connector cards.",
        tradeoff: "Search is given the most space and attention.",
      },
      {
        id: "below",
        title: "Working toolbar",
        use: "A compact search-and-view toolbar above a familiar list.",
        tradeoff: "Less expressive; prioritizes managing a collection over discovery.",
      },
    ],
  },
  {
    id: "details",
    title: "Detailed configuration",
    description:
      "Open each option to edit exactly the same connection details. No authorization or provider setup is simulated.",
    options: [
      {
        id: "inline",
        title: "Inline expansion",
        use: "A few related fields that fit naturally in a row.",
        tradeoff: "Expanding fields moves the content below them.",
      },
      {
        id: "sheet",
        title: "Side panel",
        use: "Longer configuration while keeping the list in view.",
        tradeoff: "Less editing width; needs careful phone behavior.",
      },
      {
        id: "dialog",
        title: "Focused dialog",
        use: "A bounded task that benefits from focus.",
        tradeoff: "Temporarily covers the page and interrupts browsing.",
      },
    ],
  },
  {
    id: "selection",
    title: "Selection controls",
    description:
      "Compare two single-choice controls. Multiple selection is a separate use case, not a substitute for either.",
    options: [
      {
        id: "select",
        title: "Dropdown",
        use: "A familiar, short set of self-explanatory choices.",
        tradeoff: "Options are hidden until the control opens.",
      },
      {
        id: "radio",
        title: "Visual choice tiles",
        use: "Recognizable icon-led choices with a clear selected tile.",
        tradeoff: "Needs a small, meaningful set of options.",
      },
    ],
  },
  {
    id: "multiple",
    title: "Multiple selection",
    description:
      "Choose connections visually from a tile board, or assemble them as removable chips from search results. Both support several selections.",
    options: [
      {
        id: "visible",
        title: "Selectable connector tiles",
        use: "Pick several tools directly by their logos and plus/check states.",
        tradeoff: "Large catalogs need search or categories around the tiles.",
      },
      {
        id: "disclosed",
        title: "Chip composer",
        use: "Build a selection with removable chips and searchable results.",
        tradeoff: "The input/results pattern is less visual than a tile grid.",
      },
    ],
  },
] as const;
export type CategoryId = (typeof categories)[number]["id"];
export type Favorites = Partial<Record<CategoryId, string>>;
export function selectionText(favorites: Favorites, notes: string) {
  return [
    "OpenGeni component preferences — discussion only, not implementation approval",
    ...categories.map((category) => {
      const option = category.options.find((item) => item.id === favorites[category.id]);
      return `${category.title}: ${option?.title ?? "Not selected"}`;
    }),
    "",
    "Notes:",
    notes || "None",
    "",
    "Insights and existing functionality stay unchanged. Detailed production flows need a separate review.",
  ].join("\n");
}
