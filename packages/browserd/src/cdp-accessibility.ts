import { createHash } from "node:crypto";
import {
  INTERACTION_MAX_SEMANTIC_NODES,
  type InteractionSemanticNodeValue,
} from "@opengeni/contracts";

type CdpAxValue = {
  value?: unknown;
};

export type CdpAxNode = {
  nodeId?: unknown;
  ignored?: unknown;
  role?: CdpAxValue;
  name?: CdpAxValue & { sources?: unknown };
  description?: CdpAxValue;
  value?: CdpAxValue;
  properties?: unknown;
  parentId?: unknown;
  childIds?: unknown;
  backendDOMNodeId?: unknown;
  frameId?: unknown;
};

export type CdpAccessibilityEntry = {
  ref: string;
  nodeId: string;
  parentNodeId: string | null;
  backendDOMNodeId: number | null;
  frameId: string | null;
  role: string;
  name: string | null;
  states: string[];
  actions: string[];
  nameSources: string[];
};

export type CdpAccessibilitySnapshot = {
  roots: InteractionSemanticNodeValue[];
  nodeCount: number;
  focusedRef: string | null;
  entries: CdpAccessibilityEntry[];
  entriesByRef: Map<string, CdpAccessibilityEntry>;
  entriesByNodeId: Map<string, CdpAccessibilityEntry>;
};

/** AX ids and their relationships are scoped to one frame tree. Prefix them
 * before combining independently fetched frame trees into one observation. */
export function namespaceCdpAccessibilityFrame(
  frameId: string,
  nodes: readonly CdpAxNode[],
  frameDocumentGeneration = frameId,
): CdpAxNode[] {
  const prefix = (value: string): string => `${frameDocumentGeneration}\0${value}`;
  return nodes.map((node) => ({
    ...node,
    ...(typeof node.nodeId === "string" ? { nodeId: prefix(node.nodeId) } : {}),
    ...(typeof node.parentId === "string" ? { parentId: prefix(node.parentId) } : {}),
    ...(Array.isArray(node.childIds)
      ? {
          childIds: node.childIds.map((childId) =>
            typeof childId === "string" ? prefix(childId) : childId,
          ),
        }
      : {}),
    frameId: typeof node.frameId === "string" ? node.frameId : frameId,
  }));
}

export function normalizeCdpAccessibilityTree(options: {
  nodes: readonly CdpAxNode[];
  controllerGeneration: string;
  targetId: string;
  documentGeneration: string;
}): CdpAccessibilitySnapshot {
  if (options.nodes.length > INTERACTION_MAX_SEMANTIC_NODES * 4) {
    throw new Error("CDP accessibility tree exceeds its bounded input envelope");
  }
  const rawById = new Map<string, CdpAxNode>();
  for (const node of options.nodes) {
    if (typeof node.nodeId === "string") rawById.set(node.nodeId, node);
  }
  const entriesByNodeId = new Map<string, CdpAccessibilityEntry>();
  for (const [nodeId, node] of rawById) {
    if (node.ignored === true || roleValue(node) === "InlineTextBox") continue;
    const role = normalizedRole(roleValue(node));
    const name = accessibleStringValue(node.name) || null;
    const states = propertyStates(node.properties);
    const backendDOMNodeId = finitePositiveInteger(node.backendDOMNodeId);
    const ref = semanticRef({
      controllerGeneration: options.controllerGeneration,
      targetId: options.targetId,
      documentGeneration: options.documentGeneration,
      frameId: typeof node.frameId === "string" ? node.frameId : null,
      nodeId,
      backendDOMNodeId,
    });
    entriesByNodeId.set(nodeId, {
      ref,
      nodeId,
      parentNodeId: typeof node.parentId === "string" ? node.parentId : null,
      backendDOMNodeId,
      frameId: typeof node.frameId === "string" ? node.frameId : null,
      role,
      name,
      states,
      actions: actionsForRole(role, states, backendDOMNodeId !== null),
      nameSources: nameSourceTokens(node.name?.sources),
    });
  }

  const roots: InteractionSemanticNodeValue[] = [];
  let focusedRef: string | null = null;
  let nodeCount = 0;
  const visiting = new Set<string>();
  const emitted = new Set<string>();
  const suppressed = new Set<string>();
  const suppressSubtree = (nodeId: string): void => {
    if (suppressed.has(nodeId)) return;
    suppressed.add(nodeId);
    const raw = rawById.get(nodeId);
    if (raw) for (const childId of childIds(raw)) suppressSubtree(childId);
  };
  for (const [nodeId, entry] of entriesByNodeId) {
    if (!isEditableControlRole(entry.role)) continue;
    const raw = rawById.get(nodeId);
    if (raw) for (const childId of childIds(raw)) suppressSubtree(childId);
  }

  const visit = (nodeId: string): InteractionSemanticNodeValue[] => {
    if (suppressed.has(nodeId) || visiting.has(nodeId) || emitted.has(nodeId)) return [];
    const raw = rawById.get(nodeId);
    if (!raw) return [];
    visiting.add(nodeId);
    const entry = entriesByNodeId.get(nodeId);
    const children = childIds(raw).flatMap(visit);
    visiting.delete(nodeId);
    if (!entry) return children;
    emitted.add(nodeId);
    nodeCount += 1;
    if (nodeCount > INTERACTION_MAX_SEMANTIC_NODES) {
      throw new Error("CDP accessibility tree exceeds its semantic-node bound");
    }
    if (entry.states.includes("focused")) focusedRef = entry.ref;
    const description = accessibleStringValue(raw.description);
    const semantic: InteractionSemanticNodeValue = {
      ref: entry.ref,
      role: entry.role,
      ...(entry.name !== null ? { name: entry.name } : {}),
      ...(description ? { description } : {}),
      ...safeValue(raw, entry.role),
      states: entry.states,
      actions: entry.actions,
      ...(children.length > 0 ? { children } : {}),
    };
    return [semantic];
  };

  for (const [nodeId, node] of rawById) {
    if (typeof node.parentId !== "string" || !rawById.has(node.parentId)) {
      roots.push(...visit(nodeId));
    }
  }
  for (const nodeId of rawById.keys()) roots.push(...visit(nodeId));

  const entries = [...entriesByNodeId.values()].filter((entry) => !suppressed.has(entry.nodeId));
  return {
    roots,
    nodeCount,
    focusedRef,
    entries,
    entriesByRef: new Map(entries.map((entry) => [entry.ref, entry])),
    entriesByNodeId: new Map(entries.map((entry) => [entry.nodeId, entry])),
  };
}

