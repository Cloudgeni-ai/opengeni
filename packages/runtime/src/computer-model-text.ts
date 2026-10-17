/**
 * The model's text view of computer tool results.
 *
 * A computer tool result keeps its complete typed value in
 * `structuredContent` for Code Mode, the API and the UI. What the model reads
 * is this text: one line per useful accessibility element, in the role/name
 * vocabulary that computer_act locators use. Desktop accessibility trees are
 * far noisier than web pages: a Linux AT-SPI window repeats platform metadata
 * on every node, names unlabeled containers after their role, and keeps
 * hundreds of hidden elements. As JSON one browser window costs over 20k
 * tokens; this view keeps what the model can read or act on.
 */

export type ComputerTextNode = {
  ref: string;
  role: string;
  identifier?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  value?: string | { redacted: true; reason: string } | undefined;
  states: readonly string[];
  actions: readonly string[];
  children?: readonly ComputerTextNode[] | undefined;
};

export type ComputerTextTarget = {
  id: string;
  kind: string;
  title: string;
  processId: number | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  focused: boolean;
};

export type ComputerTextObservation = {
  observationId: string;
  target: ComputerTextTarget & { targetGeneration: string };
  frameId: string | null;
  capturedFrame?: { width: number; height: number } | undefined;
  semantic:
    | { kind: "snapshot"; roots: readonly ComputerTextNode[]; nodeCount: number }
    | {
        kind: "diff";
        baseObservationId: string;
        removedRefs: readonly string[];
        changed: readonly ComputerTextNode[];
      }
    | null;
  focusedRef: string | null;
  changedRegions: readonly unknown[];
};

/** Containers that carry no meaning of their own when they have no label:
 * their children are listed in their place. */
const CONTAINER_ROLES: ReadonlySet<string> = new Set([
  "AXGroup",
  "AXLayoutArea",
  "AXScrollArea",
  "AXSplitGroup",
  "Custom",
  "Pane",
  "filler",
  "generic",
  "group",
  "grouping",
  "layered pane",
  "panel",
  "redundant object",
  "scroll pane",
  "section",
  "unknown",
  "viewport",
]);

/** Text roles: locate them by text. A ref is listed only when they report a
 * specific action. */
const TEXT_ROLES: ReadonlySet<string> = new Set([
  "AXStaticText",
  "caption",
  "heading",
  "label",
  "paragraph",
  "static",
  "text",
]);

/** Layout roles: listed for orientation, but located by role and name, so
 * their refs are left out unless they report a specific action. */
const LAYOUT_ROLES: ReadonlySet<string> = new Set([
  ...TEXT_ROLES,
  "AXList",
  "footer",
  "form",
  "header",
  "landmark",
  "list",
  "list item",
  "menu bar",
  "page tab list",
  "separator",
  "tool bar",
]);

/** Actions every element reports; listing them repeats the same words on
 * every line. */
const COMMON_ACTIONS: ReadonlySet<string> = new Set(["focus", "invoke", "scroll_into_view"]);

/** States worth a model's attention. Platform bookkeeping states (enabled,
 * sensitive, showing, visible, focusable, ...) are left out; a control that
 * lacks them is reported as disabled or offscreen instead. */
const SHOWN_STATES: ReadonlySet<string> = new Set([
  "busy",
  "checked",
  "disabled",
  "expanded",
  "focused",
  "indeterminate",
  "invalid",
  "invalid-entry",
  "modal",
  "pressed",
  "read-only",
  "readonly",
  "required",
  "selected",
]);

const MAX_NAME_CHARS = 500;
const MAX_VALUE_CHARS = 2_000;

