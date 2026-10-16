---
"@opengeni/runtime": patch
---

Browser tool calls are much shorter. `browser_act`, `browser_observe`, `browser_read`, `browser_screenshot`, `browser_debug` and `browser_tabs` may omit `browserSessionId` and `targetId` to keep working in the browser and tab the agent used last (after a fresh start, this session's most recently used live browser and its selected tab), and a locator may be an element ref given as a bare string (`"locator":"e1a2b3c4d"`). A typical click drops from about 59 to 17 output tokens, and output tokens dominate a browser step's model latency. When no browser is open or the tab is ambiguous, the tool says what to pass instead of guessing.
