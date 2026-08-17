/**
 * The one shape every OpenGeni-run integration renders through.
 *
 * `IntegrationRow` and `IntegrationSheet` know nothing about Slack, GitHub,
 * Google Drive, or Atlassian: each provider has an adapter hook that maps its
 * own data into this plain view-model, choosing the facts, access list,
 * options, and footer for the viewer's role. Empty blocks are omitted by the
 * sheet; the frame itself never varies.
 */

export type IntegrationChipTone = "ok" | "warn" | "idle" | "plain";

export type IntegrationChip = {
  label: "Connected" | "Needs attention" | "Not connected" | "Set up by an admin" | "Loading";
  tone: IntegrationChipTone;
};

export type IntegrationMark = { logoSrc: string; monogram: string } | { monogram: string };

export type IntegrationFact = {
  label: string;
  value: string;
};

export type IntegrationAccessItem = {
  name: string;
  meta?: string;
};

export type IntegrationAccess = {
  title: string;
  /** The single edit affordance for this block. Omitted when the viewer cannot change it. */
  editLabel?: string;
  onEdit?: () => void;
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
};

export type IntegrationOption = IntegrationToggleOption | IntegrationChoiceOption;

/**
 * Closed footer set. `connected` and `repair` both render Reconnect + Disconnect
 * (Reconnect is primary only for `repair`); `setup` renders one Set up button;
 * `locked` renders the admin-managed sentence.
 */
export type IntegrationFooter =
  | {
      kind: "connected" | "repair";
      onReconnect: () => void;
      onDisconnect: () => void;
      reconnectDisabled?: boolean;
      disconnectDisabled?: boolean;
      busy?: boolean;
    }
  | { kind: "setup"; onSetup: () => void; disabled?: boolean; busy?: boolean }
  | { kind: "locked" };

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
  /** Optional plain-language notice shown above the blocks (state explanations). */
  notice?: { tone: "muted" | "waiting" | "failed"; title: string; description?: string };
};

export const INTEGRATION_LOCKED_SENTENCE =
  "A workspace admin looks after this integration. You do not need to connect anything.";
