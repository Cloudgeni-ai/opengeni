/**
 * The one shape every Opengeni-run integration renders through.
 *
 * `IntegrationRow` and `IntegrationSheet` know nothing about Slack, GitHub,
 * Google Drive, or Atlassian: each provider has an adapter hook that maps its
 * own data into this plain view-model, choosing the facts, access list,
 * options, and footer for the viewer's role. Empty blocks are omitted by the
 * sheet; the frame itself never varies.
 */

import type { ReactNode } from "react";
import type { CapabilityCatalogStatus } from "../../../connect";

export type IntegrationChipTone = "ok" | "warn" | "idle" | "plain";

export type IntegrationChipLabel =
  | "Connected"
  | "Needs attention"
  | "Not connected"
  | "Set up by an admin"
  | "Retired"
  | "Unavailable"
  | "Access restricted"
  | "Loading"
  | "Installed"
  | "Not installed"
  | "Update available"
  | "Installing";

export type IntegrationChip = {
  label: IntegrationChipLabel;
  tone: IntegrationChipTone;
};

/** Keep catalog exceptions explicit without showing routine connected/not-connected text. */
export function catalogStatusForChip(chip: IntegrationChip): CapabilityCatalogStatus {
  if (chip.label === "Loading" || chip.label === "Installing") return "loading";
  if (chip.tone === "warn") return "attention";
  if (chip.tone === "ok") return "added";
  if (chip.tone === "plain") return "unavailable";
  return "available";
}

export type IntegrationMark = { logoSrc: string; monogram: string } | { monogram: string };

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
  id?: string | undefined;
  name: string;
  meta?: string | undefined;
  /** Status dot color for a multi-account entry ("ok" green, "warn" amber). Omitted for a plain resource row. */
  status?: "ok" | "warn" | undefined;
  /** Sub-entries rendered under this one (e.g. the folders an account contributes). */
  subItems?: Array<{ name: string; meta?: string | undefined }> | undefined;
  /** Shown in place of an empty `subItems` list, when the absence itself is the fact. */
  subItemsEmptyMessage?: string | undefined;
  /** Inline per-item actions (e.g. "Reconnect", "Remove") rendered at the end of the row. */
  actions?:
    | Array<{
        label: string;
        onClick: () => void;
        disabled?: boolean | undefined;
        /** Disclosure this action points at via aria-describedby. */
        disclosureId?: string | undefined;
        /** Renders in the destructive tone (still confirm before destroying). */
        destructive?: boolean | undefined;
      }>
    | undefined;
  /**
   * Per-entry expandable detail rendered under the row - the one slot deep
   * per-instance surfaces (the Integration facets panel) mount into, so they
   * stay scoped to exactly this account instead of the whole provider row.
   */
  detail?: ReactNode | undefined;
};

export type IntegrationAccess = {
  title: string;
  /** The single edit affordance for this block. Omitted when the viewer cannot change it. */
  editLabel?: string | undefined;
  onEdit?: (() => void) | undefined;
  /** Keep the edit affordance visible but inert (e.g. while a mutation is in flight). */
  editDisabled?: boolean | undefined;
  /** Disclosure the edit affordance points at via aria-describedby. */
  editDisclosureId?: string | undefined;
  items: IntegrationAccessItem[];
  /** Shown instead of the list when there is nothing scoped yet. */
  emptyMessage?: string | undefined;
};

export type IntegrationToggleOption = {
  kind: "toggle";
  id: string;
  label: string;
  description?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  onChange: (checked: boolean) => void;
  /** Optional secondary affordance for a setting that needs more than a switch. */
  action?: { label: string; onClick: () => void } | undefined;
  /** Disclosure this option's control and action point at via aria-describedby. */
  disclosureId?: string | undefined;
};

export type IntegrationChoiceOption = {
  kind: "choice";
  id: string;
  label: string;
  description?: string | undefined;
  value: string;
  choices: Array<{ value: string; label: string; disabled?: boolean | undefined }>;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  onChange: (value: string) => void;
  action?: { label: string; onClick: () => void } | undefined;
  disclosureId?: string | undefined;
};

/** A row whose only control is its action link (e.g. one entry per installation). */
export type IntegrationLinkOption = {
  kind: "link";
  id: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
  action: { label: string; onClick: () => void };
  disclosureId?: string | undefined;
};

export type IntegrationOption =
  | IntegrationToggleOption
  | IntegrationChoiceOption
  | IntegrationLinkOption;

