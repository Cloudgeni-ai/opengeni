// The macOS side of dictation, as JavaScript for Automation run by the
// system's own `osascript`, like app-shots: no native module ships with the
// app, and macOS checks the app's own Accessibility permission for the paste.

import { withEntry } from "../app-shots/mac-script";

/**
 * Argument: the shortcuts to watch, as JSON `[{id, pair: [left, right]} |
 * {id, chord: mask}]` of event-flag bits. Prints `ready`, then `down <id>`
 * when a shortcut's keys are all held and `up <id> clean|dirty` when it is let
 * go: dirty when an ordinary key was pressed, or another modifier joined,
 * while it was held (Control-Fn-Left is a key combination, not dictation).
 */
export const MAC_DICTATION_KEYS_SCRIPT = withEntry(String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("unistd");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.bindFunction("CGEventSourceCounterForEventType", ["unsigned int", ["int", "unsigned int"]]);
// Shift, Control, Option, Command and Fn, independent of left or right.
const CHORD_BITS = 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x800000;
// Ordinary key presses since login (kCGEventKeyDown), across all apps.
function keyDowns() {
  try {
    return Number($.CGEventSourceCounterForEventType(0, 10));
  } catch (error) {
    return 0;
  }
}
function main(argv) {
  const watches = JSON.parse(argv[0]);
  const held = watches.map(() => null);
  let lastDowns = keyDowns();
  console.log("ready");
  // Ends with the app: an orphaned helper is adopted by launchd (pid 1).
  while ($.getppid() !== 1) {
    const flags = Number($.CGEventSourceFlagsState(0));
    const downs = keyDowns();
    for (let index = 0; index < watches.length; index += 1) {
      const watch = watches[index];
      const pressed = watch.pair
        ? (flags & watch.pair[0]) !== 0 && (flags & watch.pair[1]) !== 0
        : (flags & CHORD_BITS) === watch.chord;
      const state = held[index];
      if (pressed && !state) {
        // A key pressed in the same moment belongs to a key combination.
        held[index] = { downs, dirty: downs !== lastDowns };
        console.log("down " + watch.id);
      } else if (state) {
        if (downs !== state.downs) state.dirty = true;
        if (!pressed) {
          const grew = Boolean(watch.chord) && (flags & watch.chord) === watch.chord;
          console.log("up " + watch.id + (state.dirty || grew ? " dirty" : " clean"));
          held[index] = null;
        }
      }
    }
    lastDowns = downs;
    delay(0.04);
  }
  return "";
}
`);

/**
 * Pastes once a line arrives on stdin: Command-V to the app in front. Started
 * while the speech is transcribed, so the paste follows the text at once.
 * Prints `ready` when it can paste, and the outcome as JSON on stdout.
 */
export const MAC_PASTE_SCRIPT = withEntry(String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
function main(argv) {
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ error: "accessibility" });
  console.log("ready");
  const data = $.NSFileHandle.fileHandleWithStandardInput.availableData;
  if (Number(data.length) === 0) return JSON.stringify({ error: "cancelled" });
  // The V key with Command alone, whatever modifiers are still held.
  const source = $.CGEventSourceCreate(1);
  const down = $.CGEventCreateKeyboardEvent(source, 9, true);
  const up = $.CGEventCreateKeyboardEvent(source, 9, false);
  $.CGEventSetFlags(down, 0x100000);
  $.CGEventSetFlags(up, 0x100000);
  $.CGEventPost(0, down);
  $.CGEventPost(0, up);
  return JSON.stringify({ ok: true });
}
`);
