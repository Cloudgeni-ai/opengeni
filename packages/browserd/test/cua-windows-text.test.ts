import { describe, expect, test } from "bun:test";
import { replaceFieldText, type Win32TextControls } from "../src/cua/windows-text";

type Control = {
  className: string;
  baseClassName?: string;
  rect: { left: number; top: number; right: number; bottom: number };
  style: number;
  enabled?: boolean;
  text: string;
  /** The most characters the control holds (EM_LIMITTEXT). */
  limit?: number;
  hung?: boolean;
};

const WINDOW = 100;
const FIELD = 200;
const ES_MULTILINE = 0x4;
const ES_UPPERCASE = 0x8;
const ES_LOWERCASE = 0x10;
const ES_PASSWORD = 0x20;
const ES_READONLY = 0x800;

/** One top-level window with at most one child control. */
class Desktop implements Win32TextControls {
  readonly log: string[] = [];
  private edited = false;
  constructor(readonly control: Control | null) {}
  descendants = (window: number) => {
    this.log.push(`descendants ${window}`);
    return this.control ? [FIELD] : [];
  };
  isVisible = () => true;
  className = () => this.control?.className ?? "Notepad";
  baseClassName = () => this.control?.baseClassName ?? this.className();
  rect = () => this.control?.rect ?? null;
  style = () => this.control?.style ?? 0;
  isEnabled = () => this.control?.enabled !== false;
  replaceAll = (_control: number, text: string) => {
    this.log.push(`replace ${JSON.stringify(text)}`);
    if (this.control!.hung) return false;
    this.control!.text = text.slice(0, this.control!.limit ?? text.length);
    this.edited = true;
    return true;
  };
  text = () => (this.control?.hung ? null : this.control!.text);
  textLength = () => (this.control?.hung ? null : this.control!.text.length);
  modified = () => (this.control?.hung ? null : this.edited);
  setModified = (_control: number, modified: boolean) => {
    this.edited = modified;
    return true;
  };
}

const bounds = { x: 10, y: 60, width: 400, height: 300 };
const rect = { left: 10, top: 60, right: 410, bottom: 360 };

describe("Windows text fields", () => {
  test("replaces the whole text of the Edit control the element is and reads it back", () => {
    const desktop = new Desktop({ className: "Edit", rect, style: ES_MULTILINE, text: "old" });
    expect(replaceFieldText(desktop, WINDOW, bounds, "one\ntwo")).toEqual({ kind: "replaced" });
    // A multi-line control takes line breaks as CR LF.
    expect(desktop.log).toEqual([`descendants ${WINDOW}`, 'replace "one\\r\\ntwo"']);
    expect(desktop.control!.text).toBe("one\r\ntwo");
  });

  test("RichEdit, Notepad's RichEdit and WinForms text boxes are text controls", () => {
    for (const className of [
      "RichEdit20W",
      "RICHEDIT50W",
      "RichEditD2DPT",
      "WindowsForms10.EDIT.app.0.141b42a_r6_ad1",
      "WindowsForms10.RichEdit20W.app.0.141b42a_r6_ad1",
    ]) {
      const desktop = new Desktop({ className, rect, style: 0, text: "" });
      expect(replaceFieldText(desktop, WINDOW, bounds, "Hello")).toEqual({ kind: "replaced" });
    }
    // A superclassed edit control is recognized by the class it is built on.
    const superclassed = new Desktop({
      className: "MyAppEditor",
      baseClassName: "Edit",
      rect,
      style: 0,
      text: "",
    });
    expect(replaceFieldText(superclassed, WINDOW, bounds, "Hello").kind).toBe("replaced");
  });

  test("writes nothing when no text control covers the element", () => {
    for (const control of [
      null,
      { className: "Button", rect, style: 0, text: "" },
      // A text control in another area than the element's.
      { className: "Edit", rect: { ...rect, bottom: 200 }, style: 0, text: "" },
    ]) {
      const desktop = new Desktop(control);
      expect(replaceFieldText(desktop, WINDOW, bounds, "Hello")).toEqual({ kind: "no_control" });
      expect(desktop.log.some((line) => line.startsWith("replace"))).toBe(false);
    }
    const desktop = new Desktop({ className: "Edit", rect, style: 0, text: "" });
    expect(replaceFieldText(desktop, WINDOW, { ...bounds, width: 0 }, "Hello").kind).toBe(
      "no_control",
    );
    expect(desktop.log).toEqual([]);
  });

  test("refuses a read-only or disabled field, and a line break in a single-line one, before writing", () => {
    for (const [control, value, kind] of [
      [{ className: "Edit", rect, style: ES_READONLY | ES_MULTILINE, text: "x" }, "a", "read_only"],
      [{ className: "Edit", rect, style: 0, enabled: false, text: "x" }, "a", "disabled"],
      [{ className: "Edit", rect, style: 0, text: "x" }, "a\nb", "single_line"],
    ] as const) {
      const desktop = new Desktop({ ...control });
      expect(replaceFieldText(desktop, WINDOW, bounds, value)).toEqual({ kind });
      expect(desktop.control!.text).toBe("x");
      expect(desktop.log.some((line) => line.startsWith("replace"))).toBe(false);
    }
  });

  test("a field that reads something else afterwards did not take the value", () => {
    const limited = new Desktop({ className: "Edit", rect, style: 0, text: "", limit: 3 });
    expect(replaceFieldText(limited, WINDOW, bounds, "Hello")).toEqual({ kind: "not_applied" });
    // A password field's text cannot be read: its length is compared.
    const password = new Desktop({ className: "Edit", rect, style: ES_PASSWORD, text: "" });
    expect(replaceFieldText(password, WINDOW, bounds, "secret")).toEqual({
      kind: "replaced_unread",
    });
    const short = new Desktop({ className: "Edit", rect, style: ES_PASSWORD, text: "", limit: 2 });
    expect(replaceFieldText(short, WINDOW, bounds, "secret")).toEqual({ kind: "not_applied" });
  });

  test("an app that does not answer leaves the outcome unknown", () => {
    const desktop = new Desktop({ className: "Edit", rect, style: 0, text: "", hung: true });
    expect(replaceFieldText(desktop, WINDOW, bounds, "Hello")).toEqual({ kind: "no_answer" });
  });
});

