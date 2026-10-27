// The dictation window's page: a small pill at the bottom of the screen that
// shows the microphone while the person speaks, then the transcription, then
// goes away as the text lands. Self-contained (a data: URL, no files), so an
// app that embeds the kit ships nothing extra. Buttons report through the
// page's address (`#action/time`), which the main process watches.

export const DICTATION_HUD_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
body {
  display: flex; align-items: flex-end; justify-content: center;
  font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #f4f4f5; -webkit-user-select: none; user-select: none; cursor: default;
}
#pill {
  display: inline-flex; align-items: center; gap: 10px; box-sizing: border-box;
  height: 40px; margin: 0 12px 12px; padding: 0 7px 0 14px; border-radius: 20px;
  background: rgba(24, 24, 27, 0.94); white-space: nowrap;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.09), 0 10px 28px rgba(0, 0, 0, 0.32);
}
#pill.plain { padding-right: 16px; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
.dot.live { animation: pulse 1.4s ease-in-out infinite; }
.dot.idle { background: #71717a; }
.bars { display: flex; align-items: center; gap: 2px; height: 18px; }
.bars i { width: 3px; height: 3px; border-radius: 2px; background: #f4f4f5; transition: height 90ms linear; }
.time { font-variant-numeric: tabular-nums; min-width: 32px; }
.label { color: #a1a1aa; }
.message { max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
.actions { display: inline-flex; gap: 4px; }
button {
  all: unset; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  height: 28px; min-width: 28px; padding: 0 10px; border-radius: 14px;
  background: rgba(255, 255, 255, 0.09); color: #f4f4f5; font: inherit; font-size: 12px;
}
button:hover { background: rgba(255, 255, 255, 0.17); }
button:active { background: rgba(255, 255, 255, 0.24); }
button.icon { padding: 0; width: 28px; }
button.primary { background: #f4f4f5; color: #18181b; }
button.primary:hover { background: #ffffff; }
.spinner {
  flex: none; width: 12px; height: 12px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.22); border-top-color: #f4f4f5;
  animation: spin 0.8s linear infinite;
}
.glyph { flex: none; display: inline-flex; }
.glyph.success { color: #4ade80; }
.glyph.error { color: #f87171; }
.glyph.info { color: #a1a1aa; }
@keyframes pulse { 50% { opacity: 0.35; } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dot.live, .spinner { animation: none; }
  .bars i { transition: none; }
}
</style>
</head>
<body>
<div id="pill" role="status" aria-live="polite"></div>
<script>
const pill = document.getElementById("pill");
const SHAPES = [0.55, 0.85, 1, 0.85, 0.55];
const ICONS = {
  stop: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8v3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.2" r="0.95" fill="currentColor"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.4v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.95" fill="currentColor"/></svg>',
};
const NAMES = { retry: "Try again", allow: "Allow", open: "Open" };
let kind = null;
let ticking = null;
let startedAt = 0;
function act(name) { location.hash = name + "/" + Date.now(); }
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function iconButton(name, icon, title) {
  const button = el("button", "icon");
  button.innerHTML = ICONS[icon];
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", () => act(name));
  return button;
}
function textButton(name, primary) {
  const button = el("button", primary ? "primary" : "", NAMES[name]);
  button.addEventListener("click", () => act(name));
  return button;
}
function elapsed() {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
function setLevel(level) {
  const bars = pill.querySelectorAll(".bars i");
  const value = typeof level === "number" ? Math.min(1, Math.max(0, level)) : 0;
  bars.forEach((bar, index) => {
    bar.style.height = Math.round(3 + SHAPES[index] * value * 15) + "px";
  });
}
function width() { return Math.ceil(pill.getBoundingClientRect().width) + 24; }
function render(state) {
  // A level update while recording changes only the bars.
  if (state.kind === "recording" && kind === "recording") {
    startedAt = state.startedAt;
    setLevel(state.level);
    return width();
  }
  kind = state.kind;
  clearInterval(ticking);
  ticking = null;
  pill.textContent = "";
  pill.className = "";
  if (state.kind === "starting") {
    pill.append(el("span", "dot idle"), el("span", "", "Starting…"));
    if (state.label) pill.append(el("span", "label", state.label));
    pill.append(iconButton("cancel", "close", "Cancel (Esc)"));
  } else if (state.kind === "recording") {
    startedAt = state.startedAt;
    const bars = el("span", "bars");
    for (let index = 0; index < SHAPES.length; index += 1) bars.append(el("i"));
    const time = el("span", "time", elapsed());
    pill.append(el("span", "dot live"), bars, time);
    if (state.label) pill.append(el("span", "label", state.label));
    const actions = el("span", "actions");
    if (!state.hold) actions.append(iconButton("stop", "stop", "Finish and type it"));
    actions.append(iconButton("cancel", "close", "Cancel (Esc)"));
    pill.append(actions);
    setLevel(state.level);
    ticking = setInterval(() => { time.textContent = elapsed(); }, 250);
  } else if (state.kind === "transcribing") {
    pill.append(el("span", "spinner"), el("span", "", "Transcribing…"));
    if (state.label) pill.append(el("span", "label", state.label));
    pill.append(iconButton("cancel", "close", "Cancel (Esc)"));
  } else if (state.kind === "notice") {
    const glyph = el("span", "glyph " + state.tone);
    glyph.innerHTML = ICONS[state.tone];
    pill.append(glyph, el("span", "message", state.message));
    const buttons = state.actions.filter((name) => NAMES[name]);
    const actions = el("span", "actions");
    buttons.forEach((name, index) => actions.append(textButton(name, index === 0)));
    if (state.actions.includes("dismiss")) actions.append(iconButton("dismiss", "close", "Close"));
    if (actions.childElementCount > 0) pill.append(actions);
    else pill.className = "plain";
  }
  return width();
}
</script>
</body>
</html>
`;
