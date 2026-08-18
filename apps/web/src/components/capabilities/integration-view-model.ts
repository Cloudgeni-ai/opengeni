/**
 * The one shape every OpenGeni-run integration renders through.
 *
 * `IntegrationRow` and `IntegrationSheet` know nothing about Slack, GitHub,
 * Google Drive, or Atlassian: each provider has an adapter hook that maps its
 * own data into this plain view-model, choosing the facts, access list,
 * options, and footer for the viewer's role. Empty blocks are omitted by the
 * sheet; the frame itself never varies.
 */

import type { ReactNode } from "react";

export type IntegrationChipTone = "ok" | "warn" | "idle" | "plain";

export type IntegrationChip = {
  label: "Connected" | "Needs attention" | "Not connected" | "Set up by an admin" | "Loading";
  tone: IntegrationChipTone;
};

/**
 * The closed icon vocabulary for a provider with no hosted logo asset, mirroring
 * `IntegrationPresentationIcon` in `@opengeni/capabilities`. A named product
 * glyph reads far better than an ambiguous two-letter monogram (Outlook
 * Calendar and Outlook Contacts cannot both be "OC").
 */
export type IntegrationMarkIcon = "mail" | "calendar" | "contacts" | "files" | "cloud";

export type IntegrationMark =
  | { logoSrc: string; monogram: string }
  | { icon: IntegrationMarkIcon }
  | { monogram: string };

export type IntegrationFact = {
  label: string;
  value: string;
};

export type IntegrationAccessItem = {
  /**
   * Stable identity for this entry (an account's instance key, a folder id).
   * Keying on it keeps a row mounted when only its status text changes, so a
   * status flip never steals focus from the row's own action. Falls back to
   * content when omitted (plain resource rows with nothing stabler).
   */
  id?: string;
  name: string;
  meta?: string;
  /** Status dot color for a multi-account entry ("ok" green, "warn" amber). Omitted for a plain resource row. */
  status?: "ok" | "warn";
  /** Sub-entries rendered under this one (e.g. the folders an account contributes). */
  subItems?: Array<{ name: string; meta?: string }>;
  /** Shown in place of an empty `subItems` list, when the absence itself is the fact. */
  subItemsEmptyMessage?: string;
  /** Inline per-item actions (e.g. "Reconnect", "Remove") rendered at the end of the row. */
  actions?: Array<{
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Disclosure this action points at via aria-describedby. */
    disclosureId?: string;
    /** Renders in the destructive tone (still confirm before destroying). */
    destructive?: boolean;
  }>;
  /**
   * Per-entry expandable detail rendered under the row - the one slot deep
   * per-instance surfaces (the Integration facets panel) mount into, so they
   * stay scoped to exactly this account instead of the whole provider row.
   */
  detail?: ReactNode;
};

export type IntegrationAccess = {
  title: string;
  /** The single edit affordance for this block. Omitted when the viewer cannot change it. */
  editLabel?: string;
  onEdit?: () => void;
  /** Keep the edit affordance visible but inert (e.g. while a mutation is in flight). */
  editDisabled?: boolean;
  /** Disclosure the edit affordance points at via aria-describedby. */
  editDisclosureId?: string;
  items: IntegrationAccessItem[];
  /** Shown instead of the list when there is nothing scoped yet. */
  emptyMessage?: string;
};

export type IntegrationToggleOption = {
  kind: "toggle";
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (checked: boolean) => void;
  /** Optional secondary affordance for a setting that needs more than a switch. */
  action?: { label: string; onClick: () => void };
  /** Disclosure this option's control and action point at via aria-describedby. */
  disclosureId?: string;
};

export type IntegrationChoiceOption = {
  kind: "choice";
  id: string;
  label: string;
  description?: string;
  value: string;
  choices: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  busy?: boolean;
  onChange: (value: string) => void;
  action?: { label: string; onClick: () => void };
  disclosureId?: string;
};

/** A row whose only control is its action link (e.g. one entry per installation). */
export type IntegrationLinkOption = {
  kind: "link";
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  action: { label: string; onClick: () => void };
  disclosureId?: string;
};

export type IntegrationOption =
  | IntegrationToggleOption
  | IntegrationChoiceOption
  | IntegrationLinkOption;

/**
 * Closed footer set. `connected` and `repair` both render Reconnect + Disconnect
 * (Reconnect is primary only for `repair`); `setup` renders one Set up button;
 * `locked` renders the adapter-supplied sentence, defaulting to the
 * admin-managed one.
 */
export type IntegrationFooter =
  | {
      kind: "connected" | "repair";
      onReconnect: () => void;
      onDisconnect: () => void;
      reconnectDisabled?: boolean;
      disconnectDisabled?: boolean;
      busy?: boolean;
      /** Disclosure the Reconnect button points at via aria-describedby. */
      disclosureId?: string;
    }
  | {
      kind: "setup";
      onSetup: () => void;
      disabled?: boolean;
      busy?: boolean;
      /** Disclosure the Set up button points at via aria-describedby. */
      disclosureId?: string;
    }
  | { kind: "locked"; message?: string };

/**
 * A provider-supplied consent/limited-use disclosure the sheet renders in a
 * fixed place. Affordances reference one by `disclosureId` (aria-describedby).
 */
export type IntegrationDisclosure = { id: string; text: string };

/**
 * The tool/function names a connected integration actually publishes, shown as
 * a flat informational chip grid (no toggles, no per-tool detail). Populated
 * only from an already-available cheap source (a stored allowlist); omitted
 * entirely when no such source exists for the adapter.
 */
export type IntegrationToolsBlock = {
  /** Defaults to "Tools" when rendered without one. */
  title?: string;
  tools: string[];
};

export type IntegrationViewModel = {
  id: string;
  name: string;
  description: string;
  mark: IntegrationMark;
  chip: IntegrationChip;
  connection: IntegrationFact[];
  access?: IntegrationAccess;
  options: IntegrationOption[];
  footer: IntegrationFooter;
  /** The tools this connection actually publishes; omitted when unavailable. */
  tools?: IntegrationToolsBlock;
  /** Optional plain-language notice shown above the blocks (state explanations). */
  notice?: {
    tone: "muted" | "waiting" | "failed";
    title: string;
    description?: string;
    /** Optional recovery affordance (e.g. Retry after a failed load). */
    action?: { label: string; onClick: () => void };
  };
  /** Provider disclosures rendered after the blocks, before the footer. */
  disclosures?: IntegrationDisclosure[];
};

export const INTEGRATION_LOCKED_SENTENCE =
  "A workspace admin looks after this integration. You do not need to connect anything.";
