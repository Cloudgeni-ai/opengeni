/**
 * The model's text view of computer tool results.
 *
 * A computer tool result keeps its complete typed value in
 * `structuredContent` for Code Mode, the API and the UI. What the model reads
 * is this text: one line per useful accessibility element (a run of plain
 * menu bar items shares one), in the role/name vocabulary that computer_act
 * locators use. Desktop accessibility trees are
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
  bounds?: { x: number; y: number; width: number; height: number } | null | undefined;
  children?: readonly ComputerTextNode[] | undefined;
};

export type ComputerTextTarget = {
  id: string;
  kind: string;
  title: string;
  processId: number | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  focused: boolean;
  offScreen?: true | undefined;
};

export type ComputerTextObservation = {
  observationId: string;
  target: ComputerTextTarget & { targetGeneration: string };
  frameId: string | null;
  capturedFrame?:
    | {
        width: number;
        height: number;
        /** A zoomed frame: the rectangle it shows, in the pixels of the
         *  `regionFrame` screenshot it was measured on. */
        region?: { x: number; y: number; width: number; height: number } | undefined;
        regionFrame?: { width: number; height: number } | undefined;
      }
    | undefined;
  semantic:
    | {
        kind: "snapshot";
        roots: readonly ComputerTextNode[];
        nodeCount: number;
        incomplete?: { reason: "time_budget" | "node_budget"; unreadCount: number } | undefined;
        readByNativeTools?: true | undefined;
      }
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
  // macOS lists a table's cells again under each AXColumn, as new elements
  // with the same role, label and bounds; the one listed first stands for
  // both.
  const listedAt = new Set<string>();
  let omitted = 0;
  let focusedListed = false;
  // The line of the menu bar items listed last and its depth, while the run
  // continues.
  let menuBar: { line: number; depth: number } | null = null;
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
      const place =
        node.bounds && (node.bounds.width > 0 || node.bounds.height > 0)
          ? JSON.stringify([
              node.role,
              name ?? null,
              value ?? null,
              node.bounds.x,
              node.bounds.y,
              node.bounds.width,
              node.bounds.height,
            ])
          : null;
      const listedElsewhere = !focused && place !== null && listedAt.has(place);
      if (
        hidden ||
        container ||
        repeatedText ||
        empty ||
        listedElsewhere ||
        (offscreen && !labelled && !focused)
      ) {
        omitted += 1;
        if (!hidden && node.children) visit(node.children, depth, parentName);
        continue;
      }
      if (place !== null) listedAt.add(place);
      if (node.ref === options.focusedRef) focusedListed = true;
      // A macOS menu bar lists a dozen plain items; one line holds them all.
      const disabled = tree.reportsEnabled && !node.states.includes("enabled");
      if (plainMenuBarItem(node, name, value, focused || disabled || offscreen)) {
        const item = `${quoted(clipped(name ?? "", MAX_NAME_CHARS, clip))} [${node.ref}]`;
        if (menuBar !== null && menuBar.line === lines.length - 1 && menuBar.depth === depth) {
          lines[menuBar.line] += `, ${item}`;
        } else {
          lines.push(`${"  ".repeat(depth)}- ${node.role} ${item}`);
          menuBar = { line: lines.length - 1, depth };
        }
        continue;
      }
      lines.push(computerNodeLine(node, depth, tree, offscreen, focused, clip));
      if (node.children) visit(node.children, depth + 1, name);
    }
  };
  visit(roots, 0, undefined);
  return { lines, listed: lines.length, omitted, clipped: clip.clipped, focusedListed };
}

/** A named menu bar item with nothing else to say: no value, state, own
 * action or children. */
function plainMenuBarItem(
  node: ComputerTextNode,
  name: string | undefined,
  value: ComputerTextNode["value"],
  marked: boolean,
): boolean {
  return (
    node.role === "AXMenuBarItem" &&
    name !== undefined &&
    value === undefined &&
    !marked &&
    !node.description &&
    !node.identifier &&
    actionableRef(node.ref) &&
    !node.children?.length &&
    listedActions(node).length === 0 &&
    !node.states.includes("expandable") &&
    !node.states.some((state) => SHOWN_STATES.has(state))
  );
}

