import type {
  BrowserAction,
  BrowserActionBatch,
  BrowserLocator,
  ComputerAction,
  ComputerActionBatch,
} from "./interaction";

/**
 * Declared bounds of the waits a controller runs inside one action. The
 * controllers use these exact values, and every layer that carries an action
 * request (the API's request to the controller, the connected-machine runner,
 * the runner's reply timer) derives its deadline from them, so a batch that
 * stays within its own declared waits is never cut off by a transport timer.
 */

/** A browser locator waits this long for its element to appear or enable. */
export const BROWSER_LOCATOR_WAIT_MS = 10_000;
/** An explicit browser wait without timeoutMs, the document-ready wait after a
 * navigation or history step, and an upload's file-chooser wait. */
export const BROWSER_DEFAULT_WAIT_MS = 30_000;
/** A navigation waits this long for its server to answer before it stops. */
export const BROWSER_NAVIGATION_COMMIT_TIMEOUT_MS = 20_000;
/** A named (non-ref) computer locator waits this long to appear and enable. */
export const COMPUTER_LOCATOR_WAIT_MS = 10_000;

/** No action request gets less than the transport's historical default, so a
 * single action keeps exactly the budget it always had. */
export const INTERACTION_ACTION_DEADLINE_FLOOR_MS = 60_000;
/** Fixed allowance per request for dispatch, the post-action settle and the
 * receipt's observation, which run once per request whatever its length. */
export const INTERACTION_ACTION_DEADLINE_MARGIN_MS = 30_000;
/** The longest any controller request may run. */
export const INTERACTION_ACTION_DEADLINE_MAX_MS = 20 * 60_000;

/** Input dispatch and round trips of one browser action beyond its waits. */
const BROWSER_ACTION_DISPATCH_MS = 2_000;
/** Input dispatch of one computer action plus its bounded settle. */
const COMPUTER_ACTION_DISPATCH_MS = 8_000;
/** A launched application's first window may take this long to appear. */
const COMPUTER_LAUNCH_WAIT_MS = 30_000;

/** The longest one browser action's own waits can take. */
export function browserActionMaxWaitMs(action: BrowserAction): number {
  const locators = (...values: (BrowserLocator | undefined)[]) =>
    values.filter((value) => value !== undefined).length * BROWSER_LOCATOR_WAIT_MS;
  const waits = (() => {
    switch (action.type) {
      case "navigate":
        return BROWSER_NAVIGATION_COMMIT_TIMEOUT_MS + BROWSER_DEFAULT_WAIT_MS;
      case "history":
        return BROWSER_DEFAULT_WAIT_MS;
      case "wait":
        return (action.timeoutMs ?? BROWSER_DEFAULT_WAIT_MS) + locators(action.locator);
      case "upload":
        return locators(action.locator) + BROWSER_DEFAULT_WAIT_MS;
      case "drag":
        return locators(action.from, action.to);
      case "click":
      case "double_click":
      case "hover":
      case "fill":
      case "select":
      case "check":
      case "type":
      case "press":
      case "scroll":
      case "clipboard":
        return locators(action.locator);
      case "activate":
      case "viewport":
      case "pointer":
      case "handle_dialog":
      case "permission":
        return 0;
    }
  })();
  return waits + BROWSER_ACTION_DISPATCH_MS;
}

/** The longest one computer action's own waits can take. */
export function computerActionMaxWaitMs(action: ComputerAction): number {
  switch (action.type) {
    case "semantic":
      return (
        (action.locator.kind === "ref" ? 0 : COMPUTER_LOCATOR_WAIT_MS) + COMPUTER_ACTION_DISPATCH_MS
      );
    case "launch":
      return COMPUTER_LAUNCH_WAIT_MS + COMPUTER_ACTION_DISPATCH_MS;
    case "keyboard":
    case "pointer":
    case "clipboard":
    case "focus":
      return COMPUTER_ACTION_DISPATCH_MS;
  }
}

function boundedDeadline(waitsMs: number): number {
  return Math.min(
    INTERACTION_ACTION_DEADLINE_MAX_MS,
    Math.max(INTERACTION_ACTION_DEADLINE_FLOOR_MS, waitsMs + INTERACTION_ACTION_DEADLINE_MARGIN_MS),
  );
}

/**
 * The request deadline for one browser action or batch: the sum of each
 * action's declared maximum wait plus a fixed margin, never below the
 * historical single-request default and never above the controller maximum.
 */
export function browserActionDeadlineMs(action: BrowserAction | BrowserActionBatch): number {
  const actions = action.type === "batch" ? action.actions : [action];
  return boundedDeadline(actions.reduce((sum, item) => sum + browserActionMaxWaitMs(item), 0));
}

/** The request deadline for one computer action or batch; see browserActionDeadlineMs. */
export function computerActionDeadlineMs(action: ComputerAction | ComputerActionBatch): number {
  const actions: readonly ComputerAction[] = action.type === "batch" ? action.actions : [action];
  return boundedDeadline(actions.reduce((sum, item) => sum + computerActionMaxWaitMs(item), 0));
}
