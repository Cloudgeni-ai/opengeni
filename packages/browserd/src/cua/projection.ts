import type { z } from "zod";
import type { ComputerLocator, InteractionSemanticNodeValue } from "@opengeni/contracts";
import { ComputerBackendError } from "../computer-backend";
import { Element } from "./wire";

const roles: Record<string, string> = {
  AXWindow: "window",
  AXButton: "button",
  AXTextField: "textbox",
  AXTextArea: "textbox",
  AXSecureTextField: "textbox",
  AXStaticText: "text",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXPopUpButton: "combobox",
  AXSlider: "slider",
  AXGroup: "group",
  AXMenuItem: "menuitem",
  AXLink: "link",
  Window: "window",
  Button: "button",
  Edit: "textbox",
  Text: "text",
  CheckBox: "checkbox",
  RadioButton: "radio",
  ComboBox: "combobox",
  Slider: "slider",
  Group: "group",
  MenuItem: "menuitem",
  Hyperlink: "link",
};

const MARKDOWN_ROW = /^(\s*)- (?:\[(\d+)\] )?(\S+)(.*)$/u;
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
const MARKDOWN_LABEL = new RegExp(`^ ${QUOTED}`, "u");
const MARKDOWN_VALUE = new RegExp(`(?:^| )= (?:${QUOTED}|([^\\s\\[][^\\[]*?))(?: \\[|$)`, "u");
const MAX_ROW_TEXTS = 64;

function unquote(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/**
 * Text that CUA's element list leaves out. Its structured `elements` carry
 * only addressable elements, so the static text inside a table row, list item
 * or cell exists only in the Markdown tree as unindexed rows. Collect that
 * text under the nearest indexed ancestor, so a row reads as its cells
 * instead of an empty AXRow. Keyed by element_index.
 */
export function unindexedTextByElement(markdown: string | undefined): Map<number, string[]> {
  const texts = new Map<number, string[]>();
  if (!markdown) return texts;
  const ancestors: Array<{ indent: number; index: number | null }> = [];
  for (const line of markdown.split("\n")) {
    const row = MARKDOWN_ROW.exec(line);
    if (!row) continue;
    const indent = row[1]!.length;
    while (ancestors.length > 0 && ancestors.at(-1)!.indent >= indent) ancestors.pop();
    const index = row[2] === undefined ? null : Number(row[2]);
    ancestors.push({ indent, index });
    if (index !== null) continue;
    const rest = row[4] ?? "";
    const label = MARKDOWN_LABEL.exec(rest);
    const value = MARKDOWN_VALUE.exec(label ? rest.slice(label[0].length) : rest);
    const text = (
      value
        ? value[1] !== undefined
          ? unquote(value[1])
          : (value[2] ?? "")
        : label
          ? unquote(label[1]!)
          : ""
    ).trim();
    if (!text) continue;
    const owner = ancestors
      .slice(0, -1)
      .reverse()
      .find((ancestor) => ancestor.index !== null);
    if (!owner) continue;
    const list = texts.get(owner.index!) ?? [];
    if (list.length < MAX_ROW_TEXTS) list.push(text);
    texts.set(owner.index!, list);
  }
  return texts;
}

export function projectElements(
  elements: z.infer<typeof Element>[],
  platform: "macos" | "windows" | "linux" = "macos",
  childTexts: ReadonlyMap<number, readonly string[]> = new Map(),
): InteractionSemanticNodeValue[] {
  // CUA may omit non-actionable parents. A flat, bounded forest preserves every
  // returned node without inventing ancestry or dropping orphaned children.
  return elements.map((element) => {
    // SDK 0.30.4 does not publish UIA IsPassword. Treat Windows Edit values
    // as protected by policy instead of guessing from their visible names.
    const opaqueWindowsEdit = platform === "windows" && element.role === "Edit";
    const protectedReason = /secure|password/i.test(element.role)
      ? ("password" as const)
      : opaqueWindowsEdit
        ? ("policy" as const)
        : null;
    // The SDK uses value as its label fallback when the native name is absent.
    const valueLabel =
      opaqueWindowsEdit && element.value !== undefined && element.label === String(element.value);
    const actions: string[] = [];
    if (element.element_token) {
      if (
        platform === "linux"
          ? element.actions.some((action) => ["click", "press", "activate"].includes(action))
          : element.actions.includes(platform === "windows" ? "invoke" : "AXPress")
      )
        actions.push("invoke");
      if (platform === "macos" && element.actions.includes("AXShowMenu")) actions.push("show_menu");
      if (
        platform === "linux"
          ? ["text", "entry", "password text", "combo box", "slider"].includes(element.role)
          : platform === "windows"
            ? element.actions.includes("set_value")
            : [
                "AXTextField",
                "AXTextArea",
                "AXSecureTextField",
                "AXSlider",
                "AXPopUpButton",
              ].includes(element.role)
      )
        actions.push("set_value");
    }
    const label = element.label && !valueLabel ? element.label : undefined;
    const contained = (childTexts.get(element.element_index) ?? []).filter(
      (text) => text !== label && text !== String(element.value ?? ""),
    );
    const containedText = contained.length > 0 ? contained.join(" | ").slice(0, 8_192) : undefined;
    return {
      ref: element.element_token ?? `read-only:${element.element_index}`,
      // Desktop labels and values can be whole documents (an editor's text
      // area). Clip to the semantic-node contract so one element cannot make
      // the entire observation invalid.
      role: (roles[element.role] ?? element.role).slice(0, 256),
      ...(label
        ? { name: label.slice(0, 8_192) }
        : containedText && !protectedReason
          ? { name: containedText }
          : {}),
      ...(label && containedText && !protectedReason ? { description: containedText } : {}),
      ...(protectedReason
        ? { value: { redacted: true as const, reason: protectedReason } }
        : element.value !== undefined
          ? { value: String(element.value).slice(0, 32_768) }
          : {}),
      states: [
        ...(element.enabled === false ? ["disabled"] : []),
        ...(element.focused ? ["focused"] : []),
      ],
      actions,
      ...(element.frame
        ? {
            bounds: {
              x: element.frame.x,
              y: element.frame.y,
              width: element.frame.w,
              height: element.frame.h,
            },
          }
        : {}),
    };
  });
}

export function locate(
  nodes: InteractionSemanticNodeValue[],
  locator: ComputerLocator,
): InteractionSemanticNodeValue {
  const matches = nodes.filter((node) => {
    const match = (value: string | undefined, query: string, exact = false) =>
      exact ? value === query : (value ?? "").toLowerCase().includes(query.toLowerCase());
    switch (locator.kind) {
      case "ref":
        return node.ref === locator.ref;
      case "role":
        return (
          node.role === locator.role &&
          (locator.name === undefined || match(node.name, locator.name, locator.exact))
        );
      case "label":
        return match(node.name, locator.text, locator.exact);
      case "text":
        return (
          match(node.name, locator.text, locator.exact) ||
          (typeof node.value === "string" && match(node.value, locator.text, locator.exact))
        );
      case "identifier":
        return node.identifier === locator.value;
    }
  });
  if (matches.length !== 1)
    throw new ComputerBackendError(
      matches.length ? "locator_ambiguous" : "locator_not_found",
      "CUA locator must resolve to exactly one observed element",
      false,
      false,
    );
  return matches[0]!;
}
