/**
 * The model's text view of browser tool results.
 *
 * A browser tool result keeps its complete typed value in `structuredContent`
 * for Code Mode, the API and the UI. What the model reads is this text: an
 * outline with one line per page element, in the role/name vocabulary that
 * locators use. It repeats no envelope keys, quoting or bookkeeping ids the
 * model never sends back, which makes a page view about half the tokens of
 * the same value as JSON.
 */

export type BrowserTextNode = {
  ref: string;
  role: string;
  depth: number;
  name?: string | undefined;
  description?: string | undefined;
  value?: string | { redacted: true; reason: string } | undefined;
  states?: readonly string[] | undefined;
  actions?: readonly string[] | undefined;
};

export type BrowserTextTarget = {
  id: string;
  kind: string;
  title: string;
  url: string;
  selected?: boolean | undefined;
  documentGeneration?: string | null | undefined;
};

export type BrowserTextObservation = {
  target: BrowserTextTarget;
  viewport?:
    | {
        width: number;
        height: number;
        deviceScaleFactor?: number | undefined;
        maxTouchPoints?: number | undefined;
      }
    | null
    | undefined;
  focusedRef?: string | null | undefined;
  changedRegions?: readonly unknown[] | undefined;
  diagnostics?:
    | {
        consoleErrorCount: number;
        failedRequestCount: number;
        downloadCount: number;
        pageErrorCount: number;
      }
    | null
    | undefined;
  dialog?: { type: string; message: string; defaultPrompt?: string | undefined } | null | undefined;
  screenshot?: unknown;
  agentView: {
    sourceKind: string;
    nodes: readonly BrowserTextNode[];
    omittedNodeCount?: number | undefined;
    omittedRegions?:
      | readonly { role: string; name?: string | undefined; count: number }[]
      | undefined;
    removedRefCount?: number | undefined;
    clippedFieldCount?: number | undefined;
  };
};

/** Text, structure and table-layout roles. Locate these by text or role and
 * name; listing their refs would cost every page view several tokens per line
 * for nodes that are almost never acted on. A complete view, a focused read,
 * and any node that reports actions still show every ref. */
const REFLESS_ROLES: ReadonlySet<string> = new Set([
  "article",
  "banner",
  "blockquote",
  "caption",
  "cell",
  "code",
  "columnheader",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "document",
  "emphasis",
  "figure",
  "form",
  "generic",
  "group",
  "heading",
  "insertion",
  "LabelText",
  "LineBreak",
  "list",
  "listitem",
  "log",
  "main",
  "mark",
  "navigation",
  "none",
  "note",
  "paragraph",
  "presentation",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "Section",
  "separator",
  "status",
  "strong",
  "subscript",
  "superscript",
  "table",
  "term",
  "text",
  "time",
]);

