export const categories = [
  {
    id: "rows",
    title: "Settings rows",
    description: "Compare density and grouping. Each option contains the same three preferences.",
    options: [
      {
        id: "compact",
        title: "Compact rows",
        use: "Familiar, short preferences and longer lists.",
        tradeoff: "Less breathing room when explanations get longer.",
      },
      {
        id: "comfortable",
        title: "Comfortable rows",
        use: "Everyday settings with useful explanations.",
        tradeoff: "Fewer settings visible at once.",
      },
      {
        id: "grouped",
        title: "Grouped sections",
        use: "Preferences with a meaningful category boundary.",
        tradeoff: "Only group where the distinction helps navigation.",
      },
    ],
  },
  {
    id: "lists",
    title: "Resource lists",
    description:
      "The same three connections, with identical status and actions in every presentation.",
    options: [
      {
        id: "simple",
        title: "Simple rows",
        use: "Short lists where names matter most.",
        tradeoff: "Metadata is less easy to compare across rows.",
      },
      {
        id: "metadata",
        title: "Metadata rows",
        use: "Connections, credentials, and richer resource lists.",
        tradeoff: "More vertical space per item.",
      },
      {
        id: "table",
        title: "Structured table",
        use: "Comparing the same attributes across many items.",
        tradeoff: "May need contained horizontal scrolling on phones.",
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
        title: "Underlined tabs",
        use: "Navigating between sections within a page.",
        tradeoff: "A quieter boundary between navigation and content.",
      },
      {
        id: "segmented",
        title: "Segmented tabs",
        use: "Small, closely related views of the same content.",
        tradeoff: "More visual weight; avoid large sets of tabs.",
      },
    ],
  },
  {
    id: "search",
    title: "Search & filters",
    description:
      "Both examples search the active view. Only the position changes—not the scope of the search.",
    options: [
      {
        id: "above",
        title: "Search above tabs",
        use: "Search is the main way people find items.",
        tradeoff: "The relationship to the active view needs a clear label.",
      },
      {
        id: "below",
        title: "Toolbar below tabs",
        use: "People choose a view, then narrow its results.",
        tradeoff: "Search sits one level lower in the hierarchy.",
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
        title: "Explained radio choices",
        use: "Choices need an explanation or have important consequences.",
        tradeoff: "Takes more space, so keep the option count small.",
      },
    ],
  },
  {
    id: "multiple",
    title: "Multiple selection",
    description:
      "A separate decision for choosing several connections. Both variants use the same searchable checkbox component.",
    options: [
      {
        id: "visible",
        title: "Always-visible checklist",
        use: "Selecting items is the main task on the page.",
        tradeoff: "The list occupies space even when you are not editing it.",
      },
      {
        id: "disclosed",
        title: "Expandable checklist",
        use: "Selection is secondary configuration.",
        tradeoff: "An extra click is needed to inspect or change the selected items.",
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
