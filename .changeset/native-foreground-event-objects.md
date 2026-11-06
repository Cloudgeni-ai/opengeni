---
"@opengeni/react-native": patch
"@opengeni/react": patch
---

A React Native app no longer crashes when it returns to the foreground. The native environment shim called its `window` and `document` listeners with no event, so the `pageshow` handlers read `event.persisted` on `undefined` and threw. Every shimmed listener now receives a browser-shaped event (`type`, `target`, `currentTarget`, `timeStamp`, the usual no-op methods, `persisted: false` for `pageshow` and `pagehide`, `relatedTarget: null` for `focus` and `blur`); listener objects and `{ once: true }` work; a listener that throws is logged and the rest still run, instead of failing the app-state callback. The shimmed `document` also has `hasFocus()`. The `pageshow` handlers in `@opengeni/react` now tolerate a missing or partial event.