/** States every page repeats that tell the model nothing it can act on. */
function shownState(role: string, state: string): boolean {
  if (state === "focusable" || state === "settable" || state === "editable") return false;
  if (state.startsWith("editable=") || state.startsWith("url=")) return false;
  if (state.endsWith("=")) return false;
  if (role === "document" && state === "focused") return false;
  return true;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Longest form field value shown inline; browser_read mode=dom returns more. */
const SHOWN_VALUE_MAX_CHARS = 2_000;

function shownValue(value: string): string {
  if (value.length <= SHOWN_VALUE_MAX_CHARS) return `value=${quoted(value)}`;
  return `value=${quoted(`${value.slice(0, SHOWN_VALUE_MAX_CHARS)}…`)} valueChars=${value.length}`;
}

export function browserNodeLine(node: BrowserTextNode, allRefs: boolean, baseDepth = 0): string {
  const parts = [`${"  ".repeat(Math.max(0, node.depth - baseDepth))}- ${node.role}`];
  if (node.name) parts.push(quoted(node.name));
  if (allRefs || (node.actions?.length ?? 0) > 0 || !REFLESS_ROLES.has(node.role)) {
    parts.push(`[${node.ref}]`);
  }
  if (node.value !== undefined && node.value !== "") {
    parts.push(typeof node.value === "string" ? shownValue(node.value) : "value=<redacted>");
  }
  if (node.description) parts.push(`description=${quoted(node.description)}`);
  for (const state of node.states ?? []) if (shownState(node.role, state)) parts.push(state);
  return parts.join(" ");
}

export function browserTargetLine(target: BrowserTextTarget): string {
  const kind = target.kind === "page" ? "" : ` (${target.kind})`;
  const selected = target.selected ? " selected" : "";
  return `Tab ${target.id}${kind}${selected}: ${quoted(target.title)} ${target.url}`;
}

/** Indent relative to the shallowest listed node, so a view of a deeply
 * nested part of the page does not spend tokens on leading spaces. */
function shallowestDepth(nodes: readonly BrowserTextNode[]): number {
  let base = Number.POSITIVE_INFINITY;
  for (const node of nodes) base = Math.min(base, node.depth);
  return Number.isFinite(base) ? base : 0;
}

function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${noun}${/(?:s|x|ch|sh)$/.test(noun) ? "es" : "s"}`;
}

/** ": 950 in main, 40 in navigation "Menu"" for the largest omitted regions. */
function omittedRegionText(
  regions: readonly { role: string; name?: string | undefined; count: number }[] | undefined,
): string {
  if (!regions || regions.length === 0) return "";
  return `: ${regions
    .map(
      (region) =>
        `${region.count} in ${region.role}${region.name ? ` ${quoted(region.name)}` : ""}`,
    )
    .join(", ")}`;
}

export function browserObservationText(
  observation: BrowserTextObservation,
  options: { allRefs?: boolean } = {},
): string {
  const allRefs = options.allRefs === true;
  const lines = [browserTargetLine({ ...observation.target, selected: false })];
  const viewport = observation.viewport;
  if (viewport) {
    const extras = [
      viewport.deviceScaleFactor && viewport.deviceScaleFactor !== 1
        ? `scale ${viewport.deviceScaleFactor}`
        : null,
      viewport.maxTouchPoints ? `${viewport.maxTouchPoints} touch points` : null,
    ].filter((entry): entry is string => entry !== null);
    lines.push(
      `Viewport ${viewport.width}x${viewport.height}${extras.length ? ` (${extras.join(", ")})` : ""}`,
    );
  }
  const dialog = observation.dialog;
  if (dialog) {
    const prompt =
      dialog.type === "prompt" && dialog.defaultPrompt
        ? ` default ${quoted(dialog.defaultPrompt)}`
        : "";
    lines.push(`Open ${dialog.type} dialog: ${quoted(dialog.message)}${prompt}`);
  }
  const diagnostics = observation.diagnostics;
  if (diagnostics) {
    const reported = [
      diagnostics.consoleErrorCount ? plural(diagnostics.consoleErrorCount, "console error") : null,
      diagnostics.pageErrorCount ? plural(diagnostics.pageErrorCount, "page error") : null,
      diagnostics.failedRequestCount
        ? plural(diagnostics.failedRequestCount, "failed request")
        : null,
      diagnostics.downloadCount ? plural(diagnostics.downloadCount, "download") : null,
    ].filter((entry): entry is string => entry !== null);
    if (reported.length) lines.push(`Page reported ${reported.join(", ")}`);
  }
  if (observation.changedRegions && observation.changedRegions.length > 0) {
    lines.push(`Changed regions: ${JSON.stringify(observation.changedRegions)}`);
  }
  if (observation.screenshot) lines.push(`Screenshot: ${JSON.stringify(observation.screenshot)}`);
  const view = observation.agentView;
  const nodes = view.nodes;
  if (
    observation.focusedRef &&
    !nodes.some(
      (node) => node.ref === observation.focusedRef && (node.states ?? []).includes("focused"),
    )
  ) {
    lines.push(`Focused element: ${observation.focusedRef}`);
  }
  if (view.sourceKind === "none") {
    lines.push("No accessibility view is available for this tab.");
  } else if (view.sourceKind === "diff") {
    lines.push(
      nodes.length === 0 && !view.removedRefCount
        ? "No element changed since your last reading of this page; its refs are still valid."
        : "Changed elements since your last reading of this page; elements not listed are unchanged and keep their refs:",
    );
    for (const node of nodes) lines.push(browserNodeLine(node, allRefs, node.depth));
  } else {
    const base = shallowestDepth(nodes);
    for (const node of nodes) lines.push(browserNodeLine(node, allRefs, base));
  }
  const notes = [
    view.omittedNodeCount && view.sourceKind !== "diff"
      ? `${plural(view.omittedNodeCount, "element")} not shown${omittedRegionText(view.omittedRegions)}`
      : null,
    view.removedRefCount
      ? `${plural(view.removedRefCount, "element")} from your last reading ${view.removedRefCount === 1 ? "is" : "are"} gone or no longer listed`
      : null,
    view.clippedFieldCount ? `${plural(view.clippedFieldCount, "long field")} clipped` : null,
  ].filter((entry): entry is string => entry !== null);
  if (notes.length) lines.push(`(${notes.join("; ")})`);
  return lines.join("\n");
}

/**
 * The part of a page reading that differs from the reading of the same page
 * the model last saw, for the outline an action returns. A ref names the same
 * element for as long as its document lives, so the model keeps acting on the
 * refs it holds and reads only what the action changed: filling one field
 * returns that field, not the whole form again, and an action that changed
 * nothing says so. The whole outline is kept whenever a diff would not help
 * or could mislead: another tab, page or document, a page without an outline,
 * or a reading in which most of what the model saw changed.
 */
export function browserObservationDiff<Observation extends BrowserTextObservation>(
  base: BrowserTextObservation,
  next: Observation,
): Observation | null {
  if (
    base.agentView.sourceKind !== "snapshot" ||
    next.agentView.sourceKind !== "snapshot" ||
    base.target.id !== next.target.id ||
    base.target.url !== next.target.url ||
    (base.target.documentGeneration ?? null) !== (next.target.documentGeneration ?? null)
  )
    return null;
  // Indentation is relative to the view it was listed in, not the element.
  const content = ({ depth: _depth, ...node }: BrowserTextNode) => JSON.stringify(node);
  const earlier = new Map(base.agentView.nodes.map((node) => [node.ref, content(node)]));
  const changed = next.agentView.nodes.filter((node) => earlier.get(node.ref) !== content(node));
  const listed = new Set(next.agentView.nodes.map((node) => node.ref));
  const gone = base.agentView.nodes.filter((node) => !listed.has(node.ref)).length;
  const size = Math.max(base.agentView.nodes.length, next.agentView.nodes.length);
  if ((changed.length + gone) * 2 > size) return null;
  const { omittedRegions: _regions, ...view } = next.agentView;
  return {
    ...next,
    agentView: {
      ...view,
      sourceKind: "diff",
      nodes: changed.map((node) => ({ ...node, depth: 0 })),
      ...(gone > 0 ? { removedRefCount: gone } : {}),
    },
  };
}

export type BrowserTextResolvedTarget = {
  actionIndex: number;
  ref: string | null;
  role: string;
  name: string | null;
  container: { role: string; name: string | null } | null;
};

function resolvedTargetText(target: BrowserTextResolvedTarget): string {
  const parts = [`#${target.actionIndex} ${target.role}`];
  if (target.name) parts.push(quoted(target.name));
  if (target.ref) parts.push(`[${target.ref}]`);
  if (target.container) {
    parts.push(
      `in ${target.container.role}${target.container.name ? ` ${quoted(target.container.name)}` : ""}`,
    );
  }
  return parts.join(" ");
}

