/**
 * Closed product-analytics labels for key controls. A control opts in with a
 * `data-analytics-action` attribute; the consent-gated click observer attaches
 * the label to `product_clicked` / `navigation_clicked` only when it is one of
 * these exact values. Never derive a label from visible text, user input, or
 * identifiers. Kept separate from the lazily loaded analytics module so pages
 * can label controls without pulling provider code into their bundle.
 *
 * `send`, `steer`, and `pause` are set by the `@opengeni/react` composer and
 * session chrome, so those three strings are part of that package's DOM.
 */
export const ANALYTICS_ACTIONS = [
  "new_session",
  "send",
  "steer",
  "pause",
  "connect_integration",
  "create_schedule",
  "install_skill",
  "invite_member",
  "buy_credits",
  "connect_model",
  "connect_codex",
  "connect_supergrok",
  "connect_ai_gateway",
  "connect_openrouter",
] as const;

export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[number];

const ACTIONS: ReadonlySet<string> = new Set(ANALYTICS_ACTIONS);

export function isAnalyticsAction(value: string | null | undefined): value is AnalyticsAction {
  return typeof value === "string" && ACTIONS.has(value);
}

/** Spread onto a control: `<Button {...analyticsAction("buy_credits")}>`. */
export function analyticsAction(action: AnalyticsAction | null | undefined): {
  "data-analytics-action"?: AnalyticsAction;
} {
  return action ? { "data-analytics-action": action } : {};
}
