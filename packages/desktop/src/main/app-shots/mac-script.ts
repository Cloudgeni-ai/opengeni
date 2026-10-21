// The macOS side of an app-shot, as JavaScript for Automation run by the
// system's own `osascript`: no native module or helper binary ships with the
// app, and the system attributes what it reads to the app, under the app's
// Screen Recording and Accessibility permissions.
//
// The script reports the window first (one `window {...}` line on stderr), so
// the screenshot can start while it reads the window's accessibility text,
// then prints the text result as JSON on stdout.
//
// Each script defines `main(argv)` and calls it itself rather than relying on
// osascript to call a JavaScript `run(argv)` handler: some macOS releases
// (26.2 among them) run a script's top level but never call `run`, so every
// helper silently did nothing. The arguments stay on the command line after
// the script text; the script reads them from its own process arguments.
// osascript prints the value of the script's last statement, as it printed
// `run`'s return value.

/** Appends the explicit entry point: `main` receives the arguments after `-e <script>`. */
function withEntry(body: string): string {
  return `${body}
ObjC.import("Foundation");
function scriptArguments() {
  const all = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);
  return all.slice(all.indexOf("-e") + 2);
}
main(scriptArguments());
`;
}

/** Arguments: own process id (never captured), most characters, time budget in ms. */
export const MAC_CAPTURE_SCRIPT = withEntry(String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id*"]]);
ObjC.bindFunction("AXUIElementCopyMultipleAttributeValues", ["int", ["id", "id", "int", "id*"]]);
ObjC.bindFunction("AXUIElementCopyParameterizedAttributeValue", ["int", ["id", "id", "id", "id*"]]);
ObjC.bindFunction("AXUIElementCreateApplication", ["id", ["int"]]);
ObjC.bindFunction("AXUIElementSetAttributeValue", ["int", ["id", "id", "id"]]);
ObjC.bindFunction("AXUIElementSetMessagingTimeout", ["int", ["id", "float"]]);
ObjC.bindFunction("_AXUIElementGetWindow", ["int", ["id", "unsigned int*"]]);

function str(value) {
  if (!value || typeof value.isKindOfClass !== "function") return "";
  if (value.isKindOfClass($.NSString)) return String(value.js || "");
  if (value.isKindOfClass($.NSAttributedString)) return String(value.string.js || "");
  return "";
}
function num(value) {
  return value && typeof value.isKindOfClass === "function" && value.isKindOfClass($.NSNumber)
    ? Number(value.js)
    : null;
}
function attribute(element, name) {
  const out = Ref();
  return $.AXUIElementCopyAttributeValue(element, $(name), out) === 0 ? out[0] : null;
}
// A web area's address (Safari and Chromium report it as an NSURL).
function urlOf(element) {
  const value = attribute(element, "AXURL");
  if (!value || typeof value.isKindOfClass !== "function") return "";
  if (value.isKindOfClass($.NSURL)) return String(value.absoluteString.js || "");
  return str(value);
}

// The window to capture: the frontmost app's frontmost ordinary window. When
// this app is in front (its own shortcut or button), the window behind it.
function frontWindow(ownPid) {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const frontPid = front ? Number(front.processIdentifier) : -1;
  const list = ObjC.deepUnwrap(
    ObjC.castRefToObject(
      $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
        0,
      ),
    ),
  ) || [];
  const candidates = list.filter((info) => {
    const bounds = info.kCGWindowBounds || {};
    return (
      info.kCGWindowLayer === 0 &&
      info.kCGWindowOwnerPID !== ownPid &&
      (info.kCGWindowAlpha === undefined || info.kCGWindowAlpha > 0) &&
      (bounds.Width || 0) >= 40 &&
      (bounds.Height || 0) >= 40
    );
  });
  // Behind this app, only an ordinary app's window: background helpers, such
  // as a full-screen pointer overlay, own normal-layer windows too.
  const ordinary = (pid) => {
    const owner = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    return Boolean(owner) &&
      Number(owner.activationPolicy) === Number($.NSApplicationActivationPolicyRegular);
  };
  const chosen =
    (frontPid !== ownPid && candidates.find((info) => info.kCGWindowOwnerPID === frontPid)) ||
    candidates.find((info) => ordinary(info.kCGWindowOwnerPID));
  if (!chosen) return null;
  const pid = chosen.kCGWindowOwnerPID;
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  return {
    pid,
    windowId: chosen.kCGWindowNumber,
    app: (app && str(app.localizedName)) || chosen.kCGWindowOwnerName || "",
    bundleId: (app && str(app.bundleIdentifier)) || "",
    title: chosen.kCGWindowName || "",
  };
}

