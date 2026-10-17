import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuaRuntime } from "../src/cua/sdk";

// The desktop workflow tools agents may call. Lifecycle, escalation,
// configuration, update, recording and browser tools stay outside.
const ADMITTED = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "kill_app",
  "bring_to_front",
  "set_window_frame",
  "invoke_menu",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "clipboard_read",
  "clipboard_write",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "move_cursor",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "get_agent_cursor_state",
  "zoom",
  "run_steps",
  "run_script",
  "parse_visual_regions",
];

// Release generation reads only the bundled driver's static tool inventory.
// No app discovery, screenshots, native input, or permission prompts.
// Run it on each platform: macOS defines the admitted set; Linux and Windows
// publish their own schemas for that set and may omit tools they lack.
const suffix =
  process.platform === "linux" ? ".linux" : process.platform === "win32" ? ".windows" : "";
const directory =
  process.platform === "linux" ? await mkdtemp(join(tmpdir(), "cua-catalog-")) : null;
const runtime = await createCuaRuntime(
  directory ? { ...process.env, HOME: directory, XDG_RUNTIME_DIR: directory } : process.env,
);
try {
  const catalog = JSON.parse(await runtime.listToolsJson());
  const admitted = new Set(ADMITTED);
  const tools = catalog.tools.filter((tool: { name: string }) => admitted.has(tool.name));
  const missing = [...admitted].filter(
    (name) => !tools.some((tool: { name: string }) => tool.name === name),
  );
  if (missing.length && !suffix) throw new Error("CUA desktop inventory is incomplete");
  if (missing.length) console.log(`This platform omits: ${missing.join(", ")}`);
  await Bun.write(
    new URL(`../../contracts/src/cua-desktop-tools${suffix}.gen.json`, import.meta.url),
    JSON.stringify(tools, null, 2) + "\n",
  );
  console.log(`Generated ${tools.length} upstream desktop tool definitions`);
} finally {
  await runtime.shutdown();
  runtime.uniffiDestroy();
  if (directory) await rm(directory, { recursive: true, force: true });
}