function quoted(value: string): string {
  return JSON.stringify(value);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type Clip = { clipped: number };

function clipped(value: string, limit: number, clip: Clip): string {
  if (value.length <= limit) return value;
  clip.clipped += 1;
  return `${value.slice(0, limit)}…`;
}

/** A label that is only the role repeated (AT-SPI's fallback) is no label. */
function meaningfulName(node: ComputerTextNode): string | undefined {
  const name = node.name?.trim();
  return name && name !== node.role ? name : undefined;
}

function visibleValue(node: ComputerTextNode): ComputerTextNode["value"] {
  if (node.value === undefined) return undefined;
  if (typeof node.value !== "string") return node.value;
  return node.value !== "" && node.value !== node.name ? node.value : undefined;
}

type TreeConventions = {
  /** The platform marks rendered elements (AT-SPI `showing`). */
  reportsShowing: boolean;
  /** The platform marks usable elements (AT-SPI `enabled`). */
  reportsEnabled: boolean;
};

function conventions(roots: readonly ComputerTextNode[]): TreeConventions {
  let reportsShowing = false;
  let reportsEnabled = false;
  const visit = (nodes: readonly ComputerTextNode[]) => {
    for (const node of nodes) {
      if (node.states.includes("showing")) reportsShowing = true;
      if (node.states.includes("enabled")) reportsEnabled = true;
      if (reportsShowing && reportsEnabled) return;
      if (node.children) visit(node.children);
    }
  };
  visit(roots);
  return { reportsShowing, reportsEnabled };
}

function specificActions(node: ComputerTextNode): string[] {
  return node.actions.filter((action) => !COMMON_ACTIONS.has(action));
}

/** The actions worth naming on a line: of a select/deselect or
 * expand/collapse pair only the one that changes the current state. */
function listedActions(node: ComputerTextNode): string[] {
  const actions = specificActions(node);
  const selected = node.states.includes("selected");
  const expanded = node.states.includes("expanded");
  return actions.filter((action) => {
    if (action === "deselect") return selected || !actions.includes("select");
    if (action === "select") return !selected || !actions.includes("deselect");
    if (action === "collapse") return expanded || !actions.includes("expand");
    if (action === "expand") return !expanded || !actions.includes("collapse");
    return true;
  });
}

/** Refs the platform marks as observation-only cannot be acted on. */
function actionableRef(ref: string): boolean {
  return !ref.startsWith("read-only:");
}

function computerNodeLine(
  node: ComputerTextNode,
  depth: number,
  tree: TreeConventions,
  offscreen: boolean,
  focused: boolean,
  clip: Clip,
): string {
  const parts = [`${"  ".repeat(depth)}- ${node.role}`];
  const name = meaningfulName(node);
  if (name) parts.push(quoted(clipped(name, MAX_NAME_CHARS, clip)));
  const actions = listedActions(node);
  if (actionableRef(node.ref) && (!LAYOUT_ROLES.has(node.role) || actions.length > 0)) {
    parts.push(`[${node.ref}]`);
  }
  if (node.identifier) parts.push(`id=${quoted(node.identifier)}`);
  const value = visibleValue(node);
  if (value !== undefined) {
    parts.push(
      typeof value === "string"
        ? `value=${quoted(clipped(value, MAX_VALUE_CHARS, clip))}`
        : "value=<redacted>",
    );
  }
  if (node.description && node.description !== node.name) {
    parts.push(`description=${quoted(clipped(node.description, MAX_NAME_CHARS, clip))}`);
  }
  const states = node.states.filter((state) => SHOWN_STATES.has(state));
  if (focused && !states.includes("focused")) states.push("focused");
  if (
    tree.reportsEnabled &&
    !node.states.includes("enabled") &&
    !states.includes("disabled") &&
    node.actions.length > 0 &&
    !TEXT_ROLES.has(node.role)
  ) {
    states.push("disabled");
  }
  if (node.states.includes("expandable") && !node.states.includes("expanded")) {
    states.push("collapsed");
  }
  if (offscreen) states.push("offscreen");
  parts.push(...states);
  if (actions.length > 0) parts.push(`(${actions.join(", ")})`);
  return parts.join(" ");
}

/** Lines for a forest of nodes. Unlabeled containers are replaced by their
 * children; elements the platform reports as not rendered are left out unless
 * they carry a label or value, which are then marked offscreen. */
export function computerNodeLines(
  roots: readonly ComputerTextNode[],
  options: { focusedRef?: string | null | undefined; tree?: TreeConventions } = {},
): { lines: string[]; listed: number; omitted: number; clipped: number; focusedListed: boolean } {
  const tree = options.tree ?? conventions(roots);
  const clip: Clip = { clipped: 0 };
  const lines: string[] = [];
  let omitted = 0;
  let focusedListed = false;
  const visit = (
    nodes: readonly ComputerTextNode[],
    depth: number,
    parentName: string | undefined,
  ) => {
    for (const node of nodes) {
      const name = meaningfulName(node);
      const value = visibleValue(node);
      const labelled = name !== undefined || value !== undefined || Boolean(node.description);
      const focused = node.ref === options.focusedRef || node.states.includes("focused");
      // AT-SPI: `visible` without `showing` is content scrolled out of view;
      // neither is a widget that is not rendered at all (hidden toolbar
      // buttons, closed panels).
      const showing = !tree.reportsShowing || node.states.includes("showing");
      const hidden = !showing && !node.states.includes("visible") && !focused;
      const offscreen = !showing && !hidden;
      const plain = !focused && !node.identifier && specificActions(node).length === 0;
      const container =
        plain && !labelled && (CONTAINER_ROLES.has(node.role) || TEXT_ROLES.has(node.role));
      // A heading or label whose text node only repeats it.
      const repeatedText =
        plain &&
        TEXT_ROLES.has(node.role) &&
        value === undefined &&
        name !== undefined &&
        name === parentName &&
        !node.children?.length;
      // Nothing to read, act on or descend into (macOS table rows whose cells
      // the platform did not expose).
      const empty = plain && !labelled && node.actions.length === 0 && !node.children?.length;
      if (hidden || container || repeatedText || empty || (offscreen && !labelled && !focused)) {
        omitted += 1;
        if (!hidden && node.children) visit(node.children, depth, parentName);
        continue;
      }
      if (node.ref === options.focusedRef) focusedListed = true;
      lines.push(computerNodeLine(node, depth, tree, offscreen, focused, clip));
      if (node.children) visit(node.children, depth + 1, name);
    }
  };
  visit(roots, 0, undefined);
  return { lines, listed: lines.length, omitted, clipped: clip.clipped, focusedListed };
}

function boundsText(bounds: ComputerTextTarget["bounds"]): string | null {
  if (!bounds || (bounds.width === 0 && bounds.height === 0)) return null;
  return `at ${bounds.x},${bounds.y} size ${bounds.width}x${bounds.height}`;
}

export function computerTargetLine(target: ComputerTextTarget): string {
  const parts = [`${target.kind} ${target.id} ${quoted(target.title)}`];
  if (target.processId !== null) parts.push(`pid ${target.processId}`);
  const bounds = target.kind === "app" ? null : boundsText(target.bounds);
  if (bounds) parts.push(bounds);
  if (target.focused) parts.push("focused");
  return parts.join(" ");
}

export function computerObservationText(observation: ComputerTextObservation): string {
  const lines = [computerTargetLine(observation.target)];
  const fence = [
    `Observation ${observation.observationId}`,
    `target generation ${observation.target.targetGeneration}`,
  ];
  if (observation.frameId) fence.push(`frame ${observation.frameId}`);
  lines.push(fence.join(", "));
  if (observation.capturedFrame) {
    lines.push(
      `Screenshot ${observation.capturedFrame.width}x${observation.capturedFrame.height} pixels; pointer x,y use these pixels.`,
    );
  }
  if (observation.changedRegions.length > 0) {
    lines.push(`Changed regions: ${JSON.stringify(observation.changedRegions)}`);
  }
  const semantic = observation.semantic;
  if (!semantic) {
    lines.push("No accessibility tree is available for this target; use the screenshot.");
    return lines.join("\n");
  }
  const roots = semantic.kind === "snapshot" ? semantic.roots : semantic.changed;
  const rendered = computerNodeLines(roots, { focusedRef: observation.focusedRef });
  if (observation.focusedRef && !rendered.focusedListed) {
    lines.push(`Focused element: ${observation.focusedRef}`);
  }
  if (semantic.kind === "diff") {
    lines.push(`Changed elements since ${semantic.baseObservationId}:`);
  } else if (rendered.listed === 0) {
    lines.push("The accessibility tree has no readable elements; use the screenshot.");
  }
  lines.push(...rendered.lines);
  const notes = [
    rendered.omitted
      ? `${plural(rendered.omitted, "hidden, unlabeled or repeated element")} not shown`
      : null,
    semantic.kind === "diff" && semantic.removedRefs.length > 0
      ? `${plural(semantic.removedRefs.length, "earlier element")} removed`
      : null,
    rendered.clipped ? `${plural(rendered.clipped, "long field")} clipped` : null,
  ].filter((entry): entry is string => entry !== null);
  if (notes.length) lines.push(`(${notes.join("; ")})`);
  return lines.join("\n");
}

const PLACEMENT_LABELS: Record<string, string> = {
  sandbox_group: "the managed sandbox",
  connected_machine: "a Connected Machine",
  external_provider: "a remote computer provider",
  attached_device: "the user's device",
};

const CAPABILITY_LABELS: Record<string, string> = {
  semanticObservation: "accessibility tree",
  appDiscovery: "app discovery",
  appLaunch: "app launch",
  windowCapture: "window screenshots",
  screenCapture: "screen screenshots",
  semanticActions: "semantic actions",
  pointerInput: "pointer input",
  keyboardInput: "keyboard input",
  clipboard: "clipboard",
  backgroundActions: "background actions",
  parallelApps: "parallel apps",
};

export function computerSessionLine(session: {
  id: string;
  lifecycle: string;
  placement: { kind: string };
  platform: string | null;
  adapter: string | null;
  displayId: string | null;
  capabilities: Record<string, boolean | undefined> | null;
  failureCode: string | null;
}): string {
  const placement = PLACEMENT_LABELS[session.placement.kind] ?? session.placement.kind;
  const facts = [
    session.adapter ? `adapter ${session.adapter}` : null,
    session.displayId ? `display ${session.displayId}` : null,
    session.failureCode ? `failure ${session.failureCode}` : null,
  ].filter((entry): entry is string => entry !== null);
  const lines = [
    `ComputerSession ${session.id} (${session.lifecycle}): ${session.platform ?? "computer"} on ${placement}${
      facts.length ? `, ${facts.join(", ")}` : ""
    }`,
  ];
  const capabilities = session.capabilities;
  if (capabilities) {
    const missing = Object.entries(CAPABILITY_LABELS)
      .filter(([key]) => capabilities[key] === false)
      .map(([, label]) => label);
    if (missing.length) lines.push(`Not available: ${missing.join(", ")}`);
    lines.push(
      capabilities.backgroundInput === true
        ? "Pointer and keyboard input stay in the background."
        : "Pointer and keyboard input use the foreground seat.",
    );
  }
  return lines.join("\n");
}

export function computerTargetsText(targets: readonly ComputerTextTarget[]): string {
  if (targets.length === 0) return "No apps, windows or screens are available.";
  return [`${plural(targets.length, "target")}:`, ...targets.map(computerTargetLine)].join("\n");
}

export function computerOpenText(output: {
  session: Parameters<typeof computerSessionLine>[0];
  targets: readonly ComputerTextTarget[];
}): string {
  return `${computerSessionLine(output.session)}\n${computerTargetsText(output.targets)}`;
}

export function computerActionText(receipt: {
  operationId: string;
  targetId: string;
  state: string;
  error: ({ code: string; message: string; retryable: boolean } & Record<string, unknown>) | null;
  observation: (ComputerTextObservation & { capturedFrame?: undefined }) | null;
}): string {
  const lines = [
    `Action ${receipt.state} on ${receipt.targetId} (operation ${receipt.operationId}).`,
  ];
  if (receipt.error) {
    const { code, message, retryable, ...details } = receipt.error;
    lines.push(
      `Error ${code}${retryable ? " (retryable)" : ""}: ${message}${
        Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""
      }`,
    );
  }
  if (receipt.observation) lines.push(computerObservationText(receipt.observation));
  return lines.join("\n");
}