function safeValue(
  node: CdpAxNode,
  role: string,
): { value?: string | { redacted: true; reason: "password" } } {
  const value = stringValue(node.value);
  if (!value) return {};
  if (["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) return {};
  return { value: value.slice(0, 32_768) };
}

function isEditableControlRole(role: string): boolean {
  return ["textbox", "searchbox", "combobox", "spinbutton"].includes(role);
}

function semanticRef(options: {
  controllerGeneration: string;
  targetId: string;
  documentGeneration: string;
  frameId: string | null;
  nodeId: string;
  backendDOMNodeId: number | null;
}): string {
  const kind = options.backendDOMNodeId === null ? "ax" : "element";
  const digest = createHash("sha256")
    .update(
      [
        options.controllerGeneration,
        options.targetId,
        options.documentGeneration,
        options.frameId ?? "",
        options.nodeId,
        options.backendDOMNodeId === null ? "" : String(options.backendDOMNodeId),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return `${kind}-${digest}`;
}

function propertyStates(properties: unknown): string[] {
  if (!Array.isArray(properties)) return [];
  const states: string[] = [];
  for (const property of properties) {
    if (!isRecord(property) || typeof property.name !== "string" || !isRecord(property.value)) {
      continue;
    }
    const value = property.value.value;
    if (value === true || value === "true") states.push(property.name.slice(0, 128));
    else if (value !== false && value !== undefined && value !== null && value !== "false") {
      states.push(`${property.name}=${String(value)}`.slice(0, 128));
    }
    if (states.length === 64) break;
  }
  return states;
}

function nameSourceTokens(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const tokens = new Set<string>();
  for (const source of sources) {
    if (!isRecord(source) || source.superseded === true) continue;
    if (typeof source.attribute === "string") tokens.add(`attribute:${source.attribute}`);
    if (typeof source.nativeSource === "string") tokens.add(`native:${source.nativeSource}`);
    if (typeof source.type === "string") tokens.add(`type:${source.type}`);
  }
  return [...tokens].slice(0, 32);
}

function actionsForRole(
  role: string,
  states: readonly string[],
  hasBackendNode: boolean,
): string[] {
  if (!hasBackendNode || states.includes("disabled")) return [];
  if (["button", "link", "menuitem", "tab"].includes(role)) return ["click"];
  if (["textbox", "searchbox", "spinbutton"].includes(role)) {
    return ["focus", "fill", "type", "press"];
  }
  if (["checkbox", "radio", "switch"].includes(role)) return ["click", "check"];
  if (["combobox", "listbox"].includes(role)) return ["click", "select"];
  return [];
}

function normalizedRole(role: string): string {
  if (role === "RootWebArea" || role === "WebArea") return "document";
  if (role === "StaticText") return "text";
  return role || "generic";
}

function roleValue(node: CdpAxNode): string {
  return accessibleStringValue(node.role);
}

function accessibleStringValue(value: CdpAxValue | undefined): string {
  return stringValue(value).replace(/\s+/gu, " ").trim();
}

function stringValue(value: CdpAxValue | undefined): string {
  return typeof value?.value === "string" ? value.value : "";
}

function childIds(node: CdpAxNode): string[] {
  return Array.isArray(node.childIds)
    ? node.childIds.filter((value): value is string => typeof value === "string")
    : [];
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
