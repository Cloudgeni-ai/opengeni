---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

Browser tool results now reach the model as a compact page outline instead of JSON: one line per element (`role "name" [ref] value states`), indented by nesting, with refs on controls and actionable elements and omitted on text and layout lines. Noise states are dropped. `browser_open`, `browser_tabs`, `browser_observe`, `browser_act` and accessibility `browser_read` use it; `structuredContent` keeps the complete typed value for Code Mode, the API and the UI. Element refs are shorter (`e`/`a` plus 8 hex digits, with the full digest on a collision within a snapshot). Together this roughly halves the tokens of browser tool output.