export function browserActionText(receipt: {
  targetId: string;
  state: string;
  error?:
    | ({ code: string; message: string; retryable: boolean } & Record<string, unknown>)
    | null
    | undefined;
  targets?: readonly BrowserTextResolvedTarget[] | undefined;
  observation?: BrowserTextObservation | null | undefined;
  allRefs?: boolean | undefined;
}): string {
  const lines = [`Action ${receipt.state} on tab ${receipt.targetId}.`];
  if (receipt.error) {
    const { code, message, retryable, ...details } = receipt.error;
    lines.push(
      `Error ${code}${retryable ? " (retryable)" : ""}: ${message}${
        Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""
      }`,
    );
  }
  if (receipt.targets && receipt.targets.length > 0) {
    lines.push(`Acted on: ${receipt.targets.map(resolvedTargetText).join("; ")}`);
  }
  if (receipt.observation) {
    lines.push(browserObservationText(receipt.observation, { allRefs: receipt.allRefs === true }));
  }
  return lines.join("\n");
}

const PLACEMENT_LABELS: Record<string, string> = {
  sandbox_group: "the managed sandbox",
  connected_machine: "a Connected Machine",
  external_provider: "a remote browser provider",
  attached_device: "the user's own Chrome",
};

export function browserSessionLine(session: {
  id: string;
  lifecycle: string;
  placement: { kind: string };
  engine?: string | null | undefined;
  headless?: boolean | null | undefined;
  identityId?: string | null | undefined;
  failureCode?: string | null | undefined;
}): string {
  const engine = session.engine ?? "browser";
  const mode =
    session.placement.kind === "attached_device" ? "" : session.headless ? " headless" : " headed";
  const placement = PLACEMENT_LABELS[session.placement.kind] ?? session.placement.kind;
  const extras = [
    session.identityId ? `identity ${session.identityId}` : null,
    session.failureCode ? `failure ${session.failureCode}` : null,
  ].filter((entry): entry is string => entry !== null);
  return `BrowserSession ${session.id} (${session.lifecycle}): ${engine}${mode} on ${placement}${
    extras.length ? `, ${extras.join(", ")}` : ""
  }`;
}