/**
 * Closed footer set. `connected` and `repair` both render Reconnect + Disconnect
 * (Reconnect is primary only for `repair`); `setup` renders one Set up button;
 * `actions` renders up to two caller-labelled buttons for a surface whose verbs
 * are not connect/disconnect; `locked` renders the adapter-supplied sentence,
 * defaulting to the admin-managed one.
 */
export type IntegrationFooter =
  | {
      kind: "connected" | "repair";
      onReconnect: () => void;
      onDisconnect: () => void;
      reconnectDisabled?: boolean | undefined;
      disconnectDisabled?: boolean | undefined;
      busy?: boolean | undefined;
      /** Disclosure the Reconnect button points at via aria-describedby. */
      disclosureId?: string | undefined;
    }
  | {
      kind: "setup";
      onSetup: () => void;
      disabled?: boolean | undefined;
      busy?: boolean | undefined;
      /** Disclosure the Set up button points at via aria-describedby. */
      disclosureId?: string | undefined;
    }
  | {
      /**
       * Up to two caller-labelled actions, for a surface whose real verbs are
       * not connect/disconnect (installing or removing a Bundle). Still a fixed
       * frame: one primary button, one optional secondary, nothing else.
       */
      kind: "actions";
      primary?:
        | {
            label: string;
            onClick: () => void;
            disabled?: boolean | undefined;
            /** Explains why the action is unavailable, surfaced as the button title. */
            unavailableReason?: string | undefined;
          }
        | undefined;
      secondary?:
        | {
            label: string;
            onClick: () => void;
            disabled?: boolean | undefined;
            /** Renders in the destructive tone (still confirm before destroying). */
            destructive?: boolean | undefined;
          }
        | undefined;
      busy?: boolean | undefined;
      /** Disclosure the primary action points at via aria-describedby. */
      disclosureId?: string | undefined;
    }
  | { kind: "locked"; message?: string | undefined };

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
  title?: string | undefined;
  tools: string[];
};

export type IntegrationViewModel = {
  id: string;
  name: string;
  description: string;

  accessibleDetail?: string | undefined;
  mark: IntegrationMark;
  chip: IntegrationChip;
  connection: IntegrationFact[];
  access?: IntegrationAccess | undefined;
  options: IntegrationOption[];
  footer: IntegrationFooter;
  /** Optional progressive disclosure for integrations with a simple everyday surface. */
  presentation?:
    | {
        summary: { title: string; description: string };
        routing?:
          | {
              description: string;
              action?:
                | { label: string; onClick: () => void; disabled?: boolean | undefined }
                | undefined;
            }
          | undefined;
        diagnostics?: IntegrationFact[] | undefined;
      }
    | undefined;
  /** What it lets agents do, in product words (up to four). Shown on the page's About section. */
  outcomes?: Array<{ title: string; description?: string | undefined }> | undefined;
  /** The tools this connection actually publishes; omitted when unavailable. */
  tools?: IntegrationToolsBlock | undefined;
  toolPermissions?: { workspaceId: string; capabilityId: string } | undefined;
  /** Optional plain-language notice shown above the blocks (state explanations). */
  notice?:
    | {
        tone: "muted" | "waiting" | "failed";
        title: string;
        description?: string | undefined;
        /** Optional recovery affordance (e.g. Retry after a failed load). */
        action?: { label: string; onClick: () => void; disabled?: boolean | undefined } | undefined;
        onDismiss?: (() => void) | undefined;
      }
    | undefined;
  /** Provider disclosures rendered after the blocks, before the footer. */
  disclosures?: IntegrationDisclosure[] | undefined;
};

/** An initial 403 is not an indefinitely pending connection status. */
export function connectionAccessChip(
  chip: IntegrationChip,
  accessDenied: boolean,
): IntegrationChip {
  return accessDenied && chip.label === "Loading"
    ? { label: "Access restricted", tone: "plain" }
    : chip;
}

/** Keep the sheet's explanation and actions consistent with its restricted tile. */
export function connectionAccessModel(
  model: IntegrationViewModel,
  accessDenied: boolean,
): IntegrationViewModel {
  if (!accessDenied || model.chip.label !== "Loading") return model;
  return {
    ...model,
    chip: connectionAccessChip(model.chip, true),
    notice: {
      tone: "waiting",
      title: "Connection access required",
      description: "Ask a workspace admin for connection access to view connected accounts.",
    },
    footer: { kind: "locked" },
  };
}

export const INTEGRATION_LOCKED_SENTENCE =
  "A workspace admin looks after this integration. You do not need to connect anything.";
