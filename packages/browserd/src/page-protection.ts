import { isRecord } from "@opengeni/contracts/values";

export type ProtectedReason = "password" | "payment" | "private";

/** Pure policy, also serialized into isolated-world DOM reads and fill
 * verification. Keep it self-contained: no page-provided helpers or globals. */
export function sensitiveFieldReason(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  editable: boolean,
): ProtectedReason | null {
  const type = tag === "input" ? (attributes.type ?? "text").toLowerCase() : "";
  const autocomplete = (attributes.autocomplete ?? "").toLowerCase();
  if (type === "password" || /(?:current|new)-password|one-time-code/u.test(autocomplete))
    return "password";
  const field = ["input", "textarea", "select"].includes(tag) || editable;
  const paymentName = (name: string) =>
    /card.?(?:number|num\b)|credit.?card|cvv|cvc|\bcsc\b|security.?code|(?:card|cc|payment).{0,12}?exp|exp(?:iry|iration)?.?(?:date|month|year|mm|yy)/iu.test(
      name,
    ) || /^(?:expiry|expiration|exp)$/iu.test(name);
  // Preserve existing explicitly named payment containers as protected too,
  // without hiding headings such as "credit-card-offers".
  const paymentContainer = [attributes.name ?? "", attributes.id ?? ""].some((name) =>
    /^(?:card.?number|credit.?card|cvv|cvc|security.?code|expiry|expiration)$/iu.test(name),
  );
  if (
    paymentContainer ||
    /(?:^|\s)cc-/u.test(autocomplete) ||
    (field &&
      [
        attributes.name ?? "",
        attributes.id ?? "",
        attributes["aria-label"] ?? "",
        attributes.placeholder ?? "",
        attributes["data-elements-stable-field-name"] ?? "",
      ].some(paymentName))
  )
    return "payment";
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
  values: string[];
  payment: boolean;
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
    throw new Error("browser could not establish page redaction");
  }
  const strings = snapshot.strings;
  const stringAt = (index: unknown): string => {
    // CDP uses -1 for an absent/empty string in dense node arrays.
    if (index === -1) return "";
    if (!Number.isSafeInteger(index) || typeof strings[index as number] !== "string")
      throw new Error("invalid page protection string");
    return strings[index as number] as string;
  };
  const found: PageProtection = { nodes: new Map(), values: [], payment: false };
  let count = 0;
  for (const document of snapshot.documents) {
    if (!isRecord(document) || !isRecord(document.nodes))
      throw new Error("invalid page protection document");
    const frameId = stringAt(document.frameId);
    const nodes = document.nodes;
    for (const key of ["backendNodeId", "parentIndex", "nodeName", "nodeValue", "attributes"]) {
      if (!Array.isArray(nodes[key])) throw new Error("invalid page protection nodes");
    }
    const backendIds = nodes.backendNodeId as unknown[];
    count += backendIds.length;
    if (count > 100_000) throw new Error("page exceeds the redaction node bound");
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
      const inherited = (parent as number) >= 0 ? (reasons[parent as number] ?? null) : null;
      const ownReason = sensitiveFieldReason(
        stringAt((nodes.nodeName as unknown[])[index]).toLowerCase(),
        attributes,
        "contenteditable" in attributes && attributes.contenteditable !== "false",
      );
      const reason = ownReason ?? inherited;
      reasons.push(reason);
      if (reason) {
        if (!Number.isSafeInteger(backendIds[index]))
          throw new Error("invalid protected backend node");
        found.nodes.set(protectedNodeKey(frameId, backendIds[index] as number), reason);
        const text = stringAt((nodes.nodeValue as unknown[])[index]);
        if (text) found.values.push(text);
        if (reason === "payment" || ownReason === "payment") found.payment = true;
      }
    }
    for (const key of ["inputValue", "textValue"]) {
      const values = nodes[key];
      if (values === undefined) continue;
      if (
        !isRecord(values) ||
        !Array.isArray(values.index) ||
        !Array.isArray(values.value) ||
        values.index.length !== values.value.length
      )
        throw new Error("invalid protected input values");
      for (let at = 0; at < values.index.length; at++) {
        const index = values.index[at];
        if (
          !Number.isSafeInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= reasons.length
        )
          throw new Error("invalid protected input index");
        if (reasons[index as number]) {
          const value = stringAt(values.value[at]);
          if (value) found.values.push(value);
        }
      }
    }
  }
  return found;
}
