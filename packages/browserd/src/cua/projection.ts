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
};

export function projectElements(
  elements: z.infer<typeof Element>[],
): InteractionSemanticNodeValue[] {
  // CUA may omit non-actionable parents. A flat, bounded forest preserves every
  // returned node without inventing ancestry or dropping orphaned children.
  return elements.map((element) => {
    const protectedValue = /secure|password/i.test(element.role);
    const actions: string[] = [];
    if (element.element_token) {
      if (element.actions.includes("AXPress")) actions.push("invoke");
      if (element.actions.includes("AXShowMenu")) actions.push("show_menu");
      if (
        ["AXTextField", "AXTextArea", "AXSecureTextField", "AXSlider", "AXPopUpButton"].includes(
          element.role,
        )
      )
        actions.push("set_value");
    }
    return {
      ref: element.element_token ?? `read-only:${element.element_index}`,
      role: roles[element.role] ?? element.role,
      ...(element.label ? { name: element.label } : {}),
      ...(protectedValue
        ? { value: { redacted: true as const, reason: "password" as const } }
        : element.value !== undefined
          ? { value: String(element.value) }
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
