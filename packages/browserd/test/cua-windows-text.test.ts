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
const ES_PASSWORD = 0x20;
const ES_READONLY = 0x800;

/** One top-level window with one control under every point of its area. */
class Desktop implements Win32TextControls {
  readonly log: string[] = [];
  constructor(readonly control: Control | null) {}
  childAt = (window: number, { x, y }: { x: number; y: number }) => {
    this.log.push(`childAt ${window} ${x},${y}`);
    return this.control ? FIELD : WINDOW;
  };
  className = () => this.control?.className ?? "Notepad";
  baseClassName = () => this.control?.baseClassName ?? this.className();
  rect = () => this.control?.rect ?? null;
  style = () => this.control?.style ?? 0;
  isEnabled = () => this.control?.enabled !== false;
  replaceAll = (_control: number, text: string) => {
    this.log.push(`replace ${JSON.stringify(text)}`);
    if (this.control!.hung) return false;
    this.control!.text = text.slice(0, this.control!.limit ?? text.length);
    return true;
  };
  text = () => (this.control?.hung ? null : this.control!.text);
  textLength = () => (this.control?.hung ? null : this.control!.text.length);
}

const bounds = { x: 10, y: 60, width: 400, height: 300 };
const rect = { left: 10, top: 60, right: 410, bottom: 360 };

describe("Windows text fields", () => {
  test("replaces an Edit control's whole text under the element's centre and reads it back", () => {
    const desktop = new Desktop({ className: "Edit", rect, style: ES_MULTILINE, text: "old" });
    expect(replaceFieldText(desktop, WINDOW, bounds, "one\ntwo")).toEqual({ kind: "replaced" });
    // A multi-line control takes line breaks as CR LF.
    expect(desktop.log).toEqual([`childAt ${WINDOW} 210,210`, 'replace "one\\r\\ntwo"']);
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
      // A control under the centre that is not the element: another area.
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
    expect(replaceFieldText(password, WINDOW, bounds, "secret")).toEqual({ kind: "replaced" });
    const short = new Desktop({ className: "Edit", rect, style: ES_PASSWORD, text: "", limit: 2 });
    expect(replaceFieldText(short, WINDOW, bounds, "secret")).toEqual({ kind: "not_applied" });
  });

  test("an app that does not answer leaves the outcome unknown", () => {
    const desktop = new Desktop({ className: "Edit", rect, style: 0, text: "", hung: true });
    expect(replaceFieldText(desktop, WINDOW, bounds, "Hello")).toEqual({ kind: "no_answer" });
  });
});