type AttachedProfileText = { id: string; name: string; profileLabel?: string | undefined };

function attachedProfileText(profile: AttachedProfileText): string {
  return `${quoted(profile.name)}${profile.profileLabel ? ` (${profile.profileLabel})` : ""} deviceId ${profile.id}`;
}

export function browserOpenText(output: {
  session: Parameters<typeof browserSessionLine>[0];
  targets: readonly BrowserTextTarget[];
  otherTabCount?: number | undefined;
  observation?: BrowserTextObservation | undefined;
  attachedProfile?: AttachedProfileText | undefined;
  otherAttachedProfiles?: readonly AttachedProfileText[] | undefined;
  notice?: string | undefined;
}): string {
  const lines = [browserSessionLine(output.session)];
  if (output.notice) lines.push(output.notice);
  if (output.attachedProfile) {
    lines.push(`Attached Chrome profile: ${attachedProfileText(output.attachedProfile)}`);
  }
  if (output.otherAttachedProfiles && output.otherAttachedProfiles.length > 0) {
    lines.push(
      `Other attached profiles: ${output.otherAttachedProfiles.map(attachedProfileText).join("; ")}`,
    );
  }
  const observedId = output.observation?.target.id;
  for (const target of output.targets) {
    if (target.id !== observedId) lines.push(browserTargetLine(target));
  }
  if (output.otherTabCount) {
    lines.push(`${plural(output.otherTabCount, "other tab")} (browser_tabs list shows them)`);
  }
  if (output.observation) lines.push(browserObservationText(output.observation));
  else if (output.targets.length === 0) lines.push("No tabs are open.");
  return lines.join("\n");
}

export function browserTabsText(output: {
  browserSessionId: string;
  targets: readonly BrowserTextTarget[];
  mutationObservation?: BrowserTextObservation | undefined;
}): string {
  const lines = [
    `BrowserSession ${output.browserSessionId} has ${plural(output.targets.length, "tab")}:`,
  ];
  // The observation starts with its tab's own line, so list that tab once.
  const observedId = output.mutationObservation?.target.id;
  for (const target of output.targets) {
    if (target.id !== observedId) lines.push(browserTargetLine(target));
  }
  if (output.mutationObservation) lines.push(browserObservationText(output.mutationObservation));
  return lines.join("\n");
}

export function browserReadText(output: {
  targetId: string;
  mode: string;
  scopeFound: boolean;
  nodes: readonly BrowserTextNode[];
  totalMatches: number;
  omittedMatches: number;
  clippedFieldCount: number;
}): string {
  const lines = [
    `Tab ${output.targetId}: ${plural(output.totalMatches, "match")} (${output.mode})${
      output.scopeFound ? "" : "; the scope element was not found"
    }`,
  ];
  const base = shallowestDepth(output.nodes);
  for (const node of output.nodes) lines.push(browserNodeLine(node, true, base));
  const notes = [
    output.omittedMatches ? `${plural(output.omittedMatches, "match")} not shown` : null,
    output.clippedFieldCount ? `${plural(output.clippedFieldCount, "long field")} clipped` : null,
  ].filter((entry): entry is string => entry !== null);
  if (notes.length) lines.push(`(${notes.join("; ")})`);
  return lines.join("\n");
}
