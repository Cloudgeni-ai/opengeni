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

export function browserNodeLine(node: BrowserTextNode, allRefs: boolean, baseDepth = 0): string {
  const parts = [`${"  ".repeat(Math.max(0, node.depth - baseDepth))}- ${node.role}`];
  if (node.name) parts.push(quoted(node.name));
  if (allRefs || (node.actions?.length ?? 0) > 0 || !REFLESS_ROLES.has(node.role)) {
    parts.push(`[${node.ref}]`);
  }
  if (node.value !== undefined && node.value !== "") {
    parts.push(typeof node.value === "string" ? `value=${quoted(node.value)}` : "value=<redacted>");
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
  } else {
    if (view.sourceKind === "diff") lines.push("Changed elements:");
    const base = shallowestDepth(nodes);
    for (const node of nodes) lines.push(browserNodeLine(node, allRefs, base));
  }
  const notes = [
    view.omittedNodeCount ? `${plural(view.omittedNodeCount, "element")} not shown` : null,
    view.removedRefCount ? `${plural(view.removedRefCount, "earlier element")} removed` : null,
    view.clippedFieldCount ? `${plural(view.clippedFieldCount, "long field")} clipped` : null,
  ].filter((entry): entry is string => entry !== null);
  if (notes.length) lines.push(`(${notes.join("; ")})`);
  return lines.join("\n");
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
}): string {
  const lines = [browserSessionLine(output.session)];
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
  for (const target of output.targets) lines.push(browserTargetLine(target));
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