type Nested = Control & { visible?: boolean; modified?: boolean; ignoresReplace?: boolean };

/** A window with several controls, some inside others. */
class NestedDesktop implements Win32TextControls {
  readonly log: string[] = [];
  constructor(readonly controls: Map<number, Nested>) {}
  private at = (handle: number) => this.controls.get(handle);
  descendants = (window: number) => {
    this.log.push(`descendants ${window}`);
    return [...this.controls.keys()];
  };
  isVisible = (handle: number) => this.at(handle)?.visible !== false;
  className = (handle: number) => this.at(handle)?.className ?? "";
  baseClassName = (handle: number) =>
    this.at(handle)?.baseClassName ?? this.at(handle)?.className ?? "";
  rect = (handle: number) => this.at(handle)?.rect ?? null;
  style = (handle: number) => this.at(handle)?.style ?? 0;
  isEnabled = (handle: number) => this.at(handle)?.enabled !== false;
  replaceAll = (handle: number, text: string) => {
    this.log.push(`replace ${handle} ${JSON.stringify(text)}`);
    const control = this.at(handle)!;
    if (control.hung) return false;
    if (control.ignoresReplace) return true;
    // As Windows' edit control does, it changes the letters it is given.
    const cased =
      control.style & ES_UPPERCASE
        ? text.toUpperCase()
        : control.style & ES_LOWERCASE
          ? text.toLowerCase()
          : text;
    control.text = cased.slice(0, control.limit ?? text.length);
    control.modified = true;
    return true;
  };
  text = (handle: number) => (this.at(handle)!.hung ? null : this.at(handle)!.text);
  textLength = (handle: number) => (this.at(handle)!.hung ? null : this.at(handle)!.text.length);
  modified = (handle: number) =>
    this.at(handle)!.hung ? null : this.at(handle)!.modified === true;
  setModified = (handle: number, modified: boolean) => {
    this.log.push(`setModified ${handle} ${modified}`);
    this.at(handle)!.modified = modified;
    return true;
  };
}