// The accessibility element of the chosen window: the one the window server
// knows by the same number, else the same title, else the focused window.
function axWindow(axApp, target) {
  const windows = attribute(axApp, "AXWindows");
  const count = windows && windows.isKindOfClass($.NSArray) ? Number(windows.count) : 0;
  let byTitle = null;
  for (let index = 0; index < count; index += 1) {
    const element = windows.objectAtIndex(index);
    const id = Ref();
    try {
      if ($._AXUIElementGetWindow(element, id) === 0 && Number(id[0]) === target.windowId) {
        return element;
      }
    } catch (error) {}
    if (!byTitle && target.title && str(attribute(element, "AXTitle")) === target.title) {
      byTitle = element;
    }
  }
  return byTitle || attribute(axApp, "AXFocusedWindow") || attribute(axApp, "AXMainWindow");
}

const SKIP = new Set([
  "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXScrollBar", "AXValueIndicator",
  "AXGrowArea", "AXRuler", "AXSplitter",
]);
const LEAF = new Set(["AXStaticText", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);
const LABELLED = {
  AXButton: "button", AXLink: "link", AXMenuButton: "menu", AXPopUpButton: "menu",
  AXCheckBox: "checkbox", AXRadioButton: "option", AXTab: "tab", AXDisclosureTriangle: "toggle",
};
const FIELDS = new Set(["AXTextField", "AXSearchField", "AXComboBox"]);
const NAMES = ["AXRole", "AXSubrole", "AXValue", "AXTitle", "AXDescription", "AXPlaceholderValue", "AXChildren"];

// A web page's whole text in one request, through the text-marker interface
// screen readers use (Safari and Chromium). Embedded objects become breaks.
function markerText(webArea) {
  const startMarker = attribute(webArea, "AXStartTextMarker");
  const endMarker = attribute(webArea, "AXEndTextMarker");
  if (!startMarker || !endMarker) return "";
  const range = Ref();
  if ($.AXUIElementCopyParameterizedAttributeValue(webArea, $("AXTextMarkerRangeForUnorderedTextMarkers"), $([startMarker, endMarker]), range) !== 0) return "";
  const out = Ref();
  if ($.AXUIElementCopyParameterizedAttributeValue(webArea, $("AXStringForTextMarkerRange"), range[0], out) !== 0) return "";
  return str(out[0])
    .replace(/\uFFFC/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

// Web content is read element by element while that is quick, so links,
// buttons and form fields keep their labels; a page too long for that is read
// as plain text in one request instead.
const WEB_STRUCTURED_MS = 1200;

function readText(root, maxChars, deadline) {
  const names = $(NAMES);
  // url: the address of the first web area in reading order, the window's page.
  const state = { lines: [], chars: 0, cut: false, last: "", url: "" };
  const push = (line) => {
    const text = line.replace(/\s+$/u, "");
    if (!text.trim() || text === state.last) return;
    state.last = text;
    state.lines.push(text);
    state.chars += text.length + 1;
    if (state.chars > maxChars) state.cut = true;
  };
  // Depth-first, in reading order, with an explicit stack so a deep page
  // cannot exhaust the call stack. A control's own label covers the text
  // inside it, so a link reads once, not once as a link and again as text.
  // Returns whether the subtree was read completely before its deadline.
  const walk = (subtree, cover0, until) => {
    const stack = [[subtree, cover0]];
    while (stack.length > 0) {
      if (state.cut) return true;
      if (Date.now() > until) return false;
      const [element, covered] = stack.pop();
      const out = Ref();
      if ($.AXUIElementCopyMultipleAttributeValues(element, names, 0, out) !== 0) continue;
      const values = out[0];
      const role = str(values.objectAtIndex(0));
      if (SKIP.has(role)) continue;
      if (role === "AXWebArea" && element !== subtree) {
        if (!state.url) state.url = urlOf(element);
        const mark = state.lines.length;
        const saved = { chars: state.chars, last: state.last };
        if (walk(element, covered, Math.min(until, Date.now() + WEB_STRUCTURED_MS))) continue;
        const text = markerText(element);
        if (!text) return false;
        state.lines.length = mark;
        state.chars = saved.chars;
        state.last = saved.last;
        for (const line of text.split("\n")) {
          push(line);
          if (state.cut) return true;
        }
        continue;
      }
      const value = values.objectAtIndex(2);
      const valueText = str(value).trim();
      const title = str(values.objectAtIndex(3)).trim();
      const description = str(values.objectAtIndex(4)).trim();
      const placeholder = str(values.objectAtIndex(5)).trim();
      const label = title || description;
      let cover = covered;
      if (role === "AXStaticText") {
        const text = valueText || label;
        if (!covered || !covered.includes(text)) push(text);
      } else if (role === "AXTextArea") {
        if (label) push("[text: " + label + "]");
        push(valueText);
      } else if (FIELDS.has(role)) {
        push("[field" + (label || placeholder ? " " + JSON.stringify(label || placeholder) : "") + "] " + valueText);
      } else if (LABELLED[role]) {
        const checked = role === "AXCheckBox" || role === "AXRadioButton"
          ? (num(value) === 1 ? " checked" : num(value) === 0 ? " unchecked" : "")
          : "";
        if (label || checked) push("[" + LABELLED[role] + checked + "] " + label);
        if (label) cover = label;
      } else if (role === "AXImage") {
        if (description && (!covered || !covered.includes(description))) push("[image] " + description);
      }
      if (LEAF.has(role)) continue;
      const children = values.objectAtIndex(6);
      if (children && children.isKindOfClass($.NSArray)) {
        for (let index = Number(children.count) - 1; index >= 0; index -= 1) {
          stack.push([children.objectAtIndex(index), cover]);
        }
      }
    }
    return true;
  };
  const complete = walk(root, "", deadline);
  let text = state.lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, truncated: state.cut || !complete, url: state.url };
}

function main(argv) {
  const ownPid = Number(argv[0]);
  const maxChars = Number(argv[1]);
  const deadline = Date.now() + Number(argv[2]);
  const target = frontWindow(ownPid);
  if (!target) return JSON.stringify({ error: "no_window" });
  const axApp = $.AXUIElementCreateApplication(target.pid);
  $.AXUIElementSetMessagingTimeout(axApp, 1.0);
  const root = $.AXIsProcessTrusted() ? axWindow(axApp, target) : null;
  if (!target.title && root) target.title = str(attribute(root, "AXTitle"));
  console.log("window " + JSON.stringify(target));
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ error: "accessibility" });
  if (!root) return JSON.stringify({ text: "", truncated: false });
  let result = readText(root, maxChars, deadline);
  // Chromium and Electron apps build their web content's accessibility only
  // once an assistive app asks; ask, then read again.
  if (result.text.length < 200 && Date.now() < deadline) {
    if ($.AXUIElementSetAttributeValue(axApp, $("AXManualAccessibility"), $.NSNumber.numberWithBool(true)) === 0) {
      delay(0.25);
      const again = readText(root, maxChars, deadline);
      if (again.text.length > result.text.length) result = Object.assign(again, { url: again.url || result.url });
      else if (!result.url) result.url = again.url;
    }
  }
  return JSON.stringify(result);
}
`);

/** Arguments: the two device-flag masks of the modifier pair. */
export const MAC_MODIFIER_PAIR_SCRIPT = withEntry(String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("unistd");
// The window-server query would otherwise register osascript as an app with
// its own Dock tile; stay a background process.
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
function main(argv) {
  const both = Number(argv[0]) | Number(argv[1]);
  let down = false;
  console.log("ready");
  // Ends with the app: an orphaned helper is adopted by launchd (pid 1).
  while ($.getppid() !== 1) {
    const pressed = ($.CGEventSourceFlagsState(0) & both) === both;
    if (pressed && !down) console.log("trigger");
    down = pressed;
    delay(0.05);
  }
  return "";
}
`);

/**
 * Argument: `check`, `request-screen` or `request-accessibility`. Prints
 * whether each permission is allowed. Run as the app's child, so it reads the
 * app's own permissions, fresh, without restarting the app after a grant.
 */
export const MAC_PERMISSIONS_SCRIPT = withEntry(String.raw`
ObjC.import("ApplicationServices");
// The screen-capture access calls have no JXA bridge metadata; bind them.
ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);
ObjC.bindFunction("AXIsProcessTrustedWithOptions", ["bool", ["id"]]);
function main(argv) {
  if (argv[0] === "request-screen") $.CGRequestScreenCaptureAccess();
  if (argv[0] === "request-accessibility") {
    $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
  }
  return JSON.stringify({
    screenRecording: Boolean($.CGPreflightScreenCaptureAccess()),
    accessibility: Boolean($.AXIsProcessTrusted()),
  });
}
`);
