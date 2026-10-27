// The card's page: a small card in the top corner of the screen that asks
// whether to record a call (or to stop when it ended), the way a meeting
// notes app does, without the system's notifications, which Focus and Do Not
// Disturb hide. Self-contained (a data: URL, no files), so an app that embeds
// the kit ships nothing extra. Buttons report through the page's address
// (`#action/token/time`), which the main process watches.

/** Room around the card, inside the window, for its shadow. */
export const MEETING_CARD_MARGIN = 14;

export const MEETING_CARD_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root {
  color-scheme: light dark;
  --surface: rgba(255, 255, 255, 0.97);
  --edge: rgba(0, 0, 0, 0.08);
  --text: #18181b;
  --muted: #52525b;
  --quiet: rgba(0, 0, 0, 0.06);
  --quiet-hover: rgba(0, 0, 0, 0.1);
  --strong: #18181b;
  --strong-text: #fafafa;
  --strong-hover: #27272a;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: rgba(39, 39, 42, 0.97);
    --edge: rgba(255, 255, 255, 0.1);
    --text: #f4f4f5;
    --muted: #a1a1aa;
    --quiet: rgba(255, 255, 255, 0.08);
    --quiet-hover: rgba(255, 255, 255, 0.14);
    --strong: #f4f4f5;
    --strong-text: #18181b;
    --strong-hover: #ffffff;
    --shadow: 0 10px 30px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
}
html, body { margin: 0; background: transparent; overflow: hidden; }
body {
  padding: ${MEETING_CARD_MARGIN}px;
  font: 400 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--text); -webkit-user-select: none; user-select: none; cursor: default;
}
#card {
  box-sizing: border-box; display: grid; grid-template-columns: auto 1fr; gap: 12px;
  padding: 14px 14px 12px; border-radius: 14px; background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--edge), var(--shadow);
}
#card.in { animation: enter 180ms ease-out; }
#icon { width: 32px; height: 32px; border-radius: 8px; }
#icon[hidden] { display: none; }
#card.no-icon { grid-template-columns: 1fr; }
.question { font-size: 14px; font-weight: 600; }
.reason { margin-top: 2px; color: var(--muted); overflow-wrap: anywhere; }
.actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 12px; border-radius: 8px; font: inherit; font-weight: 500;
  background: var(--quiet); color: var(--text); white-space: nowrap;
}
button:hover { background: var(--quiet-hover); }
button.primary { background: var(--strong); color: var(--strong-text); }
button.primary:hover { background: var(--strong-hover); }
button:active { transform: translateY(0.5px); }
@keyframes enter { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #card.in { animation: none; } }
</style>
</head>
<body>
<div id="card" role="alertdialog" aria-labelledby="question" aria-describedby="reason">
  <img id="icon" alt="" hidden>
  <div>
    <div id="question" class="question"></div>
    <div id="reason" class="reason"></div>
  </div>
  <div class="actions">
    <button id="dismiss" type="button"></button>
    <button id="act" type="button" class="primary"></button>
  </div>
</div>
<script>
const card = document.getElementById("card");
const icon = document.getElementById("icon");
// Hovering holds the card; once the pointer leaves it stays at least this long.
const AFTER_HOVER_MS = 5000;
let token = 0;
let left = 0;
let since = 0;
let timer = null;
let hovering = false;
function report(action) {
  location.hash = action + "/" + token + "/" + Date.now();
}
function schedule() {
  clearTimeout(timer);
  timer = null;
  if (!left || hovering) return;
  since = Date.now();
  timer = setTimeout(() => report("expire"), left);
}
document.getElementById("act").addEventListener("click", () => report("act"));
document.getElementById("dismiss").addEventListener("click", () => report("dismiss"));
document.body.addEventListener("mouseenter", () => {
  hovering = true;
  if (timer) left = Math.max(AFTER_HOVER_MS, left - (Date.now() - since));
  clearTimeout(timer);
  timer = null;
});
document.body.addEventListener("mouseleave", () => {
  hovering = false;
  schedule();
});
// Shows a question; returns the window height it needs.
function render(state) {
  token = state.token;
  document.getElementById("question").textContent = state.question;
  document.getElementById("reason").textContent = state.reason;
  document.getElementById("act").textContent = state.action;
  document.getElementById("dismiss").textContent = state.dismiss;
  document.title = state.title;
  if (state.icon) {
    icon.src = state.icon;
    icon.hidden = false;
    card.classList.remove("no-icon");
  } else {
    icon.hidden = true;
    card.classList.add("no-icon");
  }
  left = state.timeoutMs || 0;
  schedule();
  card.classList.remove("in");
  void card.offsetWidth;
  card.classList.add("in");
  return Math.ceil(document.body.getBoundingClientRect().height);
}
</script>
</body>
</html>`;
