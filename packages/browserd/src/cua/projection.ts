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

type Platform = "macos" | "windows" | "linux";

/**
 * Why an element's value must never reach the model, or null. Windows Edit
 * values are protected by policy because the SDK does not publish UIA
 * IsPassword, so a password box cannot be told apart from its visible name.
 */
function protectionFor(role: string, platform: Platform): "password" | "policy" | null {
  if (/secure|password/i.test(role)) return "password";
  if (platform === "windows" && role === "Edit") return "policy";
  return null;
}

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
 * instead of an empty AXRow. Keyed by element_index. Rows that are, or sit
 * inside, a protected field (indexed or not) contribute nothing: their label
 * can be the field's value and their value is the protected text itself.
 *
 * Not used on Windows. CUA writes names and values into this Markdown without
 * escaping newlines, so a multi-line Edit value can contain lines shaped like
 * rows. Every Windows Edit value is protected, and its fake rows would escape
 * the protected field's indentation, so the tree cannot be read safely there.
 */
export function unindexedTextByElement(
  markdown: string | undefined,
  platform: Platform = "macos",
): Map<number, string[]> {
  const texts = new Map<number, string[]>();
  if (!markdown || platform === "windows") return texts;
  const ancestors: Array<{ indent: number; index: number | null; protected: boolean }> = [];
  for (const line of markdown.split("\n")) {
    const row = MARKDOWN_ROW.exec(line);
    if (!row) continue;
    const indent = row[1]!.length;
    while (ancestors.length > 0 && ancestors.at(-1)!.indent >= indent) ancestors.pop();
    const index = row[2] === undefined ? null : Number(row[2]);
    const isProtected =
      protectionFor(row[3]!, platform) !== null || (ancestors.at(-1)?.protected ?? false);
    ancestors.push({ indent, index, protected: isProtected });
    if (index !== null || isProtected) continue;
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

type CuaElement = z.infer<typeof Element>;

/**
 * A macOS element activated by opening it rather than pressing it: a folder
 * or file in a file dialog's or Finder's list (AXOpen goes into the folder or
 * chooses the file, as a double-click does) and a sidebar place. Invoking it
 * opens it.
 */
export function opensOnInvoke(element: { readonly actions: readonly string[] }): boolean {
  return element.actions.includes("AXOpen") && !element.actions.includes("AXPress");
}

/**
 * The macOS elements that belong to web content, by element_index: an
 * AXWebArea and everything CUA lists under it. WebKit and Chromium report
 * AXShowMenu on every element of a page; it opens the page's context menu,
 * not a menu of the control, so offering it there names an action on every
 * line and makes a page's plain text look operable.
 */
function webContentIndexes(elements: readonly CuaElement[]): Set<number> {
  const byIndex = new Map(elements.map((element) => [element.element_index, element]));
  const known = new Map<number, boolean>();
  const inWeb = (start: CuaElement): boolean => {
    const path: number[] = [];
    let current: CuaElement | undefined = start;
    let result = false;
    while (current && path.length <= elements.length) {
      const cached = known.get(current.element_index);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      path.push(current.element_index);
      if (current.role === "AXWebArea") {
        result = true;
        break;
      }
      current = current.parent_index === undefined ? undefined : byIndex.get(current.parent_index);
    }
    for (const index of path) known.set(index, result);
    return result;
  };
  return new Set(elements.filter(inWeb).map((element) => element.element_index));
}

/**
 * Static text that only repeats the label of the element it sits in (a
 * link's or button's own text). The label already reads it, and the second
 * copy doubles every link of a page.
 */
function repeatsParentLabel(
  element: CuaElement,
  byIndex: ReadonlyMap<number, CuaElement>,
): boolean {
  if (element.role !== "AXStaticText" || element.focused || element.actions.includes("AXPress"))
    return false;
  const text = (element.label ?? (typeof element.value === "string" ? element.value : "")).trim();
  if (!text || element.parent_index === undefined) return false;
  return byIndex.get(element.parent_index)?.label?.trim() === text;
}

/**
 * Chrome names each tab with the memory its page uses ("Inbox - Memory usage
 * - 85.2 MB"). The figure changes all the time and would make every tab
 * read as changed after each action, so a tab is named by its page alone.
 */
function withoutLiveMemoryUsage(label: string): string {
  return label.replace(/ - (?:High )?[Mm]emory usage - [\d.,]+\s?[KMGT]?B(?= - |$)/u, "");
}

/** One part of a web page's date or time field, in the order the page shows
 * them (the locale's order: day, month, year in much of the world). */
export type DateSegment =
  | "year"
  | "month"
  | "day"
  | "week"
  | "hours"
  | "minutes"
  | "seconds"
  | "milliseconds"
  | "meridiem";

const DATE_SEGMENT_NAMES: Record<string, DateSegment> = {
  year: "year",
  month: "month",
  day: "day",
  week: "week",
  hours: "hours",
  minutes: "minutes",
  seconds: "seconds",
  milliseconds: "milliseconds",
  "am/pm": "meridiem",
};

/**
 * The date and time fields of web content (Chrome's and Safari's date, time,
 * month, week and datetime-local inputs), by element_index, with their parts
 * in the order shown. macOS reads such a field as an AXDateField or
 * AXTimeField whose parts are AXIncrementors named "<part> <field label>"
 * ("Day Date of birth"). A part cannot take the focus or a value on its own,
 * and the field takes no value through accessibility, so it is filled by
 * typing each part's digits. A field with a part this does not know (a
 * browser in another language names them differently) is left out.
 */
export function dateFields(
  elements: readonly CuaElement[],
  webContent: ReadonlySet<number> = webContentIndexes(elements),
): Map<number, { segments: DateSegment[]; parts: number[] }> {
  const fields = new Map<number, { segments: DateSegment[]; parts: number[] }>();
  const children = new Map<number, CuaElement[]>();
  for (const element of elements)
    if (element.parent_index !== undefined && element.role === "AXIncrementor")
      children.set(element.parent_index, [...(children.get(element.parent_index) ?? []), element]);
  for (const element of elements) {
    if (
      (element.role !== "AXDateField" && element.role !== "AXTimeField") ||
      !element.element_token ||
      !webContent.has(element.element_index)
    )
      continue;
    const parts = children.get(element.element_index) ?? [];
    const fieldLabel = (element.label ?? "").trim();
    const segments = parts.map((part) => {
      const label = (part.label ?? "").trim();
      const name =
        fieldLabel && label.endsWith(` ${fieldLabel}`)
          ? label.slice(0, -fieldLabel.length - 1)
          : label;
      return DATE_SEGMENT_NAMES[name.trim().toLowerCase()];
    });
    if (segments.length === 0 || segments.some((segment) => segment === undefined)) continue;
    if (new Set(segments).size !== segments.length) continue;
    fields.set(element.element_index, {
      segments: segments as DateSegment[],
      parts: parts.map((part) => part.element_index),
    });
  }
  return fields;
}

/** The ISO form a date or time field with these parts takes and shows. */
export function dateFieldFormat(segments: readonly DateSegment[]): string {
  const has = (segment: DateSegment) => segments.includes(segment);
  const date = has("week")
    ? "YYYY-Www"
    : has("day")
      ? "YYYY-MM-DD"
      : has("month")
        ? "YYYY-MM"
        : has("year")
          ? "YYYY"
          : "";
  const time = has("hours")
    ? `HH:MM${has("seconds") ? ":SS" : ""}${has("milliseconds") ? ".mmm" : ""}`
    : "";
  return date && time ? `${date}T${time}` : date || time;
}

type DateParts = Partial<Record<Exclude<DateSegment, "meridiem">, number>>;

/** The parts of an ISO date, time, month, week or local date-time, or null. */
export function parseDateValue(value: string): DateParts | null {
  const text = value.trim();
  if (!text) return null;
  const [datePart, timePart] = /^\d{4,6}-.*[T ]/u.test(text)
    ? (text.split(/[T ]/u, 2) as [string, string])
    : text.includes(":")
      ? ["", text]
      : [text, ""];
  const parts: DateParts = {};
  if (datePart) {
    const week = /^(\d{4,6})-W(\d{1,2})$/iu.exec(datePart);
    const date = /^(\d{4,6})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u.exec(datePart);
    if (week) Object.assign(parts, { year: Number(week[1]), week: Number(week[2]) });
    else if (date) {
      parts.year = Number(date[1]);
      if (date[2] !== undefined) parts.month = Number(date[2]);
      if (date[3] !== undefined) parts.day = Number(date[3]);
    } else return null;
  }
  if (timePart) {
    const time = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(timePart);
    if (!time) return null;
    parts.hours = Number(time[1]);
    parts.minutes = Number(time[2]);
    if (time[3] !== undefined) parts.seconds = Number(time[3]);
    if (time[4] !== undefined) parts.milliseconds = Number(time[4].padEnd(3, "0"));
  }
  const ranges: Record<keyof DateParts, [number, number]> = {
    year: [1, 275760],
    month: [1, 12],
    day: [1, 31],
    week: [1, 53],
    hours: [0, 23],
    minutes: [0, 59],
    seconds: [0, 59],
    milliseconds: [0, 999],
  };
  for (const [key, part] of Object.entries(parts) as [keyof DateParts, number][]) {
    const [low, high] = ranges[key];
    if (part < low || part > high) return null;
  }
  return parts;
}

/**
 * The text to type into each part of a date or time field to give it this
 * ISO value, in the parts' order, or why the value does not fit the field.
 * Seconds and milliseconds the value leaves out are zero.
 */
export function dateFieldTyping(
  segments: readonly DateSegment[],
  value: string,
): { texts: string[] } | { error: string } {
  const format = dateFieldFormat(segments);
  const unfit = {
    error: `This date or time field takes its whole value in the form ${format}`,
  };
  const parts = parseDateValue(value);
  if (!parts) return unfit;
  const fieldParts = new Set<string>(segments);
  if (Object.keys(parts).some((key) => !fieldParts.has(key))) return unfit;
  const texts: string[] = [];
  for (const segment of segments) {
    if (segment === "meridiem") {
      if (parts.hours === undefined) return unfit;
      texts.push(parts.hours < 12 ? "A" : "P");
      continue;
    }
    let part = parts[segment];
    if (part === undefined && (segment === "seconds" || segment === "milliseconds")) part = 0;
    if (part === undefined) return unfit;
    if (segment === "hours" && fieldParts.has("meridiem")) part = part % 12 || 12;
    texts.push(
      String(part).padStart(segment === "year" ? 4 : segment === "milliseconds" ? 3 : 2, "0"),
    );
  }
  return { texts };
}

export function projectElements(
  allElements: CuaElement[],
  platform: Platform = "macos",
  childTexts: ReadonlyMap<number, readonly string[]> = new Map(),
): InteractionSemanticNodeValue[] {
  const byIndex = new Map(allElements.map((element) => [element.element_index, element]));
  const elements =
    platform === "macos"
      ? allElements.filter((element) => !repeatsParentLabel(element, byIndex))
      : allElements;
  const webContent = platform === "macos" ? webContentIndexes(allElements) : new Set<number>();
  const typedFields =
    platform === "macos" ? dateFields(allElements, webContent) : new Map<number, unknown>();
  // CUA may omit non-actionable parents. A flat, bounded forest preserves every
  // returned node without inventing ancestry or dropping orphaned children.
  return elements.map((element) => {
    const protectedReason = protectionFor(element.role, platform);
    const opaqueWindowsEdit = protectedReason === "policy";
    // The SDK uses value as its label fallback when the native name is absent.
    const valueLabel =
      opaqueWindowsEdit && element.value !== undefined && element.label === String(element.value);
    const actions: string[] = [];
    if (element.element_token) {
      if (
        platform === "linux"
          ? element.actions.some((action) => ["click", "press", "activate"].includes(action))
          : platform === "windows"
            ? element.actions.includes("invoke")
            : element.actions.includes("AXPress") || opensOnInvoke(element)
      )
        actions.push("invoke");
      if (
        platform === "macos" &&
        element.actions.includes("AXShowMenu") &&
        !webContent.has(element.element_index)
      )
        actions.push("show_menu");
      if (
        platform === "linux"
          ? ["text", "entry", "password text", "combo box", "slider"].includes(element.role)
          : platform === "windows"
            ? element.actions.includes("set_value")
            : // An item of a file list is shown as a text field, but its text is
              // the item's name, not something to edit.
              (!opensOnInvoke(element) &&
                [
                  "AXTextField",
                  "AXTextArea",
                  "AXSecureTextField",
                  "AXSlider",
                  "AXPopUpButton",
                ].includes(element.role)) ||
              typedFields.has(element.element_index)
      )
        actions.push("set_value");
      // A control a person can operate can take the keyboard focus, so keys
      // can be sent to it (a field in a popover, a list to arrow through).
      // Only macOS's driver focuses an element on its own.
      if (platform === "macos" && actions.length > 0) actions.push("focus");
    }
    const label =
      element.label && !valueLabel
        ? platform === "macos"
          ? withoutLiveMemoryUsage(element.label)
          : element.label
        : undefined;
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
