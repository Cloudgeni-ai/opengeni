export const OPEN_GENI_ICON_ROLES = [
  "send",
  "pause",
  "resume",
  "attach",
  "close",
  "disclosure",
  "approval",
  "reject",
  "queue",
  "goal",
  "tool",
  "agent",
  "browser",
  "terminal",
  "warning",
] as const;

export type OpenGeniIconRole = (typeof OPEN_GENI_ICON_ROLES)[number];

export type OpenGeniIconMap<Value> = Readonly<Record<OpenGeniIconRole, Value>>;

export function defineOpenGeniIconMap<Value>(
  icons: OpenGeniIconMap<Value>,
): OpenGeniIconMap<Value> {
  return Object.freeze({ ...icons });
}