function boundsText(bounds: ComputerTextTarget["bounds"]): string | null {
  if (!bounds || (bounds.width === 0 && bounds.height === 0)) return null;
  return `at ${bounds.x},${bounds.y} size ${bounds.width}x${bounds.height}`;
}

/** A screenshot coordinate as given, to at most one decimal. */
function pixels(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** How many zoomed pixels show one pixel of the measured screenshot. */
function zoomFactor(zoomedWidth: number, regionWidth: number): string {
  return String(Math.round((zoomedWidth / regionWidth) * 10) / 10);
}

export function computerTargetLine(target: ComputerTextTarget): string {
  const parts = [`${target.kind} ${target.id} ${quoted(target.title)}`];
  if (target.processId !== null) parts.push(`pid ${target.processId}`);
  const bounds = target.kind === "app" ? null : boundsText(target.bounds);
  if (bounds) parts.push(bounds);
  if (target.focused) parts.push("focused");
  if (target.offScreen) parts.push("off screen");
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
    const { width, height, region, regionFrame } = observation.capturedFrame;
    const measuredOn = regionFrame
      ? `the ${regionFrame.width}x${regionFrame.height} screenshot`
      : "the full screenshot";
    lines.push(
      region
        ? `Zoomed screenshot ${width}x${height} pixels of ${measuredOn}'s region at ${pixels(region.x)},${pixels(region.y)} size ${pixels(region.width)}x${pixels(region.height)} (${zoomFactor(width, region.width)}x); pointer x,y on frame ${observation.frameId} use these zoomed pixels.`
        : `Screenshot ${width}x${height} pixels; pointer x,y use these pixels.`,
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
  if (semantic.kind === "snapshot" && semantic.readByNativeTools) {
    lines.push(
      "Elements are not listed here because this session reads them with interaction__cua_get_window_state; reading them here too would invalidate its element tokens. Call interaction__cua_get_window_state for this window's elements.",
    );
    return lines.join("\n");
  }
  const roots = semantic.kind === "snapshot" ? semantic.roots : semantic.changed;
  const rendered = computerNodeLines(roots, { focusedRef: observation.focusedRef });
  if (observation.focusedRef && !rendered.focusedListed) {
    lines.push(`Focused element: ${observation.focusedRef}`);
  }
  if (semantic.kind === "diff") {
    lines.push(
      roots.length === 0 && semantic.removedRefs.length === 0
        ? `No element changed since ${semantic.baseObservationId}; its refs are still valid.`
        : `Changed elements since ${semantic.baseObservationId}; elements not listed are unchanged and keep their refs:`,
    );
  } else if (rendered.listed === 0) {
    lines.push(
      rendered.omitted
        ? `No element is listed: the accessibility tree's ${plural(rendered.omitted, "element")} are all hidden, unlabeled or repeated; use the screenshot.`
        : "The accessibility tree has no readable elements; use the screenshot.",
    );
  }
  lines.push(...rendered.lines);
  const notes = [
    rendered.omitted && rendered.listed > 0
      ? `${plural(rendered.omitted, "hidden, unlabeled or repeated element")} not shown`
      : null,
    semantic.kind === "diff" && semantic.removedRefs.length > 0
      ? `${plural(semantic.removedRefs.length, "earlier element")} removed`
      : null,
    rendered.clipped ? `${plural(rendered.clipped, "long field")} clipped` : null,
  ].filter((entry): entry is string => entry !== null);
  if (notes.length) lines.push(`(${notes.join("; ")})`);
  if (semantic.kind === "snapshot" && semantic.incomplete) {
    const { reason, unreadCount } = semantic.incomplete;
    const cause =
      reason === "node_budget" ? "it reached its element limit" : "the app answered too slowly";
    const unread =
      unreadCount > 0
        ? `; at least ${plural(unreadCount, "more element")} ${unreadCount === 1 ? "was" : "were"} not read`
        : "";
    lines.push(
      `Partial tree: reading stopped because ${cause}${unread}. Elements not listed here may still exist; use the screenshot for them.`,
    );
  }
  return lines.join("\n");
}

/** The part of an observation that differs from the earlier one of the same
 * window the model already read, for the reading an action returns. Refs
 * stay with their element across readings, so the model keeps acting on the
 * refs it holds and reads only what changed: one ribbon of fifty styles is
 * not repeated after every click, and an action that changed nothing says so.
 * A complete observation is kept whenever a diff would not be shorter or
 * cannot be exact: another window or document, nested trees, a partial
 * reading, or a reading in which most refs are new. */
export function computerObservationDiff<Observation extends ComputerTextObservation>(
  base: ComputerTextObservation,
  next: Observation,
): Observation | null {
  const before = base.semantic;
  const after = next.semantic;
  if (
    before?.kind !== "snapshot" ||
    after?.kind !== "snapshot" ||
    before.incomplete ||
    after.incomplete ||
    before.readByNativeTools ||
    after.readByNativeTools ||
    base.target.id !== next.target.id ||
    base.target.targetGeneration !== next.target.targetGeneration ||
    base.target.title !== next.target.title ||
    base.observationId === next.observationId ||
    [...before.roots, ...after.roots].some((node) => (node.children?.length ?? 0) > 0)
  )
    return null;
  const content = ({ bounds: _bounds, ...node }: ComputerTextNode & { bounds?: unknown }) =>
    JSON.stringify(node);
  const earlier = new Map(before.roots.map((node) => [node.ref, content(node)]));
  const changed = after.roots.filter((node) => earlier.get(node.ref) !== content(node));
  const kept = new Set(after.roots.map((node) => node.ref));
  const removedRefs = before.roots.map((node) => node.ref).filter((ref) => !kept.has(ref));
  if (changed.length * 2 > after.roots.length) return null;
  return {
    ...next,
    semantic: {
      kind: "diff",
      baseObservationId: base.observationId,
      removedRefs,
      changed,
    },
  };
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
  const lines = [`${plural(targets.length, "target")}:`, ...targets.map(computerTargetLine)];
  if (targets.some((target) => target.offScreen)) lines.push(OFF_SCREEN_NOTE);
  return lines.join("\n");
}

/** Fixed text, so a listing renders identically for the same targets. */
const OFF_SCREEN_NOTE =
  "A window marked off screen, such as one on another Space or a full-screen app, can be neither captured nor read until it is back on screen. Minimized windows and windows of hidden apps are not marked: reading one brings it back on screen behind the person's front window.";

export function computerOpenText(output: {
  session: Parameters<typeof computerSessionLine>[0];
  targets: readonly ComputerTextTarget[];
}): string {
  return `${computerSessionLine(output.session)}\n${computerTargetsText(output.targets)}`;
}

type ComputerTextError =
  | ({ code: string; message: string; retryable: boolean } & Record<string, unknown>)
  | null;

function computerErrorLine(error: NonNullable<ComputerTextError>): string {
  const { code, message, retryable, ...details } = error;
  return `Error ${code}${retryable ? " (retryable)" : ""}: ${message}${
    Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""
  }`;
}

type ComputerTextRoleStandIn = {
  actionIndex: number;
  requestedRole: string;
  role: string;
  name: string;
};

/** An action that named a button that is a link here, or a link that is a
 * button, and acted on it: says so, so the next call names the right role. */
function roleStandInLine(standIn: ComputerTextRoleStandIn, batch: boolean): string {
  const { requestedRole, role, name } = standIn;
  return `${batch ? `Action ${standIn.actionIndex + 1}` : "The action"} named ${requestedRole} ${quoted(name)}, but no ${requestedRole} here has that name, so it used the ${role} ${quoted(name)}; name it as role ${quoted(role)} next time.`;
}

export function computerActionText(
  receipt:
    | {
        type?: undefined;
        operationId: string;
        targetId: string;
        state: string;
        error: ComputerTextError;
        observation: (ComputerTextObservation & { capturedFrame?: undefined }) | null;
        roleStandIns?: readonly ComputerTextRoleStandIn[] | undefined;
        /** The action sent raw input (a pointer click, a key press, typed
         * text), which no computer driver confirms the app acted on. */
        rawInput?: boolean | undefined;
      }
    | {
        type: "batch";
        targetId: string;
        actionCount: number;
        steps: readonly { operationId: string; state: string; error: ComputerTextError }[];
        observation: (ComputerTextObservation & { capturedFrame?: undefined }) | null;
        observationPrecedesStop?: boolean | undefined;
        roleStandIns?: readonly ComputerTextRoleStandIn[] | undefined;
      },
): string {
  if (receipt.type === "batch") return computerBatchText(receipt);
  const lines = [
    `Action ${receipt.state} on ${receipt.targetId} (operation ${receipt.operationId}).`,
  ];
  if (receipt.error) lines.push(computerErrorLine(receipt.error));
  for (const standIn of receipt.roleStandIns ?? []) lines.push(roleStandInLine(standIn, false));
  const semantic = receipt.observation?.semantic;
  if (
    receipt.rawInput &&
    receipt.state === "completed" &&
    receipt.observation?.target.id === receipt.targetId &&
    semantic?.kind === "diff" &&
    semantic.changed.length === 0 &&
    semantic.removedRefs.length === 0
  )
    lines.push(
      "No element changed after this input, and apps do not confirm the input they receive, so it may not have taken effect: check the window before sending it again.",
    );
  if (receipt.observation && receipt.observation.target.id !== receipt.targetId)
    lines.push(
      `This action opened ${receipt.observation.target.id}; act on that target with the observation below.`,
    );
  if (receipt.observation) lines.push(computerObservationText(receipt.observation));
  return lines.join("\n");
}

function actionRange(first: number, last: number): string {
  return first === last ? `Action ${first}` : `Actions ${first} to ${last}`;
}

function computerBatchText(receipt: {
  targetId: string;
  actionCount: number;
  steps: readonly { operationId: string; state: string; error: ComputerTextError }[];
  observation: (ComputerTextObservation & { capturedFrame?: undefined }) | null;
  observationPrecedesStop?: boolean | undefined;
  roleStandIns?: readonly ComputerTextRoleStandIn[] | undefined;
}): string {
  const last = receipt.steps.at(-1);
  const lines: string[] = [];
  const opened =
    last?.state === "completed" &&
    receipt.observation &&
    receipt.observation.target.id !== receipt.targetId
      ? receipt.observation.target.id
      : null;
  if (last && last.state === "completed" && receipt.steps.length === receipt.actionCount) {
    lines.push(`Batch completed on ${receipt.targetId}: ${plural(receipt.actionCount, "action")}.`);
  } else if (opened) {
    const at = receipt.steps.length;
    lines.push(
      `Batch stopped on ${receipt.targetId} at action ${at} of ${receipt.actionCount}: action ${at} completed (operation ${last!.operationId}) and opened another window.`,
    );
    if (at > 1) lines.push(`${actionRange(1, at - 1)} completed.`);
    lines.push(
      `${actionRange(at + 1, receipt.actionCount)} ${
        at + 1 === receipt.actionCount ? "was" : "were"
      } not run.`,
    );
  } else {
    const at = receipt.steps.length;
    lines.push(
      `Batch stopped on ${receipt.targetId} at action ${at} of ${receipt.actionCount}: action ${at} ${
        last?.state ?? "did not run"
      } (operation ${last?.operationId ?? "none"}).`,
    );
    if (last?.error) lines.push(computerErrorLine(last.error));
    if (at > 1) lines.push(`${actionRange(1, at - 1)} completed.`);
    if (at < receipt.actionCount) {
      lines.push(
        `${actionRange(at + 1, receipt.actionCount)} ${
          at + 1 === receipt.actionCount ? "was" : "were"
        } not run.`,
      );
    }
    // Only a definite failure is known not to have acted.
    const uncertain = last !== undefined && last.state !== "failed";
    if (receipt.observationPrecedesStop) {
      lines.push(
        `The state below is from before action ${at}${
          uncertain ? ", which may have taken effect" : ""
        }; observe the window again before sending it or later actions.`,
      );
    } else if (uncertain) {
      lines.push(
        `Action ${at} may have taken effect: check the state below before sending it or later actions again.`,
      );
    }
  }
  if (opened)
    lines.push(
      `Action ${receipt.steps.length} opened ${opened}; act on that target with the observation below.`,
    );
  for (const standIn of receipt.roleStandIns ?? []) lines.push(roleStandInLine(standIn, true));
  if (receipt.observation) lines.push(computerObservationText(receipt.observation));
  return lines.join("\n");
}
