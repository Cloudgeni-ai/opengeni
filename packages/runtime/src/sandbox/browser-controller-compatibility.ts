/**
 * Browser action options that a browser controller from an older release
 * rejects.
 *
 * Every controller parses a whole action command strictly before it runs any
 * of it, so an option it does not know is refused with nothing dispatched; the
 * action's meaning is never silently changed. What an older controller cannot
 * say is which option it did not know. A controller embedded in the Opengeni
 * agent of a connected machine, attached browser device or compute sandbox
 * runs whatever agent release that machine has, so the server can be newer.
 * This list lets the server name the option and its alternative.
 *
 * Add an entry whenever the public browser action contract gains an option or
 * value; `test/browser-controller-compatibility.test.ts` fails until the new
 * public-api surface keys are listed here. Entries stay: machines can run old
 * agents for a long time.
 */

export type NewerBrowserActionOption = {
  /** Flattened public-api surface keys (`<schema> <path>`) this option added. */
  readonly surfaceKeys: readonly string[];
  /** The option as the agent writes it, for example `"exact"`. */
  readonly name: string;
  /** Where the option appears, completing "does not accept <name> on ...". */
  readonly context: string;
  /** What else achieves the same result, completing "Retry without <name>, or ...". */
  readonly alternative: string;
  /** True when the action, or any action of a batch, uses the option. */
  readonly usedBy: (action: unknown) => boolean;
};

export const NEWER_BROWSER_ACTION_OPTIONS: readonly NewerBrowserActionOption[] = [
  {
    // First accepted by agent 0.1.141.
    surfaceKeys: ["BrowserLocator $|kind=label.exact", "BrowserLocator $|kind=text.exact"],
    name: '"exact"',
    context: "a text or label locator",
    alternative: "target the element by its ref",
    usedBy: (action) =>
      someObject(
        action,
        (value) => (value.kind === "text" || value.kind === "label") && value.exact !== undefined,
      ),
  },
];

/** The plain refusal an agent sees when the controller rejected the action's
 * format. `controllerInAgent` is true when the controller ships inside the
 * Opengeni agent rather than a controller image. */
export function olderBrowserControllerMessage(action: unknown, controllerInAgent: boolean): string {
  const used = NEWER_BROWSER_ACTION_OPTIONS.filter((option) => option.usedBy(action));
  const subject = controllerInAgent
    ? "This browser's controller runs in an older Opengeni agent that"
    : "This browser's controller image is older than this server and";
  const update = controllerInAgent
    ? "Updating the agent adds support."
    : "Updating the controller image adds support.";
  if (used.length === 0) {
    return `${subject} does not accept this action. Nothing ran. Retry with fewer options, or target elements by ref. ${update}`;
  }
  const accepted = used.map((option) => `${option.name} on ${option.context}`).join(" or ");
  const names = used.map((option) => option.name).join(" or ");
  const alternatives = [...new Set(used.map((option) => option.alternative))];
  return `${subject} does not accept ${accepted}. Nothing ran. Retry without ${names}, or ${alternatives.join(", or ")}. ${update}`;
}

function someObject(value: unknown, matches: (value: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => someObject(item, matches));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return matches(record) || Object.values(record).some((item) => someObject(item, matches));
}
