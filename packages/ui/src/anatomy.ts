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
