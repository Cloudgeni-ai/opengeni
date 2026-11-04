import { isRecord } from "@opengeni/contracts/values";

export type ProtectedReason = "password" | "payment" | "private";

/** Pure policy, also serialized into isolated-world DOM reads and fill
 * verification. Keep it self-contained: no page-provided helpers or globals.
 * `labelText` is the text of the field's labels (`<label for>`, a wrapping
 * `<label>`, `aria-labelledby`), which the attributes alone do not carry. */
export function sensitiveFieldReason(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  editable: boolean,
  purpose: "read" | "remember" = "read",
  labelText = "",
): ProtectedReason | null {
  if (purpose === "remember" && !["input", "textarea"].includes(tag) && !editable) return null;
  const type = tag === "input" ? (attributes.type ?? "text").toLowerCase() : "";
  if (purpose === "remember" && type === "hidden") return null;
  const autocomplete = (attributes.autocomplete ?? "").toLowerCase();
  if (type === "password" || /(?:current|new)-password|one-time-code/u.test(autocomplete))
    return "password";
  // A text field a site names or labels as a password holds one, whatever
  // its type: some sites show passwords in ordinary text inputs.
  const textField =
    (tag === "input" &&
      ![
        "hidden",
        "checkbox",
        "radio",
        "button",
        "submit",
        "reset",
        "image",
        "file",
        "range",
        "color",
      ].includes(type)) ||
    tag === "textarea" ||
    editable;
  const passwordName = (name: string) =>
    /pass(?:word|wd|code|phrase)|(?:^|[^a-z])pwd(?:[^a-z]|$)|passord|passwort|l[öo]senord|adgangskode|wachtwoord|mot de passe|contrase[ñn]a|senha|salasana|has[łl]o|jelsz[óo]/iu.test(
      name.replace(/password-?less/giu, ""),
    );
  if (
    textField &&
    [
      attributes.name ?? "",
      attributes.id ?? "",
      attributes["aria-label"] ?? "",
      attributes.placeholder ?? "",
      labelText,
    ].some(passwordName)
  )
    return "password";
  const field = ["input", "textarea", "select"].includes(tag) || editable;
  const paymentName = (name: string) =>
    /card.?(?:number|num\b)|credit.?card|cvv|cvc|\bcsc\b|security.?code|(?:card|cc|payment).{0,12}?exp|exp(?:iry|iration)?.?(?:date|month|year|mm|yy)/iu.test(
      name,
    ) || /^(?:expiry|expiration|exp)$/iu.test(name);
  const paymentSecretName = (name: string) =>
    /card.?(?:number|num\b)|cvv|cvc|\bcsc\b|security.?code/iu.test(name) ||
    /^credit.?card$/iu.test(name);
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
  ) {
    if (purpose === "read") return "payment";
    // Expiry dates, cardholder names and select options stay protected in
    // place, but common words and years must not become session secrets.
    return /(?:^|\s)cc-(?:number|csc)(?:\s|$)/u.test(autocomplete) ||
      [
        attributes.name ?? "",
        attributes.id ?? "",
        attributes["aria-label"] ?? "",
        attributes.placeholder ?? "",
        attributes["data-elements-stable-field-name"] ?? "",
      ].some(paymentSecretName)
      ? "payment"
      : null;
  }
  if (purpose === "remember") return null;
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
  for (const document of snapshot.documents) {
    if (!isRecord(document) || !isRecord(document.nodes))
      throw new Error("invalid page protection document");
    const frameId = stringAt(document.frameId);
    const nodes = document.nodes;
    for (const key of ["backendNodeId", "parentIndex", "nodeName", "nodeValue", "attributes"]) {
      if (!Array.isArray(nodes[key])) throw new Error("invalid page protection nodes");
    }
    const backendIds = nodes.backendNodeId as unknown[];
    const reasons: Array<ProtectedReason | null> = [];
    const memoryReasons: Array<ProtectedReason | null> = [];
    const paymentFields: boolean[] = [];
    const editableRoots: Array<number | null> = [];
    const editableText = new Map<number, string>();
    const remember = (
      value: string,
      reason: ProtectedReason | null | undefined,
      paymentField = false,
    ) => {
      if (!value || (!reason && !paymentField)) return;
      // Only actual card numbers/CVCs from primary payment fields enter
      // memory, not labels, option years or arbitrary hidden/private text.
      const digits = value.replace(/[\s-]/gu, "");
      if (
        reason === "password" ||
        (reason === "payment" && /^(?:[0-9]{3,4}|[0-9]{12,19})$/u.test(digits)) ||
        (paymentField && /^[0-9]{12,19}$/u.test(digits))
      )
        found.values.push(value);
    };
    const attributeList: Array<Record<string, string>> = [];
    const tags: string[] = [];
    const parents: number[] = [];
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
      attributeList.push(attributes);
      tags.push(stringAt((nodes.nodeName as unknown[])[index]).toLowerCase());
      parents.push(parent as number);
    }
    const labels = fieldLabelTexts(tags, attributeList, parents, (index) =>
      stringAt((nodes.nodeValue as unknown[])[index]),
    );
    for (let index = 0; index < backendIds.length; index++) {
      const attributes = attributeList[index] as Record<string, string>;
      const parent = parents[index] as number;
      const inherited = parent >= 0 ? (reasons[parent] ?? null) : null;
      const tag = tags[index] as string;
      const editable = "contenteditable" in attributes && attributes.contenteditable !== "false";
      const labelText = labels.get(index) ?? "";
      const ownReason = sensitiveFieldReason(tag, attributes, editable, "read", labelText);
      const reason = ownReason ?? inherited;
      reasons.push(reason);
      // Protection inherits; permission to remember does not. A named
      // payment wrapper must not turn its expiry options or postal code
      // into permanent secrets.
      const memoryReason = sensitiveFieldReason(tag, attributes, editable, "remember", labelText);
      memoryReasons.push(memoryReason);
      // Autofill may populate an unnamed field inside a payment wrapper.
      // Remember a complete card-sized number there, never a 3–4 digit
      // year/postcode or hidden metadata inherited from the wrapper.
      const paymentField =
        reason === "payment" &&
        attributes.type?.toLowerCase() !== "hidden" &&
        (["input", "textarea"].includes(tag) || editable);
      paymentFields.push(paymentField);
      const editableRoot =
        editable && (memoryReason || paymentField)
          ? index
          : !["input", "textarea", "select", "option"].includes(tag) &&
              attributes.contenteditable !== "false" &&
              parent >= 0
            ? (editableRoots[parent] ?? null)
            : null;
      editableRoots.push(editableRoot);
      if (reason) {
        if (!Number.isSafeInteger(backendIds[index]))
          throw new Error("invalid protected backend node");
        found.nodes.set(protectedNodeKey(frameId, backendIds[index] as number), reason);
        const text = stringAt((nodes.nodeValue as unknown[])[index]);
        remember(text, memoryReason);
        // An actual contenteditable field stores its value in descendant
        // text nodes, not inputValue. Collect only that field's text; nested
        // form controls above break the inheritance.
        if (tag === "#text" && editableRoot !== null)
          editableText.set(editableRoot, (editableText.get(editableRoot) ?? "") + text);
        if (reason === "payment" || ownReason === "payment") found.payment = true;
      }
    }
    for (const [index, text] of editableText)
      remember(text, memoryReasons[index], paymentFields[index]);
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
          remember(value, memoryReasons[index as number], paymentFields[index as number]);
        }
      }
    }
  }
  return found;
}

