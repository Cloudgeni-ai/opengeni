export const OPEN_GENI_COMPONENTS = [
  "session",
  "chrome",
  "status",
  "timeline",
  "timeline-row",
  "user-message",
  "composer",
  "attachments",
  "attachment",
  "queue",
  "queue-item",
  "approval",
  "human-input",
  "goal",
  "mcp-policy",
  "history",
  "fold",
  "dialog",
  "menu",
] as const;

export type OpenGeniComponentName = (typeof OPEN_GENI_COMPONENTS)[number];

export const OPEN_GENI_PARTS = [
  "header",
  "title",
  "description",
  "body",
  "content",
  "input",
  "footer",
  "controls",
  "actions",
  "item",
  "label",
  "metadata",
  "error",
  "empty",
  "badge",
  "icon",
  "preview",
] as const;

export type OpenGeniPartName = (typeof OPEN_GENI_PARTS)[number];

export const OPEN_GENI_STATES = [
  "idle",
  "loading",
  "ready",
  "streaming",
  "connecting",
  "reconnecting",
  "waiting",
  "paused",
  "submitting",
  "uploading",
  "failed",
  "disabled",
  "empty",
  "open",
  "closed",
] as const;

export type OpenGeniComponentState = (typeof OPEN_GENI_STATES)[number];

/**
 * Closed target inventory for cross-framework session parity. This inventory
 * is not qualification evidence: a capability is supported only when an
 * executable test mounts both renderers and exercises its listed states.
 */
export const OPEN_GENI_SESSION_PARITY_CAPABILITIES = {
  session: {
    components: ["session", "chrome", "status"],
    states: ["loading", "ready", "streaming", "waiting", "paused", "failed"],
  },
  timeline: {
    components: ["timeline", "timeline-row", "user-message", "history", "fold"],
    states: ["loading", "streaming", "ready", "failed", "empty", "open", "closed"],
  },
  composer: {
    components: ["composer", "attachments", "attachment", "menu"],
    states: ["loading", "ready", "submitting", "uploading", "failed", "disabled"],
  },
  queue: {
    components: ["queue", "queue-item"],
    states: ["ready", "submitting", "failed", "empty"],
  },
  approval: {
    components: ["approval"],
    states: ["waiting", "submitting", "failed"],
  },
  humanInput: {
    components: ["human-input"],
    states: ["waiting", "submitting", "failed", "open", "closed"],
  },
  goal: {
    components: ["goal"],
    states: ["loading", "ready", "submitting", "failed", "empty"],
  },
  mcpPolicy: {
    components: ["mcp-policy"],
    states: ["loading", "ready", "submitting", "failed", "disabled"],
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      components: readonly OpenGeniComponentName[];
      states: readonly OpenGeniComponentState[];
    }
  >
>;

export type OpenGeniSessionParityCapability = keyof typeof OPEN_GENI_SESSION_PARITY_CAPABILITIES;

export function openGeniAnatomy(options: {
  component: OpenGeniComponentName;
  part?: OpenGeniPartName | undefined;
  state?: OpenGeniComponentState | undefined;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    "data-og-component": options.component,
    ...(options.part ? { "data-og-part": options.part } : {}),
    ...(options.state ? { "data-og-state": options.state } : {}),
  });
}