describe("Windows text fields: which control is written", () => {
  // A multi-line text box with another one inside it, 4 pixels in from each
  // edge: the inner one is what Windows finds under the outer one's centre.
  const outer = { left: 58, top: 81, right: 558, bottom: 126 };
  const inner = { left: 62, top: 85, right: 554, bottom: 122 };
  const nested = () =>
    new NestedDesktop(
      new Map<number, Nested>([
        [
          301,
          { className: "WindowsForms10.EDIT.app.0.1", rect: outer, style: 4, text: "old-outer" },
        ],
        [
          302,
          { className: "WindowsForms10.EDIT.app.0.1", rect: inner, style: 4, text: "old-inner" },
        ],
      ]),
    );
  const boundsOf = (r: typeof outer) => ({
    x: r.left,
    y: r.top,
    width: r.right - r.left,
    height: r.bottom - r.top,
  });

  test("writes exactly the control the element is, never one nested in it or around it", () => {
    const toOuter = nested();
    expect(replaceFieldText(toOuter, WINDOW, boundsOf(outer), "new outer")).toEqual({
      kind: "replaced",
    });
    expect(toOuter.controls.get(301)!.text).toBe("new outer");
    expect(toOuter.controls.get(302)!.text).toBe("old-inner");
    const toInner = nested();
    expect(replaceFieldText(toInner, WINDOW, boundsOf(inner), "new inner")).toEqual({
      kind: "replaced",
    });
    expect(toInner.controls.get(301)!.text).toBe("old-outer");
    expect(toInner.controls.get(302)!.text).toBe("new inner");
  });

  test("writes nothing when the element's area is not exactly one visible text control's", () => {
    // Near but not the same area (an element given without its border).
    const near = nested();
    expect(
      replaceFieldText(near, WINDOW, { x: 60, y: 83, width: 496, height: 41 }, "Hello"),
    ).toEqual({ kind: "no_control" });
    // Two text controls with the very same area: which one is the element is unknown.
    const twins = new NestedDesktop(
      new Map<number, Nested>([
        [301, { className: "Edit", rect: outer, style: 0, text: "a" }],
        [302, { className: "Edit", rect: outer, style: 0, text: "b" }],
      ]),
    );
    expect(replaceFieldText(twins, WINDOW, boundsOf(outer), "Hello")).toEqual({
      kind: "no_control",
    });
    // A hidden control with the area does not count, and is never written.
    const hidden = new NestedDesktop(
      new Map<number, Nested>([
        [301, { className: "Edit", rect: outer, style: 0, text: "a", visible: false }],
      ]),
    );
    expect(replaceFieldText(hidden, WINDOW, boundsOf(outer), "Hello")).toEqual({
      kind: "no_control",
    });
    for (const desktop of [near, twins, hidden])
      expect(desktop.log.some((line) => line.startsWith("replace"))).toBe(false);
  });
});

describe("Windows text fields: a password field", () => {
  const field = (control: Partial<Nested>) =>
    new NestedDesktop(
      new Map<number, Nested>([
        [301, { className: "Edit", rect, style: ES_PASSWORD, text: "secret", ...control }],
      ]),
    );

  test("that ignores the replacement is not reported as set, even with a value of the same length", () => {
    const desktop = field({ ignoresReplace: true });
    expect(replaceFieldText(desktop, WINDOW, bounds, "foobar")).toEqual({ kind: "not_applied" });
    expect(desktop.controls.get(301)!.text).toBe("secret");
  });

  test("that someone already typed in is checked the same way and keeps its edited mark", () => {
    const ignored = field({ ignoresReplace: true, modified: true });
    expect(replaceFieldText(ignored, WINDOW, bounds, "foobar")).toEqual({ kind: "not_applied" });
    expect(ignored.controls.get(301)!.modified).toBe(true);
    const taken = field({ modified: true });
    expect(replaceFieldText(taken, WINDOW, bounds, "foobar")).toEqual({ kind: "replaced_unread" });
    expect(taken.controls.get(301)!).toMatchObject({ text: "foobar", modified: true });
  });

  test("that takes the replacement is set, but never said to read the value", () => {
    const desktop = field({});
    expect(replaceFieldText(desktop, WINDOW, bounds, "foobar")).toEqual({
      kind: "replaced_unread",
    });
    expect(desktop.controls.get(301)!.text).toBe("foobar");
  });

  test("that changes the letters it is given is set only to a value it holds unchanged", () => {
    // CharacterCasing.Upper or Lower on a WinForms password box.
    const upper = field({ style: ES_PASSWORD | ES_UPPERCASE, text: "FOOBAR" });
    expect(replaceFieldText(upper, WINDOW, bounds, "foobar")).toEqual({ kind: "not_applied" });
    expect(upper.controls.get(301)!.text).toBe("FOOBAR");
    const lower = field({ style: ES_PASSWORD | ES_LOWERCASE });
    expect(replaceFieldText(lower, WINDOW, bounds, "FooBar")).toEqual({ kind: "not_applied" });
    expect(
      replaceFieldText(field({ style: ES_PASSWORD | ES_UPPERCASE }), WINDOW, bounds, "AB-12"),
    ).toEqual({ kind: "replaced_unread" });
  });
});
