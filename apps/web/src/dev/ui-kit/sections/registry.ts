import type { ComponentType } from "react";

/**
 * Every section of the DEV-only UI kit, in navigation order. The shell renders
 * the section header (group, title, purpose, used on) from this metadata, and
 * `Fork` / `Alternative` read their default names and rationales from it, so a
 * section file only has to render the real primitives.
 */

export type AlternativeId = "a" | "b" | "c";

export const ALTERNATIVE_IDS: readonly AlternativeId[] = ["a", "b", "c"];

/**
 * A few open style questions (Button styles) compare more than three versions.
 * Pages and primitives still map `AlternativeId`; only the fork chrome, the
 * picks store and the export handle the extra letters.
 */
export type ForkAlternativeId = AlternativeId | "d" | "e";

export const FORK_ALTERNATIVE_IDS: readonly ForkAlternativeId[] = ["a", "b", "c", "d", "e"];

export type SectionGroup =
  | "Frame"
  | "Lists"
  | "Selection"
  | "Status"
  | "Structure"
  | "Forms"
  | "People"
  | "Foundations"
  | "Style"
  | "Pages";

/** Navigation order. Groups without sections are hidden. */
export const SECTION_GROUPS: readonly SectionGroup[] = [
  "Frame",
  "Lists",
  "Selection",
  "Status",
  "Structure",
  "Forms",
  "People",
  "Foundations",
  "Style",
  "Pages",
];

export interface AlternativeMeta {
  id: ForkAlternativeId;
  /** Short name, for example "Brand track". */
  name: string;
  /** One line on what it is and when it fits. */
  rationale: string;
}

export interface SectionMeta {
  key: SectionKey;
  group: SectionGroup;
  /** Sentence case, as shown in the nav and the section header. */
  title: string;
  /** One line: what the component is for. */
  purpose: string;
  /** Where it is used, as plain product words. */
  usedOn?: string;
  /** The recommended alternative. Present only when the section has a fork. */
  recommended?: AlternativeId;
  /** Why the recommended alternative is the default. */
  whyRecommended?: string;
  /** Set when the pick changed after review: what was decided, when and why. */
  decision?: string;
  /**
   * Still an open question: the recommended version shows a "Recommended" tag
   * instead of "Decided" and the fork says "We recommend".
   */
  open?: boolean;
  alternatives?: readonly AlternativeMeta[];
  load: () => Promise<{ default: ComponentType }>;
}

