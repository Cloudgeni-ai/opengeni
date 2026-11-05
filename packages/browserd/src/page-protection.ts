import { isRecord } from "@opengeni/contracts/values";

export type ProtectedReason = "password" | "payment" | "private";

/** Pure policy, also serialized into isolated-world DOM reads. Keep it
 * self-contained: no page-provided helpers or globals. Only standard markup
 * decides: a password input, the standard password, one-time-code and
 * `cc-*` autocomplete tokens, and explicit private markers. It never guesses
 * from names, ids, placeholders or label text. */
export function sensitiveFieldReason(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  _editable: boolean,
): ProtectedReason | null {
  const type = tag === "input" ? (attributes.type ?? "text").toLowerCase() : "";
  const autocomplete = (attributes.autocomplete ?? "").toLowerCase();
  if (type === "password" || /(?:current|new)-password|one-time-code/u.test(autocomplete))
    return "password";
  if (/(?:^|\s)cc-/u.test(autocomplete)) return "payment";
  if (
    type === "hidden" ||
    ["data-private", "data-sensitive", "data-opengeni-private"].some((key) => key in attributes)
  )
    return "private";
  return null;
}

export const SENSITIVE_FIELD_REASON_SOURCE = sensitiveFieldReason.toString();

export type PageProtection = {
  nodes: Map<string, ProtectedReason>;
};

export function protectedNodeKey(frameId: string, backendId: number): string {
  return `${frameId}\0${backendId}`;
}

/** DOMSnapshot flattens author shadow roots (including closed roots) and
 * includes same-process child documents. OOPIF sessions are collected by the
 * driver separately. No raw snapshot is logged or returned to a caller. */
export function pageProtection(snapshot: unknown): PageProtection {
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.strings) ||
    !Array.isArray(snapshot.documents)
  ) {
    throw new Error("browser could not read page field markup");
  }
  const strings = snapshot.strings;
  const stringAt = (index: unknown): string => {
    // CDP uses -1 for an absent/empty string in dense node arrays.
    if (index === -1) return "";
    if (!Number.isSafeInteger(index) || typeof strings[index as number] !== "string")
      throw new Error("invalid page protection string");
    return strings[index as number] as string;
  };
  const found: PageProtection = { nodes: new Map() };
  for (const document of snapshot.documents) {
    if (!isRecord(document) || !isRecord(document.nodes))
      throw new Error("invalid page protection document");
    const frameId = stringAt(document.frameId);
    const nodes = document.nodes;
    for (const key of ["backendNodeId", "parentIndex", "nodeName", "attributes"]) {
      if (!Array.isArray(nodes[key])) throw new Error("invalid page protection nodes");
    }
    const backendIds = nodes.backendNodeId as unknown[];
    const reasons: Array<ProtectedReason | null> = [];
    for (let index = 0; index < backendIds.length; index++) {
      const attributes: Record<string, string> = {};
      const raw = (nodes.attributes as unknown[])[index];
      if (!Array.isArray(raw) || raw.length % 2 !== 0)
        throw new Error("invalid page protection attributes");
      for (let at = 0; at < raw.length; at += 2)
        attributes[stringAt(raw[at])] = stringAt(raw[at + 1]);
      const parent = (nodes.parentIndex as unknown[])[index];
      if (!Number.isSafeInteger(parent) || (parent as number) < -1 || (parent as number) >= index)
        throw new Error("invalid page protection parent");
      const tag = stringAt((nodes.nodeName as unknown[])[index]).toLowerCase();
      const editable = "contenteditable" in attributes && attributes.contenteditable !== "false";
      const inherited = (parent as number) >= 0 ? (reasons[parent as number] ?? null) : null;
      const reason = sensitiveFieldReason(tag, attributes, editable) ?? inherited;
      reasons.push(reason);
      if (reason) {
        if (!Number.isSafeInteger(backendIds[index]))
          throw new Error("invalid protected backend node");
        found.nodes.set(protectedNodeKey(frameId, backendIds[index] as number), reason);
      }
    }
  }
  return found;
}