/** Label text cap per field: enough for any real label, bounded for a page
 * that labels a field with a whole article. */
const LABEL_TEXT_LIMIT = 256;

/**
 * The text of each form field's labels in one snapshot document: a
 * `<label for>` naming its id, a `<label>` around it, and the elements its
 * `aria-labelledby` names. Keyed by node index; fields without labels are
 * absent.
 */
function fieldLabelTexts(
  tags: readonly string[],
  attributes: ReadonlyArray<Readonly<Record<string, string>>>,
  parents: readonly number[],
  nodeValue: (index: number) => string,
): Map<number, string> {
  const labelled = new Map<number, string>();
  const isField = (index: number) =>
    ["input", "textarea"].includes(tags[index] ?? "") ||
    ("contenteditable" in (attributes[index] ?? {}) &&
      attributes[index]?.contenteditable !== "false");
  // Ids a label or aria-labelledby points at, and which elements carry text
  // someone may need: every label, and every element so referenced.
  const referenced = new Set<string>();
  for (let index = 0; index < tags.length; index++) {
    const own = attributes[index] ?? {};
    if (isField(index))
      for (const id of (own["aria-labelledby"] ?? "").split(/\s+/u)) if (id) referenced.add(id);
  }
  const texts = new Map<number, string>();
  const owners: number[][] = [];
  for (let index = 0; index < tags.length; index++) {
    const parent = parents[index] ?? -1;
    const inherited = parent >= 0 ? (owners[parent] ?? []) : [];
    const own = attributes[index] ?? {};
    const owner = tags[index] === "label" || (own.id !== undefined && referenced.has(own.id));
    const mine = owner ? [...inherited, index] : inherited;
    owners.push(mine);
    if (tags[index] === "#text" && mine.length > 0) {
      const value = nodeValue(index);
      for (const at of mine) {
        const text = texts.get(at) ?? "";
        if (text.length < LABEL_TEXT_LIMIT)
          texts.set(at, `${text}${value}`.slice(0, LABEL_TEXT_LIMIT));
      }
    }
  }
  const byId = new Map<string, number>();
  for (let index = 0; index < tags.length; index++) {
    const id = attributes[index]?.id;
    if (id !== undefined && !byId.has(id)) byId.set(id, index);
  }
  const add = (field: number, text: string | undefined) => {
    if (!text) return;
    labelled.set(field, `${labelled.get(field) ?? ""} ${text}`.trim());
  };
  for (let index = 0; index < tags.length; index++) {
    if (tags[index] === "label") {
      const target = attributes[index]?.for;
      const field = target === undefined ? undefined : byId.get(target);
      if (field !== undefined && isField(field)) add(field, texts.get(index));
    }
    if (!isField(index)) continue;
    // The nearest label around the field.
    for (let at = parents[index] ?? -1; at >= 0; at = parents[at] ?? -1) {
      if (tags[at] === "label") {
        add(index, texts.get(at));
        break;
      }
    }
    for (const id of (attributes[index]?.["aria-labelledby"] ?? "").split(/\s+/u)) {
      const at = id ? byId.get(id) : undefined;
      if (at !== undefined) add(index, texts.get(at));
    }
  }
  return labelled;
}