export const SECTION_KEYS = [
  // Frame
  "page-header",
  "navigation",
  "section",
  "tabs-toolbar",
  // Lists
  "list-row",
  "detail-sheet",
  "empty-state",
  // Selection
  "setting-row",
  "switch",
  "segmented-control",
  "choice-cards",
  "select",
  "disclosure",
  // Status
  "status-badge",
  "usage-meter",
  "feedback",
  // Forms
  "form-dialog",
  "destructive-confirm",
  "secret-values",
  "cadence-picker",
  // People
  "access-list",
  // Foundations
  "logo-tile",
  "relative-time",
  "copy-field",
  "diff-view",
  // Style
  "button-styles",
  // Pages
  "page-general",
  "page-access",
  "page-api-keys",
  "page-connected-agents",
  "page-models",
  "page-variable-sets",
  "page-variable-set-detail",
  "page-schedules",
  "page-schedule-form",
  "page-knowledge",
  "page-org-people",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTIONS: readonly SectionMeta[] = [
  // ---------------------------------------------------------------- Frame
  {
    key: "page-header",
    group: "Frame",
    title: "Page header",
    purpose:
      "One header for every page: title, one-line description, primary action, optional tabs.",
    usedOn: "Every rail page, Workspace settings, Organization settings, Personal settings",
    recommended: "b",
    whyRecommended: "Keeps the header you like and removes the size and icon jump inside settings.",
    alternatives: [
      {
        id: "a",
        name: "Icon everywhere",
        rationale: "Capabilities style on every page: a 16px brand icon next to a 20px title.",
      },
      {
        id: "b",
        name: "Icon on main-rail pages only",
        rationale:
          "Same header, but settings sub-pages drop the icon because the sub-nav already gives context.",
      },
      {
        id: "c",
        name: "Large settings title",
        rationale: "A 24px title with no icon, everywhere.",
      },
    ],
    load: () => import("./page-header"),
  },
  {
    key: "navigation",
    group: "Frame",
    title: "Navigation",
    purpose: "Where every destination lives, once, with one name and one icon.",
    usedOn: "Main rail, Workspace settings, Organization settings",
    recommended: "a",
    whyRecommended:
      "People keep their place, and the two sidebars stop using two different label systems.",
    alternatives: [
      {
        id: "a",
        name: "Sub-nav inside the content",
        rationale:
          "The rail never swaps. A labelled Settings item opens settings, with its sub-nav as a column in the content.",
      },
      {
        id: "b",
        name: "Cleaned settings rail",
        rationale:
          "Keep swapping the rail, with the switcher as its header, no stacked labels and one width.",
      },
      {
        id: "c",
        name: "Settings as tabs",
        rationale:
          "Settings sections as page tabs. Only works if settings shrinks below about 7 sections.",
      },
    ],
    load: () => import("./navigation"),
  },
  {
    key: "section",
    group: "Frame",
    title: "Section",
    purpose: "Group related rows on a page without boxing them.",
    usedOn: "Settings pages, detail pages, organization pages",
    recommended: "a",
    whyRecommended: "Matches Capabilities and can never produce a card inside a card.",
    alternatives: [
      {
        id: "a",
        name: "Open section",
        rationale:
          "A 16px title a step above the 14px rows, a 12px description, rows below, one hairline between sections, no box.",
      },
      {
        id: "b",
        name: "Soft group",
        rationale: "Rows inside one bordered surface per section.",
      },
      {
        id: "c",
        name: "Tile per setting",
        rationale: "Each setting in its own card. Spacious, but wastes room on simple toggles.",
      },
    ],
    load: () => import("./section"),
  },
  {
    key: "tabs-toolbar",
    group: "Frame",
    title: "Tabs and toolbar",
    purpose: "Page sections and list filtering that never reflow.",
    usedOn: "Capabilities, Knowledge, Environment detail, Agents, Artifacts, People",
    recommended: "a",
    whyRecommended:
      "The tabs you like become reusable, and status filters stop being a second tab row.",
    alternatives: [
      {
        id: "a",
        name: "Underline tabs and toolbar",
        rationale:
          "Capabilities tabs, with search, filter and the primary action in a toolbar that keeps its shape.",
      },
      {
        id: "b",
        name: "Pill tabs",
        rationale: "Filled pills. They read as filters, not places.",
      },
      {
        id: "c",
        name: "Filter menu only",
        rationale: "No tabs; one Filter menu with checkable items.",
      },
    ],
    load: () => import("./tabs-toolbar"),
  },

  // ---------------------------------------------------------------- Lists
  {
    key: "list-row",
    group: "Lists",
    title: "List row",
    purpose: "The one way to show a thing in a list.",
    usedOn:
      "Variable sets, API keys, Schedules, People, Model accounts, Machines, Environments, Knowledge, Capabilities",
    recommended: "b",
    whyRecommended:
      "A for discovering, B for managing. Both share the same tile, type and hover so they read as one family.",
    alternatives: [
      {
        id: "a",
        name: "Catalog row",
        rationale:
          "76px rows with a 40px logo tile in a 2-column grid and a trailing + or check. Today's Capabilities row.",
      },
      {
        id: "b",
        name: "Divided resource row",
        rationale:
          "56-64px rows in one column with hairline dividers, a 32px tile, a title and one meta line. For things you own.",
      },
      {
        id: "c",
        name: "Table",
        rationale:
          "Column headers and sortable columns. For more than about 20 items or numeric data.",
      },
    ],
    load: () => import("./list-row"),
  },
  {
    key: "detail-sheet",
    group: "Lists",
    title: "Detail page",
    purpose:
      "The single place to manage one thing: its own page in the content area, with a back link to its list.",
    usedOn:
      "Model accounts, People, API keys, Schedules, Variable sets, Environments, Knowledge entries, Workspaces",
    recommended: "b",
    whyRecommended:
      "No side sheets anywhere. Anything you open is its own page with a back link, like Claude and Codex settings: deep-linkable, room for tabs and tables, and one pattern for every object.",
    decision:
      "Decided 27 Sep 2026: B everywhere. Changed from A (right sheet) - Bendik wants no right-side panels at all. Centered modals stay only for short confirmations and one-field prompts.",
    alternatives: [
      {
        id: "a",
        name: "Right sheet",
        rationale:
          "520px with sections and a sticky footer, full screen on phones. Keeps the list in view. Retired: no side sheets.",
      },
      {
        id: "b",
        name: "Detail page",
        rationale:
          "Back link, 40px tile, title with chips, a meta line, underline tabs, a main column and a quiet aside card. Deep-linkable and scales to 100 rows.",
      },
      {
        id: "c",
        name: "Expand in place",
        rationale: "Today's pattern. Kept only for one level of secondary options.",
      },
    ],
    load: () => import("./detail-sheet"),
  },
  {
    key: "empty-state",
    group: "Lists",
    title: "Empty state",
    purpose: "Explain what goes here and offer the first action, once.",
    usedOn: "Every list",
    recommended: "a",
    whyRecommended: "A everywhere, and C where starting is the hard part (Schedules).",
    alternatives: [
      {
        id: "a",
        name: "Centered",
        rationale:
          "A 40px icon tile, a title, one sentence and one action. The header action hides while empty.",
      },
      {
        id: "b",
        name: "Inline",
        rationale: "One muted sentence and a link. For sections and no results.",
      },
      {
        id: "c",
        name: "Templates",
        rationale: "A, plus 2-3 starter cards that prefill a form.",
      },
    ],
    load: () => import("./empty-state"),
  },

  // ---------------------------------------------------------------- Selection
  {
    key: "setting-row",
    group: "Selection",
    title: "Setting row",
    purpose: "One setting, one row, exactly one control, aligned with its neighbours.",
    usedOn: "General, Model account page, Organization security, Integrations",
    recommended: "a",
    whyRecommended: "Every control lines up, and labels stop truncating on phones.",
    alternatives: [
      {
        id: "a",
        name: "Control right",
        rationale:
          "Label and description on the left, the control in a fixed right column so every control lines up.",
      },
      {
        id: "b",
        name: "Control left",
        rationale: "The switch or checkbox before the label, list style.",
      },
      {
        id: "c",
        name: "Stacked",
        rationale: "The control under the text. Used automatically below 640px for A.",
      },
    ],
    load: () => import("./setting-row"),
  },
  {
    key: "switch",
    group: "Selection",
    title: "Switch",
    purpose: "Immediate on/off that saves on change.",
    usedOn: "Settings, Model accounts, Integrations, Schedules, composer menus",
    recommended: "a",
    whyRecommended:
      "One size, one focus ring, one disabled look, and a visible off state in both themes.",
    alternatives: [
      {
        id: "a",
        name: "Brand track",
        rationale: "Brand fill when on, and a visible track when off in both themes.",
      },
      {
        id: "b",
        name: "Neutral track",
        rationale: "Foreground fill when on. Quieter, reads well in dense admin pages.",
      },
      {
        id: "c",
        name: "Switch with state text",
        rationale: "Adds a small On or Off label for dense rows.",
      },
    ],
    load: () => import("./switch"),
  },
  {
    key: "segmented-control",
    group: "Selection",
    title: "Segmented control",
    purpose: "2-4 exclusive short options that stay visible.",
    usedOn:
      "Learning modes, Codex source, account selection, filters, grid or list, Insights ranges",
    recommended: "a",
    whyRecommended: "The same control for settings and filters, and correct in dark mode.",
    alternatives: [
      {
        id: "a",
        name: "Filled track",
        rationale: "A soft track with the active option raised on the surface.",
      },
      {
        id: "b",
        name: "Outlined group",
        rationale: "A bordered group with the active option in a soft brand tint.",
      },
      {
        id: "c",
        name: "Mini underline tabs",
        rationale: "Text options with an underline. Only for view filters.",
      },
    ],
    load: () => import("./segmented-control"),
  },
  {
    key: "choice-cards",
    group: "Selection",
    title: "Choice cards",
    purpose:
      "2-3 options whose consequences need a sentence, and the one selected highlight used app-wide.",
    usedOn: "Connection ownership, invite role, retention, variable set scope, Slack mode",
    recommended: "a",
    whyRecommended:
      "The Capabilities-style highlight, used for every selected state: cards, templates and picker rows.",
    alternatives: [
      {
        id: "a",
        name: "Brand ring",
        rationale: "A brand border, a faint brand fill and a check in the corner.",
      },
      {
        id: "b",
        name: "Radio dot",
        rationale: "A neutral border; only the radio dot shows the selection.",
      },
      {
        id: "c",
        name: "Plain radio list",
        rationale: "No cards: radio, title and description rows.",
      },
    ],
    load: () => import("./choice-cards"),
  },
  {
    key: "select",
    group: "Selection",
    title: "Select",
    purpose: "Choose one of many; menus stay for actions.",
    usedOn: "Model picker, role select, provider and payer, time zone, people picker",
    recommended: "b",
    whyRecommended:
      "Model and role choices need descriptions and payment sources that native selects can't show.",
    alternatives: [
      {
        id: "a",
        name: "Native, restyled",
        rationale: "Keep native selects, at one height and fixed widths.",
      },
      {
        id: "b",
        name: "Menu select",
        rationale:
          "A popover like the composer: title, description and payment source, with a check on the selected option.",
      },
      {
        id: "c",
        name: "Combobox",
        rationale: "A searchable popover. Used for long or remote lists either way.",
      },
    ],
    load: () => import("./select"),
  },
  {
    key: "disclosure",
    group: "Selection",
    title: "Disclosure",
    purpose: "Hide secondary options of the same object, one level only.",
    usedOn: "Schedule advanced options, Technical details, machine limits, Insights prompt context",
    recommended: "a",
    whyRecommended: "Shows what is inside before you open it, and one pattern replaces four.",
    alternatives: [
      {
        id: "a",
        name: "Advanced row",
        rationale:
          "A full-width row with a chevron that rotates, the title and a summary of current values.",
      },
      {
        id: "b",
        name: "Change / Hide",
        rationale: "The summary on the left, text and a chevron on the right.",
      },
      {
        id: "c",
        name: "No disclosure",
        rationale: "Secondary options always live on the detail page instead.",
      },
    ],
    load: () => import("./disclosure"),
  },

  // ---------------------------------------------------------------- Status
  {
    key: "status-badge",
    group: "Status",
    title: "Status badge",
    purpose: "One status vocabulary, and one quiet chip for metadata.",
    usedOn: "Every list and detail page",
    recommended: "b",
    whyRecommended: "A in rows, B in headers. The tone table is the real decision.",
    alternatives: [
      {
        id: "a",
        name: "Dot and label",
        rationale: "A 6px dot and text, no pill. The quietest; for rows.",
      },
      {
        id: "b",
        name: "Bordered pill",
        rationale:
          "A 22px pill with a border and a 6px dot. The Capabilities chip; for page headers.",
      },
      {
        id: "c",
        name: "Tinted pill",
        rationale: "A soft status fill. Louder; only for alerts.",
      },
    ],
    load: () => import("./status-badge"),
  },
  {
    key: "usage-meter",
    group: "Status",
    title: "Usage meter",
    purpose: "Show remaining quota at a glance and in detail.",
    usedOn: "Model account rows and pages, machine rows",
    recommended: "a",
    whyRecommended: "A bar on the account page, text in the row.",
    alternatives: [
      {
        id: "a",
        name: "Thin bar",
        rationale: "A 4px bar, '22% left' and the reset time.",
      },
      {
        id: "b",
        name: "Text only",
        rationale: "'Weekly 22% left' with no bar. The quietest; for rows.",
      },
      {
        id: "c",
        name: "Ring",
        rationale: "A small ring per window. Compact, but harder to compare.",
      },
    ],
    load: () => import("./usage-meter"),
  },
  {
    key: "feedback",
    group: "Status",
    title: "Feedback",
    purpose:
      "Notices, inline help, error messages, reasons for disabled controls, stat tiles and when to toast.",
    usedOn: "Every page",
    load: () => import("./feedback"),
  },

  // ---------------------------------------------------------------- Forms
  {
    key: "form-dialog",
    group: "Forms",
    title: "Form page",
    purpose: "Create and edit in one clean vertical column, on its own page.",
    usedOn:
      "New variable set, Add variable, Create API key, Invite people, New schedule, Edit schedule, Connect account",
    recommended: "b",
    whyRecommended:
      "Every create and edit flow is a full page (/schedules/new) with a back link and a sticky Cancel + primary footer. Nothing slides in from the side.",
    decision:
      "Decided 27 Sep 2026: B everywhere. Changed from A (dialog or sheet by size). A small centered dialog stays only for one-field prompts such as Rename or Replace value.",
    alternatives: [
      {
        id: "a",
        name: "Dialog or sheet by size",
        rationale:
          "A dialog for 4 fields or fewer, a sheet for longer forms. Retired: no side sheets, and only one-field prompts stay in a dialog.",
      },
      {
        id: "b",
        name: "Full page",
        rationale:
          "Its own page with a back link, a 640px column and a sticky footer. For every create and edit flow.",
      },
      {
        id: "c",
        name: "Inline on the page",
        rationale: "Today's pattern. Pushes content down and has no clear exit.",
      },
    ],
    load: () => import("./form-dialog"),
  },
  {
    key: "destructive-confirm",
    group: "Forms",
    title: "Destructive confirm",
    purpose: "Make permanent actions explicit and blocked actions explainable.",
    usedOn:
      "Delete workspace, Disconnect, Remove from organization, Delete variable set, Revoke API key",
    recommended: "a",
    whyRecommended:
      "A by default, B and C where the stakes call for them, plus a blocked variant with no destructive button.",
    alternatives: [
      {
        id: "a",
        name: "Consequence list",
        rationale:
          "The name in the title, a short list of what happens, and a destructive primary.",
      },
      {
        id: "b",
        name: "Type to confirm",
        rationale: "A, plus typing the name. Only for permanent, wide-impact actions.",
      },
      {
        id: "c",
        name: "Undo instead",
        rationale: "No dialog; a toast with Undo. Only when the action is reversible.",
      },
    ],
    load: () => import("./destructive-confirm"),
  },
  {
    key: "secret-values",
    group: "Forms",
    title: "Secret values",
    purpose: "Handle secrets without showing them.",
    usedOn: "Variables, API key creation, provider keys",
    recommended: "a",
    whyRecommended: "A now, and C next once variables get a Secret flag.",
    alternatives: [
      {
        id: "a",
        name: "Write-only",
        rationale: "Values are never shown after saving; Replace value only.",
      },
      {
        id: "b",
        name: "Reveal with audit",
        rationale: "Today's behaviour, moved into the row menu.",
      },
      {
        id: "c",
        name: "Write-only and plain values",
        rationale:
          "A, plus a Secret flag per variable so plain config shows inline. Needs a backend change.",
      },
    ],
    load: () => import("./secret-values"),
  },
  {
    key: "cadence-picker",
    group: "Forms",
    title: "Cadence picker",
    purpose: "Say when something runs, as a sentence, with a preview.",
    usedOn: "Schedules, knowledge source sync",
    recommended: "a",
    whyRecommended:
      "The rule reads the way people think about it, and the time zone is part of the sentence.",
    alternatives: [
      {
        id: "a",
        name: "Sentence builder",
        rationale: "[Every weekday] at [08:00] [Oslo time], with a live next-run line.",
      },
      {
        id: "b",
        name: "Presets and fields",
        rationale: "Today's presets, cleaned up, with a summary line.",
      },
      {
        id: "c",
        name: "Type it",
        rationale: "Type 'every weekday at 8' and see the rule and the next run.",
      },
    ],
    load: () => import("./cadence-picker"),
  },

  // ---------------------------------------------------------------- People
  {
    key: "access-list",
    group: "People",
    title: "Access list",
    purpose: "The single membership editor, used everywhere access is edited.",
    usedOn: "Workspace Access, person page, workspace page, invite page",
    recommended: "a",
    whyRecommended: "The same rows, verbs and role definitions in all four places.",
    alternatives: [
      {
        id: "a",
        name: "Inline role and menu",
        rationale:
          "Avatar, name and email, a role select that saves immediately, and a menu with Remove.",
      },
      {
        id: "b",
        name: "Role as text",
        rationale: "Quieter rows; change the role on the person's page.",
      },
      {
        id: "c",
        name: "Matrix",
        rationale: "A people by workspaces grid. Only works with a few workspaces.",
      },
    ],
    load: () => import("./access-list"),
  },

  // ---------------------------------------------------------------- Foundations
  {
    key: "logo-tile",
    group: "Foundations",
    title: "Logo tile",
    purpose:
      "One tile for logos, monograms and icons, at 40, 32 and 24px, the same in both themes.",
    usedOn: "Capabilities, Model accounts, Variable sets, API keys, detail page headers",
    load: () => import("./logo-tile"),
  },
  {
    key: "relative-time",
    group: "Foundations",
    title: "Relative time",
    purpose: "'3 days ago' with the exact local time on hover, and one absolute date format.",
    usedOn: "Every list, detail page and run history",
    load: () => import("./relative-time"),
  },
  {
    key: "copy-field",
    group: "Foundations",
    title: "Copy field",
    purpose: "A quiet mono value with a copy button, for IDs and key prefixes.",
    usedOn: "Workspace ID, Organization ID, API key prefixes",
    load: () => import("./copy-field"),
  },
  {
    key: "diff-view",
    group: "Foundations",
    title: "Diff view",
    purpose: "Inline added and removed text with context, plus revision history with Restore.",
    usedOn: "Knowledge review, Workspace instructions, Organization identity",
    load: () => import("./diff-view"),
  },

  // ---------------------------------------------------------------- Style
  {
    key: "button-styles",
    group: "Style",
    title: "Button styles",
    purpose:
      "How primary, secondary and destructive buttons look, compared on the same screens in dark and light.",
    usedOn: "Every page header, detail page, form footer, empty state and confirm dialog",
    recommended: "a",
    open: true,
    whyRecommended:
      "One solid ink button per screen reads as confident and deliberate in both themes, and frees blue for focus, selection and links, where it carries meaning.",
    alternatives: [
      {
        id: "a",
        name: "Inverted ink",
        rationale:
          "Primary is a solid foreground-colored button (near-white on dark, near-black on light), like Claude, Vercel and Linear. Blue only marks focus, selection and links.",
      },
      {
        id: "b",
        name: "Quiet surface",
        rationale:
          "Primary is a raised neutral surface with a firm border and stronger text. No solid fills except the destructive confirm.",
      },
      {
        id: "c",
        name: "Deep indigo",
        rationale:
          "Keeps a brand-colored primary, but darker and much less saturated, with a hairline inner edge and taller 36px controls.",
      },
      {
        id: "d",
        name: "Outline accent",
        rationale:
          "Every button is outlined. The primary alone gets a thin brand ring, brand text and a faint tint; nothing is solid.",
      },
      {
        id: "e",
        name: "Ink pills",
        rationale:
          "Inverted ink primary on a fully rounded shape, with filled neutral secondaries and no outlines, like ChatGPT settings.",
      },
    ],
    load: () => import("./button-styles"),
  },

  // ---------------------------------------------------------------- Pages
  {
    key: "page-general",
    group: "Pages",
    title: "General",
    purpose: "Workspace settings: the workspace, agent activity, new session defaults and delete.",
    usedOn: "Workspace settings",
    load: () => import("./page-general"),
  },
  {
    key: "page-access",
    group: "Pages",
    title: "Access",
    purpose: "Who can use this workspace, with one role each.",
    usedOn: "Workspace settings",
    load: () => import("./page-access"),
  },
  {
    key: "page-api-keys",
    group: "Pages",
    title: "API keys",
    purpose: "Keys for automation, with presets, an expiry and a token shown once.",
    usedOn: "Workspace settings",
    load: () => import("./page-api-keys"),
  },
  {
    key: "page-connected-agents",
    group: "Pages",
    title: "Connected agents",
    purpose:
      "Outside agents working in the organization over MCP: whose they are, what they can do and where.",
    usedOn: "Organization settings > Developer, agent sign-in",
    load: () => import("./page-connected-agents"),
  },
  {
    key: "page-models",
    group: "Pages",
    title: "Models",
    purpose: "Which models a workspace can use and who pays for them, with the account page.",
    usedOn: "Workspace settings, Organization settings",
    load: () => import("./page-models"),
  },
  {
    key: "page-variable-sets",
    group: "Pages",
    title: "Variable sets",
    purpose: "Environment variables and secrets your agents get in their sandbox.",
    usedOn: "Workspace settings, Runtime",
    load: () => import("./page-variable-sets"),
  },
  {
    key: "page-variable-set-detail",
    group: "Pages",
    title: "Variable set detail",
    purpose: "One variable set: its variables and what uses it.",
    usedOn: "Workspace settings, Runtime",
    load: () => import("./page-variable-set-detail"),
  },
  {
    key: "page-schedules",
    group: "Pages",
    title: "Schedules",
    purpose: "Recurring agent work in this workspace, with the schedule page.",
    usedOn: "Main rail",
    load: () => import("./page-schedules"),
  },
  {
    key: "page-schedule-form",
    group: "Pages",
    title: "Schedule form",
    purpose: "Create or edit a schedule: what to do, when, a name and advanced options.",
    usedOn: "Schedules",
    load: () => import("./page-schedule-form"),
  },
  {
    key: "page-knowledge",
    group: "Pages",
    title: "Knowledge",
    purpose: "What your agents know and how they learn: Library, Instructions and Review.",
    usedOn: "Main rail",
    load: () => import("./page-knowledge"),
  },
  {
    key: "page-org-people",
    group: "Pages",
    title: "Organization people",
    purpose: "Everyone in Acme Robotics, with the person page.",
    usedOn: "Organization settings",
    load: () => import("./page-org-people"),
  },
];

const SECTION_BY_KEY = new Map<string, SectionMeta>(
  SECTIONS.map((section) => [section.key, section]),
);

export function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === "string" && SECTION_BY_KEY.has(value);
}

export function getSection(key: SectionKey): SectionMeta;
export function getSection(key: string): SectionMeta | undefined;
export function getSection(key: string): SectionMeta | undefined {
  return SECTION_BY_KEY.get(key);
}

/** Sections with a real fork (alternatives A/B/C and a recommended default). */
export const FORK_SECTIONS: readonly SectionMeta[] = SECTIONS.filter(
  (section) => section.recommended !== undefined,
);

export function sectionsInGroup(group: SectionGroup): readonly SectionMeta[] {
  return SECTIONS.filter((section) => section.group === group);
}

/** Non-empty groups, in navigation order. */
export function visibleGroups(): readonly SectionGroup[] {
  return SECTION_GROUPS.filter((group) => sectionsInGroup(group).length > 0);
}

export function alternativeMeta(
  key: SectionKey,
  id: ForkAlternativeId,
): AlternativeMeta | undefined {
  return getSection(key).alternatives?.find((alternative) => alternative.id === id);
}

export function alternativeLetter(id: ForkAlternativeId): string {
  return id.toUpperCase();
}
